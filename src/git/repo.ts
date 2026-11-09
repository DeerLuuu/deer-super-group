import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { RepoInfo, TaskVcs } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? err.message ?? "") };
  }
}

function gitSync(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const result = execFileSync("git", args, {
      cwd,
      timeout: 15_000,
      windowsHide: true,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, stdout: String(result).trim(), stderr: "" };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? err.message ?? "") };
  }
}

export function chooseRuntimeRoot(workspacePath: string): {
  root: string;
  relative: string;
  fallback: boolean;
} {
  const deer = path.join(workspacePath, ".deer");
  const deerGit = path.join(workspacePath, ".deer-git");
  const marker = path.join(deer, "worktrees", ".deer-git.json");
  if (!existsSync(deer)) {
    mkdirSync(path.join(deer, "worktrees"), { recursive: true });
    return { root: deer, relative: ".deer", fallback: false };
  }
  if (existsSync(marker)) {
    mkdirSync(path.join(deer, "worktrees"), { recursive: true });
    return { root: deer, relative: ".deer", fallback: false };
  }
  mkdirSync(path.join(deerGit, "worktrees"), { recursive: true });
  return { root: deerGit, relative: ".deer-git", fallback: true };
}

/**
 * Detect a workspace as a Git repo root and prepare its runtime root/exclude.
 * Never throws; failures become RepoInfo.ok=false so the caller can degrade.
 */
export async function detectRepo(workspacePath: string, baseCandidate?: string): Promise<RepoInfo> {
  const empty: RepoInfo = {
    ok: false,
    workspacePath,
    root: null,
    runtimeRoot: null,
    baseBranch: baseCandidate ?? "main",
    remote: null,
    remoteKind: "none",
    gitVersion: null,
    errorCode: "GIT_REPO_NOT_FOUND",
    reason: "not a git repository",
  };
  if (!existsSync(workspacePath)) {
    return { ...empty, errorCode: "GIT_NOT_FOUND", reason: "workspace does not exist" };
  }
  if (!existsSync(path.join(workspacePath, ".git"))) {
    return empty;
  }
  let realWorkspace: string;
  try {
    realWorkspace = realpathSync(workspacePath);
  } catch {
    return { ...empty, errorCode: "GIT_NOT_FOUND", reason: "workspace is not readable" };
  }
  const version = await git(realWorkspace, ["--version"]);
  if (!version.ok) {
    return { ...empty, errorCode: "GIT_NOT_FOUND", reason: "git is not installed" };
  }
  const versionMatch = version.stdout.match(/(\d+\.\d+\.\d+)/);
  const gitVersion = versionMatch?.[1] ?? null;
  const majorMinor = gitVersion?.split(".").slice(0, 2).map(Number) ?? [0, 0];
  if (majorMinor[0] < 2 || (majorMinor[0] === 2 && majorMinor[1] < 36)) {
    return { ...empty, gitVersion, errorCode: "GIT_VERSION_LOW", reason: "git >= 2.36 required" };
  }
  const top = await git(realWorkspace, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    return { ...empty, gitVersion, errorCode: "GIT_REPO_NOT_FOUND", reason: top.stderr || "not a git repo" };
  }
  let root: string;
  try {
    root = realpathSync(top.stdout);
  } catch {
    root = top.stdout;
  }
  if (path.resolve(root) !== path.resolve(realWorkspace)) {
    return {
      ...empty,
      gitVersion,
      errorCode: "GIT_NOT_ROOT",
      reason: "workspace must be the git repository root",
    };
  }

  const candidates = baseCandidate ? [baseCandidate, "main", "master"] : ["main", "master"];
  let baseBranch = candidates[0] ?? "main";
  for (const candidate of candidates) {
    const check = await git(root, ["rev-parse", "--verify", candidate]);
    if (check.ok) {
      baseBranch = candidate;
      break;
    }
  }

  let remote: string | null = null;
  const remoteResult = await git(root, ["remote", "get-url", "origin"]);
  if (remoteResult.ok && remoteResult.stdout) remote = remoteResult.stdout;

  const runtime = chooseRuntimeRoot(root);
  // Local-only exclude; never modify .gitignore or commit this.
  const excludePath = await git(root, ["rev-parse", "--git-path", "info/exclude"]);
  if (excludePath.ok && excludePath.stdout) {
    const target = path.isAbsolute(excludePath.stdout)
      ? excludePath.stdout
      : path.join(root, excludePath.stdout);
    try {
      const line = `${runtime.relative}/`;
      const current = existsSync(target) ? await import("node:fs/promises").then((fs) => fs.readFile(target, "utf8")) : "";
      if (!current.split(/\r?\n/).includes(line)) {
        const prefix = current && !current.endsWith("\n") ? "\n" : "";
        await import("node:fs/promises").then((fs) => fs.appendFile(target, `${prefix}${line}\n`, "utf8"));
      }
    } catch {
      // best effort; do not fail repo detection for exclude problems
    }
  }

  const marker = path.join(runtime.root, "worktrees", ".deer-git.json");
  try {
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(
      marker,
      JSON.stringify({ schema: "deer.git.runtime", version: 1, runtimeRoot: runtime.relative }, null, 2),
      "utf8",
    );
  } catch {
    // ignore marker failure; runtime still works
  }

  return {
    ok: true,
    workspacePath: root,
    root,
    runtimeRoot: runtime.root,
    baseBranch,
    remote,
    remoteKind: remote ? "remote" : "none",
    gitVersion,
  };
}

