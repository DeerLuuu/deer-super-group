import type { Store } from "../kernel/store.js";
import type { Clock } from "../kernel/execution/clock.js";
import type { Agent, Run, Task } from "../shared/types.js";
import type { ModelPriceSnapshot } from "../shared/watchdog.js";
import type { CostLedgerEntry } from "../shared/watchdog.js";
import type { WatchdogStore } from "./store.js";
import { normalizeModelPricing } from "../shared/models.js";

export interface PriceResult {
  snapshot: ModelPriceSnapshot | null;
  known: boolean;
}

function microToUsd(micro: number): number {
  return Math.round(micro) / 1_000_000;
}

function localDay(ms: number): string {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export class CostService {
  private readonly store: Store;
  private readonly watchdog: WatchdogStore;
  private readonly clock: Clock;

  constructor(store: Store, watchdog: WatchdogStore, clock: Clock) {
    this.store = store;
    this.watchdog = watchdog;
    this.clock = clock;
  }

  day(ms = this.clock.now()): string {
    return localDay(ms);
  }

  priceFor(modelProfileId: string | null, modelId: string | null): PriceResult {
    const settings = this.store.getLlmSettings();
    const profile =
      settings.models.find((model) => model.id === modelProfileId) ??
      settings.models.find((model) => model.modelId === modelId) ??
      settings.models.find((model) => model.modelId === modelProfileId) ??
      null;
    let pricing = profile?.pricing ? normalizeModelPricing(profile.pricing) : null;
    if (!pricing) {
      const raw = this.store.getSetting("watchdog.modelPricing");
      if (raw) {
        try {
          const map = JSON.parse(raw) as Record<string, unknown>;
          const key = modelProfileId ?? modelId ?? "";
          pricing = normalizeModelPricing(map[key]);
        } catch {
          pricing = null;
        }
      }
    }
    if (!pricing) return { snapshot: null, known: false };
    return {
      snapshot: {
        currency: "USD",
        inputPer1M: pricing.inputPer1M,
        outputPer1M: pricing.outputPer1M,
        ...(pricing.cachedInputPer1M !== undefined
          ? { cachedInputPer1M: pricing.cachedInputPer1M }
          : {}),
        ...(pricing.reasoningPer1M !== undefined ? { reasoningPer1M: pricing.reasoningPer1M } : {}),
        version: pricing.version ?? "manual",
      },
      known: true,
    };
  }

  calculateMicro(input: {
    tokenIn: number;
    tokenOut: number;
    cachedTokenIn?: number;
    pricing: ModelPriceSnapshot | null;
  }): number {
    if (!input.pricing) return 0;
    const price = input.pricing;
    const cached = Math.max(0, input.cachedTokenIn ?? 0);
    const normalIn = Math.max(0, input.tokenIn - cached);
    const inputMicro =
      (normalIn / 1_000_000) * price.inputPer1M * 1_000_000 +
      (cached / 1_000_000) * (price.cachedInputPer1M ?? price.inputPer1M) * 1_000_000;
    const outputMicro = (Math.max(0, input.tokenOut) / 1_000_000) * price.outputPer1M * 1_000_000;
    return Math.round(inputMicro + outputMicro);
  }

  private entryFor(
    run: Run,
    task: Task,
    kind: CostLedgerEntry["kind"],
    pricing: PriceResult,
  ): CostLedgerEntry {
    const costMicroUsd = pricing.known
      ? this.calculateMicro({
          tokenIn: run.tokenIn,
          tokenOut: run.tokenOut,
          pricing: pricing.snapshot,
        })
      : 0;
    return {
      id: `cost_${run.id}_${kind}`,
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run.id,
      agentId: run.agentId,
      modelProfileId: run.modelProfileId ?? null,
      modelId: run.modelId ?? null,
      providerId: null,
      priceSnapshot: pricing.snapshot,
      pricingKnown: pricing.known,
      tokenIn: run.tokenIn,
      tokenOut: run.tokenOut,
      cachedTokenIn: 0,
      costMicroUsd,
      costUsd: microToUsd(costMicroUsd),
      kind,
      periodDay: this.day(),
      createdAt: new Date(this.clock.now()).toISOString(),
      metadata: {},
    };
  }

  recordProvisional(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run) return;
    const task = this.store.getTask(run.taskId);
    if (!task) return;
    const pricing = this.priceFor(run.modelProfileId ?? null, run.modelId ?? null);
    const entry = this.entryFor(run, task, "provisional", pricing);
    this.watchdog.upsertProvisional(entry);
    this.watchdog.appendEvent(
      "cost.provisional",
      "run",
      runId,
      {
        runId,
        taskId: task.id,
        costMicroUsd: entry.costMicroUsd,
        tokenIn: entry.tokenIn,
        tokenOut: entry.tokenOut,
        pricingKnown: entry.pricingKnown,
      },
      `cost:${runId}:provisional`,
    );
  }

  /**
   * Final ledger + runs.cost_usd + cost.recorded 同事务（F6）。
   * 重复调用幂等（final unique index）。
   */
  recordFinal(runId: string): CostLedgerEntry | null {
    const runBefore = this.store.getRun(runId);
    if (!runBefore) return null;
    let result: CostLedgerEntry | null = null;
    this.store.withTransaction(() => {
      const run = this.store.getRun(runId);
      if (!run) return;
      const task = this.store.getTask(run.taskId);
      if (!task) return;
      const pricing = this.priceFor(run.modelProfileId ?? null, run.modelId ?? null);
      const entry = this.entryFor(run, task, "final", pricing);
      const inserted = this.watchdog.insertFinal(entry);
      if (!inserted) {
        result = this.watchdog.listFinal({ workspaceId: task.workspaceId, taskId: task.id }).find(
          (row) => row.runId === runId,
        ) ?? entry;
        return;
      }
      this.store.db
        .prepare("UPDATE runs SET cost_usd = ? WHERE id = ?")
        .run(entry.costUsd, runId);
      this.watchdog.appendEvent(
        "cost.recorded",
        "run",
        runId,
        {
          runId,
          taskId: task.id,
          agentId: run.agentId,
          kind: "final",
          costMicroUsd: entry.costMicroUsd,
          costUsd: entry.costUsd,
          pricingKnown: entry.pricingKnown,
          priceVersion: entry.priceSnapshot?.version,
        },
        `cost:${runId}:final`,
      );
      result = entry;
    });
    return result;
  }

  /** final + active provisional + reservation（F2/BU-11）。 */
  spentMicro(filter: { workspaceId: string; taskId?: string; agentId?: string }): number {
    const final = this.watchdog.sumFinal({
      workspaceId: filter.workspaceId,
      ...(filter.taskId ? { taskId: filter.taskId } : {}),
      ...(filter.agentId ? { agentId: filter.agentId } : {}),
    });
    let total = final.micro;
    const activeRuns = this.activeRuns(filter);
    for (const run of activeRuns) {
      const provisional = this.watchdog.getProvisional(run.id);
      if (provisional) total += provisional.costMicroUsd;
      total += this.reservationMicro(run);
    }
    return total;
  }

  private activeRuns(filter: { workspaceId: string; taskId?: string; agentId?: string }): Run[] {
    const tasks = filter.taskId
      ? [this.store.getTask(filter.taskId)].filter((task): task is Task => Boolean(task))
      : this.store.listTasks(filter.workspaceId);
    const runs: Run[] = [];
    for (const task of tasks) {
      const active = this.store
        .listRunsForTask(task.id)
        .filter((run) => run.status === "running" || run.status === "waiting_human");
      for (const run of active) {
        if (filter.agentId && run.agentId !== filter.agentId) continue;
        runs.push(run);
      }
    }
    return runs;
  }

  reservationMicro(run: Run): number {
    const settings = this.store.getLlmSettings();
    const profile =
      settings.models.find((model) => model.id === run.modelProfileId) ??
      settings.models.find((model) => model.modelId === run.modelId) ??
      settings.models.find((model) => model.id === settings.model) ??
      settings.models[0] ??
      null;
    const pricing =
      run.modelProfileId || run.modelId
        ? this.priceFor(run.modelProfileId ?? null, run.modelId ?? null)
        : this.priceFor(null, null);
    if (!profile || !pricing.snapshot) return 0;
    const remaining = Math.max(0, profile.maxOutputTokens - run.tokenOut);
    return Math.round((remaining / 1_000_000) * pricing.snapshot.outputPer1M * 1_000_000);
  }

  budgetLimit(
    scope: "task" | "agent" | "workspace" | "global",
    scopeId: string,
  ): { limitMicroUsd: number; softRatio: number; hardAction: "pause" | "stop" } | null {
    return this.watchdog.getBudget(scope, scopeId);
  }

  /** 启动前检查；返回 null 表示允许。 */
  checkBeforeStart(
    task: Task,
    agent: Agent,
  ): { scope: "task" | "agent" | "workspace" | "global"; scopeId: string; spentUsd: number; limitUsd: number; soft: boolean; hard: boolean; hardAction: "pause" | "stop" } | null {
    const candidates: Array<{ scope: "task" | "agent" | "workspace" | "global"; scopeId: string }> = [
      { scope: "task", scopeId: task.id },
      { scope: "agent", scopeId: agent.id },
      { scope: "workspace", scopeId: task.workspaceId },
      { scope: "global", scopeId: "*" },
    ];
    for (const candidate of candidates) {
      const limit = this.budgetLimit(candidate.scope, candidate.scopeId);
      if (!limit || limit.limitMicroUsd <= 0) continue;
      const spentMicro = this.spentMicro({
        workspaceId: task.workspaceId,
        ...(candidate.scope === "task" ? { taskId: task.id } : {}),
        ...(candidate.scope === "agent" ? { agentId: agent.id } : {}),
      });
      const spentUsd = microToUsd(spentMicro);
      const limitUsd = microToUsd(limit.limitMicroUsd);
      const ratio = limitUsd > 0 ? spentUsd / limitUsd : 0;
      const soft = ratio >= limit.softRatio;
      const hard = ratio >= 1;
      if (hard) {
        return {
          scope: candidate.scope,
          scopeId: candidate.scopeId,
          spentUsd,
          limitUsd,
          soft,
          hard,
          hardAction: limit.hardAction,
        };
      }
      if (soft) {
        // caller may emit warning; allow start
      }
    }
    return null;
  }

  budgetSnapshot(filter: { workspaceId: string; taskId?: string; agentId?: string }): {
    spentUsd: number;
    limitUsd: number;
    ratio: number;
    softRatio: number;
    hardAction: "pause" | "stop";
    pricingKnown: boolean;
  } {
    const scope = filter.taskId ? "task" : filter.agentId ? "agent" : "workspace";
    const scopeId = filter.taskId ?? filter.agentId ?? filter.workspaceId;
    const limit = this.budgetLimit(scope, scopeId);
    const spent = this.spentMicro({
      workspaceId: filter.workspaceId,
      ...(filter.taskId ? { taskId: filter.taskId } : {}),
      ...(filter.agentId ? { agentId: filter.agentId } : {}),
    });
    const spentUsd = microToUsd(spent);
    const limitUsd = microToUsd(limit?.limitMicroUsd ?? 0);
    return {
      spentUsd,
      limitUsd,
      ratio: limitUsd > 0 ? spentUsd / limitUsd : 0,
      softRatio: limit?.softRatio ?? 0.8,
      hardAction: limit?.hardAction ?? "pause",
      pricingKnown: this.priceFor(null, null).known,
    };
  }
}
