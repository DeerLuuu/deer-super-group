import type { EventRecord, Run, Task, TaskStatus } from "../../shared/types.js";
import type { Store } from "../store.js";

/**
 * t68 投影：把内核事件应用到 tasks / runs 投影表。
 * 同一批事件既在命令事务内应用，也可在 rebuildProjections 中从事件重放。
 * 规则：投影函数必须幂等（重复应用同一事件结果不变）。
 */

const TASK_COLUMNS: Array<[keyof Task, string]> = [
  ["workspaceId", "workspace_id"],
  ["title", "title"],
  ["description", "description"],
  ["acceptance", "acceptance"],
  ["status", "status"],
  ["ownerId", "owner_id"],
  ["dependsOn", "depends_on"],
  ["branch", "branch"],
  ["worktree", "worktree"],
  ["summary", "summary"],
  ["createdAt", "created_at"],
  ["startedAt", "started_at"],
  ["endedAt", "ended_at"],
  ["priority", "priority"],
  ["queuedAt", "queued_at"],
  ["blockedReason", "blocked_reason"],
  ["failureKind", "failure_kind"],
  ["attemptCount", "attempt_count"],
  ["nextRunAt", "next_run_at"],
];

const RUN_COLUMNS: Array<[keyof Run, string]> = [
  ["taskId", "task_id"],
  ["agentId", "agent_id"],
  ["status", "status"],
  ["error", "error"],
  ["startedAt", "started_at"],
  ["endedAt", "ended_at"],
  ["tokenIn", "token_in"],
  ["tokenOut", "token_out"],
  ["attempt", "attempt"],
  ["modelProfileId", "model_profile_id"],
  ["modelId", "model_id"],
  ["permissionSnapshot", "permission_snapshot"],
  ["sandboxId", "sandbox_id"],
  ["retryOfRunId", "retry_of_run_id"],
  ["heartbeatAt", "heartbeat_at"],
  ["leaseOwner", "lease_owner"],
  ["leaseExpiresAt", "lease_expires_at"],
  ["checkpointRef", "checkpoint_ref"],
  ["checkpointStep", "checkpoint_step"],
  ["costUsd", "cost_usd"],
  ["errorCode", "error_code"],
  ["retryable", "retryable"],
  ["steps", "steps"],
];

function encodeValue(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as string | number;
}

export function upsertTaskProjection(store: Store, task: Task): void {
  const columns = TASK_COLUMNS.map(([, column]) => column);
  const placeholders = columns.map(() => "?").join(", ");
  const values = TASK_COLUMNS.map(([key]) => encodeValue(task[key]));
  store.db
    .prepare(
      `INSERT OR REPLACE INTO tasks (id, ${columns.join(", ")}) VALUES (?, ${placeholders})`,
    )
    .run(task.id, ...values);
}

