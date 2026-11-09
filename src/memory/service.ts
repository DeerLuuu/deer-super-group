import type {
  ArchiveReason,
  BoardArchiveProposal,
  BoardEntry,
  Confidence,
  MemoryActor,
  MemoryContext,
  MemorySearchInput,
  MemorySearchResult,
  MemorySnapshot,
  MemorySnapshotOptions,
  MemoryResult,
  Memo,
  MemoKind,
  TaskSummary,
} from "./types.js";
import { MemoryError } from "./types.js";
import type { MemoryStore } from "./store.js";
import { MemoryContextBuilder, type MemoryContextInput } from "./context.js";

export interface CreateBoardInput {
  workspaceId: string;
  board: string;
  kind: BoardEntry["kind"];
  content: string;
  refs?: string[];
  confidence?: Confidence;
  ttlDays?: number | null;
  pinned?: boolean;
}

export interface BoardListInput {
  workspaceId: string;
  board?: string;
  status?: BoardEntry["status"];
  stale?: boolean;
  includeArchived?: boolean;
  limit?: number;
}

export interface CreateMemoInput {
  workspaceId: string;
  agentId: string;
  kind: MemoKind;
  content: string;
  tags?: string[];
  confidence?: Confidence;
  sourceTaskId?: string | null;
  sourceRunId?: string | null;
  expiresInDays?: number | null;
}

export interface SummaryInput {
  taskId: string;
  runId: string;
  workspaceId: string;
  goal: string;
  changes?: string[];
  files?: string[];
  tests?: TaskSummary["tests"];
  decisions?: string[];
  risks?: string[];
  openQuestions?: string[];
  nextSteps?: string[];
  evidenceRefs?: string[];
  attempt?: number;
  outcome?: TaskSummary["outcome"];
  agentName?: string | null;
  model?: string | null;
  tokenIn?: number;
  tokenOut?: number;
  durationMs?: number;
}

/**
 * Service boundary for t99. All governance methods are human-only; the agent
 * surface exposed here (board write/search, own memo write/search) contains no
 * pin/verify/archive/decide/promote path. IPC/tools/UI are intentionally a
 * later integration task.
 */
export class MemoryService {
  private readonly contextBuilder: MemoryContextBuilder;

  constructor(private readonly store: MemoryStore) {
    this.contextBuilder = new MemoryContextBuilder(store);
  }

  postBoard(actor: MemoryActor, input: CreateBoardInput): MemoryResult<BoardEntry> {
    return this.run(() =>
      this.store.createBoard({
        ...input,
        author: this.authorOf(actor),
        source: actor.kind === "human" ? "user" : "agent",
        sourceRef: actor.id ?? null,
        pinned: actor.kind === "human" ? input.pinned === true : false,
      }),
    );
  }

  listBoard(actor: MemoryActor, input: BoardListInput): BoardEntry[] {
    return this.store.listBoard(input.workspaceId, {
      board: input.board,
      status: input.status,
      stale: input.stale,
      includeArchived: actor.kind === "human" ? input.includeArchived : false,
      limit: input.limit,
    });
  }

  setBoardPinned(actor: MemoryActor, workspaceId: string, entryId: string, pinned: boolean): MemoryResult<BoardEntry> {
    return this.humanMutation(actor, workspaceId, "board.pin", () =>
      this.store.setBoardPinned(workspaceId, entryId, pinned, this.authorOf(actor)),
    );
  }

  verifyBoardEntry(
    actor: MemoryActor,
    workspaceId: string,
    entryId: string,
    confidence?: Confidence,
  ): MemoryResult<BoardEntry> {
    return this.humanMutation(actor, workspaceId, "board.verify", () =>
      this.store.verifyBoard(workspaceId, entryId, this.authorOf(actor), confidence),
    );
  }

  setBoardTtl(actor: MemoryActor, workspaceId: string, entryId: string, ttlDays: number | null): MemoryResult<BoardEntry> {
    return this.humanMutation(actor, workspaceId, "board.ttl", () =>
      this.store.setBoardTtl(workspaceId, entryId, ttlDays, this.authorOf(actor)),
    );
  }

  proposeBoardArchive(
    actor: MemoryActor,
    workspaceId: string,
    entryId: string,
    reason: ArchiveReason = "manual",
    note?: string,
  ): MemoryResult<BoardArchiveProposal> {
    return this.humanMutation(actor, workspaceId, "board.archive_propose", () =>
      this.store.proposeArchive({
        workspaceId,
        entryId,
        reason: reason === "ttl_expired" ? "manual" : reason,
        proposedBy: this.authorOf(actor),
        note: note ?? null,
      }),
    );
  }

  decideBoardArchive(
    actor: MemoryActor,
    workspaceId: string,
    proposalId: string,
    decision: "approve" | "reject",
    note?: string,
  ): MemoryResult<BoardArchiveProposal> {
    return this.humanMutation(actor, workspaceId, "board.archive_decide", () =>
      this.store.decideArchive({ workspaceId, proposalId, decision, actor: this.authorOf(actor), note: note ?? null }),
    );
  }

