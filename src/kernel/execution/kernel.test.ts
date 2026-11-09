import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Agent, Task } from "../../shared/types.js";
import { Store } from "../store.js";
import { AppService } from "../service.js";
import { FakeClock } from "./clock.js";
import { ExecutionKernel, type RunExecutionContext, type RunExecutor } from "./kernel.js";
import {
  assertTransition,
  blockedReasonFor,
  canTransition,
  dependenciesSatisfied,
  transitionMatrix,
} from "./stateMachine.js";
import { projectionDigest, rebuildProjections } from "./projections.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await flush();
  }
}

interface Setup {
  store: Store;
  workspaceId: string;
  agent: Agent;
  clock: FakeClock;
  kernel: ExecutionKernel;
}

function setupKernel(
  executor: RunExecutor,
  options: {
    limits?: { maxGlobal?: number; maxWorkspace?: number; maxPerAgent?: number };
    maxAttempts?: number;
    backoffBaseMs?: number;
    dataDir?: string;
  } = {},
): Setup {
  const store = new Store(":memory:");
  cleanups.push(() => store.close());
  const workspace = store.createWorkspace("test", ".");
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
  const kernel = new ExecutionKernel({
    store,
    executor,
    clock,
    autoTick: false,
    maxAttempts: options.maxAttempts ?? 3,
    backoffBaseMs: options.backoffBaseMs ?? 1_000,
    maxBackoffMs: 60_000,
    limits: options.limits,
    dataDir: options.dataDir,
  });
  cleanups.push(() => kernel.dispose());
  return { store, workspaceId: workspace.id, agent, clock, kernel };
}

function createTask(store: Store, workspaceId: string, title: string): Task {
  return store.createTask({
    workspaceId,
    title,
    description: "",
    acceptance: [],
  });
}

function taskStatus(store: Store, id: string): string {
  return store.getTask(id)?.status ?? "missing";
}

const instantExecutor: RunExecutor = async () => ({ summary: "done" });

describe("t68 state machine", () => {
  it("legal transitions follow the matrix; illegal transitions throw", () => {
    expect(canTransition("ready", "queued")).toBe(true);
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "done")).toBe(true);
    expect(canTransition("running", "queued")).toBe(true);
    expect(canTransition("failed", "queued")).toBe(true);
    expect(canTransition("blocked", "ready")).toBe(true);
    expect(canTransition("done", "running")).toBe(false);
    expect(canTransition("cancelled", "queued")).toBe(false);
    expect(() => assertTransition("done", "running")).toThrow(/INVALID|invalid/);
    expect(() => assertTransition("cancelled", "ready")).toThrow();
    const matrix = transitionMatrix();
    expect(matrix.running).toEqual(expect.arrayContaining(["done", "review", "failed", "queued", "cancelled"]));
    expect(matrix.done).toEqual([]);
  });

  it("dependency failures propagate as blocked reasons, not auto-failure", () => {
    const tasks = new Map<string, Pick<Task, "status">>([
      ["a", { status: "failed" }],
      ["b", { status: "cancelled" }],
      ["c", { status: "running" }],
      ["d", { status: "done" }],
    ]);
    const lookup = (id: string) => tasks.get(id) ?? null;
    expect(blockedReasonFor({ dependsOn: ["a"] }, lookup)).toBe("dependency_failed");
    expect(blockedReasonFor({ dependsOn: ["b"] }, lookup)).toBe("dependency_cancelled");
    expect(blockedReasonFor({ dependsOn: ["c"] }, lookup)).toBe("waiting_dependencies");
    expect(blockedReasonFor({ dependsOn: ["d"] }, lookup)).toBeNull();
    expect(dependenciesSatisfied({ dependsOn: ["d"] }, lookup)).toBe(true);
    expect(dependenciesSatisfied({ dependsOn: ["a", "d"] }, lookup)).toBe(false);
  });
});

