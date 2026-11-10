import { randomUUID } from "node:crypto";
import type { Agent, Run, Task } from "../shared/types.js";
import type {
  BudgetScope,
  BudgetSnapshot,
  CostSnapshot,
  FallbackChain,
  RunHandoff,
  SetBudgetInput,
  SetFallbackChainInput,
  WatchdogAlert,
  WatchdogHealth,
  WatchdogHold,
  WatchdogHoldReason,
  WatchdogResult,
  WatchdogSnapshot,
} from "../shared/watchdog.js";
import type { ExecutionKernel, KernelRunActivity } from "../kernel/execution/kernel.js";
import { systemClock, type Clock } from "../kernel/execution/clock.js";
import type { Store } from "../kernel/store.js";
import { CostService } from "./cost.js";
import { HandoffBuilder } from "./handoff.js";
import { WatchdogStore } from "./store.js";
import {
  DEFAULT_WATCHDOG_THRESHOLDS,
  clearWaitingHuman,
  createTaskSignalState,
  detectSignals,
  markWaitingHuman,
  recordActivity,
  type ActivityRecord,
  type SignalHit,
  type TaskSignalState,
  type WatchdogThresholds,
} from "./signals.js";

const HOLD_MS = 60 * 60_000;
const DEFAULT_TICK_MS = 60_000;

export interface WatchdogServiceOptions {
  store: Store;
  kernel: ExecutionKernel;
  clock?: Clock;
  dataDir?: string;
  autoTick?: boolean;
  tickIntervalMs?: number;
  thresholds?: Partial<WatchdogThresholds>;
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function microToUsd(micro: number): number {
  return Math.round(micro) / 1_000_000;
}

function bool(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  return value !== "0" && value !== "false";
}

export class WatchdogService {
  readonly watchdog: WatchdogStore;
  readonly cost: CostService;
  readonly handoff: HandoffBuilder;
  private readonly store: Store;
  private readonly kernel: ExecutionKernel;
  private readonly clock: Clock;
  private readonly thresholds: WatchdogThresholds;
  private readonly tickIntervalMs: number;
  private readonly states = new Map<string, TaskSignalState>();
  private readonly handled = new Set<string>();
  private readonly providerFailureHandled = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private lastTickMs = 0;
  private lastPatrolMs = 0;

