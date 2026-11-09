import type { Store } from "../kernel/store.js";
import type { BoardKind } from "./types.js";
import { MemoryStore } from "../memory/store.js";
import { MemoryService } from "../memory/service.js";
import type {
  BoardArchiveProposal,
  BoardEntry,
  Confidence,
  MemoryActor,
  MemoryContext,
  MemoryResult,
  MemoryScope,
  MemorySearchInput,
  MemorySearchResult,
  MemorySnapshot,
  MemorySnapshotOptions,
  Memo,
  MemoKind,
} from "../memory/types.js";

export interface CreateMemoryBoardInput {
  workspaceId: string;
  board: string;
  kind: BoardKind;
  content: string;
  refs?: string[];
  confidence?: Confidence;
  ttlDays?: number | null;
}

export interface CreateMemoryMemoInput {
  workspaceId: string;
  agentId: string;
  kind: MemoKind;
  content: string;
  tags?: string[];
  confidence?: Confidence;
  sourceTaskId?: string | null;
  expiresInDays?: number | null;
}

export interface MemoryToolSearchInput {
  workspaceId: string;
  agentId: string;
  query: string;
  scopes?: MemoryScope[];
  board?: string;
  limit?: number;
}

const HUMAN: MemoryActor = { kind: "human", id: "local", name: "user" };

function error(code: "MEMORY_INVALID_INPUT" | "MEMORY_UNAVAILABLE", message: string): never {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  throw err;
}

function validText(value: string, min: number, max: number, label: string): string {
  const text = value.trim();
  if (text.length < min || text.length > max) error("MEMORY_INVALID_INPUT", `${label} must be ${min}-${max} chars`);
  return text;
}

/**
 * Runtime adapter between AppService/IPC/tools and the memory core. The core
 * schema is owned by src/memory and is not modified here.
 */
export class MemoryRuntime {
  private readonly core: MemoryStore | null;
  private readonly service: MemoryService | null;
  readonly unavailableReason: string | null;

  constructor(private readonly store: Store) {
    try {
      this.core = new MemoryStore(store);
      this.service = new MemoryService(this.core);
      this.unavailableReason = null;
    } catch (err) {
      this.core = null;
      this.service = null;
      this.unavailableReason = err instanceof Error ? err.message : String(err);
    }
  }

  get available(): boolean {
    return this.service !== null;
  }

  private require(): MemoryService {
    if (!this.service) error("MEMORY_UNAVAILABLE", this.unavailableReason ?? "memory unavailable");
    return this.service;
  }

  private validateWorkspace(workspaceId: string): void {
    if (!workspaceId || !this.store.getWorkspace(workspaceId)) {
      error("MEMORY_INVALID_INPUT", "workspace not found");
    }
  }

  private validateAgent(workspaceId: string, agentId: string): void {
    const agent = this.store.listAgents(workspaceId).find((item) => item.id === agentId);
    if (!agent) error("MEMORY_INVALID_INPUT", "agent does not belong to workspace");
  }

  snapshot(workspaceId: string, options: MemorySnapshotOptions = {}): MemorySnapshot {
    this.validateWorkspace(workspaceId);
    if (options.agentId) this.validateAgent(workspaceId, options.agentId);
    const limit = (value: number | undefined, fallback: number, max: number) =>
      Math.min(max, Math.max(1, Number.isFinite(value) ? Number(value) : fallback));
    return this.require().snapshot(HUMAN, workspaceId, {
      ...options,
      entriesLimit: limit(options.entriesLimit, 500, 500),
      memosLimit: limit(options.memosLimit, 200, 200),
      proposalsLimit: limit(options.proposalsLimit, 100, 100),
    });
  }

  search(input: MemorySearchInput): MemorySearchResult {
    this.validateWorkspace(input.workspaceId);
    if (input.agentId) this.validateAgent(input.workspaceId, input.agentId);
    const query = input.query?.trim() ?? "";
    if (query.length > 200) error("MEMORY_INVALID_INPUT", "query is too long");
    const scopes = (input.scopes ?? ["board", "memo", "summary"]).filter((scope) => scope !== "doc");
    return this.require().search(HUMAN, {
      ...input,
      query: query || undefined,
      scopes,
      limit: Math.min(50, Math.max(1, Number(input.limit) || 50)),
      budgetTokens: Math.min(4000, Math.max(100, Number(input.budgetTokens) || 2000)),
    });
  }

  postBoard(input: CreateMemoryBoardInput): MemoryResult<BoardEntry> {
    try {
      this.validateWorkspace(input.workspaceId);
      const content = validText(input.content, 1, 2000, "content");
      const board = validText(input.board, 1, 80, "board");
      const ttlDays = input.ttlDays == null ? null : Math.floor(Number(input.ttlDays));
      if (ttlDays !== null && (!Number.isFinite(ttlDays) || ttlDays < 1 || ttlDays > 365)) {
        error("MEMORY_INVALID_INPUT", "ttlDays must be 1-365");
      }
      return this.require().postBoard(HUMAN, {
        workspaceId: input.workspaceId,
        board,
        kind: input.kind,
        content,
        refs: (input.refs ?? []).filter(Boolean).slice(0, 20),
        confidence: input.confidence ?? "medium",
        ttlDays,
        pinned: false,
      });
    } catch (err) {
      if (err instanceof Error && (err as Error & { code?: string }).code === "MEMORY_INVALID_INPUT") {
        return { ok: false, error: { code: "MEMORY_INVALID_INPUT", message: err.message } };
      }
      throw err;
    }
  }

