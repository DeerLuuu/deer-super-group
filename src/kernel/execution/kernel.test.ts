import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Agent, Task } from "../../shared/types.js";
import { Store } from "../store.js";
import { AppService } from "../service.js";
import { FakeClock } from "./clock.js";
import {
  DEFAULT_KERNEL_LIMITS,
  ExecutionKernel,
  type RunExecutionContext,
  type RunExecutor,
} from "./kernel.js";
import {
  assertTransition,
  blockedReasonFor,
  canTransition,
  dependenciesSatisfied,
  transitionMatrix,
} from "./stateMachine.js";
import { projectionDigest, rebuildProjections } from "./projections.js";
import {
  KERNEL_EVENT_SCHEMA_VERSION,
  KERNEL_EVENT_TYPES,
  EVENT_REGISTRY,
  assertKernelEventPayload,
} from "./eventRegistry.js";

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

/** t83：构造 v1 旧库（tasks/runs/events），可注入 WAL/迁移失败 trigger。 */
function createLegacyTaskDb(
  root: string,
  options: { wal?: boolean; trigger?: boolean } = {},
): string {
  const dbPath = path.join(root, "deer.db");
  const db = new DatabaseSync(dbPath);
  if (options.wal) db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
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
  db.prepare(
    "INSERT INTO tasks (id, workspace_id, title, description, acceptance, status, created_at) VALUES ('task_legacy', 'ws_legacy', 'Legacy task', '', '[]', 'ready', ?)",
  ).run("2026-01-01T00:00:00.000Z");
  db.prepare(
    "INSERT INTO events (id, aggregate_type, aggregate_id, type, actor, payload, created_at) VALUES ('evt_old', 'task', 'task_legacy', 'task.running', 'system', '{}', ?)",
  ).run("2026-01-01T00:00:00.000Z");
  if (options.trigger) {
    db.exec(`
      CREATE TRIGGER fail_kernel_migration BEFORE UPDATE ON tasks
      BEGIN SELECT RAISE(ABORT, 'migration fault'); END;
    `);
  }
  db.close();
  return dbPath;
}

function tableColumns(dbPath: string, table: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>).map(
      (row) => String(row.name),
    );
  } finally {
    db.close();
  }
}

