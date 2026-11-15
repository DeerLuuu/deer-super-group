import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { redactSecrets } from "../../src/git/gitExec.js";
import {
  CONSOLE_LIMITS,
  consoleError,
  consoleFail,
  consoleOk,
  type ConsoleCwdOption,
  type ConsoleEvent,
  type ConsoleResult,
  type ConsoleSession,
  type ConsoleSnapshot,
  type ConsoleStartInput,
  type ConsoleStatus,
} from "../../src/shared/console.js";

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => ChildProcess;

type ConsoleLimits = {
  activePerWorkspace: number;
  activeGlobal: number;
  historyPerWorkspace: number;
  sessionsGlobal: number;
  bufferBytes: number;
  chunkBytes: number;
  batchMs: number;
  stdinBytes: number;
  commandChars: number;
  titleChars: number;
  cwdChars: number;
  confirmTtlMs: number;
  killGraceMs: number;
};

export type ConsoleManagerOptions = {
  workspaceRoot: (workspaceId: string) => string | null | undefined;
  platform?: NodeJS.Platform;
  spawn?: SpawnLike;
  execFile?: typeof execFile;
  now?: () => number;
  limits?: Partial<ConsoleLimits>;
};

type PendingOutput = {
  stdout: string;
  stderr: string;
};

type InternalSession = {
  session: ConsoleSession;
  child: ChildProcess | null;
  decoders: { stdout: StringDecoder; stderr: StringDecoder } | null;
  pending: PendingOutput;
  flushTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  output: string;
  stopRequested: boolean;
  finalized: boolean;
};

const ACTIVE_STATUSES = new Set<ConsoleStatus>(["starting", "running", "stopping"]);
const ELEVATION_PATTERNS: Array<[RegExp, string]> = [
  [/\bsudo\b/i, "sudo"],
  [/\brunas\b/i, "runas"],
  [/\bgsudo\b/i, "gsudo"],
  [/\bpkexec\b/i, "pkexec"],
  [/Start-Process\b[\s\S]*?-Verb\s+RunAs/i, "Start-Process -Verb RunAs"],
];
const DANGER_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+-[a-z]*r[a-z]*f[a-z]*\b|\brm\s+-[a-z]*f[a-z]*r[a-z]*\b/i, "递归删除"],
  [/\brm\s+-rf?\s+(?:\/|~|\*|\.(?:\s|$))/i, "删除根/当前目录"],
  [/\bdel\s+\/s\s+\/q\b|\brd\s+\/s\s+\/q\b|\brmdir\s+\/s\s+\/q\b/i, "递归删除"],
  [/(?:^|[\s;&|])format(?:\s|$)/i, "format"],
  [/\bdiskpart\b/i, "diskpart"],
  [/\bmkfs(?:\.\w+)?\b/i, "mkfs"],
  [/\bshutdown\b|\brestart-computer\b/i, "关机/重启"],
  [/\breg\s+delete\b/i, "删除注册表"],
  [/\btakeown\s+\/f\b/i, "takeown"],
];
const SENSITIVE_ENV = new Set([
  "SSH_AUTH_SOCK",
  "GPG_AGENT_INFO",
  "HISTFILE",
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
]);
const ENV_ALLOWLIST = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "COMSPEC",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
]);

export function buildConsoleEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase();
    if (!ENV_ALLOWLIST.has(upper) || SENSITIVE_ENV.has(upper) || value === undefined) continue;
    env[key] = value;
  }
  env.CI = "1";
  env.TERM = "dumb";
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  if (process.platform !== "win32") env.HISTFILE = "/dev/null";
  return env;
}

