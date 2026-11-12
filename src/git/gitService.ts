import path from "node:path";
import { appendFileSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import type { Store } from "../kernel/store.js";
import type { Task } from "../shared/types.js";
import type { TaskVcs, GitSettings, MergeQueueItem, MergeQueueSnapshot, PrInfo, PrProvider, PrepareRunInput, PrepareRunResult, RepoDiagnostics, RepoInfo, FinalizeRunInput, TaskVcsSnapshot, GitResult } from "./types.js";
import { DEFAULT_GIT_SETTINGS } from "./types.js";
import { GitStore } from "./gitStore.js";
import { GitExec, redactSecrets } from "./gitExec.js";
import { detectRepo, ensureHooksDir, runtimeHooksPath } from "./repo.js";
import { CommitGuard } from "./commitGuard.js";
import { WorktreeManager, worktreeLeaseToken } from "./worktreeManager.js";
import { ChecksRunner } from "./checksRunner.js";
import { MergeQueue, type QueueContext } from "./mergeQueue.js";
import { commitAll, pushBranch, revParse } from "./branchOps.js";
import { pickProvider, compareUrl } from "./providers.js";
import { emitGitEvent } from "./events.js";
import { RepoLock } from "./gitExec.js";
import { GitReadService } from "./readService.js";
import type { GitCommitDetail, GitDiffParams, GitGraphPage, GitReadRepo, GitWorkingStatus, GitDiffPage, GitRefsSnapshot } from "./readTypes.js";
import { isReadPath } from "./readTypes.js";
import { initializeGitRepo, probeGitInit } from "./gitInit.js";
import type { GitInitProbe, GitInitResult } from "./initTypes.js";
import {
  GITIGNORE_TEMPLATE,
  writeFail,
  type GitCommitCreateResult,
  type GitIgnoreApplyResult,
  type GitIgnorePreview,
  type GitWritePathsResult,
} from "./writeTypes.js";

export interface GitServiceOptions {
  dataDir: string;
  store: Store;
}

function now(): string {
  return new Date().toISOString();
}

function baseVcs(workspaceId: string, taskId: string, mode: TaskVcs["mode"]): TaskVcs {
  return {
    taskId,
    workspaceId,
    mode,
    branch: null,
    baseBranch: null,
    headSha: null,
    pr: null,
    merge: { state: "none", commitSha: null },
    checksState: "none",
    conflictTaskId: null,
    degradedReason: null,
    errorCode: null,
    updatedAt: now(),
  };
}

export class GitService {
  readonly gitStore: GitStore;
  readonly worktrees: WorktreeManager;
  readonly queue: MergeQueue;
  private readonly checks = new ChecksRunner();
  private readonly repoCache = new Map<string, { repo: RepoInfo; at: number }>();
  private readonly prLock = new RepoLock();
  private readonly initLock = new RepoLock();
  /** t352 G1：版本图写操作（stage/unstage/commit/.gitignore）按工作区串行。 */
  private readonly graphWriteLock = new RepoLock();

  constructor(private readonly options: GitServiceOptions) {
    this.gitStore = new GitStore(path.join(options.dataDir, "git.db"));
    this.worktrees = new WorktreeManager(options.store, this.gitStore);
    this.queue = new MergeQueue({
      store: options.store,
      gitStore: this.gitStore,
      checks: this.checks,
      contextFor: (workspaceId) => this.contextFor(workspaceId),
      createConflictTask: (input) => this.createConflictTask(input),
    });
  }

  close(): void {
    this.gitStore.close();
  }

  /** Detect repo (cached briefly) and build a queue execution context. */
  private async repoFor(workspaceId: string): Promise<RepoInfo> {
    const cached = this.repoCache.get(workspaceId);
    if (cached && Date.now() - cached.at < 30_000) return cached.repo;
    const workspace = this.options.store.getWorkspace(workspaceId);
    if (!workspace) {
      return {
        ok: false,
        workspacePath: "",
        root: null,
        runtimeRoot: null,
        baseBranch: "main",
        remote: null,
        remoteKind: "none",
        gitVersion: null,
        errorCode: "GIT_REPO_NOT_FOUND",
        reason: "workspace not found",
      };
    }
    const settings = this.gitStore.getConfig(workspaceId);
    const repo = await detectRepo(workspace.path, settings.baseBranch);
    this.repoCache.set(workspaceId, { repo, at: Date.now() });
    return repo;
  }

  private async contextFor(workspaceId: string): Promise<QueueContext | null> {
    const repo = await this.repoFor(workspaceId);
    if (!repo.ok) return null;
    const settings = this.gitStore.getConfig(workspaceId);
    ensureHooksDir(repo);
    const hooks = runtimeHooksPath(repo);
    if (!hooks) return null;
    const git = new GitExec(hooks);
    const provider = await pickProvider(repo, settings.provider, settings.apiHost);
    return { repo, git, provider, settings };
  }

  /**
   * Kernel beforeStart hook: prepare synchronously so the kernel can put
   * `git:<cwd>` directly into the run.started payload/projection.
   */
  beforeStart(input: {
    workspaceId: string;
    taskId: string;
    runId: string;
    attempt: number;
    agentId: string;
  }):
    | boolean
    | {
        allow: boolean;
        reason?: string;
        environment?: { cwd: string; branch: string | null; sandboxId: string; mode: "git" | "degraded" };
      } {
    const admitted = this.admit(input);
    if (typeof admitted === "object" && !admitted.allow) {
      return { allow: false, reason: admitted.reason ?? "GIT_CAPACITY" };
    }
    const prepared = this.worktrees.prepareSync(input);
    if (!prepared.ok) {
      if (prepared.defer) return { allow: false, reason: prepared.reason };
      return {
        allow: true,
        environment: {
          cwd: this.options.store.getWorkspace(input.workspaceId)?.path ?? process.cwd(),
          branch: null,
          sandboxId: `workspace:${input.workspaceId}`,
          mode: "degraded",
        },
      };
    }
    return {
      allow: true,
      environment: {
        cwd: prepared.cwd,
        branch: prepared.branch,
        sandboxId: prepared.sandboxId,
        mode: prepared.mode,
      },
    };
  }

  async prepareRun(input: PrepareRunInput): Promise<PrepareRunResult> {
    return this.worktrees.prepare(input);
  }

  /**
   * Synchronous admission used by the kernel's fast beforeStart hook.
   * Capacity miss leaves the task queued (nextRunAt) without creating a Run or
   * consuming an attempt. prepareRun still performs the full async work later.
   */
  admit(input: {
    workspaceId: string;
    taskId: string;
    attempt: number;
  }): boolean | { allow: boolean; reason?: string } {
    const settings = this.gitStore.getConfig(input.workspaceId);
    if (settings.mode === "off") return true;
    const cached = this.repoCache.get(input.workspaceId);
    if (cached && !cached.repo.ok) return true;
    if (this.gitStore.getActiveWorktreeForTask(input.taskId)) return true;
    const max = Math.max(1, Math.min(3, Number(settings.maxWorktrees) || 3));
    if (this.gitStore.countActiveWorktrees(input.workspaceId) < max) return true;
    const nextRunAt = new Date(Date.now() + 15_000).toISOString();
    try {
      this.options.store.db
        .prepare("UPDATE tasks SET next_run_at = ? WHERE id = ? AND status = 'queued'")
        .run(nextRunAt, input.taskId);
    } catch {
      // Older schemas may not expose next_run_at; kernel still keeps queued.
    }
    return { allow: false, reason: "GIT_CAPACITY" };
  }

  async finalizeRun(input: FinalizeRunInput): Promise<void> {
    const record = this.gitStore.getWorktreeByRun(input.runId);
    if (!record) {
      const active = this.gitStore.getActiveWorktreeForTask(input.taskId);
      if (active && active.runId !== input.runId) {
        throw new Error("GIT_FENCING_STALE: stale Run owner cannot finalize worktree");
      }
      return;
    }
    const task = this.options.store.getTask(input.taskId);
    if (!task) return;
    const run = this.options.store.getRun(input.runId);
    const expectedLease = worktreeLeaseToken(input.runId, Math.max(1, run?.attempt ?? 1));
    if (record.state === "removed" || record.state === "orphaned") {
      const active = this.gitStore.getActiveWorktreeForTask(input.taskId);
      if (active && active.runId !== input.runId) {
        throw new Error("GIT_FENCING_STALE: stale Run owner cannot finalize worktree");
      }
      return;
    }
    if (record.state !== "active" || record.leaseOwner !== expectedLease) {
      throw new Error("GIT_FENCING_STALE: stale Run owner cannot finalize worktree");
    }
    const context = await this.contextFor(task.workspaceId);
    if (!context) {
      await this.worktrees.removeWorktree(record, "no-context");
      return;
    }
    const { git, provider, settings, repo } = context;
    const cwd = record.path;
    let commitSha: string | null = null;
    let pr: PrInfo | null = null;
    let errorCode: string | null = null;

    const shouldCommit =
      input.status === "completed" ||
      input.status === "cancelled" ||
      (input.status === "failed" && settings.autoPushWip);
    if (shouldCommit) {
      const status = await git.run(["status", "--porcelain"], { cwd });
      if (status.code === 0 && !status.stdout.trim()) {
        emitGitEvent(this.options.store, {
          aggregateType: "task",
          aggregateId: task.id,
          type: "git.no_changes",
          actor: "git-service",
          payload: { runId: input.runId },
        });
      } else {
        const guard = new CommitGuard(git);
        const committed = await commitAll({
          git,
          worktree: cwd,
          message: `${input.status === "completed" ? "feat" : "wip"}(${task.id}): ${task.title}`,
          scan: () => guard.scan(cwd),
        });
        if (committed.ok && committed.commit) {
          commitSha = committed.commit.sha;
          emitGitEvent(this.options.store, {
            aggregateType: "task",
            aggregateId: task.id,
            type: "git.commit",
            actor: "git-service",
            payload: { runId: input.runId, branch: record.branch, sha: commitSha, files: committed.commit.files },
          });
        } else if (!committed.ok) {
          errorCode = "GIT_COMMIT_BLOCKED";
          emitGitEvent(this.options.store, {
            aggregateType: "task",
            aggregateId: task.id,
            type: "git.commit_blocked",
            actor: "git-service",
            payload: {
              runId: input.runId,
              files: [],
              reason: committed.reason ?? "blocked",
              errorCode,
            },
          });
        }
      }
    }

    if (commitSha) {
      const push = input.status === "completed" || (input.status === "failed" && settings.autoPushWip) || (input.status === "cancelled" && settings.pushOnCancel);
      if (push && repo.remote && record.branch.startsWith("deer/")) {
        const pushed = await pushBranch({ git, cwd, remote: settings.remote ?? "origin", branch: record.branch });
        if (pushed.ok) {
          emitGitEvent(this.options.store, {
            aggregateType: "task",
            aggregateId: task.id,
            type: "git.pushed",
            actor: "git-service",
            payload: { runId: input.runId, branch: record.branch, remote: settings.remote ?? "origin", sha: commitSha },
          });
        } else {
          errorCode = pushed.error ?? "GIT_PUSH_NETWORK";
          emitGitEvent(this.options.store, {
            aggregateType: "task",
            aggregateId: task.id,
            type: "git.push_failed",
            actor: "git-service",
            payload: {
              runId: input.runId,
              branch: record.branch,
              remote: settings.remote ?? "origin",
              errorCode,
              retryable: true,
            },
          });
        }
      }
      if (input.status === "completed" && settings.autoCreatePr) {
        try {
          const existingVcs = this.gitStore.getTaskVcs(task.id);
          pr = await this.ensurePullRequest({
            task,
            branch: record.branch,
            baseBranch: settings.baseBranch,
            headSha: commitSha,
            provider,
            repo,
            title: task.title,
            body: `Task: ${task.id}\n\n${task.description}`,
            existingPr: existingVcs?.pr ?? null,
          });
        } catch (error) {
          errorCode = "PR_CREATE_FAILED";
          emitGitEvent(this.options.store, {
            aggregateType: "task",
            aggregateId: task.id,
            type: "git.push_failed",
            actor: "git-service",
            payload: {
              runId: input.runId,
              branch: record.branch,
              remote: settings.remote ?? "origin",
              errorCode,
              retryable: true,
              message: redactSecrets(error instanceof Error ? error.message : String(error)),
            },
          });
        }
      }
    }

    const vcs = this.gitStore.getTaskVcs(task.id) ?? baseVcs(task.workspaceId, task.id, "git");
    const updated: TaskVcs = {
      ...vcs,
      mode: "git",
      branch: record.branch,
      baseBranch: settings.baseBranch,
      headSha: commitSha ?? vcs.headSha,
      pr: pr
        ? {
            provider: pr.provider,
            number: pr.number,
            url: pr.url,
            state: pr.state,
            checks: pr.checks.length ? pr.checks.map((c) => c.status).join(",") : "none",
            review: pr.review,
          }
        : vcs.pr,
      errorCode,
      updatedAt: now(),
    };
    this.gitStore.upsertTaskVcs(updated);
    this.gitStore.upsertRunVcs({
      runId: input.runId,
      taskId: task.id,
      worktreePath: record.path,
      branch: record.branch,
      baseSha: null,
      commitSha,
      prNumber: pr?.number ?? null,
      mode: "git",
    });

    const preserve =
      input.status === "cancelled" && settings.preserveWorktreeOnCancel;
    if (!preserve) {
      await this.worktrees.removeWorktree(
        record,
        `finalize:${input.status}`,
        task.workspaceId,
        expectedLease,
      );
    }
  }

  recordScope(taskId: string, workspaceId: string, scopePaths: string[]): void {
    if (!scopePaths.length) return;
    const existing = this.gitStore.getTaskVcs(taskId) ?? baseVcs(workspaceId, taskId, "git");
    this.gitStore.upsertTaskVcs({ ...existing, scopePaths, updatedAt: now() });
  }

  getTaskVcs(taskId: string): TaskVcsSnapshot {    const vcs = this.gitStore.getTaskVcs(taskId);
    const task = this.options.store.getTask(taskId);
    const runVcs = task
      ? this.gitStore
          .listWorktrees(task.workspaceId)
          .find((item) => item.taskId === taskId)
      : null;
    return {
      vcs,
      run: runVcs
        ? {
            runId: runVcs.runId ?? "",
            taskId,
            worktreePath: runVcs.path,
            branch: runVcs.branch,
            baseSha: null,
            commitSha: vcs?.headSha ?? null,
            prNumber: vcs?.pr?.number ?? null,
            mode: vcs?.mode ?? "git",
          }
        : null,
    };
  }

  async createPr(taskId: string): Promise<TaskVcs> {
    const task = this.options.store.getTask(taskId);
    if (!task) throw new Error("task not found");
    const context = await this.contextFor(task.workspaceId);
    if (!context) throw new Error("git context unavailable");
    const vcs = this.gitStore.getTaskVcs(taskId);
    if (!vcs?.branch) throw new Error("task has no branch");
    const pr = await this.ensurePullRequest({
      task,
      branch: vcs.branch,
      baseBranch: context.settings.baseBranch,
      headSha: vcs.headSha,
      provider: context.provider,
      repo: context.repo,
      title: task.title,
      body: `Task: ${task.id}\n\n${task.description}`,
      existingPr: vcs.pr,
    });
    const updated: TaskVcs = {
      ...vcs,
      pr: {
        provider: pr.provider,
        number: pr.number,
        url: pr.url,
        state: pr.state,
        checks: pr.checks.length ? pr.checks.map((c) => c.status).join(",") : "none",
        review: pr.review,
      },
      updatedAt: now(),
    };
    this.gitStore.upsertTaskVcs(updated);
    return updated;
  }

  private getPrRow(
    workspaceId: string,
    provider: string,
    taskId: string,
  ): Record<string, unknown> | null {
    return (
      (this.gitStore.db
        .prepare(
          "SELECT * FROM pr_records WHERE workspace_id = ? AND provider = ? AND task_id = ?",
        )
        .get(workspaceId, provider, taskId) as Record<string, unknown> | undefined) ?? null
    );
  }

  private prFromRow(row: Record<string, unknown>): PrInfo {
    let checks: PrInfo["checks"] = [];
    try {
      const parsed = JSON.parse(String(row.checks_json ?? "[]"));
      if (Array.isArray(parsed)) checks = parsed as PrInfo["checks"];
    } catch {
      checks = [];
    }
    return {
      provider: String(row.provider) as PrInfo["provider"],
      number: row.number == null ? null : Number(row.number),
      url: row.url == null ? null : String(row.url),
      state: String(row.state ?? "unknown") as PrInfo["state"],
      headSha: String(row.head_sha ?? ""),
      baseBranch: String(row.base_branch ?? ""),
      mergeable: String(row.mergeable ?? "unknown") as PrInfo["mergeable"],
      checks,
      review: String(row.review_state ?? "unknown") as PrInfo["review"],
      mergedCommitSha: null,
      updatedAt: String(row.updated_at ?? now()),
    };
  }

  private persistPr(
    task: Task,
    branch: string,
    baseBranch: string,
    pr: PrInfo,
    headSha: string | null,
  ): void {
    this.gitStore.upsertPrRecord({
      provider: pr.provider,
      workspaceId: task.workspaceId,
      number: pr.number,
      branch,
      url: pr.url,
      taskId: task.id,
      headSha: pr.headSha || headSha || "",
      baseBranch,
      state: pr.state,
      checks: pr.checks,
      review: pr.review,
      mergeable: pr.mergeable,
    });
  }

  /** B3：RepoLock + DB 占位唯一键，保证并发 create/refresh 只产生一个 PR。 */
  private async ensurePullRequest(input: {
    task: Task;
    branch: string;
    baseBranch: string;
    headSha: string | null;
    provider: PrProvider;
    repo: RepoInfo;
    title: string;
    body: string;
    existingPr?: { number: number | null } | null;
  }): Promise<PrInfo> {
    const key = `pr:${input.task.workspaceId}:${input.provider.id}:${input.task.id}`;
    return this.prLock.withLock(key, async () => {
      const current = this.getPrRow(input.task.workspaceId, input.provider.id, input.task.id);
      const vcsPr = this.gitStore.getTaskVcs(input.task.id)?.pr ?? input.existingPr ?? null;
      const existingUsable =
        current &&
        String(current.state) !== "creating" &&
        String(current.state) !== "failed" &&
        (current.number != null || current.url != null || String(current.state) !== "unknown");
      if (existingUsable) {
        const pr = await input.provider.refresh(input.repo, {
          number: current.number == null ? null : Number(current.number),
          branch: input.branch,
        });
        this.persistPr(input.task, input.branch, input.baseBranch, pr, input.headSha);
        try {
          emitGitEvent(this.options.store, {
            aggregateType: "task",
            aggregateId: input.task.id,
            type: "pr.updated",
            actor: "git-service",
            payload: {
              number: pr.number,
              state: pr.state,
              headSha: pr.headSha || input.headSha || "",
              mergeable: pr.mergeable,
            },
          });
        } catch {
          // audit must not break PR refresh
        }
        return pr;
      }
      if (current?.state === "creating") {
        const age = Date.now() - Date.parse(String(current.updated_at ?? ""));
        if (Number.isFinite(age) && age < 30_000) {
          throw new Error("PR_CREATE_IN_PROGRESS");
        }
      }
      if (!current && vcsPr) {
        const pr = await input.provider.refresh(input.repo, {
          number: vcsPr.number,
          branch: input.branch,
        });
        this.persistPr(input.task, input.branch, input.baseBranch, pr, input.headSha);
        return pr;
      }
      this.reservePr(input.task, input.provider.id, input.branch, input.baseBranch, input.headSha);
      const reserved = this.getPrRow(input.task.workspaceId, input.provider.id, input.task.id);
      if (reserved?.number != null) {
        const pr = await input.provider.refresh(input.repo, {
          number: Number(reserved.number),
          branch: input.branch,
        });
        this.persistPr(input.task, input.branch, input.baseBranch, pr, input.headSha);
        return pr;
      }
      try {
        const pr = await input.provider.createPr({
          repo: input.repo,
          head: input.branch,
          base: input.baseBranch,
          title: input.title,
          body: input.body,
        });
        this.persistPr(input.task, input.branch, input.baseBranch, pr, input.headSha);
        try {
          emitGitEvent(this.options.store, {
            aggregateType: "task",
            aggregateId: input.task.id,
            type: "pr.created",
            actor: "git-service",
            payload: {
              provider: pr.provider,
              number: pr.number,
              url: pr.url,
              headSha: pr.headSha || input.headSha || "",
              base: input.baseBranch,
            },
          });
        } catch {
          // audit must not break PR creation
        }
        return pr;
      } catch (error) {
        this.gitStore.db
          .prepare(
            `UPDATE pr_records SET state = 'failed', updated_at = ?
             WHERE workspace_id = ? AND provider = ? AND task_id = ?`,
          )
          .run(now(), input.task.workspaceId, input.provider.id, input.task.id);
        throw error;
      }
    });
  }

  private reservePr(
    task: Task,
    provider: string,
    branch: string,
    baseBranch: string,
    headSha: string | null,
  ): void {
    const db = this.gitStore.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.getPrRow(task.workspaceId, provider, task.id);
      if (row) {
        if (row.number == null) {
          db.prepare(
            `UPDATE pr_records SET state = 'creating', branch = ?, head_sha = ?,
             base_branch = ?, updated_at = ? WHERE id = ?`,
          ).run(branch, headSha ?? "", baseBranch, now(), String(row.id));
        }
        db.exec("COMMIT");
        return;
      }
      try {
        db.prepare(
          `INSERT INTO pr_records
           (id, provider, workspace_id, number, branch, url, task_id, head_sha,
            base_branch, state, checks_json, review_state, mergeable, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          `pr_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`,
          provider,
          task.workspaceId,
          null,
          branch,
          null,
          task.id,
          headSha ?? "",
          baseBranch,
          "creating",
          "[]",
          "unknown",
          "unknown",
          now(),
        );
      } catch (error) {
        // Another process reserved the unique (workspace, provider, task/branch) row.
        db.exec("ROLLBACK");
        const raced = this.getPrRow(task.workspaceId, provider, task.id);
        if (raced?.number != null) return;
        throw error;
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw error;
    }
  }

  async diagnose(workspaceId: string): Promise<RepoDiagnostics> {    const workspace = this.options.store.getWorkspace(workspaceId);
    const settings = this.gitStore.getConfig(workspaceId);
    const repo = await this.repoFor(workspaceId);
    const provider = repo.ok ? await pickProvider(repo, settings.provider, settings.apiHost) : null;
    const worktrees = this.gitStore.listWorktrees(workspaceId).filter((item) => item.state !== "removed");
    const queue = this.gitStore.listQueue(workspaceId);
    const remoteHost = (() => {
      if (!repo.remote) return null;
      const match = repo.remote.match(/[@/]([^/:]+)[/:]/);
      return match?.[1] ?? null;
    })();
    return {
      workspaceId,
      workspacePath: workspace?.path ?? "",
      mode: repo.ok ? "git" : "degraded",
      root: repo.root,
      runtimeRoot: repo.runtimeRoot,
      gitVersion: repo.gitVersion,
      remote: repo.remote
        ? { name: "origin", host: remoteHost ?? "", repo: repo.remote.split("/").pop()?.replace(/\.git$/, "") ?? "" }
        : null,
      baseBranch: repo.baseBranch,
      provider: provider?.id ?? "none",
      auth: {
        gh: false,
        env: Boolean(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN),
        rest: Boolean(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN),
        user: null,
        rateLimit: { remaining: null, resetAt: null },
      },
      protection: "unknown",
      worktrees: worktrees.map((item) => ({ path: item.path, branch: item.branch, taskId: item.taskId, state: item.state })),
      queue: {
        active: queue.filter((item) => ["queued", "waiting_checks", "waiting_review", "ready", "updating", "merging"].includes(item.state)).length,
        blocked: queue.filter((item) => item.state === "blocked").length,
        state: queue.find((item) => item.state === "merging") ? "merging" : "idle",
      },
      lastError: null,
    };
  }

  getSettings(workspaceId: string): GitSettings {
    return this.gitStore.getConfig(workspaceId);
  }

  private async readContext(
    workspaceId: string,
  ): Promise<{ ok: true; reader: GitReadService } | { ok: false; result: import("./types.js").GitResult<never> }> {
    const repo = await this.repoFor(workspaceId);
    if (!repo.ok || !repo.root) {
      const code = repo.errorCode === "GIT_NOT_ROOT" ? "GIT_READ_NOT_ROOT" : "GIT_READ_NOT_REPO";
      return { ok: false, result: { ok: false, errorCode: code, message: repo.reason ?? "not a git repository", retryable: false } };
    }
    ensureHooksDir(repo);
    const hooks = runtimeHooksPath(repo);
    if (!hooks) {
      return { ok: false, result: { ok: false, errorCode: "GIT_READ_DEGRADED", message: "git runtime unavailable", retryable: true } };
    }
    return { ok: true, reader: new GitReadService(repo as RepoInfo & { root: string }, new GitExec(hooks)) };
  }

  async probeInit(workspaceId: string): Promise<GitInitProbe> {
    const workspace = this.options.store.getWorkspace(workspaceId);
    if (!workspace) {
      return {
        workspaceId,
        workspacePath: "",
        root: null,
        status: "workspace-missing",
        canInitialize: false,
        branch: "main",
        gitVersion: null,
        reason: "工作区不存在",
      };
    }
    return probeGitInit(workspace.path, workspaceId);
  }

  async init(workspaceId: string): Promise<GitResult<GitInitResult>> {
    return this.initLock.withLock(workspaceId, async () => {
      const workspace = this.options.store.getWorkspace(workspaceId);
      if (!workspace) {
        return {
          ok: false,
          errorCode: "GIT_INIT_WORKSPACE_MISSING",
          message: "工作区不存在",
          retryable: false,
        };
      }
      const initialized = await initializeGitRepo(workspace.path);
      if (!initialized.ok || !initialized.value) return initialized;
      const value = initialized.value;
      this.repoCache.delete(workspaceId);
      let auditEventId: string | null = null;
      try {
        const event = emitGitEvent(this.options.store, {
          aggregateType: "workspace",
          aggregateId: workspaceId,
          type: "git.repo_initialized",
          actor: "git-service",
          payload: { workspaceId, root: value.root, branch: value.branch, headSha: null },
        });
        auditEventId = event.id;
      } catch {
        // Audit failure must not turn a successfully created repo into an error.
      }
      return {
        ok: true,
        value: { ...value, workspaceId, auditEventId },
      };
    });
  }

  // ---------------------------------------------------------------------
  // t352 G1：Git Graph 写闭环（stage / unstage / commit / .gitignore）。
  // 全部为本地仓库操作：execFile 无 shell、argv 白名单、超时、RepoLock
  // 按工作区串行、路径必须解析在仓库根内、审计事件；无 push/force/remote。
  // ---------------------------------------------------------------------

  private async graphWriteContext(
    workspaceId: string,
  ): Promise<
    | { ok: true; git: GitExec; root: string; workspaceId: string }
    | { ok: false; result: import("./types.js").GitResult<never> }
  > {
    const workspace = this.options.store.getWorkspace(workspaceId);
    if (!workspace) {
      return {
        ok: false,
        result: writeFail("GIT_WRITE_NOT_REPO", "工作区不存在"),
      };
    }
    const repo = await this.repoFor(workspaceId);
    if (!repo.ok || !repo.root) {
      return {
        ok: false,
        result: writeFail("GIT_WRITE_NOT_REPO", repo.reason ?? "工作区不是 Git 仓库", true),
      };
    }
    ensureHooksDir(repo);
    const hooks = runtimeHooksPath(repo);
    if (!hooks) {
      return { ok: false, result: writeFail("GIT_WRITE_INTERNAL", "git 运行时不可用", true) };
    }
    return { ok: true, git: new GitExec(hooks), root: repo.root, workspaceId };
  }

  /** 路径白名单校验：相对路径、无控制字符/穿越、不指向 .git，且解析后仍在仓库根内。 */
  private resolveRepoPaths(root: string, paths: string[]): string[] | null {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 500) return null;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of paths) {
      if (typeof item !== "string" || !isReadPath(item) || seen.has(item)) return null;
      const resolved = path.resolve(root, item);
      if (!resolved.startsWith(root + path.sep)) return null;
      seen.add(item);
      out.push(item);
    }
    return out;
  }

  /** 解析 porcelain 输出中「已暂存」的仓库相对路径（xy 首字符非空格且非 `??`）。 */
  private parseStagedPaths(porcelain: string): Array<{ path: string; oldPath?: string }> {
    const parts = porcelain.split("\0");
    const staged: Array<{ path: string; oldPath?: string }> = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (!part || part.length < 3) continue;
      const xy = part.slice(0, 2);
      const filePath = part.slice(3);
      if (xy[0] === "R" || xy[0] === "C") {
        const otherPath = parts[index + 1];
        if (otherPath) index += 1;
        staged.push({ path: filePath, ...(otherPath ? { oldPath: otherPath } : {}) });
        continue;
      }
      if (xy === "??") continue;
      if (xy[0] !== " ") staged.push({ path: filePath });
    }
    return staged;
  }

  /**
   * t395 F2：.gitignore 必须是仓库根内普通文件；symlink/junction 直接拒绝，
   * 非链接文件的 realpath 也必须在仓库根内。预览与应用写前都会调用。
   */
  private inspectIgnoreTarget(
    root: string,
  ): { path: string; exists: boolean; size: number } | { error: string } {
    const ignorePath = path.join(root, ".gitignore");
    let link;
    try {
      link = lstatSync(ignorePath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return { path: ignorePath, exists: false, size: 0 };
      }
      return { error: "无法检查 .gitignore" };
    }
    if (link.isSymbolicLink()) {
      return { error: ".gitignore 不能是 symlink/junction" };
    }
    if (!link.isFile()) {
      return { error: ".gitignore 不是普通文件" };
    }
    try {
      const real = realpathSync(ignorePath);
      const rootReal = realpathSync(root);
      const relative = path.relative(rootReal, real);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        return { error: ".gitignore 真实路径不在仓库根内" };
      }
    } catch {
      return { error: "无法解析 .gitignore 真实路径" };
    }
    return { path: ignorePath, exists: true, size: link.size };
  }

  private audit(event: {
    aggregateId: string;
    type: "git.staged" | "git.unstaged" | "git.committed" | "git.ignore_updated";
    payload: unknown;
  }): void {
    try {
      emitGitEvent(this.options.store, {
        aggregateType: "workspace",
        aggregateId: event.aggregateId,
        type: event.type,
        actor: "git-graph",
        payload: event.payload,
      });
    } catch {
      // 审计失败不能让已成功的本地写操作变成错误。
    }
  }

  async stage(workspaceId: string, paths: string[]): Promise<import("./types.js").GitResult<GitWritePathsResult>> {
    return this.graphWriteLock.withLock(workspaceId, async () => {
      const context = await this.graphWriteContext(workspaceId);
      if (!context.ok) return context.result;
      const safePaths = this.resolveRepoPaths(context.root, paths);
      if (!safePaths) {
        return writeFail("GIT_WRITE_BAD_PARAM", "无效的文件路径（仅支持仓库内相对路径）");
      }
      const output = await context.git.run(["add", "--", ...safePaths], { cwd: context.root, timeoutMs: 30_000 });
      if (output.code !== 0) {
        return writeFail("GIT_WRITE_STAGE_FAILED", output.stderr || "git add 失败", true);
      }
      this.audit({
        aggregateId: workspaceId,
        type: "git.staged",
        payload: { workspaceId, paths: safePaths, count: safePaths.length },
      });
      return { ok: true, value: { paths: safePaths } };
    });
  }

  async unstage(workspaceId: string, paths: string[]): Promise<import("./types.js").GitResult<GitWritePathsResult>> {
    return this.graphWriteLock.withLock(workspaceId, async () => {
      const context = await this.graphWriteContext(workspaceId);
      if (!context.ok) return context.result;
      const safePaths = this.resolveRepoPaths(context.root, paths);
      if (!safePaths) {
        return writeFail("GIT_WRITE_BAD_PARAM", "无效的文件路径（仅支持仓库内相对路径）");
      }
      const output = await context.git.run(["reset", "--", ...safePaths], { cwd: context.root, timeoutMs: 30_000 });
      if (output.code !== 0) {
        return writeFail("GIT_WRITE_UNSTAGE_FAILED", output.stderr || "git reset 失败", true);
      }
      this.audit({
        aggregateId: workspaceId,
        type: "git.unstaged",
        payload: { workspaceId, paths: safePaths, count: safePaths.length },
      });
      return { ok: true, value: { paths: safePaths } };
    });
  }

  /**
   * 只提交用户已暂存的文件：绝不 `add -A`；提交信息 = 标题（必填）+ 可选正文；
   * CommitGuard 只检查已暂存路径（敏感路径/秘密/超大拒绝）。
   */
  async commitFiles(
    workspaceId: string,
    input: { title: string; body?: string },
  ): Promise<import("./types.js").GitResult<GitCommitCreateResult>> {
    return this.graphWriteLock.withLock(workspaceId, async () => {
      const context = await this.graphWriteContext(workspaceId);
      if (!context.ok) return context.result;
      const title = input.title.trim();
      if (!title || title.length > 100 || /[\r\n]/.test(title)) {
        return writeFail("GIT_WRITE_BAD_PARAM", "提交标题必填（1–100 字符，不含换行）");
      }
      const body = (input.body ?? "").replace(/\r\n/g, "\n").trim();
      if (body.length > 5_000) {
        return writeFail("GIT_WRITE_BAD_PARAM", "提交正文过长（≤5000 字符）");
      }
      const status = await context.git.run(["status", "--porcelain", "-z", "--untracked-files=all", "--ignore-submodules=none"], {
        cwd: context.root,
      });
      if (status.code !== 0) {
        return writeFail("GIT_WRITE_INTERNAL", "无法读取 git status", true);
      }
      const stagedEntries = this.parseStagedPaths(status.stdout);
      if (stagedEntries.length === 0) {
        return writeFail("GIT_WRITE_NOTHING_STAGED", "没有已暂存的文件；请先勾选并暂存要提交的文件");
      }
      // t395 F1：R/C 必须同时把旧路径与新路径交给 CommitGuard；否则
      // `.env → app.txt`、`.ssh/id_rsa → safe.txt` 可绕过敏感路径检查。
      const stagedPaths: string[] = [];
      const renames: Array<{ oldPath: string; newPath: string }> = [];
      for (const entry of stagedEntries) {
        if (entry.oldPath && entry.oldPath !== entry.path) {
          renames.push({ oldPath: entry.oldPath, newPath: entry.path });
          stagedPaths.push(entry.oldPath);
        }
        stagedPaths.push(entry.path);
      }
      const uniqueStagedPaths = Array.from(new Set(stagedPaths));
      const guardReason = new CommitGuard(context.git).checkPaths(context.root, uniqueStagedPaths);
      if (guardReason) {
        return writeFail("GIT_WRITE_GUARD_BLOCKED", `提交被安全守卫拒绝：${guardReason}`);
      }
      const message = body ? `${title}\n\n${body}` : title;
      const output = await context.git.run(["commit", "--no-verify", "-m", message], {
        cwd: context.root,
        timeoutMs: 60_000,
      });
      if (output.code !== 0) {
        return writeFail("GIT_WRITE_COMMIT_FAILED", output.stderr || "git commit 失败", true);
      }
      const head = await context.git.run(["rev-parse", "HEAD"], { cwd: context.root });
      const branchRaw = await context.git.run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: context.root });
      const sha = head.code === 0 ? head.stdout.trim() : "";
      const branch = branchRaw.code === 0 && branchRaw.stdout.trim() !== "HEAD" ? branchRaw.stdout.trim() : null;
      this.repoCache.delete(workspaceId);
      if (sha) {
        this.audit({
          aggregateId: workspaceId,
          type: "git.committed",
          payload: {
            workspaceId,
            sha,
            branch,
            files: uniqueStagedPaths,
            ...(renames.length ? { renames } : {}),
            title,
          },
        });
      }
      return {
        ok: true,
        value: {
          sha,
          branch,
          files: uniqueStagedPaths,
          ...(renames.length ? { renames } : {}),
          title,
        },
      };
    });
  }

  /** .gitignore 预览：内置模板仅列出缺失行，绝不覆盖现有内容。 */
  async ignorePreview(workspaceId: string): Promise<import("./types.js").GitResult<GitIgnorePreview>> {
    const context = await this.graphWriteContext(workspaceId);
    if (!context.ok) return context.result;
    const target = this.inspectIgnoreTarget(context.root);
    if ("error" in target) {
      return writeFail("GIT_WRITE_BAD_PARAM", target.error);
    }
    const ignorePath = target.path;
    const exists = target.exists;
    let existing = "";
    if (exists) {
      try {
        if (target.size > 256 * 1024) {
          return writeFail("GIT_WRITE_BAD_PARAM", ".gitignore 过大（>256KB），请手动编辑");
        }
        existing = readFileSync(ignorePath, "utf8");
      } catch {
        return writeFail("GIT_WRITE_INTERNAL", "无法读取现有 .gitignore", true);
      }
    }
    const existingLines = new Set(
      existing
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const additions = GITIGNORE_TEMPLATE.filter((line) => !existingLines.has(line.trim()));
    const base = existing
      ? existing.endsWith("\n")
        ? existing
        : `${existing}\n`
      : "";
    const preview = additions.length ? `${base}${additions.join("\n")}\n` : existing;
    return { ok: true, value: { exists, existing, additions, preview } };
  }

  /** 应用 .gitignore：仅追加缺失行；应用后作为未跟踪文件出现在工作区。 */
  async ignoreApply(workspaceId: string): Promise<import("./types.js").GitResult<GitIgnoreApplyResult>> {
    return this.graphWriteLock.withLock(workspaceId, async () => {
      const context = await this.graphWriteContext(workspaceId);
      if (!context.ok) return context.result;
      const preview = await this.ignorePreview(workspaceId);
      if (!preview.ok || !preview.value) {
        return {
          ok: false,
          errorCode: preview.errorCode ?? "GIT_WRITE_INTERNAL",
          message: preview.message ?? "无法预览 .gitignore",
          retryable: preview.retryable ?? true,
        };
      }
      if (preview.value.additions.length === 0) {
        return { ok: true, value: { addedLines: [], created: false } };
      }
      // t395 F2：写前再次 lstat/realpath 校验，防止 preview 后路径被替换为 symlink/junction。
      const target = this.inspectIgnoreTarget(context.root);
      if ("error" in target) {
        return writeFail("GIT_WRITE_BAD_PARAM", target.error);
      }
      if (preview.value.exists !== target.exists) {
        return writeFail("GIT_WRITE_BAD_PARAM", ".gitignore 状态已变化，请重新预览", true);
      }
      const ignorePath = target.path;
      try {
        if (preview.value.exists && preview.value.existing && !preview.value.existing.endsWith("\n")) {
          appendFileSync(ignorePath, "\n", "utf8");
        }
        appendFileSync(ignorePath, `${preview.value.additions.join("\n")}\n`, "utf8");
      } catch {
        return writeFail("GIT_WRITE_INTERNAL", "写入 .gitignore 失败", true);
      }
      this.audit({
        aggregateId: workspaceId,
        type: "git.ignore_updated",
        payload: { workspaceId, path: ".gitignore", addedLines: preview.value.additions },
      });
      return {
        ok: true,
        value: { addedLines: preview.value.additions, created: !preview.value.exists },
      };
    });
  }

  async readRepo(workspaceId: string): Promise<import("./types.js").GitResult<GitReadRepo>> {    const context = await this.readContext(workspaceId);
    if (!context.ok) return context.result as import("./types.js").GitResult<GitReadRepo>;
    const value = await context.reader.repoInfo();
    return value.ok && value.value ? { ok: true, value: { ...value.value, workspaceId } } : value;
  }

  async readGraph(workspaceId: string, params: { limit: number; offset: number; ref?: string }): Promise<import("./types.js").GitResult<GitGraphPage>> {
    const context = await this.readContext(workspaceId);
    if (!context.ok) return context.result as import("./types.js").GitResult<GitGraphPage>;
    const value = await context.reader.graph(params);
    if (value.ok && value.value) value.value.repo.workspaceId = workspaceId;
    return value;
  }

  async readRefs(workspaceId: string, limit = 200): Promise<import("./types.js").GitResult<GitRefsSnapshot>> {
    const context = await this.readContext(workspaceId);
    if (!context.ok) return context.result as import("./types.js").GitResult<GitRefsSnapshot>;
    return context.reader.refs(limit);
  }

  async readStatus(workspaceId: string): Promise<import("./types.js").GitResult<GitWorkingStatus>> {
    const context = await this.readContext(workspaceId);
    if (!context.ok) return context.result as import("./types.js").GitResult<GitWorkingStatus>;
    return context.reader.status();
  }

  async readCommit(workspaceId: string, sha: string): Promise<import("./types.js").GitResult<GitCommitDetail>> {
    const context = await this.readContext(workspaceId);
    if (!context.ok) return context.result as import("./types.js").GitResult<GitCommitDetail>;
    return context.reader.commit(sha);
  }

  async readDiff(workspaceId: string, params: GitDiffParams): Promise<import("./types.js").GitResult<GitDiffPage>> {
    const context = await this.readContext(workspaceId);
    if (!context.ok) return context.result as import("./types.js").GitResult<GitDiffPage>;
    return context.reader.diff(params);
  }

  saveSettings(workspaceId: string, patch: Partial<GitSettings>): GitSettings {
    const current = this.gitStore.getConfig(workspaceId);
    const next: GitSettings = {
      ...current,
      ...patch,
      workspaceId,
      maxWorktrees: Math.max(1, Math.min(3, Math.floor(patch.maxWorktrees ?? current.maxWorktrees))),
      checksTimeoutMs: Math.max(60_000, Math.min(1_800_000, patch.checksTimeoutMs ?? current.checksTimeoutMs)),
    };
    return this.gitStore.saveConfig(next);
  }

  async enqueue(taskId: string): Promise<MergeQueueItem> {
    return this.queue.enqueue(taskId);
  }

  async approve(taskId: string): Promise<MergeQueueItem> {
    const item = await this.queue.approve(taskId);
    return item;
  }

  async waiveChecks(taskId: string, reason: string): Promise<MergeQueueItem> {
    return this.queue.waiveChecks(taskId, reason);
  }

  async mergeStart(taskId: string): Promise<MergeQueueItem> {
    return this.queue.mergeStart(taskId);
  }

  async processQueue(workspaceId: string): Promise<MergeQueueItem> {
    return this.queue.process(workspaceId);
  }

  listQueue(workspaceId: string): MergeQueueSnapshot {
    return this.queue.list(workspaceId);
  }

  async recover(workspaceId: string): Promise<number> {
    await this.worktrees.reconcile(workspaceId);
    return this.queue.recover(workspaceId);
  }

  async cleanup(taskId: string): Promise<void> {
    const task = this.options.store.getTask(taskId);
    if (!task) throw new Error("task not found");
    await this.worktrees.cleanup(task.workspaceId, taskId);
  }

  async openPrUrl(taskId: string): Promise<string | null> {
    const vcs = this.gitStore.getTaskVcs(taskId);
    return vcs?.pr?.url ?? (vcs?.branch ? compareUrl((await this.repoFor(vcs.workspaceId)) as RepoInfo, vcs.branch) : null);
  }

  private async createConflictTask(input: {
    workspaceId: string;
    taskId: string;
    taskTitle: string;
    branch: string;
    baseBranch: string;
    prNumber: number | null;
    prUrl: string | null;
    conflictFiles: string[];
    baseSha: string | null;
  }): Promise<{ taskId: string; created: boolean }> {
    const existing = this.gitStore.listQueue(input.workspaceId).find(
      (item) =>
        item.conflictTaskId &&
        item.taskId === input.taskId &&
        item.baseSha === input.baseSha,
    );
    if (existing?.conflictTaskId) return { taskId: existing.conflictTaskId, created: false };
    if (input.prNumber != null) {
      const samePr = this.gitStore
        .listQueue(input.workspaceId)
        .filter((item) => item.prNumber === input.prNumber && item.conflictTaskId);
      if (samePr.length >= 2) {
        return { taskId: samePr[0]!.conflictTaskId!, created: false };
      }
    }
    const task = this.options.store.createTask({
      workspaceId: input.workspaceId,
      title: `解决合并冲突：${input.taskTitle}`,
      description: [
        `源任务：${input.taskId}`,
        `分支：${input.branch}`,
        `base：${input.baseBranch}`,
        input.prUrl ? `PR：${input.prUrl}` : "",
        input.conflictFiles.length ? `冲突文件：\n${input.conflictFiles.join("\n")}` : "",
        "请在源任务分支上解决冲突，提交并推送；完成后重新加入合并队列。",
      ]
        .filter(Boolean)
        .join("\n\n"),
      acceptance: ["冲突标记已清除", "checks 通过", "分支已推送"],
    });
    const settings = this.gitStore.getConfig(input.workspaceId);
    if (settings.mergeCaptain !== "human") {
      this.options.store.updateTask(task.id, { ownerId: settings.mergeCaptain });
    }
    this.gitStore.upsertTaskVcs({
      ...baseVcs(input.workspaceId, task.id, "git"),
      mode: "git",
      branch: input.branch,
      baseBranch: input.baseBranch,
      targetTaskId: input.taskId,
      targetBranch: input.branch,
    });
    return { taskId: task.id, created: true };
  }

  async getHead(workspaceId: string, ref: string): Promise<string | null> {
    const context = await this.contextFor(workspaceId);
    if (!context) return null;
    return revParse({ git: context.git, cwd: context.repo.root ?? context.repo.workspacePath, ref });
  }

  async verifyIntegrated(input: {
    workspaceId: string;
    taskId: string;
    integratedRef: string;
    allowAncestor?: boolean;
  }) {
    return this.queue.verifyIntegrated(input);
  }

  /** Exposed for the service/integration layer. */
  settingsDefaults(workspaceId: string): GitSettings {
    return { workspaceId, ...DEFAULT_GIT_SETTINGS };
  }
}
