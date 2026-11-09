import path from "node:path";
import type { Store } from "../kernel/store.js";
import type { TaskVcs, GitSettings, MergeQueueItem, MergeQueueSnapshot, PrInfo, PrepareRunInput, PrepareRunResult, RepoDiagnostics, RepoInfo, FinalizeRunInput, TaskVcsSnapshot } from "./types.js";
import { DEFAULT_GIT_SETTINGS } from "./types.js";
import { GitStore } from "./gitStore.js";
import { GitExec, redactSecrets } from "./gitExec.js";
import { detectRepo, ensureHooksDir, runtimeHooksPath } from "./repo.js";
import { CommitGuard } from "./commitGuard.js";
import { WorktreeManager } from "./worktreeManager.js";
import { ChecksRunner } from "./checksRunner.js";
import { MergeQueue, type QueueContext } from "./mergeQueue.js";
import { commitAll, pushBranch, revParse } from "./branchOps.js";
import { pickProvider, compareUrl } from "./providers.js";

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
    if (!record) return;
    const task = this.options.store.getTask(input.taskId);
    if (!task) return;
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
      const guard = new CommitGuard(git);
      const committed = await commitAll({
        git,
        worktree: cwd,
        message: `${input.status === "completed" ? "feat" : "wip"}(${task.id}): ${task.title}`,
        scan: () => guard.scan(cwd),
      });
      if (committed.ok && committed.commit) {
        commitSha = committed.commit.sha;
        this.options.store.appendEvent({
          aggregateType: "task",
          aggregateId: task.id,
          type: "git.commit",
          actor: "git-service",
          payload: { runId: input.runId, branch: record.branch, sha: commitSha, files: committed.commit.files },
        });
      } else if (!committed.ok) {
        errorCode = "GIT_COMMIT_BLOCKED";
        this.options.store.appendEvent({
          aggregateType: "task",
          aggregateId: task.id,
          type: "git.commit_blocked",
          actor: "git-service",
          payload: { runId: input.runId, reason: committed.reason ?? "blocked" },
        });
      }
    }

    if (commitSha) {
      const push = input.status === "completed" || (input.status === "failed" && settings.autoPushWip) || (input.status === "cancelled" && settings.pushOnCancel);
      if (push && repo.remote && record.branch.startsWith("deer/")) {
        const pushed = await pushBranch({ git, cwd, remote: settings.remote ?? "origin", branch: record.branch });
        if (pushed.ok) {
          this.options.store.appendEvent({
            aggregateType: "task",
            aggregateId: task.id,
            type: "git.pushed",
            actor: "git-service",
            payload: { runId: input.runId, branch: record.branch, remote: settings.remote ?? "origin", sha: commitSha },
          });
        } else {
          errorCode = pushed.error ?? "GIT_PUSH_NETWORK";
          this.options.store.appendEvent({
            aggregateType: "task",
            aggregateId: task.id,
            type: "git.push_failed",
            actor: "git-service",
            payload: { runId: input.runId, branch: record.branch, errorCode, retryable: true },
          });
        }
      }
      if (input.status === "completed" && settings.autoCreatePr) {
        try {
          const existingVcs = this.gitStore.getTaskVcs(task.id);
          if (existingVcs?.pr && existingVcs.pr.state !== "closed") {
            pr = await provider.refresh(repo, {
              number: existingVcs.pr.number,
              branch: record.branch,
            });
          } else {
            pr = await provider.createPr({
              repo,
              head: record.branch,
              base: settings.baseBranch,
              title: task.title,
              body: `Task: ${task.id}\n\n${task.description}`,
            });
          }
          this.gitStore.upsertPrRecord({
            provider: pr.provider,
            workspaceId: task.workspaceId,
            number: pr.number,
            branch: record.branch,
            url: pr.url,
            taskId: task.id,
            headSha: pr.headSha || commitSha,
            baseBranch: settings.baseBranch,
            state: pr.state,
            checks: pr.checks,
            review: pr.review,
            mergeable: pr.mergeable,
          });
          this.options.store.appendEvent({
            aggregateType: "task",
            aggregateId: task.id,
            type: "pr.created",
            actor: "git-service",
            payload: { provider: pr.provider, number: pr.number, url: pr.url, headSha: pr.headSha || commitSha, base: settings.baseBranch },
          });
        } catch (error) {
          errorCode = "PR_CREATE_FAILED";
          this.options.store.appendEvent({
            aggregateType: "task",
            aggregateId: task.id,
            type: "git.push_failed",
            actor: "git-service",
            payload: { runId: input.runId, errorCode, retryable: true, message: redactSecrets(error instanceof Error ? error.message : String(error)) },
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
      await this.worktrees.removeWorktree(record, `finalize:${input.status}`);
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
    const pr =
      vcs.pr && vcs.pr.state !== "closed"
        ? await context.provider.refresh(context.repo, { number: vcs.pr.number, branch: vcs.branch })
        : await context.provider.createPr({
            repo: context.repo,
            head: vcs.branch,
            base: context.settings.baseBranch,
            title: task.title,
            body: `Task: ${task.id}\n\n${task.description}`,
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

  async diagnose(workspaceId: string): Promise<RepoDiagnostics> {
    const workspace = this.options.store.getWorkspace(workspaceId);
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
    this.options.store.appendEvent({
      aggregateType: "task",
      aggregateId: task.id,
      type: "merge.conflict_task_created",
      actor: "merge-queue",
      payload: { sourceTaskId: input.taskId, branch: input.branch, pr: input.prNumber },
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