  constructor(options: WatchdogServiceOptions) {
    this.store = options.store;
    this.kernel = options.kernel;
    this.clock = options.clock ?? systemClock;
    this.thresholds = { ...DEFAULT_WATCHDOG_THRESHOLDS, ...options.thresholds };
    this.tickIntervalMs = Math.max(1_000, options.tickIntervalMs ?? DEFAULT_TICK_MS);
    this.watchdog = new WatchdogStore(this.store, this.clock);
    this.cost = new CostService(this.store, this.watchdog, this.clock);
    this.handoff = new HandoffBuilder({
      store: this.store,
      watchdog: this.watchdog,
      clock: this.clock,
      dataDir: options.dataDir,
    });
    for (const workspace of this.store.listWorkspaces()) {
      this.watchdog.ensureState(workspace.id);
    }
    this.store.onEvent((event) => {
      if (
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        event.type === "run.cancelled"
      ) {
        this.finalizeRunEvent(event.aggregateId, true);
      }
    });
    if (options.autoTick !== false) {
      const timer = setInterval(() => this.tick(), this.tickIntervalMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.timer = timer;
    }
  }

  close(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private finalizeRunEvent(runId: string, handleProviderFailure = false): void {
    try {
      const run = this.store.getRun(runId);
      if (run && handleProviderFailure) {
        const task = this.store.getTask(run.taskId);
        if (task) this.recordProviderFailure(run, task);
      }
      this.cost.recordFinal(runId);
      if (run) {
        this.watchdog.resolveAlertsForTask(run.taskId);
        this.states.delete(run.taskId);
      }
    } catch {
      // 成本入账失败不能阻断内核事件消费；启动对账会补
    }
  }

  private recordProviderFailure(run: Run, task: Task): void {
    const code = (run.errorCode ?? "").toLowerCase();
    if (!/(rate_limit|quota|quota_exceeded|429|1308)/.test(code)) return;
    if (this.providerFailureHandled.has(run.id)) return;
    this.providerFailureHandled.add(run.id);
    const settings = this.store.getLlmSettings();
    const agent = this.store.getAgent(run.agentId);
    const profile =
      settings.models.find((model) => model.id === run.modelProfileId) ??
      settings.models.find((model) => model.modelId === run.modelId) ??
      settings.models.find((model) => model.id === agent?.model) ??
      settings.models.find((model) => model.modelId === agent?.model) ??
      settings.models.find((model) => model.id === settings.model) ??
      settings.models[0] ??
      null;
    if (!profile) return;
    const until = new Date(this.clock.now() + 5 * 60_000).toISOString();
    this.watchdog.setCooldown({
      providerId: profile.providerId,
      modelId: profile.modelId,
      until,
      reason: run.errorCode ?? "provider_quota",
    });
    this.watchdog.appendEvent("provider.quota_error", "run", run.id, {
      providerId: profile.providerId,
      modelId: profile.modelId,
      code: run.errorCode ?? "provider_quota",
      resetAt: until,
    });
    this.watchdog.appendEvent("provider.cooldown_started", "workspace", task.workspaceId, {
      providerId: profile.providerId,
      modelId: profile.modelId,
      until,
      reason: run.errorCode ?? "provider_quota",
    });
    this.watchdog.appendEvent("watchdog.signal", "task", task.id, {
      kind: "provider_quota",
      severity: "warning",
      taskId: task.id,
      runId: run.id,
      evidence: { providerId: profile.providerId, modelId: profile.modelId, until },
      windowMs: 300_000,
    });
    this.createAlert({
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run.id,
      kind: "provider_quota",
      severity: "warning",
      title: "供应商配额错误，已冷却当前模型",
      detail: { providerId: profile.providerId, modelId: profile.modelId, until },
      dedupeKey: `${task.id}:quota:${Math.floor(this.clock.now() / 300_000)}`,
    });

    // t157 F2：429/quota 必须走既有 fallback（新 Run 模型 override + handoff + 冷却）。
    const state = this.watchdog.getTaskState(task.workspaceId, task.id);
    if (state.autoInterventions >= 2) {
      this.escalate(
        task,
        run,
        {
          kind: "provider_quota",
          severity: "critical",
          evidence: { providerId: profile.providerId, modelId: profile.modelId },
          windowMs: 300_000,
        },
        "provider quota after auto intervention limit",
      );
      return;
    }
    const chain = this.watchdog.getFallback(task.workspaceId, run.agentId);
    const current = run.modelProfileId;
    let target: { id: string; providerId: string; modelId: string } | null = null;
    for (const modelId of chain.models) {
      if (modelId === current) continue;
      const candidate =
        settings.models.find((model) => model.id === modelId) ??
        settings.models.find((model) => model.modelId === modelId);
      if (!candidate) continue;
      if (this.watchdog.isCooling(candidate.providerId, candidate.modelId, new Date(this.clock.now()).toISOString())) {
        continue;
      }
      target = candidate;
      break;
    }
    if (!target) return;
    const handoff = this.handoff.build({
      run,
      task,
      reason: "fallback",
      toModelProfileId: target.id,
    });
    const intervention = this.watchdog.createIntervention({
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run.id,
      level: "fallback",
      action: "provider_quota_fallback",
      reason: "provider_quota",
      handoffId: handoff.id,
      detail: { from: profile.id, to: target.id, until },
    });
    const autoIndex = this.watchdog.bumpAutoInterventions(task.workspaceId, task.id);
    try {
      this.kernel.retryTaskWithModel(task.id, {
        modelProfileId: target.id,
        handoffId: handoff.id,
      });
    } catch {
      this.watchdog.updateIntervention(intervention.id, "skipped", { handoffId: handoff.id });
      return;
    }
    this.watchdog.updateIntervention(intervention.id, "applied", { handoffId: handoff.id });
    this.watchdog.appendEvent("run.model_fallback", "run", run.id, {
      runId: run.id,
      taskId: task.id,
      fromModelProfileId: current ?? null,
      toModelProfileId: target.id,
      reason: "provider_quota",
      handoffId: handoff.id,
    });
    this.createAlert({
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run.id,
      kind: "provider_quota",
      severity: "warning",
      title: `配额错误，已切换模型：${current ?? "默认"} → ${target.id}`,
      detail: { handoffId: handoff.id, autoInterventions: autoIndex, until },
      dedupeKey: `${task.id}:quota-fallback:${Math.floor(this.clock.now() / 300_000)}`,
    });
  }

  /** 供 provider 错误适配器/测试显式记录 429/quota。 */
  recordProviderQuota(input: {
    providerId: string;
    modelId: string;
    taskId?: string | null;
    resetAt?: string;
  }): void {
    const until = input.resetAt ?? new Date(this.clock.now() + 5 * 60_000).toISOString();
    this.watchdog.setCooldown({
      providerId: input.providerId,
      modelId: input.modelId,
      until,
      reason: "provider_quota",
    });
    this.watchdog.appendEvent("provider.quota_error", "provider", input.providerId, {
      providerId: input.providerId,
      modelId: input.modelId,
      code: "429",
      resetAt: until,
    });
    this.watchdog.appendEvent("provider.cooldown_started", "provider", input.providerId, {
      providerId: input.providerId,
      modelId: input.modelId,
      until,
      reason: "429",
    });
  }

  // ------------------------------------------------------------- kernel hooks

  beforeStart(info: {
    workspaceId: string;
    taskId: string;
    runId: string;
    agentId: string;
    attempt: number;
  }): boolean {
    if (!this.enabled(info.workspaceId)) return true;
    const task = this.store.getTask(info.taskId);
    const agent = this.store.getAgent(info.agentId);
    if (!task || !agent) return false;
    const budget = this.cost.checkBeforeStart(task, agent);
    if (budget?.hard) {
      this.holdForBudget(task, budget);
      return false;
    }
    if (budget?.soft) {
      this.emitBudget("warning", budget.scope, budget.scopeId, budget.spentUsd, budget.limitUsd);
    }
    return true;
  }

  onRunStarted(info: { runId: string; taskId: string; agentId: string }): void {
    const now = this.clock.now();
    const run = this.store.getRun(info.runId);
    const state = createTaskSignalState({ taskId: info.taskId, runId: info.runId, at: now });
    if (run) state.lastActivityAt = Date.parse(run.startedAt);
    this.states.set(info.taskId, state);
  }

  onRunActivity(info: KernelRunActivity): void {
    const now = Date.parse(info.at);
    let state = this.states.get(info.taskId);
    if (!state) {
      state = createTaskSignalState({ taskId: info.taskId, runId: info.runId, at: now });
      this.states.set(info.taskId, state);
    }
    const payload = info.payload ?? {};
    const kind = info.kind;
    if (kind === "run.waiting_human") markWaitingHuman(state, now);
    if (kind === "run.resumed") clearWaitingHuman(state, now);
    const record: ActivityRecord = {
      kind,
      at: now,
      toolName: typeof payload.name === "string" ? payload.name : undefined,
      toolSignature:
        typeof payload.name === "string" && payload.arguments !== undefined
          ? `${payload.name}:${JSON.stringify(payload.arguments).slice(0, 512)}`
          : undefined,
      file:
        typeof payload.path === "string"
          ? payload.path
          : typeof payload.file === "string"
            ? payload.file
            : undefined,
      ok: typeof payload.ok === "boolean" ? payload.ok : undefined,
      progress:
        kind === "tool.result" &&
        Boolean(payload.ok) &&
        ["fs.write", "fs.edit", "shell.run", "git.commit"].includes(String(payload.name)),
      tokenIn: typeof payload.inputTokens === "number" ? payload.inputTokens : undefined,
      tokenOut: typeof payload.outputTokens === "number" ? payload.outputTokens : undefined,
    };
    recordActivity(state, record);
  }

  onRunHeartbeat(info: {
    runId: string;
    taskId: string;
    agentId: string;
    heartbeatAt: string;
    tokenIn: number;
    tokenOut: number;
    steps: number;
    status: Run["status"];
  }): void {
    if (!this.enabled(this.store.getTask(info.taskId)?.workspaceId ?? "")) return;
    this.cost.recordProvisional(info.runId);
    const task = this.store.getTask(info.taskId);
    if (!task) return;
    const state = this.states.get(info.taskId);
    if (state) {
      state.tokenSamples.push({ at: Date.parse(info.heartbeatAt), tokenIn: info.tokenIn, tokenOut: info.tokenOut });
    }
    this.checkActiveBudget(task, info.agentId, info.runId);
  }

  onRunFinished(info: { runId: string; taskId: string; status: string }): void {
    this.finalizeRunEvent(info.runId, false);
  }

  // ---------------------------------------------------------------- signals

  private enabled(workspaceId: string): boolean {
    if (this.disposed || !workspaceId) return false;
    return bool(this.store.getSetting("watchdog.enabled"), true);
  }

  private threshold(key: keyof WatchdogThresholds): number {
    const raw = this.store.getSetting(`watchdog.${key}`);
    const value = Number(raw);
    return raw !== null && Number.isFinite(value) && value >= 0 ? value : this.thresholds[key];
  }

  tick(nowMs = this.clock.now()): void {
    if (this.disposed) return;
    const workspaces = this.store.listWorkspaces();
    for (const workspace of workspaces) {
      if (!this.enabled(workspace.id)) continue;
      const state = this.watchdog.getState(workspace.id);
      if (state.lastTickAt) {
        const gap = nowMs - Date.parse(state.lastTickAt);
        if (gap > this.tickIntervalMs * 2) {
          this.createAlert({
            workspaceId: workspace.id,
            kind: "deadman",
            severity: "critical",
            title: "看门狗心跳中断",
            detail: { gapMs: gap, lastTickAt: state.lastTickAt },
            dedupeKey: `${workspace.id}:deadman:${Math.floor(nowMs / 600_000)}`,
          });
          this.watchdog.markDeadman(workspace.id, new Date(nowMs).toISOString());
          this.watchdog.appendEvent("watchdog.deadman", "workspace", workspace.id, {
            workspaceId: workspace.id,
            lastTickAt: state.lastTickAt,
            gapMs: gap,
          });
        }
      }
      this.watchdog.markTick(workspace.id, new Date(nowMs).toISOString());
      for (const task of this.store.listTasks(workspace.id)) {
        if (task.status === "running") {
          const run = this.store
            .listRunsForTask(task.id)
            .find((item) => item.status === "running" || item.status === "waiting_human");
          if (run) this.evaluateTask(task, run, nowMs);
        }
      }
    }
    this.lastTickMs = nowMs;
  }

  patrol(nowMs = this.clock.now()): void {
    if (this.disposed) return;
    for (const workspace of this.store.listWorkspaces()) {
      if (!this.enabled(workspace.id)) continue;
      this.watchdog.markPatrol(workspace.id, new Date(nowMs).toISOString());
    }
    this.tick(nowMs);
    this.lastPatrolMs = nowMs;
  }

  private evaluateTask(task: Task, run: Run, now: number): void {
    let state = this.states.get(task.id);
    if (!state) {
      state = createTaskSignalState({ taskId: task.id, runId: run.id, at: now });
      state.lastActivityAt = Date.parse(run.startedAt);
      this.states.set(task.id, state);
    }
    if (run.status === "waiting_human") markWaitingHuman(state, now);
    const hits = detectSignals(state, now, {
      ...this.thresholds,
      taskCheckMs: this.threshold("taskCheckMs"),
      stallMs: this.threshold("stallMs"),
      repeatToolCount: this.threshold("repeatToolCount"),
      sameFileWriteCount: this.threshold("sameFileWriteCount"),
      errorStreak: this.threshold("errorStreak"),
      tokenBurnPer5m: this.threshold("tokenBurnPer5m"),
      waitingHumanGraceMs: this.threshold("waitingHumanGraceMs"),
    });
    if (!hits.length) return;
    const hit = hits[0];
    const stateRow = this.watchdog.getTaskState(task.workspaceId, task.id);
    const bucket = `${task.id}:${hit.kind}:${Math.floor(now / Math.max(1, hit.windowMs))}`;
    this.createAlert({
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run.id,
      kind: hit.kind,
      severity: hit.severity,
      title: this.signalTitle(hit),
      detail: hit.evidence,
      dedupeKey: bucket,
    });
    this.watchdog.appendEvent("watchdog.signal", "task", task.id, {
      kind: hit.kind,
      severity: hit.severity,
      taskId: task.id,
      runId: run.id,
      evidence: hit.evidence,
      windowMs: hit.windowMs,
    });
    if (this.handled.has(bucket)) return;
    if (stateRow.autoInterventions >= 2) {
      this.escalate(task, run, hit, "auto interventions exhausted");
      this.handled.add(bucket);
      return;
    }
    if (this.watchdog.getActiveIntervention(task.id)) return;

    if (hit.kind === "token_burn") {
      this.nudge(task, run, hit);
    } else if (hit.kind === "provider_quota" || hit.kind === "error_streak") {
      if (!this.fallback(task, run, hit)) this.escalate(task, run, hit, "no fallback model");
    } else if (hit.kind === "heartbeat_stale") {
      this.pauseTask(task, run, hit);
    } else {
      const nudgeCount = stateRow.nudgeCount;
      if (nudgeCount < 3 && now - state.lastNudgeAt >= 5 * 60_000) this.nudge(task, run, hit);
      else this.pauseTask(task, run, hit);
    }
    this.handled.add(bucket);
  }

  private signalTitle(hit: SignalHit): string {
    const labels: Record<string, string> = {
      heartbeat_stale: "任务无活动",
      task_timeout: "任务接近超时",
      repeat_tool: "工具调用重复",
      no_progress: "无文件进展",
      error_streak: "连续错误",
      token_burn: "Token 消耗异常",
      provider_quota: "供应商配额错误",
      budget_soft: "预算接近上限",
      budget_hard: "预算已超限",
      deadman: "看门狗心跳中断",
    };
    return labels[hit.kind] ?? hit.kind;
  }

  private createAlert(input: {
    workspaceId: string;
    taskId?: string | null;
    runId?: string | null;
    kind: Parameters<WatchdogStore["createAlert"]>[0]["kind"];
    severity: "info" | "warning" | "critical";
    title: string;
    detail: Record<string, unknown>;
    dedupeKey: string;
  }): WatchdogAlert {
    return this.watchdog.createAlert({
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      runId: input.runId,
      kind: input.kind,
      severity: input.severity,
      title: input.title,
      detail: input.detail,
      dedupeKey: input.dedupeKey,
    });
  }

  private nudge(task: Task, run: Run, hit: SignalHit): void {
    const state = this.states.get(task.id);
    const count = this.watchdog.bumpNudgeCount(task.workspaceId, task.id);
    const intervention = this.watchdog.createIntervention({
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run.id,
      level: "nudge",
      action: "nudge",
      reason: hit.kind,
      detail: hit.evidence,
    });
    this.kernel.injectNudge(
      run.id,
      `看门狗检测到 ${hit.kind}。先总结当前状态与下一步，再做一次最小进展；不要重复已完成的工具调用。`,
      hit.kind,
    );
    this.watchdog.updateIntervention(intervention.id, "applied");
    this.watchdog.appendEvent("watchdog.nudged", "task", task.id, {
      taskId: task.id,
      runId: run.id,
      reason: hit.kind,
      nudgeCount: count,
    });
    if (state) state.lastNudgeAt = this.clock.now();
    this.createAlert({
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run.id,
      kind: hit.kind,
      severity: "info",
      title: `提醒：${this.signalTitle(hit)}`,
      detail: hit.evidence,
      dedupeKey: `${task.id}:nudge:${Math.floor(this.clock.now() / 300_000)}`,
    });
  }

  private pauseTask(task: Task, run: Run, hit: SignalHit): void {
    if (this.watchdog.getActiveIntervention(task.id)) return;
    const handoff = this.handoff.build({ run, task, reason: "pause" });
    const intervention = this.watchdog.createIntervention({
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run.id,
      level: "pause",
      action: "pause_checkpoint",
      reason: hit.kind,
      handoffId: handoff.id,
      detail: hit.evidence,
    });
    this.watchdog.addHold({
      workspaceId: task.workspaceId,
      taskId: task.id,
      reason: "watchdog",
      scope: "task",
    });
    const autoIndex = this.watchdog.bumpAutoInterventions(task.workspaceId, task.id);
    this.kernel.interruptRun(run.id, {
      code: "WATCHDOG_PAUSED",
      message: `watchdog paused: ${hit.kind}`,
      retryable: true,
      retryDelayMs: HOLD_MS,
      handoffId: handoff.id,
    });
    this.kernel.holdTask(task.id, new Date(this.clock.now() + HOLD_MS).toISOString());
    this.watchdog.updateIntervention(intervention.id, "applied", { handoffId: handoff.id });
    this.watchdog.appendEvent("watchdog.paused", "task", task.id, {
      taskId: task.id,
      runId: run.id,
      reason: hit.kind,
      handoffId: handoff.id,
      scope: "task",
    });
    this.createAlert({
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run.id,
      kind: hit.kind,
      severity: "warning",
      title: `已暂停：${this.signalTitle(hit)}`,
      detail: { ...hit.evidence, handoffId: handoff.id, autoInterventions: autoIndex },
      dedupeKey: `${task.id}:pause:${Math.floor(this.clock.now() / 300_000)}`,
    });
  }

  private fallback(task: Task, run: Run, hit: SignalHit): boolean {
    const chain = this.watchdog.getFallback(task.workspaceId, run.agentId);
    const current = run.modelProfileId ?? null;
    let target: { id: string; modelId: string; providerId: string } | null = null;
    for (const modelId of chain.models) {
      if (modelId === current) continue;
      const profile =
        this.store.getLlmSettings().models.find((model) => model.id === modelId) ??
        this.store.getLlmSettings().models.find((model) => model.modelId === modelId);
      if (!profile) continue;
      if (this.watchdog.isCooling(profile.providerId, profile.modelId, new Date(this.clock.now()).toISOString())) {
        continue;
      }
      target = profile;
      break;
    }
    if (!target) return false;
    const handoff = this.handoff.build({
      run,
      task,
      reason: "fallback",
      toModelProfileId: target.id,
    });
    const intervention = this.watchdog.createIntervention({
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run.id,
      level: "fallback",
      action: "fallback_model",
      reason: hit.kind,
      handoffId: handoff.id,
      detail: { ...hit.evidence, toModelProfileId: target.id },
    });
    const autoIndex = this.watchdog.bumpAutoInterventions(task.workspaceId, task.id);
    this.kernel.interruptRun(run.id, {
      code: "WATCHDOG_MODEL_SWITCH",
      message: `watchdog fallback to ${target.id}`,
      retryable: true,
      retryDelayMs: 0,
      nextModelProfileId: target.id,
      handoffId: handoff.id,
    });
    this.watchdog.updateIntervention(intervention.id, "applied", { handoffId: handoff.id });
    this.watchdog.appendEvent("run.model_fallback", "run", run.id, {
      runId: run.id,
      taskId: task.id,
      fromModelProfileId: current,
      toModelProfileId: target.id,
      reason: hit.kind,
      handoffId: handoff.id,
    });
    this.kernel.tick();
    this.createAlert({
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run.id,
      kind: hit.kind,
      severity: "warning",
      title: `已切换模型：${current ?? "默认"} → ${target.id}`,
      detail: { handoffId: handoff.id, autoInterventions: autoIndex },
      dedupeKey: `${task.id}:fallback:${Math.floor(this.clock.now() / 300_000)}`,
    });
    return true;
  }

  switchMember(taskId: string, reason = "watchdog_member_switch"): WatchdogResult<RunHandoff> {
    const task = this.store.getTask(taskId);
    if (!task) return this.fail("NOT_FOUND", `task not found: ${taskId}`);
    const run = this.kernel.listRuns(taskId).find((item) => item.status === "running");
    if (!run) return this.fail("CONFLICT", "task has no running Run");
    if (this.watchdog.getTaskState(task.workspaceId, task.id).autoInterventions >= 2) {
      this.escalate(task, run, {
        kind: "error_streak",
        severity: "critical",
        evidence: { reason: "switch_member_after_limit" },
        windowMs: 300_000,
      }, "auto interventions exhausted");
      return this.fail("CONFLICT", "auto intervention limit reached");
    }
    const candidates = this.store
      .listAgents(task.workspaceId)
      .filter(
        (agent) =>
          !agent.isRouter &&
          agent.status !== "offline" &&
          agent.id !== run.agentId &&
          this.kernel.listRuns(task.id).every((item) => item.agentId !== agent.id || item.status !== "running"),
      );
    const target = candidates[0];
    if (!target) return this.fail("CONFLICT", "no available member");
    const handoff = this.handoff.build({
      run,
      task,
      reason: "member_switch",
      toAgentId: target.id,
    });
    const intervention = this.watchdog.createIntervention({
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run.id,
      level: "member",
      action: "switch_member",
      reason,
      handoffId: handoff.id,
      detail: { toAgentId: target.id },
    });
    const autoIndex = this.watchdog.bumpAutoInterventions(task.workspaceId, task.id);
    this.kernel.interruptRun(run.id, {
      code: "WATCHDOG_MEMBER_SWITCH",
      message: `watchdog switch member to ${target.id}`,
      retryable: true,
      retryDelayMs: 0,
      handoffId: handoff.id,
    });
    this.kernel.reassignTask(task.id, target.id, reason);
    this.watchdog.updateIntervention(intervention.id, "applied", { handoffId: handoff.id });
    this.watchdog.appendEvent("run.member_switched", "run", run.id, {
      runId: run.id,
      taskId: task.id,
      fromAgentId: run.agentId,
      toAgentId: target.id,
      reason,
      handoffId: handoff.id,
    });
    this.kernel.tick();
    this.createAlert({
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run.id,
      kind: "error_streak",
      severity: "warning",
      title: `已切换成员：${target.name}`,
      detail: { handoffId: handoff.id, autoInterventions: autoIndex },
      dedupeKey: `${task.id}:member:${Math.floor(this.clock.now() / 300_000)}`,
    });
    return { ok: true, value: handoff };
  }

  private escalate(task: Task, run: Run | null, hit: SignalHit, reason: string): void {
    const intervention = this.watchdog.createIntervention({
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run?.id ?? null,
      level: "human",
      action: "escalate",
      reason,
      detail: hit.evidence,
    });
    this.watchdog.addHold({
      workspaceId: task.workspaceId,
      taskId: task.id,
      reason: "escalation",
      scope: "workspace",
    });
    this.kernel.pauseScheduler(task.workspaceId, "watchdog_escalation");
    this.watchdog.setPausedBy(task.workspaceId, "watchdog");
    this.watchdog.updateIntervention(intervention.id, "applied");
    this.watchdog.appendEvent("watchdog.escalated", "task", task.id, {
      taskId: task.id,
      runId: run?.id,
      reason,
      autoInterventions: this.watchdog.getTaskState(task.workspaceId, task.id).autoInterventions,
    });
    this.createAlert({
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run?.id ?? null,
      kind: hit.kind,
      severity: "critical",
      title: `需要人工介入：${this.signalTitle(hit)}`,
      detail: { ...hit.evidence, reason },
      dedupeKey: `${task.id}:human:${Math.floor(this.clock.now() / 300_000)}`,
    });
  }

  // ---------------------------------------------------------------- budget

  private holdForBudget(
    task: Task,
    budget: { scope: BudgetScope; scopeId: string; spentUsd: number; limitUsd: number; hardAction: "pause" | "stop" },
  ): void {
    this.watchdog.addHold({
      workspaceId: task.workspaceId,
      taskId: task.id,
      reason: "budget",
      scope: budget.scope,
    });
    this.kernel.holdTask(task.id, new Date(this.clock.now() + HOLD_MS).toISOString());
    this.watchdog.appendEvent(
      "cost.budget_exceeded",
      "task",
      task.id,
      {
        scope: budget.scope,
        scopeId: budget.scopeId,
        spentUsd: budget.spentUsd,
        limitUsd: budget.limitUsd,
        ratio: budget.limitUsd > 0 ? budget.spentUsd / budget.limitUsd : 1,
        action: budget.hardAction,
      },
      `budget:${budget.scope}:${budget.scopeId}:${Math.floor(this.clock.now() / 60_000)}`,
    );
    this.createAlert({
      workspaceId: task.workspaceId,
      taskId: task.id,
      kind: "budget_hard",
      severity: "critical",
      title: "预算已超限，任务已暂停",
      detail: { ...budget },
      dedupeKey: `${task.id}:budget:${Math.floor(this.clock.now() / 300_000)}`,
    });
  }

  private checkActiveBudget(task: Task, agentId: string, runId: string): void {
    const agent = this.store.getAgent(agentId);
    if (!agent) return;
    const budget = this.cost.checkBeforeStart(task, agent);
    if (!budget?.hard) {
      if (budget?.soft) {
        this.emitBudget("warning", budget.scope, budget.scopeId, budget.spentUsd, budget.limitUsd);
      }
      return;
    }
    const hold = this.watchdog
      .listHolds(task.workspaceId, task.id)
      .some((item) => item.reason === "budget");
    if (hold) return;
    const run = this.store.getRun(runId);
    if (!run || (run.status !== "running" && run.status !== "waiting_human")) return;
    const handoff = this.handoff.build({ run, task, reason: "pause" });
    this.watchdog.createIntervention({
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId,
      level: "pause",
      action: "budget_pause",
      reason: "budget_hard",
      handoffId: handoff.id,
      detail: budget,
    });
    this.watchdog.addHold({
      workspaceId: task.workspaceId,
      taskId: task.id,
      reason: "budget",
      scope: budget.scope,
    });
    if (budget.hardAction === "stop") {
      this.kernel.interruptRun(runId, {
        code: "BUDGET_EXHAUSTED",
        message: "budget exhausted",
        retryable: false,
      });
    } else {
      this.kernel.interruptRun(runId, {
        code: "BUDGET_EXHAUSTED",
        message: "budget exhausted; task held",
        retryable: true,
        retryDelayMs: HOLD_MS,
      });
      this.kernel.holdTask(task.id, new Date(this.clock.now() + HOLD_MS).toISOString());
    }
    this.watchdog.appendEvent("cost.budget_exceeded", "task", task.id, {
      scope: budget.scope,
      scopeId: budget.scopeId,
      spentUsd: budget.spentUsd,
      limitUsd: budget.limitUsd,
      ratio: budget.limitUsd > 0 ? budget.spentUsd / budget.limitUsd : 1,
      action: budget.hardAction,
    });
    this.createAlert({
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId,
      kind: "budget_hard",
      severity: "critical",
      title: "预算已超限，任务已暂停",
      detail: { ...budget, handoffId: handoff.id },
      dedupeKey: `${task.id}:budget:${Math.floor(this.clock.now() / 300_000)}`,
    });
  }

  private emitBudget(
    severity: "info" | "warning" | "critical",
    scope: BudgetScope,
    scopeId: string,
    spentUsd: number,
    limitUsd: number,
  ): void {
    if (severity === "info") return;
    this.watchdog.appendEvent("cost.budget_warning", "workspace", scopeId, {
      scope,
      scopeId,
      spentUsd,
      limitUsd,
      ratio: limitUsd > 0 ? spentUsd / limitUsd : 0,
    });
  }

  // ------------------------------------------------------------------- API

  private makeBudgetSnapshot(
    workspaceId: string,
    scope: BudgetScope,
    scopeId: string,
  ): BudgetSnapshot {
    const workspaceSnap = this.cost.budgetSnapshot({ workspaceId });
    const empty = { spentUsd: 0, limitUsd: 0, ratio: 0 };
    const target =
      scope === "task"
        ? this.cost.budgetSnapshot({ workspaceId, taskId: scopeId })
        : scope === "agent"
          ? this.cost.budgetSnapshot({ workspaceId, agentId: scopeId })
          : workspaceSnap;
    return {
      task: scope === "task" ? { taskId: scopeId, ...target } : { taskId: null, ...empty },
      agentDay: scope === "agent" ? { agentId: scopeId, ...target } : { agentId: null, ...empty },
      workspaceDay: {
        spentUsd: workspaceSnap.spentUsd,
        limitUsd: workspaceSnap.limitUsd,
        ratio: workspaceSnap.ratio,
      },
      softRatio: workspaceSnap.softRatio,
      hardAction: workspaceSnap.hardAction,
      pricingKnown: workspaceSnap.pricingKnown,
    };
  }

  getSnapshot(workspaceId: string): WatchdogResult<WatchdogSnapshot> {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) return this.fail("NOT_FOUND", "workspace not found");
    const state = this.watchdog.getState(workspaceId);
    const activeTask = this.store
      .listTasks(workspaceId)
      .find((task) => task.status === "running" || task.status === "queued" || task.status === "blocked");
    const activeRun = activeTask
      ? this.store.listRunsForTask(activeTask.id).find((run) => run.status === "running")
      : null;
    const budgets = this.makeBudgetSnapshot(
      workspaceId,
      activeTask ? "task" : "workspace",
      activeTask?.id ?? workspaceId,
    );
    if (activeRun) {
      const agentBudget = this.cost.budgetSnapshot({ workspaceId, agentId: activeRun.agentId });
      budgets.agentDay = { agentId: activeRun.agentId, spentUsd: agentBudget.spentUsd, limitUsd: agentBudget.limitUsd, ratio: agentBudget.ratio };
    }
    const health: WatchdogHealth = {
      lastTickAt: state.lastTickAt,
      lastPatrolAt: state.lastPatrolAt,
      stale:
        state.lastTickAt !== null && this.clock.now() - Date.parse(state.lastTickAt) > this.tickIntervalMs * 2,
      enabled: state.enabled,
      deadman: state.deadmanAt !== null,
    };
    return {
      ok: true,
      value: {
        workspaceId,
        enabled: state.enabled,
        deadman: state.deadmanAt !== null,
        pausedBy: state.pausedBy as WatchdogHoldReason | null,
        health,
        alerts: this.watchdog.listAlerts(workspaceId, 50),
        interventions: this.watchdog.listInterventions(workspaceId, 50),
        holds: this.watchdog.listHolds(workspaceId),
        budgets,
        fallback: this.watchdog.getFallback(workspaceId),
        updatedAt: new Date(this.clock.now()).toISOString(),
      },
    };
  }

  getCosts(workspaceId: string): WatchdogResult<CostSnapshot> {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) return this.fail("NOT_FOUND", "workspace not found");
    const day = this.cost.day();
    const final = this.watchdog.listFinal({ workspaceId, day });
    const totalMicro = final.reduce((sum, entry) => sum + entry.costMicroUsd, 0);
    const byAgent = new Map<string, number>();
    const byTask = new Map<string, number>();
    for (const entry of final) {
      byAgent.set(entry.agentId, (byAgent.get(entry.agentId) ?? 0) + entry.costMicroUsd);
      byTask.set(entry.taskId, (byTask.get(entry.taskId) ?? 0) + entry.costMicroUsd);
    }
    const budgets = this.makeBudgetSnapshot(workspaceId, "workspace", workspaceId);
    return {
      ok: true,
      value: {
        workspaceId,
        day,
        totals: { usd: microToUsd(totalMicro), known: final.every((entry) => entry.pricingKnown), runs: final.length },
        byAgent: [...byAgent.entries()].map(([agentId, micro]) => ({ agentId, usd: microToUsd(micro) })),
        byTask: [...byTask.entries()].map(([taskId, micro]) => ({ taskId, usd: microToUsd(micro) })),
        recent: final.slice(0, 50),
        budgets,
      },
    };
  }

