import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type WindowStateNormalization =
  | { state: WindowState; restored: true; reason: "restored" | "maximized" }
  | { state: WindowState; restored: false; reason: "missing" | "invalid" | "too-small" | "offscreen" | "no-display" };

export const DEFAULT_WINDOW_WIDTH = 1440;
export const DEFAULT_WINDOW_HEIGHT = 920;
export const DEFAULT_WINDOW_MIN_WIDTH = 960;
export const DEFAULT_WINDOW_MIN_HEIGHT = 700;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function insideTitlebarReach(bounds: WindowState, area: WorkArea): boolean {
  // A saved window may straddle displays, but its titlebar must still be
  // reachable: no part above the work area and at least 40px vertical overlap.
  const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
  const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
  return (
    bounds.y >= area.y - 8 &&
    bounds.y <= area.y + area.height - 40 &&
    overlapX >= Math.min(160, bounds.width) &&
    overlapY >= 40
  );
}

export function defaultWindowState(
  areas: readonly WorkArea[],
  minWidth = DEFAULT_WINDOW_MIN_WIDTH,
  minHeight = DEFAULT_WINDOW_MIN_HEIGHT,
): WindowState {
  const area = areas[0];
  if (!area) {
    return { x: 0, y: 0, width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT, maximized: false };
  }
  const width = Math.max(minWidth, Math.min(DEFAULT_WINDOW_WIDTH, area.width));
  const height = Math.max(minHeight, Math.min(DEFAULT_WINDOW_HEIGHT, area.height));
  return {
    x: Math.round(area.x + Math.max(0, (area.width - width) / 2)),
    y: Math.round(area.y + Math.max(0, (area.height - height) / 2)),
    width: Math.round(width),
    height: Math.round(height),
    maximized: false,
  };
}

/**
 * Validate a persisted window state against the currently visible displays.
 * Invalid/missing/small/offscreen states fall back to a centered 1440x920
 * window (or the largest size that fits the primary work area).
 */
export function normalizeWindowState(
  raw: unknown,
  areas: readonly WorkArea[],
  minWidth = DEFAULT_WINDOW_MIN_WIDTH,
  minHeight = DEFAULT_WINDOW_MIN_HEIGHT,
): WindowStateNormalization {
  if (areas.length === 0) {
    return { state: defaultWindowState(areas, minWidth, minHeight), restored: false, reason: "no-display" };
  }
  if (!raw || typeof raw !== "object") {
    return { state: defaultWindowState(areas, minWidth, minHeight), restored: false, reason: "missing" };
  }
  const value = raw as Partial<Record<keyof WindowState, unknown>>;
  if (
    !finite(value.x) ||
    !finite(value.y) ||
    !finite(value.width) ||
    !finite(value.height) ||
    typeof value.maximized !== "boolean"
  ) {
    return { state: defaultWindowState(areas, minWidth, minHeight), restored: false, reason: "invalid" };
  }
  const candidate: WindowState = {
    x: Math.round(value.x),
    y: Math.round(value.y),
    width: Math.round(value.width),
    height: Math.round(value.height),
    maximized: value.maximized,
  };
  if (candidate.width < minWidth || candidate.height < minHeight) {
    return { state: defaultWindowState(areas, minWidth, minHeight), restored: false, reason: "too-small" };
  }
  if (!areas.some((area) => insideTitlebarReach(candidate, area))) {
    return { state: defaultWindowState(areas, minWidth, minHeight), restored: false, reason: "offscreen" };
  }
  return {
    state: candidate,
    restored: true,
    reason: candidate.maximized ? "maximized" : "restored",
  };
}

export function readWindowState(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** Persist synchronously; window close must not wait for an async write. */
export function writeWindowState(filePath: string, state: WindowState): boolean {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
