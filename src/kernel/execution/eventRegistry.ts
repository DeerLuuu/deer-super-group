/**
 * t68 事件注册表：内核写入的事件类型必须在此登记。
 * 旧代码（权限/工具/聊天）继续走 Store.appendEvent 的宽松路径；
 * 内核路径使用 assertKernelEventType 拒绝未知类型，避免脏事件进入重建。
 */
export const KERNEL_EVENT_TYPES = [
  "task.created",
  "task.updated",
  "task.status_changed",
  "task.blocked",
  "task.unblocked",
  "task.review_requested",
  "task.review_approved",
  "task.review_rejected",
  "task.retry_scheduled",
  "task.retry_exhausted",
  "task.cancelled",
  "run.started",
  "run.heartbeat",
  "run.checkpoint",
  "run.waiting_human",
  "run.resumed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "scheduler.paused",
  "scheduler.resumed",
  "scheduler.admitted",
  "scheduler.rejected",
  "scheduler.tick",
  "kernel.legacy_snapshot",
  "kernel.migrated",
  "kernel.recovered",
  "kernel.rebuild",
  "kernel.command_rejected",
] as const;

export type KernelEventType = (typeof KERNEL_EVENT_TYPES)[number];

const KERNEL_EVENT_SET = new Set<string>(KERNEL_EVENT_TYPES);

export function isKernelEventType(type: string): type is KernelEventType {
  return KERNEL_EVENT_SET.has(type);
}

export function assertKernelEventType(type: string): void {
  if (!KERNEL_EVENT_SET.has(type)) {
    throw new Error(`kernel event type is not registered: ${type}`);
  }
}

/** 事件 payload 必须是对象（数组/标量不允许）。 */
export function assertKernelEventPayload(type: string, payload: unknown): void {
  assertKernelEventType(type);
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`kernel event payload must be an object: ${type}`);
  }
}
