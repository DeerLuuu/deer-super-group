import { z } from "zod";

/**
 * Git event catalog and schemas. The kernel eventRegistry is owned by t68;
 * this module is the Git-side contract used by tests and by future registry
 * registration. Type names must match ^[a-z0-9_.]+$ (no `/`, `。`, `;`, space).
 */
export const GIT_EVENT_TYPES = [
  "git.repo_detected",
  "git.degraded",
  "git.worktree_created",
  "git.worktree_removed",
  "git.worktree_orphaned",
  "git.worktree_reclaimed",
  "git.worktree_recovered",
  "git.legacy_cleared",
  "git.commit_blocked",
  "git.local_finalized",
  "git.branch_created",
  "git.commit",
  "git.no_changes",
  "git.scope_mismatch",
  "git.pushed",
  "git.push_failed",
  "pr.created",
  "pr.updated",
  "pr.closed",
  "pr.merged",
  "merge.enqueued",
  "merge.approved",
  "merge.approval_reset",
  "merge.checks_pending",
  "merge.checks_failed",
  "merge.checks_passed",
  "merge.checks_waived",
  "merge.started",
  "merge.merged",
  "merge.blocked",
  "merge.failed",
  "merge.cancelled",
  "merge.conflict_task_created",
  "git.reconciled",
] as const;

export type GitEventType = (typeof GIT_EVENT_TYPES)[number];

export const gitEventTypeSchema = z
  .string()
  .regex(/^[a-z0-9_.]+$/, "event type must match ^[a-z0-9_.]+$")
  .refine((value) => (GIT_EVENT_TYPES as readonly string[]).includes(value), {
    message: "unknown Git event type",
  });

const checksSchema = z.array(
  z.object({
    name: z.string(),
    status: z.string(),
    url: z.string().optional(),
  }),
);

export const GIT_EVENT_SCHEMAS: Record<GitEventType, z.ZodTypeAny> = {
  "git.repo_detected": z.object({ root: z.string().nullable(), baseBranch: z.string(), provider: z.string() }).passthrough(),
  "git.degraded": z.object({ reason: z.string(), workspacePath: z.string() }).passthrough(),
  "git.worktree_created": z.object({ taskId: z.string(), runId: z.string(), path: z.string(), branch: z.string() }).passthrough(),
  "git.worktree_removed": z.object({ taskId: z.string(), path: z.string(), reason: z.string() }).passthrough(),
  "git.worktree_orphaned": z.object({ taskId: z.string(), path: z.string(), reason: z.string() }).passthrough(),
  "git.worktree_reclaimed": z.object({ taskId: z.string(), branch: z.string(), oldPath: z.string(), reason: z.string() }).passthrough(),
  "git.worktree_recovered": z.object({ taskId: z.string(), runId: z.string(), path: z.string(), action: z.string() }).passthrough(),
  "git.legacy_cleared": z.object({ taskId: z.string(), oldBranch: z.string(), oldWorktree: z.string() }).passthrough(),
  "git.commit_blocked": z.object({ runId: z.string(), files: z.array(z.string()), reason: z.string(), errorCode: z.string() }).passthrough(),
  "git.local_finalized": z.object({ runId: z.string(), branch: z.string(), commitSha: z.string() }).passthrough(),
  "git.branch_created": z.object({ branch: z.string(), base: z.string(), baseSha: z.string() }).passthrough(),
  "git.commit": z.object({ runId: z.string(), branch: z.string(), sha: z.string(), files: z.array(z.string()) }).passthrough(),
  "git.no_changes": z.object({ runId: z.string() }).passthrough(),
  "git.scope_mismatch": z.object({ runId: z.string(), files: z.array(z.string()), scopePaths: z.array(z.string()) }).passthrough(),
  "git.pushed": z.object({ runId: z.string(), branch: z.string(), remote: z.string(), sha: z.string() }).passthrough(),
  "git.push_failed": z.object({ runId: z.string(), branch: z.string(), errorCode: z.string(), retryable: z.boolean() }).passthrough(),
  "pr.created": z.object({ provider: z.string(), number: z.number().nullable(), url: z.string().nullable(), headSha: z.string(), base: z.string() }).passthrough(),
  "pr.updated": z.object({ number: z.number().nullable(), state: z.string(), headSha: z.string(), mergeable: z.string() }).passthrough(),
  "pr.closed": z.object({ number: z.number().nullable(), reason: z.string() }).passthrough(),
  "pr.merged": z.object({ number: z.number().nullable(), mergeCommitSha: z.string().nullable(), headSha: z.string() }).passthrough(),
  "merge.enqueued": z.object({ queueId: z.string(), position: z.number(), taskId: z.string() }).passthrough(),
  "merge.approved": z.object({ queueId: z.string(), actor: z.string(), headSha: z.string() }).passthrough(),
  "merge.approval_reset": z.object({ queueId: z.string(), oldHeadSha: z.string(), newHeadSha: z.string(), reason: z.string() }).passthrough(),
  "merge.checks_pending": z.object({ queueId: z.string(), headSha: z.string(), checks: checksSchema }).passthrough(),
  "merge.checks_failed": z.object({ queueId: z.string(), headSha: z.string(), checks: checksSchema, detail: z.string().optional() }).passthrough(),
  "merge.checks_passed": z.object({ queueId: z.string(), checks: checksSchema }).passthrough(),
  "merge.checks_waived": z.object({ queueId: z.string(), actor: z.string(), headSha: z.string(), reason: z.string().min(8) }).passthrough(),
  "merge.started": z.object({ queueId: z.string(), attempt: z.number(), headSha: z.string() }).passthrough(),
  "merge.merged": z.object({ queueId: z.string(), mergeCommitSha: z.string().nullable() }).passthrough(),
  "merge.blocked": z.object({ queueId: z.string(), reason: z.string(), conflictTaskId: z.string().optional() }).passthrough(),
  "merge.failed": z.object({ queueId: z.string(), errorCode: z.string(), attempts: z.number() }).passthrough(),
  "merge.cancelled": z.object({ queueId: z.string(), reason: z.string() }).passthrough(),
  "merge.conflict_task_created": z.object({ queueId: z.string(), conflictTaskId: z.string(), sourceTaskId: z.string() }).passthrough(),
  "git.reconciled": z.object({ worktrees: z.number(), queue: z.number(), repaired: z.number() }).passthrough(),
};

export function validateGitEvent(type: string, payload: unknown): { ok: true } | { ok: false; error: string } {
  const typeResult = gitEventTypeSchema.safeParse(type);
  if (!typeResult.success) return { ok: false, error: typeResult.error.issues[0]?.message ?? "invalid type" };
  const schema = GIT_EVENT_SCHEMAS[type as GitEventType];
  const result = schema.safeParse(payload);
  return result.success ? { ok: true } : { ok: false, error: result.error.issues[0]?.message ?? "invalid payload" };
}

export function assertGitEvent(type: string, payload: unknown): void {
  const result = validateGitEvent(type, payload);
  if (!result.ok) throw new Error(`invalid Git event ${type}: ${result.error}`);
}
