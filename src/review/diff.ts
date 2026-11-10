import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskVcs } from "../git/types.js";
import type { ReviewFile, ReviewLine } from "./types.js";

const execFileAsync = promisify(execFile);

export interface ReviewDiffFile extends ReviewFile {
  patchText: string;
  fileHash: string;
}

export interface ReviewDiffResult {
  baseSha: string;
  mergeBaseSha: string;
  headSha: string;
  diffHash: string;
  files: ReviewDiffFile[];
}

export class ReviewDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewDiffError";
  }
}

const MAX_FILE_LINES = 2000;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

function hash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function gitPath(raw: string): string {
  let value = raw.trim();
  if (value.startsWith("a/") || value.startsWith("b/")) value = value.slice(2);
  if (value === "/dev/null") return "";
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      value = JSON.parse(value) as string;
    } catch {
      value = value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Parse one unified diff file block. This intentionally supports the subset
 * produced by `git diff -U3`; combined diffs are rejected by the provider.
 */
export function parseFilePatch(block: string, fileIndex = 0): ReviewDiffFile {
  const lines = block.split("\n");
  let path = "";
  let oldPath: string | null = null;
  let changeType = "M";
  let isBinary = false;
  let isLfs = false;
  let additions = 0;
  let deletions = 0;
  let patchText = block;
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const value = gitPath(line.slice(4));
      if (value) path = value;
    } else if (line.startsWith("--- ")) {
      const value = gitPath(line.slice(4));
      oldPath = value || null;
    } else if (line.startsWith("new file mode")) {
      changeType = "A";
    } else if (line.startsWith("deleted file mode")) {
      changeType = "D";
    } else if (line.startsWith("rename from ")) {
      oldPath = line.slice("rename from ".length);
      changeType = "R";
    } else if (line.startsWith("rename to ")) {
      path = line.slice("rename to ".length);
      changeType = "R";
    } else if (line.startsWith("Binary files ")) {
      isBinary = true;
      if (line.includes("GIT binary patch")) isLfs = true;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }
  if (!path && oldPath) path = oldPath;
  const parsed = parseFileLines(block);
  const totalLines = parsed.length;
  const truncated = totalLines > MAX_FILE_LINES || Buffer.byteLength(patchText, "utf8") > MAX_FILE_BYTES;
  if (truncated) {
    const kept = block.split("\n").slice(0, MAX_FILE_LINES).join("\n");
    patchText = kept.slice(0, MAX_FILE_BYTES);
  }
  return {
    targetId: "",
    fileIndex,
    path: path || "(unknown)",
    oldPath: oldPath === path ? null : oldPath,
    changeType,
    isBinary,
    isLfs,
    additions,
    deletions,
    lineCount: totalLines,
    truncated,
    patchText,
    fileHash: hash(block),
  };
}

export function parseUnifiedDiff(patch: string): ReviewDiffFile[] {
  const blocks: string[] = [];
  const lines = patch.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith("diff --git ")) {
      if (start >= 0) blocks.push(lines.slice(start, i).join("\n"));
      start = i;
    }
  }
  if (start >= 0) blocks.push(lines.slice(start).join("\n"));
  return blocks.map((block, index) => parseFilePatch(block, index));
}

export function parseFileLines(patch: string): ReviewLine[] {
  const result: ReviewLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let hunk = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!match) continue;
      oldLine = Number(match[1]);
      newLine = Number(match[2]);
      inHunk = true;
      hunk += 1;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("diff --git") || line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (line.startsWith("+")) {
      result.push({ kind: "add", oldLine: null, newLine, text: line.slice(1), hunk });
      newLine += 1;
    } else if (line.startsWith("-")) {
      result.push({ kind: "del", oldLine, newLine: null, text: line.slice(1), hunk });
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      result.push({ kind: "context", oldLine, newLine, text: line.slice(1), hunk });
      oldLine += 1;
      newLine += 1;
    } else if (line.startsWith("\\ No newline")) {
      // metadata, not a diff line
    } else if (line === "") {
      // A trailing empty line should not consume a line number.
    } else {
      // File metadata after a hunk (e.g. mode change) ends the hunk.
      inHunk = false;
    }
  }
  return result;
}

