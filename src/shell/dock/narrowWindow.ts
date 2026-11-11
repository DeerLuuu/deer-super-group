/**
 * t194 P0-1 窄窗布局常量与纯函数（DockShell / App 共用）。
 *
 * 背景：窗口 ≤960（Electron 最小 960）时侧栏折叠后 Dock 仍有 ~900，按 Dock 宽度旧规则会
 * 落到 narrow/medium 并强制 Team right split，导致 Tasks（minWidth=560）+ Team 互相挤压。
 * 这里把「窗口宽度」作为 single 变体的强制条件，并给侧栏一个可读宽度上限，保证单栏主区
 * 至少能容纳 tasks 的 560 最小值。
 */

/** 窗口宽度 ≤ 该值强制 single 变体（t194：960/900/760 均单栏）。 */
export const NARROW_WINDOW_MAX = 960;

/** 侧栏自动折叠阈值（沿用既有 1100 行为；用户手动展开后同一宽度内不再折叠）。 */
export const SIDEBAR_AUTO_COLLAPSE_WIDTH = 1100;

export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 250;
export const SIDEBAR_COLLAPSED_WIDTH = 56;

/** tasks 面板最小可读宽度（与 panelRegistry tasks.minWidth 一致）。 */
export const TASKS_MIN_WIDTH = 560;

/** Team 面板最小宽度（与 panelRegistry team.minWidth 一致）。 */
export const TEAM_MIN_WIDTH = 360;

/** 非 single 布局需要同时容纳 Tasks 主组与 Team 右组的最小 Dock 宽度。 */
export const MIN_SPLIT_DOCK_WIDTH = TASKS_MIN_WIDTH + TEAM_MIN_WIDTH;

export function isNarrowWindow(windowWidth: number): boolean {
  return windowWidth <= NARROW_WINDOW_MAX;
}

/**
 * 侧栏宽度上限：普通宽度仍为 480；窄窗时最多把 Dock 压到 tasks 的 560 可读宽度。
 * 注意：只限制「显示/拖拽」宽度，不改写 localStorage 中用户保存的宽度——回到宽屏后可恢复。
 */
export function sidebarMaxWidth(windowWidth: number): number {
  if (!isNarrowWindow(windowWidth)) return SIDEBAR_MAX_WIDTH;
  return Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, windowWidth - TASKS_MIN_WIDTH),
  );
}

/** 按窗口宽度钳制侧栏宽度（180..480，窄窗额外保证 Dock ≥ TASKS_MIN_WIDTH）。 */
export function clampSidebarWidth(width: number, windowWidth: number): number {
  const max = sidebarMaxWidth(windowWidth);
  const rounded = Number.isFinite(width) ? Math.round(width) : SIDEBAR_DEFAULT_WIDTH;
  return Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, rounded));
}

/**
 * 是否在窗口宽度变化时自动折叠侧栏。
 * - 初始（prev=null）且已经窄 → 折叠一次；
 * - 只有从宽（>1100）跨到 ≤1100 的边沿才折叠；
 * - 在窄窗内继续缩放、或用户在窄窗手动展开后 resize，都不覆盖用户选择。
 */
export function shouldAutoCollapseSidebar(
  prevWindowWidth: number | null,
  nextWindowWidth: number,
): boolean {
  if (nextWindowWidth > SIDEBAR_AUTO_COLLAPSE_WIDTH) return false;
  return prevWindowWidth === null || prevWindowWidth > SIDEBAR_AUTO_COLLAPSE_WIDTH;
}
