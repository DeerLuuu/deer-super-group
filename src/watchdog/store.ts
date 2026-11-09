import { randomUUID } from "node:crypto";
import type { Store } from "../kernel/store.js";
import type { Clock } from "../kernel/execution/clock.js";
import type {
  BudgetScope,
  CostLedgerEntry,
  FallbackChain,
  ModelPriceSnapshot,
  RunHandoff,
  WatchdogAlert,
  WatchdogAlertStatus,
  WatchdogHold,
  WatchdogHoldReason,
  WatchdogIntervention,
  WatchdogInterventionLevel,
  WatchdogInterventionStatus,
  WatchdogSeverity,
  WatchdogSignalKind,
  WatchdogTaskState,
} from "../shared/watchdog.js";
import { assertWatchdogEvent } from "./events.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS watchdog_schema (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watchdog_state (
  workspace_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_tick_at TEXT,
  last_patrol_at TEXT,
  deadman_at TEXT,
  paused_by TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watchdog_alerts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acked_at TEXT,
  resolved_at TEXT,
  actor TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_watchdog_alert_open
  ON watchdog_alerts(dedupe_key) WHERE status='open';
CREATE TABLE IF NOT EXISTS watchdog_interventions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT,
  level TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  auto_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'started',
  handoff_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_watchdog_intervention_active
  ON watchdog_interventions(task_id) WHERE status='started';
