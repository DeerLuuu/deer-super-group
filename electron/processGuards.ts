import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

type ErrorLike = { code?: unknown; message?: unknown; cause?: unknown };

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as ErrorLike).code;
  if (typeof code === "string") return code;
  const cause = (error as ErrorLike).cause;
  return cause ? errorCode(cause) : null;
}

/** EPIPE/EIO/DESTROYED are expected when a parent closes the stdio pipe. */
export function isIgnorablePipeError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === "EPIPE" || code === "EIO" || code === "ERR_STREAM_DESTROYED") {
    return true;
  }
  if (error instanceof Error) {
    return /\bEPIPE\b|broken pipe|ERR_STREAM_DESTROYED/i.test(error.message);
  }
  return false;
}

export function formatGuardError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

type ProcessLike = {
  on(event: "uncaughtException", listener: (error: unknown) => void): unknown;
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  exit(code: number): void;
};

type ErrorStreamLike = {
  on(event: "error", listener: (error: unknown) => void): unknown;
};

export type ProcessGuardOptions = {
  logPath: string;
  process?: ProcessLike;
  stdout?: ErrorStreamLike;
  stderr?: ErrorStreamLike;
  now?: () => Date;
};

/**
 * Write one diagnostic line to the userData log. Never use console here:
 * console.* writes to the same broken pipe and would recurse into EPIPE.
 * A failed log write is intentionally silent.
 */
export function appendGuardLog(
  logPath: string,
  kind: string,
  error: unknown,
  now: () => Date = () => new Date(),
): boolean {
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    const timestamp = now().toISOString();
    appendFileSync(
      logPath,
      `[${timestamp}] ${kind}: ${formatGuardError(error)}\n`,
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Install process-level guards as early as possible in the Electron main
 * process. Pipe errors are recorded and ignored; non-pipe uncaught exceptions
 * are recorded and still terminate the process (fail fast, not silent).
 */
export function installProcessGuards(options: ProcessGuardOptions): void {
  const proc = options.process ?? process;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const record = (kind: string, error: unknown) => {
    appendGuardLog(options.logPath, kind, error, options.now);
  };

  const onStreamError = (streamName: "stdout" | "stderr") => (error: unknown) => {
    if (isIgnorablePipeError(error)) {
      record(`stream:${streamName}:pipe`, error);
      return;
    }
    record(`stream:${streamName}:error`, error);
  };
  stdout.on("error", onStreamError("stdout"));
  stderr.on("error", onStreamError("stderr"));

  proc.on("uncaughtException", (error: unknown) => {
    if (isIgnorablePipeError(error)) {
      record("uncaughtException:pipe", error);
      return;
    }
    record("uncaughtException", error);
    // Preserve fatal behavior for real bugs. No console write: stdout/stderr
    // may be the broken stream that caused the exception.
    proc.exit(1);
  });

  proc.on("unhandledRejection", (reason: unknown) => {
    if (isIgnorablePipeError(reason)) {
      record("unhandledRejection:pipe", reason);
      return;
    }
    record("unhandledRejection", reason);
  });
}