  promoteBoardEntry(
    actor: MemoryActor,
    workspaceId: string,
    entryId: string,
    kind: "decision" | "fact" = "decision",
  ): MemoryResult<BoardEntry> {
    return this.humanMutation(actor, workspaceId, "board.promote", () =>
      this.store.promoteBoard(workspaceId, entryId, this.authorOf(actor), kind),
    );
  }

  createMemo(actor: MemoryActor, input: CreateMemoInput): MemoryResult<Memo> {
    return this.run(() => {
      if (actor.kind === "agent" && input.agentId !== actor.id) {
        this.store.auditRejected(this.authorOf(actor), input.workspaceId, "memo.write");
        throw new MemoryError("MEMORY_PRIVATE_SCOPE", "agent can only write its own memo");
      }
      return this.store.createMemo({
        ...input,
        source: actor.kind === "human" ? "user" : "agent",
        sourceRef: actor.id ?? null,
      });
    });
  }

  listMemos(actor: MemoryActor, workspaceId: string, agentId: string, options: { includeArchived?: boolean; limit?: number } = {}): Memo[] {
    if (actor.kind === "agent" && actor.id !== agentId) return [];
    return this.store.listMemos(workspaceId, agentId, {
      includeArchived: actor.kind === "human" ? options.includeArchived : false,
      limit: options.limit,
    });
  }

  verifyMemo(actor: MemoryActor, workspaceId: string, agentId: string, memoId: string): MemoryResult<Memo> {
    return this.humanMutation(actor, workspaceId, "memo.verify", () =>
      this.store.verifyMemo(workspaceId, agentId, memoId, this.authorOf(actor)),
    );
  }

  archiveMemo(actor: MemoryActor, workspaceId: string, agentId: string, memoId: string): MemoryResult<Memo> {
    return this.humanMutation(actor, workspaceId, "memo.archive", () =>
      this.store.archiveMemo(workspaceId, agentId, memoId, this.authorOf(actor)),
    );
  }

  promoteMemo(actor: MemoryActor, workspaceId: string, agentId: string, memoId: string, board: string): MemoryResult<BoardEntry> {
    return this.humanMutation(actor, workspaceId, "memo.promote", () =>
      this.store.promoteMemo(workspaceId, agentId, memoId, this.authorOf(actor), board),
    );
  }

  search(actor: MemoryActor, input: MemorySearchInput): MemorySearchResult {
    return this.store.search({
      ...input,
      agentId: actor.kind === "agent" ? actor.id : input.agentId ?? null,
      includeArchived: actor.kind === "human" ? input.includeArchived : false,
      scopes: (input.scopes ?? ["board", "memo", "summary"]).filter((scope) => scope !== "doc"),
    });
  }

  snapshot(actor: MemoryActor, workspaceId: string, options: MemorySnapshotOptions = {}): MemorySnapshot {
    const agentId = actor.kind === "agent" ? actor.id : options.agentId ?? null;
    const snapshot = this.store.snapshot(workspaceId, {
      ...options,
      agentId,
      includeArchived: actor.kind === "human" ? options.includeArchived : false,
    });
    if (actor.kind === "agent") {
      return { ...snapshot, proposals: [], counts: { ...snapshot.counts, proposalsPending: 0 } };
    }
    return snapshot;
  }

  buildContext(input: MemoryContextInput): MemoryContext {
    return this.contextBuilder.build(input);
  }

  /** Human-initiated maintenance; the system scheduler will call store.sweep directly. */
  sweep(actor: MemoryActor, workspaceId?: string): MemoryResult<ReturnType<MemoryStore["sweep"]>> {
    return this.humanMutation(actor, workspaceId ?? "memory", "memory.sweep", () => this.store.sweep(workspaceId));
  }

  /** Run-completion hook for later service integration; only board evidenceAt changes. */
  onRunCompleted(actor: MemoryActor, taskId: string, runId: string, workspaceId?: string): MemoryResult<number> {
    return this.run(() => this.store.onRunCompleted(taskId, runId, workspaceId));
  }

  saveSummary(actor: MemoryActor, input: SummaryInput): MemoryResult<TaskSummary> {
    return this.run(() => {
      if (actor.kind === "agent" && !input.taskId) throw new MemoryError("MEMORY_INVALID_INPUT", "taskId required");
      return this.store.saveSummary(input);
    });
  }

  private authorOf(actor: MemoryActor): string {
    return actor.kind === "human" ? actor.name ?? "user" : `agent:${actor.name || actor.id}`;
  }

  private humanMutation<T>(actor: MemoryActor, workspaceId: string, operation: string, fn: () => T): MemoryResult<T> {
    if (actor.kind !== "human") {
      this.store.auditRejected(this.authorOf(actor), workspaceId, operation);
      return { ok: false, error: { code: "MEMORY_FORBIDDEN", message: `${operation} is human-only` } };
    }
    return this.run(fn);
  }

  private run<T>(fn: () => T): MemoryResult<T> {
    try {
      return { ok: true, value: fn() };
    } catch (error) {
      if (error instanceof MemoryError) return { ok: false, error: { code: error.code, message: error.message } };
      throw error;
    }
  }
}
