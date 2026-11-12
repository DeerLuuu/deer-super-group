import { execFile } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { GitResult } from "./types.js";
import type { GitInitProbe, GitInitResult } from "./initTypes.js";

const execFileAsync = promisify(execFile);
const MIN_GIT_MAJOR = 2;
const MIN_GIT_MINOR = 36;
const INIT_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 8_000;
const MAX_CHILD_ENTRIES = 10_000;

type GitRun = {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  errorCode?: string;
};

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "LANG", "LC_ALL"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function runGit(cwd: string, args: string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<GitRun> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      env: gitEnv(),
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, code: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim(), timedOut: false };
  } catch (error) {
    const cause = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    return {
      ok: false,
      code: typeof cause.code === "number" ? cause.code : 1,
      stdout: String(cause.stdout ?? "").trim(),
      stderr: String(cause.stderr ?? cause.message ?? "").trim(),
      timedOut: Boolean(cause.killed) || cause.code === "ETIMEDOUT",
      errorCode: typeof cause.code === "string" ? cause.code : undefined,
    };
  }
}

function realPath(value: string): string {
  return realpathSync.native ? realpathSync.native(value) : realpathSync(value);
}

function samePath(left: string | null, right: string): boolean {
  if (!left) return false;
  try {
    return path.resolve(realPath(left)) === path.resolve(realPath(right));
  } catch {
    return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  }
}

function probeBase(workspaceId: string, workspacePath: string): GitInitProbe {
  return {
    workspaceId,
    workspacePath,
    root: null,
    status: "check-failed",
    canInitialize: false,
    branch: "main",
    gitVersion: null,
    reason: null,
  };
}

async function probeGitVersion(root: string): Promise<{ status: "ok" | "git-missing" | "version-low"; version: string | null }> {
  const version = await runGit(root, ["--version"], 5_000);
  if (!version.ok) return { status: "git-missing", version: null };
  const match = version.stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return { status: "git-missing", version: null };
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < MIN_GIT_MAJOR || (major === MIN_GIT_MAJOR && minor < MIN_GIT_MINOR)) {
    return { status: "version-low", version: `${match[1]}.${match[2]}.${match[3]}` };
  }
  return { status: "ok", version: `${match[1]}.${match[2]}.${match[3]}` };
}

/** Read-only preflight for initializing the workspace root as a Git repository. */
export async function probeGitInit(
  workspacePath: string,
  workspaceId = "",
): Promise<GitInitProbe> {
  const base = probeBase(workspaceId, workspacePath);
  if (!workspacePath || !existsSync(workspacePath)) {
    return { ...base, status: "not-found", reason: "工作区目录不存在" };
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(workspacePath).isDirectory();
  } catch {
    return { ...base, status: "not-found", reason: "工作区不可读取" };
  }
  if (!isDirectory) return { ...base, status: "not-directory", reason: "工作区不是目录" };

  let root: string;
  try {
    root = realPath(workspacePath);
  } catch {
    return { ...base, status: "not-found", reason: "工作区路径不可解析" };
  }
  const result = { ...base, root };
  const dotGit = path.join(root, ".git");
  if (existsSync(dotGit)) {
    const top = await runGit(root, ["rev-parse", "--show-toplevel"], PROBE_TIMEOUT_MS);
    if (top.ok && samePath(top.stdout, root)) {
      return { ...result, status: "already-repo", reason: "工作区已经是 Git 仓库" };
    }
    return { ...result, status: "invalid-repo", reason: "工作区存在 .git，但无法识别为仓库根" };
  }

  const version = await probeGitVersion(root);
  if (version.status === "git-missing") {
    return { ...result, status: "git-missing", reason: "未找到可用的 Git" };
  }
  if (version.status === "version-low") {
    return {
      ...result,
      status: "version-low",
      gitVersion: version.version,
      reason: `需要 Git ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}+（当前 ${version.version ?? "未知"}）`,
    };
  }
  result.gitVersion = version.version;

  const parent = await runGit(root, ["rev-parse", "--show-toplevel"], PROBE_TIMEOUT_MS);
  if (parent.ok && parent.stdout) {
    if (samePath(parent.stdout, root)) {
      return { ...result, status: "already-repo", reason: "工作区已经是 Git 仓库" };
    }
    return {
      ...result,
      status: "nested-repo",
      reason: `工作区位于已有 Git 仓库内：${parent.stdout}`,
    };
  }

  try {
    const entries = readdirSync(root, { withFileTypes: true });
    if (entries.length > MAX_CHILD_ENTRIES) {
      return { ...result, status: "check-failed", reason: "工作区条目过多，无法安全初始化" };
    }
    const childRepo = entries.find(
      (entry) => entry.isDirectory() && existsSync(path.join(root, entry.name, ".git")),
    );
    if (childRepo) {
      return {
        ...result,
        status: "nested-repo",
        reason: `工作区包含直接子仓库：${childRepo.name}`,
      };
    }
  } catch {
    return { ...result, status: "check-failed", reason: "工作区不可读取，无法安全检查" };
  }

  try {
    accessSync(root, constants.W_OK);
  } catch {
    return { ...result, status: "not-writable", reason: "工作区不可写" };
  }

  const bare = await runGit(root, ["rev-parse", "--is-bare-repository"], PROBE_TIMEOUT_MS);
  if (bare.ok && bare.stdout === "true") {
    return { ...result, status: "unsupported", reason: "不支持在 bare 工作区内初始化" };
  }

  return { ...result, status: "ready", canInitialize: true };
}

