import crypto from "node:crypto";
import type { TaskVcsSnapshot } from "../git/types.js";
import type { Store } from "../kernel/store.js";
import { ReviewDiffProvider, parseFileLines, pageLines } from "./diff.js";
import type { ReviewDiffResult } from "./diff.js";
import { reanchorTargets } from "./anchor.js";
import { ReviewStore } from "./store.js";
import type {
  ReviewBoardPost,
  ReviewComment,
  ReviewConfig,
  ReviewConfigPatch,
  ReviewDecision,
  ReviewDecisionRecord,
  ReviewDiffPage,
  ReviewFile,
  ReviewGateResult,
  ReviewLine,
  ReviewMail,
  ReviewMode,
  ReviewReviewer,
  ReviewSeverity,
  ReviewSummary,
  ReviewTarget,
  ReviewThread,
} from "./types.js";
import { ReviewError } from "./types.js";

const HUMAN = "user";
const MAX_BODY = 10_000;
const MAX_THREADS = 2_000;

export interface ReviewServiceOptions {
  store: Store;
  getTaskVcs: (taskId: string) => Promise<TaskVcsSnapshot>;
  workspacePath: (workspaceId: string) => string;
  sendMail?: (mail: ReviewMail) => void;
  postBoard?: (post: ReviewBoardPost) => void;
  computeDiff?: (workspaceId: string, vcs: import("../git/types.js").TaskVcs) => Promise<ReviewDiffResult>;
}

function assertHuman(actor: string): void {
  if (!actor || actor.startsWith("agent:") || actor !== HUMAN) {
    throw new ReviewError("REVIEW_FORBIDDEN", "review writes are human-only");
  }
}

function body(value: string): string {
  const text = value.trim();
  if (!text || text.length > MAX_BODY) throw new ReviewError("REVIEW_LIMIT", "comment must be 1..10000 characters");
  return text;
}

