import { createHash } from "node:crypto";

export const MAX_TASK_DEPENDENCIES = 100;

export type TaskGraphErrorCode =
  | "TASK_NOT_FOUND"
  | "TASK_OWNER_NOT_FOUND"
  | "TASK_OWNER_WORKSPACE_MISMATCH"
  | "TASK_DEPENDENCY_NOT_FOUND"
  | "TASK_DEPENDENCY_WORKSPACE_MISMATCH"
  | "TASK_DEPENDENCY_SELF"
  | "TASK_DEPENDENCY_DUPLICATE"
  | "TASK_DEPENDENCY_CYCLE"
  | "TASK_DEPENDENCY_LIMIT"
  | "TASK_HAS_DEPENDENTS";

export class TaskGraphError extends Error {
  readonly code: TaskGraphErrorCode;

  constructor(code: TaskGraphErrorCode, message: string) {
    super(message);
    this.name = "TaskGraphError";
    this.code = code;
  }
}

function hashIds(ids: readonly string[]): string {
  return createHash("sha1").update(JSON.stringify(ids)).digest("hex").slice(0, 20);
}

export function taskOwnerIdempotencyKey(
  taskId: string,
  from: string | null,
  to: string | null,
): string {
  return `task:${taskId}:owner:${from ?? "none"}:${to ?? "none"}`;
}

export function taskDependenciesIdempotencyKey(
  taskId: string,
  from: readonly string[],
  to: readonly string[],
): string {
  return `task:${taskId}:deps:${hashIds(from)}:${hashIds(to)}`;
}
