import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redactSecrets } from "./gitExec.js";

const execFileAsync = promisify(execFile);

export interface ChecksRunOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  mode?: "shell" | "argv";
}

export interface ChecksRunResult {
  ok: boolean;
  state: "passed" | "failed";
  code: number | null;
  output: string;
  timeout: boolean;
}

function env(): NodeJS.ProcessEnv {
  const allowed: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "windir",
    "SystemDrive",
    "ComSpec",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "ProgramFiles",
    "ProgramFiles(x86)",
  ]) {
    const value = process.env[key];
    if (value) allowed[key] = value;
  }
  allowed.CI = "1";
  return allowed;
}

/**
 * Run the user-configured checks command. This is intentionally the only
 * shell-based executor: `checks_command` is trusted user input and may contain
 * `&&`. Agent/task content is never interpolated into it.
 */
export class ChecksRunner {
  async run(options: ChecksRunOptions): Promise<ChecksRunResult> {
    const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 1_800_000, 1_800_000));
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const argv =
      options.mode === "argv"
        ? options.command.split(/\s+/).filter(Boolean)
        : isWindows
          ? ["/d", "/s", "/c", `"${options.command}"`]
          : ["-lc", options.command];
    const executable = options.mode === "argv" ? (argv.shift() ?? "") : shell;
    try {
      const result = await execFileAsync(executable, argv, {
        cwd: options.cwd,
        env: env(),
        timeout: timeoutMs,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        windowsVerbatimArguments: isWindows && options.mode !== "argv",
      });
      return {
        ok: true,
        state: "passed",
        code: 0,
        output: redactSecrets([result.stdout, result.stderr].filter(Boolean).join("\n")).slice(0, 64 * 1024),
        timeout: false,
      };
    } catch (error) {
      const err = error as {
        code?: number | string;
        killed?: boolean;
        signal?: string;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      const timeout = Boolean(err.killed) || err.signal === "SIGTERM";
      return {
        ok: false,
        state: "failed",
        code: typeof err.code === "number" ? err.code : null,
        output: redactSecrets([err.stdout ?? "", err.stderr ?? err.message ?? "checks failed"].filter(Boolean).join("\n")).slice(0, 64 * 1024),
        timeout,
      };
    }
  }
}