  getRunHandoff(workspaceId: string, runId: string): WatchdogResult<RunHandoff | null> {
    const run = this.store.getRun(runId);
    if (run) {
      const task = this.store.getTask(run.taskId);
      if (!task || task.workspaceId !== workspaceId) {
        return this.fail("NOT_FOUND", "run not found in workspace");
      }
    }
    return { ok: true, value: this.watchdog.getHandoff(workspaceId, runId) };
  }

  ackAlert(workspaceId: string, alertId: string, actor = "user"): WatchdogResult<WatchdogAlert> {
    const alert = this.watchdog.getAlert(workspaceId, alertId);
    if (!alert) return this.fail("NOT_FOUND", "alert not found");
    const updated = this.watchdog.updateAlertStatus(workspaceId, alertId, "acked", actor);
    if (!updated) return this.fail("NOT_FOUND", "alert not found");
    this.watchdog.appendEvent("watchdog.alert_acknowledged", "watchdog", alertId, {
      alertId,
      taskId: alert.taskId ?? undefined,
      actor,
    });
    return { ok: true, value: updated };
  }

  resolveAlert(workspaceId: string, alertId: string, actor = "user"): WatchdogResult<WatchdogAlert> {
    const alert = this.watchdog.getAlert(workspaceId, alertId);
    if (!alert) return this.fail("NOT_FOUND", "alert not found");
    const updated = this.watchdog.updateAlertStatus(workspaceId, alertId, "resolved", actor);
    if (!updated) return this.fail("NOT_FOUND", "alert not found");
    return { ok: true, value: updated };
  }

