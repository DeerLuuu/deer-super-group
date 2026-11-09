import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Store } from "../kernel/store.js";
import { detectRepo, ensureHooksDir, runtimeHooksPath } from "./repo.js";
import { GitExec } from "./gitExec.js";
import { GitStore } from "./gitStore.js";
import type { GitSettings, PrepareRunInput, PrepareRunResult, WorktreeRecord } from "./types.js";

const MAX_WORKTREES_HARD_LIMIT = 3;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";
}

export function branchName(taskId: string, title: string): string {
  return `deer/${taskId}-${slugify(title)}`;
}

function newWorktreeId(): string {
  return `wt_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export interface PreparedRepo {
  repo: Awaited<ReturnType<typeof detectRepo>>;
  git: GitExec;
  settings: GitSettings;
}

export class WorktreeManager {
  constructor(
    private readonly store: Store,
    private readonly gitStore: GitStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async repoFor(workspaceId: string): Promise<PreparedRepo | null> {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) return null;
    const settings = this.gitStore.getConfig(workspaceId);
    const repo = await detectRepo(workspace.path, settings.baseBranch);
    if (!repo.ok) return null;
    ensureHooksDir(repo);
    const hooks = runtimeHooksPath(repo);
    if (!hooks) return null;
    return { repo, git: new GitExec(hooks), settings };
  }

  async prepare(input: PrepareRunInput): Promise<PrepareRunResult> {
    const workspace = this.store.getWorkspace(input.workspaceId);
    if (!workspace) {
      return { ok: false, defer: false, errorCode: "GIT_REPO_NOT_FOUND", message: "workspace not found" };
    }
    const settings = this.gitStore.getConfig(input.workspaceId);
    if (settings.mode === "off") {
      return {
        ok: true,
        cwd: workspace.path,
        branch: null,
        sandboxId: `workspace:${workspace.id}`,
        mode: "degraded",
      };
    }
    const repo = await detectRepo(workspace.path, settings.baseBranch);
    if (!repo.ok) {
      this.gitStore.upsertTaskVcs({
        taskId: input.taskId,
        workspaceId: workspace.id,
        mode: "degraded",
        branch: null,
        baseBranch: settings.baseBranch,
        headSha: null,
        pr: null,
        merge: { state: "none", commitSha: null },
        checksState: "none",
        conflictTaskId: null,
        degradedReason: repo.reason ?? "git unavailable",
        errorCode: repo.errorCode ?? "GIT_NOT_FOUND",
        updatedAt: this.now(),
      });
      this.event(input.workspaceId, "task", input.taskId, "git.degraded", {
        reason: repo.reason ?? "git unavailable",
        workspacePath: workspace.path,
      });
      return {
        ok: true,
        cwd: workspace.path,
        branch: null,
        sandboxId: `workspace:${workspace.id}`,
        mode: "degraded",
      };
    }
    ensureHooksDir(repo);
    const hooksPath = runtimeHooksPath(repo);
    if (!hooksPath) {
      return { ok: false, defer: false, errorCode: "GIT_REPO_NOT_FOUND", message: "runtime root unavailable" };
    }
    const git = new GitExec(hooksPath);
    const maxWorktrees = Math.min(
      MAX_WORKTREES_HARD_LIMIT,
      Math.max(1, Number(settings.maxWorktrees) || 3),
    );
    const activeForTask = this.gitStore.getActiveWorktreeForTask(input.taskId);
    if (this.gitStore.countActiveWorktrees(workspace.id) >= maxWorktrees && !activeForTask) {
      return {
        ok: false,
        defer: true,
        retryAfterMs: 15_000,
        reason: "GIT_CAPACITY",
      };
    }

    const task = this.store.getTask(input.taskId);
    if (!task) {
      return { ok: false, defer: false, errorCode: "GIT_WORKTREE_FAILED", message: "task not found" };
    }
    const branch = task.branch && task.branch.startsWith("deer/")
      ? task.branch
      : branchName(task.id, task.title);
    const branchCheck = await git.run(["check-ref-format", "--branch", branch], { cwd: repo.root ?? workspace.path });
    if (branchCheck.code !== 0) {
      return { ok: false, defer: false, errorCode: "GIT_BRANCH_INVALID", message: "invalid branch name" };
    }

    const existing = this.gitStore.getActiveWorktreeForTask(task.id);
    if (existing) {
      const existingRun = existing.runId ? this.store.getRun(existing.runId) : null;
      const active =
        existingRun &&
        ["running", "waiting_human", "queued"].includes(existingRun.status) &&
        existing.leaseExpiresAt &&
        Date.parse(existing.leaseExpiresAt) > Date.now();
      if (existing.runId !== input.runId && active) {
        return {
          ok: false,
          defer: true,
          retryAfterMs: 15_000,
          reason: "GIT_WORKTREE_BUSY",
        };
      }
      await this.removeWorktree(existing, "reclaimed", input.workspaceId);
    }

    const attempt = Math.max(1, Math.floor(input.attempt));
    const runtimeRoot = repo.runtimeRoot ?? path.join(workspace.path, ".deer");
    const worktreePath = path.join(runtimeRoot, "worktrees", task.id, String(attempt));
    const resolvedPath = path.resolve(worktreePath);
    const resolvedRoot = path.resolve(runtimeRoot);
    if (!resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
      return { ok: false, defer: false, errorCode: "GIT_PATH_ESCAPE", message: "worktree path escapes runtime root" };
    }
    if (existsSync(worktreePath)) {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        // git worktree remove below will report a clear error if still present
      }
    }
    try {
      mkdirSync(path.dirname(worktreePath), { recursive: true });
    } catch (error) {
      return {
        ok: false,
        defer: false,
        errorCode: "GIT_WORKTREE_FAILED",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const existsBranch = await git.run(["rev-parse", "--verify", branch], { cwd: repo.root ?? workspace.path });
    const add =
      existsBranch.code === 0
        ? await git.run(["worktree", "add", worktreePath, branch], { cwd: repo.root ?? workspace.path, timeoutMs: 120_000 })
        : await git.run(
            ["worktree", "add", "-b", branch, worktreePath, settings.baseBranch],
            { cwd: repo.root ?? workspace.path, timeoutMs: 120_000 },
          );
    if (add.code !== 0) {
      this.event(input.workspaceId, "task", task.id, "git.worktree_orphaned", {
        taskId: task.id,
        path: worktreePath,
        reason: add.stderr || "worktree add failed",
      });
      return {
        ok: false,
        defer: false,
        errorCode: "GIT_WORKTREE_FAILED",
        message: add.stderr || "worktree add failed",
      };
    }

    const record: WorktreeRecord = {
      id: newWorktreeId(),
      workspaceId: workspace.id,
      taskId: task.id,
      branchTaskId: task.id,
      runId: input.runId,
      path: worktreePath,
      branch,
      state: "active",
      leaseOwner: "git-service",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.gitStore.insertWorktree(record);
    this.store.updateTask(task.id, { branch, worktree: worktreePath });
    this.gitStore.upsertRunVcs({
      runId: input.runId,
      taskId: task.id,
      worktreePath,
      branch,
      baseSha: null,
      commitSha: null,
      prNumber: null,
      mode: "git",
    });
    this.gitStore.upsertTaskVcs({
      taskId: task.id,
      workspaceId: workspace.id,
      mode: "git",
      branch,
      baseBranch: settings.baseBranch,
      headSha: null,
      pr: null,
      merge: { state: "none", commitSha: null },
      checksState: "none",
      conflictTaskId: null,
      errorCode: null,
      updatedAt: this.now(),
    });
    this.event(workspace.id, "task", task.id, "git.worktree_created", {
      taskId: task.id,
      runId: input.runId,
      path: worktreePath,
      branch,
    });
    return {
      ok: true,
      cwd: worktreePath,
      branch,
      sandboxId: `git:${worktreePath}`,
      mode: "git",
      runtimeRoot: repo.runtimeRoot ?? undefined,
    };
  }

  async cleanup(workspaceId: string, taskId: string): Promise<void> {
    const record = this.gitStore.getActiveWorktreeForTask(taskId);
    if (record) await this.removeWorktree(record, "manual", workspaceId);
  }

  async removeWorktree(
    record: WorktreeRecord,
    reason: string,
    workspaceId = record.workspaceId,
  ): Promise<void> {
    const repo = await this.repoFor(workspaceId);
    if (repo) {
      const git = repo.git;
      const cwd = repo.repo.root ?? repo.repo.workspacePath;
      await git.run(["worktree", "remove", "--force", record.path], { cwd, timeoutMs: 60_000 });
      await git.run(["worktree", "prune"], { cwd, timeoutMs: 30_000 });
    }
    try {
      rmSync(record.path, { recursive: true, force: true });
    } catch {
      // best effort
    }
    this.gitStore.updateWorktree(record.id, { state: "removed" });
    this.event(workspaceId, "task", record.taskId, "git.worktree_removed", {
      taskId: record.taskId,
      runId: record.runId,
      path: record.path,
      reason,
    });
  }

  async reconcile(workspaceId: string): Promise<{ removed: number; orphaned: number }> {
    const records = this.gitStore
      .listWorktrees(workspaceId)
      .filter((item) => ["reserving", "creating", "ready", "active", "finalizing"].includes(item.state));
    let removed = 0;
    let orphaned = 0;
    for (const record of records) {
      const run = record.runId ? this.store.getRun(record.runId) : null;
      const terminal = run ? ["completed", "failed", "cancelled"].includes(run.status) : true;
      if (!terminal) continue;
      try {
        await this.removeWorktree(record, "reconcile", workspaceId);
        removed += 1;
      } catch {
        orphaned += 1;
        this.gitStore.updateWorktree(record.id, { state: "orphaned" });
      }
    }
    this.event(workspaceId, "workspace", workspaceId, "git.reconciled", {
      worktrees: records.length,
      queue: 0,
      repaired: removed,
      orphaned,
    });
    return { removed, orphaned };
  }

  private event(
    workspaceId: string,
    aggregateType: string,
    aggregateId: string,
    type: string,
    payload: unknown,
  ): void {
    try {
      this.store.appendEvent({
        aggregateType,
        aggregateId,
        type,
        actor: "git-service",
        payload,
      });
    } catch {
      // Git events must not break execution
    }
  }
}
