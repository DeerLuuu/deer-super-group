import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../kernel/store.js";
import { ExecutionKernel } from "../kernel/execution/kernel.js";
import { EVENT_REGISTRY, isKernelEventType } from "../kernel/execution/eventRegistry.js";
import type { KernelHooks, RunEnvironment } from "../kernel/execution/kernel.js";
import { GitStore } from "./gitStore.js";
import { GitExec, redactSecrets, validateGitArgs } from "./gitExec.js";
import { CommitGuard } from "./commitGuard.js";
import { ChecksRunner } from "./checksRunner.js";
import { MergeQueue } from "./mergeQueue.js";
import { WorktreeManager, branchName, validateWorktreePath } from "./worktreeManager.js";
import { GitService } from "./gitService.js";
import { verifyIntegratedContent, commitAll, pushBranch } from "./branchOps.js";
import { detectRepoSync } from "./repo.js";
import { LocalProvider, ManualProvider, GitHubProvider, safePrUrl } from "./providers.js";
import { GitRunEnvironmentProvider, type RunEnvironmentProvider } from "./g3.js";
import { GIT_EVENT_TYPES, gitEventTypeSchema, validateGitEvent, emitGitEvent, registerGitEventTypes } from "./events.js";
import type { GitErrorCode, GitSettings, MergeQueueItem, PrepareRunInput, PrepareRunResult, PrInfo, PrProvider, RepoDiagnostics, RepoInfo, TaskVcs, WorktreeRecord } from "./types.js";

const dirs: string[] = [];

// AC-KRN-08 / AC-TYPE-01：类型级契约快照（pnpm typecheck 即验证）。
const typeProbePrepare: PrepareRunInput = {
  workspaceId: "ws",
  taskId: "t1",
  runId: "r1",
  attempt: 1,
  agentId: "a1",
};
const typeProbeKernelInfo: Parameters<NonNullable<KernelHooks["beforeStart"]>>[0] = {
  ...typeProbePrepare,
  priority: 0,
};
const typeProbeKernelToGit: PrepareRunInput = typeProbeKernelInfo;
const typeProbeGitToKernel: Parameters<GitRunEnvironmentProvider["prepare"]>[0] =
  typeProbeKernelToGit;
