import crypto from "node:crypto";
import type { Store } from "../kernel/store.js";
import type {
  ReviewComment,
  ReviewConfig,
  ReviewConfigPatch,
  ReviewDecisionRecord,
  ReviewFile,
  ReviewReviewer,
  ReviewTarget,
  ReviewThread,
} from "./types.js";

type Row = Record<string, unknown>;

export function reviewId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function now(): string {
  return new Date().toISOString();
}

function bool(value: unknown): boolean {
  return value === 1 || value === true;
}

function parseContext(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((part): part is string => typeof part === "string").slice(0, 3) : [];
  } catch {
    return [];
  }
}

function stringifyContext(lines: string[] | undefined): string {
  return JSON.stringify((lines ?? []).filter((line) => typeof line === "string").slice(0, 3).map((line) => line.slice(0, 500)));
}

export class ReviewStore {
  constructor(readonly store: Store) {
    this.ensureSchema();
  }

  private get db() {
    return this.store.db;
  }

  ensureSchema(): void {
    this.store.withTransaction(() => {
      this.db
        .prepare(
          `CREATE TABLE IF NOT EXISTS review_schema (
            version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, note TEXT
          )`,
        )
        .run();
      this.db
        .prepare(
          `CREATE TABLE IF NOT EXISTS review_config (
            workspace_id TEXT PRIMARY KEY,
            mode TEXT NOT NULL DEFAULT 'advisory',
            required_approvals INTEGER NOT NULL DEFAULT 1 CHECK (required_approvals = 1),
            notify_mailbox INTEGER NOT NULL DEFAULT 1,
            board_summary INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL
          )`,
        )
        .run();
      this.db
        .prepare(
          `CREATE TABLE IF NOT EXISTS review_targets (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            author_agent_id TEXT,
            requester_id TEXT NOT NULL,
            requester_kind TEXT NOT NULL,
            provider TEXT NOT NULL,
            pr_number INTEGER,
            pr_url TEXT,
            base_branch TEXT NOT NULL,
            base_sha TEXT NOT NULL,
            head_sha TEXT NOT NULL,
            merge_base_sha TEXT NOT NULL,
            diff_hash TEXT NOT NULL,
            status TEXT NOT NULL,
            required_approvals INTEGER NOT NULL DEFAULT 1 CHECK (required_approvals = 1),
            blocker_count INTEGER NOT NULL DEFAULT 0,
            approval_count INTEGER NOT NULL DEFAULT 0,
            last_decision_id TEXT,
            stale_reason TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(task_id, head_sha, base_sha)
          )`,
        )
        .run();
      this.db
        .prepare(
          `CREATE TABLE IF NOT EXISTS review_diff_files (
            target_id TEXT NOT NULL,
            file_index INTEGER NOT NULL,
            path TEXT NOT NULL,
            old_path TEXT,
            change_type TEXT NOT NULL,
            is_binary INTEGER NOT NULL DEFAULT 0,
            is_lfs INTEGER NOT NULL DEFAULT 0,
            additions INTEGER NOT NULL DEFAULT 0,
            deletions INTEGER NOT NULL DEFAULT 0,
            line_count INTEGER NOT NULL DEFAULT 0,
            patch_text TEXT,
            truncated INTEGER NOT NULL DEFAULT 0,
            file_hash TEXT NOT NULL,
            PRIMARY KEY(target_id, file_index)
          )`,
        )
        .run();
      this.db
        .prepare(
          `CREATE TABLE IF NOT EXISTS review_reviewers (
            id TEXT PRIMARY KEY,
            target_id TEXT NOT NULL,
            reviewer_id TEXT NOT NULL,
            reviewer_kind TEXT NOT NULL,
            role TEXT NOT NULL,
            status TEXT NOT NULL,
            assigned_by TEXT NOT NULL,
            requested_at TEXT NOT NULL,
            decided_at TEXT,
            removed_at TEXT,
            removed_reason TEXT,
            last_notified_at TEXT,
            UNIQUE(target_id, reviewer_id)
          )`,
        )
        .run();
      this.db
        .prepare(
          `CREATE TABLE IF NOT EXISTS review_threads (
            id TEXT PRIMARY KEY,
            target_id TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            old_path TEXT,
            side TEXT NOT NULL,
            line_start INTEGER NOT NULL,
            line_end INTEGER NOT NULL,
            anchor_head_sha TEXT NOT NULL,
            anchor_blob_sha TEXT,
            context_before TEXT NOT NULL DEFAULT '[]',
            context_after TEXT NOT NULL DEFAULT '[]',
            diff_hash TEXT NOT NULL,
            severity TEXT NOT NULL,
            status TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            resolved_by TEXT,
            resolved_at TEXT,
            resolution_note TEXT,
            reanchored_at TEXT,
            outdated_reason TEXT
          )`,
        )
        .run();
      this.db
        .prepare(
          `CREATE TABLE IF NOT EXISTS review_comments (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            author_id TEXT NOT NULL,
            author_kind TEXT NOT NULL,
            body TEXT NOT NULL,
            body_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            edited_at TEXT,
            deleted_at TEXT,
            deleted_by TEXT
          )`,
        )
        .run();
      this.db
        .prepare(
          `CREATE TABLE IF NOT EXISTS review_decisions (
            id TEXT PRIMARY KEY,
            target_id TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            reviewer_id TEXT NOT NULL,
            decision TEXT NOT NULL,
            head_sha TEXT NOT NULL,
            blocker_count INTEGER NOT NULL DEFAULT 0,
            notes TEXT,
            revision INTEGER NOT NULL DEFAULT 1,
            is_current INTEGER NOT NULL DEFAULT 1,
            supersedes_id TEXT,
            invalidated_at TEXT,
            invalidated_reason TEXT,
            client_request_id TEXT,
            created_at TEXT NOT NULL
          )`,
        )
        .run();
      this.db
        .prepare(
          `CREATE TABLE IF NOT EXISTS review_reanchor_log (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            from_head_sha TEXT NOT NULL,
            to_head_sha TEXT NOT NULL,
            from_line INTEGER NOT NULL,
            to_line INTEGER,
            result TEXT NOT NULL,
            reason TEXT,
            created_at TEXT NOT NULL
          )`,
        )
        .run();
      this.db
        .prepare(
          `CREATE INDEX IF NOT EXISTS idx_review_target_task ON review_targets(workspace_id, task_id, created_at DESC)`,
        )
        .run();
      this.db
        .prepare(
          `CREATE UNIQUE INDEX IF NOT EXISTS uq_review_decision_current
             ON review_decisions(target_id, reviewer_id, head_sha) WHERE is_current = 1`,
        )
        .run();
      this.db
        .prepare(
          `CREATE INDEX IF NOT EXISTS idx_review_threads_file
             ON review_threads(target_id, file_path, status, severity)`,
        )
        .run();
      this.db
        .prepare(
          `INSERT INTO review_schema(version, applied_at, note)
           SELECT 1, ?, 'review_schema P0' WHERE NOT EXISTS (SELECT 1 FROM review_schema)`,
        )
        .run(now());
    });
  }