  releaseTaskHold(
    workspaceId: string,
    taskId: string,
    reason?: WatchdogHoldReason,
    all = false,
  ): WatchdogResult<void> {
    const task = this.store.getTask(taskId);
    if (!task || task.workspaceId !== workspaceId) return this.fail("NOT_FOUND", "task not found");
    if (!reason && !all) {
      return this.fail("INVALID_INPUT", "releaseTaskHold requires reason or all=true");
    }
    const remaining = this.watchdog.releaseHolds(
      workspaceId,
      taskId,
      all ? null : (reason ?? null),
      "user",
    );
    if (remaining.length === 0) {
      this.kernel.releaseTaskHold(taskId);
      this.watchdog.resetTaskState(workspaceId, taskId);
      this.watchdog.setPausedBy(workspaceId, null);
      this.watchdog.appendEvent("watchdog.resumed", "task", taskId, {
        taskId,
        actor: "user",
        ...(reason ? { reason } : {}),
      });
    }
    return { ok: true, value: undefined };
  }

  setBudget(input: SetBudgetInput): WatchdogResult<BudgetSnapshot> {
    if (!this.store.getWorkspace(input.workspaceId)) return this.fail("NOT_FOUND", "workspace not found");
    if (!Number.isFinite(input.limitUsd) || input.limitUsd < 0) {
      return this.fail("INVALID_INPUT", "limitUsd must be non-negative");
    }
    const soft = input.softRatio ?? 0.8;
    if (soft < 0.1 || soft > 1) return this.fail("INVALID_INPUT", "softRatio must be 0.1..1");
    const hardAction = input.hardAction === "stop" ? "stop" : "pause";
    if (input.scope === "task") {
      const task = this.store.getTask(input.scopeId);
      if (!task || task.workspaceId !== input.workspaceId) return this.fail("NOT_FOUND", "task not found");
    } else if (input.scope === "agent") {
      const agent = this.store.getAgent(input.scopeId);
      if (!agent || agent.workspaceId !== input.workspaceId) return this.fail("NOT_FOUND", "agent not found");
    } else if (input.scope === "workspace" && input.scopeId !== input.workspaceId) {
      return this.fail("INVALID_INPUT", "workspace scopeId must equal workspaceId");
    }
    this.watchdog.setBudget({
      workspaceId: input.workspaceId,
      scope: input.scope,
      scopeId: input.scopeId,
      limitMicroUsd: Math.round(input.limitUsd * 1_000_000),
      softRatio: soft,
      hardAction,
    });
    this.watchdog.appendEvent("cost.budget_changed", "workspace", input.workspaceId, {
      workspaceId: input.workspaceId,
      scope: input.scope,
      scopeId: input.scopeId,
      limitUsd: input.limitUsd,
    });
    return {
      ok: true,
      value: this.makeBudgetSnapshot(input.workspaceId, input.scope, input.scopeId),
    };
  }