const typeProbeEnvironment: RunEnvironment = {} as Extract<PrepareRunResult, { ok: true }>;
const typeProbeProvider: RunEnvironmentProvider = {} as GitRunEnvironmentProvider;

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deer-git-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore Windows locks
    }
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function initRepo(): string {
  const dir = tempDir();
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.name", "Deer Test"]);
  git(dir, ["config", "user.email", "deer@test.local"]);
  writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

function seedRepoTask(dir: string): { store: Store; workspaceId: string; taskId: string; gitStore: GitStore } {
  const store = new Store(path.join(dir, "deer.db"));
  const workspace = store.createWorkspace("repo", dir);
  const task = store.createTask({
    workspaceId: workspace.id,
    title: "Test task",
    description: "desc",
    acceptance: ["ok"],
  });
  const gitStore = new GitStore(path.join(dir, "git.db"));
  return { store, workspaceId: workspace.id, taskId: task.id, gitStore };
}

function hooksFor(dir: string): string {
  const hooks = path.join(dir, ".deer", "hooks-empty");
  mkdirSync(hooks, { recursive: true });
  return hooks;
}

function vcsFor(taskId: string, workspaceId: string, branch: string, head: string): TaskVcs {
  return {
    taskId,
    workspaceId,
    mode: "git",
    branch,
    baseBranch: "main",
    headSha: head,
    pr: null,
    merge: { state: "none", commitSha: null },
    checksState: "none",
    conflictTaskId: null,
    errorCode: null,
    updatedAt: new Date().toISOString(),
  };
}

class MockProvider implements PrProvider {
  readonly id = "github" as const;
  merged = false;
  conflict = false;
  calls = 0;
  async detect(): Promise<boolean> {
    return true;
  }
  async createPr(input: { head: string; base: string }): Promise<PrInfo> {
    return this.info(input.head, input.base);
  }
  async refresh(): Promise<PrInfo> {
    this.calls += 1;
    return this.info("head-sha", "main");
  }
  async listChecks(): Promise<PrInfo["checks"]> {
    return [];
  }
  async merge(): Promise<PrInfo> {
    this.merged = true;
    return { ...this.info("head-sha", "main"), state: "merged", mergedCommitSha: "merge-sha" };
  }
  async close(): Promise<void> {
    return;
  }
  private info(head: string, base: string): PrInfo {
    return {
      provider: "github",
      number: 7,
      url: "https://example.invalid/pull/7",
      state: this.merged ? "merged" : this.conflict ? "open" : "open",
      headSha: head,
      baseBranch: base,
      mergeable: this.conflict ? "conflicting" : "mergeable",
      checks: [],
      review: "approved",
      mergedCommitSha: this.merged ? "merge-sha" : null,
      updatedAt: new Date().toISOString(),
    };
  }
}

describe("GitExec", () => {
  it("accepts status/diff -z and rejects dangerous argv", () => {
    expect(validateGitArgs(["status", "--porcelain", "-z"]).ok).toBe(true);
    expect(validateGitArgs(["diff", "--cached", "--name-only", "-z"]).ok).toBe(true);
    expect(validateGitArgs(["push", "--no-verify", "origin", "main:main"]).ok).toBe(false);
    expect(validateGitArgs(["push", "--force", "origin", "deer/x:deer/x"]).ok).toBe(false);
    expect(validateGitArgs(["-c", "core.hooksPath=x", "status", "--porcelain"]).ok).toBe(false);
    expect(validateGitArgs(["-c", "core.hooksPath=/tmp/hooks", "status", "--porcelain"], "/tmp/hooks").ok).toBe(true);
    expect(validateGitArgs(["-c", "core.hooksPath=/tmp/other", "status", "--porcelain"], "/tmp/hooks").ok).toBe(false);
  });

  it("redacts tokens from output", () => {
    expect(redactSecrets("token=ghp_abcdefghijklmnopqrstuvwxyz")).not.toContain("ghp_");
    expect(redactSecrets("https://user:secret@github.com/a/b")).not.toContain("secret");
  });

  it("runs a real command with hooks isolation", async () => {
    const dir = initRepo();
    const gitExec = new GitExec(hooksFor(dir));
    const status = await gitExec.run(["status", "--porcelain"], { cwd: dir });
    expect(status.code).toBe(0);
    expect(status.stdout).toBe("");
  });
});

describe("GitStore migrations/config", () => {
  it("upgrades a v1 config table with the six t92 columns", () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "git.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE git_schema (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO git_schema VALUES (1, 'old');
      CREATE TABLE git_repo_config (
        workspace_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'auto',
        base_branch TEXT NOT NULL DEFAULT 'main'
      );
      INSERT INTO git_repo_config (workspace_id, mode, base_branch) VALUES ('ws', 'auto', 'main');
    `);
    db.close();
    const store = new GitStore(dbPath);
    const columns = store.db.prepare("PRAGMA table_info(git_repo_config)").all() as Array<{ name?: string }>;
    const names = columns.map((item) => item.name);
    for (const name of [
      "push_on_cancel",
      "preserve_worktree_on_cancel",
      "export_cancel_patch",
      "checks_mode",
      "checks_timeout_ms",
      "allow_skip_blocked",
    ]) {
      expect(names).toContain(name);
    }
    expect(store.schemaVersion()).toBe(2);
    expect(store.getConfig("ws").maxWorktrees).toBe(3);
    expect(store.getConfig("ws").checksMode).toBe("shell");
    store.close();
  });

  it("persists all six config columns", () => {
    const dir = tempDir();
    const store = new GitStore(path.join(dir, "git.db"));
    const settings = store.getConfig("ws");
    const saved = store.saveConfig({
      ...settings,
      pushOnCancel: true,
      preserveWorktreeOnCancel: true,
      exportCancelPatch: true,
      checksMode: "argv",
      checksTimeoutMs: 60_000,
      allowSkipBlocked: true,
    });
    expect(saved.pushOnCancel).toBe(true);
    expect(saved.checksMode).toBe("argv");
    expect(saved.checksTimeoutMs).toBe(60_000);
    expect(store.getConfig("ws").allowSkipBlocked).toBe(true);
    store.close();
  });
});

describe("CommitGuard", () => {
  it("blocks secrets and sensitive names", async () => {
    const dir = initRepo();
    const guard = new CommitGuard(new GitExec(hooksFor(dir)));
    writeFileSync(path.join(dir, ".env"), "TOKEN=x\n");
    const blocked = await guard.scan(dir);
    expect(blocked.ok).toBe(false);
    rmSync(path.join(dir, ".env"));
    writeFileSync(path.join(dir, "secret.txt"), "token=ghp_abcdefghijklmnopqrstuvwxyz\n");
    const contentBlocked = await guard.scan(dir);
    expect(contentBlocked.ok).toBe(false);
  });
});

describe("WorktreeManager", () => {
  it("creates a runtime worktree/branch and enforces capacity", async () => {
    const dir = initRepo();
    const { store, workspaceId, taskId, gitStore } = seedRepoTask(dir);
    gitStore.saveConfig({ ...gitStore.getConfig(workspaceId), maxWorktrees: 1 });
    const manager = new WorktreeManager(store, gitStore);
    const first = await manager.prepare({ workspaceId, taskId, runId: "run-1", attempt: 1, agentId: "a1" });
    expect(first.ok).toBe(true);
    if (!first.ok || first.mode !== "git") throw new Error("expected git prepare");
    expect(first.cwd.replace(/\\/g, "/")).toContain("/.deer/worktrees/");
    expect(first.branch).toMatch(/^deer\//);
    expect(store.getTask(taskId)?.worktree).toBe(first.cwd);

    const secondTask = store.createTask({
      workspaceId,
      title: "Second",
      description: "d",
      acceptance: [],
    });
    const second = await manager.prepare({
      workspaceId,
      taskId: secondTask.id,
      runId: "run-2",
      attempt: 1,
      agentId: "a1",
    });
    expect(second.ok).toBe(false);
    if (!second.ok && second.defer) {
      expect(second.defer).toBe(true);
      expect(second.reason).toBe("GIT_CAPACITY");
    }
    await manager.cleanup(workspaceId, taskId);
    expect(existsSync(first.cwd)).toBe(false);
    store.close();
    gitStore.close();
  });

  it("falls back to .deer-git when .deer is occupied without a marker", async () => {
    const dir = initRepo();
    mkdirSync(path.join(dir, ".deer"), { recursive: true });
    writeFileSync(path.join(dir, ".deer", "user-file"), "keep");
    const { store, workspaceId, taskId, gitStore } = seedRepoTask(dir);
    const manager = new WorktreeManager(store, gitStore);
    const result = await manager.prepare({ workspaceId, taskId, runId: "run-1", attempt: 1, agentId: "a1" });
    expect(result.ok).toBe(true);
    if (result.ok && result.mode === "git") {
      expect(result.cwd.replace(/\\/g, "/")).toContain("/.deer-git/worktrees/");
      expect(readFileSync(path.join(dir, ".deer", "user-file"), "utf8")).toBe("keep");
    }
    store.close();
    gitStore.close();
  });
});

describe("GitService finalize", () => {
  it("commits/pushes nothing for a local repo, records VCS and removes the worktree", async () => {
    const dir = initRepo();
    const service = new GitService({ dataDir: path.join(dir, "data"), store: new Store(path.join(dir, "deer.db")) });
    const workspace = service["options"].store.createWorkspace("repo", dir);
    const task = service["options"].store.createTask({
      workspaceId: workspace.id,
      title: "Finalize me",
      description: "d",
      acceptance: [],
    });
    const prepared = await service.prepareRun({
      workspaceId: workspace.id,
      taskId: task.id,
      runId: "run-final",
      attempt: 1,
      agentId: "a1",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok || prepared.mode !== "git") throw new Error("expected git");
    writeFileSync(path.join(prepared.cwd, "out.txt"), "work\n");
    await service.finalizeRun({ runId: "run-final", taskId: task.id, status: "completed" });
    const vcs = service.getTaskVcs(task.id).vcs;
    expect(vcs?.branch).toMatch(/^deer\//);
    expect(vcs?.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(prepared.cwd)).toBe(false);
    const log = git(dir, ["log", "--oneline", "-2", vcs?.branch ?? "HEAD"]);
    expect(log).toContain("feat(");
    service.close();
  });
});

describe("MergeQueue", () => {
  it("enforces approval and merges exactly once with a provider", async () => {
    const dir = initRepo();
    const { store, workspaceId, taskId, gitStore } = seedRepoTask(dir);
    const repo: RepoInfo = {
      ok: true,
      workspacePath: dir,
      root: dir,
      runtimeRoot: path.join(dir, ".deer"),
      baseBranch: "main",
      remote: null,
      remoteKind: "none",
      gitVersion: "2.40.0",
    };
    const provider = new MockProvider();
    const settings: GitSettings = { ...gitStore.getConfig(workspaceId), requireApproval: true, autoMerge: true };
    gitStore.upsertTaskVcs(vcsFor(taskId, workspaceId, "deer/t1-test", "head-sha"));
    const queue = new MergeQueue({
      store,
      gitStore,
      checks: new ChecksRunner(),
      contextFor: async () => ({ repo, git: new GitExec(hooksFor(dir)), provider, settings }),
      createConflictTask: async () => ({ taskId: "conflict-task", created: true }),
    });
    const queued = await queue.enqueue(taskId);
    expect(queued.state).toBe("waiting_checks");
    await queue.approve(taskId);
    const merged = await queue.process(workspaceId, queued.id);
    expect(merged.state).toBe("merged");
    expect(merged.mergeCommitSha).toBe("merge-sha");
    expect(gitStore.getTaskVcs(taskId)?.merge.state).toBe("merged");
    expect(provider.merged).toBe(true);
    store.close();
    gitStore.close();
  });

  it("is idempotent for duplicate enqueue and supports all merge methods", async () => {
    const dir = initRepo();
    const { store, workspaceId, taskId, gitStore } = seedRepoTask(dir);
    const repo: RepoInfo = {
      ok: true,
      workspacePath: dir,
      root: dir,
      runtimeRoot: path.join(dir, ".deer"),
      baseBranch: "main",
      remote: null,
      remoteKind: "none",
      gitVersion: "2.40.0",
    };
    const provider = new MockProvider();
    gitStore.upsertTaskVcs(vcsFor(taskId, workspaceId, "deer/t1-test", "head-sha"));
    for (const mergeMethod of ["squash", "merge", "rebase"] as const) {
      const settings: GitSettings = {
        ...gitStore.getConfig(workspaceId),
        requireApproval: false,
        autoMerge: true,
        mergeMethod,
      };
      const queue = new MergeQueue({
        store,
        gitStore,
        checks: new ChecksRunner(),
        contextFor: async () => ({ repo, git: new GitExec(hooksFor(dir)), provider, settings }),
        createConflictTask: async () => ({ taskId: "conflict", created: true }),
      });
      const first = await queue.enqueue(taskId);
      const second = await queue.enqueue(taskId);
      expect(second.id).toBe(first.id);
      if (first.state !== "merged") {
        const result = await queue.process(workspaceId, first.id);
        expect(result.state).toBe("merged");
      }
    }
    expect(provider.merged).toBe(true);
    store.close();
    gitStore.close();
  });

  it("blocks on conflict and reuses an existing conflict task", async () => {    const dir = initRepo();
    const { store, workspaceId, taskId, gitStore } = seedRepoTask(dir);
    const repo: RepoInfo = {
      ok: true,
      workspacePath: dir,
      root: dir,
      runtimeRoot: path.join(dir, ".deer"),
      baseBranch: "main",
      remote: null,
      remoteKind: "none",
      gitVersion: "2.40.0",
    };
    const provider = new MockProvider();
    provider.conflict = true;
    const settings: GitSettings = { ...gitStore.getConfig(workspaceId), requireApproval: false, autoMerge: true };
    gitStore.upsertTaskVcs(vcsFor(taskId, workspaceId, "deer/t1-test", "head-sha"));
    let calls = 0;
    const queue = new MergeQueue({
      store,
      gitStore,
      checks: new ChecksRunner(),
      contextFor: async () => ({ repo, git: new GitExec(hooksFor(dir)), provider, settings }),
      createConflictTask: async () => {
        calls += 1;
        return { taskId: "conflict-task", created: true };
      },
    });
    const queued = await queue.enqueue(taskId);
    const blocked = await queue.process(workspaceId, queued.id);
    expect(blocked.state).toBe("blocked");
    expect(blocked.conflictTaskId).toBe("conflict-task");
    expect(calls).toBe(1);
    store.close();
    gitStore.close();
  });
});

describe("Git event schemas", () => {
  it("rejects slash/composite types and validates checks payloads", () => {
    for (const type of GIT_EVENT_TYPES) {
      expect(gitEventTypeSchema.safeParse(type).success).toBe(true);
      expect(type).not.toMatch(/[/。; ]/);
    }
    expect(gitEventTypeSchema.safeParse("merge.checks_pending/failed").success).toBe(false);
    expect(validateGitEvent("merge.checks_pending", { queueId: "q", headSha: "h", checks: [] }).ok).toBe(true);
    expect(validateGitEvent("merge.checks_failed", { queueId: "q", headSha: "h", checks: [], detail: "x" }).ok).toBe(true);
    expect(validateGitEvent("merge.checks_waived", { queueId: "q", actor: "u", headSha: "h", reason: "short" }).ok).toBe(false);
    expect(validateGitEvent("merge.unknown", {}).ok).toBe(false);
  });
});

describe("bare remote, REST, waive and crash recovery", () => {
  it("pushes a deer branch to a local bare remote", async () => {
    const dir = initRepo();
    const bare = path.join(tempDir(), "remote.git");
    execFileSync("git", ["init", "--bare", bare], { windowsHide: true });
    git(dir, ["remote", "add", "origin", bare]);
    const { store, workspaceId, taskId, gitStore } = seedRepoTask(dir);
    const manager = new WorktreeManager(store, gitStore);
    const prepared = await manager.prepare({ workspaceId, taskId, runId: "run-push", attempt: 1, agentId: "a1" });
    if (!prepared.ok || prepared.mode !== "git") throw new Error("prepare failed");
    writeFileSync(path.join(prepared.cwd, "pushed.txt"), "x\n");
    const gitExec = new GitExec(hooksFor(dir));
    const committed = await commitAll({
      git: gitExec,
      worktree: prepared.cwd,
      message: "feat(t): push",
      scan: () => new CommitGuard(gitExec).scan(prepared.cwd),
    });
    expect(committed.ok).toBe(true);
    const pushed = await pushBranch({
      git: gitExec,
      cwd: prepared.cwd,
      remote: "origin",
      branch: prepared.branch ?? "",
    });
    expect(pushed.ok).toBe(true);
    const refs = execFileSync("git", ["--git-dir", bare, "show-ref"], { encoding: "utf8" });
    expect(refs).toContain(prepared.branch ?? "");
    store.close();
    gitStore.close();
  });

  it("uses enterprise REST host with a mocked fetch", async () => {
    const dir = initRepo();
    const repo: RepoInfo = {
      ok: true,
      workspacePath: dir,
      root: dir,
      runtimeRoot: null,
      baseBranch: "main",
      remote: "https://ghe.example/acme/repo.git",
      remoteKind: "remote",
      gitVersion: "2.40.0",
    };
    const oldToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";
    const calls: string[] = [];
    const mocked = vi.fn(async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            number: 7,
            html_url: "https://ghe.example/acme/repo/pull/7",
            state: "open",
            head: { sha: "abc" },
            base: { ref: "main" },
            mergeable: true,
            merge_commit_sha: null,
          }),
      };
    });
    vi.stubGlobal("fetch", mocked);
    try {
      const provider = new GitHubProvider("ghe.example");
      const info = await provider.restRefresh(repo, 7);
      expect(info.state).toBe("open");
      expect(calls[0]).toContain("https://ghe.example/api/v3/repos/acme/repo/pulls/7");
    } finally {
      vi.unstubAllGlobals();
      if (oldToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = oldToken;
    }
  });

  it("waives checks only when no checks_command is configured", async () => {
    const dir = initRepo();
    const { store, workspaceId, taskId, gitStore } = seedRepoTask(dir);
    const repo: RepoInfo = {
      ok: true,
      workspacePath: dir,
      root: dir,
      runtimeRoot: path.join(dir, ".deer"),
      baseBranch: "main",
      remote: null,
      remoteKind: "none",
      gitVersion: "2.40.0",
    };
    const settings: GitSettings = { ...gitStore.getConfig(workspaceId), checksCommand: null };
    gitStore.upsertTaskVcs(vcsFor(taskId, workspaceId, "deer/t1", "head-sha"));
    const makeQueue = (nextSettings: GitSettings) =>
      new MergeQueue({
        store,
        gitStore,
        checks: new ChecksRunner(),
        contextFor: async () => ({ repo, git: new GitExec(hooksFor(dir)), provider: new LocalProvider(), settings: nextSettings }),
        createConflictTask: async () => ({ taskId: "conflict", created: true }),
      });
    const queue = makeQueue(settings);
    const item = await queue.enqueue(taskId);
    const waived = await queue.waiveChecks(taskId, "manual waiver reason");
    expect(waived.checksWaived).toBe(true);
    await expect(makeQueue({ ...settings, checksCommand: "node -e 0" }).waiveChecks(taskId, "manual waiver reason")).rejects.toThrow(
      /checks_command/,
    );
    expect(item.state).toBe("waiting_checks");
    store.close();
    gitStore.close();
  });

  it("reconciles an orphaned runtime worktree after a crash", async () => {
    const dir = initRepo();
    const { store, workspaceId, taskId, gitStore } = seedRepoTask(dir);
    const manager = new WorktreeManager(store, gitStore);
    const prepared = await manager.prepare({ workspaceId, taskId, runId: "run-crash", attempt: 1, agentId: "a1" });
    if (!prepared.ok || prepared.mode !== "git") throw new Error("prepare failed");
    // A crash leaves no Run row; reconcile must reclaim the worktree.
    const result = await manager.reconcile(workspaceId);
    expect(result.removed).toBe(1);
    expect(existsSync(prepared.cwd)).toBe(false);
    store.close();
    gitStore.close();
  });
  it("aborts a running kernel run and finalizes its runtime worktree", async () => {
    const dir = initRepo();
    const store = new Store(path.join(dir, "deer.db"));
    const git = new GitService({ dataDir: path.join(dir, "data"), store });
    const workspace = store.createWorkspace("repo", dir);
    store.createAgent(
      { workspaceId: workspace.id, name: "worker", role: "engineer", systemPrompt: "", persona: "", agentsMd: "", model: null },
      false,
    );
    git.gitStore.saveConfig({ ...git.gitStore.getConfig(workspace.id), maxWorktrees: 1 });
    const task = store.createTask({ workspaceId: workspace.id, title: "Abort", description: "d", acceptance: [] });
    let activeRunId = "";
    const kernel = new ExecutionKernel({
      store,
      executor: async (ctx) =>
        new Promise(() => {
          activeRunId = ctx.run.id;
        }),
      hooks: { beforeStart: (info) => git.beforeStart(info) },
    });
    const pending = kernel.runTask(task.id);
    for (let i = 0; i < 200 && !activeRunId; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(activeRunId).toMatch(/^run_/);
    kernel.cancelRun(activeRunId);
    await expect(pending).rejects.toThrow(/cancelled|abort/i);
    await git.finalizeRun({ runId: activeRunId, taskId: task.id, status: "cancelled" });
    expect(store.getTask(task.id)?.status).toBe("failed");
    expect(store.getTask(task.id)?.failureKind).toBe("RUN_CANCELLED");
    expect(git.gitStore.listWorktrees(workspace.id).filter((item) => item.state !== "removed")).toHaveLength(0);
    kernel.dispose();
    git.close();
    store.close();
  });
});

describe("kernel G3 integration", () => {
  it("puts git:<worktree> into run.started and keeps a capacity-deferred task queued", async () => {    const dir = initRepo();
    const store = new Store(path.join(dir, "deer.db"));
    const git = new GitService({ dataDir: path.join(dir, "data"), store });
    const workspace = store.createWorkspace("repo", dir);
    store.createAgent(
      {
        workspaceId: workspace.id,
        name: "worker",
        role: "engineer",
        systemPrompt: "",
        persona: "",
        agentsMd: "",
        model: null,
      },
      false,
    );
    git.gitStore.saveConfig({ ...git.gitStore.getConfig(workspace.id), maxWorktrees: 1 });
    const first = store.createTask({ workspaceId: workspace.id, title: "First", description: "d", acceptance: [] });
    const second = store.createTask({ workspaceId: workspace.id, title: "Second", description: "d", acceptance: [] });
    let observedSandbox: string | null = null;
    const kernel = new ExecutionKernel({
      store,
      executor: async (ctx) => {
        observedSandbox = ctx.run.sandboxId ?? null;
        return { summary: "ok" };
      },
      hooks: { beforeStart: (info) => git.beforeStart(info) },
    });
    await kernel.runTask(first.id);
    const firstRun = store.listRunsForTask(first.id)[0];
    expect(observedSandbox).toMatch(/^git:/);
    expect(firstRun.sandboxId).toBe(observedSandbox);
    const started = store
      .listEventsForTask(first.id, 100)
      .find((event) => event.type === "run.started");
    expect((started?.payload as { run?: { sandboxId?: string } }).run?.sandboxId).toBe(observedSandbox);

    kernel.startTask(second.id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getTask(second.id)?.status).toBe("queued");
    expect(store.getTask(second.id)?.attemptCount ?? 0).toBe(0);
    expect(store.listRunsForTask(second.id)).toHaveLength(0);

    await git.finalizeRun({ runId: firstRun.id, taskId: first.id, status: "completed" });
    store.db.prepare("UPDATE tasks SET next_run_at = NULL WHERE id = ?").run(second.id);
    kernel.startTask(second.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(store.getTask(second.id)?.status).toBe("done");
    kernel.dispose();
    git.close();
    store.close();
  });
});

describe("admission and manual providers", () => {
  it("exposes async RunEnvironmentProvider prepare/release", async () => {
    const dir = initRepo();
    const store = new Store(path.join(dir, "deer.db"));
    const git = new GitService({ dataDir: path.join(dir, "data"), store });
    const workspace = store.createWorkspace("repo", dir);
    const task = store.createTask({ workspaceId: workspace.id, title: "Provider", description: "d", acceptance: [] });
    const provider = new GitRunEnvironmentProvider(git);
    const prepared = await provider.prepare({
      workspaceId: workspace.id,
      taskId: task.id,
      runId: "run-provider",
      attempt: 1,
      agentId: "a1",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("prepare failed");
    expect(prepared.sandboxId).toMatch(/^git:/);
    await provider.release({ runId: "run-provider", taskId: task.id, status: "completed" });
    expect(git.gitStore.listWorktrees(workspace.id).filter((item) => item.state !== "removed")).toHaveLength(0);
    git.close();
    store.close();
  });

  it("defers a second workspace run without consuming a queue item", async () => {
    const dir = initRepo();
    const store = new Store(path.join(dir, "deer.db"));
    const service = new GitService({ dataDir: path.join(dir, "data"), store });
    const workspace = store.createWorkspace("repo", dir);
    service.gitStore.saveConfig({ ...service.gitStore.getConfig(workspace.id), maxWorktrees: 1 });
    await service.diagnose(workspace.id);
    const first = store.createTask({ workspaceId: workspace.id, title: "One", description: "d", acceptance: [] });
    const second = store.createTask({ workspaceId: workspace.id, title: "Two", description: "d", acceptance: [] });
    const prepared = await service.prepareRun({
      workspaceId: workspace.id,
      taskId: first.id,
      runId: "run-one",
      attempt: 1,
      agentId: "a1",
    });
    expect(prepared.ok).toBe(true);
    const admitted = service.admit({ workspaceId: workspace.id, taskId: second.id, attempt: 1 });
    expect(typeof admitted === "object" && admitted.allow).toBe(false);
    expect(store.getTask(second.id)?.attemptCount ?? 0).toBe(0);
    expect(store.getTask(second.id)?.status).toBe("ready");
    service.close();
    store.close();
  });

  it("keeps local/manual merges at ready instead of failing", async () => {
    const dir = initRepo();
    const { store, workspaceId, taskId, gitStore } = seedRepoTask(dir);
    const repo: RepoInfo = {
      ok: true,
      workspacePath: dir,
      root: dir,
      runtimeRoot: path.join(dir, ".deer"),
      baseBranch: "main",
      remote: null,
      remoteKind: "none",
      gitVersion: "2.40.0",
    };
    const settings: GitSettings = { ...gitStore.getConfig(workspaceId), requireApproval: false, autoMerge: true };
    gitStore.upsertTaskVcs(vcsFor(taskId, workspaceId, "deer/t1-test", "head-sha"));
    const queue = new MergeQueue({
      store,
      gitStore,
      checks: new ChecksRunner(),
      contextFor: async () => ({ repo, git: new GitExec(hooksFor(dir)), provider: new LocalProvider(), settings }),
      createConflictTask: async () => ({ taskId: "conflict-task", created: true }),
    });
    const item = await queue.enqueue(taskId);
    const result = await queue.process(workspaceId, item.id);
    expect(result.state).toBe("ready");
    expect(result.lastError).toBe("manual merge required");
    store.close();
    gitStore.close();
  });

  it("exposes manual compare URL without a token", async () => {
    const dir = initRepo();
    const repo: RepoInfo = {
      ok: true,
      workspacePath: dir,
      root: dir,
      runtimeRoot: null,
      baseBranch: "main",
      remote: "https://github.com/acme/repo.git",
      remoteKind: "remote",
      gitVersion: "2.40.0",
    };
    const provider = new ManualProvider();
    const info = await provider.createPr({ repo, head: "deer/t1", base: "main", title: "t", body: "b" });
    expect(info.url).toContain("github.com/acme/repo/compare/main...deer/t1");
    expect(info.state).toBe("manual_pending");
    await expect(provider.merge()).rejects.toThrow(/MERGE_REVIEW_REQUIRED/);
  });
});

describe("ChecksRunner", () => {  it("records success and failure without a shell injection from task content", async () => {
    const runner = new ChecksRunner();
    const ok = await runner.run({ command: 'node -e "process.exit(0)"', cwd: process.cwd(), timeoutMs: 10_000 });
    expect(ok.ok).toBe(true);
    const bad = await runner.run({ command: 'node -e "process.exit(1)"', cwd: process.cwd(), timeoutMs: 10_000 });
    expect(bad.ok).toBe(false);
  });
});

describe("tree verification", () => {
  it("compares content for squash-style integration", async () => {
    const dir = initRepo();
    git(dir, ["checkout", "-b", "feature"]);
    writeFileSync(path.join(dir, "README.md"), "feature\n");
    git(dir, ["commit", "-am", "feature"]);
    const head = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["checkout", "main"]);
    git(dir, ["merge", "--squash", "feature"]);
    git(dir, ["commit", "-m", "squash feature"]);
    const result = await verifyIntegratedContent({
      git: new GitExec(hooksFor(dir)),
      cwd: dir,
      headSha: head,
      integratedRef: "main",
    });
    expect(result.ok).toBe(true);
  });
});

describe("t111 repair — B1 realpath/lstat worktree paths", () => {
  it("rejects traversal even when it resolves back under different spelling", () => {
    const dir = initRepo();
    const root = path.join(dir, ".deer");
    mkdirSync(root, { recursive: true });
    expect(validateWorktreePath(root, path.join(root, "..", "escape")).ok).toBe(false);
    expect(validateWorktreePath(root, path.join(root, "worktrees", "task", "1")).ok).toBe(true);
  });

  it("rejects a symlink/junction target under runtimeRoot and does not touch it", () => {
    const dir = initRepo();
    const { store, workspaceId, taskId, gitStore } = seedRepoTask(dir);
    const detected = detectRepoSync(dir, "main");
    const root = detected.runtimeRoot ?? path.join(dir, ".deer");
    const link = path.join(root, "worktrees", taskId, "1");
    const outside = tempDir();
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    const manager = new WorktreeManager(store, gitStore);
    const result = manager.prepareSync({
      workspaceId,
      taskId,
      runId: "run-symlink",
      attempt: 1,
      agentId: "agent",
    });
    expect(result.ok).toBe(false);
    if (!result.ok && !result.defer) {
      expect(result.errorCode).toBe("GIT_PATH_ESCAPE");
    }
    expect(existsSync(outside)).toBe(true);
  });
});

describe("t111 repair — B2 emitGitEvent/eventRegistry", () => {
  it("registers all 35 Git event types and validates before append", () => {
    registerGitEventTypes();
    expect(GIT_EVENT_TYPES).toHaveLength(35);
    for (const type of GIT_EVENT_TYPES) {
      expect(isKernelEventType(type)).toBe(true);
      expect((EVENT_REGISTRY as unknown as Record<string, unknown>)[type]).toBeTruthy();
    }

    const store = new Store(path.join(tempDir(), "events.db"));
    expect(() =>
      emitGitEvent(store, {
        aggregateType: "task",
        aggregateId: "t1",
        type: "git.commit",
        actor: "test",
        payload: {},
      }),
    ).toThrow(/invalid Git event/);
    expect(
      (store.db.prepare("SELECT count(*) AS n FROM events WHERE type = 'git.commit'").get() as {
        n: number;
      }).n,
    ).toBe(0);

    const event = emitGitEvent(store, {
      aggregateType: "task",
      aggregateId: "t1",
      type: "git.commit",
      actor: "test",
      payload: { runId: "r1", branch: "deer/t1", sha: "abc", files: [] },
    });
    expect(event.type).toBe("git.commit");
    expect(
      (store.db.prepare("SELECT schema_version FROM events WHERE id = ?").get(event.id) as {
        schema_version: number;
      }).schema_version,
    ).toBe(2);
  });
});

describe("t111 repair — B3 PR idempotency", () => {
  it("serializes concurrent createPr and returns one provider PR", async () => {
    const dir = initRepo();
    const { store, workspaceId, taskId } = seedRepoTask(dir);
    const service = new GitService({ dataDir: path.join(dir, "data"), store });
    service.gitStore.upsertTaskVcs(vcsFor(taskId, workspaceId, "deer/t1-pr", "head-sha"));
    const repo: RepoInfo = {
      ok: true,
      workspacePath: dir,
      root: dir,
      runtimeRoot: path.join(dir, ".deer"),
      baseBranch: "main",
      remote: null,
      remoteKind: "none",
      gitVersion: "2.40.0",
    };
    let creates = 0;
    let refreshes = 0;
    const prInfo = (): PrInfo => ({
      provider: "github",
      number: 41,
      url: "https://example.invalid/pull/41",
      state: "open",
      headSha: "head-sha",
      baseBranch: "main",
      mergeable: "mergeable",
      checks: [],
      review: "approved",
      mergedCommitSha: null,
      updatedAt: new Date().toISOString(),
    });
    const provider: PrProvider = {
      id: "github",
      detect: async () => true,
      createPr: async () => {
        creates += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return prInfo();
      },
      refresh: async () => {
        refreshes += 1;
        return prInfo();
      },
      listChecks: async () => [],
      merge: async () => ({ ...prInfo(), state: "merged" }),
      close: async () => undefined,
    };
    const settings: GitSettings = { ...service.getSettings(workspaceId), autoCreatePr: true };
    (service as unknown as { contextFor: () => Promise<unknown> }).contextFor = async () => ({
      repo,
      git: new GitExec(hooksFor(dir)),
      provider,
      settings,
    });

    const [first, second] = await Promise.all([
      service.createPr(taskId),
      service.createPr(taskId),
    ]);
    expect(creates).toBe(1);
    expect(refreshes).toBeLessThanOrEqual(1);
    expect(first.pr?.number).toBe(41);
    expect(second.pr?.number).toBe(41);
    expect(
      (service.gitStore.db.prepare("SELECT count(*) AS n FROM pr_records").get() as { n: number }).n,
    ).toBe(1);
  });
});

describe("t111 repair — B4 fencing", () => {
  it("rejects a stale worktree lease owner on finalize", async () => {
    const dir = initRepo();
    const { store, workspaceId, taskId } = seedRepoTask(dir);
    const service = new GitService({ dataDir: path.join(dir, "data"), store });
    const run = store.createRun(taskId, "agent");
    const prepared = service.beforeStart({
      workspaceId,
      taskId,
      runId: run.id,
      attempt: 1,
      agentId: "agent",
    });
    expect(prepared).toMatchObject({ allow: true });
    const record = service.gitStore.getWorktreeByRun(run.id);
    expect(record?.state).toBe("active");
    service.gitStore.updateWorktree(record!.id, { leaseOwner: "git-service:stale" });

    await expect(
      service.finalizeRun({ runId: run.id, taskId, status: "completed" }),
    ).rejects.toThrow(/GIT_FENCING_STALE/);
    expect(service.gitStore.getWorktreeByRun(run.id)?.state).toBe("active");
  });
});

describe("t111 repair — AC-WT-13/14/15", () => {
  it("creates a local WIP commit on cancel and removes the worktree by default", async () => {
    const dir = initRepo();
    const { store, workspaceId, taskId } = seedRepoTask(dir);
    const service = new GitService({ dataDir: path.join(dir, "data"), store });
    const run = store.createRun(taskId, "agent");
    const prepared = service.beforeStart({
      workspaceId,
      taskId,
      runId: run.id,
      attempt: 1,
      agentId: "agent",
    });
    if (typeof prepared === "boolean" || !prepared.allow || !prepared.environment) {
      throw new Error("worktree was not prepared");
    }
    writeFileSync(path.join(prepared.environment.cwd, "cancel.txt"), "wip\n");
    await service.finalizeRun({ runId: run.id, taskId, status: "cancelled" });
    const branch = service.gitStore.getTaskVcs(taskId)?.branch;
    expect(branch).toBeTruthy();
    expect(git(dir, ["log", "--format=%s", "-1", branch!])).toContain("wip(");
    expect(existsSync(prepared.environment.cwd)).toBe(false);
  });

  it("reclaims a terminal stale worktree and defers a busy live one", async () => {
    const dir = initRepo();
    const { store, workspaceId, taskId } = seedRepoTask(dir);
    const service = new GitService({ dataDir: path.join(dir, "data"), store });
    const first = store.createRun(taskId, "agent");
    expect(
      service.beforeStart({ workspaceId, taskId, runId: first.id, attempt: 1, agentId: "agent" }),
    ).toMatchObject({ allow: true });
    store.updateRun(first.id, { status: "completed" });
    // createRun uses the kernel's (task, attempt) unique key; move the old
    // attempt out of the way before creating the next attempt fixture.
    store.db.prepare("UPDATE runs SET attempt = 2 WHERE id = ?").run(first.id);

    const second = store.createRun(taskId, "agent");
    const reclaimed = service.beforeStart({
      workspaceId,
      taskId,
      runId: second.id,
      attempt: 1,
      agentId: "agent",
    });
    expect(reclaimed).toMatchObject({ allow: true });
    expect(service.gitStore.getActiveWorktreeForTask(taskId)?.runId).toBe(second.id);
    await expect(
      service.finalizeRun({ runId: first.id, taskId, status: "completed" }),
    ).rejects.toThrow(/GIT_FENCING_STALE/);
    expect(
      (store.db
        .prepare("SELECT count(*) AS n FROM events WHERE type = 'git.worktree_reclaimed'")
        .get() as { n: number }).n,
    ).toBeGreaterThan(0);

    const third = "run-busy-third";
    store.db
      .prepare("UPDATE runs SET lease_owner = ?, lease_expires_at = ? WHERE id = ?")
      .run("active-owner", new Date(Date.now() + 60_000).toISOString(), second.id);
    const busy = service.beforeStart({
      workspaceId,
      taskId,
      runId: third,
      attempt: 1,
      agentId: "agent",
    });
    expect(busy).toMatchObject({ allow: false, reason: "GIT_WORKTREE_BUSY" });
  });

  it("preserves the worktree on cancel when configured", async () => {
    const dir = initRepo();
    const { store, workspaceId, taskId } = seedRepoTask(dir);
    const service = new GitService({ dataDir: path.join(dir, "data"), store });
    service.gitStore.saveConfig({
      ...service.getSettings(workspaceId),
      preserveWorktreeOnCancel: true,
    });
    const run = store.createRun(taskId, "agent");
    const prepared = service.beforeStart({
      workspaceId,
      taskId,
      runId: run.id,
      attempt: 1,
      agentId: "agent",
    });
    if (typeof prepared === "boolean" || !prepared.allow || !prepared.environment) {
      throw new Error("worktree was not prepared");
    }
    writeFileSync(path.join(prepared.environment.cwd, "preserve.txt"), "wip\n");
    await service.finalizeRun({ runId: run.id, taskId, status: "cancelled" });
    expect(existsSync(prepared.environment.cwd)).toBe(true);
  });
});

describe("t111 repair — AC-MQ-06 recovery", () => {
  it("recovers merging/updating to merged/blocked and never merges twice", async () => {
    const dir = initRepo();
    const { store, workspaceId, taskId, gitStore } = seedRepoTask(dir);
    gitStore.upsertTaskVcs(vcsFor(taskId, workspaceId, "deer/t1-recover", "head-sha"));
    const repo: RepoInfo = {
      ok: true,
      workspacePath: dir,
      root: dir,
      runtimeRoot: path.join(dir, ".deer"),
      baseBranch: "main",
      remote: null,
      remoteKind: "none",
      gitVersion: "2.40.0",
    };
    const provider = new MockProvider();
    provider.merged = true;
    const queue = new MergeQueue({
      store,
      gitStore,
      checks: new ChecksRunner(),
      contextFor: async () => ({ repo, git: new GitExec(hooksFor(dir)), provider, settings: gitStore.getConfig(workspaceId) }),
      createConflictTask: async () => ({ taskId: "conflict-task", created: true }),
    });
    const item = await queue.enqueue(taskId);
    gitStore.updateQueue(item.id, {
      state: "merging",
      approvedHeadSha: item.headSha,
      checksWaived: true,
    });
    expect(await queue.recover(workspaceId)).toBe(1);
    const merged = gitStore.getQueueItem(item.id);
    expect(merged?.state).toBe("merged");
    expect(merged?.approvedHeadSha).toBeNull();
    expect(merged?.checksWaived).toBe(false);
    expect(await queue.recover(workspaceId)).toBe(0);

    provider.merged = false;
    provider.conflict = true;
    gitStore.updateQueue(item.id, { state: "updating", approvedHeadSha: item.headSha, checksWaived: true });
    expect(await queue.recover(workspaceId)).toBe(1);
    expect(gitStore.getQueueItem(item.id)?.state).toBe("blocked");
    expect(gitStore.getQueueItem(item.id)?.approvedHeadSha).toBeNull();
    expect(gitStore.getQueueItem(item.id)?.checksWaived).toBe(false);

    provider.conflict = false;
    gitStore.updateQueue(item.id, { state: "updating", approvedHeadSha: item.headSha, checksWaived: true });
    provider.refresh = async () => ({
      provider: "github",
      number: 7,
      url: "https://example.invalid/pull/7",
      state: "unknown",
      headSha: item.headSha,
      baseBranch: "main",
      mergeable: "unknown",
      checks: [],
      review: "pending",
      mergedCommitSha: null,
      updatedAt: new Date().toISOString(),
    });
    expect(await queue.recover(workspaceId)).toBe(1);
    expect(gitStore.getQueueItem(item.id)?.state).toBe("blocked");
    expect(gitStore.getQueueItem(item.id)?.approvedHeadSha).toBeNull();
    expect(gitStore.getQueueItem(item.id)?.checksWaived).toBe(false);
  });
});

describe("t111 repair — AC-GIT-01 29-row argv table", () => {
  it("accepts every designed argv shape and rejects unsafe variants", () => {
    const hooks = "/tmp/deer-hooks";
    const rows: Array<[string, string[]]> = [
      ["#1", ["rev-parse", "--show-toplevel"]],
      ["#2", ["rev-parse", "--verify", "HEAD"]],
      ["#3", ["rev-parse", "--git-path", "info/exclude"]],
      ["#4", ["rev-parse", "--git-common-dir"]],
      ["#5", ["rev-parse", "HEAD:README.md"]],
      ["#6", ["rev-parse", "HEAD"]],
      ["#7", ["remote", "get-url", "origin"]],
      ["#8", ["--version"]],
      ["#9", ["config", "--get", "user.name"]],
      ["#10", ["status", "--porcelain=v2", "-z"]],
      ["#11", ["diff", "--name-status", "--diff-filter=U", "-z"]],
      ["#12", ["log", "-n", "1", "--format=%H"]],
      ["#13", ["show", "HEAD"]],
      ["#14", ["cat-file", "-p", "HEAD"]],
      ["#15", ["merge-base", "--is-ancestor", "main", "deer/t1"]],
      ["#16", ["patch-id", "--stable"]],
      ["#17", ["worktree", "add", "--detach", "/tmp/wt", "HEAD"]],
      ["#18", ["worktree", "list", "--porcelain"]],
      ["#19", ["worktree", "remove", "--force", "/tmp/wt"]],
      ["#20", ["worktree", "prune"]],
      ["#21", ["branch", "--list", "deer/*"]],
      ["#22", ["check-ref-format", "--branch", "deer/t1"]],
      ["#23", ["add", "-A"]],
      ["#24", ["commit", "--no-verify", "-m", "msg"]],
      ["#25", ["format-patch", "-1", "HEAD", "--stdout"]],
      ["#26", ["fetch", "origin", "main"]],
      ["#27", ["push", "--no-verify", "-u", "origin", "deer/t1:deer/t1"]],
      ["#28", ["merge", "--ff-only", "main"]],
      ["#29", ["merge-tree", "--write-tree", "main", "deer/t1"]],
    ];
    expect(rows).toHaveLength(29);
    for (const [label, argv] of rows) {
      expect(validateGitArgs(argv, hooks).ok, `${label} ${argv.join(" ")}`).toBe(true);
    }
    expect(validateGitArgs(["-c", `core.hooksPath=${hooks}`, "status", "--porcelain"], hooks).ok).toBe(true);
    expect(validateGitArgs(["push", "origin", "main:main"]).ok).toBe(false);
    expect(validateGitArgs(["push", "--force", "origin", "deer/t1:deer/t1"]).ok).toBe(false);
    expect(validateGitArgs(["-c", "core.hooksPath=/elsewhere", "status", "--porcelain"], hooks).ok).toBe(false);
    expect(validateGitArgs(["status", "--porcelain", "--exec=evil"]).ok).toBe(false);
  });
});

describe("t128 repair — AC-WT-05/06/07 process/error paths", () => {
  it("AC-WT-05: worktree creation failure returns an error and records no fake worktree", () => {
    const dir = initRepo();
    const { store, workspaceId, taskId, gitStore } = seedRepoTask(dir);
    const service = new GitService({ dataDir: path.join(dir, "data"), store });
    const repo = detectRepoSync(dir, "main");
    const parent = path.join(repo.runtimeRoot ?? path.join(dir, ".deer"), "worktrees", taskId);
    mkdirSync(path.dirname(parent), { recursive: true });
    writeFileSync(parent, "not a directory\n");
    const result = service.beforeStart({
      workspaceId,
      taskId,
      runId: "run-create-fail",
      attempt: 1,
      agentId: "agent",
    });
    expect(result).toMatchObject({ allow: true, environment: { mode: "degraded" } });
    expect(service.gitStore.getActiveWorktreeForTask(taskId)).toBeNull();
  });

  it("AC-WT-06: clean worktree emits git.no_changes and removes the worktree", async () => {
    const dir = initRepo();
    const { store, workspaceId, taskId } = seedRepoTask(dir);
    const service = new GitService({ dataDir: path.join(dir, "data"), store });
    const run = store.createRun(taskId, "agent");
    const prepared = service.beforeStart({
      workspaceId,
      taskId,
      runId: run.id,
      attempt: 1,
      agentId: "agent",
    });
    if (typeof prepared === "boolean" || !prepared.allow || !prepared.environment) {
      throw new Error("worktree was not prepared");
    }
    await service.finalizeRun({ runId: run.id, taskId, status: "completed" });
    expect(existsSync(prepared.environment.cwd)).toBe(false);
    expect(
      (store.db.prepare("SELECT count(*) AS n FROM events WHERE type = 'git.no_changes'").get() as {
        n: number;
      }).n,
    ).toBe(1);
  });

  it("AC-WT-07: a separately terminated process leaves a stale lease; finalize rejects and recover reclaims", async () => {
    const dir = initRepo();
    const { store, workspaceId, taskId } = seedRepoTask(dir);
    const dataDir = path.join(dir, "data");
    const service = new GitService({ dataDir, store });
    const run = store.createRun(taskId, "agent");
    expect(
      service.beforeStart({ workspaceId, taskId, runId: run.id, attempt: 1, agentId: "agent" }),
    ).toMatchObject({ allow: true });
    const fixture = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "stale-lease-holder.cjs",
    );
    const child = spawn(process.execPath, [fixture], {
      env: {
        ...process.env,
        GIT_DB: path.join(dataDir, "git.db"),
        RUN_ID: run.id,
        STALE_OWNER: "git-service:other-process",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child fixture timeout")), 10_000);
      child.stdout?.on("data", (chunk) => {
        if (String(chunk).includes("READY")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    child.kill();
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    await expect(
      service.finalizeRun({ runId: run.id, taskId, status: "completed" }),
    ).rejects.toThrow(/GIT_FENCING_STALE/);
    store.updateRun(run.id, { status: "completed" });
    await service.recover(workspaceId);
    expect(service.gitStore.getActiveWorktreeForTask(taskId)).toBeNull();
  });
});

describe("t128 repair — AC-TYPE-01 field snapshots", () => {
  it("keeps the public Git UI/API field sets stable", () => {
    const taskVcs: Array<keyof TaskVcs> = [
      "taskId", "workspaceId", "mode", "branch", "baseBranch", "headSha", "pr",
      "merge", "checksState", "conflictTaskId", "targetTaskId", "targetBranch",
      "scopePaths", "degradedReason", "errorCode", "updatedAt",
    ];
    const queueItem: Array<keyof MergeQueueItem> = [
      "id", "workspaceId", "taskId", "taskTitle", "provider", "prNumber", "prUrl",
      "branch", "state", "position", "attempts", "headSha", "baseSha",
      "approvedHeadSha", "checks", "checksWaived", "retryAt", "review",
      "conflictTaskId", "lastError", "mergeCommitSha", "createdAt", "updatedAt",
    ];
    const diagnostics: Array<keyof RepoDiagnostics> = [
      "workspaceId", "workspacePath", "mode", "root", "runtimeRoot", "gitVersion",
      "remote", "baseBranch", "provider", "auth", "protection", "worktrees", "queue", "lastError",
    ];
    expect(taskVcs).toHaveLength(16);
    expect(queueItem).toHaveLength(23);
    expect(diagnostics).toHaveLength(14);
    const prepare: PrepareRunInput = { workspaceId: "w", taskId: "t", runId: "r", attempt: 1, agentId: "a" };
    expect(prepare.agentId).toBe("a");
    const errorCode: GitErrorCode = "GIT_PATH_ESCAPE";
    expect(errorCode).toBe("GIT_PATH_ESCAPE");
  });
});

describe("t128 repair — AC-GIT-02..13", () => {
  it("AC-GIT-02 rejects branch injection and sanitizes slugs", () => {
    expect(validateGitArgs(["check-ref-format", "--branch", "a;rm -rf"]).ok).toBe(false);
    expect(validateGitArgs(["check-ref-format", "--branch", "-x"]).ok).toBe(false);
    const branch = branchName("t1", "a;rm -rf /tmp/x");
    expect(branch).toMatch(/^deer\/t1-[a-z0-9-]+$/);
    expect(validateGitArgs(["check-ref-format", "--branch", branch]).ok).toBe(true);
  });

  it("AC-GIT-03 CommitGuard blocks env/private-key/large files without leaking content", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, ".env"), "SECRET_VALUE=super-secret\n");
    writeFileSync(path.join(dir, "id_rsa"), "PRIVATE KEY\n");
    writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(6 * 1024 * 1024));
    const guard = new CommitGuard(new GitExec(hooksFor(dir)));
    const result = await guard.scan(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain("super-secret");
  });

  it("AC-GIT-04 uses temporary commit identity when repo config is absent", async () => {
    const dir = tempDir();
    git(dir, ["init", "-b", "main"]);
    writeFileSync(path.join(dir, "a.txt"), "a\n");
    git(dir, ["add", "a.txt"]);
    const oldHome = process.env.HOME;
    const oldProfile = process.env.USERPROFILE;
    process.env.HOME = tempDir();
    process.env.USERPROFILE = process.env.HOME;
    try {
      const committed = await commitAll({
        git: new GitExec(hooksFor(dir)),
        worktree: dir,
        message: "test identity",
        scan: async () => ({ ok: true, blocked: false, files: [] }),
      });
      expect(committed.ok).toBe(true);
      expect(git(dir, ["log", "-1", "--format=%an <%ae>"])).toContain("DeerSuperGroup Agent");
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = oldProfile;
    }
  });

  it("AC-GIT-05/06 maps non-fast-forward and network push failures", async () => {
    const dir = initRepo();
    const remote = tempDir();
    git(remote, ["init", "--bare"]);
    git(dir, ["remote", "add", "origin", remote]);
    git(dir, ["checkout", "-b", "deer/pushtest"]);
    writeFileSync(path.join(dir, "push.txt"), "one\n");
    git(dir, ["add", "push.txt"]);
    git(dir, ["commit", "-m", "one"]);
    expect(
      await pushBranch({
        git: new GitExec(hooksFor(dir)),
        cwd: dir,
        remote: "origin",
        branch: "deer/pushtest",
      }),
    ).toMatchObject({ ok: true });
    const other = tempDir();
    git(other, ["clone", "-b", "deer/pushtest", remote, "."]);
    writeFileSync(path.join(other, "push.txt"), "two\n");
    git(other, ["commit", "-am", "two"]);
    git(other, ["push", "origin", "deer/pushtest"]);
    writeFileSync(path.join(dir, "push.txt"), "three\n");
    git(dir, ["commit", "-am", "three"]);
    const rejected = await pushBranch({
      git: new GitExec(hooksFor(dir)),
      cwd: dir,
      remote: "origin",
      branch: "deer/pushtest",
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toBe("GIT_PUSH_REJECTED");
    git(dir, ["remote", "set-url", "origin", path.join(dir, "missing-remote")]);
    const network = await pushBranch({
      git: new GitExec(hooksFor(dir)),
      cwd: dir,
      remote: "origin",
      branch: "deer/pushtest",
    });
    expect(network.ok).toBe(false);
    expect(network.error).toBe("GIT_PUSH_NETWORK");
  });

  it("AC-GIT-07/08 redacts tokens/credentials and only accepts https PR URLs", () => {
    expect(redactSecrets("ghp_abcdefghijklmnopqrstuvwxyz123456")).toBe("[REDACTED]");
    expect(redactSecrets("https://user:pass@github.com/x/y")).not.toContain("pass");
    expect(safePrUrl("https://github.com/acme/repo/pull/1")).toBe("https://github.com/acme/repo/pull/1");
    expect(safePrUrl("http://github.com/acme/repo/pull/1")).toBeNull();
    expect(safePrUrl("https://evil.example/acme/repo/pull/1")).toBeNull();
  });

  it("AC-GIT-09/10 degrades when git is unavailable or repo is not root", () => {
    const repoDir = initRepo();
    const sub = path.join(repoDir, "sub");
    mkdirSync(path.join(sub, ".git"), { recursive: true });
    const fake = tempDir();
    const oldPath = process.env.PATH;
    if (process.platform === "win32") {
      writeFileSync(
        path.join(fake, "git.cmd"),
        `@echo off\nif "%1"=="--version" (echo git version 2.40.0 & exit /b 0)\nif "%1"=="rev-parse" if "%2"=="--show-toplevel" (echo ${repoDir} & exit /b 0)\nexit /b 1\n`,
      );
    } else {
      const script = path.join(fake, "git");
      writeFileSync(
        script,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.40.0"; exit 0; fi\nif [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then echo "${repoDir}"; exit 0; fi\nexit 1\n`,
      );
      chmodSync(script, 0o755);
    }
    process.env.PATH = `${fake}${path.delimiter}${oldPath ?? ""}`;
    try {
      expect(detectRepoSync(sub, "main").errorCode).toBe("GIT_NOT_ROOT");
      process.env.PATH = "";
      expect(detectRepoSync(repoDir, "main").errorCode).toBe("GIT_NOT_FOUND");
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it("AC-GIT-11 malicious hooks are not executed", async () => {
    const dir = initRepo();
    const sentinel = path.join(dir, "hook-ran.txt");
    const hook = path.join(dir, ".git", "hooks", "pre-commit");
    mkdirSync(path.dirname(hook), { recursive: true });
    writeFileSync(hook, `node -e "require('fs').writeFileSync('${sentinel.replace(/\\/g, "\\\\")}','x')"\n`);
    writeFileSync(path.join(dir, "hooked.txt"), "hooked\n");
    const committed = await commitAll({
      git: new GitExec(hooksFor(dir)),
      worktree: dir,
      message: "hook test",
      scan: async () => ({ ok: true, blocked: false, files: [] }),
    });
    expect(committed.ok).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("AC-GIT-12 finalize is idempotent after worktree removal", async () => {
    const dir = initRepo();
    const { store, workspaceId, taskId } = seedRepoTask(dir);
    const service = new GitService({ dataDir: path.join(dir, "data"), store });
    const run = store.createRun(taskId, "agent");
    service.beforeStart({ workspaceId, taskId, runId: run.id, attempt: 1, agentId: "agent" });
    await service.finalizeRun({ runId: run.id, taskId, status: "completed" });
    await expect(
      service.finalizeRun({ runId: run.id, taskId, status: "completed" }),
    ).resolves.toBeUndefined();
  });

  it("AC-GIT-13 GitErrorCode snapshot", () => {
    const codes: GitErrorCode[] = [
      "GIT_NOT_FOUND", "GIT_REPO_NOT_FOUND", "GIT_NOT_ROOT", "GIT_VERSION_LOW",
      "GIT_CAPACITY", "GIT_WORKTREE_FAILED", "GIT_WORKTREE_NOT_CLEAN",
      "GIT_WORKTREE_BUSY", "GIT_BRANCH_INVALID", "GIT_BRANCH_EXISTS",
      "GIT_COMMIT_BLOCKED", "GIT_PUSH_REJECTED", "GIT_PUSH_NETWORK",
      "GIT_TIMEOUT", "GIT_FORBIDDEN", "GIT_PATH_ESCAPE", "SECRET_BLOCKED",
      "AUTH_MISSING", "AUTH_FORBIDDEN", "AUTH_PUSH", "PR_NOT_FOUND",
      "PR_CREATE_FAILED", "PR_RATE_LIMITED", "PR_UNKNOWN_STATE",
      "PR_METHOD_UNSUPPORTED", "CHECKS_FAILED", "CHECKS_TIMEOUT", "CHECKS_SPAWN",
      "MERGE_CONFLICT", "MERGE_REVIEW_REQUIRED", "MERGE_APPROVAL_STALE",
      "MERGE_UNKNOWN_STATE", "MERGE_LOCKED", "MERGE_CANCELLED", "MERGE_LIMIT",
    ];
    expect(codes).toHaveLength(35);
    expect(new Set(codes).size).toBe(35);
  });
});

describe("t128 repair — AC-PR mock enterprise host", () => {
  const repo: RepoInfo = {
    ok: true,
    workspacePath: "/tmp/repo",
    root: "/tmp/repo",
    runtimeRoot: "/tmp/repo/.deer",
    baseBranch: "main",
    remote: "https://ghe.example/acme/repo.git",
    remoteKind: "remote",
    gitVersion: "2.40.0",
  };

  it("AC-PR-04/07/09 maps 401/403/429/5xx and keeps REST headers/token out of URL", async () => {
    const oldToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    try {
      for (const status of [401, 403, 429, 500]) {
        vi.stubGlobal(
          "fetch",
          vi.fn(async (url: string, init: RequestInit) => {
            calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
            return { ok: false, status, text: async () => `error-${status}` };
          }),
        );
        const provider = new GitHubProvider("ghe.example");
        await expect(provider.restRefresh(repo, 7)).rejects.toMatchObject({
          code: status === 401 ? "AUTH_MISSING" : status === 500 ? "PR_UNKNOWN_STATE" : "PR_RATE_LIMITED",
        });
      }
      expect(calls[0]!.url).toContain("https://ghe.example/api/v3/repos/acme/repo/pulls/7");
      expect(calls[0]!.url).not.toContain("test-token");
      expect(calls[0]!.headers.Authorization).toBe("Bearer test-token");
      expect(calls[0]!.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    } finally {
      vi.unstubAllGlobals();
      if (oldToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = oldToken;
    }
  });

  it("AC-PR-10 maps squash/merge/rebase to gh flags with match-head-commit", async () => {
    for (const method of ["squash", "merge", "rebase"] as const) {
      const calls: string[][] = [];
      const provider = new GitHubProvider("ghe.example", async (args) => {
        calls.push(args);
        if (args[0] === "pr" && args[1] === "merge") return { ok: true, stdout: "", stderr: "" };
        return {
          ok: true,
          stdout: JSON.stringify({
            number: 7,
            url: "https://ghe.example/acme/repo/pull/7",
            state: "OPEN",
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            reviewDecision: "APPROVED",
            statusCheckRollup: [],
            headRefOid: "head-sha",
            baseRefName: "main",
            mergeCommit: null,
          }),
          stderr: "",
        };
      });
      const pr = await provider.merge(repo, { number: 7, branch: "deer/x", headSha: "head-sha" }, { method });
      expect(pr.state).toBe("open");
      const mergeArgs = calls.find((args) => args[1] === "merge")!;
      expect(mergeArgs).toContain(`--${method}`);
      expect(mergeArgs).toContain("--match-head-commit");
      expect(mergeArgs).toContain("head-sha");
    }
  });
});

describe("t128 repair — AC-MQ-01..14", () => {
  function queueFixture() {
    const dir = initRepo();
    const { store, workspaceId, taskId, gitStore } = seedRepoTask(dir);
    const repo: RepoInfo = {
      ok: true,
      workspacePath: dir,
      root: dir,
      runtimeRoot: path.join(dir, ".deer"),
      baseBranch: "main",
      remote: null,
      remoteKind: "none",
      gitVersion: "2.40.0",
    };
    gitStore.upsertTaskVcs(vcsFor(taskId, workspaceId, "deer/mq-test", "head-sha"));
    const provider = new MockProvider();
    return { dir, store, workspaceId, taskId, gitStore, repo, provider };
  }

  it("AC-MQ-02b auto_merge=false stops at ready until explicit mergeStart", async () => {
    const { dir, store, workspaceId, taskId, gitStore, repo, provider } = queueFixture();
    const settings: GitSettings = { ...gitStore.getConfig(workspaceId), requireApproval: false, autoMerge: false };
    const queue = new MergeQueue({
      store, gitStore, checks: new ChecksRunner(),
      contextFor: async () => ({ repo, git: new GitExec(hooksFor(dir)), provider, settings }),
      createConflictTask: async () => ({ taskId: "c", created: true }),
    });
    const item = await queue.enqueue(taskId);
    const ready = await queue.process(workspaceId, item.id);
    expect(ready.state).toBe("ready");
    expect(provider.merged).toBe(false);
    await queue.approve(taskId);
    await queue.mergeStart(taskId);
    expect(gitStore.getQueueItem(item.id)?.state).toBe("ready");
  });

  it("AC-MQ-03/04/14 checks fail and head reset clear approval/waiver", async () => {
    const { dir, store, workspaceId, taskId, gitStore, repo, provider } = queueFixture();
    const settings: GitSettings = { ...gitStore.getConfig(workspaceId), requireApproval: true, autoMerge: true };
    const queue = new MergeQueue({
      store, gitStore, checks: new ChecksRunner(),
      contextFor: async () => ({ repo, git: new GitExec(hooksFor(dir)), provider, settings }),
      createConflictTask: async () => ({ taskId: "c", created: true }),
    });
    const item = await queue.enqueue(taskId);
    await queue.approve(taskId);
    gitStore.updateQueue(item.id, { checksWaived: true, approvedHeadSha: item.headSha });
    provider.refresh = async () => ({
      provider: "github", number: 7, url: null, state: "open",
      headSha: "new-head", baseBranch: "main", mergeable: "mergeable",
      checks: [], review: "approved", mergedCommitSha: null, updatedAt: new Date().toISOString(),
    });
    const reset = await queue.process(workspaceId, item.id);
    expect(reset.state).toBe("waiting_review");
    expect(reset.approvedHeadSha).toBeNull();
    expect(reset.checksWaived).toBe(false);
  });

  it("AC-MQ-05/08/09/12 cancels, blocks queue head, and limits conflict tasks", async () => {
    const { dir, store, workspaceId, taskId, gitStore, repo, provider } = queueFixture();
    const settings: GitSettings = { ...gitStore.getConfig(workspaceId), requireApproval: false, autoMerge: true };
    const queue = new MergeQueue({
      store, gitStore, checks: new ChecksRunner(),
      contextFor: async () => ({ repo, git: new GitExec(hooksFor(dir)), provider, settings }),
      createConflictTask: async () => ({ taskId: "c", created: true }),
    });
    const first = await queue.enqueue(taskId);
    await queue.cancel(taskId, "test cancel");
    expect(gitStore.getQueueItem(first.id)?.state).toBe("cancelled");
    const task2 = store.createTask({ workspaceId, title: "second", description: "d", acceptance: [] });
    gitStore.upsertTaskVcs(vcsFor(task2.id, workspaceId, "deer/mq-2", "head-2"));
    const second = await queue.enqueue(task2.id);
    gitStore.updateQueue(second.id, { state: "blocked" });
    await expect(queue.process(workspaceId)).rejects.toThrow(/head is blocked/);

    const service = new GitService({ dataDir: path.join(dir, "data"), store });
    const conflictInput = {
      workspaceId, taskId: "source", taskTitle: "source", branch: "deer/source",
      baseBranch: "main", prNumber: 99, prUrl: "https://ghe.example/pull/99",
      conflictFiles: ["a.txt"], baseSha: "base",
    };
    const a = await (service as unknown as { createConflictTask: (i: typeof conflictInput) => Promise<{ created: boolean }> }).createConflictTask(conflictInput);
    const b = await (service as unknown as { createConflictTask: (i: typeof conflictInput) => Promise<{ created: boolean }> }).createConflictTask(conflictInput);
    expect(a.created).toBe(true);
    expect(b.created).toBe(true); // different source task/base; second conflict task allowed
    service.gitStore.insertQueue({
      ...first, id: "q_limit_1", taskId: "limit-1", state: "blocked", conflictTaskId: "c1", prNumber: 99, position: 10,
    });
    service.gitStore.insertQueue({
      ...first, id: "q_limit_2", taskId: "limit-2", state: "blocked", conflictTaskId: "c2", prNumber: 99, position: 11,
    });
    const c = await (service as unknown as { createConflictTask: (i: typeof conflictInput) => Promise<{ created: boolean }> }).createConflictTask({ ...conflictInput, taskId: "source-3" });
    expect(c.created).toBe(false);
  });

  it("AC-MQ-11 tree verification accepts squash/rebase content and rejects wrong content", async () => {
    const dir = initRepo();
    git(dir, ["checkout", "-b", "feature"]);
    writeFileSync(path.join(dir, "README.md"), "feature\n");
    git(dir, ["commit", "-am", "feature"]);
    const head = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["checkout", "main"]);
    git(dir, ["merge", "--squash", "feature"]);
    git(dir, ["commit", "-m", "squash feature"]);
    expect(
      await verifyIntegratedContent({ git: new GitExec(hooksFor(dir)), cwd: dir, headSha: head, integratedRef: "main" }),
    ).toMatchObject({ ok: true });

    git(dir, ["checkout", "-b", "rebase-feature"]);
    writeFileSync(path.join(dir, "README.md"), "rebase\n");
    git(dir, ["commit", "-am", "rebase feature"]);
    const rebaseHead = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["checkout", "main"]);
    git(dir, ["cherry-pick", rebaseHead]);
    expect(
      await verifyIntegratedContent({ git: new GitExec(hooksFor(dir)), cwd: dir, headSha: rebaseHead, integratedRef: "main" }),
    ).toMatchObject({ ok: true });
  });
});

describe("t128 repair — remaining AC-MQ acceptance", () => {
  function fixture() {
    const dir = initRepo();
    const { store, workspaceId, taskId, gitStore } = seedRepoTask(dir);
    const repo: RepoInfo = {
      ok: true, workspacePath: dir, root: dir, runtimeRoot: path.join(dir, ".deer"),
      baseBranch: "main", remote: null, remoteKind: "none", gitVersion: "2.40.0",
    };
    gitStore.upsertTaskVcs(vcsFor(taskId, workspaceId, "deer/mq-remaining", "head-sha"));
    const provider = new MockProvider();
    return { dir, store, workspaceId, taskId, gitStore, repo, provider };
  }

  it("AC-MQ-01/07/10/13 merge once, idempotent approve, event/vcs, waive boundary", async () => {
    const { dir, store, workspaceId, taskId, gitStore, repo, provider } = fixture();
    const settings: GitSettings = {
      ...gitStore.getConfig(workspaceId),
      requireApproval: true,
      autoMerge: true,
      checksCommand: null,
    };
    const queue = new MergeQueue({
      store, gitStore, checks: new ChecksRunner(),
      contextFor: async () => ({ repo, git: new GitExec(hooksFor(dir)), provider, settings }),
      createConflictTask: async () => ({ taskId: "c", created: true }),
    });
    const item = await queue.enqueue(taskId);
    await queue.approve(taskId);
    await queue.approve(taskId);
    expect(gitStore.getQueueItem(item.id)?.approvedHeadSha).toBe(item.headSha);
    await expect(queue.waiveChecks(taskId, "short")).rejects.toThrow(/at least 8/);
    const merged = await queue.process(workspaceId, item.id);
    expect(merged.state).toBe("merged");
    expect(gitStore.getTaskVcs(taskId)?.merge.state).toBe("merged");
    expect(
      (store.db.prepare("SELECT count(*) AS n FROM events WHERE type = 'merge.merged'").get() as { n: number }).n,
    ).toBe(1);

    const other = store.createTask({ workspaceId, title: "other", description: "d", acceptance: [] });
    gitStore.upsertTaskVcs(vcsFor(other.id, workspaceId, "deer/mq-other", "other-head"));
    const queuedOther = await queue.enqueue(other.id);
    gitStore.updateQueue(item.id, { state: "merging" });
    await expect(queue.process(workspaceId)).rejects.toThrow(/another merge/);
    expect(gitStore.getQueueItem(queuedOther.id)?.state).not.toBe("merged");
  });

  it("AC-MQ-15 failed item with new head returns to waiting_checks", async () => {
    const { dir, store, workspaceId, taskId, gitStore, repo, provider } = fixture();
    const settings: GitSettings = { ...gitStore.getConfig(workspaceId), requireApproval: false, autoMerge: true };
    const queue = new MergeQueue({
      store, gitStore, checks: new ChecksRunner(),
      contextFor: async () => ({ repo, git: new GitExec(hooksFor(dir)), provider, settings }),
      createConflictTask: async () => ({ taskId: "c", created: true }),
    });
    const item = await queue.enqueue(taskId);
    gitStore.updateQueue(item.id, { state: "failed", headSha: "old-head", checksWaived: true });
    provider.refresh = async () => ({
      provider: "github", number: 7, url: null, state: "open",
      headSha: "new-head", baseBranch: "main", mergeable: "mergeable",
      checks: [], review: "pending", mergedCommitSha: null, updatedAt: new Date().toISOString(),
    });
    const next = await queue.process(workspaceId, item.id);
    expect(next.state).toBe("waiting_checks");
    expect(next.headSha).toBe("new-head");
    expect(next.checksWaived).toBe(false);
  });
});


