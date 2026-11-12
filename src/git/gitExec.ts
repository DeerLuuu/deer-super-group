import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitOutput {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitExecOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  env?: Record<string, string>;
}

const TOKEN_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /https?:\/\/[^/\s]+:[^/\s]+@/gi,
  /token=[^&\s]+/gi,
];

export function redactSecrets(value: string): string {
  let result = value;
  for (const pattern of TOKEN_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

function isSafeRef(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    !/[\0-\x1f\x7f~^:?*[\\\s]/.test(value) &&
    !value.includes("..") &&
    !value.startsWith("-")
  );
}

function isSafePath(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 260 &&
    !/[\0-\x1f\x7f]/.test(value) &&
    !value.includes("..") &&
    !value.startsWith("-")
  );
}

function isSafeBranch(value: string): boolean {
  return /^deer\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(value);
}

/**
 * argv-only allowlist. The first optional pair may be an isolated
 * `-c core.hooksPath=<runtimeRoot>/hooks-empty`; all other -c are forbidden.
 */
export function validateGitArgs(
  args: string[],
  hooksPath?: string,
): { ok: true; args: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(args) || args.length === 0) return { ok: false, reason: "empty argv" };
  const argv = [...args];
  if (argv[0] === "-c") {
    const setting = argv[1] ?? "";
    if (!hooksPath || setting !== `core.hooksPath=${hooksPath}`) {
      return { ok: false, reason: "forbidden -c setting" };
    }
    argv.splice(0, 2);
  }
  if (argv.some((item) => item.startsWith("-c") && item !== "-c")) {
    return { ok: false, reason: "forbidden -c option" };
  }
  if (argv.some((item) => item === "--exec" || item.startsWith("!") || item === "-f")) {
    return { ok: false, reason: "forbidden option" };
  }
  const command = argv[0] ?? "";
  const rest = argv.slice(1);
  if (command === "--version") return { ok: true, args: argv };
  if (command === "rev-parse") {
    if (rest.length < 1) return { ok: false, reason: "rev-parse requires a ref" };
    const first = rest[0] ?? "";
    if (first.startsWith("--")) {
      const allowed = new Set([
        "--show-toplevel",
        "--verify",
        "--abbrev-ref",
        "--git-dir",
        "--git-common-dir",
        "--git-path",
        "--is-inside-work-tree",
        "--is-bare-repository",
        "--is-shallow-repository",
      ]);
      if (!allowed.has(first)) return { ok: false, reason: "rev-parse flag" };
      if (first === "--git-path") {
        if (rest.length !== 2 || !isSafePath(rest[1])) return { ok: false, reason: "git-path arg" };
      }
      return { ok: true, args: argv };
    }
    if (!isSafeRef(first) && !/^[^:]+:.+$/.test(first)) {
      return { ok: false, reason: "unsafe rev-parse ref" };
    }
    return { ok: true, args: argv };
  }
  if (command === "remote") {
    if (rest[0] === "-v") return { ok: true, args: argv };
    if (rest[0] === "get-url" && rest.length === 2 && isSafeRef(rest[1])) return { ok: true, args: argv };
    return { ok: false, reason: "remote shape" };
  }
  if (command === "config") {
    if (rest[0] === "--get" && rest.length === 2 && isSafeRef(rest[1])) return { ok: true, args: argv };
    return { ok: false, reason: "config shape" };
  }
  if (command === "status") {
    if (rest[0] === "--porcelain" || rest[0] === "--porcelain=v1" || rest[0] === "--porcelain=v2") {
      const extra = rest.slice(1);
      if (extra.every((item) => item === "-z" || item === "--untracked-files=all" || item === "--ignore-submodules=none")) return { ok: true, args: argv };
    }
    return { ok: false, reason: "status shape" };
  }
  if (command === "diff") {
    const allowed = new Set([
      "--cached",
      "--name-only",
      "--name-status",
      "--numstat",
      "--stat",
      "--quiet",
      "--diff-filter=U",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--find-renames",
      "--find-copies",
      "-M",
      "-C",
      "--no-renames",
      "--no-index",
      "-z",
    ]);
    let unified = false;
    let paths = false;
    for (const item of rest) {
      if (paths) {
        if (!isSafePath(item)) return { ok: false, reason: "unsafe diff path" };
        continue;
      }
      if (item === "--") {
        paths = true;
        continue;
      }
      if (item.startsWith("--unified=")) {
        if (!/^--unified=\d+$/.test(item)) return { ok: false, reason: "unified" };
        unified = true;
        continue;
      }
      if (item.startsWith("-")) {
        if (!allowed.has(item)) return { ok: false, reason: `diff flag: ${item}` };
        continue;
      }
      // Revision expressions such as `<sha>~1` are safe for read-only diffs.
      if (!isSafeRef(item) && !/^[0-9a-f]{7,64}~1$/i.test(item)) {
        return { ok: false, reason: "unsafe diff ref" };
      }
    }
    void unified;
    return { ok: true, args: argv };
  }
  if (command === "log") {
    if (rest[0] === "-n" && rest[1] === "1" && rest[2]?.startsWith("--format=")) return { ok: true, args: argv };
    const allowed = new Set(["--no-color", "--no-decorate", "--topo-order", "--parents", "--all", "--oneline"]);
    let hasFormat = false;
    let maxCount = false;
    let skip = false;
    for (let index = 0; index < rest.length; index += 1) {
      const item = rest[index];
      if (item === "-n" && index === 0 && rest[index + 1] === "1" && rest[index + 2]?.startsWith("--format=")) {
        hasFormat = true;
        break;
      }
      if (item.startsWith("--format=")) {
        hasFormat = true;
        continue;
      }
      if (item.startsWith("--max-count=")) {
        const value = Number(item.slice("--max-count=".length));
        if (!Number.isInteger(value) || value < 1 || value > 501) return { ok: false, reason: "log max-count" };
        maxCount = true;
        continue;
      }
      if (item.startsWith("--skip=")) {
        const value = Number(item.slice("--skip=".length));
        if (!Number.isInteger(value) || value < 0 || value > 2000) return { ok: false, reason: "log skip" };
        skip = true;
        continue;
      }
      if (item.startsWith("-")) {
        if (!allowed.has(item)) return { ok: false, reason: `log flag: ${item}` };
        continue;
      }
      if (!isSafeRef(item)) return { ok: false, reason: "unsafe log ref" };
    }
    if (!hasFormat || !maxCount) return { ok: false, reason: "log shape" };
    void skip;
    return { ok: true, args: argv };
  }
  if (command === "for-each-ref") {
    if (
      rest[0]?.startsWith("--format=") &&
      rest.slice(1).every((item) => item === "--sort=refname" || /^refs\/(heads|remotes|tags)$/.test(item)) &&
      rest.slice(1).some((item) => item.startsWith("refs/"))
    ) {
      return { ok: true, args: argv };
    }
    return { ok: false, reason: "for-each-ref shape" };
  }
  if (command === "rev-list") {
    if (rest[0] === "--left-right" && rest[1] === "--count" && rest.length === 4 && isSafeRef(rest[2]) && isSafeRef(rest[3])) {
      return { ok: true, args: argv };
    }
    return { ok: false, reason: "rev-list shape" };
  }
  if (command === "show") {
    const allowed = new Set(["--no-color", "--no-ext-diff", "--no-textconv", "--name-status", "--numstat", "-s", "-z"]);
    let ref: string | null = null;
    let paths = false;
    for (const item of rest) {
      if (paths) {
        if (!isSafePath(item)) return { ok: false, reason: "unsafe show path" };
        continue;
      }
      if (item === "--") {
        paths = true;
        continue;
      }
      if (item.startsWith("--format=") || item.startsWith("--unified=")) continue;
      if (item.startsWith("-")) {
        if (!allowed.has(item)) return { ok: false, reason: `show flag: ${item}` };
        continue;
      }
      if (ref || !isSafeRef(item)) return { ok: false, reason: "show shape" };
      ref = item;
    }
    return ref || rest.length === 0 ? { ok: true, args: argv } : { ok: false, reason: "show shape" };
  }
  if (command === "cat-file") {
    if (rest[0] !== "-p" || !rest[1]) return { ok: false, reason: "cat-file shape" };
    if (isSafeRef(rest[1])) return { ok: true, args: argv };
    const refPath = /^([^:]+):(.+)$/.exec(rest[1]);
    if (refPath && isSafeRef(refPath[1]) && isSafePath(refPath[2])) return { ok: true, args: argv };
    return { ok: false, reason: "cat-file shape" };
  }
  if (command === "merge-base") {
    if (rest[0] === "--is-ancestor" && rest.length === 3 && isSafeRef(rest[1]) && isSafeRef(rest[2])) {
      return { ok: true, args: argv };
    }
    if (rest.length === 2 && isSafeRef(rest[0]) && isSafeRef(rest[1])) return { ok: true, args: argv };
    return { ok: false, reason: "merge-base shape" };
  }
  if (command === "patch-id") {
    return { ok: true, args: argv };
  }
  if (command === "check-ref-format") {
    if (rest[0] === "--branch" && rest[1] && isSafeRef(rest[1])) return { ok: true, args: argv };
    return { ok: false, reason: "check-ref-format shape" };
  }
  if (command === "submodule") {
    if (rest[0] === "status" && rest.length === 2 && rest[1] === "--recursive") return { ok: true, args: argv };
    return { ok: false, reason: "submodule shape" };
  }
  if (command === "worktree") {
    const sub = rest[0];
    if (sub === "list" && rest[1] === "--porcelain") return { ok: true, args: argv };
    if (sub === "prune" && rest.length === 1) return { ok: true, args: argv };
    if (sub === "remove") {
      const target = rest.find((item) => !item.startsWith("-"));
      if (target && isSafePath(target)) return { ok: true, args: argv };
    }
    if (sub === "add") {
      let index = 1;
      let branch: string | undefined;
      if (rest[index] === "--detach") index += 1;
      if (rest[index] === "-b") {
        branch = rest[index + 1];
        index += 2;
      }
      const worktreePath = rest[index];
      const ref = rest[index + 1];
      if (!branch || isSafeBranch(branch)) {
        if (worktreePath && isSafePath(worktreePath) && ref && isSafeRef(ref)) {
          return { ok: true, args: argv };
        }
      }
    }
    return { ok: false, reason: "worktree shape" };
  }
  if (command === "branch") {
    if (rest[0] === "--list" && rest.length === 2) return { ok: true, args: argv };
    if (rest[0] === "-D" && rest.length === 2 && isSafeBranch(rest[1])) return { ok: true, args: argv };
    return { ok: false, reason: "branch shape" };
  }
  if (command === "add") {
    // t352 G1：版本图写闭环——只允许 `add -A`（任务收尾）或
    // `add -- <paths>`（用户显式勾选暂存），路径必须逐一通过 isSafePath。
    if (rest[0] === "-A" && rest.length === 1) return { ok: true, args: argv };
    if (rest[0] === "--" && rest.length >= 2) {
      const paths = rest.slice(1);
      if (paths.length <= 500 && paths.every((item) => isSafePath(item))) {
        return { ok: true, args: argv };
      }
    }
    return { ok: false, reason: "add shape" };
  }
  if (command === "reset") {
    // t352 G1：unstage——仅允许 `reset -- <paths>`（把索引条目还原到 HEAD）。
    // 不允许 reset --hard / --soft / <commit> 等任何分支移动形态。
    if (rest[0] === "--" && rest.length >= 2) {
      const paths = rest.slice(1);
      if (paths.length <= 500 && paths.every((item) => isSafePath(item))) {
        return { ok: true, args: argv };
      }
    }
    return { ok: false, reason: "reset shape (only `reset -- <paths>` for unstage)" };
  }
  if (command === "commit") {
    if (rest[0] === "--no-verify" && rest[1] === "-m" && rest.length === 3) return { ok: true, args: argv };
    return { ok: false, reason: "commit shape" };
  }
  if (command === "format-patch") {
    if (rest[0] === "-1" && rest[1] && rest[2] === "--stdout" && isSafeRef(rest[1])) {
      return { ok: true, args: argv };
    }
    return { ok: false, reason: "format-patch shape" };
  }
  if (command === "fetch") {
    if (rest.length === 0) return { ok: true, args: argv };
    if (rest[0] && isSafeRef(rest[0]) && (rest.length === 1 || (rest.length === 2 && isSafeRef(rest[1])))) {
      return { ok: true, args: argv };
    }
    return { ok: false, reason: "fetch shape" };
  }
  if (command === "push") {
    const argsRest = rest.filter((item) => item !== "--no-verify" && item !== "-u");
    const target = argsRest[1] ?? "";
    const [from, to] = target.split(":");
    if (argsRest.length === 2 && isSafeRef(argsRest[0]) && isSafeBranch(from) && isSafeBranch(to ?? from)) {
      return { ok: true, args: argv };
    }
    return { ok: false, reason: "push shape (only deer/* branches)" };
  }
  if (command === "merge") {
    if (rest[0] === "--ff-only" && rest[1] && isSafeRef(rest[1])) return { ok: true, args: argv };
    return { ok: false, reason: "merge shape" };
  }
  if (command === "merge-tree") {
    if (rest[0] === "--write-tree" && rest.length === 3 && isSafeRef(rest[1]) && isSafeRef(rest[2])) {
      return { ok: true, args: argv };
    }
    return { ok: false, reason: "merge-tree shape" };
  }
  return { ok: false, reason: `unsupported git command: ${command}` };
}