  pin(workspaceId: string, entryId: string, pinned: boolean): MemoryResult<BoardEntry> {
    this.validateWorkspace(workspaceId);
    return this.require().setBoardPinned(HUMAN, workspaceId, entryId, pinned);
  }

  verifyBoard(workspaceId: string, entryId: string, confidence?: Confidence): MemoryResult<BoardEntry> {
    this.validateWorkspace(workspaceId);
    return this.require().verifyBoardEntry(HUMAN, workspaceId, entryId, confidence);
  }

  setTtl(workspaceId: string, entryId: string, ttlDays: number | null): MemoryResult<BoardEntry> {
    this.validateWorkspace(workspaceId);
    if (ttlDays !== null && (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 365)) {
      error("MEMORY_INVALID_INPUT", "ttlDays must be 1-365 or null");
    }
    return this.require().setBoardTtl(HUMAN, workspaceId, entryId, ttlDays);
  }

  /** P1 archive restore; additive data update, core schema is untouched. */
  restoreBoardEntry(workspaceId: string, entryId: string): MemoryResult<BoardEntry> {
    this.validateWorkspace(workspaceId);
    const core = this.core;
    if (!core) error("MEMORY_UNAVAILABLE", this.unavailableReason ?? "memory unavailable");
    const entry = core.getBoard(workspaceId, entryId);
    if (!entry) return { ok: false, error: { code: "MEMORY_NOT_FOUND", message: "entry not found" } };
    if (entry.status !== "archived") {
      return { ok: false, error: { code: "MEMORY_CONFLICT", message: "entry is not archived" } };
    }
    const now = new Date().toISOString();
    core.db
      .prepare(
        `UPDATE board_entries
         SET status = 'active', archived_at = NULL, archived_by = NULL, archive_reason = NULL, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND status = 'archived'`,
      )
      .run(now, workspaceId, entryId);
    core.rebuildIndex();
    const restored = core.getBoard(workspaceId, entryId);
    if (!restored) return { ok: false, error: { code: "MEMORY_NOT_FOUND", message: "entry not found after restore" } };
    try {
      this.store.appendEvent({
        aggregateType: "board",
        aggregateId: restored.id,
        type: "board.restored",
        actor: "user",
        payload: { entryId: restored.id, board: restored.board, kind: restored.kind },
      });
    } catch {
      // audit is best effort
    }
    return { ok: true, value: restored };
  }

  proposeArchive(
    workspaceId: string,
    entryId: string,
    reason: "manual" | "stale" = "manual",
    note?: string,
  ): MemoryResult<BoardArchiveProposal> {
    this.validateWorkspace(workspaceId);
    return this.require().proposeBoardArchive(HUMAN, workspaceId, entryId, reason, note);
  }

  decideArchive(
    workspaceId: string,
    proposalId: string,
    decision: "approve" | "reject",
    note?: string,
  ): MemoryResult<BoardArchiveProposal> {
    this.validateWorkspace(workspaceId);
    return this.require().decideBoardArchive(HUMAN, workspaceId, proposalId, decision, note);
  }

  promoteBoard(
    workspaceId: string,
    entryId: string,
    kind: "decision" | "fact" = "decision",
  ): MemoryResult<BoardEntry> {
    this.validateWorkspace(workspaceId);
    return this.require().promoteBoardEntry(HUMAN, workspaceId, entryId, kind);
  }

  createMemo(input: CreateMemoryMemoInput): MemoryResult<Memo> {
    this.validateWorkspace(input.workspaceId);
    this.validateAgent(input.workspaceId, input.agentId);
    const content = validText(input.content, 1, 2000, "content");
    const expiresInDays = input.expiresInDays == null ? null : Math.floor(Number(input.expiresInDays));
    if (expiresInDays !== null && (!Number.isFinite(expiresInDays) || expiresInDays < 1 || expiresInDays > 365)) {
      error("MEMORY_INVALID_INPUT", "expiresInDays must be 1-365");
    }
    return this.require().createMemo(HUMAN, {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      kind: input.kind,
      content,
      tags: (input.tags ?? []).filter(Boolean).slice(0, 10),
      confidence: input.confidence ?? "medium",
      sourceTaskId: input.sourceTaskId ?? null,
      expiresInDays,
    });
  }

  listMemos(workspaceId: string, agentId: string): Memo[] {
    this.validateWorkspace(workspaceId);
    this.validateAgent(workspaceId, agentId);
    return this.require().listMemos(HUMAN, workspaceId, agentId, { includeArchived: true, limit: 200 });
  }