function userVersion(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    return Number((db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version);
  } finally {
    db.close();
  }
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
    // t83 F4：Store.appendEvent 是旧调用路径，默认 schemaVersion=1；内核显式写 2。
    expect(store.listEvents({ aggregateId: "t1" })[0].schemaVersion).toBe(1);
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

describe("t83 event validation and schema versions", () => {
  it("registers a zod schema for every kernel event type", () => {
    for (const type of KERNEL_EVENT_TYPES) {
      expect(EVENT_REGISTRY[type]).toBeTruthy();
      expect(EVENT_REGISTRY[type].version).toBe(KERNEL_EVENT_SCHEMA_VERSION);
      expect(EVENT_REGISTRY[type].version).toBe(2);
      expect(EVENT_REGISTRY[type].maxBytes).toBeGreaterThan(0);
    }
  });

  it("rejects unknown types, unknown fields, invalid values and oversized payloads", () => {
    const valid = {
      task: { id: "t1", workspaceId: "w1", title: "ok", status: "ready" },
    };
    expect(() => assertKernelEventPayload("task.created", valid)).not.toThrow();
    expect(() =>
      assertKernelEventPayload("task.created", { ...valid, unexpected: true }),
    ).toThrow(/invalid kernel event payload/);
    expect(() =>
      assertKernelEventPayload("task.status_changed", {
        from: "running",
        to: "not-a-status",
        reason: "x",
      }),
    ).toThrow(/invalid kernel event payload/);
    expect(() =>
      assertKernelEventPayload("task.created", {
        task: { id: "", workspaceId: "w1", title: "x", status: "ready" },
      }),
    ).toThrow(/invalid kernel event payload/);
    expect(() => assertKernelEventPayload("unknown.event", {})).toThrow(/not registered/);
    expect(() =>
      assertKernelEventPayload("task.updated", { patch: { description: "x".repeat(70_000) } }),
    ).toThrow(/too large/);
  });

  it("writes old events as 1 and kernel/task.created events as 2", () => {
    const { store, workspaceId } = setupKernel(instantExecutor);
    const task = createTask(store, workspaceId, "schema");
    const created = store
      .listEvents({ aggregateId: task.id })
      .find((event) => event.type === "task.created");
    expect(created?.schemaVersion).toBe(2);
    const legacy = store.appendEvent({
      aggregateType: "task",
      aggregateId: task.id,
      type: "tool.call",
      actor: "agent",
      payload: { name: "fs.read" },
    });
    expect(legacy.schemaVersion).toBe(1);
  });
});

describe("t83 workspace write isolation", () => {
  it("defaults maxWorkspace to 1 and serializes two different members writing the same file", async () => {
    expect(DEFAULT_KERNEL_LIMITS.maxWorkspace).toBe(1);
    const store = new Store(":memory:");
    cleanups.push(() => store.close());
    const workspace = store.createWorkspace("isolation", ".");
    const agents = ["A", "B"].map((name) =>
      store.createAgent({
        workspaceId: workspace.id,
        name,
        role: "engineer",
        systemPrompt: "",
        persona: "",
        agentsMd: "",
        model: null,
      }),
    );
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "deer-write-")), "shared.txt");
    writeFileSync(file, "", "utf8");
    let activeWriters = 0;
    let maxActiveWriters = 0;
    const gates: Array<() => void> = [];
    const executor: RunExecutor = async () => {
      activeWriters += 1;
      maxActiveWriters = Math.max(maxActiveWriters, activeWriters);
      await new Promise<void>((resolve) => gates.push(resolve));
      activeWriters -= 1;
      return { summary: "ok" };
    };
    const kernel = new ExecutionKernel({
      store,
      executor,
      clock: new FakeClock(),
      autoTick: false,
      limits: { maxGlobal: 4, maxWorkspace: 1, maxPerAgent: 1 },
    });
    cleanups.push(() => kernel.dispose());
    const first = store.createTask({
      workspaceId: workspace.id,
      title: "writer-a",
      description: "",
      acceptance: [],
      ownerId: agents[0].id,
    });
    const second = store.createTask({
      workspaceId: workspace.id,
      title: "writer-b",
      description: "",
      acceptance: [],
      ownerId: agents[1].id,
    });
    kernel.startTask(first.id);
    kernel.startTask(second.id);
    await waitFor(() => gates.length === 1);
    expect(maxActiveWriters).toBe(1);
    expect(taskStatus(store, second.id)).toBe("queued");
    gates.shift()?.();
    await waitFor(() => gates.length === 1);
    gates.shift()?.();
    await waitFor(() => taskStatus(store, second.id) === "done");
    expect(maxActiveWriters).toBe(1);
  });
});

describe("t83 watchdog and waiting_human", () => {
  it("aborts a hung local run when heartbeat/lease expires and audits LEASE_EXPIRED", async () => {
    let aborted = false;
    const executor: RunExecutor = (ctx) => {
      ctx.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise(() => {});
    };
    const { store, workspaceId, clock, kernel } = setupKernel(executor, {
      maxAttempts: 1,
    });
    const task = createTask(store, workspaceId, "hung");
    kernel.startTask(task.id);
    await waitFor(() => taskStatus(store, task.id) === "running");
    clock.advance(61_000);
    kernel.tick();
    const run = kernel.listRuns(task.id)[0];
    expect(aborted).toBe(true);
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("LEASE_EXPIRED");
    expect(taskStatus(store, task.id)).toBe("failed");
    const events = store.listEvents({ aggregateId: run.id });
    expect(
      events.some(
        (event) =>
          event.type === "run.failed" &&
          (event.payload as { patch?: { errorCode?: string } }).patch?.errorCode ===
            "LEASE_EXPIRED",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "kernel.recovered" &&
          (event.payload as { action?: string; source?: string }).action === "lease_expired" &&
          (event.payload as { source?: string }).source === "watchdog",
      ),
    ).toBe(true);
  });

  it("keeps waiting_human alive past lease TTL, then resumes and completes", async () => {
    let captured: RunExecutionContext | null = null;
    let release: (() => void) | null = null;
    const executor: RunExecutor = (ctx) => {
      captured = ctx;
      ctx.waitingHuman("risk_approval");
      return new Promise((resolve) => {
        release = () => resolve({ summary: "approved" });
      });
    };
    const { store, workspaceId, clock, kernel } = setupKernel(executor);
    const task = createTask(store, workspaceId, "waiting");
    kernel.startTask(task.id);
    await waitFor(() => kernel.listRuns(task.id)[0]?.status === "waiting_human");
    const before = kernel.listRuns(task.id)[0];
    clock.advance(120_000);
    kernel.tick();
    const waiting = kernel.listRuns(task.id)[0];
    expect(waiting.status).toBe("waiting_human");
    expect(Date.parse(waiting.leaseExpiresAt!) > Date.parse(before.leaseExpiresAt!)).toBe(true);
    captured!.resumeHuman();
    release!();
    await waitFor(() => taskStatus(store, task.id) === "done");
    const types = store.listEvents({ aggregateId: waiting.id }).map((event) => event.type);
    expect(types).toContain("run.waiting_human");
    expect(types).toContain("run.resumed");
  });

  it("waiting_human failure resumes into run.failed", async () => {
    let rejectExec: ((error: Error) => void) | null = null;
    let captured: RunExecutionContext | null = null;
    const executor: RunExecutor = (ctx) => {
      captured = ctx;
      ctx.waitingHuman("risk_approval");
      return new Promise((_resolve, reject) => {
        rejectExec = reject;
      });
    };
    const { store, workspaceId, kernel } = setupKernel(executor, { maxAttempts: 1 });
    const task = createTask(store, workspaceId, "waiting-fail");
    kernel.startTask(task.id);
    await waitFor(() => kernel.listRuns(task.id)[0]?.status === "waiting_human");
    captured!.resumeHuman();
    rejectExec!(new Error("approval denied"));
    await waitFor(() => taskStatus(store, task.id) === "failed");
    expect(kernel.listRuns(task.id)[0].status).toBe("failed");
  });
});

