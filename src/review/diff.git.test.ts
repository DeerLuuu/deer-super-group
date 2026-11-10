import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewDiffProvider } from "./diff.js";
import type { TaskVcs } from "../git/types.js";

const dirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may keep a handle after a git process; ignore cleanup.
    }
  }
});

describe("ReviewDiffProvider with real git/GitExec", () => {
  it("reads a commit diff, redacts secrets and stays inside the workspace", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "review-git-"));
    dirs.push(dir);
    git(dir, ["init", "-b", "main"]);
    git(dir, ["config", "user.email", "review@example.com"]);
    git(dir, ["config", "user.name", "Review"]);
    writeFileSync(path.join(dir, "a.txt"), "base\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-m", "base"]);
    git(dir, ["checkout", "-b", "feature"]);
    writeFileSync(path.join(dir, "a.txt"), "base\ntoken=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-m", "feature"]);
    const head = git(dir, ["rev-parse", "HEAD"]).trim();
    const provider = new ReviewDiffProvider(() => dir);
    const result = await provider.compute("ws1", {
      taskId: "t1",
      workspaceId: "ws1",
      mode: "auto",
      branch: "feature",
      baseBranch: "main",
      headSha: head,
      pr: null,
      merge: { state: "none", commitSha: null },
      conflictTaskId: null,
      errorCode: null,
      updatedAt: new Date().toISOString(),
    } as unknown as TaskVcs);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files[0].path).toBe("a.txt");
    expect(result.files[0].patchText).toContain("[REDACTED]");
    expect(result.files[0].patchText).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });
});