  verifyMemo(workspaceId: string, agentId: string, memoId: string): MemoryResult<Memo> {
    this.validateWorkspace(workspaceId);
    this.validateAgent(workspaceId, agentId);
    return this.require().verifyMemo(HUMAN, workspaceId, agentId, memoId);
  }

  archiveMemo(workspaceId: string, agentId: string, memoId: string): MemoryResult<Memo> {
    this.validateWorkspace(workspaceId);
    this.validateAgent(workspaceId, agentId);
    return this.require().archiveMemo(HUMAN, workspaceId, agentId, memoId);
  }

  promoteMemo(workspaceId: string, agentId: string, memoId: string, board: string): MemoryResult<BoardEntry> {
    this.validateWorkspace(workspaceId);
    this.validateAgent(workspaceId, agentId);
    return this.require().promoteMemo(HUMAN, workspaceId, agentId, memoId, validText(board, 1, 80, "board"));
  }

  maintenance(workspaceId?: string): MemoryResult<unknown> {
    if (workspaceId) this.validateWorkspace(workspaceId);
    return this.require().sweep(HUMAN, workspaceId);
  }

  buildContext(input: {
    workspaceId: string;
    agentId?: string | null;
    taskId?: string | null;
    runId?: string | null;
    maxTokens?: number;
    contextWindow?: number;
  }): MemoryContext {
    this.validateWorkspace(input.workspaceId);
    if (input.agentId) this.validateAgent(input.workspaceId, input.agentId);
    const task = input.taskId ? this.store.getTask(input.taskId) : null;
    return this.require().buildContext({
      workspaceId: input.workspaceId,
      actor: input.agentId ? { kind: "agent", id: input.agentId, name: input.agentId } : HUMAN,
      mode: input.agentId ? "worker" : "router",
      taskId: input.taskId ?? null,
      taskTitle: task?.title ?? null,
      taskStatus: task?.status ?? null,
      dependencies: task?.dependsOn ?? [],
      budgetTokens: input.maxTokens,
      contextWindow: input.contextWindow,
    });
  }

  // ------------------------------------------------------------ agent tools
  searchForAgent(input: MemoryToolSearchInput): MemorySearchResult {
    this.validateWorkspace(input.workspaceId);
    this.validateAgent(input.workspaceId, input.agentId);
    const result = this.require().search(
      { kind: "agent", id: input.agentId, name: input.agentId },
      {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        query: input.query,
        scopes: input.scopes,
        board: input.board,
        limit: Math.min(50, Math.max(1, input.limit ?? 10)),
        includeArchived: false,
      },
    );
    return result;
  }

  postBoardForAgent(input: {
    workspaceId: string;
    agentId: string;
    agentName: string;
    board: string;
    kind: BoardKind;
    content: string;
    refs?: string[];
    confidence?: Confidence;
    ttlDays?: number | null;
  }): BoardEntry {
    this.validateWorkspace(input.workspaceId);
    this.validateAgent(input.workspaceId, input.agentId);
    const result = this.require().postBoard(
      { kind: "agent", id: input.agentId, name: input.agentName },
      {
        workspaceId: input.workspaceId,
        board: input.board,
        kind: input.kind,
        content: input.content,
        refs: input.refs,
        confidence: input.confidence,
        ttlDays: input.ttlDays,
      },
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  listBoardForAgent(input: {
    workspaceId: string;
    board?: string;
    status?: "active" | "archived";
    stale?: boolean;
    limit?: number;
  }): BoardEntry[] {
    this.validateWorkspace(input.workspaceId);
    return this.require().listBoard(HUMAN, {
      workspaceId: input.workspaceId,
      board: input.board,
      status: input.status,
      stale: input.stale,
      limit: input.limit,
    });
  }

  addMemoForAgent(input: {
    workspaceId: string;
    agentId: string;
    kind: MemoKind;
    content: string;
    tags?: string[];
    sourceTaskId?: string | null;
    expiresInDays?: number | null;
  }): Memo {
    this.validateWorkspace(input.workspaceId);
    this.validateAgent(input.workspaceId, input.agentId);
    const result = this.require().createMemo(
      { kind: "agent", id: input.agentId, name: input.agentId },
      {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        kind: input.kind,
        content: input.content,
        tags: input.tags,
        sourceTaskId: input.sourceTaskId,
        expiresInDays: input.expiresInDays,
      },
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  searchMemosForAgent(input: {
    workspaceId: string;
    agentId: string;
    query: string;
    limit?: number;
  }): Memo[] {
    this.validateWorkspace(input.workspaceId);
    this.validateAgent(input.workspaceId, input.agentId);
    return this.require().listMemos(
      { kind: "agent", id: input.agentId, name: input.agentId },
      input.workspaceId,
      input.agentId,
      { limit: Math.min(50, Math.max(1, input.limit ?? 10)) },
    );
  }
}