describe("t83 review policy", () => {
  it("required policy enters review, approve completes, reject fails", async () => {
    const { store, workspaceId, kernel } = setupKernel(instantExecutor);
    store.setSetting("kernel.reviewPolicy", "required");
    const approvedTask = createTask(store, workspaceId, "review-approve");
    kernel.startTask(approvedTask.id);
    await waitFor(() => taskStatus(store, approvedTask.id) === "review");
    expect(
      store
        .listEvents({ aggregateId: approvedTask.id })
        .some((event) => event.type === "task.review_requested"),
    ).toBe(true);
    kernel.reviewTask(approvedTask.id, "approve", { reviewer: "user" });
    expect(taskStatus(store, approvedTask.id)).toBe("done");
    expect(
      store
        .listEvents({ aggregateId: approvedTask.id })
        .some((event) => event.type === "task.review_approved"),
    ).toBe(true);

    const rejectedTask = createTask(store, workspaceId, "review-reject");
    kernel.startTask(rejectedTask.id);
    await waitFor(() => taskStatus(store, rejectedTask.id) === "review");
    kernel.reviewTask(rejectedTask.id, "reject", { notes: "not acceptable" });
    expect(taskStatus(store, rejectedTask.id)).toBe("failed");
    expect(store.getTask(rejectedTask.id)?.failureKind).toBe("REVIEW_REJECTED");
    expect(
      store
        .listEvents({ aggregateId: rejectedTask.id })
        .some((event) => event.type === "task.review_rejected"),
    ).toBe(true);
  });
});

describe("t83 T22 blocked reason audit", () => {
  it("writes task.blocked(reasonB) without a status transition when dependency fails", async () => {
    const executor: RunExecutor = async () => {
      const error = new Error("parent failed") as Error & { retryable?: boolean };
      error.retryable = false;
      throw error;
    };
    const { store, workspaceId, kernel } = setupKernel(executor, { maxAttempts: 1 });
    const parent = createTask(store, workspaceId, "t22-parent");
    const child = store.createTask({
      workspaceId,
      title: "t22-child",
      description: "",
      acceptance: [],
      dependsOn: [parent.id],
    });
    expect(store.getTask(child.id)?.blockedReason).toBe("waiting_dependencies");
    kernel.startTask(parent.id);
    await waitFor(() => taskStatus(store, parent.id) === "failed");
    expect(taskStatus(store, child.id)).toBe("blocked");
    expect(store.getTask(child.id)?.blockedReason).toBe("dependency_failed");
    const blockedEvents = store
      .listEvents({ aggregateId: child.id })
      .filter((event) => event.type === "task.blocked");
    expect(blockedEvents).toHaveLength(1);
    const payload = blockedEvents[0].payload as { reason?: string; previousReason?: string };
    expect(payload.reason).toBe("dependency_failed");
    expect(payload.previousReason).toBe("waiting_dependencies");
    expect(blockedEvents[0].idempotencyKey).toMatch(
      new RegExp(`^task:${child.id}:blocked:dependency_failed:\\d+$`),
    );
    const blockedStatusChanges = store
      .listEvents({ aggregateId: child.id })
      .filter(
        (event) =>
          event.type === "task.status_changed" &&
          (event.payload as { to?: string }).to === "blocked",
      );
    expect(blockedStatusChanges).toHaveLength(0);
  });
});

