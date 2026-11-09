import { z } from "zod";

/**
 * t68/t83 事件注册表：内核写入的事件类型必须在此登记。
 * 旧代码（权限/工具/聊天）继续走 Store.appendEvent 的宽松路径；
 * 内核路径使用 assertKernelEventPayload 校验类型、版本、大小与 zod schema。
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
  "run.result_discarded",
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

export const KERNEL_EVENT_SCHEMA_VERSION = 2;
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;

const iso = z.string().min(1).max(64);
const shortText = z.string().min(1).max(500);
const optionalText = z.string().max(2_000).optional();
const record = z.record(z.string(), z.unknown());
const taskStatus = z.enum([
  "ready",
  "queued",
  "running",
  "review",
  "blocked",
  "done",
  "failed",
  "cancelled",
]);
const runStatus = z.enum([
  "queued",
  "running",
  "waiting_human",
  "completed",
  "failed",
  "cancelled",
]);

const taskSchema = z
  .object({
    id: z.string().min(1).max(200),
    workspaceId: z.string().min(1).max(200),
    title: z.string().min(1).max(2_000),
    status: taskStatus,
  })
  .passthrough();

const runSchema = z
  .object({
    id: z.string().min(1).max(200),
    taskId: z.string().min(1).max(200),
    agentId: z.string().min(1).max(200),
    status: runStatus,
  })
  .passthrough();

const taskPatch = z
  .object({
    status: taskStatus.optional(),
    summary: z.string().max(20_000).nullable().optional(),
    endedAt: iso.nullable().optional(),
    startedAt: iso.nullable().optional(),
    queuedAt: iso.nullable().optional(),
    nextRunAt: iso.nullable().optional(),
    failureKind: z.string().max(200).nullable().optional(),
    blockedReason: z.string().max(200).nullable().optional(),
    ownerId: z.string().max(200).nullable().optional(),
    attemptCount: z.number().int().min(0).max(1_000).optional(),
    dependsOn: z.array(z.string().max(200)).max(1_000).optional(),
    title: z.string().max(2_000).optional(),
    description: z.string().max(20_000).optional(),
    acceptance: z.array(z.string().max(2_000)).max(200).optional(),
    branch: z.string().max(500).nullable().optional(),
    worktree: z.string().max(2_000).nullable().optional(),
  })
  .passthrough();

const runPatch = z
  .object({
    status: runStatus.optional(),
    endedAt: iso.nullable().optional(),
    error: z.string().max(8_000).nullable().optional(),
    errorCode: z.string().max(200).nullable().optional(),
    retryable: z.boolean().optional(),
    tokenIn: z.number().int().min(0).max(1_000_000_000).optional(),
    tokenOut: z.number().int().min(0).max(1_000_000_000).optional(),
    steps: z.number().int().min(0).max(100_000).optional(),
    heartbeatAt: iso.optional(),
    leaseExpiresAt: iso.optional(),
    checkpointRef: z.string().max(2_000).nullable().optional(),
    checkpointStep: z.number().int().min(0).max(100_000).optional(),
  })
  .passthrough();

export interface KernelEventDefinition {
  version: number;
  schema: z.ZodType<unknown>;
  maxBytes: number;
}

const def = (
  schema: z.ZodType<unknown>,
  maxBytes = MAX_EVENT_PAYLOAD_BYTES,
): KernelEventDefinition => ({
  version: KERNEL_EVENT_SCHEMA_VERSION,
  schema,
  maxBytes,
});

export const EVENT_REGISTRY: Record<KernelEventType, KernelEventDefinition> = {
  "task.created": def(z.strictObject({ task: taskSchema })),
  "task.updated": def(z.strictObject({ patch: taskPatch })),
  "task.status_changed": def(
    z.strictObject({
      from: taskStatus,
      to: taskStatus,
      reason: shortText,
      runId: z.string().max(200).optional(),
      patch: taskPatch.optional(),
    }),
  ),
  "task.blocked": def(
    z.strictObject({
      reason: shortText,
      previousReason: shortText.optional(),
    }),
  ),
  "task.unblocked": def(z.strictObject({ reason: shortText.optional() })),
  "task.review_requested": def(
    z.strictObject({ runId: z.string().max(200), policy: z.enum(["auto", "required"]) }),
  ),
  "task.review_approved": def(
    z.strictObject({ reviewer: z.string().max(200).optional(), notes: optionalText }),
  ),
  "task.review_rejected": def(
    z.strictObject({ reviewer: z.string().max(200).optional(), notes: optionalText }),
  ),
  "task.retry_scheduled": def(
    z.strictObject({
      attempt: z.number().int().min(1).max(100),
      nextRunAt: iso,
      errorCode: z.string().max(200).optional(),
      reason: z.string().max(200).optional(),
    }),
  ),
  "task.retry_exhausted": def(
    z.strictObject({
      attempts: z.number().int().min(1).max(100),
      lastErrorCode: z.string().max(200).optional(),
    }),
  ),
  "task.cancelled": def(z.strictObject({ reason: shortText })),
  "run.started": def(z.strictObject({ run: runSchema })),
  "run.heartbeat": def(z.strictObject({ patch: runPatch })),
  "run.checkpoint": def(
    z.strictObject({
      checkpointRef: z.string().max(2_000),
      checkpointStep: z.number().int().min(0).max(100_000),
      patch: runPatch.optional(),
    }),
  ),
  "run.waiting_human": def(
    z.strictObject({ reason: shortText, patch: runPatch.optional() }),
  ),
  "run.resumed": def(z.strictObject({ reason: shortText.optional(), patch: runPatch.optional() })),
  "run.completed": def(z.strictObject({ patch: runPatch })),
  "run.failed": def(z.strictObject({ patch: runPatch })),
  "run.cancelled": def(z.strictObject({ reason: shortText, patch: runPatch })),
  "run.result_discarded": def(
    z.strictObject({
      runId: z.string().min(1).max(200),
      action: z.enum([
        "heartbeat",
        "checkpoint",
        "enter_waiting_human",
        "resume",
        "complete",
        "fail",
      ]),
      owner: z.string().max(200).nullable(),
      reason: shortText.optional(),
    }),
  ),
  "scheduler.paused": def(z.strictObject({ reason: shortText })),
  "scheduler.resumed": def(z.strictObject({})),
  "scheduler.admitted": def(
    z.strictObject({
      taskId: z.string().max(200),
      runId: z.string().max(200),
      attempt: z.number().int().min(1).max(100),
    }),
  ),
  "scheduler.rejected": def(z.strictObject({ taskId: z.string().max(200), reason: shortText })),
  "scheduler.tick": def(
    z.strictObject({
      counts: z.record(z.string().max(100), z.number().int().min(0)).optional(),
    }),
  ),
  "kernel.legacy_snapshot": def(
    z.strictObject({
      entity: z.enum(["task", "run"]),
      value: record,
    }),
  ),
  "kernel.migrated": def(
    z.strictObject({
      from: z.number().int().min(1),
      to: z.number().int().min(2),
    }),
  ),
  "kernel.recovered": def(
    z.strictObject({
      runId: z.string().max(200).optional(),
      taskId: z.string().max(200).optional(),
      action: shortText,
      attempt: z.number().int().min(0).max(100).optional(),
      source: z.string().max(200).optional(),
    }),
  ),
  "kernel.rebuild": def(z.strictObject({ counts: record.optional() })),
  "kernel.command_rejected": def(
    z.strictObject({
      command: z.string().max(200),
      errorCode: z.string().max(200),
    }),
  ),
};

export function isKernelEventType(type: string): type is KernelEventType {
  return Object.prototype.hasOwnProperty.call(EVENT_REGISTRY, type);
}

export function assertKernelEventType(type: string): void {
  if (!isKernelEventType(type)) {
    throw new Error(`kernel event type is not registered: ${type}`);
  }
}

/** 校验类型、schemaVersion、payload 大小与 schema；失败抛出带原因的错误。 */
export function assertKernelEventPayload(
  type: string,
  payload: unknown,
  schemaVersion = KERNEL_EVENT_SCHEMA_VERSION,
): void {
  assertKernelEventType(type);
  const eventType = type as KernelEventType;
  const definition = EVENT_REGISTRY[eventType];
  if (
    !Number.isInteger(schemaVersion) ||
    schemaVersion < 1 ||
    schemaVersion > KERNEL_EVENT_SCHEMA_VERSION
  ) {
    throw new Error(`unsupported kernel event schemaVersion: ${schemaVersion}`);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`kernel event payload must be an object: ${type}`);
  }
  const raw = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(raw).length;
  if (bytes > definition.maxBytes) {
    throw new Error(
      `kernel event payload too large: ${type} (${bytes} > ${definition.maxBytes} bytes)`,
    );
  }
  const parsed = definition.schema.safeParse(payload);
  if (!parsed.success) {
    const issues = (
      parsed.error.issues as Array<{ path: Array<string | number>; message: string }>
    )
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid kernel event payload: ${type}: ${issues}`);
  }
}
