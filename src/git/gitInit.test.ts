import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeGitRepo, probeGitInit } from "./gitInit.js";
import { detectRepo } from "./repo.js";
import { GitExec } from "./gitExec.js";
import { GitReadService } from "./readService.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "deer-init-"));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function initRepo(cwd: string): void {
  git(cwd, ["init", "--initial-branch=main"]);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold a git handle; best effort cleanup.
    }
  }
});

describe("t348 git init probe", () => {
  it("marks a plain directory ready without writing anything", async () => {
    const root = tempRoot();
    writeFileSync(path.join(root, "keep.txt"), "unchanged", "utf8");
    const probe = await probeGitInit(root, "ws");
    expect(probe.status).toBe("ready");
    expect(probe.canInitialize).toBe(true);
    expect(probe.root).toBeTruthy();
    expect(probe.gitVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(existsSync(path.join(root, ".git"))).toBe(false);
    expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
    expect(statSync(path.join(root, "keep.txt")).size).toBe("unchanged".length);
  });

  it("returns already-repo for an existing repository", async () => {
    const root = tempRoot();
    initRepo(root);
    const probe = await probeGitInit(root);
    expect(probe.status).toBe("already-repo");
    expect(probe.canInitialize).toBe(false);
  });

  it("rejects a directory nested inside an existing repository", async () => {
    const parent = tempRoot();
    initRepo(parent);
    const child = path.join(parent, "nested");
    mkdirSync(child);
    const probe = await probeGitInit(child);
    expect(probe.status).toBe("nested-repo");
    expect(probe.reason).toBeTruthy();
  });

  it("rejects a workspace containing a direct child repository", async () => {
    const root = tempRoot();
    const child = path.join(root, "child");
    mkdirSync(child);
    initRepo(child);
    const probe = await probeGitInit(root);
    expect(probe.status).toBe("nested-repo");
    expect(probe.reason).toContain("child");
  });

  it("reports missing/non-directory paths", async () => {
    expect((await probeGitInit(path.join(tempRoot(), "missing"))).status).toBe("not-found");
    const file = path.join(tempRoot(), "file.txt");
    writeFileSync(file, "x");
    expect((await probeGitInit(file)).status).toBe("not-directory");
  });

  it("rejects a broken .git entry without touching it", async () => {
    const root = tempRoot();
    writeFileSync(path.join(root, ".git"), "not a gitdir", "utf8");
    const probe = await probeGitInit(root);
    expect(probe.status).toBe("invalid-repo");
    const result = await initializeGitRepo(root);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("GIT_INIT_UNSUPPORTED");
    expect(existsSync(path.join(root, ".git"))).toBe(true);
  });
});

describe("t348 git init write", () => {
  it("creates main with no commits, no add/commit, no .gitignore", async () => {
    const root = tempRoot();
    writeFileSync(path.join(root, "app.ts"), "export const x = 1;\n", "utf8");
    const result = await initializeGitRepo(root);
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ root, branch: "main", headSha: null, initialized: true });
    expect(existsSync(path.join(root, ".git"))).toBe(true);
    expect(git(root, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
    expect(git(root, ["status", "--porcelain"])).toContain("app.ts");
    expect(git(root, ["ls-files"])).toBe("");
    expect(() => git(root, ["rev-parse", "HEAD"])).toThrow();
    expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
    expect((await probeGitInit(root)).status).toBe("already-repo");
    void result.value?.auditEventId;

    const repo = await detectRepo(root);
    expect(repo.ok).toBe(true);
    const hooks = mkdtempSync(path.join(tmpdir(), "deer-hooks-"));
    roots.push(hooks);
    const reader = new GitReadService(repo as never, new GitExec(hooks));
    const repoInfo = await reader.repoInfo();
    expect(repoInfo.ok).toBe(true);
    expect(repoInfo.value?.headSha).toBeNull();
    expect(repoInfo.value?.branch).toBe("main");
    const graph = await reader.graph({ limit: 50, offset: 0 });
    expect(graph.ok).toBe(true);
    expect(graph.value?.commits).toEqual([]);
    expect(graph.value?.hasMore).toBe(false);
  });

  it("never overwrites an existing repository", async () => {
    const root = tempRoot();
    initRepo(root);
    writeFileSync(path.join(root, "tracked.txt"), "keep", "utf8");
    const result = await initializeGitRepo(root);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("GIT_INIT_ALREADY_REPO");
    expect(git(root, ["status", "--porcelain"])).toContain("tracked.txt");
  });

  it("refuses nested repositories and leaves them untouched", async () => {
    const parent = tempRoot();
    initRepo(parent);
    const child = path.join(parent, "child");
    mkdirSync(child);
    const result = await initializeGitRepo(child);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("GIT_INIT_NESTED_REPO");
    expect(existsSync(path.join(child, ".git"))).toBe(false);
  });
});