function hash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export class ReviewService {
  readonly patches: ReviewStore;
  private readonly diffs: ReviewDiffProvider;
  private readonly computeDiff: (workspaceId: string, vcs: import("../git/types.js").TaskVcs) => Promise<ReviewDiffResult>;

  constructor(private readonly options: ReviewServiceOptions) {
    this.patches = new ReviewStore(options.store);
    this.diffs = new ReviewDiffProvider(options.workspacePath);
    this.computeDiff = options.computeDiff ?? ((workspaceId, vcs) => this.diffs.compute(workspaceId, vcs));
  }

  getConfig(workspaceId: string): ReviewConfig {
    return this.patches.getConfig(workspaceId);
  }

  saveConfig(
    workspaceId: string,
    patch: ReviewConfigPatch,
    options: { confirmResets?: boolean; actor?: string } = {},
  ): ReviewConfig {
    const actor = options.actor ?? HUMAN;
    assertHuman(actor);
    const current = this.getConfig(workspaceId);
    const nextMode: ReviewMode = patch.mode ?? current.mode;
    if (!["required", "advisory", "off"].includes(nextMode)) {
      throw new ReviewError("REVIEW_LIMIT", "invalid review mode");
    }
    const modeChanged = nextMode !== current.mode;
    const dangerous = modeChanged && (current.mode === "required" || nextMode === "required");
    if (dangerous) {
      const hasQueue = Boolean(
        this.options.store.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'merge_queue'")
          .get(),
      );
      const active = hasQueue
        ? (this.options.store.db
            .prepare(
              `SELECT id FROM merge_queue
               WHERE workspace_id = ? AND state IN ('queued','waiting_checks','waiting_review','ready','updating')
                 AND (approved_head_sha IS NOT NULL OR checks_waived = 1)`,
            )
            .all(workspaceId) as Array<{ id: string }>)
        : [];
      if (active.length > 0 && !options.confirmResets) {
        throw new ReviewError("REVIEW_CONFIG_CONFIRM_REQUIRED", "confirm clearing merge approvals/checks waiver");
      }
      if (active.length > 0 && hasQueue) {
        this.options.store.withTransaction(() => {
          this.options.store.db
            .prepare(
              `UPDATE merge_queue
               SET approved_head_sha = NULL, checks_waived = 0, checks_waived_by = NULL,
                   checks_waived_reason = NULL, checks_waived_at = NULL, state = 'waiting_review', updated_at = ?
               WHERE workspace_id = ? AND state IN ('queued','waiting_checks','waiting_review','ready','updating')`,
            )
            .run(new Date().toISOString(), workspaceId);
          this.options.store.appendEvent({
            aggregateType: "workspace",
            aggregateId: workspaceId,
            type: "merge.approval_reset",
            actor,
            payload: { reason: "review_config_changed", from: current.mode, to: nextMode },
            schemaVersion: 2,
          });
        });
      }
    }
    const saved = this.patches.saveConfig(workspaceId, { ...patch, mode: nextMode });
    this.options.store.appendEvent({
      aggregateType: "workspace",
      aggregateId: workspaceId,
      type: "review.config_changed",
      actor,
      payload: {
        fromMode: current.mode,
        toMode: nextMode,
        fromApprovals: 1,
        toApprovals: 1,
      },
      schemaVersion: 2,
      idempotencyKey: `review:config:${workspaceId}:${Date.now()}`,
    });
    return saved;
  }

  async ensureTarget(taskId: string): Promise<ReviewTarget> {
    const task = this.options.store.getTask(taskId);
    if (!task) throw new ReviewError("REVIEW_NOT_FOUND", "task not found");
    const snapshot = await this.options.getTaskVcs(taskId);
    const vcs = snapshot.vcs;
    if (!vcs || !vcs.branch || !vcs.headSha) {
      throw new ReviewError("REVIEW_TARGET_MISSING", "task has no branch/head");
    }
    const diff = await this.computeDiff(task.workspaceId, vcs);
    const existing = this.patches.getTarget(taskId, diff.headSha);
    if (existing && existing.baseSha === diff.baseSha && existing.diffHash === diff.diffHash) {
      if (existing.reviewers.length === 0) this.ensureDefaultReviewer(existing);
      return this.patches.getTargetById(existing.id)!;
    }
    if (existing) this.patches.markTargetStale(existing.id, "base_or_diff_changed");
    const latest = this.patches.getTarget(taskId);
    if (latest && latest.headSha !== diff.headSha) {
      this.patches.markTargetStale(latest.id, "head_changed");
      this.patches.appendEvent(latest, "review.stale", {
        oldHeadSha: latest.headSha,
        newHeadSha: diff.headSha,
        reason: "head_changed",
      }, `review:stale:${latest.id}:${diff.headSha}`);
    }
    const owner = task.ownerId ? this.options.store.getAgent(task.ownerId) : null;
    const authorAgentId = owner && owner.workspaceId === task.workspaceId ? owner.id : null;
    const target = this.patches.createTarget({
      workspaceId: task.workspaceId,
      taskId,
      authorAgentId,
      requesterId: HUMAN,
      requesterKind: "human",
      provider: vcs.pr?.provider ?? "local",
      prNumber: vcs.pr?.number ?? null,
      prUrl: vcs.pr?.url ?? null,
      baseBranch: vcs.baseBranch ?? "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
      mergeBaseSha: diff.mergeBaseSha,
      diffHash: diff.diffHash,
    });
    this.patches.saveFiles(
      target.id,
      diff.files.map((file) => ({
        ...file,
        targetId: target.id,
        patchText: file.patchText,
      })),
    );
    this.patches.appendEvent(target, "review.target_created", {
      taskId,
      headSha: diff.headSha,
      baseSha: diff.baseSha,
      diffHash: diff.diffHash,
    }, `review:target:${taskId}:${diff.headSha}:${diff.baseSha}`);
    if (!authorAgentId) {
      this.patches.appendEvent(target, "review.author_unknown", {
        taskId,
        ownerId: task.ownerId,
        actor: HUMAN,
      }, `review:author-unknown:${target.id}`);
    }
    this.ensureDefaultReviewer(target);
    this.notifyTarget(target);
    if (latest && latest.headSha !== diff.headSha) {
      await reanchorTargets({
        store: this.options.store,
        reviewStore: this.patches,
        diffs: this.diffs,
        workspaceId: target.workspaceId,
        oldTarget: latest,
        newTarget: target,
      });
    }
    return this.patches.getTargetById(target.id)!;
  }

  private ensureDefaultReviewer(target: ReviewTarget): void {
    if (target.reviewers.some((reviewer) => reviewer.status !== "removed")) return;
    const reviewer = this.patches.addReviewer(target.id, {
      reviewerId: HUMAN,
      reviewerKind: "human",
      role: "reviewer",
      assignedBy: HUMAN,
    });
    this.patches.appendEvent(target, "review.requested", {
      reviewerId: reviewer.reviewerId,
      role: reviewer.role,
    }, `review:req:${target.id}:${reviewer.reviewerId}`);
    const owner = target.authorAgentId ? this.options.store.getAgent(target.authorAgentId) : null;
    if (owner && this.getConfig(target.workspaceId).notifyMailbox) {
      this.options.sendMail?.({
        workspaceId: target.workspaceId,
        from: "review",
        to: [owner.id],
        subject: `[评审] 任务 ${target.taskId} · ${target.headSha.slice(0, 7)}`,
        body: `任务 ${target.taskId} 的行级评审已创建；请打开任务详情完成评审。`,
        kind: "review",
      });
    }
  }

  async getSummary(taskId: string): Promise<ReviewSummary> {
    const target = await this.ensureTarget(taskId);
    const mode = this.getConfig(target.workspaceId).mode;
    return {
      target: this.patches.getTargetById(target.id)!,
      mode,
      files: this.patches.listFiles(target.id).map((file) => ({
        targetId: file.targetId,
        fileIndex: file.fileIndex,
        path: file.path,
        oldPath: file.oldPath,
        changeType: file.changeType,
        isBinary: file.isBinary,
        isLfs: file.isLfs,
        additions: file.additions,
        deletions: file.deletions,
        lineCount: file.lineCount,
        truncated: file.truncated,
      })),
      decisions: this.patches.listDecisions(target.id),
      gate: this.evaluate(target, mode),
    };
  }

  async getDiff(
    taskId: string,
    input: { file?: string; offset?: number; limit?: number } = {},
  ): Promise<ReviewDiffPage> {
    const target = await this.ensureTarget(taskId);
    const files = this.patches.listFiles(target.id);
    if (files.length === 0) throw new ReviewError("REVIEW_NOT_FOUND", "diff has no files");
    const file = (input.file ? files.find((candidate) => candidate.path === input.file) : files[0])!;
    if (!file) throw new ReviewError("REVIEW_NOT_FOUND", "file not found");
    const lines = parseFileLines(file.patchText ?? "");
    const page = pageLines(lines, input.offset ?? 0, input.limit ?? 300);
    return {
      targetId: target.id,
      file: {
        targetId: file.targetId,
        fileIndex: file.fileIndex,
        path: file.path,
        oldPath: file.oldPath,
        changeType: file.changeType,
        isBinary: file.isBinary,
        isLfs: file.isLfs,
        additions: file.additions,
        deletions: file.deletions,
        lineCount: file.lineCount,
        truncated: file.truncated,
      },
      ...page,
    };
  }

  async getThreads(taskId: string, input: { file?: string; status?: string } = {}): Promise<ReviewThread[]> {
    const target = await this.ensureTarget(taskId);
    return this.patches.listThreads(target.id, input.file, input.status);
  }

  async createThread(input: {
    taskId: string;
    filePath: string;
    side: "new" | "old";
    lineStart: number;
    lineEnd?: number;
    body: string;
    severity: ReviewSeverity;
    actor?: string;
  }): Promise<ReviewThread> {
    const actor = input.actor ?? HUMAN;
    assertHuman(actor);
    const target = await this.ensureTarget(input.taskId);
    const text = body(input.body);
    const files = this.patches.listFiles(target.id);
    const file = files.find((candidate) => candidate.path === input.filePath);
    if (!file) throw new ReviewError("REVIEW_NOT_FOUND", "file not found");
    const lines = parseFileLines(file.patchText ?? "");
    const line = lines.find((candidate) =>
      input.side === "new" ? candidate.newLine === input.lineStart : candidate.oldLine === input.lineStart,
    );
    if (!line) throw new ReviewError("REVIEW_NOT_FOUND", "line not found");
    if (input.severity === "blocker" && !target.reviewers.some((reviewer) => reviewer.reviewerId === actor && reviewer.status !== "removed")) {
      throw new ReviewError("REVIEW_FORBIDDEN", "only a reviewer can open a blocker");
    }
    if (this.patches.listThreads(target.id).length >= MAX_THREADS) {
      throw new ReviewError("REVIEW_LIMIT", "too many threads");
    }
    const before = lines.slice(Math.max(0, lines.indexOf(line) - 3), lines.indexOf(line)).map((entry) => entry.text);
    const after = lines.slice(lines.indexOf(line) + 1, lines.indexOf(line) + 4).map((entry) => entry.text);
    return this.patches.createThread({
      target,
      filePath: input.filePath,
      oldPath: file.oldPath,
      side: input.side,
      lineStart: input.lineStart,
      lineEnd: input.lineEnd ?? input.lineStart,
      severity: input.severity,
      createdBy: actor,
      body: text,
      contextBefore: before,
      contextAfter: after,
    });
  }

  async reply(taskId: string, threadId: string, text: string, actor = HUMAN): Promise<ReviewComment> {
    assertHuman(actor);
    const target = await this.ensureTarget(taskId);
    const thread = this.patches.getThread(threadId);
    if (!thread || thread.targetId !== target.id) throw new ReviewError("REVIEW_NOT_FOUND", "thread not found");
    return this.patches.addReply(threadId, actor, body(text));
  }

  async editComment(taskId: string, commentId: string, text: string, actor = HUMAN): Promise<ReviewComment> {
    assertHuman(actor);
    const target = await this.ensureTarget(taskId);
    const thread = this.patches.listThreads(target.id).find((candidate) =>
      candidate.comments.some((comment) => comment.id === commentId),
    );
    if (!thread) throw new ReviewError("REVIEW_NOT_FOUND", "comment not found");
    return this.patches.editComment(commentId, actor, body(text));
  }

  async deleteComment(taskId: string, commentId: string, actor = HUMAN): Promise<ReviewComment> {
    assertHuman(actor);
    const target = await this.ensureTarget(taskId);
    const thread = this.patches.listThreads(target.id).find((candidate) =>
      candidate.comments.some((comment) => comment.id === commentId),
    );
    if (!thread) throw new ReviewError("REVIEW_NOT_FOUND", "comment not found");
    if (thread.severity === "blocker" && thread.comments[0]?.id === commentId) {
      throw new ReviewError("REVIEW_FORBIDDEN", "blocker root comment cannot be deleted");
    }
    return this.patches.deleteComment(commentId, actor);
  }

  async resolveThread(taskId: string, threadId: string, note?: string, actor = HUMAN): Promise<ReviewThread> {
    assertHuman(actor);
    const target = await this.ensureTarget(taskId);
    const thread = this.patches.getThread(threadId);
    if (!thread || thread.targetId !== target.id) throw new ReviewError("REVIEW_NOT_FOUND", "thread not found");
    return this.patches.setThreadStatus(threadId, "resolved", actor, note);
  }

  async reopenThread(taskId: string, threadId: string, note?: string, actor = HUMAN): Promise<ReviewThread> {
    assertHuman(actor);
    const target = await this.ensureTarget(taskId);
    const thread = this.patches.getThread(threadId);
    if (!thread || thread.targetId !== target.id) throw new ReviewError("REVIEW_NOT_FOUND", "thread not found");
    return this.patches.setThreadStatus(threadId, "open", actor, note);
  }

  async setSeverity(taskId: string, threadId: string, severity: ReviewSeverity, actor = HUMAN): Promise<ReviewThread> {
    assertHuman(actor);
    const target = await this.ensureTarget(taskId);
    const thread = this.patches.getThread(threadId);
    if (!thread || thread.targetId !== target.id) throw new ReviewError("REVIEW_NOT_FOUND", "thread not found");
    if (severity === "blocker" && !target.reviewers.some((reviewer) => reviewer.reviewerId === actor && reviewer.status !== "removed")) {
      throw new ReviewError("REVIEW_FORBIDDEN", "only a reviewer can create/upgrade a blocker");
    }
    return this.patches.setSeverity(threadId, severity, actor);
  }

  async assignReviewer(
    taskId: string,
    reviewerId: string,
    role: ReviewReviewer["role"] = "reviewer",
    actor = HUMAN,
  ): Promise<ReviewTarget> {
    assertHuman(actor);
    const target = await this.ensureTarget(taskId);
    if (reviewerId === target.authorAgentId) throw new ReviewError("REVIEW_FORBIDDEN", "author cannot review");
    const agent = this.options.store.getAgent(reviewerId);
    if (reviewerId !== HUMAN && !agent) throw new ReviewError("REVIEW_NOT_FOUND", "reviewer not found");
    if (reviewerId !== HUMAN && role === "reviewer") {
      throw new ReviewError("REVIEW_FORBIDDEN", "P0 required reviewer must be the local human");
    }
    this.patches.addReviewer(target.id, {
      reviewerId,
      reviewerKind: reviewerId === HUMAN ? "human" : "agent",
      role,
      assignedBy: actor,
    });
    this.patches.appendEvent(target, "review.requested", { reviewerId, role }, `review:req:${target.id}:${reviewerId}:${Date.now()}`);
    return this.patches.getTargetById(target.id)!;
  }

  async removeReviewer(
    taskId: string,
    reviewerId: string,
    reason: string,
    actor = HUMAN,
  ): Promise<ReviewTarget> {
    assertHuman(actor);
    if (reason.trim().length < 8) throw new ReviewError("REVIEW_LIMIT", "reason must be at least 8 characters");
    const target = await this.ensureTarget(taskId);
    if (!target.reviewers.some((reviewer) => reviewer.reviewerId === reviewerId)) {
      throw new ReviewError("REVIEW_NOT_FOUND", "reviewer not found");
    }
    this.patches.removeReviewer(target.id, reviewerId, reason.trim());
    this.patches.appendEvent(target, "review.reviewer_removed", { reviewerId, actor, reason: reason.trim() }, `review:reviewer-remove:${target.id}:${reviewerId}:${Date.now()}`);
    this.resetQueue(target);
    return this.patches.getTargetById(target.id)!;
  }

  async replaceReviewer(
    taskId: string,
    fromReviewerId: string,
    toReviewerId: string,
    reason: string,
    actor = HUMAN,
  ): Promise<ReviewTarget> {
    assertHuman(actor);
    const target = await this.removeReviewer(taskId, fromReviewerId, reason, actor);
    const updated = await this.assignReviewer(taskId, toReviewerId, "reviewer", actor);
    this.patches.appendEvent(updated, "review.reviewer_replaced", {
      fromReviewerId,
      toReviewerId,
      actor,
      reason,
    }, `review:reviewer-replace:${target.id}:${fromReviewerId}:${toReviewerId}:${Date.now()}`);
    return this.patches.getTargetById(target.id)!;
  }

  async submitDecision(input: {
    taskId: string;
    decision: ReviewDecision;
    headSha: string;
    notes?: string;
    clientRequestId?: string;
    actor?: string;
  }): Promise<ReviewTarget> {
    const actor = input.actor ?? HUMAN;
    assertHuman(actor);
    const target = await this.ensureTarget(input.taskId);
    if (input.headSha !== target.headSha) throw new ReviewError("REVIEW_STALE", "head changed; re-review required");
    if (actor === target.authorAgentId) throw new ReviewError("REVIEW_FORBIDDEN", "author cannot review");
    if (!target.reviewers.some((reviewer) => reviewer.reviewerId === actor && reviewer.status !== "removed")) {
      throw new ReviewError("REVIEW_FORBIDDEN", "reviewer not assigned");
    }
    if (!["approve", "request_changes", "comment"].includes(input.decision)) {
      throw new ReviewError("REVIEW_LIMIT", "invalid decision");
    }
    const blockers = this.patches.countBlockers(target.id);
    if (input.decision === "approve" && blockers > 0) {
      throw new ReviewError("REVIEW_BLOCKED", `${blockers} blocker(s) unresolved`);
    }
    if (input.decision === "request_changes" && !input.notes?.trim()) {
      throw new ReviewError("REVIEW_LIMIT", "request_changes requires notes");
    }
    const record = this.patches.insertDecision({
      target,
      reviewerId: actor,
      decision: input.decision,
      headSha: target.headSha,
      notes: input.notes?.trim() || null,
      blockerCount: blockers,
      clientRequestId: input.clientRequestId,
    });
    this.patches.markReviewerDecision(
      target.id,
      actor,
      input.decision === "approve" ? "approved" : input.decision === "request_changes" ? "changes_requested" : "requested",
    );
    this.patches.recomputeTarget(target.id);
    const updated = this.patches.getTargetById(target.id)!;
    if (input.decision === "approve" && updated.status === "approved") {
      this.patches.appendEvent(updated, "review.approved", {
        headSha: updated.headSha,
        approvals: updated.approvalCount,
        requiredApprovals: 1,
      }, `review:approved:${updated.id}:${updated.headSha}`);
      this.notifyDecision(updated, "approved");
    } else if (input.decision === "request_changes") {
      this.patches.appendEvent(updated, "review.changes_requested", {
        headSha: updated.headSha,
        reviewerId: actor,
        notesHash: input.notes ? hash(input.notes) : null,
      }, `review:changes:${updated.id}:${updated.headSha}:${actor}:${record.revision}`);
      this.notifyDecision(updated, "changes_requested");
    }
    return updated;
  }

  getDecisions(taskId: string): ReviewDecisionRecord[] {
    const target = this.patches.getTarget(taskId);
    if (!target) throw new ReviewError("REVIEW_NOT_FOUND", "target not found");
    return this.patches.listDecisions(target.id);
  }

  async evaluateTask(taskId: string, headSha?: string): Promise<ReviewGateResult> {
    const target = headSha
      ? this.patches.getTarget(taskId, headSha)
      : this.patches.getTarget(taskId);
    const snapshot = await this.options.getTaskVcs(taskId);
    const currentHead = snapshot.vcs?.headSha ?? null;
    const workspaceId = this.options.store.getTask(taskId)?.workspaceId;
    if (!workspaceId) throw new ReviewError("REVIEW_NOT_FOUND", "task not found");
    const mode = this.getConfig(workspaceId).mode;
    if (mode === "off") return { ok: true, mode, targetId: target?.id ?? null };
    if (!target) {
      if (mode === "advisory") return { ok: true, mode, targetId: null, warnings: ["review target not created"] };
      return {
        ok: false,
        mode,
        targetId: null,
        code: "REVIEW_TARGET_MISSING",
        reason: "review target not created",
        blockers: 0,
        approvals: 0,
        requiredApprovals: 1,
      };
    }
    if (headSha && headSha !== currentHead) {
      return {
        ok: false,
        mode,
        targetId: target.id,
        code: "REVIEW_STALE",
        reason: "head no longer current",
        blockers: target.blockerCount,
        approvals: target.approvalCount,
        requiredApprovals: 1,
      };
    }
    return this.evaluate(target, mode);
  }

  async assertMergeAllowed(taskId: string): Promise<void> {
    const snapshot = await this.options.getTaskVcs(taskId);
    const head = snapshot.vcs?.headSha;
    if (!head) return;
    const gate = await this.evaluateTask(taskId, head);
    if (!gate.ok) throw new ReviewError(gate.code, gate.reason);
  }

  private evaluate(target: ReviewTarget, mode: ReviewMode): ReviewGateResult {
    const blockers = this.patches.countBlockers(target.id);
    const current = this.patches.currentDecisions(target.id, target.headSha);
    const approvals = current.filter((decision) => decision.decision === "approve").length;
    const changes = current.some((decision) => decision.decision === "request_changes");
    if (mode === "advisory") {
      return {
        ok: true,
        mode,
        targetId: target.id,
        warnings: blockers > 0 ? [`${blockers} blocker(s) unresolved`] : undefined,
      };
    }
    if (target.status === "stale" || target.status === "unavailable") {
      return { ok: false, mode, targetId: target.id, code: "REVIEW_STALE", reason: target.staleReason ?? "review stale", blockers, approvals, requiredApprovals: 1 };
    }
    if (blockers > 0) {
      return { ok: false, mode, targetId: target.id, code: "REVIEW_BLOCKED", reason: `${blockers} blocker(s) unresolved`, blockers, approvals, requiredApprovals: 1 };
    }
    if (changes) {
      return { ok: false, mode, targetId: target.id, code: "REVIEW_CHANGES_REQUESTED", reason: "changes requested", blockers, approvals, requiredApprovals: 1 };
    }
    if (!target.reviewers.some((reviewer) => reviewer.reviewerKind === "human" && reviewer.status !== "removed")) {
      return { ok: false, mode, targetId: target.id, code: "REVIEW_UNASSIGNED", reason: "no human reviewer assigned", blockers, approvals, requiredApprovals: 1 };
    }
    if (approvals < 1) {
      return { ok: false, mode, targetId: target.id, code: "REVIEW_PENDING", reason: "waiting for approval", blockers, approvals, requiredApprovals: 1 };
    }
    return { ok: true, mode, targetId: target.id };
  }

  private resetQueue(target: ReviewTarget): void {
    const hasQueue = Boolean(
      this.options.store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'merge_queue'")
        .get(),
    );
    if (!hasQueue) return;
    this.options.store.db
      .prepare(
        `UPDATE merge_queue SET approved_head_sha = NULL, checks_waived = 0, state = 'waiting_review', updated_at = ?
         WHERE workspace_id = ? AND task_id = ?`,
      )
      .run(new Date().toISOString(), target.workspaceId, target.taskId);
  }

  private notifyTarget(target: ReviewTarget): void {
    if (!this.getConfig(target.workspaceId).boardSummary) return;
    this.options.postBoard?.({
      workspaceId: target.workspaceId,
      board: "reviews",
      author: "review",
      kind: "warning",
      content: `评审已创建：任务 ${target.taskId} · head ${target.headSha.slice(0, 7)}`,
      confidence: "high",
    });
  }

  private notifyDecision(target: ReviewTarget, decision: "approved" | "changes_requested"): void {
    if (!this.getConfig(target.workspaceId).boardSummary) return;
    this.options.postBoard?.({
      workspaceId: target.workspaceId,
      board: "reviews",
      author: "review",
      kind: decision === "approved" ? "decision" : "warning",
      content: `合并评审 ${decision === "approved" ? "通过" : "要求修改"}：任务 ${target.taskId} · head ${target.headSha.slice(0, 7)} · blockers ${target.blockerCount}`,
      confidence: "high",
    });
  }
}
