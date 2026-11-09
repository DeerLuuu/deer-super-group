import type { GitExec } from "./gitExec.js";
import type { BranchCommit, TreeVerification } from "./types.js";

export function parseNameStatus(raw: string): Array<{ status: string; path: string }> {
  const tokens = raw.split("\0").filter(Boolean);
  const result: Array<{ status: string; path: string }> = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const status = tokens[i];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = tokens[i + 1];
      const to = tokens[i + 2];
      if (from && to) result.push({ status, path: `${from}\0${to}` });
      i += 2;
      continue;
    }
    const file = tokens[i + 1];
    if (file) result.push({ status, path: file });
    i += 1;
  }
  return result;
}

export async function commitAll(input: {
  git: GitExec;
  worktree: string;
  message: string;
  scan: () => Promise<{ ok: boolean; blocked: boolean; reason?: string; files: string[] }>;
}): Promise<{ ok: boolean; commit?: BranchCommit; reason?: string }> {
  const guard = await input.scan();
  if (!guard.ok) return { ok: false, reason: guard.reason ?? "commit guard blocked" };
  const add = await input.git.run(["add", "-A"], { cwd: input.worktree });
  if (add.code !== 0) return { ok: false, reason: add.stderr || "git add failed" };
  const commit = await input.git.run(["commit", "--no-verify", "-m", input.message], {
    cwd: input.worktree,
    timeoutMs: 60_000,
  });
  if (commit.code !== 0) return { ok: false, reason: commit.stderr || "git commit failed" };
  const sha = await input.git.run(["log", "-n", "1", "--format=%H"], { cwd: input.worktree });
  if (sha.code !== 0) return { ok: false, reason: sha.stderr || "git log failed" };
  const head = sha.stdout.trim();
  const diff = await input.git.run(["diff", "--name-only", `${head}~1`, head], {
    cwd: input.worktree,
  });
  const files = diff.code === 0 ? diff.stdout.split("\n").filter(Boolean) : [];
  return {
    ok: true,
    commit: {
      sha: head,
      branch: "",
      files,
      insertions: 0,
      deletions: 0,
    },
  };
}

export async function pushBranch(input: {
  git: GitExec;
  cwd: string;
  remote: string;
  branch: string;
}): Promise<{ ok: boolean; code: number; error?: string }> {
  const result = await input.git.run(
    ["push", "--no-verify", "-u", input.remote, `${input.branch}:${input.branch}`],
    { cwd: input.cwd, timeoutMs: 120_000 },
  );
  if (result.code === 0) return { ok: true, code: 0 };
  const error = /auth|permission|denied/i.test(result.stderr)
    ? "AUTH_PUSH"
    : "GIT_PUSH_NETWORK";
  return { ok: false, code: result.code, error };
}

export async function revParse(input: {
  git: GitExec;
  cwd: string;
  ref: string;
}): Promise<string | null> {
  const result = await input.git.run(["rev-parse", input.ref], { cwd: input.cwd });
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * Tree/patch-level integration check for local/manual flows. A merge commit
 * can use the fast ancestor path; squash/rebase must compare changed blobs.
 */
export async function verifyIntegratedContent(input: {
  git: GitExec;
  cwd: string;
  headSha: string;
  integratedRef: string;
  allowAncestor?: boolean;
}): Promise<TreeVerification> {
  if (input.allowAncestor) {
    const ancestor = await input.git.run(
      ["merge-base", "--is-ancestor", input.headSha, input.integratedRef],
      { cwd: input.cwd },
    );
    if (ancestor.code === 0) return { ok: true, method: "ancestor" };
  }
  const base = await input.git.run(["merge-base", input.headSha, input.integratedRef], {
    cwd: input.cwd,
  });
  if (base.code !== 0) return { ok: false, method: "content", reason: "no common merge-base" };
  const mergeBase = base.stdout.trim();
  const diff = await input.git.run(["diff", "--name-status", "-z", mergeBase, input.headSha], {
    cwd: input.cwd,
  });
  if (diff.code !== 0) return { ok: false, method: "content", reason: diff.stderr || "diff failed" };
  const entries = parseNameStatus(diff.stdout);
  const mismatched: string[] = [];
  for (const entry of entries) {
    const paths = entry.path.split("\0");
    for (const relative of paths) {
      if (!relative) continue;
      const headBlob = await input.git.run(["rev-parse", `${input.headSha}:${relative}`], {
        cwd: input.cwd,
      });
      const integratedBlob = await input.git.run(
        ["rev-parse", `${input.integratedRef}:${relative}`],
        { cwd: input.cwd },
      );
      const headValue = headBlob.code === 0 ? headBlob.stdout.trim() : null;
      const integratedValue = integratedBlob.code === 0 ? integratedBlob.stdout.trim() : null;
      if (headValue !== integratedValue) mismatched.push(relative);
    }
  }
  return {
    ok: mismatched.length === 0,
    method: "content",
    reason: mismatched.length ? "content differs" : undefined,
    mismatched,
  };
}

export async function detectConflict(input: {
  git: GitExec;
  cwd: string;
  base: string;
  head: string;
}): Promise<boolean> {
  const result = await input.git.run(["merge-tree", "--write-tree", input.base, input.head], {
    cwd: input.cwd,
    timeoutMs: 60_000,
  });
  return result.code !== 0 || /CONFLICT/i.test(result.stdout + result.stderr);
}