describe("t83 rebuild pagination", () => {
  it("replays more than 2000 events without truncation", () => {
    const store = new Store(":memory:");
    cleanups.push(() => store.close());
    const workspace = store.createWorkspace("pagination", ".");
    const task = store.createTask({
      workspaceId: workspace.id,
      title: "start",
      description: "",
      acceptance: [],
    });
    store.withTransaction(() => {
      for (let index = 0; index < 2_105; index += 1) {
        store.appendEvent({
          aggregateType: "task",
          aggregateId: task.id,
          type: "task.updated",
          actor: "system",
          payload: { patch: { title: `title-${index}` } },
          schemaVersion: 2,
        });
      }
    });
    const total = Number(
      (
        store.db.prepare("SELECT COUNT(*) AS count FROM events").get() as {
          count?: number;
        }
      ).count ?? 0,
    );
    expect(total).toBeGreaterThan(2_000);
    expect(store.listEvents({ aggregateId: task.id })).toHaveLength(500);
    rebuildProjections(store);
    expect(store.getTask(task.id)?.title).toBe("title-2104");
  });
});

describe("t83 migration backup fail-closed", () => {
  it("creates a verified backup and preserves old event schemaVersion/timestamps", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deer-backup-ok-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const dbPath = createLegacyTaskDb(root, { wal: true });
    const store = new Store(dbPath);
    cleanups.push(() => store.close());
    expect(userVersion(dbPath)).toBe(2);
    expect(store.lastBackupPath).toBeTruthy();
    expect(existsSync(store.lastBackupPath!)).toBe(true);
    const backup = new DatabaseSync(store.lastBackupPath!);
    try {
      const integrity = backup.prepare("PRAGMA integrity_check").get() as {
        integrity_check?: string;
      };
      expect(integrity.integrity_check).toBe("ok");
      const row = backup.prepare("SELECT title FROM tasks WHERE id = 'task_legacy'").get() as
        | { title?: string }
        | undefined;
      expect(row?.title).toBe("Legacy task");
    } finally {
      backup.close();
    }
    const oldEvent = store
      .listEvents({ aggregateId: "task_legacy" })
      .find((event) => event.id === "evt_old")!;
    expect(oldEvent.schemaVersion).toBe(1);
    expect(oldEvent.occurredAt).toBe(oldEvent.createdAt);
    expect(oldEvent.recordedAt).toBe(oldEvent.createdAt);
  });

  it("refuses to migrate when backup fails, keeping user_version=1 and no v2 columns", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deer-backup-fail-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const dbPath = createLegacyTaskDb(root);
    const notADirectory = path.join(root, "backup-target-is-a-file");
    writeFileSync(notADirectory, "x", "utf8");
    expect(() => new Store(dbPath, { backupDirectory: notADirectory })).toThrow();
    expect(userVersion(dbPath)).toBe(1);
    expect(tableColumns(dbPath, "tasks")).not.toContain("priority");
  });

  it("rolls back a half migration and keeps user_version=1", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deer-half-migrate-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const dbPath = createLegacyTaskDb(root, { trigger: true });
    expect(() => new Store(dbPath)).toThrow(/kernel migration failed/);
    expect(userVersion(dbPath)).toBe(1);
    expect(tableColumns(dbPath, "tasks")).not.toContain("priority");
  });
});