  getConfig(workspaceId: string): ReviewConfig {
    let row = this.db.prepare("SELECT * FROM review_config WHERE workspace_id = ?").get(workspaceId) as Row | undefined;
    if (!row) {
      this.db
        .prepare(
          `INSERT INTO review_config(workspace_id, mode, required_approvals, notify_mailbox, board_summary, updated_at)
           VALUES (?, 'advisory', 1, 1, 1, ?)`,
        )
        .run(workspaceId, now());
      row = this.db.prepare("SELECT * FROM review_config WHERE workspace_id = ?").get(workspaceId) as Row;
    }
    return {
      workspaceId,
      mode: String(row.mode) as ReviewConfig["mode"],
      requiredApprovals: 1,
      notifyMailbox: bool(row.notify_mailbox),
      boardSummary: bool(row.board_summary),
      updatedAt: String(row.updated_at),
    };
  }

  saveConfig(workspaceId: string, patch: ReviewConfigPatch): ReviewConfig {
    const current = this.getConfig(workspaceId);
    const mode = patch.mode ?? current.mode;
    if (!["required", "advisory", "off"].includes(mode)) throw new Error("invalid review mode");
    this.db
      .prepare(
        `UPDATE review_config SET mode = ?, notify_mailbox = ?, board_summary = ?, updated_at = ?
         WHERE workspace_id = ?`,
      )
      .run(mode, patch.notifyMailbox ?? current.notifyMailbox ? 1 : 0, patch.boardSummary ?? current.boardSummary ? 1 : 0, now(), workspaceId);
    return this.getConfig(workspaceId);
  }