describe("t68 event log", () => {
  it("idempotent append: same key writes once and returns the original event", () => {
    const store = new Store(":memory:");
    cleanups.push(() => store.close());
    const first = store.appendEventIdempotent({
      aggregateType: "task",
      aggregateId: "t1",
      type: "task.created",
      actor: "user",
      payload: {},
      idempotencyKey: "cmd:1",
    });
    const second = store.appendEventIdempotent({
      aggregateType: "task",
      aggregateId: "t1",
      type: "task.created",
      actor: "user",
      payload: {},
      idempotencyKey: "cmd:1",
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.event.seq).toBe(first.event.seq);
    expect(store.listEvents({ aggregateId: "t1" })).toHaveLength(1);
    expect(store.listEvents({ aggregateId: "t1" })[0].schemaVersion).toBe(2);
  });

  it("seq is monotonic and events are ordered by seq", () => {
    const store = new Store(":memory:");
    cleanups.push(() => store.close());
    const first = store.appendEvent({
      aggregateType: "task",
      aggregateId: "t1",
      type: "task.created",
      actor: "user",
      payload: {},
    });
    const second = store.appendEvent({
      aggregateType: "task",
      aggregateId: "t1",
      type: "task.updated",
      actor: "user",
      payload: {},
    });
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(store.listEvents({ aggregateId: "t1" }).map((event) => event.seq)).toEqual([
      first.seq,
      second.seq,
    ]);
  });

  it("transaction rollback writes neither event nor projection", () => {
    const store = new Store(":memory:");
    cleanups.push(() => store.close());
    const workspace = store.createWorkspace("w", ".");
    const before = store.listTasks(workspace.id).length;
    expect(() =>
      store.withTransaction(() => {
        store.createTask({
          workspaceId: workspace.id,
          title: "rolled back",
          description: "",
          acceptance: [],
        });
        throw new Error("boom");
      }),
    ).toThrow(/boom/);
    expect(store.listTasks(workspace.id)).toHaveLength(before);
    expect(
      store.listEvents().some((event) => (event.payload as { task?: { title?: string } }).task?.title === "rolled back"),
    ).toBe(false);
  });
});

describe("t68 scheduler", () => {
  it("respects global concurrency and drains the queue as runs finish", async () => {
    const gates: Array<() => void> = [];
    const started: string[] = [];
    const executor: RunExecutor = (ctx) => {
      started.push(ctx.task.title);
      return new Promise((resolve) => {
        gates.push(() => resolve({ summary: "done" }));
      });
    };
    const { store, workspaceId, kernel } = setupKernel(executor, {
      limits: { maxGlobal: 1, maxWorkspace: 1, maxPerAgent: 1 },
    });
    const first = createTask(store, workspaceId, "one");
    const second = createTask(store, workspaceId, "two");
    kernel.startTask(first.id);
    kernel.startTask(second.id);
    await waitFor(() => started.length === 1);
    expect(started).toEqual(["one"]);
    expect(taskStatus(store, first.id)).toBe("running");
    expect(taskStatus(store, second.id)).toBe("queued");

    gates.shift()?.();
    await waitFor(() => started.length === 2);
    expect(started).toEqual(["one", "two"]);
    gates.shift()?.();
    await waitFor(() => taskStatus(store, second.id) === "done");
    expect(taskStatus(store, first.id)).toBe("done");
  });

  it("enforces per-agent concurrency even when global capacity is free", async () => {
    const gates: Array<() => void> = [];
    const started: string[] = [];
    const executor: RunExecutor = (ctx) => {
      started.push(ctx.task.id);
      return new Promise((resolve) => gates.push(() => resolve({ summary: "ok" })));
    };
    const { store, workspaceId, agent, kernel } = setupKernel(executor, {
      limits: { maxGlobal: 4, maxWorkspace: 4, maxPerAgent: 1 },
    });
    const first = createTask(store, workspaceId, "a");
    const second = createTask(store, workspaceId, "b");
    store.updateTask(first.id, { ownerId: agent.id });
    store.updateTask(second.id, { ownerId: agent.id });
    kernel.startTask(first.id);
    kernel.startTask(second.id);
    await waitFor(() => started.length === 1);
    expect(started).toHaveLength(1);
    gates.shift()?.();
    await waitFor(() => started.length === 2);
    gates.shift()?.();
    await waitFor(() => taskStatus(store, second.id) === "done");
  });

  it("pause blocks new runs, resume continues; queued tasks survive pause", async () => {
    const { store, workspaceId, kernel } = setupKernel(instantExecutor, {
      limits: { maxGlobal: 1, maxWorkspace: 1, maxPerAgent: 1 },
    });
    kernel.pauseScheduler(workspaceId);
    const task = createTask(store, workspaceId, "paused");
    kernel.startTask(task.id);
    await flush();
    expect(taskStatus(store, task.id)).toBe("queued");
    expect(kernel.getScheduler(workspaceId).paused).toBe(true);
    expect(kernel.getScheduler(workspaceId).queue.map((item) => item.taskId)).toEqual([task.id]);

    kernel.resumeScheduler(workspaceId);
    await waitFor(() => taskStatus(store, task.id) === "done");
  });

  it("cancels a running task: aborts executor, marks run/task cancelled", async () => {
    let aborted = false;
    const executor: RunExecutor = (ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    const { store, workspaceId, kernel } = setupKernel(executor);
    const task = createTask(store, workspaceId, "cancel-me");
    kernel.startTask(task.id);
    await waitFor(() => taskStatus(store, task.id) === "running");
    kernel.cancelTask(task.id);
    expect(aborted).toBe(true);
    expect(taskStatus(store, task.id)).toBe("cancelled");
    const run = kernel.listRuns(task.id)[0];
    expect(run.status).toBe("cancelled");
  });

  it("starts higher-priority queued tasks first and is idempotent on double start", async () => {
    const started: string[] = [];
    const gates: Array<() => void> = [];
    const executor: RunExecutor = (ctx) => {
      started.push(ctx.task.id);
      return new Promise((resolve) => gates.push(() => resolve({ summary: "ok" })));
    };
    const { store, workspaceId, kernel } = setupKernel(executor, {
      limits: { maxGlobal: 1, maxWorkspace: 1, maxPerAgent: 1 },
    });
    const low = createTask(store, workspaceId, "low");
    const high = createTask(store, workspaceId, "high");
    store.db.prepare("UPDATE tasks SET priority = ? WHERE id = ?").run(10, low.id);
    store.db.prepare("UPDATE tasks SET priority = ? WHERE id = ?").run(90, high.id);
    // 暂停期间入队，避免 startTask 立即启动 low；恢复后按优先级取 high。
    kernel.pauseScheduler(workspaceId);
    kernel.startTask(low.id);
    kernel.startTask(high.id);
    kernel.startTask(high.id); // 幂等：已 queued，不新增 Run
    kernel.resumeScheduler(workspaceId);
    await waitFor(() => started.length === 1);
    expect(started[0]).toBe(high.id);
    expect(kernel.listRuns(high.id)).toHaveLength(1);
    gates.shift()?.();
    await waitFor(() => started.length === 2);
    gates.shift()?.();
    await waitFor(() => taskStatus(store, low.id) === "done");
  });
});

describe("t68 run lifecycle, retry and leases", () => {
  it("first failure is retried as a new Run after backoff, and the task completes", async () => {
    let calls = 0;
    const executor: RunExecutor = async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("provider hiccup") as Error & { retryable?: boolean };
        error.retryable = true;
        throw error;
      }
      return { summary: "after retry", tokenIn: 3, tokenOut: 4 };
    };
    const { store, workspaceId, clock, kernel } = setupKernel(executor, {
      maxAttempts: 3,
      backoffBaseMs: 1_000,
    });
    const task = createTask(store, workspaceId, "retry");
    kernel.startTask(task.id);
    await waitFor(() => calls === 1 && taskStatus(store, task.id) === "queued");
    const firstRun = kernel.listRuns(task.id)[0];
    expect(firstRun.status).toBe("failed");
    expect(firstRun.attempt).toBe(1);
    expect(firstRun.retryable).toBe(true);
    const queued = store.getTask(task.id)!;
    expect(queued.nextRunAt).toBeTruthy();

    clock.advance(2_000);
    kernel.tick();
    await waitFor(() => taskStatus(store, task.id) === "done");
    const runs = kernel.listRuns(task.id);
    expect(runs).toHaveLength(2);
    expect(runs[1].attempt).toBe(2);
    expect(runs[1].retryOfRunId).toBe(runs[0].id);
    expect(store.getTask(task.id)?.summary).toBe("after retry");
  });

  it("retry exhaustion marks failed(retry_exhausted) and manual retry requeues", async () => {
    let calls = 0;
    const executor: RunExecutor = async () => {
      calls += 1;
      const error = new Error("always down") as Error & { retryable?: boolean };
      error.retryable = true;
      throw error;
    };
    const { store, workspaceId, clock, kernel } = setupKernel(executor, {
      maxAttempts: 2,
      backoffBaseMs: 100,
    });
    const task = createTask(store, workspaceId, "exhaust");
    kernel.startTask(task.id);
    await waitFor(() => calls === 1 && taskStatus(store, task.id) === "queued");
    clock.advance(1_000);
    kernel.tick();
    await waitFor(() => taskStatus(store, task.id) === "failed");
    expect(store.getTask(task.id)?.failureKind).toBe("retry_exhausted");
    expect(kernel.listRuns(task.id)).toHaveLength(2);
    // 暂停调度器后手动重试：任务回到 queued，恢复后才再次执行。
    kernel.pauseScheduler(workspaceId);
    kernel.retryTask(task.id);
    expect(taskStatus(store, task.id)).toBe("queued");
    kernel.resumeScheduler(workspaceId);
    await waitFor(() => taskStatus(store, task.id) === "failed");
    expect(kernel.listRuns(task.id).length).toBeGreaterThanOrEqual(3);
  });

  it("heartbeat extends lease and checkpoint is persisted as an event", async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "deer-kernel-cp-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    let captured: RunExecutionContext | null = null;
    const executor: RunExecutor = (ctx) => {
      captured = ctx;
      return new Promise((resolve) => setTimeout(() => resolve({ summary: "ok", steps: 2 }), 5));
    };
    const { store, workspaceId, kernel } = setupKernel(executor, { dataDir });
    const task = createTask(store, workspaceId, "lease");
    kernel.startTask(task.id);
    await waitFor(() => Boolean(captured));
    const ctx = captured!;
    ctx.heartbeat({ steps: 1, tokenIn: 1, tokenOut: 2 });
    ctx.checkpoint({ step: 1 });
    const run = kernel.listRuns(task.id)[0];
    expect(run.heartbeatAt).toBeTruthy();
    expect(run.leaseExpiresAt).toBeTruthy();
    expect(run.checkpointStep).toBe(1);
    expect(run.checkpointRef).toContain("checkpoints/");
    const eventTypes = store.listEvents({ aggregateId: run.id }).map((event) => event.type);
    expect(eventTypes).toContain("run.checkpoint");
    await waitFor(() => taskStatus(store, task.id) === "done");
  });
});