/**
 * Synchronous variant used by the kernel's fast beforeStart hook so the
 * `run.started` event can carry `git:<worktree>` without a second write.
 */
export function detectRepoSync(workspacePath: string, baseCandidate?: string): RepoInfo {
  const empty: RepoInfo = {
    ok: false,
    workspacePath,
    root: null,
    runtimeRoot: null,
    baseBranch: baseCandidate ?? "main",
    remote: null,
    remoteKind: "none",
    gitVersion: null,
    errorCode: "GIT_REPO_NOT_FOUND",
    reason: "not a git repository",
  };
  if (!existsSync(workspacePath)) return { ...empty, errorCode: "GIT_NOT_FOUND", reason: "workspace does not exist" };
  if (!existsSync(path.join(workspacePath, ".git"))) return empty;
  let realWorkspace: string;
  try {
    realWorkspace = realpathSync(workspacePath);
  } catch {
    return { ...empty, errorCode: "GIT_NOT_FOUND", reason: "workspace is not readable" };
  }
  const version = gitSync(realWorkspace, ["--version"]);
  if (!version.ok) return { ...empty, errorCode: "GIT_NOT_FOUND", reason: "git is not installed" };
  const gitVersion = version.stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  const majorMinor = gitVersion?.split(".").slice(0, 2).map(Number) ?? [0, 0];
  if (majorMinor[0] < 2 || (majorMinor[0] === 2 && majorMinor[1] < 36)) {
    return { ...empty, gitVersion, errorCode: "GIT_VERSION_LOW", reason: "git >= 2.36 required" };
  }
  const top = gitSync(realWorkspace, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { ...empty, gitVersion, errorCode: "GIT_REPO_NOT_FOUND", reason: top.stderr || "not a git repo" };
  let root: string;
  try {
    root = realpathSync(top.stdout);
  } catch {
    root = top.stdout;
  }
  if (path.resolve(root) !== path.resolve(realWorkspace)) {
    return { ...empty, gitVersion, errorCode: "GIT_NOT_ROOT", reason: "workspace must be the git repository root" };
  }
  const candidates = baseCandidate ? [baseCandidate, "main", "master"] : ["main", "master"];
  let baseBranch = candidates[0] ?? "main";
  for (const candidate of candidates) {
    if (gitSync(root, ["rev-parse", "--verify", candidate]).ok) {
      baseBranch = candidate;
      break;
    }
  }
  const remoteResult = gitSync(root, ["remote", "get-url", "origin"]);
  const remote = remoteResult.ok && remoteResult.stdout ? remoteResult.stdout : null;
  const runtime = chooseRuntimeRoot(root);
  const excludePath = gitSync(root, ["rev-parse", "--git-path", "info/exclude"]);
  if (excludePath.ok && excludePath.stdout) {
    const target = path.isAbsolute(excludePath.stdout) ? excludePath.stdout : path.join(root, excludePath.stdout);
    try {
      const line = `${runtime.relative}/`;
      const current = existsSync(target) ? readFileSync(target, "utf8") : "";
      if (!current.split(/\r?\n/).includes(line)) {
        appendFileSync(target, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`, "utf8");
      }
    } catch {
      // best effort
    }
  }
  const marker = path.join(runtime.root, "worktrees", ".deer-git.json");
  try {
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify({ schema: "deer.git.runtime", version: 1, runtimeRoot: runtime.relative }, null, 2), "utf8");
  } catch {
    // ignore
  }
  return {
    ok: true,
    workspacePath: root,
    root,
    runtimeRoot: runtime.root,
    baseBranch,
    remote,
    remoteKind: remote ? "remote" : "none",
    gitVersion,
  };
}

export function runtimeHooksPath(repo: RepoInfo): string | null {  return repo.runtimeRoot ? path.join(repo.runtimeRoot, "hooks-empty") : null;
}

export function taskVcsMode(repo: RepoInfo | null): TaskVcs["mode"] {
  return repo?.ok ? "git" : "degraded";
}

export function ensureHooksDir(repo: RepoInfo): void {
  if (!repo.runtimeRoot) return;
  mkdirSync(path.join(repo.runtimeRoot, "hooks-empty"), { recursive: true });
}
