import type { BoardKind, TaskSummary as SharedTaskSummary } from "../shared/types.js";

/** Memory-core clock. Production uses SystemClock; tests use FixedClock. */
export interface Clock {
  now(): string;
}

export type MemoryActor =
  | { kind: "human"; id?: string; name?: string }
  | { kind: "agent"; id: string; name: string };

export type BoardStatus = "active" | "archived";
export type ArchiveReason = "ttl_expired" | "manual" | "stale";
export type ArchiveProposalStatus = "pending" | "approved" | "rejected" | "superseded" | "expired";
export type MemorySourceKind = "user" | "agent" | "task" | "run" | "doc" | "system";
export type Confidence = "low" | "medium" | "high";
export type MemoryEntityType = "board" | "memo" | "summary";
export type MemoryScope = MemoryEntityType | "doc";

export interface BoardEntry {
  id: string;
  workspaceId: string;
  board: string;
  author: string;
  kind: BoardKind;
  content: string;
  refs: string[];
  confidence: Confidence;
  pinned: boolean;
  source: MemorySourceKind;
  sourceRef: string | null;
  ttlAt: string | null;
  lastVerifiedAt: string | null;
  verifiedBy: string | null;
  /** Only board entries have evidenceAt (design R6). */
  evidenceAt: string | null;
  status: BoardStatus;
  archivedAt: string | null;
  archivedBy: string | null;
  archiveReason: string | null;
  promotedToId: string | null;
  stale: boolean;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
}

export interface BoardEntrySnapshot {
  board: string;
  kind: BoardKind;
  confidence: Confidence;
  ttlAt: string | null;
  lastVerifiedAt: string | null;
  verifiedBy: string | null;
  pinned: boolean;
  status: BoardStatus;
  contentHash: string;
  /** Bounded preview; the full body is never copied into the proposal. */
  contentPreview: string;
}

