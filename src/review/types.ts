import type { BoardKind } from "../shared/types.js";

export type ReviewMode = "required" | "advisory" | "off";
export type ReviewSeverity = "nit" | "suggestion" | "issue" | "blocker";
export type ReviewThreadStatus = "open" | "resolved" | "outdated";
export type ReviewDecision = "approve" | "request_changes" | "comment";
export type ReviewTargetStatus =
  | "pending"
  | "approved"
  | "changes_requested"
  | "stale"
  | "unavailable";

export interface ReviewConfig {
  workspaceId: string;
  mode: ReviewMode;
  requiredApprovals: number;
  notifyMailbox: boolean;
  boardSummary: boolean;
  updatedAt: string;
}

export interface ReviewReviewer {
  id: string;
  targetId: string;
  reviewerId: string;
  reviewerKind: "human" | "agent";
  role: "reviewer" | "merge_captain" | "advisory";
  status: "requested" | "approved" | "changes_requested" | "removed";
  assignedBy: string;
  requestedAt: string;
  decidedAt: string | null;
  removedAt: string | null;
  removedReason: string | null;
}

export interface ReviewFile {
  targetId: string;
  fileIndex: number;
  path: string;
  oldPath: string | null;
  changeType: string;
  isBinary: boolean;
  isLfs: boolean;
  additions: number;
  deletions: number;
  lineCount: number;
  truncated: boolean;
}

export interface ReviewLine {
  kind: "context" | "add" | "del";
  oldLine: number | null;
  newLine: number | null;
  text: string;
  hunk: number;
}

export interface ReviewDiffPage {
  targetId: string;
  file: ReviewFile;
  lines: ReviewLine[];
  offset: number;
  total: number;
  hasMore: boolean;
}

export interface ReviewComment {
  id: string;
  threadId: string;
  authorId: string;
  authorKind: "human" | "agent";
  body: string;
  bodyHash: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
}

export interface ReviewThread {
  id: string;
  targetId: string;
  filePath: string;
  oldPath: string | null;
  side: "new" | "old";
  lineStart: number;
  lineEnd: number;
  severity: ReviewSeverity;
  status: ReviewThreadStatus;
  anchorHeadSha: string;
  contextBefore: string[];
  contextAfter: string[];
  createdBy: string;
  createdAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  outdatedReason: string | null;
  comments: ReviewComment[];
}

export interface ReviewDecisionRecord {
  id: string;
  targetId: string;
  reviewerId: string;
  decision: ReviewDecision;
  headSha: string;
  revision: number;
  isCurrent: boolean;
  supersedesId: string | null;
  invalidatedReason: string | null;
  notes: string | null;
  createdAt: string;
}

export interface ReviewTarget {
  id: string;
  workspaceId: string;
  taskId: string;
  authorAgentId: string | null;
  requesterId: string;
  requesterKind: "human" | "agent";
  provider: string;
  prNumber: number | null;
  prUrl: string | null;
  baseBranch: string;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  diffHash: string;
  status: ReviewTargetStatus;
  requiredApprovals: number;
  approvalCount: number;
  blockerCount: number;
  staleReason: string | null;
  createdAt: string;
  updatedAt: string;
  reviewers: ReviewReviewer[];
}

export type ReviewGateErrorCode =
  | "REVIEW_UNAVAILABLE"
  | "REVIEW_TARGET_MISSING"
  | "REVIEW_UNASSIGNED"
  | "REVIEW_PENDING"
  | "REVIEW_BLOCKED"
  | "REVIEW_CHANGES_REQUESTED"
  | "REVIEW_STALE"
  | "REVIEW_FORBIDDEN"
  | "REVIEW_LIMIT"
  | "REVIEW_NOT_FOUND"
  | "REVIEW_CONFIG_CONFIRM_REQUIRED";

export type ReviewGateResult =
  | { ok: true; mode: ReviewMode; targetId: string | null; warnings?: string[] }
  | {
      ok: false;
      mode: ReviewMode;
      targetId: string | null;
      code: ReviewGateErrorCode;
      reason: string;
      blockers: number;
      approvals: number;
      requiredApprovals: number;
    };

export interface ReviewSummary {
  target: ReviewTarget;
  mode: ReviewMode;
  files: ReviewFile[];
  decisions: ReviewDecisionRecord[];
  gate: ReviewGateResult;
}

export class ReviewError extends Error {
  constructor(
    readonly code: ReviewGateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

export interface ReviewConfigPatch {
  mode?: ReviewMode;
  notifyMailbox?: boolean;
  boardSummary?: boolean;
}

export interface ReviewMail {
  workspaceId: string;
  from: string;
  to: string[];
  subject: string;
  body: string;
  kind: "review";
}

export interface ReviewBoardPost {
  workspaceId: string;
  board: string;
  author: string;
  kind: BoardKind;
  content: string;
  confidence: "low" | "medium" | "high";
}
