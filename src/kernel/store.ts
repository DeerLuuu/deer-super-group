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
import { CanvasSchema, QuestionSchema } from "../shared/interactive.js";
import type { DeerCanvas, DeerQuestion, QuestionAnswers } from "../shared/interactive.js";
import {
  PollError,
  decisionSummary,
  evaluatePoll,
  isPollExpired,
  normalizeCreatePoll,
  validateSelections,
} from "../shared/poll.js";
import type {
  CastPollInput,
  ClosePollInput,
  CreatePollInput,
  Poll,
  PollBallot,
  PollDecision,
  PollOption,
  PollStatus,
} from "../shared/poll.js";
import type {
  Agent,
  AgentStatus,
  BoardEntry,
  BoardKind,
  ChatArtifactRecord,
  ChatMessage,
  ChatQuestionRecord,
  ChatRole,
  CreateAgentInput,
  CreateTaskInput,
  DeleteAgentResult,
  DeleteTaskResult,
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
  TranslationSettings,
  Workspace,
} from "../shared/types.js";
import { normalizeLayoutSettings } from "../shared/types.js";
import { normalizeTranslationSettings, parseTranslationSettings } from "../shared/translation.js";

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
  parent_id TEXT,
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

CREATE TABLE IF NOT EXISTS chat_artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  protocol_version INTEGER NOT NULL DEFAULT 1,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(message_id, block_index)
);
CREATE INDEX IF NOT EXISTS idx_chat_artifacts_ws
  ON chat_artifacts(workspace_id, agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_artifacts_msg
  ON chat_artifacts(message_id);

CREATE TABLE IF NOT EXISTS chat_questions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  answer TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  expires_at TEXT,
  UNIQUE(message_id, block_index)
);
CREATE INDEX IF NOT EXISTS idx_chat_questions_ws
  ON chat_questions(workspace_id, agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_questions_status
  ON chat_questions(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_chat_questions_msg
  ON chat_questions(message_id);

CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL,
  max_selections INTEGER,
  threshold_rule TEXT NOT NULL DEFAULT 'gt',
  threshold_value INTEGER NOT NULL DEFAULT 3,
  quorum INTEGER NOT NULL DEFAULT 0,
  allow_abstain INTEGER NOT NULL DEFAULT 0,
  anonymous INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closes_at TEXT,
  closed_at TEXT,
  decision_ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_polls_ws_status
  ON polls(workspace_id, status, created_at);

CREATE TABLE IF NOT EXISTS poll_options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll
  ON poll_options(poll_id, sort_order);

CREATE TABLE IF NOT EXISTS poll_ballots (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL,
  voter_id TEXT NOT NULL,
  voter_type TEXT NOT NULL,
  selections TEXT NOT NULL DEFAULT '[]',
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE(poll_id, voter_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_ballots_poll
  ON poll_ballots(poll_id, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_poll_ballots_voter
  ON poll_ballots(poll_id, voter_id);

CREATE TABLE IF NOT EXISTS poll_decisions (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  adopted_option_ids TEXT NOT NULL DEFAULT '[]',
  insufficient_quorum INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  board_entry_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_poll_decisions_ws
  ON poll_decisions(workspace_id, created_at);
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
    ...(row.parent_id == null ? {} : { parentId: String(row.parent_id) }),
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

const QUESTION_STATUSES = ["pending", "answered", "cancelled", "expired"] as const;

function toChatArtifact(row: Row): ChatArtifactRecord | null {
  const parsed = CanvasSchema.safeParse(parseJson<unknown>(row.payload, null));
  if (!parsed.success) return null;
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    agentId: String(row.agent_id),
    messageId: String(row.message_id),
    blockIndex: Number(row.block_index ?? 0),
    kind: parsed.data.kind,
    title: String(row.title),
    protocolVersion: Number(row.protocol_version ?? 1),
    payload: parsed.data,
    createdAt: String(row.created_at),
  };
}

function toChatQuestion(row: Row): ChatQuestionRecord | null {
  const payload = QuestionSchema.safeParse(parseJson<unknown>(row.payload, null));
  if (!payload.success) return null;
  const rawStatus = String(row.status ?? "pending");
  const status = (QUESTION_STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as ChatQuestionRecord["status"])
    : "pending";
  const rawAnswer = row.answer == null ? null : parseJson<unknown>(row.answer, null);
  const answer =
    rawAnswer &&
    typeof rawAnswer === "object" &&
    !Array.isArray(rawAnswer) &&
    typeof (rawAnswer as { values?: unknown }).values === "object"
      ? (rawAnswer as QuestionAnswers)
      : null;
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    agentId: String(row.agent_id),
    messageId: String(row.message_id),
    blockIndex: Number(row.block_index ?? 0),
    title: String(row.title),
    payload: payload.data,
    status,
    answer,
    createdAt: String(row.created_at),
    answeredAt: row.answered_at == null ? null : String(row.answered_at),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
  };
}

/** 类型可用性：DeerQuestion 用于 service 侧签名对齐（store 内部只存 JSON）。 */
export type StoredQuestionPayload = DeerQuestion;
export type StoredCanvasPayload = DeerCanvas;

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

    // t409 M1：真实回复链父节点。旧库补可空列；旧行保持 NULL，
    // 由投影层只对 legacy thread 做线性兼容。ALTER ADD COLUMN 原子，
    // 失败会关闭连接并拒绝启动，避免留下半迁移状态。
    try {
      const messageColumns = this.db.prepare("PRAGMA table_info(messages)").all() as Array<{
        name?: string;
      }>;
      if (!messageColumns.some((column) => column.name === "parent_id")) {
        this.db.exec("ALTER TABLE messages ADD COLUMN parent_id TEXT");
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id)");
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // ignore close error
      }
      throw error;
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

  /**
   * t167：删除成员。Router 由 service 拒绝；有活跃 Run 时拒绝；
   * 历史消息/聊天保留，归属任务改为未分配（不静默改所有者）。
   */
  deleteAgent(id: string): DeleteAgentResult {
    return this.withTransaction(() => {
      const agent = this.getAgent(id);
      if (!agent) throw new Error(`agent not found: ${id}`);
      if (agent.isRouter) throw new Error("Router 不能删除");
      const active = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND status IN ('queued','running','waiting_human')",
        )
        .get(id) as { n: number };
      if (Number(active.n) > 0) {
        throw new Error("成员还有排队/运行中的 Run，请先取消或等待其结束");
      }
      const reassigned = this.db
        .prepare("UPDATE tasks SET owner_id = NULL WHERE owner_id = ?")
        .run(id);
      this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
      this.appendEvent({
        aggregateType: "workspace",
        aggregateId: agent.workspaceId,
        type: "agent.deleted",
        actor: "user",
        payload: {
          agentId: id,
          name: agent.name,
          role: agent.role,
          reassignedTasks: Number(reassigned.changes ?? 0),
        },
      });
      return { agentId: id, reassignedTasks: Number(reassigned.changes ?? 0) };
    });
  }

  /**
   * t167：删除任务。保留事件日志，清理 Run、TaskSummary 与评审投影；
   * 有活跃 Run 或被其他任务依赖时拒绝，避免破坏 DAG。
   */
  deleteTask(id: string): DeleteTaskResult {
    return this.withTransaction(() => {
      const task = this.getTask(id);
      if (!task) throw new Error(`task not found: ${id}`);
      if (["queued", "running", "waiting_human"].includes(task.status)) {
        throw new Error("任务正在排队/运行中，请先取消任务");
      }
      const activeRuns = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND status IN ('queued','running','waiting_human')",
        )
        .get(id) as { n: number };
      if (Number(activeRuns.n) > 0) {
        throw new Error("任务还有排队/运行中的 Run，请先取消或等待其结束");
      }
      const dependents = this.listTasks(task.workspaceId).filter((row) =>
        row.dependsOn.includes(id),
      );
      if (dependents.length > 0) {
        throw new Error(
          `还有 ${dependents.length} 个任务依赖它（${dependents
            .slice(0, 3)
            .map((row) => row.title)
            .join("、")}），请先解除依赖`,
        );
      }

      const runs = this.db
        .prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?")
        .get(id) as { n: number };
      const summaries = this.db
        .prepare("SELECT COUNT(*) AS n FROM summaries WHERE task_id = ?")
        .get(id) as { n: number };

      this.deleteReviewProjectionForTask(id);
      this.db.prepare("DELETE FROM summaries WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM runs WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
      this.appendEvent({
        aggregateType: "task",
        aggregateId: id,
        type: "task.deleted",
        actor: "user",
        payload: {
          taskId: id,
          title: task.title,
          status: task.status,
          removedRuns: Number(runs.n ?? 0),
          removedSummaries: Number(summaries.n ?? 0),
        },
      });
      return {
        taskId: id,
        removedRuns: Number(runs.n ?? 0),
        removedSummaries: Number(summaries.n ?? 0),
      };
    });
  }

  /** t167：评审表可能由 ReviewStore 延迟创建；存在才清理，避免旧库报错。 */
  private deleteReviewProjectionForTask(taskId: string): void {
    const tables = new Set(
      (
        this.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name?: string }>
      ).map((row) => String(row.name ?? "")),
    );
    const has = (name: string) => tables.has(name);
    if (has("review_reanchor_log") && has("review_threads")) {
      this.db
        .prepare(
          "DELETE FROM review_reanchor_log WHERE thread_id IN (SELECT id FROM review_threads WHERE task_id = ?)",
        )
        .run(taskId);
    }
    if (has("review_comments") && has("review_threads")) {
      this.db
        .prepare(
          "DELETE FROM review_comments WHERE thread_id IN (SELECT id FROM review_threads WHERE task_id = ?)",
        )
        .run(taskId);
    }
    if (has("review_threads")) {
      this.db.prepare("DELETE FROM review_threads WHERE task_id = ?").run(taskId);
    }
    for (const table of [
      "review_diff_files",
      "review_decisions",
      "review_reviewers",
    ]) {
      if (has(table) && has("review_targets")) {
        this.db
          .prepare(
            `DELETE FROM ${table} WHERE target_id IN (SELECT id FROM review_targets WHERE task_id = ?)`,
          )
          .run(taskId);
      }
    }
    if (has("review_targets")) {
      this.db.prepare("DELETE FROM review_targets WHERE task_id = ?").run(taskId);
    }
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
    parentId?: string;
  }): MailboxMessage {
    const message: MailboxMessage = {
      id: newId("msg"),
      workspaceId: input.workspaceId,
      threadId: input.threadId ?? newId("thread"),
      ...(input.parentId ? { parentId: input.parentId } : {}),
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
        `INSERT INTO messages (id, workspace_id, thread_id, parent_id, from_agent, to_agents, kind, subject, body, refs, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.workspaceId,
        message.threadId,
        message.parentId ?? null,
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
    /** t170：压缩摘要需要排在最近消息之前。 */
    createdAt?: string;
  }): ChatMessage {
    const message: ChatMessage = {
      id: newId("chat"),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      role: input.role,
      content: input.content,
      reasoning: input.reasoning ?? "",
      createdAt: input.createdAt ?? now(),
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

  /**
   * t168：历史 turn 投影的分页读取。before 是 `(createdAt,id)` 游标，
   * 返回位于游标之前的最近 limit 条消息（按时间升序）。
   */
  listChatMessagesPage(
    workspaceId: string,
    agentId: string | undefined,
    limit = 200,
    before?: { createdAt: string; id: string } | null,
  ): ChatMessage[] {
    const clauses = ["workspace_id = ?"];
    const params: Array<string | number> = [workspaceId];
    if (agentId) {
      clauses.push("agent_id = ?");
      params.push(agentId);
    }
    if (before) {
      clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(before.createdAt, before.createdAt, before.id);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM chat_messages
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, Math.max(1, limit)) as Row[];
    return rows.map(toChatMessage).reverse();
  }

  /** t168：最近 2000 条 chat 事件（升序返回，供 turn 投影按时间窗口归属）。 */
  listRecentChatEvents(workspaceId: string, limit = 2000): EventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE aggregate_type = 'chat' AND aggregate_id = ?
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(workspaceId, Math.max(1, Math.min(limit, 2000))) as Row[];
    return rows.map((row) => this.toEventRecord(row)).reverse();
  }

  /**
   * t175：终态事件独立于 2000 process 窗口读取。
   * 返回按 seq 升序的最近 limit 条（默认 500）。
   */
  listChatTurnTerminalEvents(workspaceId: string, limit = 500): EventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE aggregate_type = 'chat' AND aggregate_id = ?
           AND type IN ('chat.turn_cancelled', 'chat.turn_error')
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(workspaceId, Math.max(1, Math.min(limit, 500))) as Row[];
    return rows.map((row) => this.toEventRecord(row)).reverse();
  }

  /** t170：清空当前对话、画布索引与提问；事件日志保留。 */
  clearChatContext(
    workspaceId: string,
    agentId: string,
  ): { removedMessages: number; removedArtifacts: number; removedQuestions: number } {
    return this.withTransaction(() => {
      const messages = this.db
        .prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE workspace_id = ? AND agent_id = ?")
        .get(workspaceId, agentId) as { n: number };
      const artifacts = this.db
        .prepare("SELECT COUNT(*) AS n FROM chat_artifacts WHERE workspace_id = ? AND agent_id = ?")
        .get(workspaceId, agentId) as { n: number };
      const questions = this.db
        .prepare("SELECT COUNT(*) AS n FROM chat_questions WHERE workspace_id = ? AND agent_id = ?")
        .get(workspaceId, agentId) as { n: number };
      this.db
        .prepare("DELETE FROM chat_questions WHERE workspace_id = ? AND agent_id = ?")
        .run(workspaceId, agentId);
      this.db
        .prepare("DELETE FROM chat_artifacts WHERE workspace_id = ? AND agent_id = ?")
        .run(workspaceId, agentId);
      this.db
        .prepare("DELETE FROM chat_messages WHERE workspace_id = ? AND agent_id = ?")
        .run(workspaceId, agentId);
      this.appendEvent({
        aggregateType: "chat",
        aggregateId: workspaceId,
        type: "chat.context_cleared",
        actor: "user",
        payload: {
          agentId,
          removedMessages: Number(messages.n ?? 0),
          removedArtifacts: Number(artifacts.n ?? 0),
          removedQuestions: Number(questions.n ?? 0),
        },
      });
      return {
        removedMessages: Number(messages.n ?? 0),
        removedArtifacts: Number(artifacts.n ?? 0),
        removedQuestions: Number(questions.n ?? 0),
      };
    });
  }

  /**
   * t170：保留最近 keep 条，旧消息替换为一条 system 摘要。
   * 摘要 createdAt 放在最近消息之前，保证 prompt/UI 顺序稳定。
   */
  compactChatContext(
    workspaceId: string,
    agentId: string,
    keep = 8,
  ): { summarizedMessages: number; keptMessages: number; summary: string } {
    return this.withTransaction(() => {
      const messages = this.listChatMessages(workspaceId, agentId, 200);
      if (messages.length <= keep) {
        return { summarizedMessages: 0, keptMessages: messages.length, summary: "" };
      }
      const older = messages.slice(0, messages.length - keep);
      const recent = messages.slice(messages.length - keep);
      const trim = (value: string, max = 180) => {
        const normalized = value.replace(/\s+/g, " ").trim();
        return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
      };
      const userGoals = older
        .filter((message) => message.role === "user")
        .slice(-4)
        .map((message) => `- ${trim(message.content)}`);
      const assistantNotes = older
        .filter((message) => message.role === "assistant")
        .slice(-4)
        .map((message) => `- ${trim(message.content)}`);
      const summary = [
        `[上下文压缩] 已将 ${older.length} 条较早消息压缩为摘要，保留最近 ${recent.length} 条。`,
        userGoals.length ? "近期用户目标：" : "",
        ...userGoals,
        assistantNotes.length ? "近期助手结论：" : "",
        ...assistantNotes,
      ]
        .filter(Boolean)
        .join("\n");
      const placeholders = older.map(() => "?").join(",");
      this.db
        .prepare(`DELETE FROM chat_messages WHERE id IN (${placeholders})`)
        .run(...older.map((message) => message.id));
      const recentStartedAt = Date.parse(recent[0]?.createdAt ?? "");
      const summaryCreatedAt = Number.isFinite(recentStartedAt)
        ? new Date(recentStartedAt - 1).toISOString()
        : now();
      this.addChatMessage({
        workspaceId,
        agentId,
        role: "system",
        content: summary,
        createdAt: summaryCreatedAt,
      });
      this.appendEvent({
        aggregateType: "chat",
        aggregateId: workspaceId,
        type: "chat.context_compacted",
        actor: "user",
        payload: {
          agentId,
          summarizedMessages: older.length,
          keptMessages: recent.length,
        },
      });
      return {
        summarizedMessages: older.length,
        keptMessages: recent.length,
        summary,
      };
    });
  }

  // chat interactive（t64：画布索引 + 提问状态机）-------------------------

  saveCanvasArtifact(input: {
    id: string;
    workspaceId: string;
    agentId: string;
    messageId: string;
    blockIndex: number;
    kind: DeerCanvas["kind"];
    title: string;
    protocolVersion: number;
    payload: DeerCanvas;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO chat_artifacts
         (id, workspace_id, agent_id, message_id, block_index, kind, title, protocol_version, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(
        input.id,
        input.workspaceId,
        input.agentId,
        input.messageId,
        input.blockIndex,
        input.kind,
        input.title,
        input.protocolVersion,
        JSON.stringify(input.payload),
        input.createdAt,
      );
  }

  listCanvasArtifacts(workspaceId: string, agentId?: string, limit = 100): ChatArtifactRecord[] {
    const capped = Math.max(1, Math.min(limit, 200));
    const rows = agentId
      ? (this.db
          .prepare(
            `SELECT * FROM chat_artifacts
             WHERE workspace_id = ? AND agent_id = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(workspaceId, agentId, capped) as Row[])
      : (this.db
          .prepare(
            `SELECT * FROM chat_artifacts
             WHERE workspace_id = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(workspaceId, capped) as Row[]);
    const records: ChatArtifactRecord[] = [];
    for (const row of rows) {
      const record = toChatArtifact(row);
      if (record) records.push(record);
    }
    return records;
  }

  getCanvasArtifact(workspaceId: string, artifactId: string): ChatArtifactRecord | null {
    const row = this.db
      .prepare("SELECT * FROM chat_artifacts WHERE id = ? AND workspace_id = ?")
      .get(artifactId, workspaceId) as Row | undefined;
    return row ? toChatArtifact(row) : null;
  }

  saveChatQuestion(input: {
    id: string;
    workspaceId: string;
    agentId: string;
    messageId: string;
    blockIndex: number;
    title: string;
    payload: DeerQuestion;
    createdAt: string;
    expiresAt: string | null;
  }): ChatQuestionRecord {
    this.db
      .prepare(
        `INSERT INTO chat_questions
         (id, workspace_id, agent_id, message_id, block_index, title, payload, status, answer, created_at, answered_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(
        input.id,
        input.workspaceId,
        input.agentId,
        input.messageId,
        input.blockIndex,
        input.title,
        JSON.stringify(input.payload),
        input.createdAt,
        input.expiresAt,
      );
    const record = this.getChatQuestion(input.id);
    if (!record) throw new Error(`question not found after save: ${input.id}`);
    return record;
  }

  listChatQuestions(workspaceId: string, agentId?: string, limit = 200): ChatQuestionRecord[] {
    const capped = Math.max(1, Math.min(limit, 200));
    const rows = agentId
      ? (this.db
          .prepare(
            `SELECT * FROM chat_questions
             WHERE workspace_id = ? AND agent_id = ?
             ORDER BY created_at ASC LIMIT ?`,
          )
          .all(workspaceId, agentId, capped) as Row[])
      : (this.db
          .prepare(
            `SELECT * FROM chat_questions
             WHERE workspace_id = ?
             ORDER BY created_at ASC LIMIT ?`,
          )
          .all(workspaceId, capped) as Row[]);
    const records: ChatQuestionRecord[] = [];
    for (const row of rows) {
      const record = toChatQuestion(row);
      if (record) records.push(record);
    }
    return records;
  }

  getChatQuestion(questionId: string): ChatQuestionRecord | null {
    const row = this.db.prepare("SELECT * FROM chat_questions WHERE id = ?").get(questionId) as
      | Row
      | undefined;
    return row ? toChatQuestion(row) : null;
  }

  /** 条件更新：仅 pending 且未过期才成功；返回是否发生变更。 */
  answerChatQuestion(input: {
    questionId: string;
    answer: QuestionAnswers;
    answeredAt: string;
  }): boolean {
    const result = this.db
      .prepare(
        `UPDATE chat_questions
            SET status = 'answered', answer = ?, answered_at = ?
          WHERE id = ?
            AND status = 'pending'
            AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .run(JSON.stringify(input.answer), input.answeredAt, input.questionId, input.answeredAt);
    return Number(result.changes) > 0;
  }

  /** 条件更新：仅 pending 才能取消；幂等（已取消返回 false）。 */
  cancelChatQuestion(input: { questionId: string; finishedAt: string }): boolean {
    const result = this.db
      .prepare(
        `UPDATE chat_questions
            SET status = 'cancelled', answered_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(input.finishedAt, input.questionId);
    return Number(result.changes) > 0;
  }

  /** 惰性过期：返回被标记的 id 列表（供服务层写事件）。 */
  expireChatQuestions(workspaceId: string, nowIso: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM chat_questions
          WHERE workspace_id = ? AND status = 'pending'
            AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .all(workspaceId, nowIso) as Row[];
    if (rows.length === 0) return [];
    const update = this.db.prepare(
      `UPDATE chat_questions SET status = 'expired', answered_at = ?
        WHERE id = ? AND status = 'pending'`,
    );
    const expired: string[] = [];
    for (const row of rows) {
      const id = String(row.id);
      const result = update.run(nowIso, id);
      if (Number(result.changes) > 0) expired.push(id);
    }
    return expired;
  }

  // polls ---------------------------------------------------------------

  createPoll(input: CreatePollInput): Poll {
    const normalized = normalizeCreatePoll(input);
    if (!this.getWorkspace(normalized.workspaceId)) {
      throw new PollError("POLL_INVALID_INPUT", "workspace not found");
    }
    if (!normalized.createdBy.trim()) {
      throw new PollError("POLL_INVALID_INPUT", "createdBy required");
    }
    const pollId = newId("poll");
    this.withTransaction(() => {
      this.db.prepare(
        `INSERT INTO polls
          (id, workspace_id, scope, scope_id, title, description, mode, max_selections,
           threshold_rule, threshold_value, quorum, allow_abstain, anonymous, status,
           created_by, created_at, closes_at, closed_at, decision_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL, NULL)`,
      ).run(
        pollId,
        normalized.workspaceId,
        normalized.scope,
        normalized.scopeId,
        normalized.title,
        normalized.description,
        normalized.mode,
        normalized.maxSelections,
        normalized.thresholdRule,
        normalized.thresholdValue,
        normalized.quorum,
        normalized.allowAbstain ? 1 : 0,
        normalized.anonymous ? 1 : 0,
        normalized.createdBy,
        now(),
        normalized.closesAt,
      );
      normalized.options.forEach((option, index) => {
        this.db.prepare(
          `INSERT INTO poll_options
            (id, poll_id, label, description, source_type, source_id, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          newId("popt"),
          pollId,
          option.label,
          option.description,
          option.sourceType,
          option.sourceId,
          index,
        );
      });
      this.appendEvent({
        aggregateType: "poll",
        aggregateId: pollId,
        type: "poll.created",
        actor: normalized.createdBy,
        payload: {
          workspaceId: normalized.workspaceId,
          scope: normalized.scope,
          mode: normalized.mode,
          optionCount: normalized.options.length,
          thresholdRule: normalized.thresholdRule,
          thresholdValue: normalized.thresholdValue,
          quorum: normalized.quorum,
          closesAt: normalized.closesAt,
        },
      });
      this.appendEvent({
        aggregateType: "poll",
        aggregateId: pollId,
        type: "poll.opened",
        actor: normalized.createdBy,
        payload: {
          workspaceId: normalized.workspaceId,
          scope: normalized.scope,
          mode: normalized.mode,
          optionCount: normalized.options.length,
        },
      });
    });
    return this.requirePoll(pollId);
  }

  listPolls(workspaceId: string, status?: PollStatus, limit = 100): Poll[] {
    if (!this.getWorkspace(workspaceId)) throw new PollError("POLL_INVALID_INPUT", "workspace not found");
    const rows = this.db.prepare(
      "SELECT id FROM polls WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?",
    ).all(workspaceId, Math.max(1, Math.min(500, limit))) as Row[];
    return rows
      .map((row) => this.getPoll(String(row.id)))
      .filter((poll): poll is Poll => poll !== null)
      .filter((poll) => !status || poll.status === status);
  }

  getPoll(pollId: string): Poll | null {
    const row = this.db.prepare("SELECT * FROM polls WHERE id = ?").get(pollId) as Row | undefined;
    if (!row) return null;
    if (row.status === "open" && isPollExpired({
      status: String(row.status) as PollStatus,
      closesAt: row.closes_at == null ? null : String(row.closes_at),
    }, now())) {
      const changed = this.db.prepare(
        "UPDATE polls SET status = 'expired' WHERE id = ? AND status = 'open'",
      ).run(pollId);
      if (Number(changed.changes ?? 0) > 0) {
        this.appendEvent({
          aggregateType: "poll",
          aggregateId: pollId,
          type: "poll.expired",
          actor: "system",
          payload: { workspaceId: String(row.workspace_id) },
        });
      }
      row.status = "expired";
    }
    const options = this.db.prepare(
      "SELECT * FROM poll_options WHERE poll_id = ? ORDER BY sort_order, id",
    ).all(pollId) as Row[];
    const ballots = this.db.prepare(
      "SELECT * FROM poll_ballots WHERE poll_id = ? ORDER BY updated_at, id",
    ).all(pollId) as Row[];
    const decisionRow = this.db.prepare(
      "SELECT * FROM poll_decisions WHERE poll_id = ?",
    ).get(pollId) as Row | undefined;
    return this.toPoll(row, options, ballots, decisionRow);
  }

  castPoll(input: CastPollInput): Poll {
    const poll = this.requirePoll(input.pollId);
    if (poll.status === "closed") throw new PollError("POLL_CLOSED", "poll is closed");
    if (poll.status === "expired") throw new PollError("POLL_EXPIRED", "poll is expired");
    if (poll.status !== "open") throw new PollError("POLL_CLOSED", "poll is not open");
    this.ensurePollVoter(poll.workspaceId, input.voterId, input.voterType);
    const selections = validateSelections(poll, input.selections);
    const existing = this.db.prepare(
      "SELECT * FROM poll_ballots WHERE poll_id = ? AND voter_id = ?",
    ).get(input.pollId, input.voterId) as Row | undefined;
    const previous = existing ? parseJson<string[]>(existing.selections, []) : [];
    const unchanged = existing && previous.length === selections.length && previous.every((id, index) => id === selections[index]);
    if (unchanged) return this.requirePoll(input.pollId);
    const timestamp = now();
    this.withTransaction(() => {
      this.db.prepare(
        `INSERT INTO poll_ballots
          (id, poll_id, voter_id, voter_type, selections, submitted_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(poll_id, voter_id) DO UPDATE SET
           voter_type = excluded.voter_type,
           selections = excluded.selections,
           updated_at = excluded.updated_at,
           revision = poll_ballots.revision + 1`,
      ).run(newId("pballot"), input.pollId, input.voterId, input.voterType, JSON.stringify(selections), timestamp, timestamp);
      const stored = this.db.prepare(
        "SELECT revision FROM poll_ballots WHERE poll_id = ? AND voter_id = ?",
      ).get(input.pollId, input.voterId) as Row | undefined;
      const revision = Number(stored?.revision ?? 1);
      this.appendEvent({
        aggregateType: "poll",
        aggregateId: input.pollId,
        type: "poll.voted",
        actor: input.voterId,
        payload: {
          workspaceId: poll.workspaceId,
          voterType: input.voterType,
          selectionCount: selections.length,
          revision,
        },
      });
    });
    return this.requirePoll(input.pollId);
  }

  closePoll(
    input: ClosePollInput,
    options: {
      /** 服务层用 MemoryStore.createBoard 写 decision，保证 domain/FTS/source 列完整。 */
      boardWriter?: (entry: {
        workspaceId: string;
        board: string;
        author: string;
        kind: "decision";
        content: string;
        confidence: "high";
        refs: string[];
      }) => { id: string };
    } = {},
  ): Poll {
    const poll = this.requirePoll(input.pollId);
    if (poll.status === "closed") return poll;
    if (
      input.actor !== poll.createdBy &&
      input.actor !== "facilitator" &&
      input.actor !== "admin"
    ) {
      throw new PollError("POLL_FORBIDDEN", "only creator/facilitator/admin can close poll");
    }
    const timestamp = now();
    const result = evaluatePoll(poll, poll.ballots);
    const decisionId = newId("pdec");
    const summary = decisionSummary(poll, result);
    let boardEntryId: string | null = null;
    this.withTransaction(() => {
      if (result.adoptedOptionIds.length > 0) {
        const boardInput = {
          workspaceId: poll.workspaceId,
          board: "decisions",
          author: input.actor,
          kind: "decision" as const,
          content: summary.slice(0, 2000),
          confidence: "high" as const,
          refs: [`poll:${poll.id}`],
        };
        const boardEntry = options.boardWriter
          ? options.boardWriter(boardInput)
          : this.postBoard(boardInput);
        boardEntryId = boardEntry.id;
      }
      this.db.prepare(
        `INSERT INTO poll_decisions
          (id, poll_id, workspace_id, adopted_option_ids, insufficient_quorum, summary, board_entry_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        decisionId,
        poll.id,
        poll.workspaceId,
        JSON.stringify(result.adoptedOptionIds),
        result.insufficientQuorum ? 1 : 0,
        summary,
        boardEntryId,
        timestamp,
      );
      this.db.prepare(
        "UPDATE polls SET status = 'closed', closed_at = ?, decision_ref = ? WHERE id = ?",
      ).run(timestamp, boardEntryId, poll.id);
      this.appendEvent({
        aggregateType: "poll",
        aggregateId: poll.id,
        type: "poll.closed",
        actor: input.actor,
        payload: {
          workspaceId: poll.workspaceId,
          adoptedCount: result.adoptedOptionIds.length,
          insufficientQuorum: result.insufficientQuorum,
          reason: input.reason ?? null,
        },
      });
      this.appendEvent({
        aggregateType: "poll",
        aggregateId: poll.id,
        type: "poll.decided",
        actor: input.actor,
        payload: {
          workspaceId: poll.workspaceId,
          decisionId,
          adoptedCount: result.adoptedOptionIds.length,
          boardEntryId,
          insufficientQuorum: result.insufficientQuorum,
        },
      });
    });
    return this.requirePoll(poll.id);
  }

  private requirePoll(pollId: string): Poll {
    const poll = this.getPoll(pollId);
    if (!poll) throw new PollError("POLL_NOT_FOUND", "poll not found");
    return poll;
  }

  private ensurePollVoter(workspaceId: string, voterId: string, voterType: "human" | "agent"): void {
    if (!voterId.trim()) throw new PollError("POLL_INVALID_INPUT", "voterId required");
    if (voterType === "human") return;
    if (voterType !== "agent") throw new PollError("POLL_INVALID_INPUT", "invalid voterType");
    const row = this.db.prepare(
      "SELECT 1 AS hit FROM agents WHERE id = ? AND workspace_id = ?",
    ).get(voterId, workspaceId) as Row | undefined;
    if (!row) throw new PollError("POLL_FORBIDDEN", "agent does not belong to workspace");
  }

  private toPoll(row: Row, options: Row[], ballots: Row[], decisionRow?: Row): Poll {
    const optionList: PollOption[] = options.map((option) => ({
      id: String(option.id),
      pollId: String(option.poll_id),
      label: String(option.label),
      description: String(option.description ?? ""),
      sourceType: String(option.source_type ?? "manual") as PollOption["sourceType"],
      sourceId: option.source_id == null ? null : String(option.source_id),
      sortOrder: Number(option.sort_order ?? 0),
    }));
    const ballotList: PollBallot[] = ballots.map((ballot) => ({
      id: String(ballot.id),
      pollId: String(ballot.poll_id),
      voterId: String(ballot.voter_id),
      voterType: String(ballot.voter_type) as PollBallot["voterType"],
      selections: parseJson<string[]>(ballot.selections, []),
      submittedAt: String(ballot.submitted_at),
      updatedAt: String(ballot.updated_at),
      revision: Number(ballot.revision ?? 1),
    }));
    const base = {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      scope: String(row.scope) as Poll["scope"],
      scopeId: row.scope_id == null ? null : String(row.scope_id),
      title: String(row.title),
      description: String(row.description ?? ""),
      mode: String(row.mode) as Poll["mode"],
      maxSelections: row.max_selections == null ? null : Number(row.max_selections),
      thresholdRule: String(row.threshold_rule) as Poll["thresholdRule"],
      thresholdValue: Number(row.threshold_value ?? 3),
      quorum: Number(row.quorum ?? 0),
      allowAbstain: Number(row.allow_abstain ?? 0) === 1,
      anonymous: Number(row.anonymous ?? 0) === 1,
      status: String(row.status) as Poll["status"],
      createdBy: String(row.created_by),
      createdAt: String(row.created_at),
      closesAt: row.closes_at == null ? null : String(row.closes_at),
      closedAt: row.closed_at == null ? null : String(row.closed_at),
      decisionRef: row.decision_ref == null ? null : String(row.decision_ref),
      options: optionList,
      ballots: ballotList,
    };
    const result = evaluatePoll(base, ballotList);
    const decision: PollDecision | null = decisionRow
      ? {
          id: String(decisionRow.id),
          pollId: String(decisionRow.poll_id),
          workspaceId: String(decisionRow.workspace_id),
          adoptedOptionIds: parseJson<string[]>(decisionRow.adopted_option_ids, []),
          insufficientQuorum: Number(decisionRow.insufficient_quorum ?? 0) === 1,
          summary: String(decisionRow.summary),
          boardEntryId: decisionRow.board_entry_id == null ? null : String(decisionRow.board_entry_id),
          createdAt: String(decisionRow.created_at),
        }
      : null;
    return { ...base, result, decision };
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

  getTranslationSettings(): TranslationSettings {
    return parseTranslationSettings(this.getSetting("translation.settings"));
  }

  saveTranslationSettings(settings: TranslationSettings): TranslationSettings {
    const normalized = normalizeTranslationSettings(settings);
    this.setSetting("translation.settings", JSON.stringify(normalized));
    return normalized;
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
      layout: normalizeLayoutSettings(
        parseJson<unknown>(this.getSetting("layout.settings"), null),
      ),
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
    // 逐字段保存：旧调用不带 layout 时保留用户已保存的最大分栏数，不被重置为默认。
    if (settings.layout !== undefined) {
      this.setSetting("layout.settings", JSON.stringify(normalizeLayoutSettings(settings.layout)));
    }
  }
}