describe("t68 dependency propagation", () => {
  it("blocked child follows parent failure, then becomes ready when parent retries successfully", async () => {
    let failParent = true;
    const executor: RunExecutor = async (ctx) => {
      if (ctx.task.title === "parent" && failParent) {
        const error = new Error("parent failed") as Error & { retryable?: boolean };
        error.retryable = false;
        throw error;
      }
      return { summary: "ok" };
    };
    const { store, workspaceId, kernel } = setupKernel(executor, { maxAttempts: 1 });
    const parent = createTask(store, workspaceId, "parent");
    const child = store.createTask({
      workspaceId,
      title: "child",
      description: "",
      acceptance: [],
      dependsOn: [parent.id],
    });
    expect(taskStatus(store, child.id)).toBe("blocked");
    expect(store.getTask(child.id)?.blockedReason).toBe("waiting_dependencies");
    expect(() => kernel.startTask(child.id)).toThrow(/dependency is not done/);

    kernel.startTask(parent.id);
    await waitFor(() => taskStatus(store, parent.id) === "failed");
    expect(store.getTask(child.id)?.blockedReason).toBe("dependency_failed");
    expect(taskStatus(store, child.id)).toBe("blocked");

    failParent = false;
    kernel.pauseScheduler(workspaceId);
    kernel.retryTask(parent.id);
    kernel.resumeScheduler(workspaceId);
    await waitFor(() => taskStatus(store, parent.id) === "done");
    expect(taskStatus(store, child.id)).toBe("ready");

    kernel.startTask(child.id);
    await waitFor(() => taskStatus(store, child.id) === "done");
  });

  it("cancelling a dependency blocks the downstream with dependency_cancelled", async () => {
    const { store, workspaceId, kernel } = setupKernel(instantExecutor);
    const parent = createTask(store, workspaceId, "cancel-parent");
    const child = store.createTask({
      workspaceId,
      title: "cancel-child",
      description: "",
      acceptance: [],
      dependsOn: [parent.id],
    });
    expect(taskStatus(store, child.id)).toBe("blocked");
    kernel.cancelTask(parent.id);
    expect(taskStatus(store, parent.id)).toBe("cancelled");
    expect(store.getTask(child.id)?.blockedReason).toBe("dependency_cancelled");
    expect(taskStatus(store, child.id)).toBe("blocked");
  });

  it("rejects invalid kernel transitions and duplicate starts", async () => {
    const gates: Array<() => void> = [];
    const executor: RunExecutor = () =>
      new Promise((resolve) => gates.push(() => resolve({ summary: "ok" })));
    const { store, workspaceId, kernel } = setupKernel(executor);
    const task = createTask(store, workspaceId, "transitions");
    kernel.startTask(task.id);
    await waitFor(() => taskStatus(store, task.id) === "running");
    expect(() => kernel.startTask(task.id)).toThrow(/already running/);
    gates.shift()?.();
    await waitFor(() => taskStatus(store, task.id) === "done");
    expect(() => kernel.startTask(task.id)).toThrow(/already done/);
    expect(() => kernel.cancelTask(task.id)).toThrow(/done/);
  });
});