describe("t90 waiting_human/resumed projection replay", () => {
  it("rebuilds a waiting_human run consistently, then resumes and completes", async () => {
    let captured: RunExecutionContext | null = null;
    let release: (() => void) | null = null;
    const executor: RunExecutor = (ctx) => {
      captured = ctx;
      ctx.waitingHuman("risk_approval");
      return new Promise((resolve) => {
        release = () => resolve({ summary: "approved", tokenIn: 2, tokenOut: 3 });
      });
    };
    const { store, workspaceId, kernel } = setupKernel(executor);
    const task = createTask(store, workspaceId, "replay-waiting");
    kernel.startTask(task.id);
    await waitFor(() => kernel.listRuns(task.id)[0]?.status === "waiting_human");
    const liveWaiting = projectionDigest(store);
    const liveWaitingRun = kernel.listRuns(task.id)[0];
    expect(liveWaitingRun.status).toBe("waiting_human");

    const rebuiltWaiting = rebuildProjections(store);
    expect(rebuiltWaiting).toEqual(liveWaiting);
    const rebuiltRun = kernel.listRuns(task.id)[0];
    expect(rebuiltRun.status).toBe("waiting_human");
    expect(rebuiltRun.heartbeatAt).toBe(liveWaitingRun.heartbeatAt);
    expect(rebuiltRun.leaseExpiresAt).toBe(liveWaitingRun.leaseExpiresAt);

    captured!.resumeHuman();
    release!();
    await waitFor(() => taskStatus(store, task.id) === "done");
    const liveDone = projectionDigest(store);
    const rebuiltDone = rebuildProjections(store);
    expect(rebuiltDone).toEqual(liveDone);
    expect(kernel.listRuns(task.id)[0].status).toBe("completed");
  });

  it("rebuilds a failed run after waiting_human failure", async () => {
    let captured: RunExecutionContext | null = null;
    let rejectExec: ((error: Error) => void) | null = null;
    const executor: RunExecutor = (ctx) => {
      captured = ctx;
      ctx.waitingHuman("risk_approval");
      return new Promise((_resolve, reject) => {
        rejectExec = reject;
      });
    };
    const { store, workspaceId, kernel } = setupKernel(executor, { maxAttempts: 1 });
    const task = createTask(store, workspaceId, "replay-waiting-fail");
    kernel.startTask(task.id);
    await waitFor(() => kernel.listRuns(task.id)[0]?.status === "waiting_human");
    captured!.resumeHuman();
    rejectExec!(new Error("approval denied"));
    await waitFor(() => taskStatus(store, task.id) === "failed");
    const live = projectionDigest(store);
    const rebuilt = rebuildProjections(store);
    expect(rebuilt).toEqual(live);
    expect(kernel.listRuns(task.id)[0].status).toBe("failed");
    expect(store.getTask(task.id)?.status).toBe("failed");
  });
});