CREATE TABLE IF NOT EXISTS watchdog_task_state (
  workspace_id TEXT NOT NULL,
  task_id TEXT PRIMARY KEY,
  auto_interventions INTEGER NOT NULL DEFAULT 0,
  nudge_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watchdog_holds (
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  released_at TEXT,
  released_by TEXT,
  PRIMARY KEY(task_id, reason, scope)
);
CREATE INDEX IF NOT EXISTS idx_watchdog_holds_active
  ON watchdog_holds(task_id) WHERE released_at IS NULL;
CREATE TABLE IF NOT EXISTS run_handoffs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  reason TEXT NOT NULL,
  summary TEXT NOT NULL,
  next_step TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  diff_stat TEXT NOT NULL DEFAULT '',
  diff_ref TEXT,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  from_model_profile_id TEXT,
  to_model_profile_id TEXT,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE TABLE IF NOT EXISTS cost_ledger (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  model_profile_id TEXT,
  model_id TEXT,
  provider_id TEXT,
  price_snapshot TEXT,
  pricing_known INTEGER NOT NULL DEFAULT 0,
  token_in INTEGER NOT NULL DEFAULT 0,
  token_out INTEGER NOT NULL DEFAULT 0,
  cached_token_in INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  period_day TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cost_run_final
  ON cost_ledger(run_id) WHERE kind='final';
CREATE UNIQUE INDEX IF NOT EXISTS ux_cost_run_kind
  ON cost_ledger(run_id, kind) WHERE kind IN ('provisional','final');
CREATE INDEX IF NOT EXISTS idx_cost_workspace_day
  ON cost_ledger(workspace_id, period_day);
CREATE INDEX IF NOT EXISTS idx_cost_agent_day
  ON cost_ledger(agent_id, period_day);
CREATE TABLE IF NOT EXISTS budget_limits (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  limit_micro_usd INTEGER NOT NULL DEFAULT 0,
  soft_ratio REAL NOT NULL DEFAULT 0.8,
  hard_action TEXT NOT NULL DEFAULT 'pause',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(scope, scope_id)
);
CREATE TABLE IF NOT EXISTS provider_cooldowns (
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL DEFAULT '*',
  until TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(provider_id, model_id)
);
CREATE TABLE IF NOT EXISTS watchdog_fallbacks (
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '*',
  models TEXT NOT NULL DEFAULT '[]',
  max_switches INTEGER NOT NULL DEFAULT 2,
  on_quota INTEGER NOT NULL DEFAULT 1,
  on_errors INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, agent_id)
);
`;

type Row = Record<string, unknown>;

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class WatchdogStore {
  readonly store: Store;
  readonly db: Store["db"];
  private readonly clock: Clock;

  constructor(store: Store, clock: Clock) {
    this.store = store;
    this.db = store.db;
    this.clock = clock;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(SCHEMA);
    const row = this.db.prepare("SELECT version FROM watchdog_schema WHERE version = 1").get() as
      | Row
      | undefined;
    if (!row) {
      this.db
        .prepare("INSERT OR IGNORE INTO watchdog_schema (version, applied_at) VALUES (1, ?)")
        .run(new Date(this.clock.now()).toISOString());
    }
  }

  nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  appendEvent(
    type: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): void {
    assertWatchdogEvent(type, payload);
    this.store.appendEvent({
      aggregateType,
      aggregateId,
      type,
      actor: "watchdog",
      payload,
      schemaVersion: 2,
      idempotencyKey: idempotencyKey ?? null,
    });
  }

  // ---------------------------------------------------------------- state

  ensureState(workspaceId: string): void {
    const now = this.nowIso();
    this.db
      .prepare(
        "INSERT INTO watchdog_state (workspace_id, enabled, updated_at) VALUES (?, 1, ?) ON CONFLICT(workspace_id) DO NOTHING",
      )
      .run(workspaceId, now);
  }

  getState(workspaceId: string): {
    workspaceId: string;
    enabled: boolean;
    lastTickAt: string | null;
    lastPatrolAt: string | null;
    deadmanAt: string | null;
    pausedBy: string | null;
  } {
    this.ensureState(workspaceId);
    const row = this.db.prepare("SELECT * FROM watchdog_state WHERE workspace_id = ?").get(workspaceId) as Row;
    return {
      workspaceId,
      enabled: Number(row.enabled) === 1,
      lastTickAt: row.last_tick_at == null ? null : String(row.last_tick_at),
      lastPatrolAt: row.last_patrol_at == null ? null : String(row.last_patrol_at),
      deadmanAt: row.deadman_at == null ? null : String(row.deadman_at),
      pausedBy: row.paused_by == null ? null : String(row.paused_by),
    };
  }

  markTick(workspaceId: string, nowIso: string): void {
    this.ensureState(workspaceId);
    this.db
      .prepare("UPDATE watchdog_state SET last_tick_at = ?, updated_at = ? WHERE workspace_id = ?")
      .run(nowIso, nowIso, workspaceId);
  }

  markPatrol(workspaceId: string, nowIso: string): void {
    this.ensureState(workspaceId);
    this.db
      .prepare("UPDATE watchdog_state SET last_patrol_at = ?, updated_at = ? WHERE workspace_id = ?")
      .run(nowIso, nowIso, workspaceId);
  }

  markDeadman(workspaceId: string, nowIso: string): void {
    this.ensureState(workspaceId);
    this.db
      .prepare("UPDATE watchdog_state SET deadman_at = ?, updated_at = ? WHERE workspace_id = ?")
      .run(nowIso, nowIso, workspaceId);
  }

  setPausedBy(workspaceId: string, pausedBy: string | null): void {
    this.ensureState(workspaceId);
    this.db
      .prepare("UPDATE watchdog_state SET paused_by = ?, updated_at = ? WHERE workspace_id = ?")
      .run(pausedBy, this.nowIso(), workspaceId);
  }

  // --------------------------------------------------------------- alerts

  createAlert(input: {
    workspaceId: string;
    taskId?: string | null;
    runId?: string | null;
    kind: WatchdogSignalKind;
    severity: WatchdogSeverity;
    title: string;
    detail?: Record<string, unknown>;
    dedupeKey: string;
  }): WatchdogAlert {
    const existing = this.db
      .prepare("SELECT * FROM watchdog_alerts WHERE dedupe_key = ? AND status = 'open'")
      .get(input.dedupeKey) as Row | undefined;
    if (existing) return this.toAlert(existing);
    const alert: WatchdogAlert = {
      id: newId("wda"),
      workspaceId: input.workspaceId,
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      kind: input.kind,
      severity: input.severity,
      status: "open",
      title: input.title,
      detail: input.detail ?? {},
      dedupeKey: input.dedupeKey,
      createdAt: this.nowIso(),
      ackedAt: null,
      resolvedAt: null,
      actor: null,
    };
    this.db
      .prepare(
        `INSERT INTO watchdog_alerts
         (id, workspace_id, task_id, run_id, kind, severity, status, title, detail, dedupe_key, created_at, acked_at, resolved_at, actor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      )
      .run(
        alert.id,
        alert.workspaceId,
        alert.taskId,
        alert.runId,
        alert.kind,
        alert.severity,
        alert.status,
        alert.title,
        JSON.stringify(alert.detail),
        alert.dedupeKey,
        alert.createdAt,
      );
    return alert;
  }

  listAlerts(workspaceId: string, limit = 50): WatchdogAlert[] {
    const rows = this.db
      .prepare("SELECT * FROM watchdog_alerts WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(workspaceId, limit) as Row[];
    return rows.map((row) => this.toAlert(row));
  }

  getAlert(workspaceId: string, id: string): WatchdogAlert | null {
    const row = this.db
      .prepare("SELECT * FROM watchdog_alerts WHERE id = ? AND workspace_id = ?")
      .get(id, workspaceId) as Row | undefined;
    return row ? this.toAlert(row) : null;
  }

  updateAlertStatus(
    workspaceId: string,
    id: string,
    status: WatchdogAlertStatus,
    actor?: string,
  ): WatchdogAlert | null {
    const now = this.nowIso();
    const row = this.db
      .prepare("SELECT * FROM watchdog_alerts WHERE id = ? AND workspace_id = ?")
      .get(id, workspaceId) as Row | undefined;
    if (!row) return null;
    this.db
      .prepare(
        "UPDATE watchdog_alerts SET status = ?, acked_at = COALESCE(acked_at, ?), resolved_at = ?, actor = COALESCE(?, actor) WHERE id = ? AND workspace_id = ?",
      )
      .run(
        status,
        status === "acked" ? now : null,
        status === "resolved" ? now : null,
        actor ?? null,
        id,
        workspaceId,
      );
    return this.getAlert(workspaceId, id);
  }

  resolveAlertsForTask(taskId: string): void {
    this.db
      .prepare(
        "UPDATE watchdog_alerts SET status='resolved', resolved_at=? WHERE task_id=? AND status != 'resolved'",
      )
      .run(this.nowIso(), taskId);
  }

  private toAlert(row: Row): WatchdogAlert {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      taskId: row.task_id == null ? null : String(row.task_id),
      runId: row.run_id == null ? null : String(row.run_id),
      kind: String(row.kind) as WatchdogSignalKind,
      severity: String(row.severity) as WatchdogSeverity,
      status: String(row.status) as WatchdogAlertStatus,
      title: String(row.title),
      detail: parseJson<Record<string, unknown>>(row.detail, {}),
      dedupeKey: String(row.dedupe_key),
      createdAt: String(row.created_at),
      ackedAt: row.acked_at == null ? null : String(row.acked_at),
      resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
      actor: row.actor == null ? null : String(row.actor),
    };
  }

  // ---------------------------------------------------------- interventions

  createIntervention(input: {
    workspaceId: string;
    taskId: string;
    runId?: string | null;
    level: WatchdogInterventionLevel;
    action: string;
    reason: string;
    autoIndex?: number;
    handoffId?: string | null;
    detail?: Record<string, unknown>;
  }): WatchdogIntervention {
    const intervention: WatchdogIntervention = {
      id: newId("wdi"),
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      runId: input.runId ?? null,
      level: input.level,
      action: input.action,
      reason: input.reason,
      autoIndex: input.autoIndex ?? 0,
      status: "started",
      handoffId: input.handoffId ?? null,
      detail: input.detail ?? {},
      createdAt: this.nowIso(),
      appliedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO watchdog_interventions
         (id, workspace_id, task_id, run_id, level, action, reason, auto_index, status, handoff_id, detail, created_at, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        intervention.id,
        intervention.workspaceId,
        intervention.taskId,
        intervention.runId,
        intervention.level,
        intervention.action,
        intervention.reason,
        intervention.autoIndex,
        intervention.status,
        intervention.handoffId,
        JSON.stringify(intervention.detail),
        intervention.createdAt,
      );
    return intervention;
  }

  updateIntervention(
    id: string,
    status: WatchdogInterventionStatus,
    patch?: { handoffId?: string | null; detail?: Record<string, unknown> },
  ): void {
    this.db
      .prepare(
        "UPDATE watchdog_interventions SET status = ?, applied_at = ?, handoff_id = COALESCE(?, handoff_id), detail = COALESCE(?, detail) WHERE id = ?",
      )
      .run(
        status,
        status === "applied" ? this.nowIso() : null,
        patch?.handoffId ?? null,
        patch?.detail ? JSON.stringify(patch.detail) : null,
        id,
      );
  }

  getActiveIntervention(taskId: string): WatchdogIntervention | null {
    const row = this.db
      .prepare("SELECT * FROM watchdog_interventions WHERE task_id = ? AND status = 'started' LIMIT 1")
      .get(taskId) as Row | undefined;
    return row ? this.toIntervention(row) : null;
  }

  listInterventions(workspaceId: string, limit = 50): WatchdogIntervention[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM watchdog_interventions WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(workspaceId, limit) as Row[];
    return rows.map((row) => this.toIntervention(row));
  }

  private toIntervention(row: Row): WatchdogIntervention {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      taskId: String(row.task_id),
      runId: row.run_id == null ? null : String(row.run_id),
      level: String(row.level) as WatchdogInterventionLevel,
      action: String(row.action),
      reason: String(row.reason),
      autoIndex: Number(row.auto_index ?? 0),
      status: String(row.status) as WatchdogInterventionStatus,
      handoffId: row.handoff_id == null ? null : String(row.handoff_id),
      detail: parseJson<Record<string, unknown>>(row.detail, {}),
      createdAt: String(row.created_at),
      appliedAt: row.applied_at == null ? null : String(row.applied_at),
    };
  }

  // ------------------------------------------------------------ task state

  getTaskState(workspaceId: string, taskId: string): WatchdogTaskState {
    const row = this.db.prepare("SELECT * FROM watchdog_task_state WHERE task_id = ?").get(taskId) as
      | Row
      | undefined;
    if (!row) {
      const state: WatchdogTaskState = {
        workspaceId,
        taskId,
        autoInterventions: 0,
        nudgeCount: 0,
        updatedAt: this.nowIso(),
      };
      this.db
        .prepare(
          "INSERT OR IGNORE INTO watchdog_task_state (workspace_id, task_id, auto_interventions, nudge_count, updated_at) VALUES (?, ?, 0, 0, ?)",
        )
        .run(workspaceId, taskId, state.updatedAt);
      return state;
    }
    return {
      workspaceId: String(row.workspace_id),
      taskId: String(row.task_id),
      autoInterventions: Number(row.auto_interventions ?? 0),
      nudgeCount: Number(row.nudge_count ?? 0),
      updatedAt: String(row.updated_at),
    };
  }

  bumpAutoInterventions(workspaceId: string, taskId: string): number {
    this.getTaskState(workspaceId, taskId);
    this.db
      .prepare(
        "UPDATE watchdog_task_state SET auto_interventions = auto_interventions + 1, updated_at = ? WHERE task_id = ?",
      )
      .run(this.nowIso(), taskId);
    return this.getTaskState(workspaceId, taskId).autoInterventions;
  }

  bumpNudgeCount(workspaceId: string, taskId: string): number {
    this.getTaskState(workspaceId, taskId);
    this.db
      .prepare("UPDATE watchdog_task_state SET nudge_count = nudge_count + 1, updated_at = ? WHERE task_id = ?")
      .run(this.nowIso(), taskId);
    return this.getTaskState(workspaceId, taskId).nudgeCount;
  }

  resetTaskState(workspaceId: string, taskId: string): void {
    this.getTaskState(workspaceId, taskId);
    this.db
      .prepare(
        "UPDATE watchdog_task_state SET auto_interventions = 0, nudge_count = 0, updated_at = ? WHERE task_id = ?",
      )
      .run(this.nowIso(), taskId);
  }

  // ---------------------------------------------------------------- holds

  addHold(input: {
    workspaceId: string;
    taskId: string;
    reason: WatchdogHoldReason;
    scope: BudgetScope;
  }): WatchdogHold {
    const now = this.nowIso();
    this.db
      .prepare(
        `INSERT INTO watchdog_holds (task_id, workspace_id, reason, scope, created_at, released_at, released_by)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(task_id, reason, scope) DO UPDATE SET created_at = excluded.created_at, released_at = NULL, released_by = NULL`,
      )
      .run(input.taskId, input.workspaceId, input.reason, input.scope, now);
    return this.listHolds(input.workspaceId, input.taskId).find(
      (hold) => hold.reason === input.reason && hold.scope === input.scope,
    )!;
  }

  listHolds(workspaceId: string, taskId?: string): WatchdogHold[] {
    const rows = (
      taskId
        ? this.db
            .prepare(
              "SELECT * FROM watchdog_holds WHERE workspace_id = ? AND task_id = ? AND released_at IS NULL ORDER BY created_at ASC",
            )
            .all(workspaceId, taskId)
        : this.db
            .prepare(
              "SELECT * FROM watchdog_holds WHERE workspace_id = ? AND released_at IS NULL ORDER BY created_at ASC",
            )
            .all(workspaceId)
    ) as Row[];
    return rows.map((row) => ({
      taskId: String(row.task_id),
      workspaceId: String(row.workspace_id),
      reason: String(row.reason) as WatchdogHoldReason,
      scope: String(row.scope) as BudgetScope,
      createdAt: String(row.created_at),
      releasedAt: row.released_at == null ? null : String(row.released_at),
      releasedBy: row.released_by == null ? null : String(row.released_by),
    }));
  }

  releaseHolds(
    workspaceId: string,
    taskId: string,
    reason: WatchdogHoldReason | null,
    actor?: string,
  ): WatchdogHold[] {
    const now = this.nowIso();
    if (reason) {
      this.db
        .prepare(
          "UPDATE watchdog_holds SET released_at = ?, released_by = ? WHERE workspace_id = ? AND task_id = ? AND reason = ? AND released_at IS NULL",
        )
        .run(now, actor ?? null, workspaceId, taskId, reason);
    } else {
      this.db
        .prepare(
          "UPDATE watchdog_holds SET released_at = ?, released_by = ? WHERE workspace_id = ? AND task_id = ? AND released_at IS NULL",
        )
        .run(now, actor ?? null, workspaceId, taskId);
    }
    return this.listHolds(workspaceId, taskId);
  }

  // -------------------------------------------------------------- handoff

  saveHandoff(handoff: RunHandoff): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO run_handoffs
         (id, workspace_id, task_id, run_id, attempt, reason, summary, next_step, files, diff_stat, diff_ref, last_event_seq, from_model_profile_id, to_model_profile_id, from_agent_id, to_agent_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        handoff.id,
        handoff.workspaceId,
        handoff.taskId,
        handoff.runId,
        handoff.attempt,
        handoff.reason,
        handoff.summary,
        handoff.nextStep,
        JSON.stringify(handoff.files),
        handoff.diffStat,
        handoff.diffRef,
        handoff.lastEventSeq,
        handoff.fromModelProfileId,
        handoff.toModelProfileId,
        handoff.fromAgentId,
        handoff.toAgentId,
        handoff.createdAt,
        handoff.expiresAt,
      );
  }

  getHandoff(workspaceId: string, runId: string): RunHandoff | null {
    const row = this.db
      .prepare("SELECT * FROM run_handoffs WHERE run_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(runId, workspaceId) as Row | undefined;
    return row ? this.toHandoff(row) : null;
  }

  getHandoffById(workspaceId: string, id: string): RunHandoff | null {
    const row = this.db
      .prepare("SELECT * FROM run_handoffs WHERE id = ? AND workspace_id = ?")
      .get(id, workspaceId) as Row | undefined;
    return row ? this.toHandoff(row) : null;
  }

  listHandoffs(workspaceId: string, limit = 20): RunHandoff[] {
    const rows = this.db
      .prepare("SELECT * FROM run_handoffs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(workspaceId, limit) as Row[];
    return rows.map((row) => this.toHandoff(row));
  }

  private toHandoff(row: Row): RunHandoff {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      taskId: String(row.task_id),
      runId: String(row.run_id),
      attempt: Number(row.attempt ?? 1),
      reason: String(row.reason) as RunHandoff["reason"],
      summary: String(row.summary),
      nextStep: String(row.next_step),
      files: parseJson<string[]>(row.files, []),
      diffStat: String(row.diff_stat ?? ""),
      diffRef: row.diff_ref == null ? null : String(row.diff_ref),
      lastEventSeq: Number(row.last_event_seq ?? 0),
      fromModelProfileId: row.from_model_profile_id == null ? null : String(row.from_model_profile_id),
      toModelProfileId: row.to_model_profile_id == null ? null : String(row.to_model_profile_id),
      fromAgentId: String(row.from_agent_id),
      toAgentId: row.to_agent_id == null ? null : String(row.to_agent_id),
      createdAt: String(row.created_at),
      expiresAt: row.expires_at == null ? null : String(row.expires_at),
    };
  }

  // ----------------------------------------------------------------- cost

  upsertProvisional(entry: CostLedgerEntry): void {
    this.db
      .prepare(
        `INSERT INTO cost_ledger
         (id, workspace_id, task_id, run_id, agent_id, model_profile_id, model_id, provider_id,
          price_snapshot, pricing_known, token_in, token_out, cached_token_in, cost_micro_usd,
          cost_usd, kind, period_day, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisional', ?, ?, ?)
         ON CONFLICT(run_id, kind) WHERE kind IN ('provisional','final')
         DO UPDATE SET token_in = excluded.token_in, token_out = excluded.token_out,
           cached_token_in = excluded.cached_token_in, cost_micro_usd = excluded.cost_micro_usd,
           cost_usd = excluded.cost_usd, pricing_known = excluded.pricing_known,
           price_snapshot = excluded.price_snapshot, created_at = excluded.created_at,
           metadata = excluded.metadata`,
      )
      .run(
        entry.id,
        entry.workspaceId,
        entry.taskId,
        entry.runId,
        entry.agentId,
        entry.modelProfileId,
        entry.modelId,
        entry.providerId,
        entry.priceSnapshot ? JSON.stringify(entry.priceSnapshot) : null,
        entry.pricingKnown ? 1 : 0,
        entry.tokenIn,
        entry.tokenOut,
        entry.cachedTokenIn,
        entry.costMicroUsd,
        entry.costUsd,
        entry.periodDay,
        entry.createdAt,
        JSON.stringify(entry.metadata),
      );
  }

  insertFinal(entry: CostLedgerEntry): boolean {
    const existing = this.db
      .prepare("SELECT id FROM cost_ledger WHERE run_id = ? AND kind = 'final'")
      .get(entry.runId) as Row | undefined;
    if (existing) return false;
    this.db
      .prepare(
        `INSERT INTO cost_ledger
         (id, workspace_id, task_id, run_id, agent_id, model_profile_id, model_id, provider_id,
          price_snapshot, pricing_known, token_in, token_out, cached_token_in, cost_micro_usd,
          cost_usd, kind, period_day, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'final', ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.workspaceId,
        entry.taskId,
        entry.runId,
        entry.agentId,
        entry.modelProfileId,
        entry.modelId,
        entry.providerId,
        entry.priceSnapshot ? JSON.stringify(entry.priceSnapshot) : null,
        entry.pricingKnown ? 1 : 0,
        entry.tokenIn,
        entry.tokenOut,
        entry.cachedTokenIn,
        entry.costMicroUsd,
        entry.costUsd,
        entry.periodDay,
        entry.createdAt,
        JSON.stringify(entry.metadata),
      );
    this.db.prepare("DELETE FROM cost_ledger WHERE run_id = ? AND kind = 'provisional'").run(entry.runId);
    return true;
  }

  getProvisional(runId: string): CostLedgerEntry | null {
    const row = this.db
      .prepare("SELECT * FROM cost_ledger WHERE run_id = ? AND kind = 'provisional'")
      .get(runId) as Row | undefined;
    return row ? this.toLedger(row) : null;
  }

  listLedger(workspaceId: string, limit = 100): CostLedgerEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM cost_ledger WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(workspaceId, limit) as Row[];
    return rows.map((row) => this.toLedger(row));
  }

  sumFinal(
    filter: { workspaceId: string; taskId?: string; agentId?: string; day?: string },
  ): { micro: number; runs: number; knownRuns: number } {
    const clauses = ["workspace_id = ?", "kind = 'final'"];
    const params: Array<string | number> = [filter.workspaceId];
    if (filter.taskId) {
      clauses.push("task_id = ?");
      params.push(filter.taskId);
    }
    if (filter.agentId) {
      clauses.push("agent_id = ?");
      params.push(filter.agentId);
    }
    if (filter.day) {
      clauses.push("period_day = ?");
      params.push(filter.day);
    }
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_micro_usd),0) AS micro, COUNT(*) AS runs, COALESCE(SUM(pricing_known),0) AS known FROM cost_ledger WHERE ${clauses.join(" AND ")}`,
      )
      .get(...params) as Row;
    return {
      micro: Number(row.micro ?? 0),
      runs: Number(row.runs ?? 0),
      knownRuns: Number(row.known ?? 0),
    };
  }

  listFinal(filter: { workspaceId: string; taskId?: string; agentId?: string; day?: string }): CostLedgerEntry[] {
    const clauses = ["workspace_id = ?", "kind = 'final'"];
    const params: Array<string | number> = [filter.workspaceId];
    if (filter.taskId) {
      clauses.push("task_id = ?");
      params.push(filter.taskId);
    }
    if (filter.agentId) {
      clauses.push("agent_id = ?");
      params.push(filter.agentId);
    }
    if (filter.day) {
      clauses.push("period_day = ?");
      params.push(filter.day);
    }
    const rows = this.db
      .prepare(`SELECT * FROM cost_ledger WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 500`)
      .all(...params) as Row[];
    return rows.map((row) => this.toLedger(row));
  }

  private toLedger(row: Row): CostLedgerEntry {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      taskId: String(row.task_id),
      runId: String(row.run_id),
      agentId: String(row.agent_id),
      modelProfileId: row.model_profile_id == null ? null : String(row.model_profile_id),
      modelId: row.model_id == null ? null : String(row.model_id),
      providerId: row.provider_id == null ? null : String(row.provider_id),
      priceSnapshot: parseJson<ModelPriceSnapshot | null>(row.price_snapshot, null),
      pricingKnown: Number(row.pricing_known) === 1,
      tokenIn: Number(row.token_in ?? 0),
      tokenOut: Number(row.token_out ?? 0),
      cachedTokenIn: Number(row.cached_token_in ?? 0),
      costMicroUsd: Number(row.cost_micro_usd ?? 0),
      costUsd: Number(row.cost_usd ?? 0),
      kind: String(row.kind) as CostLedgerEntry["kind"],
      periodDay: String(row.period_day),
      createdAt: String(row.created_at),
      metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    };
  }

  // -------------------------------------------------------------- budgets

  setBudget(input: {
    workspaceId: string;
    scope: BudgetScope;
    scopeId: string;
    limitMicroUsd: number;
    softRatio: number;
    hardAction: "pause" | "stop";
  }): void {
    this.db
      .prepare(
        `INSERT INTO budget_limits (scope, scope_id, limit_micro_usd, soft_ratio, hard_action, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, scope_id) DO UPDATE SET limit_micro_usd=excluded.limit_micro_usd,
           soft_ratio=excluded.soft_ratio, hard_action=excluded.hard_action, updated_at=excluded.updated_at`,
      )
      .run(
        input.scope,
        input.scopeId,
        input.limitMicroUsd,
        input.softRatio,
        input.hardAction,
        this.nowIso(),
      );
  }

  getBudget(
    scope: BudgetScope,
    scopeId: string,
  ): { limitMicroUsd: number; softRatio: number; hardAction: "pause" | "stop" } | null {
    const row = this.db
      .prepare("SELECT * FROM budget_limits WHERE scope = ? AND scope_id = ?")
      .get(scope, scopeId) as Row | undefined;
    if (!row) return null;
    return {
      limitMicroUsd: Number(row.limit_micro_usd ?? 0),
      softRatio: Number(row.soft_ratio ?? 0.8),
      hardAction: String(row.hard_action) === "stop" ? "stop" : "pause",
    };
  }

  // ------------------------------------------------------------ fallbacks

  setFallback(input: FallbackChain): void {
    this.db
      .prepare(
        `INSERT INTO watchdog_fallbacks (workspace_id, agent_id, models, max_switches, on_quota, on_errors, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, agent_id) DO UPDATE SET models=excluded.models,
           max_switches=excluded.max_switches, on_quota=excluded.on_quota, on_errors=excluded.on_errors, updated_at=excluded.updated_at`,
      )
      .run(
        input.workspaceId,
        input.agentId ?? "*",
        JSON.stringify(input.models),
        input.maxSwitches,
        input.onQuota ? 1 : 0,
        input.onErrors ? 1 : 0,
        this.nowIso(),
      );
  }

  getFallback(workspaceId: string, agentId?: string | null): FallbackChain {
    const row = (
      agentId
        ? this.db
            .prepare("SELECT * FROM watchdog_fallbacks WHERE workspace_id = ? AND agent_id = ?")
            .get(workspaceId, agentId)
        : undefined
    ) ?? (this.db
      .prepare("SELECT * FROM watchdog_fallbacks WHERE workspace_id = ? AND agent_id = '*'")
      .get(workspaceId) as Row | undefined);
    if (!row) {
      return {
        workspaceId,
        agentId: agentId ?? null,
        models: [],
        maxSwitches: 2,
        onQuota: true,
        onErrors: true,
      };
    }
    return {
      workspaceId,
      agentId: row.agent_id === "*" ? null : String(row.agent_id),
      models: parseJson<string[]>(row.models, []),
      maxSwitches: Number(row.max_switches ?? 2),
      onQuota: Number(row.on_quota ?? 1) === 1,
      onErrors: Number(row.on_errors ?? 1) === 1,
    };
  }

  // ----------------------------------------------------------- cooldowns

  setCooldown(input: {
    providerId: string;
    modelId: string;
    until: string;
    reason: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO provider_cooldowns (provider_id, model_id, until, reason, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider_id, model_id) DO UPDATE SET until=excluded.until, reason=excluded.reason, created_at=excluded.created_at`,
      )
      .run(input.providerId, input.modelId, input.until, input.reason, this.nowIso());
  }

  isCooling(providerId: string, modelId: string, nowIso: string): boolean {
    const rows = this.db
      .prepare(
        "SELECT * FROM provider_cooldowns WHERE provider_id = ? AND model_id IN (?, '*') AND until > ?",
      )
      .all(providerId, modelId, nowIso) as Row[];
    return rows.length > 0;
  }

  listCooldowns(nowIso: string): Array<{ providerId: string; modelId: string; until: string; reason: string }> {
    const rows = this.db
      .prepare("SELECT * FROM provider_cooldowns WHERE until > ? ORDER BY until ASC")
      .all(nowIso) as Row[];
    return rows.map((row) => ({
      providerId: String(row.provider_id),
      modelId: String(row.model_id),
      until: String(row.until),
      reason: String(row.reason),
    }));
  }

  clearExpiredCooldowns(nowIso: string): number {
    const result = this.db.prepare("DELETE FROM provider_cooldowns WHERE until <= ?").run(nowIso);
    return Number(result.changes);
  }

  // ------------------------------------------------------------- rebuild

  rebuild(): { alerts: number; interventions: number; holds: number; handoffs: number; ledger: number } {
    // watchdog tables are projections; kernel rebuild never touches them.
    // This method intentionally does not wipe state: hold/counter/handoff must survive
    // kernel projection rebuilds (F1/KRN-06). It only reports/validates counts.
    const count = (table: string) =>
      Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n ?? 0);
    return {
      alerts: count("watchdog_alerts"),
      interventions: count("watchdog_interventions"),
      holds: count("watchdog_holds"),
      handoffs: count("run_handoffs"),
      ledger: count("cost_ledger"),
    };
  }
}
