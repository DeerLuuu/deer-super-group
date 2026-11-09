import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import type { Store } from "../kernel/store.js";
import { detectRepo, detectRepoSync, ensureHooksDir, runtimeHooksPath } from "./repo.js";
import { GitExec, validateGitArgs } from "./gitExec.js";
import { GitStore } from "./gitStore.js";
import { emitGitEvent } from "./events.js";
import type { GitSettings, PrepareRunInput, PrepareRunResult, WorktreeRecord } from "./types.js";

const MAX_WORKTREES_HARD_LIMIT = 3;

/**
 * AC-WT-08：worktree 路径必须逐段校验，拒绝符号链接/junction 与 realpath 逃逸。
 * 已存在段与目标本身都要检查；不存在段由祖先 realpath 约束。
 */
export function validateWorktreePath(
  runtimeRoot: string,
  target: string,
): { ok: true } | { ok: false; reason: string } {
  const root = path.resolve(runtimeRoot);
  const resolved = path.resolve(target);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    return { ok: false, reason: "worktree path escapes runtime root" };
  }
  const relative = path.relative(root, resolved);
  if (!relative || relative.split(path.sep).some((segment) => segment === ".." || segment === "")) {
    return { ok: false, reason: "worktree path contains traversal" };
  }
  try {
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink()) return { ok: false, reason: "runtime root is a symlink" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, reason: "cannot stat runtime root" };
    }
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      return { ok: false, reason: "cannot stat worktree path segment" };
    }
    if (stat.isSymbolicLink()) {
      return { ok: false, reason: "symlink or junction in worktree path" };
    }
  }
  try {
    let existing = resolved;
    while (!existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    const realExisting = realpathSync.native(existing);
    const realRoot = existsSync(root) ? realpathSync.native(root) : root;
    if (realExisting !== realRoot && !realExisting.startsWith(`${realRoot}${path.sep}`)) {
      return { ok: false, reason: "worktree realpath escapes runtime root" };
    }
  } catch {
    return { ok: false, reason: "cannot resolve worktree realpath" };
  }
  return { ok: true };
}

function assertWorktreePath(runtimeRoot: string, target: string): PrepareRunResult | null {
  const checked = validateWorktreePath(runtimeRoot, target);
  if (checked.ok) return null;
  return {
    ok: false,
    defer: false,
    errorCode: "GIT_PATH_ESCAPE",
    message: checked.reason,
  };
}


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

/** Fencing lease token persisted in git_worktrees.lease_owner. */
export function worktreeLeaseToken(runId: string, attempt: number): string {
  return `git-service:${runId}:${attempt}`;
}