export interface BoardDomain {
  id: string;
  workspaceId: string;
  name: string;
  nameKey: string;
  description: string;
  defaultTtlDays: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface BoardArchiveProposal {
  id: string;
  workspaceId: string;
  entryId: string;
  board: string;
  reason: ArchiveReason;
  status: ArchiveProposalStatus;
  entrySnapshot: BoardEntrySnapshot | null;
  proposedBy: string;
  proposedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
}

export type MemoKind = "lesson" | "failure" | "shortcut" | "preference";

export interface Memo {
  id: string;
  workspaceId: string;
  agentId: string;
  kind: MemoKind;
  content: string;
  tags: string[];
  confidence: Confidence;
  source: MemorySourceKind;
  sourceRef: string | null;
  sourceTaskId: string | null;
  sourceRunId: string | null;
  expiresAt: string | null;
  status: "active" | "expired" | "archived";
  stale: boolean;
  lastVerifiedAt: string | null;
  verifiedBy: string | null;
  promotedToBoardId: string | null;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
}

export interface TaskSummary extends SharedTaskSummary {
  workspaceId: string;
  attempt: number;
  outcome: "completed" | "failed" | "cancelled";
  nextSteps: string[];
  evidenceRefs: string[];
  agentName: string | null;
  model: string | null;
  tokenIn: number;
  tokenOut: number;
  durationMs: number;
  contentHash: string;
  embedding?: Uint8Array | null;
}

export interface MemoryScoreBreakdown {
  relevance: number;
  rawRank: number | null;
  normalization: "minmax" | "like" | "browse";
  confidence: number;
  freshness: number;
  typeWeight: number;
  pinBoost: number;
  verifiedBoost: number;
  evidenceBoost: number;
  penalty: number;
  score: number;
}

export interface MemoryHit {
  id: string;
  entityType: MemoryEntityType;
  entityId: string;
  workspaceId: string;
  board: string | null;
  agentId: string | null;
  title: string;
  snippet: string;
  content: string;
  contentHash: string;
  citations: string[];
  source: MemorySourceKind;
  confidence: Confidence;
  pinned: boolean;
  verified: boolean;
  stale: boolean;
  expired: boolean;
  createdAt: string;
  lastVerifiedAt: string | null;
  score: number;
  breakdown: MemoryScoreBreakdown;
}

export interface MemoryBudget {
  maxTokens: number;
  usedTokens: number;
  truncated: boolean;
  omitted: number;
  perLayer: Record<"working" | "episodic" | "semantic", number>;
}

export interface MemorySearchInput {
  workspaceId: string;
  /** Required for memo visibility. When absent, memo scope returns no rows. */
  agentId?: string | null;
  query?: string;
  scopes?: MemoryScope[];
  board?: string;
  limit?: number;
  budgetTokens?: number;
  includeArchived?: boolean;
  includeExpired?: boolean;
}

export interface MemorySearchResult {
  hits: MemoryHit[];
  total: number;
  budget: MemoryBudget;
  generatedAt: string;
}

export interface MemorySnapshotOptions {
  agentId?: string | null;
  board?: string;
  includeArchived?: boolean;
  entriesLimit?: number;
  memosLimit?: number;
  proposalsLimit?: number;
}

export interface MemoryCounts {
  boardActive: number;
  boardArchived: number;
  boardStale: number;
  boardExpired: number;
  memosActive: number;
  memosStale: number;
  memosExpired: number;
  summaries: number;
  proposalsPending: number;
}

export interface MemorySnapshot {
  workspaceId: string;
  entries: BoardEntry[];
  domains: BoardDomain[];
  memos: Memo[];
  proposals: BoardArchiveProposal[];
  /** Recent task summaries; P1 document scope is intentionally absent. */
  summaries: TaskSummary[];
  counts: MemoryCounts;
  ftsAvailable: boolean;
  degradedReason: string | null;
  generatedAt: string;
}

export interface MemoryContextSection {
  layer: "working" | "episodic" | "semantic";
  title: string;
  citations: string[];
  lines: string[];
}

export interface MemoryContext {
  text: string;
  sections: MemoryContextSection[];
  hits: MemoryHit[];
  usedTokens: number;
  maxTokens: number;
  truncated: boolean;
  omitted: number;
}

export interface MemoryMaintenanceResult {
  workspaceIds: string[];
  staleMarked: number;
  ttlProposed: number;
  cooldownSkipped: number;
  memosExpired: number;
  proposalsExpired: number;
  indexRepaired: boolean;
  durationMs: number;
}

export interface MemoryConfig {
  staleAfterDays: number;
  archiveProposalTtlDays: number;
  rejectCooldownDays: number;
  maintenanceIntervalMin: number;
  maxContextTokens: number;
  routerMaxTokens: number;
  workingMaxTokens: number;
  episodicMaxTokens: number;
  semanticMaxTokens: number;
  candidateLimit: number;
  searchLimit: number;
  repoDocsEnabled: false;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  staleAfterDays: 30,
  archiveProposalTtlDays: 30,
  rejectCooldownDays: 7,
  maintenanceIntervalMin: 60,
  maxContextTokens: 2000,
  routerMaxTokens: 1200,
  workingMaxTokens: 600,
  episodicMaxTokens: 700,
  semanticMaxTokens: 900,
  candidateLimit: 200,
  searchLimit: 50,
  repoDocsEnabled: false,
};

export type MemoryErrorCode =
  | "MEMORY_INVALID_INPUT"
  | "MEMORY_NOT_FOUND"
  | "MEMORY_CONFLICT"
  | "MEMORY_PINNED"
  | "MEMORY_FORBIDDEN"
  | "MEMORY_PRIVATE_SCOPE"
  | "MEMORY_PROPOSAL_CLOSED"
  | "MEMORY_UNAVAILABLE";

export interface MemoryErrorInfo {
  code: MemoryErrorCode;
  message: string;
}

export type MemoryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MemoryErrorInfo };

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;

  constructor(code: MemoryErrorCode, message: string) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
  }
}

export interface MemoryStoreOptions {
  clock?: Clock;
  config?: Partial<MemoryConfig>;
  /** Test-only switch to exercise the LIKE fallback. */
  ftsEnabled?: boolean;
  /** Test-only fault injected after the first migration DDL, to prove rollback. */
  migrationFault?: "after-ddl" | null;
}

export const DAY_MS = 86_400_000;

export function isHuman(actor: MemoryActor): boolean {
  return actor.kind === "human";
}

export function actorLabel(actor: MemoryActor): string {
  return actor.kind === "human" ? "user" : `agent:${actor.name || actor.id}`;
}