describe("t68 recovery and replay consistency", () => {
  it("recovers an expired lease into a new attempt and cancels orphan runs", async () => {
    const { store, workspaceId, clock, kernel } = setupKernel(instantExecutor, {
      maxAttempts: 3,
    });
    const task = createTask(store, workspaceId, "recover");
    // 模拟崩溃残留：Task running + Run running（旧 owner / 已过期）。
    const nowIso = new Date(clock.now() - 120_000).toISOString();
    store.db
      .prepare("UPDATE tasks SET status = 'running', started_at = ?, attempt_count = 1 WHERE id = ?")
      .run(nowIso, task.id);
    store.db
      .prepare(
        `INSERT INTO runs (id, task_id, agent_id, status, error, started_at, ended_at, token_in, token_out, attempt, heartbeat_at, lease_owner, lease_expires_at)
         VALUES ('run_stale', ?, 'agent_x', 'running', NULL, ?, NULL, 0, 0, 1, ?, 'dead-boot', ?)`,
      )
      .run(task.id, nowIso, nowIso, nowIso);
    // 孤儿 Run：task 不存在。
    store.db
      .prepare(
        `INSERT INTO runs (id, task_id, agent_id, status, error, started_at, ended_at, token_in, token_out, attempt, lease_owner, lease_expires_at)
         VALUES ('run_orphan', 'missing_task', 'agent_x', 'running', NULL, ?, NULL, 0, 0, 1, 'dead-boot', ?)`,
      )
      .run(nowIso, nowIso);

    kernel.recover();
    const recoveredRun = store.getRun("run_stale");
    expect(recoveredRun?.status).toBe("failed");
    expect(recoveredRun?.errorCode).toBe("LEASE_EXPIRED");
    expect(taskStatus(store, task.id)).toBe("queued");
    expect(store.getRun("run_orphan")?.status).toBe("cancelled");

    kernel.tick();
    await waitFor(() => taskStatus(store, task.id) === "done");
    expect(kernel.listRuns(task.id)).toHaveLength(2);
  });

  it("rebuildProjections reproduces the live task/run digest", async () => {
    const { store, workspaceId, kernel } = setupKernel(instantExecutor);
    const first = createTask(store, workspaceId, "rebuild-a");
    const second = createTask(store, workspaceId, "rebuild-b");
    kernel.startTask(first.id);
    kernel.startTask(second.id);
    await waitFor(() => taskStatus(store, second.id) === "done");
    const live = projectionDigest(store);
    const rebuilt = rebuildProjections(store);
    expect(rebuilt).toEqual(live);
    expect(store.getTask(first.id)?.status).toBe("done");
    expect(store.listRunsForTask(first.id).length).toBeGreaterThan(0);
  });
});