export function pageLines(lines: ReviewLine[], offset = 0, limit = 300): { lines: ReviewLine[]; offset: number; total: number; hasMore: boolean } {
  const safeOffset = Math.max(0, Math.min(offset, lines.length));
  const safeLimit = Math.max(1, Math.min(limit, 500));
  return {
    lines: lines.slice(safeOffset, safeOffset + safeLimit),
    offset: safeOffset,
    total: lines.length,
    hasMore: safeOffset + safeLimit < lines.length,
  };
}

export class ReviewDiffProvider {
  constructor(private readonly workspacePath: (workspaceId: string) => string) {}

  private async git(workspaceId: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<string> {
    const cwd = this.workspacePath(workspaceId);
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        encoding: "utf8",
        maxBuffer,
        timeout: 30_000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
      });
      return stdout;
    } catch (err) {
      throw new ReviewDiffError(err instanceof Error ? err.message : String(err));
    }
  }

  async compute(workspaceId: string, vcs: TaskVcs): Promise<ReviewDiffResult> {
    if (!vcs.branch || !vcs.headSha) throw new ReviewDiffError("task has no branch/head");
    const baseBranch = vcs.baseBranch || "main";
    const baseSha = (await this.git(workspaceId, ["rev-parse", "--verify", baseBranch])).trim();
    const headSha = (await this.git(workspaceId, ["rev-parse", "--verify", vcs.headSha])).trim();
    let mergeBaseSha: string;
    try {
      mergeBaseSha = (await this.git(workspaceId, ["merge-base", baseSha, headSha])).trim();
    } catch {
      throw new ReviewDiffError("merge base not found");
    }
    if (!mergeBaseSha) throw new ReviewDiffError("merge base empty");
    const patch = await this.git(workspaceId, [
      "-c",
      "core.hooksPath=/dev/null",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      "-U3",
      `${mergeBaseSha}..${headSha}`,
    ]);
    if (Buffer.byteLength(patch, "utf8") > MAX_TOTAL_BYTES) {
      throw new ReviewDiffError("diff too large");
    }
    const files = parseUnifiedDiff(patch);
    return {
      baseSha,
      mergeBaseSha,
      headSha,
      diffHash: hash(patch),
      files,
    };
  }

  async readBlob(workspaceId: string, headSha: string, path: string): Promise<string | null> {
    try {
      return await this.git(workspaceId, ["cat-file", "-p", `${headSha}:${path}`], 4 * 1024 * 1024);
    } catch {
      return null;
    }
  }

  async nameStatus(workspaceId: string, oldHead: string, newHead: string): Promise<Map<string, string>> {
    const output = await this.git(workspaceId, ["diff", "--name-status", "-z", "-M", oldHead, newHead]);
    const parts = output.split("\0").filter(Boolean);
    const map = new Map<string, string>();
    for (let i = 0; i < parts.length; i += 1) {
      const status = parts[i];
      if (status.startsWith("R") || status.startsWith("C")) {
        const from = parts[i + 1];
        const to = parts[i + 2];
        if (from && to) map.set(from, `${to}\0${status[0]}`);
        i += 2;
      } else {
        const file = parts[i + 1];
        if (file) map.set(file, `${file}\0${status[0]}`);
        i += 1;
      }
    }
    return map;
  }

  async diffBetween(workspaceId: string, oldHead: string, newHead: string, path: string): Promise<string> {
    return this.git(workspaceId, [
      "-c",
      "core.hooksPath=/dev/null",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "-U3",
      oldHead,
      newHead,
      "--",
      path,
    ]);
  }
}
