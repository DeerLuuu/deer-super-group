import { z } from "zod";

/** t144：watchdog/cost 事件独立 registry（与内核 KERNEL_EVENT_TYPES 分离）。 */
export const WATCHDOG_EVENT_TYPES = [
  "watchdog.tick",
  "watchdog.signal",
  "watchdog.nudged",
  "watchdog.paused",
  "watchdog.resumed",
  "watchdog.escalated",
  "watchdog.alert_acknowledged",
  "watchdog.intervention_skipped",
  "watchdog.deadman",
  "watchdog.migration_failed",
  "watchdog.rebuild_mismatch",
  "run.handoff_created",
  "run.model_fallback",
  "run.member_switched",
  "cost.provisional",
  "cost.recorded",
  "cost.budget_warning",
  "cost.budget_exceeded",
  "cost.budget_hold",
  "cost.budget_released",
  "cost.budget_changed",
  "provider.quota_error",
  "provider.cooldown_started",
  "provider.cooldown_ended",
] as const;

export type WatchdogEventType = (typeof WATCHDOG_EVENT_TYPES)[number];

export const WATCHDOG_EVENT_SCHEMA_VERSION = 2;
export const MAX_WATCHDOG_PAYLOAD_BYTES = 60 * 1024;

const text = z.string().min(1).max(500);
const optionalText = z.string().max(2_000).optional();
const iso = z.string().min(1).max(64);
const record = z.record(z.string(), z.unknown());
const signal = z.enum([
  "heartbeat_stale",
  "task_timeout",
  "repeat_tool",
  "no_progress",
  "error_streak",
  "token_burn",
  "provider_quota",
  "budget_soft",
  "budget_hard",
  "deadman",
]);
const severity = z.enum(["info", "warning", "critical"]);
const interventionLevel = z.enum(["nudge", "pause", "fallback", "member", "human"]);
const budgetScope = z.enum(["task", "agent", "workspace", "global"]);

const def = (schema: z.ZodType<unknown>) => ({ version: 2, schema, maxBytes: MAX_WATCHDOG_PAYLOAD_BYTES });