function allowEnv(input?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "ComSpec",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
  ]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  Object.assign(env, input ?? {});
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export class RepoLock {
  private readonly tails = new Map<string, Promise<void>>();

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, previous.then(() => current));
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}

export class GitExec {
  private readonly hooksPath: string;
  readonly lock = new RepoLock();

  constructor(hooksPath: string) {
    this.hooksPath = hooksPath;
  }

  async run(args: string[], opts: GitExecOptions = {}): Promise<GitOutput> {
    const validated = validateGitArgs(args, this.hooksPath);
    if (!validated.ok) {
      throw Object.assign(new Error(validated.reason), { code: "GIT_FORBIDDEN" });
    }
    const fullArgs = [ "-c", `core.hooksPath=${this.hooksPath}`, ...validated.args ];
    try {
      const result = await execFileAsync("git", fullArgs, {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
        windowsHide: true,
        env: allowEnv(opts.env),
      });
      return {
        stdout: redactSecrets(result.stdout),
        stderr: redactSecrets(result.stderr),
        code: 0,
      };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; code?: number | string; message?: string };
      return {
        stdout: redactSecrets(err.stdout ?? ""),
        stderr: redactSecrets(err.stderr || err.message || "git failed"),
        code: typeof err.code === "number" ? err.code : 1,
      };
    }
  }
}
