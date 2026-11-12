import type { RunStatus, TaskStatus } from "../shared/types.js";

export type GitErrorCode =
  | "GIT_NOT_FOUND"
  | "GIT_REPO_NOT_FOUND"
  | "GIT_NOT_ROOT"
  | "GIT_VERSION_LOW"
  | "GIT_CAPACITY"
  | "GIT_WORKTREE_FAILED"
  | "GIT_WORKTREE_NOT_CLEAN"
  | "GIT_WORKTREE_BUSY"
  | "GIT_BRANCH_INVALID"
  | "GIT_BRANCH_EXISTS"
  | "GIT_COMMIT_BLOCKED"
  | "GIT_PUSH_REJECTED"
  | "GIT_PUSH_NETWORK"
  | "GIT_TIMEOUT"
  | "GIT_FORBIDDEN"
  | "GIT_PATH_ESCAPE"
  | "SECRET_BLOCKED"
  | "AUTH_MISSING"
  | "AUTH_FORBIDDEN"
  | "AUTH_PUSH"
  | "PR_NOT_FOUND"
  | "PR_CREATE_FAILED"
  | "PR_RATE_LIMITED"
  | "PR_UNKNOWN_STATE"
  | "PR_METHOD_UNSUPPORTED"
  | "CHECKS_FAILED"
  | "CHECKS_TIMEOUT"
  | "CHECKS_SPAWN"
  | "MERGE_CONFLICT"
  | "MERGE_REVIEW_REQUIRED"
  | "MERGE_APPROVAL_STALE"
  | "MERGE_UNKNOWN_STATE"
  | "MERGE_LOCKED"
  | "MERGE_CANCELLED"
  | "MERGE_LIMIT"
  | "GIT_READ_NOT_REPO"
  | "GIT_READ_NOT_ROOT"
  | "GIT_READ_NO_COMMITS"
  | "GIT_READ_BAD_PARAM"
  | "GIT_READ_BAD_REF"
  | "GIT_READ_BAD_PATH"
  | "GIT_REF_NOT_FOUND"
  | "GIT_READ_TIMEOUT"
  | "GIT_READ_TOO_LARGE"
  | "GIT_READ_DIFF_BINARY"
  | "GIT_READ_DIFF_SUBMODULE"
  | "GIT_READ_DEGRADED"
  | "GIT_INIT_ALREADY_REPO"
  | "GIT_INIT_NESTED_REPO"
  | "GIT_INIT_GIT_MISSING"
  | "GIT_INIT_VERSION_LOW"
  | "GIT_INIT_NOT_WRITABLE"
  | "GIT_INIT_NOT_FOUND"
  | "GIT_INIT_UNSUPPORTED"
  | "GIT_INIT_CHECK_FAILED"
  | "GIT_INIT_TIMEOUT"
  | "GIT_INIT_PARTIAL"
  | "GIT_INIT_WORKSPACE_MISSING"
  | "GIT_INIT_FAILED"
  | "GIT_READ_INTERNAL";

export interface GitResult<T> {
  ok: boolean;
  value?: T;
  errorCode?: GitErrorCode;
  message?: string;
  retryable?: boolean;
}

export type GitMode = "git" | "degraded" | "local" | "off";

export interface RepoInfo {
  ok: boolean;
  workspacePath: string;
  root: string | null;
  runtimeRoot: string | null;
  baseBranch: string;
  remote: string | null;
  remoteKind: "remote" | "none";
  gitVersion: string | null;
  errorCode?: GitErrorCode;
  reason?: string;
}

export interface GitSettings {
  workspaceId: string;
  mode: "auto" | "off" | "github" | "manual" | "local";
  baseBranch: string;
  remote: string | null;
  provider: "auto" | "github" | "manual" | "local";
  apiHost: string;
  autoCreatePr: boolean;
  autoPushWip: boolean;
  pushOnCancel: boolean;
  preserveWorktreeOnCancel: boolean;
  exportCancelPatch: boolean;
  requireApproval: boolean;
  checksMode: "shell" | "argv";
  checksCommand: string | null;
  checksTimeoutMs: number;
  requiredChecks: string[];
  mergeMethod: "squash" | "merge" | "rebase";
  autoMerge: boolean;
  allowSkipBlocked: boolean;
  maxWorktrees: number;
  mergeCaptain: string;
}

export const DEFAULT_GIT_SETTINGS: Omit<GitSettings, "workspaceId"> = {
  mode: "auto",
  baseBranch: "main",
  remote: "origin",
  provider: "auto",
  apiHost: "github.com",
  autoCreatePr: true,
  autoPushWip: true,
  pushOnCancel: false,
  preserveWorktreeOnCancel: false,
  exportCancelPatch: false,
  requireApproval: true,
  checksMode: "shell",
  checksCommand: null,
  checksTimeoutMs: 1_800_000,
  requiredChecks: [],
  mergeMethod: "squash",
  autoMerge: true,
  allowSkipBlocked: false,
  maxWorktrees: 3,
  mergeCaptain: "human",
};

export interface TaskVcs {
  taskId: string;
  workspaceId: string;
  mode: GitMode;
  branch: string | null;
  baseBranch: string | null;
  headSha: string | null;
  pr: {
    provider: string;
    number: number | null;
    url: string | null;
    state: string;
    checks: string;
    review: string;
  } | null;
  merge: { state: string; commitSha: string | null; approvedHeadSha?: string | null };
  checksState?: "none" | "pending" | "passed" | "failed" | "waived";
  conflictTaskId: string | null;
  targetTaskId?: string | null;
  targetBranch?: string | null;
  scopePaths?: string[];
  degradedReason?: string | null;
  errorCode: string | null;
  updatedAt: string;
}