export function patchTaskProjection(
  store: Store,
  id: string,
  patch: Record<string, unknown>,
): void {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  for (const [key, column] of TASK_COLUMNS) {
    if (!(key in patch)) continue;
    sets.push(`${column} = ?`);
    params.push(encodeValue(patch[key as string]));
  }
  if (!sets.length) return;
  params.push(id);
  store.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

export function upsertRunProjection(store: Store, run: Run): void {
  const columns = RUN_COLUMNS.map(([, column]) => column);
  const placeholders = columns.map(() => "?").join(", ");
  const values = RUN_COLUMNS.map(([key]) => encodeValue(run[key]));
  store.db
    .prepare(
      `INSERT OR REPLACE INTO runs (id, ${columns.join(", ")}) VALUES (?, ${placeholders})`,
    )
    .run(run.id, ...values);
}

export function patchRunProjection(
  store: Store,
  id: string,
  patch: Record<string, unknown>,
): void {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  for (const [key, column] of RUN_COLUMNS) {
    if (!(key in patch)) continue;
    sets.push(`${column} = ?`);
    params.push(encodeValue(patch[key as string]));
  }
  if (!sets.length) return;
  params.push(id);
  store.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 把一条内核事件应用到投影（幂等）。非内核事件忽略。 */
export function applyKernelEvent(store: Store, event: EventRecord): void {
  const payload = asRecord(event.payload) ?? {};
  switch (event.type) {
    case "kernel.legacy_snapshot": {
      const entity = payload.entity;
      const value = asRecord(payload.value);
      if (!value) return;
      if (entity === "task") upsertTaskProjection(store, value as unknown as Task);
      if (entity === "run") upsertRunProjection(store, value as unknown as Run);
      return;
    }
    case "task.created": {
      const task = asRecord(payload.task);
      if (task) upsertTaskProjection(store, task as unknown as Task);
      return;
    }
    case "task.updated": {
      const patch = asRecord(payload.patch);
      if (patch) patchTaskProjection(store, event.aggregateId, patch);
      return;
    }
    case "task.status_changed": {
      const to = payload.to;
      const patch = asRecord(payload.patch) ?? {};
      patchTaskProjection(store, event.aggregateId, {
        ...patch,
        ...(typeof to === "string" ? { status: to as TaskStatus } : {}),
      });
      return;
    }
    case "task.blocked":
      patchTaskProjection(store, event.aggregateId, {
        status: "blocked",
        blockedReason: payload.reason ?? "waiting_dependencies",
      });
      return;
    case "task.unblocked":
      patchTaskProjection(store, event.aggregateId, { status: "ready", blockedReason: null });
      return;
    case "task.retry_scheduled":
      patchTaskProjection(store, event.aggregateId, {
        nextRunAt: payload.nextRunAt ?? null,
        ...(typeof payload.attempt === "number" ? { attemptCount: payload.attempt } : {}),
      });
      return;
    case "task.retry_exhausted":
      patchTaskProjection(store, event.aggregateId, {
        status: "failed",
        failureKind: "retry_exhausted",
      });
      return;
    case "run.started": {
      const run = asRecord(payload.run);
      if (run) upsertRunProjection(store, run as unknown as Run);
      return;
    }
    case "run.heartbeat":
    case "run.checkpoint": {
      const patch = asRecord(payload.patch);
      if (patch) patchRunProjection(store, event.aggregateId, patch);
      return;
    }
    case "run.completed":
    case "run.failed":
    case "run.cancelled": {
      const patch = asRecord(payload.patch);
      if (patch) patchRunProjection(store, event.aggregateId, patch);
      return;
    }
    default:
      return;
  }
}

export interface ProjectionDigest {
  tasks: Record<TaskStatus, number>;
  runs: Record<string, number>;
  activeRuns: number;
  attemptsByTask: Record<string, number>;
}

const EMPTY_TASK_COUNTS = (): Record<TaskStatus, number> => ({
  ready: 0,
  queued: 0,
  running: 0,
  blocked: 0,
  review: 0,
  done: 0,
  failed: 0,
  cancelled: 0,
});

export function projectionDigest(store: Store, workspaceId?: string): ProjectionDigest {
  const tasks = EMPTY_TASK_COUNTS();
  const taskRows = (
    workspaceId
      ? store.db
          .prepare("SELECT status, COUNT(*) AS count FROM tasks WHERE workspace_id = ? GROUP BY status")
          .all(workspaceId)
      : store.db.prepare("SELECT status, COUNT(*) AS count FROM tasks GROUP BY status").all()
  ) as Array<{
    status?: string;
    count?: number;
  }>;
  for (const row of taskRows) {
    const status = String(row.status) as TaskStatus;
    if (status in tasks) tasks[status] = Number(row.count ?? 0);
  }
  const runs: Record<string, number> = {};
  const runRows = (
    workspaceId
      ? store.db
          .prepare(
            "SELECT r.status AS status, COUNT(*) AS count FROM runs r JOIN tasks t ON t.id = r.task_id WHERE t.workspace_id = ? GROUP BY r.status",
          )
          .all(workspaceId)
      : store.db.prepare("SELECT status, COUNT(*) AS count FROM runs GROUP BY status").all()
  ) as Array<{ status?: string; count?: number }>;
  for (const row of runRows) runs[String(row.status)] = Number(row.count ?? 0);
  const activeRow = (
    workspaceId
      ? store.db
          .prepare(
            "SELECT COUNT(*) AS count FROM runs r JOIN tasks t ON t.id = r.task_id WHERE t.workspace_id = ? AND r.status IN ('queued','running','waiting_human')",
          )
          .get(workspaceId)
      : store.db
          .prepare("SELECT COUNT(*) AS count FROM runs WHERE status IN ('queued','running','waiting_human')")
          .get()
  ) as { count?: number };
  const attemptRows = (
    workspaceId
      ? store.db
          .prepare(
            "SELECT r.task_id AS task_id, MAX(r.attempt) AS attempt FROM runs r JOIN tasks t ON t.id = r.task_id WHERE t.workspace_id = ? GROUP BY r.task_id",
          )
          .all(workspaceId)
      : store.db
          .prepare("SELECT task_id, MAX(attempt) AS attempt FROM runs GROUP BY task_id")
          .all()
  ) as Array<{ task_id?: string; attempt?: number }>;
  const attemptsByTask: Record<string, number> = {};
  for (const row of attemptRows) attemptsByTask[String(row.task_id)] = Number(row.attempt ?? 0);
  return { tasks, runs, activeRuns: Number(activeRow.count ?? 0), attemptsByTask };
}

/**
 * 从事件重建任务/运行投影：清空 tasks/runs，按 seq 重放全部内核事件。
 * 旧库的 kernel.legacy_snapshot 提供基线；旧事件中无法识别的类型被忽略。
 * 注意：仅重建 tasks/runs；agents/messages/board/settings 不在事件重建范围（显式边界）。
 */
export function rebuildProjections(store: Store): ProjectionDigest {
  return store.withTransaction(() => {
    store.db.exec("DELETE FROM runs; DELETE FROM tasks;");
    const events = store.listEvents({ limit: 2000 });
    for (const event of events) applyKernelEvent(store, event);
    return projectionDigest(store);
  });
}