function runGitSync(
  cwd: string,
  args: string[],
  hooksPath: string,
): { code: number; stdout: string; stderr: string } {
  const validated = validateGitArgs(args, hooksPath);
  if (!validated.ok) return { code: 1, stdout: "", stderr: validated.reason };
  try {
    const stdout = execFileSync("git", ["-c", `core.hooksPath=${hooksPath}`, ...validated.args], {
      cwd,
      timeout: 120_000,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { code: 0, stdout: String(stdout).trim(), stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof err.status === "number" ? err.status : 1,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? err.message ?? "git failed"),
    };
  }
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

  /**
   * Synchronous preparation for the kernel's beforeStart hook. This keeps the
   * prepared cwd/sandboxId available for the run.started event, so no manual
   * run-row UPDATE is needed. The async prepare remains the §16 provider API.
   */
  prepareSync(input: PrepareRunInput): PrepareRunResult {
    const workspace = this.store.getWorkspace(input.workspaceId);
    if (!workspace) {
      return { ok: false, defer: false, errorCode: "GIT_REPO_NOT_FOUND", message: "workspace not found" };
    }
    const settings = this.gitStore.getConfig(input.workspaceId);
    if (settings.mode === "off") {
      return { ok: true, cwd: workspace.path, branch: null, sandboxId: `workspace:${workspace.id}`, mode: "degraded" };
    }
    const repo = detectRepoSync(workspace.path, settings.baseBranch);
    if (!repo.ok) {
      return { ok: true, cwd: workspace.path, branch: null, sandboxId: `workspace:${workspace.id}`, mode: "degraded" };
    }
    ensureHooksDir(repo);
    const hooks = runtimeHooksPath(repo);
    if (!hooks) {
      return { ok: false, defer: false, errorCode: "GIT_REPO_NOT_FOUND", message: "runtime root unavailable" };
    }
    const task = this.store.getTask(input.taskId);
    if (!task) return { ok: false, defer: false, errorCode: "GIT_WORKTREE_FAILED", message: "task not found" };
    const maxWorktrees = Math.min(MAX_WORKTREES_HARD_LIMIT, Math.max(1, Number(settings.maxWorktrees) || 3));
    const activeForTask = this.gitStore.getActiveWorktreeForTask(task.id);
    if (this.gitStore.countActiveWorktrees(workspace.id) >= maxWorktrees && !activeForTask) {
      return { ok: false, defer: true, retryAfterMs: 15_000, reason: "GIT_CAPACITY" };
    }
    const branch = task.branch && task.branch.startsWith("deer/") ? task.branch : branchName(task.id, task.title);
    const branchCheck = runGitSync(repo.root ?? workspace.path, ["check-ref-format", "--branch", branch], hooks);
    if (branchCheck.code !== 0) {
      return { ok: false, defer: false, errorCode: "GIT_BRANCH_INVALID", message: "invalid branch name" };
    }
    if (activeForTask) {
      const existingRun = activeForTask.runId ? this.store.getRun(activeForTask.runId) : null;
      if (
        activeForTask.runId !== input.runId &&
        existingRun &&
        ["running", "waiting_human", "queued"].includes(existingRun.status) &&
        existingRun.leaseExpiresAt &&
        Date.parse(existingRun.leaseExpiresAt) > Date.now()
      ) {
        return { ok: false, defer: true, retryAfterMs: 15_000, reason: "GIT_WORKTREE_BUSY" };
      }
      const reclaimCheck = assertWorktreePath(
        repo.runtimeRoot ?? path.join(workspace.path, ".deer"),
        activeForTask.path,
      );
      if (reclaimCheck) return reclaimCheck;
      runGitSync(repo.root ?? workspace.path, ["worktree", "remove", "--force", activeForTask.path], hooks);
      runGitSync(repo.root ?? workspace.path, ["worktree", "prune"], hooks);
      try {
        rmSync(activeForTask.path, { recursive: true, force: true });
      } catch {
        // best effort
      }
      this.gitStore.updateWorktree(activeForTask.id, { state: "removed" });
      this.event(workspace.id, "task", task.id, "git.worktree_reclaimed", {
        taskId: task.id,
        branch: activeForTask.branch,
        oldPath: activeForTask.path,
        reason: "prepare",
      });
    }
    const attempt = Math.max(1, Math.floor(input.attempt));
    const runtimeRoot = repo.runtimeRoot ?? path.join(workspace.path, ".deer");
    const worktreePath = path.join(runtimeRoot, "worktrees", task.id, String(attempt));
    const pathCheck = assertWorktreePath(runtimeRoot, worktreePath);
    if (pathCheck) return pathCheck;
    try {
      mkdirSync(path.dirname(worktreePath), { recursive: true });
    } catch (error) {
      return { ok: false, defer: false, errorCode: "GIT_WORKTREE_FAILED", message: error instanceof Error ? error.message : String(error) };
    }
    const branchExists = runGitSync(repo.root ?? workspace.path, ["rev-parse", "--verify", branch], hooks);
    const add =
      branchExists.code === 0
        ? runGitSync(repo.root ?? workspace.path, ["worktree", "add", worktreePath, branch], hooks)
        : runGitSync(repo.root ?? workspace.path, ["worktree", "add", "-b", branch, worktreePath, settings.baseBranch], hooks);
    if (add.code !== 0) {
      return { ok: false, defer: false, errorCode: "GIT_WORKTREE_FAILED", message: add.stderr || "worktree add failed" };
    }
    const postCheck = assertWorktreePath(runtimeRoot, worktreePath);
    if (postCheck) return postCheck;
    const record: WorktreeRecord = {
      id: newWorktreeId(),
      workspaceId: workspace.id,
      taskId: task.id,
      branchTaskId: task.id,
      runId: input.runId,
      path: worktreePath,
      branch,
      state: "active",
      leaseOwner: worktreeLeaseToken(input.runId, attempt),
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
      if (existing.runId === input.runId && existing.state === "active") {
        const currentCheck = assertWorktreePath(
          repo.runtimeRoot ?? path.join(workspace.path, ".deer"),
          existing.path,
        );
        if (currentCheck) return currentCheck;
        this.gitStore.updateWorktree(existing.id, {
          leaseOwner: worktreeLeaseToken(input.runId, Math.max(1, Math.floor(input.attempt))),
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        return {
          ok: true,
          cwd: existing.path,
          branch: existing.branch,
          sandboxId: `git:${existing.path}`,
          mode: "git",
          runtimeRoot: repo.runtimeRoot ?? undefined,
        };
      }
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
      const reclaimCheck = assertWorktreePath(
        repo.runtimeRoot ?? path.join(workspace.path, ".deer"),
        existing.path,
      );
      if (reclaimCheck) return reclaimCheck;
      await this.removeWorktree(existing, "reclaimed", input.workspaceId);
    }

    const attempt = Math.max(1, Math.floor(input.attempt));
    const runtimeRoot = repo.runtimeRoot ?? path.join(workspace.path, ".deer");
    const worktreePath = path.join(runtimeRoot, "worktrees", task.id, String(attempt));
    const pathCheck = assertWorktreePath(runtimeRoot, worktreePath);
    if (pathCheck) return pathCheck;
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
    const postCheck = assertWorktreePath(runtimeRoot, worktreePath);
    if (postCheck) return postCheck;

    const record: WorktreeRecord = {
      id: newWorktreeId(),
      workspaceId: workspace.id,
      taskId: task.id,
      branchTaskId: task.id,
      runId: input.runId,
      path: worktreePath,
      branch,
      state: "active",
      leaseOwner: worktreeLeaseToken(input.runId, attempt),
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
    expectedLeaseOwner?: string,
  ): Promise<void> {
    if (expectedLeaseOwner && record.leaseOwner !== expectedLeaseOwner) {
      throw new Error("GIT_FENCING_STALE: worktree lease owner changed");
    }
    const repo = await this.repoFor(workspaceId);
    if (repo) {
      const runtimeRoot = repo.repo.runtimeRoot ?? path.join(repo.repo.workspacePath, ".deer");
      const checked = validateWorktreePath(runtimeRoot, record.path);
      if (!checked.ok) {
        this.gitStore.updateWorktree(record.id, { state: "orphaned" });
        this.event(workspaceId, "task", record.taskId, "git.worktree_orphaned", {
          taskId: record.taskId,
          path: record.path,
          reason: `unsafe path: ${checked.reason}`,
        });
        return;
      }
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
    if (reason === "reclaimed") {
      this.event(workspaceId, "task", record.taskId, "git.worktree_reclaimed", {
        taskId: record.taskId,
        branch: record.branch,
        oldPath: record.path,
        reason,
      });
    } else {
      this.event(workspaceId, "task", record.taskId, "git.worktree_removed", {
        taskId: record.taskId,
        runId: record.runId ?? "",
        path: record.path,
        reason,
      });
    }
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
      emitGitEvent(this.store, {
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
