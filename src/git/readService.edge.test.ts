import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitExec } from "./gitExec.js";
import { detectRepo, ensureHooksDir, runtimeHooksPath } from "./repo.js";
import { GitReadService } from "./readService.js";
import { gitGraphParamsSchema } from "./readTypes.js";
import { GitService } from "./gitService.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may keep a short handle.
    }
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "read@example.com"]);
  git(dir, ["config", "user.name", "Read"]);
  return dir;
}

async function readerFor(dir: string): Promise<GitReadService> {
  const repo = await detectRepo(dir);
  expect(repo.ok).toBe(true);
  ensureHooksDir(repo);
  return new GitReadService(repo as never, new GitExec(runtimeHooksPath(repo)!));
}

describe("GitReadService boundaries and degradation", () => {
  it("rejects bad sha/path/ref and offset+limit overflow", async () => {
    const dir = initRepo("git-edge-");
    writeFileSync(path.join(dir, "a.txt"), "a\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-m", "one"]);
    const reader = await readerFor(dir);

    expect((await reader.commit("not-a-sha")).errorCode).toBe("GIT_READ_BAD_PARAM");
    expect((await reader.diff({ scope: "working", path: "../escape" })).errorCode).toBe("GIT_READ_BAD_PATH");
    expect((await reader.graph({ limit: 200, offset: 1900 })).errorCode).toBe("GIT_READ_BAD_PARAM");
    expect((await reader.graph({ limit: 10, offset: 0, ref: "bad ref" })).errorCode).toBe("GIT_READ_BAD_REF");
  });

  it("returns NO_COMMITS for an empty repository", async () => {
    const dir = initRepo("git-empty-");
    const reader = await readerFor(dir);
    expect((await reader.repoInfo()).errorCode).toBe("GIT_READ_NO_COMMITS");
    expect((await reader.graph({ limit: 10, offset: 0 })).errorCode).toBe("GIT_READ_NO_COMMITS");
  });

  it("includes detached HEAD in the graph", async () => {
    const dir = initRepo("git-detached-");
    writeFileSync(path.join(dir, "a.txt"), "a\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-m", "detached target"]);
    git(dir, ["checkout", "--detach"]);
    const reader = await readerFor(dir);
    const info = await reader.repoInfo();
    expect(info.ok).toBe(true);
    if (!info.ok) return;
    const infoValue = info.value!;
    expect(infoValue.detached).toBe(true);
    expect(infoValue.branch).toBeNull();
    const graph = await reader.graph({ limit: 10, offset: 0 });
    expect(graph.ok).toBe(true);
    if (graph.ok) expect(graph.value!.commits.some((commit) => commit.sha === infoValue.headSha)).toBe(true);
  });

  it("parses rename entries instead of dropping them", async () => {
    const dir = initRepo("git-rename-");
    writeFileSync(path.join(dir, "old.txt"), "rename me\n");
    git(dir, ["add", "old.txt"]);
    git(dir, ["commit", "-m", "add old"]);
    git(dir, ["mv", "old.txt", "new.txt"]);
    const reader = await readerFor(dir);
    const status = await reader.status();
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    const statusValue = status.value!;
    const renamed = statusValue.staged.find((file) => file.path === "new.txt");
    expect(renamed).toBeTruthy();
    expect(renamed?.oldPath).toBe("old.txt");
  });

  it("shows a real diff for an untracked text file and marks binary", async () => {
    const dir = initRepo("git-untracked-");
    writeFileSync(path.join(dir, "untracked.txt"), "hello untracked\n");
    writeFileSync(path.join(dir, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    const reader = await readerFor(dir);

    const text = await reader.diff({ scope: "working", path: "untracked.txt", context: 3 });
    expect(text.ok).toBe(true);
    if (text.ok) {
      expect(text.value!.truncated).toBe(false);
      expect(text.value!.files).toHaveLength(1);
      expect(text.value!.files[0].path).toBe("untracked.txt");
      expect(text.value!.files[0].hunks.flatMap((hunk) => hunk.lines).some((line) => line.text === "hello untracked")).toBe(true);
    }

    const binary = await reader.diff({ scope: "working", path: "binary.dat", context: 3 });
    expect(binary.ok).toBe(true);
    if (binary.ok) expect(binary.value!.binary).toBe(true);
  }, 20_000);

  it("reports a submodule instead of an empty list", async () => {
    const child = initRepo("git-sub-child-");
    writeFileSync(path.join(child, "child.txt"), "child\n");
    git(child, ["add", "child.txt"]);
    git(child, ["commit", "-m", "child"]);
    const dir = initRepo("git-sub-");
    git(dir, ["-c", "protocol.file.allow=always", "submodule", "add", child, "sub"]);
    git(dir, ["commit", "-m", "add submodule"]);
    const reader = await readerFor(dir);
    const status = await reader.status();
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    const statusValue = status.value!;
    expect(statusValue.submodules.some((file) => file.path === "sub")).toBe(true);
    expect(statusValue.submodulesUnsupported).toBe(false);
  }, 20_000);

  it("maps maxBuffer diff failures to GIT_READ_TOO_LARGE", async () => {
    const dir = initRepo("git-large-");
    const big = Buffer.alloc(9 * 1024 * 1024, "a");
    writeFileSync(path.join(dir, "big.bin"), big);
    git(dir, ["add", "big.bin"]);
    git(dir, ["commit", "-m", "big"]);
    writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(9 * 1024 * 1024, "b"));
    const reader = await readerFor(dir);
    const result = await reader.diff({ scope: "working", path: "big.bin", maxBytes: 1_048_576 });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("GIT_READ_TOO_LARGE");
  }, 30_000);

  it("enforces 500/2000 graph bounds exactly", async () => {
    const dir = initRepo("git-bounds-");
    writeFileSync(path.join(dir, "a.txt"), "a\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-m", "one"]);
    const reader = await readerFor(dir);

    expect(gitGraphParamsSchema.safeParse({ limit: 500, offset: 1500 }).success).toBe(true);
    expect(gitGraphParamsSchema.safeParse({ limit: 501, offset: 0 }).success).toBe(false);
    expect(gitGraphParamsSchema.safeParse({ limit: 1, offset: 2001 }).success).toBe(false);
    expect((await reader.graph({ limit: 500, offset: 1500 })).ok).toBe(true);
    expect((await reader.graph({ limit: 1, offset: 1999 })).ok).toBe(true);
    expect((await reader.graph({ limit: 1, offset: 2000 })).errorCode).toBe("GIT_READ_BAD_PARAM");
  });

  it("truncates a 1MB diff instead of failing", async () => {
    const dir = initRepo("git-truncate-");
    writeFileSync(path.join(dir, "large.txt"), "a".repeat(2 * 1024 * 1024));
    git(dir, ["add", "large.txt"]);
    git(dir, ["commit", "-m", "large"]);
    writeFileSync(path.join(dir, "large.txt"), "b".repeat(2 * 1024 * 1024));
    const reader = await readerFor(dir);
    const result = await reader.diff({ scope: "working", path: "large.txt", maxBytes: 1_048_576 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value!.truncated).toBe(true);
    expect(result.value!.bytes).toBeGreaterThan(1_048_576);
    expect(result.value!.reason).toBe("max-bytes");
  }, 30_000);

  it("maps timeout stderr to GIT_READ_TIMEOUT", async () => {
    const fake = {
      run: async () => ({ code: 1, stdout: "", stderr: "git timed out" }),
    } as unknown as GitExec;
    const repo = {
      ok: true,
      workspacePath: "/tmp/repo",
      root: "/tmp/repo",
      runtimeRoot: null,
      baseBranch: "main",
      remote: null,
      remoteKind: "none",
      gitVersion: "2.40.0",
    };
    const reader = new GitReadService(repo as never, fake);
    const result = await reader.diff({ scope: "working" });
    expect(result.errorCode).toBe("GIT_READ_TIMEOUT");
  });

  it("returns GIT_READ_NOT_REPO through the service boundary", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "git-nonrepo-"));
    dirs.push(dir);
    const service = new GitService({
      dataDir: path.join(dir, "data"),
      store: { getWorkspace: () => ({ id: "ws1", name: "non-git", path: dir }) } as never,
    });
    try {
      const result = await service.readRepo("ws1");
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("GIT_READ_NOT_REPO");
    } finally {
      service.close();
    }
  });

  it("reports shallow and bare repositories without inventing a workspace", async () => {
    const source = initRepo("git-shallow-source-");
    writeFileSync(path.join(source, "a.txt"), "a\n");
    git(source, ["add", "a.txt"]);
    git(source, ["commit", "-m", "first"]);
    writeFileSync(path.join(source, "a.txt"), "b\n");
    git(source, ["add", "a.txt"]);
    git(source, ["commit", "-m", "second"]);
    const shallow = mkdtempSync(path.join(os.tmpdir(), "git-shallow-"));
    dirs.push(shallow);
    execFileSync("git", ["clone", "--depth", "1", "--no-local", source, shallow], { cwd: os.tmpdir(), encoding: "utf8" });
    const shallowReader = await readerFor(shallow);
    const shallowInfo = await shallowReader.repoInfo();
    expect(shallowInfo.ok).toBe(true);
    if (shallowInfo.ok) expect(shallowInfo.value!.shallow).toBe(true);

    const bare = mkdtempSync(path.join(os.tmpdir(), "git-bare-"));
    dirs.push(bare);
    execFileSync("git", ["clone", "--bare", source, bare], { cwd: os.tmpdir(), encoding: "utf8" });
    const bareRepo = {
      ok: true,
      workspacePath: bare,
      root: bare,
      runtimeRoot: null,
      baseBranch: "main",
      remote: null,
      remoteKind: "none",
      gitVersion: "2.40.0",
    };
    const bareReader = new GitReadService(bareRepo as never, new GitExec(mkdtempSync(path.join(os.tmpdir(), "git-hooks-"))));
    const bareInfo = await bareReader.repoInfo();
    expect(bareInfo.ok).toBe(true);
    if (bareInfo.ok) expect(bareInfo.value!.bare).toBe(true);
  }, 30_000);

  it("marks a tracked binary diff as binary", async () => {
    const dir = initRepo("git-binary-");
    writeFileSync(path.join(dir, "image.bin"), Buffer.from([0, 1, 2, 3]));
    git(dir, ["add", "image.bin"]);
    git(dir, ["commit", "-m", "binary"]);
    writeFileSync(path.join(dir, "image.bin"), Buffer.from([0, 4, 5, 6]));
    const reader = await readerFor(dir);
    const result = await reader.diff({ scope: "working", path: "image.bin" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value!.binary).toBe(true);
  });
});