export interface WorktreeRecord {
  id: string;
  workspaceId: string;
  taskId: string;
  branchTaskId: string | null;
  runId: string | null;
  path: string;
  branch: string;
  state:
    | "reserving"
    | "creating"
    | "ready"
    | "active"
    | "finalizing"
    | "removed"
    | "orphaned";
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrInfo {
  provider: "github" | "manual" | "local";
  number: number | null;
  url: string | null;
  state: "draft" | "open" | "closed" | "merged" | "unknown" | "manual_pending" | "local";
  headSha: string;
  baseBranch: string;
  mergeable: "mergeable" | "conflicting" | "unknown";
  checks: Array<{
    name: string;
    status: "queued" | "in_progress" | "passed" | "failed" | "skipped" | "neutral";
    url?: string;
  }>;
  review: "approved" | "changes_requested" | "pending" | "none";
  mergedCommitSha: string | null;
  updatedAt: string;
}

export interface PrProvider {
  readonly id: "github" | "manual" | "local";
  detect(repo: RepoInfo): Promise<boolean>;
  createPr(input: {
    repo: RepoInfo;
    head: string;
    base: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<PrInfo>;
  refresh(repo: RepoInfo, pr: { number: number | null; branch: string }): Promise<PrInfo>;
  listChecks(repo: RepoInfo, pr: { number: number | null; branch: string }): Promise<PrInfo["checks"]>;
  merge(
    repo: RepoInfo,
    pr: { number: number | null; branch: string; headSha: string },
    opts: { method: "squash" | "merge" | "rebase" },
  ): Promise<PrInfo>;
  close(repo: RepoInfo, pr: { number: number | null; branch: string }): Promise<void>;
}

export interface MergeQueueItem {
  id: string;
  workspaceId: string;
  taskId: string;
  taskTitle: string;
  provider: string;
  prNumber: number | null;
  prUrl: string | null;
  branch: string | null;
  state:
    | "queued"
    | "waiting_checks"
    | "waiting_review"
    | "ready"
    | "updating"
    | "merging"
    | "merged"
    | "blocked"
    | "failed"
    | "cancelled";
  position: number;
  attempts?: number;
  headSha: string;
  baseSha: string | null;
  approvedHeadSha: string | null;
  checks: { state: string; summary: string; waived?: boolean };
  checksWaived: boolean;
  retryAt: string | null;
  review: string;
  conflictTaskId: string | null;
  lastError: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MergeQueueSnapshot {
  workspaceId: string;
  items: MergeQueueItem[];
  activeMerge: string | null;
  updatedAt: string;
}

export interface RepoDiagnostics {
  workspaceId: string;
  workspacePath: string;
  mode: GitMode;
  root: string | null;
  runtimeRoot: string | null;
  gitVersion: string | null;
  remote: { name: string; host: string; repo: string } | null;
  baseBranch: string | null;
  provider: "github" | "manual" | "local" | "none";
  auth: {
    gh: boolean;
    env: boolean;
    rest: boolean;
    user: string | null;
    rateLimit: { remaining: number | null; resetAt: string | null };
  };
  protection: "protected" | "unprotected" | "unknown";
  worktrees: Array<{ path: string; branch: string; taskId: string; state: string }>;
  queue: { active: number; blocked: number; state: string };
  lastError: { code: string; message: string; at: string } | null;
}

export interface CheckRun {
  id: string;
  taskId: string;
  source: "github" | "local";
  headSha: string;
  name: string;
  state: "queued" | "running" | "passed" | "failed" | "skipped";
  detail: string | null;
  updatedAt: string;
}

export interface PrepareRunInput {
  workspaceId: string;
  taskId: string;
  runId: string;
  attempt: number;
  agentId: string;
}

export type PrepareRunResult =
  | {
      ok: true;
      cwd: string;
      branch: string | null;
      sandboxId: string;
      mode: "git" | "degraded";
      runtimeRoot?: string;
    }
  | { ok: false; defer: true; retryAfterMs: number; reason: string }
  | { ok: false; defer: false; errorCode: GitErrorCode; message: string };

export type FinalizeStatus = "completed" | "failed" | "cancelled";

export interface FinalizeRunInput {
  runId: string;
  taskId: string;
  status: FinalizeStatus;
}

export interface GitEventPayload {
  [key: string]: unknown;
}

export interface TaskVcsSnapshot {
  vcs: TaskVcs | null;
  run: {
    runId: string;
    taskId: string;
    worktreePath: string | null;
    branch: string | null;
    baseSha: string | null;
    commitSha: string | null;
    prNumber: number | null;
    mode: string;
  } | null;
}

export interface WorktreeRef {
  taskId: string;
  branch: string;
  path: string;
  runId: string;
  attempt: number;
}

export interface BranchCommit {
  sha: string;
  branch: string;
  files: string[];
  insertions: number;
  deletions: number;
}

export interface TreeVerification {
  ok: boolean;
  method: "ancestor" | "content";
  reason?: string;
  mismatched?: string[];
}

export interface QueueCheckResult {
  state: "passed" | "failed" | "pending" | "waived";
  summary: string;
  detail?: string;
}

export interface ConflictTaskResult {
  taskId: string;
  created: boolean;
}

export interface GitRunStatus {
  runId: string;
  taskId: string;
  status: RunStatus;
  taskStatus?: TaskStatus;
}
