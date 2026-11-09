import type { Id } from "./types.js";

/** t144：看门狗/成本共享类型（main/preload/renderer 共用）。 */

export type WatchdogErrorCode =
  | "WATCHDOG_DISABLED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_INPUT"
  | "INTERNAL";

export type WatchdogResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: WatchdogErrorCode; message: string; details?: unknown } };

export type WatchdogSignalKind =
  | "heartbeat_stale"
  | "task_timeout"
  | "repeat_tool"
  | "no_progress"
  | "error_streak"
  | "token_burn"
  | "provider_quota"
  | "budget_soft"
  | "budget_hard"
  | "deadman";

export type WatchdogSeverity = "info" | "warning" | "critical";
export type WatchdogAlertStatus = "open" | "acked" | "resolved";
export type WatchdogInterventionLevel = "nudge" | "pause" | "fallback" | "member" | "human";
export type WatchdogInterventionStatus = "started" | "applied" | "skipped" | "failed";
export type WatchdogHoldReason = "watchdog" | "budget" | "escalation";
export type BudgetScope = "task" | "agent" | "workspace" | "global";

export interface WatchdogAlert {
  id: Id;
  workspaceId: Id;
  taskId: Id | null;
  runId: Id | null;
  kind: WatchdogSignalKind;
  severity: WatchdogSeverity;
  status: WatchdogAlertStatus;
  title: string;
  detail: Record<string, unknown>;
  dedupeKey: string;
  createdAt: string;
  ackedAt: string | null;
  resolvedAt: string | null;
  actor: string | null;
}

export interface WatchdogIntervention {
  id: Id;
  workspaceId: Id;
  taskId: Id;
  runId: Id | null;
  level: WatchdogInterventionLevel;
  action: string;
  reason: string;
  autoIndex: number;
  status: WatchdogInterventionStatus;
  handoffId: Id | null;
  detail: Record<string, unknown>;
  createdAt: string;
  appliedAt: string | null;
}

export interface WatchdogTaskState {
  workspaceId: Id;
  taskId: Id;
  autoInterventions: number;
  nudgeCount: number;
  updatedAt: string;
}

export interface WatchdogHold {
  taskId: Id;
  workspaceId: Id;
  reason: WatchdogHoldReason;
  scope: BudgetScope;
  createdAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
}

export interface RunHandoff {
  id: Id;
  workspaceId: Id;
  taskId: Id;
  runId: Id;
  attempt: number;
  reason: "pause" | "fallback" | "member_switch" | "manual";
  summary: string;
  nextStep: string;
  files: string[];
  diffStat: string;
  diffRef: string | null;
  lastEventSeq: number;
  fromModelProfileId: string | null;
  toModelProfileId: string | null;
  fromAgentId: Id;
  toAgentId: Id | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface ModelPriceSnapshot {
  currency: "USD";
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M?: number;
  reasoningPer1M?: number;
  version: string;
}

export interface CostLedgerEntry {
  id: Id;
  workspaceId: Id;
  taskId: Id;
  runId: Id;
  agentId: Id;
  modelProfileId: string | null;
  modelId: string | null;
  providerId: string | null;
  priceSnapshot: ModelPriceSnapshot | null;
  pricingKnown: boolean;
  tokenIn: number;
  tokenOut: number;
  cachedTokenIn: number;
  costMicroUsd: number;
  costUsd: number;
  kind: "provisional" | "final" | "adjustment";
  periodDay: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface BudgetSnapshot {
  task: { taskId: Id | null; spentUsd: number; limitUsd: number; ratio: number };
  agentDay: { agentId: Id | null; spentUsd: number; limitUsd: number; ratio: number };
  workspaceDay: { spentUsd: number; limitUsd: number; ratio: number };
  softRatio: number;
  hardAction: "pause" | "stop";
  pricingKnown: boolean;
}

export interface FallbackChain {
  workspaceId: Id;
  agentId: Id | null;
  models: string[];
  maxSwitches: number;
  onQuota: boolean;
  onErrors: boolean;
}

export interface CostSnapshot {
  workspaceId: Id;
  day: string;
  totals: { usd: number; known: boolean; runs: number };
  byAgent: Array<{ agentId: Id; usd: number }>;
  byTask: Array<{ taskId: Id; usd: number }>;
  recent: CostLedgerEntry[];
  budgets: BudgetSnapshot;
}

export interface WatchdogHealth {
  lastTickAt: string | null;
  lastPatrolAt: string | null;
  stale: boolean;
  enabled: boolean;
  deadman: boolean;
}

export interface WatchdogSnapshot {
  workspaceId: Id;
  enabled: boolean;
  deadman: boolean;
  pausedBy: WatchdogHoldReason | null;
  health: WatchdogHealth;
  alerts: WatchdogAlert[];
  interventions: WatchdogIntervention[];
  holds: WatchdogHold[];
  budgets: BudgetSnapshot;
  fallback: FallbackChain;
  updatedAt: string;
}

export interface SetBudgetInput {
  workspaceId: Id;
  scope: BudgetScope;
  scopeId: Id;
  limitUsd: number;
  softRatio?: number;
  hardAction?: "pause" | "stop";
}

export interface SetFallbackChainInput {
  workspaceId: Id;
  agentId?: Id | null;
  models: string[];
  maxSwitches?: number;
  onQuota?: boolean;
  onErrors?: boolean;
}

export interface WatchdogApi {
  getWatchdogSnapshot(workspaceId: Id): Promise<WatchdogResult<WatchdogSnapshot>>;
  getWatchdogCosts(workspaceId: Id): Promise<WatchdogResult<CostSnapshot>>;
  getRunHandoff(workspaceId: Id, runId: Id): Promise<WatchdogResult<RunHandoff | null>>;
  ackWatchdogAlert(workspaceId: Id, alertId: Id): Promise<WatchdogResult<WatchdogAlert>>;
  resolveWatchdogAlert(workspaceId: Id, alertId: Id): Promise<WatchdogResult<WatchdogAlert>>;
  releaseWatchdogTaskHold(workspaceId: Id, taskId: Id): Promise<WatchdogResult<void>>;
  setWatchdogBudget(input: SetBudgetInput): Promise<WatchdogResult<BudgetSnapshot>>;
  setWatchdogFallback(input: SetFallbackChainInput): Promise<WatchdogResult<FallbackChain>>;
  getWatchdogHealth(): Promise<WatchdogHealth>;
}
