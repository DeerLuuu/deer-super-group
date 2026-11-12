import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitExec } from "./gitExec.js";
import { detectRepo, ensureHooksDir, runtimeHooksPath } from "./repo.js";
import { GitReadService } from "./readService.js";

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
});
