import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  normalizeModels,
  normalizeProviders,
  type LegacyProviderFields,
} from "../shared/models.js";
import { resolveApiKeyEnv, resolveBaseUrlEnv } from "./env.js";
import { assertKernelEventPayload, isKernelEventType } from "./execution/eventRegistry.js";
import type {
  Agent,
  AgentStatus,
  BoardEntry,
  BoardKind,
  ChatMessage,
  ChatRole,
  CreateAgentInput,
  CreateTaskInput,
  EventRecord,
  LlmSettings,
  LlmSettingsInfo,
  MailboxMessage,
  ProviderInfo,
  Memo,
  MessageKind,
  Run,
  RunStatus,
  Task,
  TaskStatus,
  TaskSummary,
  Workspace,
} from "../shared/types.js";

type Row = Record<string, unknown>;

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  overview TEXT,
  overview_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  persona TEXT NOT NULL DEFAULT '',
  agents_md TEXT NOT NULL DEFAULT '',
  model TEXT,
  permission TEXT NOT NULL DEFAULT 'workspace_write',
  is_router INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'idle',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_ws ON agents(workspace_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'ready',
  owner_id TEXT,
  depends_on TEXT NOT NULL DEFAULT '[]',
  branch TEXT,
  worktree TEXT,
  summary TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_ws ON tasks(workspace_id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  token_in INTEGER NOT NULL DEFAULT 0,
  token_out INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_agg ON events(aggregate_type, aggregate_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agents TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  refs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_ws ON messages(workspace_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  reasoning TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_ws ON chat_messages(workspace_id, agent_id);

CREATE TABLE IF NOT EXISTS board_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  board TEXT NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  refs TEXT NOT NULL DEFAULT '[]',
  confidence TEXT NOT NULL DEFAULT 'medium',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_ws ON board_entries(workspace_id, board);

CREATE TABLE IF NOT EXISTS memos (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memos_ws ON memos(workspace_id);

CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  changes TEXT NOT NULL DEFAULT '[]',
  files TEXT NOT NULL DEFAULT '[]',
  tests TEXT NOT NULL DEFAULT '[]',
  decisions TEXT NOT NULL DEFAULT '[]',
  risks TEXT NOT NULL DEFAULT '[]',
  open_questions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summaries_task ON summaries(task_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * t68 内核 DDL（在 v1→v2 迁移补齐列之后执行；索引必须晚于列存在）。
 * 新库：SCHEMA 建基础表 → 补列 → 本 DDL → user_version=2。
 */
const KERNEL_TABLES = `
CREATE TABLE IF NOT EXISTS scheduler_state (
  workspace_id TEXT PRIMARY KEY,
  paused INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;

const KERNEL_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS ux_events_idem
  ON events(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_runs_attempt ON runs(task_id, attempt);
CREATE UNIQUE INDEX IF NOT EXISTS ux_runs_active
  ON runs(task_id) WHERE status IN ('queued','running','waiting_human');
CREATE INDEX IF NOT EXISTS idx_runs_heartbeat ON runs(status, heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_tasks_ready ON tasks(workspace_id, status, next_run_at);
`;

function newId(prefix: string): string {
  const uuid =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${Date.now().toString(36)}_${uuid.replace(/-/g, "").slice(0, 10)}`;
}

function now(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function toWorkspace(row: Row): Workspace {
  return {
    id: String(row.id),
    name: String(row.name),
    path: String(row.path),
    overview: row.overview == null ? null : String(row.overview),
    overviewEnabled: Number(row.overview_enabled) === 1,
    createdAt: String(row.created_at),
  };
}

function toAgent(row: Row): Agent {
  const permission = String(row.permission ?? "workspace_write");
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    role: String(row.role),
    systemPrompt: String(row.system_prompt),
    persona: String(row.persona),
    agentsMd: String(row.agents_md),
    model: row.model == null ? null : String(row.model),
    permission: (
      ["read_only", "workspace_write", "full_access", "auto_risk"] as const
    ).includes(permission as (typeof permissionValues)[number])
      ? (permission as Agent["permission"])
      : "workspace_write",
    isRouter: Number(row.is_router) === 1,
    status: String(row.status) as AgentStatus,
    createdAt: String(row.created_at),
  };
}

const permissionValues = ["read_only", "workspace_write", "full_access", "auto_risk"] as const;

function toTask(row: Row): Task {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    title: String(row.title),
    description: String(row.description),
    acceptance: parseJson<string[]>(row.acceptance, []),
    status: String(row.status) as TaskStatus,
    ownerId: row.owner_id == null ? null : String(row.owner_id),
    dependsOn: parseJson<string[]>(row.depends_on, []),
    branch: row.branch == null ? null : String(row.branch),
    worktree: row.worktree == null ? null : String(row.worktree),
    summary: row.summary == null ? null : String(row.summary),
    createdAt: String(row.created_at),
    startedAt: row.started_at == null ? null : String(row.started_at),
    endedAt: row.ended_at == null ? null : String(row.ended_at),
    priority: row.priority == null ? 50 : Number(row.priority),
    queuedAt: row.queued_at == null ? null : String(row.queued_at),
    blockedReason: row.blocked_reason == null ? null : String(row.blocked_reason),
    failureKind: row.failure_kind == null ? null : String(row.failure_kind),
    attemptCount: row.attempt_count == null ? 0 : Number(row.attempt_count),
    nextRunAt: row.next_run_at == null ? null : String(row.next_run_at),
  };
}

function toRun(row: Row): Run {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    agentId: String(row.agent_id),
    status: String(row.status) as RunStatus,
    error: row.error == null ? null : String(row.error),
    startedAt: String(row.started_at),
    endedAt: row.ended_at == null ? null : String(row.ended_at),
    tokenIn: Number(row.token_in ?? 0),
    tokenOut: Number(row.token_out ?? 0),
    attempt: row.attempt == null ? 1 : Number(row.attempt),
    modelProfileId: row.model_profile_id == null ? null : String(row.model_profile_id),
    modelId: row.model_id == null ? null : String(row.model_id),
    permissionSnapshot: row.permission_snapshot == null ? null : (String(row.permission_snapshot) as Run["permissionSnapshot"]),
    sandboxId: row.sandbox_id == null ? null : String(row.sandbox_id),
    retryOfRunId: row.retry_of_run_id == null ? null : String(row.retry_of_run_id),
    heartbeatAt: row.heartbeat_at == null ? null : String(row.heartbeat_at),
    leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
    leaseExpiresAt: row.lease_expires_at == null ? null : String(row.lease_expires_at),
    checkpointRef: row.checkpoint_ref == null ? null : String(row.checkpoint_ref),
    checkpointStep: row.checkpoint_step == null ? 0 : Number(row.checkpoint_step),
    costUsd: row.cost_usd == null ? 0 : Number(row.cost_usd),
    errorCode: row.error_code == null ? null : String(row.error_code),
    retryable: Number(row.retryable ?? 0) === 1,
    steps: row.steps == null ? 0 : Number(row.steps),
  };
}

function toMessage(row: Row): MailboxMessage {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    threadId: String(row.thread_id),
    from: String(row.from_agent),
    to: parseJson<string[]>(row.to_agents, []),
    kind: String(row.kind) as MessageKind,
    subject: String(row.subject),
    body: String(row.body),
    refs: parseJson<string[]>(row.refs, []),
    createdAt: String(row.created_at),
  };
}

function toBoardEntry(row: Row): BoardEntry {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    board: String(row.board),
    author: String(row.author),
    kind: String(row.kind) as BoardKind,
    content: String(row.content),
    refs: parseJson<string[]>(row.refs, []),
    confidence: String(row.confidence) as BoardEntry["confidence"],
    pinned: Number(row.pinned) === 1,
    createdAt: String(row.created_at),
  };
}

function toChatMessage(row: Row): ChatMessage {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    agentId: String(row.agent_id),
    role: String(row.role) as ChatRole,
    content: String(row.content),
    reasoning: row.reasoning == null ? "" : String(row.reasoning),
    createdAt: String(row.created_at),
  };
}

function toMemo(row: Row): Memo {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    agentId: String(row.agent_id),
    kind: String(row.kind) as Memo["kind"],
    content: String(row.content),
    tags: parseJson<string[]>(row.tags, []),
    createdAt: String(row.created_at),
  };
}

function toSummary(row: Row): TaskSummary {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    runId: String(row.run_id),
    goal: String(row.goal),
    changes: parseJson<string[]>(row.changes, []),
    files: parseJson<string[]>(row.files, []),
    tests: parseJson<TaskSummary["tests"]>(row.tests, []),
    decisions: parseJson<string[]>(row.decisions, []),
    risks: parseJson<string[]>(row.risks, []),
    openQuestions: parseJson<string[]>(row.open_questions, []),
    createdAt: String(row.created_at),
  };
}

export interface StoreOptions {
  /** 迁移备份目录；默认与数据库同目录。测试可指向不可写路径验证 fail-closed。 */
  backupDirectory?: string;
}

export class Store {
  readonly db: DatabaseSync;
  private readonly databasePath: string;
  private readonly backupDirectory: string | undefined;
  /** 最近一次成功且校验通过的迁移备份路径（t83 F3）。 */
  lastBackupPath: string | null = null;
  private listeners = new Set<(event: EventRecord) => void>();
  /** t68：事务中待提交事件（COMMIT 后再通知 renderer）。 */
  private txDepth = 0;
  private pendingEvents: EventRecord[] = [];

  constructor(databasePath: string, options: StoreOptions = {}) {
    this.databasePath = databasePath;
    this.backupDirectory = options.backupDirectory;
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.db = new DatabaseSync(databasePath);
    const legacyDatabase = this.tableExists("tasks");
    this.db.exec(SCHEMA);

    // Existing databases created before reasoning_content support.
    const columns = this.db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{
      name?: string;
    }>;
    if (!columns.some((column) => column.name === "reasoning")) {
      this.db.exec(
        "ALTER TABLE chat_messages ADD COLUMN reasoning TEXT NOT NULL DEFAULT ''",
      );
    }

    // DESIGN §15：存量库补 permission 列（默认 workspace_write 保持既有行为；新成员由 createAgent 默认 read_only）。
    const agentColumns = this.db.prepare("PRAGMA table_info(agents)").all() as Array<{
      name?: string;
    }>;
    if (!agentColumns.some((column) => column.name === "permission")) {
      this.db.exec(
        "ALTER TABLE agents ADD COLUMN permission TEXT NOT NULL DEFAULT 'workspace_write'",
      );
    }

    // t68：事件/投影/调度 schema（v2）。旧库补列并为存量实体写基线事件。
    // t83 F3：迁移/备份失败必须关闭连接并拒绝启动，避免泄漏锁文件。
    try {
      this.migrateKernelSchema(legacyDatabase, databasePath);
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // ignore close error
      }
      throw error;
    }
  }

  /**
   * t83 F3：WAL checkpoint + SQLite VACUUM INTO 生成一致性备份，并打开备份做 integrity_check。
   * 任何一步失败都抛错，调用方（迁移）必须拒绝启动，不得继续写 user_version=2。
   */
  backupDatabase(backupDirectory = this.backupDirectory): string {
    if (this.databasePath === ":memory:") {
      throw new Error("cannot backup an in-memory database");
    }
    const base = `${this.databasePath}.v1-backup`;
    let target = base;
    if (backupDirectory) {
      mkdirSync(backupDirectory, { recursive: true });
      target = path.join(backupDirectory, path.basename(base));
    }
    if (existsSync(target)) {
      target = `${target}-${Date.now()}`;
    }
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const escaped = target.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);
    const check = new DatabaseSync(target);
    try {
      const result = check.prepare("PRAGMA integrity_check").get() as {
        integrity_check?: string;
      };
      if (String(result?.integrity_check ?? "") !== "ok") {
        throw new Error(`backup integrity_check failed: ${target}`);
      }
    } finally {
      check.close();
    }
    this.lastBackupPath = target;
    return target;
  }

  private tableExists(name: string): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as Row | undefined;
    return Boolean(row);
  }

  private ensureColumn(table: string, name: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name?: string;
    }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }

  private migrateKernelSchema(legacyDatabase: boolean, databasePath?: string): void {
    const versionRow = this.db.prepare("PRAGMA user_version").get() as {
      user_version?: number;
    };
    const version = Number(versionRow?.user_version ?? 0);
    if (version >= 2) return;

    // 旧库先钉在 v1：备份或迁移失败时 user_version 仍为 1，应用拒绝启动。
    if (legacyDatabase && version < 1) {
      this.db.exec("PRAGMA user_version = 1");
    }
    if (legacyDatabase && databasePath && databasePath !== ":memory:") {
      // t83 F3：备份必须成功且可校验；失败直接抛出，不进入 DDL。
      this.backupDatabase();
    }

    const columns: Array<[string, string, string]> = [
      ["tasks", "priority", "INTEGER NOT NULL DEFAULT 50"],
      ["tasks", "queued_at", "TEXT"],
      ["tasks", "blocked_reason", "TEXT"],
      ["tasks", "failure_kind", "TEXT"],
      ["tasks", "attempt_count", "INTEGER NOT NULL DEFAULT 0"],
      ["tasks", "next_run_at", "TEXT"],
      ["runs", "attempt", "INTEGER NOT NULL DEFAULT 1"],
      ["runs", "model_profile_id", "TEXT"],
      ["runs", "model_id", "TEXT"],
      ["runs", "permission_snapshot", "TEXT"],
      ["runs", "sandbox_id", "TEXT"],
      ["runs", "retry_of_run_id", "TEXT"],
      ["runs", "heartbeat_at", "TEXT"],
      ["runs", "lease_owner", "TEXT"],
      ["runs", "lease_expires_at", "TEXT"],
      ["runs", "checkpoint_ref", "TEXT"],
      ["runs", "checkpoint_step", "INTEGER NOT NULL DEFAULT 0"],
      ["runs", "cost_usd", "REAL NOT NULL DEFAULT 0"],
      ["runs", "error_code", "TEXT"],
      ["runs", "retryable", "INTEGER NOT NULL DEFAULT 0"],
      ["runs", "steps", "INTEGER NOT NULL DEFAULT 0"],
      // t83 F4：旧 v1 事件默认 1；内核新写显式 schemaVersion=2。
      ["events", "schema_version", "INTEGER NOT NULL DEFAULT 1"],
      ["events", "idempotency_key", "TEXT"],
      ["events", "correlation_id", "TEXT"],
      ["events", "causation_id", "TEXT"],
      ["events", "occurred_at", "TEXT"],
      ["events", "recorded_at", "TEXT"],
    ];

    // DDL + 基线 + 归一 + 版本号同事务；任何一步失败回滚，user_version 保持 1。
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [table, name, definition] of columns) {
        this.ensureColumn(table, name, definition);
      }
      this.db.exec(KERNEL_TABLES);
      // 旧库可能有多条同任务 active Run；先归一（编号 + 去重），否则唯一索引会失败。
      if (legacyDatabase) this.normalizeLegacyRuns();
      this.db.exec(KERNEL_INDEXES);
      this.db.exec(
        "UPDATE events SET occurred_at = COALESCE(occurred_at, created_at), recorded_at = COALESCE(recorded_at, created_at) WHERE occurred_at IS NULL OR recorded_at IS NULL",
      );
      if (legacyDatabase) this.seedLegacySnapshots();
      this.db
        .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(2, now());
      this.db.exec("PRAGMA user_version = 2");
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback failure
      }
      throw new Error(
        `kernel migration failed (user_version stays 1${
          this.lastBackupPath ? `, backup: ${this.lastBackupPath}` : ""
        }): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private normalizeLegacyRuns(): void {
    const runs = this.db
      .prepare("SELECT * FROM runs ORDER BY task_id ASC, started_at ASC, id ASC")
      .all() as Row[];
    const attempts = new Map<string, number>();
    for (const row of runs) {
      const taskId = String(row.task_id);
      const attempt = (attempts.get(taskId) ?? 0) + 1;
      attempts.set(taskId, attempt);
      this.db
        .prepare("UPDATE runs SET attempt = ?, heartbeat_at = COALESCE(heartbeat_at, started_at) WHERE id = ?")
        .run(attempt, String(row.id));
    }
    // 同一 task 多个 active Run：保留最新一条，其余标记 failed（DUPLICATE_ACTIVE），
    // 保证 ux_runs_active 部分唯一索引可建立。
    const activeRows = this.db
      .prepare(
        "SELECT id, task_id FROM runs WHERE status IN ('queued','running','waiting_human') ORDER BY task_id ASC, started_at DESC, id DESC",
      )
      .all() as Array<{ id?: string; task_id?: string }>;
    const seen = new Set<string>();
    for (const row of activeRows) {
      const taskId = String(row.task_id);
      if (!seen.has(taskId)) {
        seen.add(taskId);
        continue;
      }
      this.db
        .prepare(
          "UPDATE runs SET status = 'failed', error = 'duplicate active run during migration', error_code = 'DUPLICATE_ACTIVE', retryable = 1, ended_at = ? WHERE id = ?",
        )
        .run(now(), String(row.id));
    }
  }

  /**
   * 旧库迁移：为 tasks / runs 写 `kernel.legacy_snapshot` 基线事件，
   * 让重建投影不必解释全部历史事件语义；旧事件保留只读（trace 仍可看）。
   */
  private seedLegacySnapshots(): void {
    const tasks = this.db.prepare("SELECT * FROM tasks").all() as Row[];
    for (const row of tasks) {
      const task = toTask(row);
      this.insertLegacySnapshot("task", task.id, task);
    }
    // 旧库 runs 没有 attempt：按 started_at + id 给每个 task 编号。
    const runs = this.db
      .prepare("SELECT * FROM runs ORDER BY task_id ASC, started_at ASC, id ASC")
      .all() as Row[];
    const attempts = new Map<string, number>();
    for (const row of runs) {
      const taskId = String(row.task_id);
      const attempt = (attempts.get(taskId) ?? 0) + 1;
      attempts.set(taskId, attempt);
      this.db
        .prepare("UPDATE runs SET attempt = ?, heartbeat_at = COALESCE(heartbeat_at, started_at) WHERE id = ?")
        .run(attempt, String(row.id));
    }
    const refreshedRuns = this.db.prepare("SELECT * FROM runs").all() as Row[];
    for (const row of refreshedRuns) {
      const run = toRun(row);
      this.insertLegacySnapshot("run", run.id, run);
    }
    this.db.exec(
      "UPDATE tasks SET attempt_count = (SELECT COUNT(*) FROM runs WHERE runs.task_id = tasks.id) WHERE attempt_count = 0",
    );
  }

  private insertLegacySnapshot(entity: "task" | "run", id: string, value: Task | Run): void {
    const createdAt = now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events
           (id, aggregate_type, aggregate_id, type, actor, payload, created_at,
            schema_version, idempotency_key, occurred_at, recorded_at)
         VALUES (?, ?, ?, 'kernel.legacy_snapshot', 'system', ?, ?, 2, ?, ?, ?)`,
      )
      .run(
        newId("evt"),
        entity,
        id,
        JSON.stringify({ entity, value }),
        createdAt,
        `legacy:snapshot:${entity}:${id}`,
        createdAt,
        createdAt,
      );
  }

  /** t68：唯一事务入口（同步；事件监听器在 COMMIT 后触发）。 */
  withTransaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth = 1;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      this.txDepth = 0;
      this.flushPendingEvents();
      return result;
    } catch (error) {
      this.txDepth = 0;
      this.pendingEvents = [];
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback errors
      }
      throw error;
    }
  }

  private flushPendingEvents(): void {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    for (const event of events) this.emitEvent(event);
  }

  private emitEvent(event: EventRecord): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore listener errors
      }
    }
  }

  close(): void {
    this.db.close();
  }

  onEvent(listener: (event: EventRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  appendEvent(input: {
    aggregateType: string;
    aggregateId: string;
    type: string;
    actor: string;
    payload?: unknown;
    schemaVersion?: number;
    idempotencyKey?: string | null;
    correlationId?: string | null;
    causationId?: string | null;
    occurredAt?: string;
  }): EventRecord {
    return this.appendEventIdempotent(input).event;
  }

  /**
   * t68：幂等 append。若 idempotencyKey 已存在，返回已有事件且不重复写/不重复通知。
   * 必须在 withTransaction 内与投影写一起调用，保证「事件+投影」原子。
   */
  appendEventIdempotent(input: {
    aggregateType: string;
    aggregateId: string;
    type: string;
    actor: string;
    payload?: unknown;
    schemaVersion?: number;
    idempotencyKey?: string | null;
    correlationId?: string | null;
    causationId?: string | null;
    occurredAt?: string;
  }): { event: EventRecord; created: boolean } {
    const idempotencyKey = input.idempotencyKey ?? null;
    const schemaVersion = input.schemaVersion ?? 1;
    // t83 F6：所有 schemaVersion=2 的内核事件在 append 前做 zod 严格校验。
    if (schemaVersion === 2 && isKernelEventType(input.type)) {
      assertKernelEventPayload(input.type, input.payload ?? {}, schemaVersion);
    }
    if (idempotencyKey) {
      const existing = this.db
        .prepare("SELECT * FROM events WHERE idempotency_key = ?")
        .get(idempotencyKey) as Row | undefined;
      if (existing) return { event: this.toEventRecord(existing), created: false };
    }
    const id = newId("evt");
    const occurredAt = input.occurredAt ?? now();
    const recordedAt = now();
    const result = this.db
      .prepare(
        `INSERT INTO events
           (id, aggregate_type, aggregate_id, type, actor, payload, created_at,
            schema_version, idempotency_key, correlation_id, causation_id, occurred_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.aggregateType,
        input.aggregateId,
        input.type,
        input.actor,
        JSON.stringify(input.payload ?? {}),
        occurredAt,
        schemaVersion,
        idempotencyKey,
        input.correlationId ?? null,
        input.causationId ?? null,
        occurredAt,
        recordedAt,
      );
    const event: EventRecord = {
      seq: Number(result.lastInsertRowid),
      id,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      type: input.type,
      actor: input.actor,
      payload: input.payload ?? {},
      createdAt: occurredAt,
      schemaVersion,
      idempotencyKey,
      correlationId: input.correlationId ?? null,
      causationId: input.causationId ?? null,
      occurredAt,
      recordedAt,
    };
    if (this.txDepth > 0) this.pendingEvents.push(event);
    else this.emitEvent(event);
    return { event, created: true };
  }

  private toEventRecord(row: Row): EventRecord {
    return {
      seq: Number(row.seq),
      id: String(row.id),
      aggregateType: String(row.aggregate_type),
      aggregateId: String(row.aggregate_id),
      type: String(row.type),
      actor: String(row.actor),
      payload: parseJson<unknown>(row.payload, {}),
      createdAt: String(row.created_at),
      schemaVersion: row.schema_version == null ? 1 : Number(row.schema_version),
      idempotencyKey: row.idempotency_key == null ? null : String(row.idempotency_key),
      correlationId: row.correlation_id == null ? null : String(row.correlation_id),
      causationId: row.causation_id == null ? null : String(row.causation_id),
      occurredAt: row.occurred_at == null ? String(row.created_at) : String(row.occurred_at),
      recordedAt: row.recorded_at == null ? String(row.created_at) : String(row.recorded_at),
    };
  }

  listEvents(filter: { aggregateId?: string; aggregateType?: string; limit?: number } = {}): EventRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.aggregateId) {
      clauses.push("aggregate_id = ?");
      params.push(filter.aggregateId);
    }
    if (filter.aggregateType) {
      clauses.push("aggregate_type = ?");
      params.push(filter.aggregateType);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(filter.limit ?? 500, 2000));
    const rows = this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY seq ASC LIMIT ${limit}`)
      .all(...params) as Row[];
    return rows.map((row) => this.toEventRecord(row));
  }

  /** t68：按任务 + 其全部 Run 聚合取事件（trace 兼容旧 tool.* 事件）。 */
  /** t83 F8：按 seq 游标分页读取，供完整重建（不静默截断）。 */
  listEventsAfter(afterSeq: number, limit = 500): EventRecord[] {
    const pageSize = Math.max(1, Math.min(limit, 1000));
    const rows = this.db
      .prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?")
      .all(afterSeq, pageSize) as Row[];
    return rows.map((row) => this.toEventRecord(row));
  }

  listEventsForTask(taskId: string, limit = 2000): EventRecord[] {
    const runIds = (
      this.db.prepare("SELECT id FROM runs WHERE task_id = ?").all(taskId) as Row[]
    ).map((row) => String(row.id));
    const ids = [taskId, ...runIds];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE aggregate_id IN (${placeholders}) ORDER BY seq ASC LIMIT ?`)
      .all(...ids, Math.max(1, Math.min(limit, 5000))) as Row[];
    return rows.map((row) => this.toEventRecord(row));
  }

  // workspaces -----------------------------------------------------------

  createWorkspace(name: string, workspacePath: string): Workspace {
    const existing = this.getWorkspaceByPath(workspacePath);
    if (existing) return existing;
    const workspace: Workspace = {
      id: newId("ws"),
      name,
      path: workspacePath,
      overview: null,
      overviewEnabled: true,
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, path, overview, overview_enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workspace.id,
        workspace.name,
        workspace.path,
        workspace.overview,
        1,
        workspace.createdAt,
      );
    this.appendEvent({
      aggregateType: "workspace",
      aggregateId: workspace.id,
      type: "workspace.created",
      actor: "user",
      payload: { name, path: workspacePath },
    });
    return workspace;
  }

  getWorkspace(id: string): Workspace | null {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Row | undefined;
    return row ? toWorkspace(row) : null;
  }

  getWorkspaceByPath(workspacePath: string): Workspace | null {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE path = ?").get(workspacePath) as
      | Row
      | undefined;
    return row ? toWorkspace(row) : null;
  }

  listWorkspaces(): Workspace[] {
    const rows = this.db.prepare("SELECT * FROM workspaces ORDER BY created_at ASC").all() as Row[];
    return rows.map(toWorkspace);
  }

  updateWorkspaceOverview(id: string, overview: string): void {
    this.db.prepare("UPDATE workspaces SET overview = ? WHERE id = ?").run(overview, id);
  }

  // agents ---------------------------------------------------------------

  createAgent(input: CreateAgentInput, isRouter = false): Agent {
    const agent: Agent = {
      id: newId("agent"),
      workspaceId: input.workspaceId,
      name: input.name,
      role: input.role,
      systemPrompt: input.systemPrompt,
      persona: input.persona,
      agentsMd: input.agentsMd,
      model: input.model,
      // DESIGN §15.2：新成员默认 read_only（安全默认）；Router 同样。
      permission: "read_only",
      isRouter,
      status: "idle",
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO agents
         (id, workspace_id, name, role, system_prompt, persona, agents_md, model, permission, is_router, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agent.id,
        agent.workspaceId,
        agent.name,
        agent.role,
        agent.systemPrompt,
        agent.persona,
        agent.agentsMd,
        agent.model,
        agent.permission,
        agent.isRouter ? 1 : 0,
        agent.status,
        agent.createdAt,
      );
    this.appendEvent({
      aggregateType: "workspace",
      aggregateId: agent.workspaceId,
      type: "agent.created",
      actor: "user",
      payload: { agentId: agent.id, name: agent.name, role: agent.role },
    });
    return agent;
  }

  getAgent(id: string): Agent | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
    return row ? toAgent(row) : null;
  }

  listAgents(workspaceId: string): Agent[] {
    const rows = this.db
      .prepare("SELECT * FROM agents WHERE workspace_id = ? ORDER BY is_router DESC, created_at ASC")
      .all(workspaceId) as Row[];
    return rows.map(toAgent);
  }

  updateAgentStatus(id: string, status: AgentStatus): void {
    this.db.prepare("UPDATE agents SET status = ? WHERE id = ?").run(status, id);
  }

  updateAgent(
    id: string,
    patch: Partial<
      Pick<Agent, "name" | "role" | "systemPrompt" | "persona" | "agentsMd" | "model" | "permission">
    >,
  ): Agent {
    const columns: Record<string, string> = {
      name: "name",
      role: "role",
      systemPrompt: "system_prompt",
      persona: "persona",
      agentsMd: "agents_md",
      model: "model",
      permission: "permission",
    };
    const sets: string[] = [];
    const params: Array<string | null> = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      const value = (patch as Record<string, unknown>)[key];
      params.push((value as string | null | undefined) ?? null);
    }
    if (sets.length > 0) {
      params.push(id);
      this.db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    }
    const agent = this.getAgent(id);
    if (!agent) throw new Error(`agent not found: ${id}`);
    this.appendEvent({
      aggregateType: "agent",
      aggregateId: id,
      type: "agent.updated",
      actor: "user",
      payload: patch,
    });
    return agent;
  }

  // tasks ----------------------------------------------------------------

  createTask(input: CreateTaskInput & { ownerId?: string | null; dependsOn?: string[] }): Task {
    return this.withTransaction(() => {
      const dependsOn = input.dependsOn ?? [];
      const dependsSatisfied = dependsOn.every(
        (dependencyId) => this.getTask(dependencyId)?.status === "done",
      );
      const task: Task = {
        id: newId("task"),
        workspaceId: input.workspaceId,
        title: input.title,
        description: input.description,
        acceptance: input.acceptance ?? [],
        status: dependsSatisfied ? "ready" : "blocked",
        ownerId: input.ownerId ?? null,
        dependsOn,
        branch: null,
        worktree: null,
        summary: null,
        createdAt: now(),
        startedAt: null,
        endedAt: null,
        priority: 50,
        queuedAt: null,
        blockedReason: dependsSatisfied ? null : "waiting_dependencies",
        failureKind: null,
        attemptCount: 0,
        nextRunAt: null,
      };
      this.insertTaskProjection(task);
      this.appendEventIdempotent({
        aggregateType: "task",
        aggregateId: task.id,
        type: "task.created",
        actor: "user",
        payload: { task },
        schemaVersion: 2,
        idempotencyKey: `task:${task.id}:created`,
      });
      return task;
    });
  }

  /** t68：供内核/迁移复用的任务投影写入。 */
  insertTaskProjection(task: Task): void {
    this.db
      .prepare(
        `INSERT INTO tasks
         (id, workspace_id, title, description, acceptance, status, owner_id, depends_on,
          branch, worktree, summary, created_at, started_at, ended_at,
          priority, queued_at, blocked_reason, failure_kind, attempt_count, next_run_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.workspaceId,
        task.title,
        task.description,
        JSON.stringify(task.acceptance),
        task.status,
        task.ownerId,
        JSON.stringify(task.dependsOn),
        task.branch,
        task.worktree,
        task.summary,
        task.createdAt,
        task.startedAt,
        task.endedAt,
        task.priority ?? 50,
        task.queuedAt ?? null,
        task.blockedReason ?? null,
        task.failureKind ?? null,
        task.attemptCount ?? 0,
        task.nextRunAt ?? null,
      );
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? toTask(row) : null;
  }

  listTasks(workspaceId: string): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE workspace_id = ? ORDER BY created_at ASC")
      .all(workspaceId) as Row[];
    return rows.map(toTask);
  }

  updateTask(
    id: string,
    patch: Partial<Pick<Task, "title" | "description" | "acceptance" | "status" | "ownerId" | "dependsOn" | "branch" | "worktree" | "summary" | "startedAt" | "endedAt">>,
  ): Task {
    return this.withTransaction(() => {
      const before = this.getTask(id);
      if (!before) throw new Error(`task not found: ${id}`);
      const columns: Record<string, string> = {
        title: "title",
        description: "description",
        acceptance: "acceptance",
        status: "status",
        ownerId: "owner_id",
        dependsOn: "depends_on",
        branch: "branch",
        worktree: "worktree",
        summary: "summary",
        startedAt: "started_at",
        endedAt: "ended_at",
      };
      const sets: string[] = [];
      const params: Array<string | number | null> = [];
      for (const [key, column] of Object.entries(columns)) {
        if (!(key in patch)) continue;
        const value = (patch as Record<string, unknown>)[key];
        sets.push(`${column} = ?`);
        if (Array.isArray(value)) params.push(JSON.stringify(value));
        else params.push((value as string | number | null | undefined) ?? null);
      }
      if (!sets.length) return before;
      params.push(id);
      this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);

      const statusPatch = patch.status;
      if (patch.dependsOn && !statusPatch) {
        const satisfied = (patch.dependsOn ?? []).every(
          (dependencyId) => this.getTask(dependencyId)?.status === "done",
        );
        const desired = satisfied ? "ready" : "blocked";
        if (before.status === "ready" || before.status === "blocked") {
          this.db
            .prepare("UPDATE tasks SET status = ?, blocked_reason = ? WHERE id = ?")
            .run(desired, satisfied ? null : "waiting_dependencies", id);
        }
        this.appendEventIdempotent({
          aggregateType: "task",
          aggregateId: id,
          type: "task.updated",
          actor: "system",
          payload: { patch: { dependsOn: patch.dependsOn } },
          schemaVersion: 2,
        });
      } else if (statusPatch) {
        this.appendEventIdempotent({
          aggregateType: "task",
          aggregateId: id,
          type: "task.status_changed",
          actor: "system",
          payload: { from: before.status, to: statusPatch, reason: "store.updateTask" },
          schemaVersion: 2,
        });
      } else {
        this.appendEventIdempotent({
          aggregateType: "task",
          aggregateId: id,
          type: "task.updated",
          actor: "system",
          payload: { patch },
          schemaVersion: 2,
        });
      }
      return this.getTask(id) ?? before;
    });
  }

  // runs -----------------------------------------------------------------

  createRun(taskId: string, agentId: string): Run {
    const run: Run = {
      id: newId("run"),
      taskId,
      agentId,
      status: "running",
      error: null,
      startedAt: now(),
      endedAt: null,
      tokenIn: 0,
      tokenOut: 0,
    };
    this.db
      .prepare(
        `INSERT INTO runs (id, task_id, agent_id, status, error, started_at, ended_at, token_in, token_out)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.taskId,
        run.agentId,
        run.status,
        run.error,
        run.startedAt,
        run.endedAt,
        run.tokenIn,
        run.tokenOut,
      );
    return run;
  }

  updateRun(
    id: string,
    patch: Partial<Pick<Run, "status" | "error" | "endedAt" | "tokenIn" | "tokenOut">>,
  ): void {
    const columns: Record<string, string> = {
      status: "status",
      error: "error",
      endedAt: "ended_at",
      tokenIn: "token_in",
      tokenOut: "token_out",
    };
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      const value = (patch as Record<string, unknown>)[key];
      sets.push(`${column} = ?`);
      params.push((value as string | number | null | undefined) ?? null);
    }
    if (!sets.length) return;
    params.push(id);
    this.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  getRun(id: string): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? toRun(row) : null;
  }

  listRunsForTask(taskId: string): Run[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at ASC")
      .all(taskId) as Row[];
    return rows.map(toRun);
  }

  // messages -------------------------------------------------------------

  addMessage(input: {
    workspaceId: string;
    from: string;
    to: string[];
    kind: MessageKind;
    subject: string;
    body: string;
    refs?: string[];
    threadId?: string;
  }): MailboxMessage {
    const message: MailboxMessage = {
      id: newId("msg"),
      workspaceId: input.workspaceId,
      threadId: input.threadId ?? newId("thread"),
      from: input.from,
      to: input.to,
      kind: input.kind,
      subject: input.subject,
      body: input.body,
      refs: input.refs ?? [],
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, workspace_id, thread_id, from_agent, to_agents, kind, subject, body, refs, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.workspaceId,
        message.threadId,
        message.from,
        JSON.stringify(message.to),
        message.kind,
        message.subject,
        message.body,
        JSON.stringify(message.refs),
        message.createdAt,
      );
    this.appendEvent({
      aggregateType: "workspace",
      aggregateId: message.workspaceId,
      type: "mailbox.sent",
      actor: message.from,
      payload: { messageId: message.id, to: message.to, subject: message.subject },
    });
    return message;
  }

  listMessages(workspaceId: string, limit = 200): MailboxMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(workspaceId, limit) as Row[];
    return rows.map(toMessage);
  }

  // chat -----------------------------------------------------------------

  addChatMessage(input: {
    workspaceId: string;
    agentId: string;
    role: ChatRole;
    content: string;
    reasoning?: string;
  }): ChatMessage {
    const message: ChatMessage = {
      id: newId("chat"),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      role: input.role,
      content: input.content,
      reasoning: input.reasoning ?? "",
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO chat_messages (id, workspace_id, agent_id, role, content, reasoning, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.workspaceId,
        message.agentId,
        message.role,
        message.content,
        message.reasoning,
        message.createdAt,
      );
    return message;
  }

  listChatMessages(workspaceId: string, agentId?: string, limit = 100): ChatMessage[] {
    const rows = agentId
      ? (this.db
          .prepare(
            `SELECT * FROM chat_messages
             WHERE workspace_id = ? AND agent_id = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(workspaceId, agentId, limit) as Row[])
      : (this.db
          .prepare(
            `SELECT * FROM chat_messages
             WHERE workspace_id = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(workspaceId, limit) as Row[]);
    return rows.map(toChatMessage).reverse();
  }

  // board ----------------------------------------------------------------

  postBoard(input: {
    workspaceId: string;
    board: string;
    author: string;
    kind: BoardKind;
    content: string;
    refs?: string[];
    confidence?: BoardEntry["confidence"];
    pinned?: boolean;
  }): BoardEntry {
    const entry: BoardEntry = {
      id: newId("board"),
      workspaceId: input.workspaceId,
      board: input.board,
      author: input.author,
      kind: input.kind,
      content: input.content,
      refs: input.refs ?? [],
      confidence: input.confidence ?? "medium",
      pinned: input.pinned ?? false,
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO board_entries (id, workspace_id, board, author, kind, content, refs, confidence, pinned, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.workspaceId,
        entry.board,
        entry.author,
        entry.kind,
        entry.content,
        JSON.stringify(entry.refs),
        entry.confidence,
        entry.pinned ? 1 : 0,
        entry.createdAt,
      );
    this.appendEvent({
      aggregateType: "workspace",
      aggregateId: entry.workspaceId,
      type: "board.posted",
      actor: entry.author,
      payload: { board: entry.board, entryId: entry.id, kind: entry.kind },
    });
    return entry;
  }

  listBoard(workspaceId: string, board?: string, limit = 200): BoardEntry[] {
    const rows = board
      ? (this.db
          .prepare(
            "SELECT * FROM board_entries WHERE workspace_id = ? AND board = ? ORDER BY created_at DESC LIMIT ?",
          )
          .all(workspaceId, board, limit) as Row[])
      : (this.db
          .prepare(
            "SELECT * FROM board_entries WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?",
          )
          .all(workspaceId, limit) as Row[]);
    return rows.map(toBoardEntry);
  }

  // memos ----------------------------------------------------------------

  addMemo(input: {
    workspaceId: string;
    agentId: string;
    kind: Memo["kind"];
    content: string;
    tags?: string[];
  }): Memo {
    const memo: Memo = {
      id: newId("memo"),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      kind: input.kind,
      content: input.content,
      tags: input.tags ?? [],
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO memos (id, workspace_id, agent_id, kind, content, tags, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memo.id,
        memo.workspaceId,
        memo.agentId,
        memo.kind,
        memo.content,
        JSON.stringify(memo.tags),
        memo.createdAt,
      );
    return memo;
  }

  searchMemos(workspaceId: string, query: string, limit = 20): Memo[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM memos WHERE workspace_id = ? AND content LIKE ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(workspaceId, `%${query}%`, limit) as Row[];
    return rows.map(toMemo);
  }

  // summaries ------------------------------------------------------------

  saveSummary(input: Omit<TaskSummary, "id" | "createdAt">): TaskSummary {
    const summary: TaskSummary = { ...input, id: newId("sum"), createdAt: now() };
    this.db
      .prepare(
        `INSERT INTO summaries (id, task_id, run_id, goal, changes, files, tests, decisions, risks, open_questions, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        summary.id,
        summary.taskId,
        summary.runId,
        summary.goal,
        JSON.stringify(summary.changes),
        JSON.stringify(summary.files),
        JSON.stringify(summary.tests),
        JSON.stringify(summary.decisions),
        JSON.stringify(summary.risks),
        JSON.stringify(summary.openQuestions),
        summary.createdAt,
      );
    return summary;
  }

  getSummaryForTask(taskId: string): TaskSummary | null {
    const row = this.db
      .prepare("SELECT * FROM summaries WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(taskId) as Row | undefined;
    return row ? toSummary(row) : null;
  }

  // settings -------------------------------------------------------------

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value?: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  getLlmSettings(): LlmSettingsInfo {
    const legacy: LegacyProviderFields = {
      baseUrl: this.getSetting("llm.baseUrl") ?? "https://api.deepseek.com/v1",
      baseUrlEnv: this.getSetting("llm.baseUrlEnv") ?? "",
      apiKey: this.getSetting("llm.apiKey") ?? "",
      apiKeyEnv: this.getSetting("llm.apiKeyEnv") ?? "",
    };
    const mock = this.getSetting("llm.mock") !== "0";
    const providers = normalizeProviders(
      parseJson<unknown>(this.getSetting("llm.providers"), null),
      legacy,
    );

    const storedModel = this.getSetting("llm.model") ?? "deepseek-chat";
    const rawModels = parseJson<unknown>(this.getSetting("llm.models"), null);
    const models = normalizeModels(rawModels, providers, storedModel);
    const model =
      models.find((profile) => profile.id === storedModel)?.id ??
      models.find((profile) => profile.modelId === storedModel)?.id ??
      models[0].id;

    const providerInfos: ProviderInfo[] = providers.map((provider) => {
      const keyEnv = resolveApiKeyEnv({ apiKeyEnv: provider.apiKeyEnv });
      const baseEnv = resolveBaseUrlEnv({ baseUrlEnv: provider.baseUrlEnv });
      const apiKeySource: ProviderInfo["apiKeySource"] = mock
        ? "none"
        : keyEnv
          ? "env"
          : provider.apiKey.trim()
            ? "local"
            : "none";
      return {
        ...provider,
        apiKeySource,
        apiKeyEnvActive: keyEnv?.name ?? null,
        apiKeyEnvSet: Boolean(keyEnv),
        baseUrlSource: baseEnv ? "env" : "local",
        baseUrlEnvActive: baseEnv?.name ?? null,
        baseUrlEnvSet: Boolean(baseEnv),
        effectiveBaseUrl: baseEnv?.value ?? provider.baseUrl,
      };
    });

    const first = providerInfos[0];
    return {
      baseUrl: first.baseUrl,
      baseUrlEnv: first.baseUrlEnv,
      apiKey: first.apiKey,
      apiKeyEnv: first.apiKeyEnv,
      providers: providerInfos,
      model,
      models,
      mock,
      apiKeySource: first.apiKeySource,
      apiKeyEnvActive: first.apiKeyEnvActive,
      apiKeyEnvSet: first.apiKeyEnvSet,
      baseUrlSource: first.baseUrlSource,
      baseUrlEnvActive: first.baseUrlEnvActive,
      baseUrlEnvSet: first.baseUrlEnvSet,
      effectiveBaseUrl: first.effectiveBaseUrl,
    };
  }

  saveLlmSettings(settings: LlmSettings): void {
    const legacy: LegacyProviderFields = {
      baseUrl: settings.baseUrl,
      baseUrlEnv: settings.baseUrlEnv,
      apiKey: settings.apiKey,
      apiKeyEnv: settings.apiKeyEnv,
    };
    const providers = normalizeProviders(settings.providers, legacy);
    const models = normalizeModels(
      settings.models,
      providers,
      settings.model || "deepseek-chat",
    );
    const model =
      models.find((profile) => profile.id === settings.model)?.id ??
      models.find((profile) => profile.modelId === settings.model)?.id ??
      models[0].id;
    const first = providers[0];

    this.setSetting("llm.providers", JSON.stringify(providers));
    this.setSetting("llm.models", JSON.stringify(models));
    this.setSetting("llm.model", model);
    this.setSetting("llm.mock", settings.mock ? "1" : "0");
    // Keep legacy keys in sync for migration and for code paths that still read them.
    this.setSetting("llm.baseUrl", first.baseUrl);
    this.setSetting("llm.baseUrlEnv", first.baseUrlEnv);
    this.setSetting("llm.apiKey", first.apiKey);
    this.setSetting("llm.apiKeyEnv", first.apiKeyEnv);
  }
}
