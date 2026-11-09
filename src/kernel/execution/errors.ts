import type { KernelErrorCode } from "../../shared/types.js";

/** t68 内核领域错误：命令层把 code 暴露给服务/IPC，UI 可据此提示。 */
export class KernelError extends Error {
  readonly code: KernelErrorCode;
  readonly details?: unknown;

  constructor(code: KernelErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "KernelError";
    this.code = code;
    this.details = details;
  }
}

export function isTerminalTaskStatus(status: string): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

export function isActiveRunStatus(status: string): boolean {
  return status === "queued" || status === "running" || status === "waiting_human";
}
