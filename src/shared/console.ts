import { z } from "zod";

/** t447/G12 后台控制台共享契约：仅类型/常量/zod，渲染层与主进程都可导入。 */

export const CONSOLE_LIMITS = {
  activePerWorkspace: 6,
  activeGlobal: 12,
  historyPerWorkspace: 20,
  sessionsGlobal: 32,
  bufferBytes: 2 * 1024 * 1024,
  chunkBytes: 16 * 1024,
  batchMs: 50,
  stdinBytes: 4 * 1024,
  commandChars: 4096,
  titleChars: 80,
  cwdChars: 260,
  confirmTtlMs: 60_000,
  killGraceMs: 3_000,
  tailBytes: 256 * 1024,
  tailLines: 2_000,
} as const;

export type ConsoleStatus =
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "failed"
  | "stopped";

export type ConsoleSource = "manual";

export interface ConsoleSession {
  id: string;
  workspaceId: string;
  title: string;
  command: string;
  /** 绝对 cwd（受 workspace 根限制）。 */
  cwd: string;
  /** "." 或相对 workspace 的子目录。 */
  cwdRelative: string;
  source: ConsoleSource;
  status: ConsoleStatus;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  seq: number;
  bytes: number;
  truncated: boolean;
  droppedBytes: number;
  error: string | null;
}

export interface ConsoleOutputEvent {
  type: "output";
  sessionId: string;
  seq: number;
  stream: "stdout" | "stderr";
  data: string;
  truncated: boolean;
}

export interface ConsoleStatusEvent {
  type: "status";
  sessionId: string;
  seq: number;
  session: ConsoleSession;
}

export interface ConsoleClearedEvent {
  type: "cleared";
  sessionId: string;
  seq: number;
  session: ConsoleSession;
}

export type ConsoleEvent = ConsoleOutputEvent | ConsoleStatusEvent | ConsoleClearedEvent;

export type ConsoleErrorCode =
  | "CONSOLE_WORKSPACE_MISSING"
  | "CONSOLE_SESSION_NOT_FOUND"
  | "CONSOLE_LIMIT"
  | "CONSOLE_CWD_INVALID"
  | "CONSOLE_COMMAND_INVALID"
  | "CONSOLE_CONFIRM_REQUIRED"
  | "CONSOLE_CONFIRM_INVALID"
  | "CONSOLE_ELEVATION_REJECTED"
  | "CONSOLE_SPAWN_FAILED"
  | "CONSOLE_NOT_RUNNING"
  | "CONSOLE_WRITE_FAILED"
  | "CONSOLE_STOP_FAILED"
  | "CONSOLE_OUTPUT_TRUNCATED"
  | "CONSOLE_INTERNAL";

export interface ConsoleError {
  code: ConsoleErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type ConsoleResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ConsoleError };

export interface ConsoleSnapshot {
  session: ConsoleSession;
  output: string;
  truncated: boolean;
  droppedBytes: number;
  seq: number;
}

export interface ConsoleStartInput {
  command: string;
  title?: string;
  cwd?: string;
  confirmToken?: string;
}

export interface ConsoleCwdOption {
  relative: string;
  absolute: string;
}

const idSchema = z.string().trim().min(1).max(200);
const commandSchema = z.string().min(1).max(CONSOLE_LIMITS.commandChars);
const titleSchema = z.string().max(CONSOLE_LIMITS.titleChars).optional();
const cwdSchema = z.string().max(CONSOLE_LIMITS.cwdChars).optional();
const confirmSchema = z.string().max(200).optional();
const inputDataSchema = z.string().max(CONSOLE_LIMITS.stdinBytes);

export const consoleWorkspaceSchema = z.object({ workspaceId: idSchema }).strict();

export const consoleStartSchema = z
  .object({
    workspaceId: idSchema,
    command: commandSchema,
    title: titleSchema,
    cwd: cwdSchema,
    confirmToken: confirmSchema,
  })
  .strict();

export const consoleSessionSchema = z.object({ workspaceId: idSchema, sessionId: idSchema }).strict();

export const consoleInputSchema = consoleSessionSchema
  .extend({ data: inputDataSchema })
  .strict();

export type ConsoleParsedStart = z.infer<typeof consoleStartSchema>;
export type ConsoleParsedSession = z.infer<typeof consoleSessionSchema>;
export type ConsoleParsedInput = z.infer<typeof consoleInputSchema>;

export function consoleError(
  code: ConsoleErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, unknown>,
): ConsoleError {
  return { code, message, retryable, ...(details ? { details } : {}) };
}

export function consoleFail(
  code: ConsoleErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, unknown>,
): ConsoleResult<never> {
  return { ok: false, error: consoleError(code, message, retryable, details) };
}

export function consoleOk<T>(value: T): ConsoleResult<T> {
  return { ok: true, value };
}

export function consoleErrorSummary(code: ConsoleErrorCode): string {
  switch (code) {
    case "CONSOLE_WORKSPACE_MISSING":
      return "工作区不存在或已关闭";
    case "CONSOLE_SESSION_NOT_FOUND":
      return "控制台会话不存在";
    case "CONSOLE_LIMIT":
      return "后台任务已达上限，请先停止或关闭一个任务";
    case "CONSOLE_CWD_INVALID":
      return "工作目录必须在当前工作区内";
    case "CONSOLE_COMMAND_INVALID":
      return "命令为空、含非法字符或过长";
    case "CONSOLE_CONFIRM_REQUIRED":
      return "该命令可能造成破坏，需要二次确认";
    case "CONSOLE_CONFIRM_INVALID":
      return "确认已过期或命令发生变化，请重新确认";
    case "CONSOLE_ELEVATION_REJECTED":
      return "不支持提权/管理员命令（不会请求 UAC）";
    case "CONSOLE_SPAWN_FAILED":
      return "启动命令失败";
    case "CONSOLE_NOT_RUNNING":
      return "任务未在运行，无法写入 stdin";
    case "CONSOLE_WRITE_FAILED":
      return "写入 stdin 失败";
    case "CONSOLE_STOP_FAILED":
      return "停止任务失败";
    case "CONSOLE_OUTPUT_TRUNCATED":
      return "输出超过上限，仅保留尾部";
    case "CONSOLE_INTERNAL":
      return "控制台内部错误";
  }
}
