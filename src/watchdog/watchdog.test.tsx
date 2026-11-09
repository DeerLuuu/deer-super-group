import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../kernel/store.js";
import { FakeClock } from "../kernel/execution/clock.js";
import { ExecutionKernel, type RunExecutor } from "../kernel/execution/kernel.js";
import type { Agent, Task } from "../shared/types.js";
import { WatchdogService } from "./service.js";
import { DEFAULT_WATCHDOG_THRESHOLDS, createTaskSignalState, detectSignals, recordActivity } from "./signals.js";
import { WatchdogPanel } from "./WatchdogPanel.js";
import { renderToStaticMarkup } from "react-dom/server";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await flush();
  }
}

function setup(executor: RunExecutor, options: { dataDir?: string } = {}) {
  const store = new Store(":memory:");
  cleanups.push(() => store.close());
  const workspace = store.createWorkspace("watchdog-test", ".");
  const agent = store.createAgent({
    workspaceId: workspace.id,
    name: "Builder",
    role: "engineer",
    systemPrompt: "",
    persona: "",
    agentsMd: "",
    model: null,
  });
  const clock = new FakeClock();
  let watchdog: WatchdogService | null = null;
  const kernel = new ExecutionKernel({
    store,
    executor,
    clock,
    autoTick: false,
    maxAttempts: 3,
    hooks: {
      beforeStart: (info) => watchdog?.beforeStart(info) ?? true,
      onRunStarted: (info) => watchdog?.onRunStarted(info),
      onRunActivity: (info) => watchdog?.onRunActivity(info),
      onRunHeartbeat: (info) => watchdog?.onRunHeartbeat(info),
      onRunFinished: (info) => watchdog?.onRunFinished(info),
    },
  });
  watchdog = new WatchdogService({
    store,
    kernel,
    clock,
    dataDir: options.dataDir,
    autoTick: false,
  });
  cleanups.push(() => {
    watchdog?.close();
    kernel.dispose();
  });
  return { store, workspace, agent, clock, kernel, watchdog: watchdog as WatchdogService };
}

function createTask(store: Store, workspaceId: string, title = "task"): Task {
  return store.createTask({ workspaceId, title, description: "", acceptance: [] });
}

function createAgent(store: Store, workspaceId: string, name: string): Agent {
  return store.createAgent({
    workspaceId,
    name,
    role: "engineer",
    systemPrompt: "",
    persona: "",
    agentsMd: "",
    model: null,
  });
}

describe("t144 signal detector", () => {
  it("detects stale, repeat, no-progress, error and token signals deterministically", () => {
    const now = 1_000_000;
    const state = createTaskSignalState({ taskId: "t1", runId: "r1", at: now - 20 * 60_000 });
    recordActivity(state, {
      kind: "tool.call",
      at: now - 2_000,
      toolSignature: "fs.read:a",
      file: "src/a.ts",
    });
    recordActivity(state, { kind: "tool.call", at: now - 1_500, toolSignature: "fs.read:a" });
    recordActivity(state, { kind: "tool.call", at: now - 1_000, toolSignature: "fs.read:a" });
    recordActivity(state, { kind: "tool.result", at: now - 900, ok: false });
    recordActivity(state, { kind: "tool.result", at: now - 800, ok: false });
    recordActivity(state, { kind: "tool.result", at: now - 700, ok: false });
    state.tokenSamples.push({ at: now - 1_000, tokenIn: 80_000, tokenOut: 80_000 });
    const hits = detectSignals(state, now, {
      ...DEFAULT_WATCHDOG_THRESHOLDS,
      taskCheckMs: 60_000,
      stallMs: 120_000,
    });
    expect(hits.map((hit) => hit.kind)).toEqual(
      expect.arrayContaining(["no_progress", "repeat_tool", "error_streak", "token_burn"]),
    );
  });

  it("does not treat waiting_human as no-activity pause", () => {
    const now = 10_000_000;
    const state = createTaskSignalState({ taskId: "t2", runId: "r2", at: now - 20 * 60_000 });
    state.waitingHuman = true;
    state.waitingHumanSince = now - 20 * 60_000;
    const hits = detectSignals(state, now, DEFAULT_WATCHDOG_THRESHOLDS);
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("task_timeout");
    expect(hits[0].severity).toBe("critical");
  });
});

