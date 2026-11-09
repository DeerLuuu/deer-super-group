import type { Store } from "../kernel/store.js";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { ChecksRunner } from "./checksRunner.js";
import { detectConflict, verifyIntegratedContent } from "./branchOps.js";
import type { GitExec } from "./gitExec.js";
import type { GitStore } from "./gitStore.js";
import type {
  GitSettings,
  MergeQueueItem,
  MergeQueueSnapshot,
  PrInfo,
  PrProvider,
  RepoInfo,
  TreeVerification,
} from "./types.js";

export interface QueueContext {
  repo: RepoInfo;
  git: GitExec;
  provider: PrProvider;
  settings: GitSettings;
}

export interface MergeQueueDeps {
  store: Store;
  gitStore: GitStore;
  checks: ChecksRunner;
  contextFor(workspaceId: string): Promise<QueueContext | null>;
  createConflictTask(input: {
    workspaceId: string;
    taskId: string;
    taskTitle: string;
    branch: string;
    baseBranch: string;
    prNumber: number | null;
    prUrl: string | null;
    conflictFiles: string[];
    baseSha: string | null;
  }): Promise<{ taskId: string; created: boolean }>;
}

function now(): string {
  return new Date().toISOString();
}

function queueId(): string {
  return `mq_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function isActive(state: MergeQueueItem["state"]): boolean {
  return ["queued", "waiting_checks", "waiting_review", "ready", "updating", "merging"].includes(state);
}

function event(
  store: Store,
  workspaceId: string,
  type: string,
  payload: unknown,
  taskId?: string,
): void {
  try {
    store.appendEvent({
      aggregateType: taskId ? "task" : "workspace",
      aggregateId: taskId ?? workspaceId,
      type,
      actor: "merge-queue",
      payload,
    });
  } catch {
    // audit must not break queue
  }
}

export class MergeQueue {
  constructor(private readonly deps: MergeQueueDeps) {}

  private fill(item: MergeQueueItem): MergeQueueItem {
    const task = this.deps.store.getTask(item.taskId);
    return { ...item, taskTitle: task?.title ?? item.taskId };
  }

  list(workspaceId: string): MergeQueueSnapshot {
    const items = this.deps.gitStore.listQueue(workspaceId).map((item) => this.fill(item));
    return {
      workspaceId,
      items,
      activeMerge: items.find((item) => item.state === "merging")?.id ?? null,
      updatedAt: now(),
    };
  }

  async enqueue(taskId: string): Promise<MergeQueueItem> {
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const vcs = this.deps.gitStore.getTaskVcs(taskId);
    if (!vcs || !vcs.branch) throw new Error("task has no Git branch; run the task first");
    const existing = this.deps.gitStore.getQueueForTask(taskId);
    if (existing && isActive(existing.state)) return this.fill(existing);
    const context = await this.deps.contextFor(task.workspaceId);
    if (!context) throw new Error("git context unavailable");
    const head = vcs.headSha ?? vcs.branch;
    const item: MergeQueueItem = {
      id: queueId(),
      workspaceId: task.workspaceId,
      taskId,
      taskTitle: task.title,
      provider: context.provider.id,
      prNumber: vcs.pr?.number ?? null,
      prUrl: vcs.pr?.url ?? null,
      branch: vcs.branch,
      state: "waiting_checks",
      position: this.deps.gitStore.nextQueuePosition(task.workspaceId),
      headSha: head,
      baseSha: null,
      approvedHeadSha: null,
      checks: { state: "none", summary: "" },
      checksWaived: false,
      retryAt: null,
      review: "pending",
      conflictTaskId: null,
      lastError: null,
      mergeCommitSha: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.deps.gitStore.insertQueue(item);
    event(this.deps.store, task.workspaceId, "merge.enqueued", {
      queueId: item.id,
      position: item.position,
      taskId,
      pr: item.prNumber,
    }, taskId);
    return this.fill(item);
  }

  async approve(taskId: string): Promise<MergeQueueItem> {
    const item = this.deps.gitStore.getQueueForTask(taskId);
    if (!item) throw new Error("task is not in the merge queue");
    this.deps.gitStore.updateQueue(item.id, { approvedHeadSha: item.headSha });
    const current = this.deps.gitStore.getQueueItem(item.id);
    if (!current) throw new Error("queue item disappeared");
    event(this.deps.store, current.workspaceId, "merge.approved", {
      queueId: current.id,
      actor: "user",
      headSha: item.headSha,
    }, taskId);
    return this.fill(current);
  }

  async waiveChecks(taskId: string, reason: string): Promise<MergeQueueItem> {
    if (reason.trim().length < 8) throw new Error("waive reason must be at least 8 characters");
    const item = this.deps.gitStore.getQueueForTask(taskId);
    if (!item) throw new Error("task is not in the merge queue");
    const task = this.deps.store.getTask(taskId);
    const repo = task ? await this.deps.contextFor(task.workspaceId) : null;
    if (!repo) throw new Error("git context unavailable");
    if (repo.settings.checksCommand) throw new Error("cannot waive checks when checks_command is configured");
    this.deps.gitStore.updateQueue(item.id, { checksWaived: true });
    event(this.deps.store, item.workspaceId, "merge.checks_waived", {
      queueId: item.id,
      actor: "user",
      headSha: item.headSha,
      reason,
    }, taskId);
    return this.fill(this.deps.gitStore.getQueueItem(item.id) ?? item);
  }

  async mergeStart(taskId: string): Promise<MergeQueueItem> {
    const item = this.deps.gitStore.getQueueForTask(taskId);
    if (!item) throw new Error("task is not in the merge queue");
    if (item.approvedHeadSha !== item.headSha) throw new Error("merge approval is stale for current head");
    this.deps.gitStore.updateQueue(item.id, { state: "ready" });
    return this.process(item.workspaceId, item.id);
  }

  async process(workspaceId: string, onlyId?: string): Promise<MergeQueueItem> {
    const snapshot = this.list(workspaceId);
    const activeMerge = snapshot.items.find((item) => item.state === "merging");
    if (activeMerge && activeMerge.id !== onlyId) {
      throw new Error("another merge is in progress");
    }
    const target = onlyId
      ? snapshot.items.find((item) => item.id === onlyId)
      : snapshot.items.find(
          (item) =>
            ["queued", "waiting_checks", "waiting_review", "ready", "updating"].includes(item.state) &&
            !item.retryAt,
        );
    if (!target) throw new Error("no merge queue item ready");
    return this.processItem(target);
  }

  private async processItem(item: MergeQueueItem): Promise<MergeQueueItem> {
    const context = await this.deps.contextFor(item.workspaceId);
    if (!context) {
      this.deps.gitStore.updateQueue(item.id, { state: "blocked", lastError: "git context unavailable" });
      return this.fill(this.deps.gitStore.getQueueItem(item.id) ?? item);
    }
    let pr: PrInfo;
    try {
      pr = await context.provider.refresh(context.repo, {
        number: item.prNumber,
        branch: item.branch ?? "",
      });
    } catch (error) {
      this.deps.gitStore.updateQueue(item.id, {
        state: "blocked",
        lastError: error instanceof Error ? error.message : String(error),
      });
      event(this.deps.store, item.workspaceId, "merge.blocked", {
        queueId: item.id,
        reason: "refresh_failed",
      }, item.taskId);
      return this.fill(this.deps.gitStore.getQueueItem(item.id) ?? item);
    }

    if (pr.state === "merged") {
      this.deps.gitStore.updateQueue(item.id, {
        state: "merged",
        mergeCommitSha: pr.mergedCommitSha,
        lastError: null,
      });
      this.recordTaskVcs(item, "merged", pr.mergedCommitSha);
      event(this.deps.store, item.workspaceId, "merge.merged", {
        queueId: item.id,
        mergeCommitSha: pr.mergedCommitSha,
      }, item.taskId);
      return this.fill(this.deps.gitStore.getQueueItem(item.id) ?? item);
    }

    if (item.headSha && pr.headSha && pr.headSha !== item.headSha) {
      // A new head invalidates approval and waivers; require a new review.
      this.deps.gitStore.updateQueue(item.id, {
        state: "waiting_review",
        headSha: pr.headSha,
        approvedHeadSha: null,
        checksWaived: false,
        lastError: null,
      });
      event(this.deps.store, item.workspaceId, "merge.approval_reset", {
        queueId: item.id,
        oldHeadSha: item.headSha,
        newHeadSha: pr.headSha,
        reason: "head_changed",
      }, item.taskId);
      return this.fill(this.deps.gitStore.getQueueItem(item.id) ?? item);
    }

    const checkResult = await this.runChecks(item, context, pr);
    if (checkResult.state === "failed") {
      this.deps.gitStore.updateQueue(item.id, {
        state: "failed",
        lastError: checkResult.detail ?? "checks failed",
      });
      event(this.deps.store, item.workspaceId, "merge.checks_failed", {
        queueId: item.id,
        headSha: item.headSha,
        checks: checkResult.detail,
      }, item.taskId);
      return this.fill(this.deps.gitStore.getQueueItem(item.id) ?? item);
    }
    if (checkResult.state === "pending") {
      this.deps.gitStore.updateQueue(item.id, { state: "waiting_checks" });
      event(this.deps.store, item.workspaceId, "merge.checks_pending", {
        queueId: item.id,
        headSha: item.headSha,
        checks: checkResult.summary,
      }, item.taskId);
      return this.fill(this.deps.gitStore.getQueueItem(item.id) ?? item);
    }

    const approved = item.approvedHeadSha === item.headSha;
    if (context.settings.requireApproval && !approved) {
      this.deps.gitStore.updateQueue(item.id, { state: "waiting_review" });
      return this.fill(this.deps.gitStore.getQueueItem(item.id) ?? item);
    }
    if (!context.settings.autoMerge) {
      this.deps.gitStore.updateQueue(item.id, { state: "ready" });
      return this.fill(this.deps.gitStore.getQueueItem(item.id) ?? item);
    }

    if (pr.mergeable === "conflicting") {
      return this.handleConflict(item, context, pr);
    }
    if (context.provider.id !== "github") {
      // Local/manual flows are merged by the user; queue stops at ready and
      // the caller verifies integrated content explicitly (verifyIntegrated).
      this.deps.gitStore.updateQueue(item.id, { state: "ready", lastError: "manual merge required" });
      return this.fill(this.deps.gitStore.getQueueItem(item.id) ?? item);
    }

    this.deps.gitStore.updateQueue(item.id, {
      state: "merging",
      attempts: (item.attempts ?? 0) + 1,
      headSha: pr.headSha || item.headSha,
    });
    event(this.deps.store, item.workspaceId, "merge.started", {
      queueId: item.id,
      attempt: (item.attempts ?? 0) + 1,
      headSha: item.headSha,
      baseSha: item.baseSha,
    }, item.taskId);
    try {
      const merged = await context.provider.merge(
        context.repo,
        { number: item.prNumber, branch: item.branch ?? "", headSha: item.headSha },
        { method: context.settings.mergeMethod },
      );
      const result = merged.state === "merged" ? merged : await context.provider.refresh(context.repo, {
        number: item.prNumber,
        branch: item.branch ?? "",
      });
      if (result.state !== "merged") {
        this.deps.gitStore.updateQueue(item.id, {
          state: "blocked",
          lastError: "merge result unknown",
        });
        return this.fill(this.deps.gitStore.getQueueItem(item.id) ?? item);
      }
      this.deps.gitStore.updateQueue(item.id, {
        state: "merged",
        mergeCommitSha: result.mergedCommitSha,
        lastError: null,
      });
      this.recordTaskVcs(item, "merged", result.mergedCommitSha);
      event(this.deps.store, item.workspaceId, "merge.merged", {
        queueId: item.id,
        mergeCommitSha: result.mergedCommitSha,
      }, item.taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/CONFLICT/i.test(message)) {
        return this.handleConflict(item, context, pr);
      }
      this.deps.gitStore.updateQueue(item.id, {
        state: "failed",
        lastError: message,
      });
      event(this.deps.store, item.workspaceId, "merge.failed", {
        queueId: item.id,
        errorCode: message,
        attempts: (item.attempts ?? 0) + 1,
      }, item.taskId);
    }
    return this.fill(this.deps.gitStore.getQueueItem(item.id) ?? item);
  }

  private async runChecks(
    item: MergeQueueItem,
    context: QueueContext,
    pr: PrInfo,
  ): Promise<{ state: "passed" | "failed" | "pending"; summary: string; detail?: string }> {
    const required = context.settings.requiredChecks;
    const checks = pr.checks.length ? pr.checks : [];
    if (checks.length) {
      const relevant = required.length ? checks.filter((check) => required.includes(check.name)) : checks;
      if (relevant.some((check) => check.status === "failed")) {
        return { state: "failed", summary: "provider checks failed", detail: relevant.map((c) => c.name).join(",") };
      }
      if (relevant.some((check) => check.status === "queued" || check.status === "in_progress")) {
        return { state: "pending", summary: "provider checks pending" };
      }
      if (relevant.length) {
        this.deps.gitStore.upsertCheck({
          id: `gh_${item.id}_${item.headSha}`,
          taskId: item.taskId,
          source: "github",
          headSha: item.headSha,
          name: "provider",
          state: "passed",
          detail: relevant.map((c) => c.name).join(","),
          updatedAt: now(),
        });
        return { state: "passed", summary: "provider checks passed" };
      }
    }
    if (item.checksWaived) return { state: "passed", summary: "checks waived" };
    if (!context.settings.checksCommand) {
      return context.settings.requireApproval
        ? { state: "passed", summary: "no checks configured; approval required" }
        : { state: "passed", summary: "no checks configured" };
    }
    // Run checks in a detached `_checks` worktree so they cannot dirty the
    // task's finalize worktree. Fall back only if the worktree cannot be made.
    let checksCwd = this.deps.store.getTask(item.taskId)?.worktree ?? this.deps.store.getWorkspace(item.workspaceId)?.path ?? ".";
    let createdChecksTree = false;
    if (context.repo.runtimeRoot && item.headSha) {
      const checksPath = path.join(
        context.repo.runtimeRoot,
        "worktrees",
        "_checks",
        `${item.id}-${item.headSha.slice(0, 7)}`,
      );
      try {
        mkdirSync(path.dirname(checksPath), { recursive: true });
        const add = await context.git.run(["worktree", "add", "--detach", checksPath, item.headSha], {
          cwd: context.repo.root ?? context.repo.workspacePath,
          timeoutMs: 60_000,
        });
        if (add.code === 0) {
          checksCwd = checksPath;
          createdChecksTree = true;
        }
      } catch {
        createdChecksTree = false;
      }
    }
    const result = await this.deps.checks.run({
      command: context.settings.checksCommand,
      cwd: checksCwd,
      timeoutMs: context.settings.checksTimeoutMs,
      mode: context.settings.checksMode,
    });
    if (createdChecksTree) {
      await context.git.run(["worktree", "remove", "--force", checksCwd], {
        cwd: context.repo.root ?? context.repo.workspacePath,
        timeoutMs: 30_000,
      });
    }
    this.deps.gitStore.upsertCheck({
      id: `local_${item.id}_${item.headSha}`,
      taskId: item.taskId,
      source: "local",
      headSha: item.headSha,
      name: "local:checks",
      state: result.state,
      detail: result.output.slice(0, 4000),
      updatedAt: now(),
    });
    return {
      state: result.ok ? "passed" : "failed",
      summary: result.ok ? "local checks passed" : "local checks failed",
      detail: result.output.slice(0, 4000),
    };
  }

  private async handleConflict(
    item: MergeQueueItem,
    context: QueueContext,
    pr: PrInfo,
  ): Promise<MergeQueueItem> {
    const branch = item.branch ?? "";
    let conflictFiles: string[] = [];
    const base = context.repo.baseBranch;
    try {
      const conflict = await detectConflict({
        git: context.git,
        cwd: context.repo.root ?? context.repo.workspacePath,
        base,
        head: item.headSha,
      });
      if (conflict) conflictFiles = [];
    } catch {
      conflictFiles = [];
    }
    if (item.conflictTaskId) {
      this.deps.gitStore.updateQueue(item.id, { state: "blocked" });
      return this.fill(this.deps.gitStore.getQueueItem(item.id) ?? item);
    }
    const task = this.deps.store.getTask(item.taskId);
    const conflict = await this.deps.createConflictTask({
      workspaceId: item.workspaceId,
      taskId: item.taskId,
      taskTitle: task?.title ?? item.taskId,
      branch,
      baseBranch: base,
      prNumber: item.prNumber,
      prUrl: pr.url,
      conflictFiles,
      baseSha: item.baseSha,
    });
    this.deps.gitStore.updateQueue(item.id, {
      state: "blocked",
      conflictTaskId: conflict.taskId,
      lastError: "merge conflict",
    });
    event(this.deps.store, item.workspaceId, "merge.blocked", {
      queueId: item.id,
      reason: "conflict",
      conflictTaskId: conflict.taskId,
    }, item.taskId);
    event(this.deps.store, item.workspaceId, "merge.conflict_task_created", {
      queueId: item.id,
      conflictTaskId: conflict.taskId,
      sourceTaskId: item.taskId,
      pr: item.prNumber,
    }, item.taskId);
    return this.fill(this.deps.gitStore.getQueueItem(item.id) ?? item);
  }

  /**
   * Verify a local/manual merge result using tree/patch content, not only
   * ancestor (squash/rebase rewrites head).
   */
  async verifyIntegrated(input: {
    workspaceId: string;
    taskId: string;
    integratedRef: string;
    allowAncestor?: boolean;
  }): Promise<TreeVerification> {
    const context = await this.deps.contextFor(input.workspaceId);
    if (!context) return { ok: false, method: "content", reason: "git context unavailable" };
    const vcs = this.deps.gitStore.getTaskVcs(input.taskId);
    if (!vcs?.headSha) return { ok: false, method: "content", reason: "no head sha" };
    return verifyIntegratedContent({
      git: context.git,
      cwd: context.repo.root ?? context.repo.workspacePath,
      headSha: vcs.headSha,
      integratedRef: input.integratedRef,
      allowAncestor: input.allowAncestor,
    });
  }

  async recover(workspaceId: string): Promise<number> {
    const items = this.list(workspaceId).items;
    let repaired = 0;
    for (const item of items) {
      if (!["merging", "updating"].includes(item.state)) continue;
      const context = await this.deps.contextFor(workspaceId);
      if (!context) continue;
      try {
        const pr = await context.provider.refresh(context.repo, {
          number: item.prNumber,
          branch: item.branch ?? "",
        });
        if (pr.state === "merged") {
          this.deps.gitStore.updateQueue(item.id, {
            state: "merged",
            mergeCommitSha: pr.mergedCommitSha,
            lastError: null,
          });
          this.recordTaskVcs(item, "merged", pr.mergedCommitSha);
        } else if (pr.mergeable === "conflicting") {
          this.deps.gitStore.updateQueue(item.id, {
            state: "waiting_review",
            headSha: pr.headSha || item.headSha,
            approvedHeadSha: null,
            checksWaived: false,
            lastError: "recovered_conflict",
          });
        } else {
          this.deps.gitStore.updateQueue(item.id, {
            state: "ready",
            headSha: pr.headSha || item.headSha,
            lastError: null,
          });
        }
        repaired += 1;
      } catch {
        this.deps.gitStore.updateQueue(item.id, { state: "blocked", lastError: "recovery_unknown" });
      }
    }
    return repaired;
  }

  private recordTaskVcs(item: MergeQueueItem, state: string, commitSha: string | null): void {
    const vcs = this.deps.gitStore.getTaskVcs(item.taskId);
    if (!vcs) return;
    this.deps.gitStore.upsertTaskVcs({
      ...vcs,
      merge: { state, commitSha },
      updatedAt: now(),
    });
  }
}
