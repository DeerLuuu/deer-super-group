import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../kernel/store.js";
import { FakeClock } from "../kernel/execution/clock.js";
import { ExecutionKernel, type RunExecutor } from "../kernel/execution/kernel.js";
import type { Agent, Run, Task } from "../shared/types.js";
import type { RunHandoff } from "../shared/watchdog.js";
import RunHistory from "../RunHistory.js";
import { WatchdogService } from "./service.js";
import { DEFAULT_WATCHDOG_THRESHOLDS, createTaskSignalState, detectSignals, recordActivity } from "./signals.js";
import { BudgetBar, WatchdogPanel } from "./WatchdogPanel.js";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultModelProfile, defaultProviderProfile } from "../shared/models.js";
import { PANEL_DEFS, selectVariant } from "../shell/dock/panelRegistry.js";
import { execFileSync } from "node:child_process";

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

function setup(
  executor: RunExecutor,
  options: { dataDir?: string; workspacePath?: string } = {},
) {
  const store = new Store(":memory:");
  cleanups.push(() => store.close());
  const workspace = store.createWorkspace("watchdog-test", options.workspacePath ?? ".");
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

  it("redacts tracked .env/.ssh changes from handoff stat, patch and summary", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "watchdog-sensitive-"));
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "watchdog-sensitive-data-"));
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    execFileSync("git", ["init"], { cwd: repo, windowsHide: true });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo, windowsHide: true });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo, windowsHide: true });
    writeFileSync(path.join(repo, ".env"), "SECRET=old\n", "utf8");
    writeFileSync(path.join(repo, "src-app.ts"), "export const x = 1;\n", "utf8");
    mkdirSync(path.join(repo, ".ssh"), { recursive: true });
    writeFileSync(path.join(repo, ".ssh", "id_rsa"), "OLD_PRIVATE_KEY\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, windowsHide: true });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, windowsHide: true });
    writeFileSync(path.join(repo, ".env"), "SECRET=TOP_SECRET\n", "utf8");
    writeFileSync(path.join(repo, ".ssh", "id_rsa"), "NEW_PRIVATE_KEY\n", "utf8");
    writeFileSync(path.join(repo, "src-app.ts"), "export const x = 2;\n", "utf8");

    let captured: Parameters<RunExecutor>[0] | null = null;
    const executor: RunExecutor = (ctx) => {
      captured = ctx;
      return new Promise(() => {});
    };
    const { store, workspace, kernel, watchdog } = setup(executor, { workspacePath: repo, dataDir });
    const task = createTask(store, workspace.id, "sensitive-handoff");
    kernel.startTask(task.id);
    await waitFor(() => kernel.listRuns(task.id)[0]?.status === "running");
    store.appendEvent({
      aggregateType: "task",
      aggregateId: task.id,
      type: "assistant.message",
      actor: "agent",
      payload: { text: "read .env and .ssh/id_rsa, secret TOP_SECRET" },
      schemaVersion: 2,
      idempotencyKey: null,
    });
    const run = kernel.listRuns(task.id)[0];
    store.saveSummary({
      taskId: task.id,
      runId: run.id,
      goal: "finish handoff",
      changes: ["read .env and SECRET=TOP_SECRET"],
      files: [".env", ".ssh/id_rsa", "src-app.ts"],
      tests: [],
      decisions: [],
      risks: [],
      openQuestions: ["rotate .ssh/id_rsa before merge"],
    });
    const handoff = watchdog.handoff.build({ run, task, reason: "pause" });
    expect(handoff.files).not.toContain(".env");
    expect(handoff.files.some((file) => file.includes(".ssh"))).toBe(false);
    expect(handoff.diffStat).not.toContain(".env");
    expect(handoff.diffStat).not.toContain(".ssh");
    expect(handoff.summary).not.toContain("TOP_SECRET");
    expect(handoff.summary).not.toContain(".env");
    expect(handoff.summary).not.toContain(".ssh");
    expect(handoff.nextStep).not.toContain(".ssh");
    expect(handoff.nextStep).toContain("[REDACTED]");
    expect(handoff.diffRef).toBeTruthy();
    const patch = readFileSync(path.join(dataDir, handoff.diffRef!), "utf8");
    expect(patch).not.toContain("TOP_SECRET");
    expect(patch).not.toContain("NEW_PRIVATE_KEY");
    expect(patch).not.toContain(".env");
    expect(patch).not.toContain(".ssh");
    expect(patch).toContain("src-app.ts");
    expect(captured).not.toBeNull();
  });

  it("releases only the requested hold and clears nextRunAt only after the last hold", async () => {
    const { store, workspace, kernel, watchdog } = setup(async () => ({ summary: "ok" }));
    const task = createTask(store, workspace.id, "double-hold");
    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    kernel.holdTask(task.id, until);
    watchdog.watchdog.addHold({ workspaceId: workspace.id, taskId: task.id, reason: "budget", scope: "task" });
    watchdog.watchdog.addHold({ workspaceId: workspace.id, taskId: task.id, reason: "watchdog", scope: "task" });
    expect(watchdog.releaseTaskHold(workspace.id, task.id).ok).toBe(false);
    expect(store.getTask(task.id)?.nextRunAt).toBe(until);
    expect(watchdog.releaseTaskHold(workspace.id, task.id, "budget").ok).toBe(true);
    expect(watchdog.watchdog.listHolds(workspace.id, task.id).map((hold) => hold.reason)).toEqual(["watchdog"]);
    expect(store.getTask(task.id)?.nextRunAt).toBe(until);
    expect(watchdog.releaseTaskHold(workspace.id, task.id, "watchdog").ok).toBe(true);
    expect(watchdog.watchdog.listHolds(workspace.id, task.id)).toHaveLength(0);
    expect(store.getTask(task.id)?.nextRunAt).toBeNull();
  });

  it("detects a deadman gap with the fake clock", () => {
    const { workspace, clock, watchdog } = setup(async () => ({ summary: "ok" }));
    watchdog.tick(clock.now());
    clock.advance(3 * 60_000);
    watchdog.tick(clock.now());
    const snapshot = watchdog.getSnapshot(workspace.id);
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.alerts.some((alert) => alert.kind === "deadman")).toBe(true);
      expect(snapshot.value.health.deadman).toBe(true);
    }
  });

  it("repairs a dropped watchdog table without touching kernel tables", async () => {
    const { store, workspace, watchdog } = setup(async () => ({ summary: "ok" }));
    const task = createTask(store, workspace.id, "schema-repair");
    watchdog.watchdog.addHold({
      workspaceId: workspace.id,
      taskId: task.id,
      reason: "watchdog",
      scope: "task",
    });
    store.db.exec("DROP TABLE watchdog_holds");
    const repaired = watchdog.rebuild();
    expect(repaired.repaired).toBe(true);
    expect(repaired.missing).toContain("watchdog_holds");
    const table = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='watchdog_holds'")
      .get();
    expect(table).toBeTruthy();
    expect(watchdog.rebuild().repaired).toBe(false);
    const snapshot = watchdog.getSnapshot(workspace.id);
    expect(snapshot.ok).toBe(true);
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

  it("falls back to the next model on provider 429 and cools the original provider", async () => {
    let calls = 0;
    const seenModels: Array<string | null> = [];
    const executor: RunExecutor = async (ctx) => {
      calls += 1;
      seenModels.push(ctx.run.modelProfileId ?? null);
      if (calls === 1) {
        const error = new Error("rate limited") as Error & { code?: string; retryable?: boolean };
        error.code = "PROVIDER_RATE_LIMIT";
        error.retryable = true;
        throw error;
      }
      return { summary: "fallback-done" };
    };
    const { store, workspace, agent, clock, kernel, watchdog } = setup(executor);
    const provider = defaultProviderProfile(
      { baseUrl: "https://example.test/v1", baseUrlEnv: "", apiKey: "test", apiKeyEnv: "" },
      "p1",
      "Provider 1",
    );
    const m1 = defaultModelProfile("m1", "p1");
    const m2 = defaultModelProfile("m2", "p1");
    store.saveLlmSettings({
      ...store.getLlmSettings(),
      providers: [provider],
      models: [m1, m2],
      model: m1.id,
      mock: true,
    });
    const chain = watchdog.setFallbackChain({
      workspaceId: workspace.id,
      agentId: agent.id,
      models: [m2.id],
    });
    expect(chain.ok).toBe(true);

    const task = createTask(store, workspace.id, "quota-fallback");
    kernel.startTask(task.id);
    await waitFor(() => store.getTask(task.id)?.status === "done");
    expect(calls).toBe(2);
    expect(seenModels[1]).toBe(m2.id);
    expect(watchdog.watchdog.isCooling("p1", "m1", new Date(clock.now()).toISOString())).toBe(true);
    expect(watchdog.watchdog.listHandoffs(workspace.id).length).toBeGreaterThanOrEqual(1);
    expect(watchdog.watchdog.listInterventions(workspace.id).some((item) => item.level === "fallback")).toBe(true);
  });

  it("escalates after two real 429s and writes provider-wide '*' cooldown", async () => {
    let calls = 0;
    const executor: RunExecutor = async () => {
      calls += 1;
      const error = new Error("rate limited") as Error & { code?: string; retryable?: boolean };
      error.code = "PROVIDER_RATE_LIMIT";
      error.retryable = true;
      throw error;
    };
    const { store, workspace, agent, clock, kernel, watchdog } = setup(executor);
    const provider = defaultProviderProfile(
      { baseUrl: "https://example.test/v1", baseUrlEnv: "", apiKey: "test", apiKeyEnv: "" },
      "p1",
      "Provider 1",
    );
    const m1 = defaultModelProfile("m1", "p1");
    const m2 = defaultModelProfile("m2", "p1");
    store.saveLlmSettings({
      ...store.getLlmSettings(),
      providers: [provider],
      models: [m1, m2],
      model: m1.id,
      mock: true,
    });
    expect(
      watchdog.setFallbackChain({ workspaceId: workspace.id, agentId: agent.id, models: [m2.id] }).ok,
    ).toBe(true);
    const task = createTask(store, workspace.id, "two-provider-failures");
    kernel.startTask(task.id);
    await waitFor(() => calls >= 2, 5_000);
    await waitFor(
      () => watchdog.watchdog.isCooling("p1", "*", new Date(clock.now()).toISOString()),
      3_000,
    );
    await waitFor(
      () =>
        watchdog.watchdog
          .listInterventions(workspace.id)
          .some((item) => item.level === "human"),
      3_000,
    );
    expect(calls).toBe(2);
    expect(store.getTask(task.id)?.status).not.toBe("done");
    expect(kernel.getScheduler(workspace.id).paused).toBe(true);
    expect(
      watchdog.watchdog
        .listHolds(workspace.id, task.id)
        .some((hold) => hold.reason === "escalation"),
    ).toBe(true);
    const snapshot = watchdog.getSnapshot(workspace.id);
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(
        snapshot.value.alerts.some(
          (alert) => alert.kind === "provider_quota" && alert.severity === "critical",
        ),
      ).toBe(true);
    }
    // 暂停后不得再自动启动第三次同 provider Run。
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls).toBe(2);
    const blockedTask = createTask(store, workspace.id, "after-provider-cooling");
    const allowed = watchdog.beforeStart({
      workspaceId: workspace.id,
      taskId: blockedTask.id,
      runId: "no-run",
      agentId: agent.id,
      attempt: 1,
    });
    expect(allowed).toBe(false);
    expect(
      watchdog.watchdog
        .listHolds(workspace.id, blockedTask.id)
        .some((hold) => hold.reason === "watchdog"),
    ).toBe(true);
  });

  it("blocks beforeStart for a cooling model/provider", async () => {
    const { store, workspace, clock, kernel, watchdog } = setup(async () => ({ summary: "ok" }));
    const provider = defaultProviderProfile(
      { baseUrl: "https://example.test/v1", baseUrlEnv: "", apiKey: "test", apiKeyEnv: "" },
      "p1",
      "Provider 1",
    );
    const m1 = defaultModelProfile("m1", "p1");
    store.saveLlmSettings({
      ...store.getLlmSettings(),
      providers: [provider],
      models: [m1],
      model: m1.id,
      mock: true,
    });
    watchdog.recordProviderQuota({ providerId: "p1", modelId: "m1" });
    watchdog.recordProviderQuota({ providerId: "p1", modelId: "m1" });
    expect(
      watchdog.watchdog.isCooling("p1", "*", new Date(clock.now()).toISOString()),
    ).toBe(true);
    const task = createTask(store, workspace.id, "cooling-blocked");
    kernel.startTask(task.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(kernel.listRuns(task.id)).toHaveLength(0);
    expect(store.getTask(task.id)?.status).toBe("queued");
    expect(
      watchdog.watchdog
        .listHolds(workspace.id, task.id)
        .some((hold) => hold.reason === "watchdog"),
    ).toBe(true);
  });

  it("escalates when the fallback chain is empty or all targets are cooling", async () => {
    const runCase = async (chainModels: string[] | null) => {
      let calls = 0;
      const executor: RunExecutor = async () => {
        calls += 1;
        const error = new Error("rate limited") as Error & { code?: string; retryable?: boolean };
        error.code = "PROVIDER_RATE_LIMIT";
        error.retryable = true;
        throw error;
      };
      const { store, workspace, agent, clock, kernel, watchdog } = setup(executor);
      const provider = defaultProviderProfile(
        { baseUrl: "https://example.test/v1", baseUrlEnv: "", apiKey: "test", apiKeyEnv: "" },
        "p1",
        "Provider 1",
      );
      const m1 = defaultModelProfile("m1", "p1");
      const m2 = defaultModelProfile("m2", "p1");
      store.saveLlmSettings({
        ...store.getLlmSettings(),
        providers: [provider],
        models: [m1, m2],
        model: m1.id,
        mock: true,
      });
      if (chainModels) {
        watchdog.setFallbackChain({
          workspaceId: workspace.id,
          agentId: agent.id,
          models: chainModels,
        });
        watchdog.watchdog.setCooldown({
          providerId: "p1",
          modelId: m2.modelId,
          until: new Date(clock.now() + 60_000).toISOString(),
          reason: "test-all-cooling",
        });
      }
      const task = createTask(store, workspace.id, "no-target-escalation");
      kernel.startTask(task.id);
      await waitFor(() => calls === 1, 3_000);
      await waitFor(
        () =>
          watchdog.watchdog
            .listInterventions(workspace.id)
            .some((item) => item.level === "human"),
        3_000,
      );
      expect(calls).toBe(1);
      expect(store.getTask(task.id)?.status).not.toBe("done");
      expect(kernel.getScheduler(workspace.id).paused).toBe(true);
      expect(
        watchdog.watchdog
          .listHolds(workspace.id, task.id)
          .some((hold) => hold.reason === "escalation"),
      ).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(calls).toBe(1);
    };
    await runCase(null);
    await runCase(["m2"]);
  });

  it("resets provider failure window on a successful Run (429→success→429 no '*')", async () => {
    let calls = 0;
    const executor: RunExecutor = async () => {
      calls += 1;
      if (calls === 1 || calls === 3) {
        const error = new Error("rate limited") as Error & { code?: string; retryable?: boolean };
        error.code = "PROVIDER_RATE_LIMIT";
        error.retryable = true;
        throw error;
      }
      return { summary: "success" };
    };
    const { store, workspace, agent, clock, kernel, watchdog } = setup(executor);
    const provider = defaultProviderProfile(
      { baseUrl: "https://example.test/v1", baseUrlEnv: "", apiKey: "test", apiKeyEnv: "" },
      "p1",
      "Provider 1",
    );
    const m1 = defaultModelProfile("m1", "p1");
    const m2 = defaultModelProfile("m2", "p1");
    store.saveLlmSettings({
      ...store.getLlmSettings(),
      providers: [provider],
      models: [m1, m2],
      model: m1.id,
      mock: true,
    });
    expect(
      watchdog.setFallbackChain({ workspaceId: workspace.id, agentId: agent.id, models: [m2.id] }).ok,
    ).toBe(true);

    const first = createTask(store, workspace.id, "success-reset-1");
    kernel.startTask(first.id);
    await waitFor(() => store.getTask(first.id)?.status === "done");
    expect(watchdog.watchdog.isCooling("p1", m1.modelId, new Date(clock.now()).toISOString())).toBe(true);
    // 成功 Run 已清 provider window；手动让 model TTL 过期以验证下一次失败重新从 1 计数。
    watchdog.watchdog.setCooldown({
      providerId: "p1",
      modelId: m1.modelId,
      until: new Date(clock.now() - 1_000).toISOString(),
      reason: "expired",
    });
    expect(watchdog.watchdog.isCooling("p1", "*", new Date(clock.now()).toISOString())).toBe(false);

    const second = createTask(store, workspace.id, "success-reset-2");
    kernel.startTask(second.id);
    await waitFor(() => store.getTask(second.id)?.status === "done");
    expect(calls).toBe(4);
    expect(watchdog.watchdog.isCooling("p1", "*", new Date(clock.now()).toISOString())).toBe(false);
    expect(watchdog.watchdog.isCooling("p1", m1.modelId, new Date(clock.now()).toISOString())).toBe(true);
  });

  it("recordProviderQuota external path uses the same provider window", () => {
    const { clock, watchdog } = setup(async () => ({ summary: "ok" }));
    watchdog.recordProviderQuota({ providerId: "p1", modelId: "m1" });
    expect(watchdog.watchdog.isCooling("p1", "*", new Date(clock.now()).toISOString())).toBe(false);
    watchdog.recordProviderQuota({ providerId: "p1", modelId: "m1" });
    expect(watchdog.watchdog.isCooling("p1", "*", new Date(clock.now()).toISOString())).toBe(true);
  });

  it("escalates with handoff/hold when retryTaskWithModel throws", async () => {
    let calls = 0;
    const executor: RunExecutor = async () => {
      calls += 1;
      const error = new Error("rate limited") as Error & { code?: string; retryable?: boolean };
      error.code = "PROVIDER_RATE_LIMIT";
      error.retryable = true;
      throw error;
    };
    const { store, workspace, agent, kernel, watchdog } = setup(executor);
    const provider = defaultProviderProfile(
      { baseUrl: "https://example.test/v1", baseUrlEnv: "", apiKey: "test", apiKeyEnv: "" },
      "p1",
      "Provider 1",
    );
    const m1 = defaultModelProfile("m1", "p1");
    const m2 = defaultModelProfile("m2", "p1");
    store.saveLlmSettings({
      ...store.getLlmSettings(),
      providers: [provider],
      models: [m1, m2],
      model: m1.id,
      mock: true,
    });
    expect(
      watchdog.setFallbackChain({ workspaceId: workspace.id, agentId: agent.id, models: [m2.id] }).ok,
    ).toBe(true);
    const spy = vi.spyOn(kernel, "retryTaskWithModel").mockImplementation(() => {
      throw new Error("injected retry failure");
    });
    const task = createTask(store, workspace.id, "retry-throws");
    kernel.startTask(task.id);
    await waitFor(
      () =>
        watchdog.watchdog
          .listInterventions(workspace.id)
          .some((item) => item.level === "human"),
      3_000,
    );
    expect(calls).toBe(1);
    expect(store.getTask(task.id)?.status).not.toBe("done");
    expect(kernel.getScheduler(workspace.id).paused).toBe(true);
    expect(
      watchdog.watchdog
        .listHolds(workspace.id, task.id)
        .some((hold) => hold.reason === "escalation"),
    ).toBe(true);
    expect(watchdog.watchdog.listHandoffs(workspace.id).length).toBeGreaterThanOrEqual(1);
    const snapshot = watchdog.getSnapshot(workspace.id);
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(
        snapshot.value.alerts.some(
          (alert) => alert.kind === "provider_quota" && alert.severity === "critical",
        ),
      ).toBe(true);
    }
    spy.mockRestore();
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
  it("registers the watchdog dock panel closed by default with 900/760 narrow breakpoints", () => {
    expect(PANEL_DEFS.watchdog.key).toBe("watchdog");
    expect(PANEL_DEFS.watchdog.defaultClosed).toBe(true);
    expect(PANEL_DEFS.watchdog.title).toContain("看门狗");
    expect(selectVariant(1100)).toBe("wide");
    expect(selectVariant(900)).toBe("medium");
    expect(selectVariant(760)).toBe("narrow");
    expect(selectVariant(759)).toBe("single");
  });

  it("wires budget and ack/release callbacks and renders RunHistory handoff", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // @ts-expect-error react-test-renderer 19.x 不带类型声明（仅测试依赖）
    const TestRenderer = (await import("react-test-renderer")) as unknown as {
      act: (callback: () => Promise<void>) => Promise<void>;
      create: (element: unknown) => { root: { findAllByType: (type: string) => Array<{ props: Record<string, any> }> } };
    };
    let renderer: { root: { findAllByType: (type: string) => Array<{ props: Record<string, any> }> } } | null = null;
    let opened = 0;
    let acked = 0;
    let released = 0;
    const alert = {
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
    };
    const snapshot = {
      workspaceId: "ws",
      enabled: true,
      deadman: false,
      pausedBy: null,
      health: { lastTickAt: null, lastPatrolAt: null, stale: false, enabled: true, deadman: false },
      alerts: [alert],
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
      fallback: {
        workspaceId: "ws",
        agentId: null,
        models: [],
        maxSwitches: 2,
        onQuota: true,
        onErrors: true,
      },
      updatedAt: new Date().toISOString(),
    };
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(
        <WatchdogPanel
          snapshot={snapshot}
          costs={null}
          onAck={() => {
            acked += 1;
          }}
          onResolve={() => undefined}
          onRelease={() => {
            released += 1;
          }}
        />,
      );
    });
    let budgetRenderer: {
      root: { findAllByType: (type: string) => Array<{ props: Record<string, any> }> };
    } | null = null;
    await TestRenderer.act(async () => {
      budgetRenderer = TestRenderer.create(
        <BudgetBar
          spentUsd={2}
          limitUsd={10}
          ratio={0.2}
          softRatio={0.8}
          label="今日预算"
          onOpen={() => {
            opened += 1;
          }}
        />,
      );
    });
    const budgetButton = budgetRenderer!.root.findAllByType("button")[0];
    await TestRenderer.act(async () => budgetButton.props.onClick());
    expect(opened).toBe(1);
    const buttons = renderer!.root.findAllByType("button");
    for (const button of buttons) expect(button.props.type).toBe("button");
    const ack = buttons.find((node) => node.props.children === "确认告警");
    expect(ack).toBeTruthy();
    await TestRenderer.act(async () => ack!.props.onClick());
    expect(acked).toBe(1);
    const release = buttons.find((node) => node.props.children === "恢复任务");
    expect(release).toBeTruthy();
    await TestRenderer.act(async () => release!.props.onClick());
    expect(released).toBe(1);

    const task = {
      id: "t1",
      workspaceId: "ws",
      title: "handoff-task",
      description: "",
      acceptance: [],
      status: "failed",
      ownerId: null,
      dependsOn: [],
      branch: null,
      worktree: null,
      summary: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      attemptCount: 1,
      nextRunAt: null,
    } as Task;
    const run = {
      id: "r1",
      taskId: "t1",
      agentId: "a1",
      status: "failed",
      error: "failed",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      tokenIn: 10,
      tokenOut: 20,
      attempt: 1,
      errorCode: "RUN_FAILED",
      heartbeatAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    } as Run;
    const handoff = {
      id: "h1",
      workspaceId: "ws",
      taskId: "t1",
      runId: "r1",
      attempt: 1,
      reason: "pause",
      summary: "handoff summary",
      nextStep: "next",
      files: [],
      diffStat: "",
      diffRef: null,
      lastEventSeq: 0,
      fromModelProfileId: null,
      toModelProfileId: null,
      fromAgentId: "a1",
      toAgentId: null,
      createdAt: new Date().toISOString(),
      expiresAt: null,
    } as RunHandoff;
    const html = renderToStaticMarkup(
      <RunHistory
        task={task}
        runs={[run]}
        agents={[]}
        events={[]}
        loading={false}
        error={null}
        selectedRunId="r1"
        busy={null}
        onRetryLoad={() => undefined}
        onSelectRun={() => undefined}
        onCancelRun={() => undefined}
        onOpenRunPanel={() => undefined}
        onRetryTask={() => undefined}
        handoffs={{ r1: handoff }}
      />,
    );
    expect(html).toContain("交接摘要");
    expect(html).toContain("handoff summary");
  });

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
