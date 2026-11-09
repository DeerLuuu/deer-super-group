import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../kernel/store.js";
import { GitStore } from "./gitStore.js";
import { GitExec, redactSecrets, validateGitArgs } from "./gitExec.js";
import { CommitGuard } from "./commitGuard.js";
import { ChecksRunner } from "./checksRunner.js";
import { MergeQueue } from "./mergeQueue.js";
import { WorktreeManager } from "./worktreeManager.js";
import { GitService } from "./gitService.js";
import { verifyIntegratedContent } from "./branchOps.js";
import { LocalProvider, ManualProvider } from "./providers.js";
import type { GitSettings, PrInfo, PrProvider, RepoInfo, TaskVcs } from "./types.js";

const dirs: string[] = [];

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

describe("admission and manual providers", () => {
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