function initError(code: GitResult<GitInitResult>["errorCode"], message: string, retryable: boolean): GitResult<GitInitResult> {
  return { ok: false, errorCode: code, message, retryable };
}

function mapProbeFailure(probe: GitInitProbe): GitResult<GitInitResult> {
  const byStatus = {
    "already-repo": ["GIT_INIT_ALREADY_REPO", false],
    "nested-repo": ["GIT_INIT_NESTED_REPO", false],
    "git-missing": ["GIT_INIT_GIT_MISSING", false],
    "version-low": ["GIT_INIT_VERSION_LOW", false],
    "not-writable": ["GIT_INIT_NOT_WRITABLE", true],
    "invalid-repo": ["GIT_INIT_UNSUPPORTED", false],
    unsupported: ["GIT_INIT_UNSUPPORTED", false],
    "not-found": ["GIT_INIT_NOT_FOUND", false],
    "not-directory": ["GIT_INIT_NOT_FOUND", false],
    "check-failed": ["GIT_INIT_CHECK_FAILED", false],
    "workspace-missing": ["GIT_INIT_WORKSPACE_MISSING", false],
  } as const;
  const mapped = byStatus[probe.status as keyof typeof byStatus];
  return initError(mapped?.[0] ?? "GIT_INIT_FAILED", probe.reason ?? "无法初始化 Git 仓库", mapped?.[1] ?? false);
}

function isPermissionError(stderr: string): boolean {
  return /permission denied|access is denied|eacces|eperm/i.test(stderr);
}

/**
 * Initialize the workspace root only. No add/commit/.gitignore/remote/worktree
 * operations are performed; a failure never deletes a pre-existing .git.
 */
export async function initializeGitRepo(workspacePath: string): Promise<GitResult<GitInitResult>> {
  const probe = await probeGitInit(workspacePath);
  if (probe.status !== "ready" || !probe.root) return mapProbeFailure(probe);
  const root = probe.root;

  // Recheck immediately before the only write: an external process may have
  // created .git between probe and init.
  if (existsSync(path.join(root, ".git"))) {
    return initError("GIT_INIT_ALREADY_REPO", "工作区已经存在 .git", false);
  }

  const init = await runGit(root, ["init", "--initial-branch=main"], INIT_TIMEOUT_MS);
  if (!init.ok) {
    const partial = existsSync(path.join(root, ".git"));
    if (init.timedOut) return initError("GIT_INIT_TIMEOUT", "初始化 Git 超时，请重试", true);
    if (isPermissionError(init.stderr)) return initError("GIT_INIT_NOT_WRITABLE", "工作区不可写，无法创建 .git", true);
    if (partial) return initError("GIT_INIT_PARTIAL", ".git 可能已部分创建，请刷新检查后再试", true);
    return initError("GIT_INIT_FAILED", init.stderr || "git init 失败", true);
  }

  const verify = await runGit(root, ["rev-parse", "--show-toplevel"], PROBE_TIMEOUT_MS);
  if (!verify.ok || !samePath(verify.stdout, root)) {
    return initError("GIT_INIT_PARTIAL", "Git 仓库未完整创建，请刷新检查", true);
  }

  return {
    ok: true,
    value: {
      workspaceId: "",
      workspacePath,
      root,
      branch: "main",
      headSha: null,
      auditEventId: null,
      initialized: true,
    },
  };
}

export { INIT_TIMEOUT_MS };