describe("t68 migration from a v1 database", () => {
  it("adds v2 columns, keeps existing tasks readable, seeds legacy snapshots", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deer-kernel-migrate-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const dbPath = path.join(root, "deer.db");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', acceptance TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'ready', owner_id TEXT,
        depends_on TEXT NOT NULL DEFAULT '[]', branch TEXT, worktree TEXT, summary TEXT,
        created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        status TEXT NOT NULL, error TEXT, started_at TEXT NOT NULL, ended_at TEXT,
        token_in INTEGER NOT NULL DEFAULT 0, token_out INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, type TEXT NOT NULL,
        actor TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      );
    `);
    legacy
      .prepare(
        "INSERT INTO tasks (id, workspace_id, title, description, acceptance, status, owner_id, depends_on, created_at) VALUES ('task_legacy', 'ws_legacy', 'Legacy task', '', '[]', 'running', NULL, '[]', ?)",
      )
      .run("2026-01-01T00:00:00.000Z");
    legacy
      .prepare(
        "INSERT INTO runs (id, task_id, agent_id, status, started_at) VALUES ('run_legacy', 'task_legacy', 'agent_legacy', 'running', ?)",
      )
      .run("2026-01-01T00:00:00.000Z");
    legacy
      .prepare(
        "INSERT INTO events (id, aggregate_type, aggregate_id, type, actor, payload, created_at) VALUES ('evt_old', 'task', 'task_legacy', 'task.running', 'system', '{}', ?)",
      )
      .run("2026-01-01T00:00:00.000Z");
    legacy.close();

    const store = new Store(dbPath);
    cleanups.push(() => store.close());
    const version = (store.db.prepare("PRAGMA user_version").get() as { user_version?: number })
      .user_version;
    expect(Number(version)).toBe(2);
    expect(store.getTask("task_legacy")?.title).toBe("Legacy task");
    expect(store.getRun("run_legacy")?.attempt).toBe(1);
    const baseline = store
      .listEvents({ aggregateId: "task_legacy" })
      .filter((event) => event.type === "kernel.legacy_snapshot");
    expect(baseline).toHaveLength(1);
    expect(store.listEvents({ aggregateId: "task_legacy" }).some((event) => event.id === "evt_old")).toBe(true);
    // 迁移前备份存在（设计 §10.2）。
    expect(existsSync(`${dbPath}.v1-backup`)).toBe(true);
  });

  it("migrated workspace opens through AppService and returns the legacy task", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deer-kernel-open-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const dataDir = path.join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "deer.db");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
        overview TEXT, overview_enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', acceptance TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'ready', owner_id TEXT,
        depends_on TEXT NOT NULL DEFAULT '[]', branch TEXT, worktree TEXT, summary TEXT,
        created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        status TEXT NOT NULL, error TEXT, started_at TEXT NOT NULL, ended_at TEXT,
        token_in INTEGER NOT NULL DEFAULT 0, token_out INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, type TEXT NOT NULL,
        actor TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      );
    `);
    legacy
      .prepare(
        "INSERT INTO workspaces (id, name, path, created_at) VALUES ('ws_open', 'legacy', ?, ?)",
      )
      .run(path.join(root, "workspace"), "2026-01-01T00:00:00.000Z");
    legacy
      .prepare(
        "INSERT INTO tasks (id, workspace_id, title, description, acceptance, status, created_at) VALUES ('task_open', 'ws_open', 'Open legacy task', '', '[]', 'ready', ?)",
      )
      .run("2026-01-01T00:00:00.000Z");
    legacy.close();

    const service = new AppService(dataDir);
    cleanups.push(() => service.close());
    const snapshot = service.getSnapshot("ws_open");
    expect(snapshot.workspace.id).toBe("ws_open");
    expect(snapshot.tasks.some((task) => task.id === "task_open")).toBe(true);
    expect(service.getScheduler("ws_open").counts.ready).toBe(1);
  });
});