describe("t144 watchdog service", () => {
  it("pauses a stale run, writes handoff before run.failed and survives kernel rebuild", async () => {
    let captured: Parameters<RunExecutor>[0] | null = null;
    const executor: RunExecutor = (ctx) => {
      captured = ctx;
      return new Promise(() => {});
    };
    const { store, workspace, clock, kernel, watchdog } = setup(executor);
    const task = createTask(store, workspace.id, "stale-task");
    kernel.startTask(task.id);
    await waitFor(() => kernel.listRuns(task.id)[0]?.status === "running");
    clock.advance(11 * 60_000);
    watchdog.tick(clock.now());

    const snapshot = watchdog.getSnapshot(workspace.id);
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.alerts.some((alert) => alert.kind === "heartbeat_stale")).toBe(true);
    expect(snapshot.value.holds.some((hold) => hold.reason === "watchdog")).toBe(true);
    expect(snapshot.value.interventions.some((item) => item.level === "pause")).toBe(true);
    expect(store.getTask(task.id)?.status).toBe("queued");
    const run = kernel.listRuns(task.id)[0];
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("WATCHDOG_PAUSED");
    const handoff = watchdog.getRunHandoff(workspace.id, run.id);
    expect(handoff.ok).toBe(true);
    if (handoff.ok) {
      expect(handoff.value?.runId).toBe(run.id);
      expect(handoff.value?.nextStep).toBeTruthy();
    }

    const events = store.listEventsForTask(task.id);
    const handoffSeq = events.find((event) => event.type === "run.handoff_created")?.seq;
    const failedSeq = events.find((event) => event.type === "run.failed")?.seq;
    expect(handoffSeq).toBeDefined();
    expect(failedSeq).toBeDefined();
    expect(Number(handoffSeq)).toBeLessThan(Number(failedSeq));

    const stateBefore = watchdog.watchdog.getTaskState(workspace.id, task.id);
    const holdsBefore = watchdog.getSnapshot(workspace.id);
    kernel.rebuildProjections();
    const after = watchdog.getSnapshot(workspace.id);
    expect(after.ok).toBe(true);
    if (!after.ok || !holdsBefore.ok) return;
    expect(after.value.holds.map((hold) => hold.taskId)).toEqual(
      holdsBefore.value.holds.map((hold) => hold.taskId),
    );
    expect(watchdog.watchdog.getTaskState(workspace.id, task.id).autoInterventions).toBe(
      stateBefore.autoInterventions,
    );
    expect(watchdog.getRunHandoff(workspace.id, run.id)).toMatchObject({ ok: true });
    expect(captured).not.toBeNull();
  });

  it("disables all automatic actions including nudge after two interventions", async () => {
    const executor: RunExecutor = () => new Promise(() => {});
    const { store, workspace, clock, kernel, watchdog } = setup(executor);
    const task = createTask(store, workspace.id, "max-auto");
    watchdog.watchdog.bumpAutoInterventions(workspace.id, task.id);
    watchdog.watchdog.bumpAutoInterventions(workspace.id, task.id);
    kernel.startTask(task.id);
    await waitFor(() => kernel.listRuns(task.id)[0]?.status === "running");
    clock.advance(11 * 60_000);
    watchdog.tick(clock.now());
    const interventions = watchdog.watchdog.listInterventions(workspace.id);
    expect(interventions.some((item) => item.level === "human")).toBe(true);
    expect(interventions.some((item) => item.level === "nudge")).toBe(false);
    const snapshot = watchdog.getSnapshot(workspace.id);
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.alerts.some((alert) => alert.severity === "critical")).toBe(true);
      expect(snapshot.value.holds.some((hold) => hold.reason === "escalation")).toBe(true);
    }
    expect(kernel.getScheduler(workspace.id).paused).toBe(true);
  });

  it("computes final ledger, writes Run.costUsd and blocks prestart over budget", async () => {
    const executor: RunExecutor = async () => ({
      summary: "done",
      tokenIn: 1_000_000,
      tokenOut: 1_000_000,
    });
    const { store, workspace, kernel, watchdog } = setup(executor);
    store.setSetting(
      "watchdog.modelPricing",
      JSON.stringify({ "": { inputPer1M: 1, outputPer1M: 2, version: "test" } }),
    );
    const task = createTask(store, workspace.id, "cost-task");
    kernel.startTask(task.id);
    await waitFor(() => store.getTask(task.id)?.status === "done");
    const costs = watchdog.getCosts(workspace.id);
    expect(costs.ok).toBe(true);
    if (costs.ok) {
      expect(costs.value.totals.runs).toBe(1);
      expect(costs.value.totals.usd).toBeCloseTo(3, 4);
    }
    const run = kernel.listRuns(task.id)[0];
    expect(store.getRun(run.id)?.costUsd).toBeCloseTo(3, 4);
    expect(watchdog.watchdog.listFinal({ workspaceId: workspace.id })[0]?.pricingKnown).toBe(true);

    // Workspace budget $1; a new task start must be denied and held.
    const budget = watchdog.setBudget({
      workspaceId: workspace.id,
      scope: "workspace",
      scopeId: workspace.id,
      limitUsd: 1,
      softRatio: 0.8,
      hardAction: "pause",
    });
    expect(budget.ok).toBe(true);
    const blocked = createTask(store, workspace.id, "over-budget");
    kernel.startTask(blocked.id);
    await flush();
    expect(store.getTask(blocked.id)?.status).toBe("queued");
    expect(watchdog.watchdog.listHolds(workspace.id, blocked.id).some((h) => h.reason === "budget")).toBe(true);
    expect(kernel.listRuns(blocked.id)).toHaveLength(0);
  });

  it("records a provisional ledger for an active run and clears it on final", async () => {
    let release: (() => void) | null = null;
    const executor: RunExecutor = (ctx) =>
      new Promise((resolve) => {
        ctx.heartbeat({ tokenIn: 100_000, tokenOut: 50_000, steps: 1 });
        release = () => resolve({ summary: "done", tokenIn: 100_000, tokenOut: 50_000 });
      });
    const { store, workspace, kernel, watchdog } = setup(executor);
    store.setSetting(
      "watchdog.modelPricing",
      JSON.stringify({ "": { inputPer1M: 1, outputPer1M: 2, version: "test" } }),
    );
    const task = createTask(store, workspace.id, "provisional");
    kernel.startTask(task.id);
    await waitFor(() => Boolean(release));
    const run = kernel.listRuns(task.id)[0];
    await waitFor(() => Boolean(watchdog.watchdog.getProvisional(run.id)));
    expect(watchdog.watchdog.getProvisional(run.id)?.kind).toBe("provisional");
    expect(watchdog.cost.spentMicro({ workspaceId: workspace.id })).toBeGreaterThanOrEqual(
      watchdog.watchdog.getProvisional(run.id)?.costMicroUsd ?? 0,
    );
    release!();
    await waitFor(() => store.getTask(task.id)?.status === "done");
    expect(watchdog.watchdog.getProvisional(run.id)).toBeNull();
    expect(watchdog.watchdog.listFinal({ workspaceId: workspace.id })[0]?.kind).toBe("final");
  });

  it("enforces provider/model cooldown both levels", () => {
    const { watchdog } = setup(async () => ({ summary: "ok" }));
    const future = new Date(Date.now() + 60_000).toISOString();
    watchdog.watchdog.setCooldown({ providerId: "p1", modelId: "m1", until: future, reason: "429" });
    expect(watchdog.watchdog.isCooling("p1", "m1", new Date().toISOString())).toBe(true);
    expect(watchdog.watchdog.isCooling("p1", "m2", new Date().toISOString())).toBe(false);
    watchdog.watchdog.setCooldown({ providerId: "p1", modelId: "*", until: future, reason: "provider" });
    expect(watchdog.watchdog.isCooling("p1", "m2", new Date().toISOString())).toBe(true);
  });

  it("switches member with handoff and starts a new Run", async () => {
    let calls = 0;
    const executor: RunExecutor = () => {
      calls += 1;
      if (calls === 1) return new Promise(() => {});
      return Promise.resolve({ summary: "member-switched" });
    };
    const { store, workspace, kernel, watchdog } = setup(executor);
    const task = createTask(store, workspace.id, "member-switch");
    const second = createAgent(store, workspace.id, "Second");
    kernel.startTask(task.id);
    await waitFor(() => kernel.listRuns(task.id)[0]?.status === "running");
    const result = watchdog.switchMember(task.id);
    expect(result.ok).toBe(true);
    kernel.tick();
    await waitFor(() => store.getTask(task.id)?.status === "done");
    const runs = kernel.listRuns(task.id);
    expect(runs).toHaveLength(2);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].errorCode).toBe("WATCHDOG_MEMBER_SWITCH");
    expect(runs[1].agentId).toBe(second.id);
    expect(watchdog.watchdog.listHandoffs(workspace.id).length).toBeGreaterThanOrEqual(1);
    expect(watchdog.watchdog.getTaskState(workspace.id, task.id).autoInterventions).toBe(1);
  });

  it("isolates watchdog API by workspace", async () => {
    const executor: RunExecutor = () => new Promise(() => {});
    const { store, workspace, clock, kernel, watchdog } = setup(executor);
    const other = store.createWorkspace("other", path.join(os.tmpdir(), `watchdog-other-${Date.now()}`));
    const task = createTask(store, workspace.id, "isolation");
    kernel.startTask(task.id);
    await waitFor(() => kernel.listRuns(task.id)[0]?.status === "running");
    clock.advance(11 * 60_000);
    watchdog.tick(clock.now());
    const alert = watchdog.watchdog.listAlerts(workspace.id)[0];
    expect(alert).toBeTruthy();
    expect(watchdog.ackAlert(other.id, alert.id).ok).toBe(false);
    const run = kernel.listRuns(task.id)[0];
    expect(watchdog.getRunHandoff(other.id, run.id).ok).toBe(false);
    expect(watchdog.releaseTaskHold(other.id, task.id).ok).toBe(false);
  });
});

