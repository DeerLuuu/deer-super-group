import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  normalizeModels,
  normalizeProviders,
  type LegacyProviderFields,
} from "../shared/models.js";
import { resolveApiKeyEnv, resolveBaseUrlEnv } from "./env.js";
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

export class Store {
  readonly db: DatabaseSync;
  private listeners = new Set<(event: EventRecord) => void>();

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.db = new DatabaseSync(databasePath);
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
  }): EventRecord {
    const id = newId("evt");
    const createdAt = now();
    const result = this.db
      .prepare(
        `INSERT INTO events (id, aggregate_type, aggregate_id, type, actor, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.aggregateType,
        input.aggregateId,
        input.type,
        input.actor,
        JSON.stringify(input.payload ?? {}),
        createdAt,
      );
    const event: EventRecord = {
      seq: Number(result.lastInsertRowid),
      id,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      type: input.type,
      actor: input.actor,
      payload: input.payload ?? {},
      createdAt,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore listener errors
      }
    }
    return event;
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
    return rows.map((row) => ({
      seq: Number(row.seq),
      id: String(row.id),
      aggregateType: String(row.aggregate_type),
      aggregateId: String(row.aggregate_id),
      type: String(row.type),
      actor: String(row.actor),
      payload: parseJson<unknown>(row.payload, {}),
      createdAt: String(row.created_at),
    }));
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
    const task: Task = {
      id: newId("task"),
      workspaceId: input.workspaceId,
      title: input.title,
      description: input.description,
      acceptance: input.acceptance ?? [],
      status: "ready",
      ownerId: input.ownerId ?? null,
      dependsOn: input.dependsOn ?? [],
      branch: null,
      worktree: null,
      summary: null,
      createdAt: now(),
      startedAt: null,
      endedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO tasks
         (id, workspace_id, title, description, acceptance, status, owner_id, depends_on, branch, worktree, summary, created_at, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    this.appendEvent({
      aggregateType: "task",
      aggregateId: task.id,
      type: "task.created",
      actor: "user",
      payload: { title: task.title, dependsOn: task.dependsOn },
    });
    return task;
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
    if (sets.length) {
      params.push(id);
      this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    }
    const task = this.getTask(id);
    if (!task) throw new Error(`task not found: ${id}`);
    if (patch.status) {
      this.appendEvent({
        aggregateType: "task",
        aggregateId: id,
        type: `task.${patch.status}`,
        actor: "system",
        payload: { status: patch.status },
      });
    }
    return task;
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