  getTarget(taskId: string, headSha?: string | null): ReviewTarget | null {
    const row = (headSha
      ? this.db
          .prepare(
            "SELECT * FROM review_targets WHERE task_id = ? AND head_sha = ? ORDER BY created_at DESC LIMIT 1",
          )
          .get(taskId, headSha)
      : this.db
          .prepare("SELECT * FROM review_targets WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
          .get(taskId)) as Row | undefined;
    return row ? this.toTarget(row) : null;
  }

  getTargetById(targetId: string): ReviewTarget | null {
    const row = this.db.prepare("SELECT * FROM review_targets WHERE id = ?").get(targetId) as Row | undefined;
    return row ? this.toTarget(row) : null;
  }

  createTarget(input: {
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
  }): ReviewTarget {
    const existingRow = this.db
      .prepare(
        "SELECT * FROM review_targets WHERE task_id = ? AND head_sha = ? AND base_sha = ? LIMIT 1",
      )
      .get(input.taskId, input.headSha, input.baseSha) as Row | undefined;
    if (existingRow) return this.toTarget(existingRow);
    const id = reviewId("review");
    const at = now();
    this.db
      .prepare(
        `INSERT INTO review_targets(
           id, workspace_id, task_id, author_agent_id, requester_id, requester_kind, provider,
           pr_number, pr_url, base_branch, base_sha, head_sha, merge_base_sha, diff_hash, status,
           required_approvals, blocker_count, approval_count, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',1,0,0,?,?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.taskId,
        input.authorAgentId,
        input.requesterId,
        input.requesterKind,
        input.provider,
        input.prNumber,
        input.prUrl,
        input.baseBranch,
        input.baseSha,
        input.headSha,
        input.mergeBaseSha,
        input.diffHash,
        at,
        at,
      );
    return this.getTargetById(id)!;
  }

  markTargetStale(targetId: string, reason: string): void {
    this.db
      .prepare("UPDATE review_targets SET status = 'stale', stale_reason = ?, updated_at = ? WHERE id = ?")
      .run(reason, now(), targetId);
  }

  saveFiles(targetId: string, files: Array<ReviewFile & { patchText: string | null; fileHash: string }>): void {
    this.store.withTransaction(() => {
      for (const file of files) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO review_diff_files(
              target_id, file_index, path, old_path, change_type, is_binary, is_lfs,
              additions, deletions, line_count, patch_text, truncated, file_hash
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            targetId,
            file.fileIndex,
            file.path,
            file.oldPath,
            file.changeType,
            file.isBinary ? 1 : 0,
            file.isLfs ? 1 : 0,
            file.additions,
            file.deletions,
            file.lineCount,
            file.patchText,
            file.truncated ? 1 : 0,
            file.fileHash,
          );
      }
    });
  }

  listFiles(targetId: string): Array<ReviewFile & { patchText: string | null }> {
    const rows = this.db
      .prepare("SELECT * FROM review_diff_files WHERE target_id = ? ORDER BY file_index ASC")
      .all(targetId) as Row[];
    return rows.map((row) => ({
      targetId: String(row.target_id),
      fileIndex: Number(row.file_index),
      path: String(row.path),
      oldPath: row.old_path ? String(row.old_path) : null,
      changeType: String(row.change_type),
      isBinary: bool(row.is_binary),
      isLfs: bool(row.is_lfs),
      additions: Number(row.additions),
      deletions: Number(row.deletions),
      lineCount: Number(row.line_count),
      truncated: bool(row.truncated),
      patchText: row.patch_text == null ? null : String(row.patch_text),
    }));
  }

  addReviewer(targetId: string, input: {
    reviewerId: string;
    reviewerKind: "human" | "agent";
    role: ReviewReviewer["role"];
    assignedBy: string;
  }): ReviewReviewer {
    const existing = this.db
      .prepare("SELECT * FROM review_reviewers WHERE target_id = ? AND reviewer_id = ?")
      .get(targetId, input.reviewerId) as Row | undefined;
    if (existing) {
      this.db
        .prepare(
          "UPDATE review_reviewers SET role = ?, status = 'requested', removed_at = NULL, removed_reason = NULL WHERE id = ?",
        )
        .run(input.role, String(existing.id));
      return this.listReviewers(targetId).find((reviewer) => reviewer.reviewerId === input.reviewerId)!;
    }
    const id = reviewId("reviewer");
    this.db
      .prepare(
        `INSERT INTO review_reviewers(id, target_id, reviewer_id, reviewer_kind, role, status, assigned_by, requested_at)
         VALUES (?,?,?,?,?,'requested',?,?)`,
      )
      .run(id, targetId, input.reviewerId, input.reviewerKind, input.role, input.assignedBy, now());
    return this.listReviewers(targetId).find((reviewer) => reviewer.id === id)!;
  }

  listReviewers(targetId: string): ReviewReviewer[] {
    const rows = this.db
      .prepare("SELECT * FROM review_reviewers WHERE target_id = ? ORDER BY requested_at ASC")
      .all(targetId) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      targetId: String(row.target_id),
      reviewerId: String(row.reviewer_id),
      reviewerKind: String(row.reviewer_kind) as ReviewReviewer["reviewerKind"],
      role: String(row.role) as ReviewReviewer["role"],
      status: String(row.status) as ReviewReviewer["status"],
      assignedBy: String(row.assigned_by),
      requestedAt: String(row.requested_at),
      decidedAt: row.decided_at ? String(row.decided_at) : null,
      removedAt: row.removed_at ? String(row.removed_at) : null,
      removedReason: row.removed_reason ? String(row.removed_reason) : null,
    }));
  }

  removeReviewer(targetId: string, reviewerId: string, reason: string): void {
    this.store.withTransaction(() => {
      this.db
        .prepare(
          "UPDATE review_reviewers SET status = 'removed', removed_at = ?, removed_reason = ? WHERE target_id = ? AND reviewer_id = ?",
        )
        .run(now(), reason, targetId, reviewerId);
      this.db
        .prepare(
          `UPDATE review_decisions SET is_current = 0, invalidated_at = ?, invalidated_reason = 'reviewer_removed'
           WHERE target_id = ? AND reviewer_id = ? AND is_current = 1`,
        )
        .run(now(), targetId, reviewerId);
    });
    this.recomputeTarget(targetId);
  }

  createThread(input: {
    target: ReviewTarget;
    filePath: string;
    oldPath: string | null;
    side: "new" | "old";
    lineStart: number;
    lineEnd: number;
    severity: ReviewThread["severity"];
    createdBy: string;
    body: string;
    contextBefore: string[];
    contextAfter: string[];
  }): ReviewThread {
    const threadId = reviewId("thread");
    const commentId = reviewId("comment");
    const at = now();
    this.store.withTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO review_threads(
            id, target_id, workspace_id, task_id, file_path, old_path, side, line_start, line_end,
            anchor_head_sha, context_before, context_after, diff_hash, severity, status, created_by, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`,
        )
        .run(
          threadId,
          input.target.id,
          input.target.workspaceId,
          input.target.taskId,
          input.filePath,
          input.oldPath,
          input.side,
          input.lineStart,
          input.lineEnd,
          input.target.headSha,
          stringifyContext(input.contextBefore),
          stringifyContext(input.contextAfter),
          input.target.diffHash,
          input.severity,
          input.createdBy,
          at,
        );
      this.insertComment(threadId, input.createdBy, "human", input.body, at);
      this.appendEvent(input.target, "review.thread_created", {
        threadId,
        filePath: input.filePath,
        lineStart: input.lineStart,
        severity: input.severity,
      }, `review:thread:${threadId}`);
      this.appendEvent(input.target, "review.comment_added", {
        threadId,
        commentId,
        authorId: input.createdBy,
      }, `review:comment:${commentId}`);
    });
    this.recomputeTarget(input.target.id);
    return this.getThread(threadId)!;
  }

  private insertComment(threadId: string, authorId: string, authorKind: "human" | "agent", body: string, at = now()): string {
    const id = reviewId("comment");
    this.db
      .prepare(
        `INSERT INTO review_comments(id, thread_id, author_id, author_kind, body, body_hash, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(id, threadId, authorId, authorKind, body, crypto.createHash("sha256").update(body).digest("hex"), at);
    return id;
  }

  addReply(threadId: string, authorId: string, body: string): ReviewComment {
    const thread = this.getThread(threadId);
    if (!thread) throw new Error("thread not found");
    const target = this.getTargetById(thread.targetId);
    if (!target) throw new Error("target not found");
    const commentId = this.insertComment(threadId, authorId, "human", body);
    this.appendEvent(target, "review.comment_added", { threadId, commentId, authorId }, `review:comment:${commentId}`);
    return this.listComments(threadId).find((comment) => comment.id === commentId)!;
  }

  editComment(commentId: string, actor: string, body: string): ReviewComment {
    const row = this.db.prepare("SELECT * FROM review_comments WHERE id = ?").get(commentId) as Row | undefined;
    if (!row) throw new Error("comment not found");
    const at = now();
    this.db
      .prepare("UPDATE review_comments SET body = ?, body_hash = ?, edited_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(body, crypto.createHash("sha256").update(body).digest("hex"), at, commentId);
    const thread = this.getThread(String(row.thread_id));
    const target = thread ? this.getTargetById(thread.targetId) : null;
    if (target) this.appendEvent(target, "review.comment_edited", { threadId: thread!.id, commentId, actorId: actor, bodyHash: crypto.createHash("sha256").update(body).digest("hex") }, `review:comment-edit:${commentId}:${at}`);
    return this.listComments(String(row.thread_id)).find((comment) => comment.id === commentId)!;
  }

  deleteComment(commentId: string, actor: string): ReviewComment {
    const row = this.db.prepare("SELECT * FROM review_comments WHERE id = ?").get(commentId) as Row | undefined;
    if (!row) throw new Error("comment not found");
    const at = now();
    this.db
      .prepare("UPDATE review_comments SET deleted_at = ?, deleted_by = ? WHERE id = ?")
      .run(at, actor, commentId);
    const thread = this.getThread(String(row.thread_id));
    const target = thread ? this.getTargetById(thread.targetId) : null;
    if (target) this.appendEvent(target, "review.comment_deleted", { threadId: thread!.id, commentId, actorId: actor, bodyHash: String(row.body_hash) }, `review:comment-delete:${commentId}:${at}`);
    return this.listComments(String(row.thread_id)).find((comment) => comment.id === commentId)!;
  }

  listComments(threadId: string): ReviewComment[] {
    const rows = this.db.prepare("SELECT * FROM review_comments WHERE thread_id = ? ORDER BY created_at ASC").all(threadId) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      threadId: String(row.thread_id),
      authorId: String(row.author_id),
      authorKind: String(row.author_kind) as ReviewComment["authorKind"],
      body: String(row.body),
      bodyHash: String(row.body_hash),
      createdAt: String(row.created_at),
      editedAt: row.edited_at ? String(row.edited_at) : null,
      deletedAt: row.deleted_at ? String(row.deleted_at) : null,
      deletedBy: row.deleted_by ? String(row.deleted_by) : null,
    }));
  }

  getThread(threadId: string): ReviewThread | null {
    const row = this.db.prepare("SELECT * FROM review_threads WHERE id = ?").get(threadId) as Row | undefined;
    return row ? this.toThread(row) : null;
  }

  listThreads(targetId: string, file?: string, status?: string): ReviewThread[] {
    const rows = (file
      ? this.db
          .prepare("SELECT * FROM review_threads WHERE target_id = ? AND file_path = ? ORDER BY created_at ASC")
          .all(targetId, file)
      : this.db.prepare("SELECT * FROM review_threads WHERE target_id = ? ORDER BY created_at ASC").all(targetId)) as Row[];
    return rows
      .map((row) => this.toThread(row))
      .filter((thread) => !status || status === "all" || thread.status === status);
  }

  setThreadStatus(threadId: string, status: "open" | "resolved", actor: string, note?: string): ReviewThread {
    const thread = this.getThread(threadId);
    if (!thread) throw new Error("thread not found");
    const target = this.getTargetById(thread.targetId);
    this.db
      .prepare(
        "UPDATE review_threads SET status = ?, resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE id = ?",
      )
      .run(status, status === "resolved" ? actor : null, status === "resolved" ? now() : null, note ?? null, threadId);
    if (target) {
      this.appendEvent(target, status === "resolved" ? "review.thread_resolved" : "review.thread_reopened", {
        threadId,
        actor,
      }, `${status === "resolved" ? "review:resolve" : "review:reopen"}:${threadId}:${now()}`);
    }
    this.recomputeTarget(thread.targetId);
    return this.getThread(threadId)!;
  }

  setSeverity(threadId: string, severity: ReviewThread["severity"], actor: string): ReviewThread {
    const thread = this.getThread(threadId);
    if (!thread) throw new Error("thread not found");
    this.db.prepare("UPDATE review_threads SET severity = ? WHERE id = ?").run(severity, threadId);
    const target = this.getTargetById(thread.targetId);
    if (target) this.appendEvent(target, "review.severity_changed", { threadId, from: thread.severity, to: severity, actor }, `review:sev:${threadId}:${now()}`);
    this.recomputeTarget(thread.targetId);
    return this.getThread(threadId)!;
  }

  insertDecision(input: {
    target: ReviewTarget;
    reviewerId: string;
    decision: ReviewDecisionRecord["decision"];
    headSha: string;
    notes: string | null;
    blockerCount: number;
    clientRequestId?: string | null;
  }): ReviewDecisionRecord {
    const existing = this.db
      .prepare(
        `SELECT * FROM review_decisions WHERE target_id = ? AND reviewer_id = ? AND head_sha = ? AND is_current = 1`,
      )
      .get(input.target.id, input.reviewerId, input.headSha) as Row | undefined;
    if (input.clientRequestId) {
      const replay = this.db
        .prepare("SELECT * FROM review_decisions WHERE client_request_id = ?")
        .get(input.clientRequestId) as Row | undefined;
      if (replay) return this.toDecision(replay);
    }
    const revision = existing ? Number(existing.revision) + 1 : 1;
    const id = reviewId("decision");
    const supersedes = existing ? String(existing.id) : null;
    this.store.withTransaction(() => {
      if (existing) {
        this.db
          .prepare("UPDATE review_decisions SET is_current = 0 WHERE id = ?")
          .run(String(existing.id));
      }
      this.db
        .prepare(
          `INSERT INTO review_decisions(
             id, target_id, workspace_id, task_id, reviewer_id, decision, head_sha, blocker_count,
             notes, revision, is_current, supersedes_id, client_request_id, created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
        )
        .run(
          id,
          input.target.id,
          input.target.workspaceId,
          input.target.taskId,
          input.reviewerId,
          input.decision,
          input.headSha,
          input.blockerCount,
          input.notes,
          revision,
          supersedes,
          input.clientRequestId ?? null,
          now(),
        );
      this.db
        .prepare("UPDATE review_targets SET last_decision_id = ?, updated_at = ? WHERE id = ?")
        .run(id, now(), input.target.id);
      this.appendEvent(input.target, "review.decision", {
        reviewerId: input.reviewerId,
        decision: input.decision,
        headSha: input.headSha,
        revision,
        supersedesId: supersedes,
        blockerCount: input.blockerCount,
      }, `review:decision:${input.target.id}:${input.reviewerId}:${input.headSha}:${revision}`);
    });
    return this.getDecision(id)!;
  }

  getDecision(id: string): ReviewDecisionRecord | null {
    const row = this.db.prepare("SELECT * FROM review_decisions WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toDecision(row) : null;
  }

  listDecisions(targetId: string): ReviewDecisionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM review_decisions WHERE target_id = ? ORDER BY created_at DESC, revision DESC")
      .all(targetId) as Row[];
    return rows.map((row) => this.toDecision(row));
  }

  currentDecisions(targetId: string, headSha: string): ReviewDecisionRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM review_decisions WHERE target_id = ? AND head_sha = ? AND is_current = 1 ORDER BY created_at DESC",
      )
      .all(targetId, headSha) as Row[];
    return rows.map((row) => this.toDecision(row));
  }

  countBlockers(targetId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM review_threads WHERE target_id = ? AND severity = 'blocker' AND status IN ('open','outdated')",
      )
      .get(targetId) as { n: number };
    return Number(row.n);
  }

  recomputeTarget(targetId: string): void {
    const target = this.getTargetById(targetId);
    if (!target) return;
    const blockers = this.countBlockers(targetId);
    const current = this.currentDecisions(targetId, target.headSha);
    const approvals = current.filter((decision) => decision.decision === "approve").length;
    const changes = current.some((decision) => decision.decision === "request_changes");
    const stale = target.status === "stale" || target.status === "unavailable";
    const status: ReviewTarget["status"] = stale
      ? target.status
      : changes
        ? "changes_requested"
        : blockers > 0
          ? "pending"
          : approvals >= 1
            ? "approved"
            : "pending";
    this.db
      .prepare(
        "UPDATE review_targets SET blocker_count = ?, approval_count = ?, status = ?, updated_at = ? WHERE id = ?",
      )
      .run(blockers, approvals, status, now(), targetId);
  }

  markReviewerDecision(targetId: string, reviewerId: string, status: ReviewReviewer["status"]): void {
    this.db
      .prepare("UPDATE review_reviewers SET status = ?, decided_at = ? WHERE target_id = ? AND reviewer_id = ?")
      .run(status, now(), targetId, reviewerId);
  }

  appendEvent(target: ReviewTarget, type: string, payload: Record<string, unknown>, idempotencyKey?: string): void {
    this.store.appendEvent({
      aggregateType: "task",
      aggregateId: target.taskId,
      type,
      actor: "user",
      payload: { targetId: target.id, ...payload },
      schemaVersion: 2,
      idempotencyKey: idempotencyKey ?? null,
    });
  }

  private toTarget(row: Row): ReviewTarget {
    const id = String(row.id);
    return {
      id,
      workspaceId: String(row.workspace_id),
      taskId: String(row.task_id),
      authorAgentId: row.author_agent_id ? String(row.author_agent_id) : null,
      requesterId: String(row.requester_id),
      requesterKind: String(row.requester_kind) as ReviewTarget["requesterKind"],
      provider: String(row.provider),
      prNumber: row.pr_number == null ? null : Number(row.pr_number),
      prUrl: row.pr_url ? String(row.pr_url) : null,
      baseBranch: String(row.base_branch),
      baseSha: String(row.base_sha),
      headSha: String(row.head_sha),
      mergeBaseSha: String(row.merge_base_sha),
      diffHash: String(row.diff_hash),
      status: String(row.status) as ReviewTarget["status"],
      requiredApprovals: 1,
      approvalCount: Number(row.approval_count),
      blockerCount: Number(row.blocker_count),
      staleReason: row.stale_reason ? String(row.stale_reason) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      reviewers: this.listReviewers(id),
    };
  }

  private toDecision(row: Row): ReviewDecisionRecord {
    return {
      id: String(row.id),
      targetId: String(row.target_id),
      reviewerId: String(row.reviewer_id),
      decision: String(row.decision) as ReviewDecisionRecord["decision"],
      headSha: String(row.head_sha),
      revision: Number(row.revision),
      isCurrent: bool(row.is_current),
      supersedesId: row.supersedes_id ? String(row.supersedes_id) : null,
      invalidatedReason: row.invalidated_reason ? String(row.invalidated_reason) : null,
      notes: row.notes ? String(row.notes) : null,
      createdAt: String(row.created_at),
    };
  }

  private toThread(row: Row): ReviewThread {
    return {
      id: String(row.id),
      targetId: String(row.target_id),
      filePath: String(row.file_path),
      oldPath: row.old_path ? String(row.old_path) : null,
      side: String(row.side) as ReviewThread["side"],
      lineStart: Number(row.line_start),
      lineEnd: Number(row.line_end),
      severity: String(row.severity) as ReviewThread["severity"],
      status: String(row.status) as ReviewThread["status"],
      anchorHeadSha: String(row.anchor_head_sha),
      contextBefore: parseContext(row.context_before),
      contextAfter: parseContext(row.context_after),
      createdBy: String(row.created_by),
      createdAt: String(row.created_at),
      resolvedBy: row.resolved_by ? String(row.resolved_by) : null,
      resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
      resolutionNote: row.resolution_note ? String(row.resolution_note) : null,
      outdatedReason: row.outdated_reason ? String(row.outdated_reason) : null,
      comments: this.listComments(String(row.id)),
    };
  }
}