describe("t144 watchdog UI", () => {
  it("renders budget progressbar, alerts and aria-live semantics", () => {
    const snapshot = {
      workspaceId: "ws",
      enabled: true,
      deadman: false,
      pausedBy: null,
      health: { lastTickAt: null, lastPatrolAt: null, stale: false, enabled: true, deadman: false },
      alerts: [
        {
          id: "a1",
          workspaceId: "ws",
          taskId: "t1",
          runId: "r1",
          kind: "heartbeat_stale" as const,
          severity: "critical" as const,
          status: "open" as const,
          title: "任务无活动",
          detail: {},
          dedupeKey: "k",
          createdAt: new Date().toISOString(),
          ackedAt: null,
          resolvedAt: null,
          actor: null,
        },
      ],
      interventions: [],
      holds: [],
      budgets: {
        task: { taskId: null, spentUsd: 2, limitUsd: 10, ratio: 0.2 },
        agentDay: { agentId: null, spentUsd: 2, limitUsd: 10, ratio: 0.2 },
        workspaceDay: { spentUsd: 2, limitUsd: 10, ratio: 0.2 },
        softRatio: 0.8,
        hardAction: "pause" as const,
        pricingKnown: true,
      },
      fallback: { workspaceId: "ws", agentId: null, models: [], maxSwitches: 2, onQuota: true, onErrors: true },
      updatedAt: new Date().toISOString(),
    };
    const html = renderToStaticMarkup(
      <WatchdogPanel snapshot={snapshot} costs={null} onAck={() => {}} onRelease={() => {}} />,
    );
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="20"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("确认告警");
    expect(html).toContain("恢复任务");
  });
});