export function consoleElevationReason(command: string): string | null {
  for (const [pattern, reason] of ELEVATION_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

export function consoleDangerReasons(command: string): string[] {
  return DANGER_PATTERNS.filter(([pattern]) => pattern.test(command)).map(([, reason]) => reason);
}

function commandHash(command: string, cwd: string): string {
  return createHash("sha256").update(`${command}\0${cwd}`).digest("hex");
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function tailText(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  return buffer.subarray(buffer.length - maxBytes).toString("utf8");
}

/** 以 UTF-8 字节上限切一个前缀（避免把多字节字符切成半个）。 */
function utf8Prefix(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8");
  let end = Math.min(buffer.length, maxBytes);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function splitUtf8(value: string, maxBytes: number): string[] {
  const result: string[] = [];
  let rest = value;
  while (rest && byteLength(rest) > maxBytes) {
    const prefix = utf8Prefix(rest, maxBytes);
    result.push(prefix);
    rest = rest.slice(prefix.length);
    if (!prefix) break;
  }
  if (rest) result.push(rest);
  return result;
}

function safeMessage(error: unknown, max = 300): string {
  const text = error instanceof Error ? error.message : String(error ?? "unknown");
  return redactSecrets(text).slice(0, max);
}

function normalizeCwdRelative(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+/g, "/");
  return normalized === "" || normalized === "./" ? "." : normalized.replace(/\/$/, "");
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sortSessions(sessions: ConsoleSession[]): ConsoleSession[] {
  return [...sessions].sort((left, right) => {
    const leftActive = ACTIVE_STATUSES.has(left.status) ? 0 : 1;
    const rightActive = ACTIVE_STATUSES.has(right.status) ? 0 : 1;
    if (leftActive !== rightActive) return leftActive - rightActive;
    return right.startedAt.localeCompare(left.startedAt);
  });
}

export class ConsoleManager {
  private readonly options: Required<Omit<ConsoleManagerOptions, "limits" | "spawn" | "execFile">> & {
    spawn: SpawnLike;
    execFile: typeof execFile;
    limits: ConsoleLimits;
  };
  private readonly sessions = new Map<string, InternalSession>();
  private readonly listeners = new Set<(event: ConsoleEvent) => void>();
  private readonly confirmations = new Map<
    string,
    { workspaceId: string; hash: string; expiresAt: number }
  >();

  constructor(options: ConsoleManagerOptions) {
    this.options = {
      workspaceRoot: options.workspaceRoot,
      platform: options.platform ?? process.platform,
      spawn: options.spawn ?? (spawn as unknown as SpawnLike),
      execFile: options.execFile ?? execFile,
      now: options.now ?? Date.now,
      limits: { ...CONSOLE_LIMITS, ...options.limits },
    };
  }

  onEvent(listener: (event: ConsoleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(workspaceId: string): ConsoleSession[] {
    const root = this.workspaceRoot(workspaceId);
    if (!root) return [];
    return sortSessions(
      [...this.sessions.values()]
        .filter((item) => item.session.workspaceId === workspaceId)
        .map((item) => this.view(item)),
    );
  }

  cwds(workspaceId: string): ConsoleResult<ConsoleCwdOption[]> {
    const root = this.workspaceRoot(workspaceId);
    if (!root) return consoleFail("CONSOLE_WORKSPACE_MISSING", "工作区不存在或已关闭");
    try {
      const realRoot = realpathSync(root);
      if (!statSync(realRoot).isDirectory()) {
        return consoleFail("CONSOLE_CWD_INVALID", "工作区根不是目录");
      }
      const names = readdirSync(realRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter(
          (name) =>
            !name.startsWith(".") &&
            !["node_modules", "dist", "dist-electron", "coverage"].includes(name),
        )
        .sort((left, right) => left.localeCompare(right))
        .slice(0, 99);
      return consoleOk([
        { relative: ".", absolute: realRoot },
        ...names.map((name) => ({
          relative: name,
          absolute: path.join(realRoot, name),
        })),
      ]);
    } catch (error) {
      return consoleFail("CONSOLE_CWD_INVALID", safeMessage(error));
    }
  }

  start(workspaceId: string, input: ConsoleStartInput): ConsoleResult<ConsoleSession> {
    const root = this.workspaceRoot(workspaceId);
    if (!root) return consoleFail("CONSOLE_WORKSPACE_MISSING", "工作区不存在或已关闭");
    const command = String(input.command ?? "").trim();
    if (
      !command ||
      command.length > this.options.limits.commandChars ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(command)
    ) {
      return consoleFail("CONSOLE_COMMAND_INVALID", "命令为空、含非法字符或过长");
    }
    const elevation = consoleElevationReason(command);
    if (elevation) {
      return consoleFail(
        "CONSOLE_ELEVATION_REJECTED",
        "不支持提权/管理员命令（不会请求 UAC）",
        false,
        { reason: elevation },
      );
    }
    const cwdResult = this.resolveCwd(root, input.cwd ?? ".");
    if (!cwdResult.ok) return cwdResult;

    const dangerReasons = consoleDangerReasons(command);
    if (dangerReasons.length > 0) {
      const hash = commandHash(command, cwdResult.value.absolute);
      if (!input.confirmToken) {
        const token = randomUUID();
        const now = this.options.now();
        this.cleanupConfirmations(now);
        this.confirmations.set(token, {
          workspaceId,
          hash,
          expiresAt: now + this.options.limits.confirmTtlMs,
        });
        return consoleFail(
          "CONSOLE_CONFIRM_REQUIRED",
          "该命令可能造成破坏，需要二次确认",
          false,
          { confirmToken: token, reasons: dangerReasons },
        );
      }
      const confirmation = this.confirmations.get(input.confirmToken);
      if (
        !confirmation ||
        confirmation.workspaceId !== workspaceId ||
        confirmation.hash !== hash ||
        confirmation.expiresAt < this.options.now()
      ) {
        return consoleFail("CONSOLE_CONFIRM_INVALID", "确认已过期或命令发生变化，请重新确认");
      }
      this.confirmations.delete(input.confirmToken);
    }

    const active = [...this.sessions.values()].filter((item) =>
      ACTIVE_STATUSES.has(item.session.status),
    );
    if (
      active.filter((item) => item.session.workspaceId === workspaceId).length >=
        this.options.limits.activePerWorkspace ||
      active.length >= this.options.limits.activeGlobal
    ) {
      return consoleFail("CONSOLE_LIMIT", "后台任务已达上限，请先停止或关闭一个任务");
    }
    if (this.sessions.size >= this.options.limits.sessionsGlobal) {
      this.evictHistory(1);
      if (this.sessions.size >= this.options.limits.sessionsGlobal) {
        return consoleFail("CONSOLE_LIMIT", "后台任务总数已达上限");
      }
    }

    const now = this.options.now();
    const title =
      (input.title ?? "").trim().slice(0, this.options.limits.titleChars) ||
      command.split(/\r?\n/)[0]!.slice(0, 60);
    const session: ConsoleSession = {
      id: `con_${randomUUID()}`,
      workspaceId,
      title,
      command,
      cwd: cwdResult.value.absolute,
      cwdRelative: cwdResult.value.relative,
      source: "manual",
      status: "starting",
      pid: null,
      startedAt: iso(now),
      endedAt: null,
      durationMs: 0,
      exitCode: null,
      signal: null,
      seq: 0,
      bytes: 0,
      truncated: false,
      droppedBytes: 0,
      error: null,
    };
    const internal: InternalSession = {
      session,
      child: null,
      decoders: null,
      pending: { stdout: "", stderr: "" },
      flushTimer: null,
      killTimer: null,
      output: "",
      stopRequested: false,
      finalized: false,
    };
    this.sessions.set(session.id, internal);
    this.evictHistory();
    this.emitStatus(internal);
    this.spawn(internal, root);
    return consoleOk(this.view(internal));
  }

  stop(workspaceId: string, sessionId: string): ConsoleResult<ConsoleSession> {
    const internal = this.find(workspaceId, sessionId);
    if (!internal) return consoleFail("CONSOLE_SESSION_NOT_FOUND", "控制台会话不存在");
    if (!ACTIVE_STATUSES.has(internal.session.status)) {
      return consoleOk(this.view(internal));
    }
    if (internal.session.status === "stopping") {
      return consoleOk(this.view(internal));
    }
    internal.stopRequested = true;
    internal.session.status = "stopping";
    this.emitStatus(internal);
    this.terminate(internal, false);
    this.scheduleForceKill(internal);
    return consoleOk(this.view(internal));
  }

  input(workspaceId: string, sessionId: string, data: string): ConsoleResult<{ accepted: boolean }> {
    const internal = this.find(workspaceId, sessionId);
    if (!internal) return consoleFail("CONSOLE_SESSION_NOT_FOUND", "控制台会话不存在");
    if (internal.session.status !== "running" || !internal.child?.stdin) {
      return consoleFail("CONSOLE_NOT_RUNNING", "任务未在运行，无法写入 stdin");
    }
    if (typeof data !== "string" || !data || byteLength(data) > this.options.limits.stdinBytes) {
      return consoleFail("CONSOLE_COMMAND_INVALID", "stdin 为空或超过 4KB");
    }
    try {
      internal.child.stdin.write(data);
      return consoleOk({ accepted: true });
    } catch (error) {
      return consoleFail("CONSOLE_WRITE_FAILED", safeMessage(error), true);
    }
  }

  clear(workspaceId: string, sessionId: string): ConsoleResult<ConsoleSession> {
    const internal = this.find(workspaceId, sessionId);
    if (!internal) return consoleFail("CONSOLE_SESSION_NOT_FOUND", "控制台会话不存在");
    internal.output = "";
    internal.pending = { stdout: "", stderr: "" };
    if (internal.flushTimer) {
      clearTimeout(internal.flushTimer);
      internal.flushTimer = null;
    }
    internal.session.bytes = 0;
    internal.session.truncated = false;
    internal.session.droppedBytes = 0;
    internal.session.seq += 1;
    this.emit({
      type: "cleared",
      sessionId: internal.session.id,
      seq: internal.session.seq,
      session: this.view(internal),
    });
    return consoleOk(this.view(internal));
  }

  snapshot(workspaceId: string, sessionId: string): ConsoleResult<ConsoleSnapshot> {
    const internal = this.find(workspaceId, sessionId);
    if (!internal) return consoleFail("CONSOLE_SESSION_NOT_FOUND", "控制台会话不存在");
    this.flush(internal);
    const output = redactSecrets(internal.output);
    return consoleOk({
      session: this.view(internal),
      output,
      truncated: internal.session.truncated,
      droppedBytes: internal.session.droppedBytes,
      seq: internal.session.seq,
    });
  }

  async closeAll(): Promise<void> {
    const active = [...this.sessions.values()].filter((item) =>
      ACTIVE_STATUSES.has(item.session.status),
    );
    if (active.length === 0) return;
    for (const internal of active) {
      try {
        this.stop(internal.session.workspaceId, internal.session.id);
      } catch {
        // 退出清理尽力而为
      }
    }
    const deadline = this.options.now() + this.options.limits.killGraceMs + 200;
    while (this.options.now() < deadline) {
      if (active.every((item) => !ACTIVE_STATUSES.has(item.session.status))) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    for (const internal of active) {
      if (ACTIVE_STATUSES.has(internal.session.status)) {
        this.finalize(internal, "stopped", internal.session.exitCode, internal.session.signal);
      }
    }
  }

  private workspaceRoot(workspaceId: string): string | null {
    if (!workspaceId) return null;
    try {
      const root = this.options.workspaceRoot(workspaceId);
      return root ? path.resolve(root) : null;
    } catch {
      return null;
    }
  }

  private resolveCwd(
    root: string,
    requested: string,
  ): ConsoleResult<{ absolute: string; relative: string }> {
    const value = String(requested ?? ".").trim() || ".";
    if (
      value.length > this.options.limits.cwdChars ||
      /[\u0000-\u001f\u007f]/.test(value) ||
      path.isAbsolute(value) ||
      path.win32.isAbsolute(value) ||
      /^[A-Za-z]:[\\/]/.test(value) ||
      value.split(/[\\/]+/).includes("..")
    ) {
      return consoleFail("CONSOLE_CWD_INVALID", "cwd 必须是工作区内的相对目录");
    }
    try {
      const realRoot = realpathSync(root);
      if (!statSync(realRoot).isDirectory()) {
        return consoleFail("CONSOLE_CWD_INVALID", "工作区根不是目录");
      }
      const resolved = path.resolve(realRoot, value);
      if (!inside(realRoot, resolved)) {
        return consoleFail("CONSOLE_CWD_INVALID", "cwd 越出工作区");
      }
      const real = realpathSync(resolved);
      if (!inside(realRoot, real)) {
        return consoleFail("CONSOLE_CWD_INVALID", "cwd 链接逃逸工作区");
      }
      if (!statSync(real).isDirectory()) {
        return consoleFail("CONSOLE_CWD_INVALID", "cwd 不是目录");
      }
      const relative = normalizeCwdRelative(path.relative(realRoot, real));
      return consoleOk({ absolute: real, relative });
    } catch (error) {
      return consoleFail("CONSOLE_CWD_INVALID", safeMessage(error));
    }
  }

  private spawn(internal: InternalSession, root: string): void {
    const platform = this.options.platform;
    const command =
      platform === "win32"
        ? { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", internal.session.command] }
        : { file: "/bin/sh", args: ["-lc", internal.session.command] };
    let child: ChildProcess;
    try {
      child = this.options.spawn(command.file, command.args, {
        cwd: internal.session.cwd,
        env: buildConsoleEnv(),
        shell: false,
        windowsHide: true,
        detached: platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.finalize(internal, "failed", null, null, safeMessage(error));
      return;
    }
    internal.child = child;
    internal.decoders = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    };
    internal.session.pid = child.pid ?? null;
    internal.session.status = "running";
    this.emitStatus(internal);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = internal.decoders!.stdout.write(chunk);
      if (text) this.appendOutput(internal, "stdout", text);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = internal.decoders!.stderr.write(chunk);
      if (text) this.appendOutput(internal, "stderr", text);
    });
    child.stdin?.on("error", () => {
      // 写入错误由 input 调用返回；这里避免未处理 stream error 崩溃。
    });
    child.on("error", (error) => {
      if (internal.finalized) return;
      this.finalize(internal, "failed", null, null, safeMessage(error));
    });
    child.on("exit", (code, signal) => {
      const status: ConsoleStatus = internal.stopRequested
        ? "stopped"
        : code === 0
          ? "exited"
          : "failed";
      this.finalize(internal, status, code, signal);
    });
  }

  private appendOutput(internal: InternalSession, stream: "stdout" | "stderr", text: string): void {
    const redacted = redactSecrets(text);
    if (!redacted) return;
    internal.output += redacted;
    internal.session.bytes = byteLength(internal.output);
    if (internal.session.bytes > this.options.limits.bufferBytes) {
      const before = internal.session.bytes;
      internal.output = tailText(internal.output, this.options.limits.bufferBytes);
      const after = byteLength(internal.output);
      internal.session.bytes = after;
      internal.session.truncated = true;
      internal.session.droppedBytes += Math.max(0, before - after);
    }
    this.queue(internal, stream, redacted);
  }

  private queue(internal: InternalSession, stream: "stdout" | "stderr", text: string): void {
    internal.pending[stream] += text;
    const pendingBytes = byteLength(internal.pending.stdout) + byteLength(internal.pending.stderr);
    if (pendingBytes >= this.options.limits.chunkBytes) {
      this.flush(internal);
      return;
    }
    if (!internal.flushTimer) {
      internal.flushTimer = setTimeout(() => {
        internal.flushTimer = null;
        this.flush(internal);
      }, this.options.limits.batchMs);
    }
  }

  private flush(internal: InternalSession): void {
    if (internal.flushTimer) {
      clearTimeout(internal.flushTimer);
      internal.flushTimer = null;
    }
    for (const stream of ["stdout", "stderr"] as const) {
      let pending = internal.pending[stream];
      if (!pending) continue;
      internal.pending[stream] = "";
      for (const data of splitUtf8(pending, this.options.limits.chunkBytes)) {
        if (!data) continue;
        internal.session.seq += 1;
        this.emit({
          type: "output",
          sessionId: internal.session.id,
          seq: internal.session.seq,
          stream,
          data,
          truncated: internal.session.truncated,
        });
      }
    }
  }

  private terminate(internal: InternalSession, force: boolean): void {
    const child = internal.child;
    const pid = internal.session.pid;
    if (!child && !pid) return;
    try {
      if (this.options.platform === "win32") {
        if (force && pid) {
          this.options.execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {});
        } else {
          child?.kill();
        }
      } else if (pid) {
        try {
          process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
        } catch {
          child?.kill(force ? "SIGKILL" : "SIGTERM");
        }
      } else {
        child?.kill(force ? "SIGKILL" : "SIGTERM");
      }
    } catch {
      // 进程可能已退出；exit 事件负责最终状态。
    }
  }

  private scheduleForceKill(internal: InternalSession): void {
    if (internal.killTimer) clearTimeout(internal.killTimer);
    internal.killTimer = setTimeout(() => {
      internal.killTimer = null;
      if (internal.finalized || !ACTIVE_STATUSES.has(internal.session.status)) return;
      this.terminate(internal, true);
      setTimeout(() => {
        if (!internal.finalized) {
          this.finalize(internal, "stopped", internal.session.exitCode, internal.session.signal);
        }
      }, 150);
    }, this.options.limits.killGraceMs);
  }

  private finalize(
    internal: InternalSession,
    status: ConsoleStatus,
    exitCode: number | null,
    signal: string | null,
    error?: string,
  ): void {
    if (internal.finalized) return;
    internal.finalized = true;
    if (internal.flushTimer) {
      clearTimeout(internal.flushTimer);
      internal.flushTimer = null;
    }
    if (internal.killTimer) {
      clearTimeout(internal.killTimer);
      internal.killTimer = null;
    }
    if (internal.decoders) {
      const stdoutTail = internal.decoders.stdout.end();
      const stderrTail = internal.decoders.stderr.end();
      if (stdoutTail) this.appendOutput(internal, "stdout", stdoutTail);
      if (stderrTail) this.appendOutput(internal, "stderr", stderrTail);
    }
    this.flush(internal);
    internal.session.status = status;
    internal.session.exitCode = exitCode;
    internal.session.signal = signal;
    internal.session.endedAt = iso(this.options.now());
    internal.session.error = error ? redactSecrets(error) : null;
    internal.child = null;
    this.emitStatus(internal);
    this.evictHistory();
  }

  private emitStatus(internal: InternalSession): void {
    this.emit({
      type: "status",
      sessionId: internal.session.id,
      seq: internal.session.seq,
      session: this.view(internal),
    });
  }

  private emit(event: ConsoleEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 事件监听器异常不能影响进程管理。
      }
    }
  }

  private find(workspaceId: string, sessionId: string): InternalSession | null {
    const internal = this.sessions.get(sessionId);
    if (!internal || internal.session.workspaceId !== workspaceId) return null;
    return internal;
  }

  private view(internal: InternalSession): ConsoleSession {
    const session = internal.session;
    const now = this.options.now();
    const ended = session.endedAt ? Date.parse(session.endedAt) : now;
    return {
      ...session,
      durationMs:
        session.status === "starting" || session.status === "running" || session.status === "stopping"
          ? Math.max(0, now - Date.parse(session.startedAt))
          : Math.max(0, ended - Date.parse(session.startedAt)),
    };
  }

  private cleanupConfirmations(now: number): void {
    for (const [token, confirmation] of this.confirmations) {
      if (confirmation.expiresAt < now) this.confirmations.delete(token);
    }
  }

  private evictHistory(extraNeeded = 0): void {
    for (const workspaceId of new Set(
      [...this.sessions.values()].map((item) => item.session.workspaceId),
    )) {
      const history = [...this.sessions.values()]
        .filter(
          (item) =>
            item.session.workspaceId === workspaceId &&
            !ACTIVE_STATUSES.has(item.session.status),
        )
        .sort((left, right) =>
          (left.session.endedAt ?? left.session.startedAt).localeCompare(
            right.session.endedAt ?? right.session.startedAt,
          ),
        );
      const limit = this.options.limits.historyPerWorkspace;
      while (history.length > limit) {
        const removed = history.shift();
        if (removed) this.sessions.delete(removed.session.id);
      }
    }
    const terminal = [...this.sessions.values()]
      .filter((item) => !ACTIVE_STATUSES.has(item.session.status))
      .sort((left, right) =>
        (left.session.endedAt ?? left.session.startedAt).localeCompare(
          right.session.endedAt ?? right.session.startedAt,
        ),
      );
    const target = Math.max(0, this.options.limits.sessionsGlobal - extraNeeded);
    while (this.sessions.size > target && terminal.length > 0) {
      const removed = terminal.shift();
      if (removed) this.sessions.delete(removed.session.id);
    }
  }
}