export const WATCHDOG_EVENT_REGISTRY: Record<WatchdogEventType, ReturnType<typeof def>> = {
  "watchdog.tick": def(z.strictObject({ workspaceId: z.string().max(200), at: iso })),
  "watchdog.signal": def(
    z.strictObject({
      kind: signal,
      severity,
      taskId: z.string().max(200).optional(),
      runId: z.string().max(200).optional(),
      evidence: record.optional(),
      windowMs: z.number().int().min(0).max(86_400_000).optional(),
    }),
  ),
  "watchdog.nudged": def(
    z.strictObject({
      taskId: z.string().max(200),
      runId: z.string().max(200).optional(),
      reason: text,
      nudgeCount: z.number().int().min(0).max(100).optional(),
    }),
  ),
  "watchdog.paused": def(
    z.strictObject({
      taskId: z.string().max(200),
      runId: z.string().max(200).optional(),
      reason: text,
      handoffId: z.string().max(200).optional(),
      scope: budgetScope.optional(),
    }),
  ),
  "watchdog.resumed": def(
    z.strictObject({ taskId: z.string().max(200), actor: z.string().max(200).optional() }),
  ),
  "watchdog.escalated": def(
    z.strictObject({
      taskId: z.string().max(200),
      runId: z.string().max(200).optional(),
      reason: text,
      autoInterventions: z.number().int().min(0).max(100),
    }),
  ),
  "watchdog.alert_acknowledged": def(
    z.strictObject({
      alertId: z.string().max(200),
      taskId: z.string().max(200).optional(),
      actor: z.string().max(200).optional(),
    }),
  ),
  "watchdog.intervention_skipped": def(
    z.strictObject({
      taskId: z.string().max(200),
      level: interventionLevel,
      reason: text,
    }),
  ),
  "watchdog.deadman": def(
    z.strictObject({
      workspaceId: z.string().max(200),
      lastTickAt: iso.nullable(),
      gapMs: z.number().int().min(0),
    }),
  ),
  "watchdog.migration_failed": def(z.strictObject({ error: text })),
  "watchdog.rebuild_mismatch": def(z.strictObject({ expected: record.optional(), actual: record.optional() })),
  "run.handoff_created": def(
    z.strictObject({
      handoffId: z.string().max(200),
      runId: z.string().max(200),
      taskId: z.string().max(200),
      reason: text,
      files: z.array(z.string().max(2_000)).max(100).optional(),
      diffStatHash: z.string().max(200).optional(),
    }),
  ),
  "run.model_fallback": def(
    z.strictObject({
      transferId: z.string().max(200).optional(),
      runId: z.string().max(200),
      taskId: z.string().max(200),
      fromModelProfileId: z.string().max(200).nullable(),
      toModelProfileId: z.string().max(200),
      reason: text,
      handoffId: z.string().max(200).optional(),
    }),
  ),
  "run.member_switched": def(
    z.strictObject({
      runId: z.string().max(200),
      taskId: z.string().max(200),
      fromAgentId: z.string().max(200),
      toAgentId: z.string().max(200),
      reason: text,
      handoffId: z.string().max(200).optional(),
    }),
  ),
  "cost.provisional": def(
    z.strictObject({
      runId: z.string().max(200),
      taskId: z.string().max(200),
      costMicroUsd: z.number().int().min(0),
      tokenIn: z.number().int().min(0),
      tokenOut: z.number().int().min(0),
      pricingKnown: z.boolean(),
    }),
  ),
  "cost.recorded": def(
    z.strictObject({
      runId: z.string().max(200),
      taskId: z.string().max(200),
      agentId: z.string().max(200),
      kind: z.enum(["final", "adjustment"]),
      costMicroUsd: z.number().int().min(0),
      costUsd: z.number().min(0),
      pricingKnown: z.boolean(),
      priceVersion: z.string().max(200).optional(),
    }),
  ),
  "cost.budget_warning": def(
    z.strictObject({
      scope: budgetScope,
      scopeId: z.string().max(200),
      spentUsd: z.number().min(0),
      limitUsd: z.number().min(0),
      ratio: z.number().min(0),
    }),
  ),
  "cost.budget_exceeded": def(
    z.strictObject({
      scope: budgetScope,
      scopeId: z.string().max(200),
      spentUsd: z.number().min(0),
      limitUsd: z.number().min(0),
      ratio: z.number().min(0),
      action: z.enum(["pause", "stop"]),
    }),
  ),
  "cost.budget_hold": def(
    z.strictObject({ taskId: z.string().max(200), scope: budgetScope, reason: text }),
  ),
  "cost.budget_released": def(
    z.strictObject({ taskId: z.string().max(200), scope: budgetScope, actor: z.string().max(200).optional() }),
  ),
  "cost.budget_changed": def(
    z.strictObject({ workspaceId: z.string().max(200), scope: budgetScope, scopeId: z.string().max(200), limitUsd: z.number().min(0) }),
  ),
  "provider.quota_error": def(
    z.strictObject({
      providerId: z.string().max(200),
      modelId: z.string().max(200),
      code: z.string().max(100),
      resetAt: iso.optional(),
    }),
  ),
  "provider.cooldown_started": def(
    z.strictObject({
      providerId: z.string().max(200),
      modelId: z.string().max(200),
      until: iso,
      reason: text,
    }),
  ),
  "provider.cooldown_ended": def(
    z.strictObject({ providerId: z.string().max(200), modelId: z.string().max(200) }),
  ),
};

export function assertWatchdogEvent(type: string, payload: unknown): void {
  const definition = WATCHDOG_EVENT_REGISTRY[type as WatchdogEventType];
  if (!definition) throw new Error(`watchdog event type is not registered: ${type}`);
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`watchdog event payload must be an object: ${type}`);
  }
  const raw = JSON.stringify(payload);
  if (new TextEncoder().encode(raw).length > definition.maxBytes) {
    throw new Error(`watchdog event payload too large: ${type}`);
  }
  const parsed = definition.schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `invalid watchdog event payload: ${type}: ${parsed.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
}
