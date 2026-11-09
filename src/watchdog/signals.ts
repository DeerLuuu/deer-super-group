import type { WatchdogSeverity, WatchdogSignalKind } from "../shared/watchdog.js";

/**
 * t144：L2 信号纯函数（无 IO，fake clock 可测）。
 * 与内核 L1 lease 分离：heartbeat 只更新 token，不刷新 activity。
 */
export interface WatchdogThresholds {
  taskCheckMs: number;
  stallMs: number;
  repeatToolCount: number;
  sameFileWriteCount: number;
  errorStreak: number;
  tokenBurnPer5m: number;
  waitingHumanGraceMs: number;
}

export const DEFAULT_WATCHDOG_THRESHOLDS: WatchdogThresholds = {
  taskCheckMs: 5 * 60_000,
  stallMs: 10 * 60_000,
  repeatToolCount: 3,
  sameFileWriteCount: 4,
  errorStreak: 3,
  tokenBurnPer5m: 120_000,
  waitingHumanGraceMs: 240_000,
};

export interface ActivityRecord {
  kind: string;
  at: number;
  toolName?: string;
  toolSignature?: string;
  file?: string;
  ok?: boolean;
  progress?: boolean;
  tokenIn?: number;
  tokenOut?: number;
}

export interface TaskSignalState {
  taskId: string;
  runId: string | null;
  startedAt: number;
  lastActivityAt: number;
  lastProgressAt: number;
  lastNudgeAt: number;
  stepsWithoutProgress: number;
  consecutiveErrors: number;
  toolCounts: Map<string, number>;
  fileWrites: Map<string, number>;
  tokenSamples: Array<{ at: number; tokenIn: number; tokenOut: number }>;
  waitingHuman: boolean;
  waitingHumanSince: number | null;
}

export interface SignalHit {
  kind: WatchdogSignalKind;
  severity: WatchdogSeverity;
  evidence: Record<string, unknown>;
  /** 同一信号窗口内去重。 */
  windowMs: number;
}

export function createTaskSignalState(input: {
  taskId: string;
  runId?: string | null;
  at: number;
}): TaskSignalState {
  return {
    taskId: input.taskId,
    runId: input.runId ?? null,
    startedAt: input.at,
    lastActivityAt: input.at,
    lastProgressAt: input.at,
    lastNudgeAt: 0,
    stepsWithoutProgress: 0,
    consecutiveErrors: 0,
    toolCounts: new Map(),
    fileWrites: new Map(),
    tokenSamples: [],
    waitingHuman: false,
    waitingHumanSince: null,
  };
}

export function recordActivity(state: TaskSignalState, activity: ActivityRecord): void {
  state.lastActivityAt = Math.max(state.lastActivityAt, activity.at);
  if (activity.progress) {
    state.lastProgressAt = activity.at;
    state.stepsWithoutProgress = 0;
  }
  if (activity.kind === "run.step") {
    state.stepsWithoutProgress += 1;
  }
  if (activity.kind === "tool.call" && activity.toolSignature) {
    state.toolCounts.set(activity.toolSignature, (state.toolCounts.get(activity.toolSignature) ?? 0) + 1);
  }
  if (activity.kind === "tool.result") {
    if (activity.ok === false) state.consecutiveErrors += 1;
    else state.consecutiveErrors = 0;
  }
  if (activity.kind === "tool.call" && activity.file) {
    state.fileWrites.set(activity.file, (state.fileWrites.get(activity.file) ?? 0) + 1);
  }
  if (typeof activity.tokenIn === "number" || typeof activity.tokenOut === "number") {
    state.tokenSamples.push({
      at: activity.at,
      tokenIn: activity.tokenIn ?? 0,
      tokenOut: activity.tokenOut ?? 0,
    });
  }
}

export function markWaitingHuman(state: TaskSignalState, at: number): void {
  state.waitingHuman = true;
  state.waitingHumanSince = at;
}

export function clearWaitingHuman(state: TaskSignalState, at: number): void {
  state.waitingHuman = false;
  state.waitingHumanSince = null;
  state.lastActivityAt = at;
}

export function detectSignals(
  state: TaskSignalState,
  now: number,
  thresholds: WatchdogThresholds = DEFAULT_WATCHDOG_THRESHOLDS,
): SignalHit[] {
  const hits: SignalHit[] = [];
  if (state.waitingHuman) {
    const since = state.waitingHumanSince ?? state.lastActivityAt;
    if (now - since >= thresholds.waitingHumanGraceMs) {
      hits.push({
        kind: "task_timeout",
        severity: "critical",
        evidence: { waitingHuman: true, waitingMs: now - since },
        windowMs: thresholds.waitingHumanGraceMs,
      });
    }
    // waiting_human 不参与 5/10min no-activity pause（KRN-07）。
    return hits;
  }

  const idle = now - state.lastActivityAt;
  if (idle >= thresholds.stallMs) {
    hits.push({
      kind: "heartbeat_stale",
      severity: "critical",
      evidence: { idleMs: idle },
      windowMs: thresholds.stallMs,
    });
  } else if (idle >= thresholds.taskCheckMs) {
    hits.push({
      kind: "task_timeout",
      severity: "warning",
      evidence: { idleMs: idle },
      windowMs: thresholds.taskCheckMs,
    });
  }

  for (const [signature, count] of state.toolCounts) {
    if (count >= thresholds.repeatToolCount) {
      hits.push({
        kind: "repeat_tool",
        severity: "warning",
        evidence: { signature, count },
        windowMs: 10 * 60_000,
      });
      break;
    }
  }
  for (const [file, count] of state.fileWrites) {
    if (count >= thresholds.sameFileWriteCount) {
      hits.push({
        kind: "repeat_tool",
        severity: "warning",
        evidence: { file, count },
        windowMs: 10 * 60_000,
      });
      break;
    }
  }

  if (
    (state.stepsWithoutProgress >= 3 || now - state.lastProgressAt >= 8 * 60_000) &&
    now - state.lastProgressAt >= 8 * 60_000
  ) {
    hits.push({
      kind: "no_progress",
      severity: "warning",
      evidence: {
        stepsWithoutProgress: state.stepsWithoutProgress,
        msSinceProgress: now - state.lastProgressAt,
      },
      windowMs: 8 * 60_000,
    });
  }

  if (state.consecutiveErrors >= thresholds.errorStreak) {
    hits.push({
      kind: "error_streak",
      severity: "warning",
      evidence: { consecutiveErrors: state.consecutiveErrors },
      windowMs: 5 * 60_000,
    });
  }

  const windowStart = now - 5 * 60_000;
  const recent = state.tokenSamples.filter((sample) => sample.at >= windowStart);
  const tokenTotal = recent.reduce((sum, sample) => sum + sample.tokenIn + sample.tokenOut, 0);
  if (tokenTotal >= thresholds.tokenBurnPer5m) {
    hits.push({
      kind: "token_burn",
      severity: "warning",
      evidence: { tokenTotal, windowMs: 5 * 60_000 },
      windowMs: 5 * 60_000,
    });
  }
  return hits;
}