describe("t90 stale-owner CAS audit", () => {
  type StaleAction =
    | "heartbeat"
    | "checkpoint"
    | "enter_waiting_human"
    | "resume"
    | "complete"
    | "fail";

  const cases: Array<{ action: StaleAction; name: string }> = [
    { action: "heartbeat", name: "heartbeat" },
    { action: "checkpoint", name: "checkpoint" },
    { action: "enter_waiting_human", name: "enterWaiting" },
    { action: "resume", name: "resume" },
    { action: "complete", name: "complete" },
    { action: "fail", name: "fail" },
  ];

  it.each(cases)("discards stale-owner $name without state events", async ({ action }) => {
    let captured: RunExecutionContext | null = null;
    let aborted = false;
    let resolveExec: ((result: { summary: string }) => void) | null = null;
    let rejectExec: ((error: Error) => void) | null = null;
    const executor: RunExecutor = (ctx) => {
      captured = ctx;
      ctx.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise((resolve, reject) => {
        resolveExec = resolve;
        rejectExec = reject;
      });
    };
    const { store, workspaceId, kernel } = setupKernel(executor, { maxAttempts: 1 });
    const task = createTask(store, workspaceId, `stale-${action}`);
    kernel.startTask(task.id);
    await waitFor(() => taskStatus(store, task.id) === "running");
    const run = kernel.listRuns(task.id)[0];
    const statusChangesBefore = store
      .listEvents({ aggregateId: task.id })
      .filter((event) => event.type === "task.status_changed").length;
    store.db
      .prepare("UPDATE runs SET lease_owner = 'stale-owner' WHERE id = ?")
      .run(run.id);

    switch (action) {
      case "heartbeat":
        captured!.heartbeat({ steps: 9 });
        break;
      case "checkpoint":
        captured!.checkpoint({ step: 2 });
        break;
      case "enter_waiting_human":
        captured!.waitingHuman("risk_approval");
        break;
      case "resume":
        captured!.resumeHuman();
        break;
      case "complete":
        resolveExec!({ summary: "should-not-apply" });
        break;
      case "fail":
        rejectExec!(new Error("should-not-apply"));
        break;
    }
    await flush();
    await flush();

    const after = store.getRun(run.id)!;
    expect(aborted).toBe(true);
    expect(kernel.hasActiveRun(run.id)).toBe(false);
    expect(after.status).toBe("running");
    expect(after.attempt).toBe(1);
    expect(taskStatus(store, task.id)).toBe("running");
    expect(kernel.listRuns(task.id)).toHaveLength(1);
    const stateChangesAfter = store
      .listEvents({ aggregateId: task.id })
      .filter((event) => event.type === "task.status_changed").length;
    expect(stateChangesAfter).toBe(statusChangesBefore);

    const runEvents = store.listEvents({ aggregateId: run.id });
    expect(
      runEvents.filter((event) =>
        ["run.completed", "run.failed", "run.waiting_human", "run.resumed", "run.checkpoint"].includes(
          event.type,
        ),
      ),
    ).toHaveLength(0);
    const discarded = runEvents.filter((event) => event.type === "run.result_discarded");
    expect(discarded.length).toBeGreaterThanOrEqual(1);
    const payload = discarded[discarded.length - 1].payload as {
      runId?: string;
      action?: string;
      owner?: string | null;
    };
    expect(payload.runId).toBe(run.id);
    expect(payload.action).toBe(action);
    expect(payload.owner).toBe("stale-owner");
  });

  it("aborts stale heartbeat before a late executor tool call", async () => {
    let captured: RunExecutionContext | null = null;
    let releaseGate: (() => void) | null = null;
    let aborted = false;
    let toolCalls = 0;
    const executor: RunExecutor = async (ctx) => {
      captured = ctx;
      ctx.signal.addEventListener("abort", () => {
        aborted = true;
      });
      await new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      // 模拟 executor 在 await 之后尝试调用工具；abort 后必须不再产生副作用。
      if (!ctx.signal.aborted) toolCalls += 1;
      return { summary: "late-tool" };
    };
    const { store, workspaceId, kernel } = setupKernel(executor, { maxAttempts: 1 });
    const task = createTask(store, workspaceId, "stale-late-tool");
    kernel.startTask(task.id);
    await waitFor(() => taskStatus(store, task.id) === "running");
    const run = kernel.listRuns(task.id)[0];
    store.db.prepare("UPDATE runs SET lease_owner = 'stale-owner' WHERE id = ?").run(run.id);

    captured!.heartbeat({ steps: 1 });
    expect(aborted).toBe(true);
    expect(kernel.hasActiveRun(run.id)).toBe(false);
    releaseGate!();
    await flush();
    await flush();
    expect(toolCalls).toBe(0);
    expect(store.getRun(run.id)?.status).toBe("running");
    expect(taskStatus(store, task.id)).toBe("running");
  });
});

describe("t94 foreign lease reclaim consistency", () => {
  it("does not steal an unexpired foreign lease; recover and tick both wait for expiry", async () => {
    const { store, workspaceId, clock, kernel } = setupKernel(instantExecutor, { maxAttempts: 1 });
    const task = createTask(store, workspaceId, "foreign-lease");
    const now = clock.now();
    const nowIso = new Date(now).toISOString();
    const futureIso = new Date(now + 60_000).toISOString();
    store.db
      .prepare("UPDATE tasks SET status = 'running', started_at = ?, attempt_count = 1 WHERE id = ?")
      .run(nowIso, task.id);
    store.db
      .prepare(
        `INSERT INTO runs (id, task_id, agent_id, status, error, started_at, ended_at, token_in, token_out, attempt, heartbeat_at, lease_owner, lease_expires_at)
         VALUES ('run_foreign', ?, 'agent_x', 'running', NULL, ?, NULL, 0, 0, 1, ?, 'other-instance', ?)`,
      )
      .run(task.id, nowIso, nowIso, futureIso);

    kernel.recover();
    expect(kernel.listRuns(task.id)[0].status).toBe("running");
    kernel.tick();
    expect(kernel.listRuns(task.id)[0].status).toBe("running");
    expect(taskStatus(store, task.id)).toBe("running");

    clock.advance(61_000);
    kernel.tick();
    const recovered = kernel.listRuns(task.id)[0];
    expect(recovered.status).toBe("failed");
    expect(recovered.errorCode).toBe("LEASE_EXPIRED");
    expect(taskStatus(store, task.id)).toBe("failed");
  });
});