  setFallbackChain(input: SetFallbackChainInput): WatchdogResult<FallbackChain> {
    if (!this.store.getWorkspace(input.workspaceId)) return this.fail("NOT_FOUND", "workspace not found");
    if (new Set(input.models).size !== input.models.length) {
      return this.fail("INVALID_INPUT", "fallback models must be unique");
    }
    const settings = this.store.getLlmSettings();
    const known = new Set(settings.models.map((model) => model.id));
    for (const model of input.models) {
      if (!known.has(model) && !settings.models.some((item) => item.modelId === model)) {
        return this.fail("INVALID_INPUT", `unknown model: ${model}`);
      }
    }
    const chain: FallbackChain = {
      workspaceId: input.workspaceId,
      agentId: input.agentId ?? null,
      models: input.models,
      maxSwitches: input.maxSwitches ?? 2,
      onQuota: input.onQuota ?? true,
      onErrors: input.onErrors ?? true,
    };
    this.watchdog.setFallback(chain);
    return { ok: true, value: this.watchdog.getFallback(input.workspaceId, input.agentId) };
  }

  getHealth(): WatchdogHealth {
    const workspace = this.store.listWorkspaces()[0];
    const state = workspace ? this.watchdog.getState(workspace.id) : null;
    return {
      lastTickAt: state?.lastTickAt ?? null,
      lastPatrolAt: state?.lastPatrolAt ?? null,
      stale:
        state?.lastTickAt != null &&
        this.clock.now() - Date.parse(state.lastTickAt) > this.tickIntervalMs * 2,
      enabled: state?.enabled ?? false,
      deadman: state?.deadmanAt != null,
    };
  }

  rebuild(): ReturnType<WatchdogStore["rebuild"]> {
    return this.watchdog.rebuild();
  }

  private fail<T>(code: "WATCHDOG_DISABLED" | "NOT_FOUND" | "CONFLICT" | "INVALID_INPUT" | "INTERNAL", message: string): WatchdogResult<T> {
    return { ok: false, error: { code, message } };
  }
}
