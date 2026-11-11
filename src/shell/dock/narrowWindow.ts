/**
 * t194 P0-1 窄窗布局常量与纯函数（DockShell / App 共用）。
 *
 * 背景：窗口 ≤960（Electron 最小 960）时侧栏折叠后 Dock 仍有 ~900，按 Dock 宽度旧规则会
 * 落到 narrow/medium 并强制 Team right split，导致 Tasks（minWidth=560）+ Team 互相挤压。
 * 这里把「窗口宽度」作为 single 变体的强制条件，并给侧栏一个可读宽度上限，保证单栏主区
 * 至少能容纳 tasks 的 560 最小值。
 *
 * t212 修复：
 * - 侧栏外还有 6px resizer、非 single 的 Dock 左右组之间还有 4px sash；宽度预算必须扣除，
 *   否则「window - sidebar = 560」实际 main 只有 554/550。
 * - preferredWidth（persist）与 displayedWidth（当前显示）分离：窄窗拖拽只改显示，不写
 *   preferred；回到宽窗恢复用户原值。
 */

/** 窗口宽度 ≤ 该值强制 single 变体（t194：960/900/760 均单栏）。 */
export const NARROW_WINDOW_MAX = 960;

/** 侧栏自动折叠阈值（沿用既有 1100 行为；用户手动展开后同一宽度内不再折叠）。 */
export const SIDEBAR_AUTO_COLLAPSE_WIDTH = 1100;

export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 250;
export const SIDEBAR_COLLAPSED_WIDTH = 56;

/** 侧栏与 Dock 之间的可拖拽 resizer 宽度（styles.css `.resizer`）。 */
export const SIDEBAR_RESIZER_WIDTH = 6;

/** dockview 横向 split 的 sash 宽度（dockview.css `.dv-horizontal > .dv-sash { width:4px }`）。 */
export const DOCK_SASH_WIDTH = 4;

/** tasks 面板最小可读宽度（与 panelRegistry tasks.minWidth 一致）。 */
export const TASKS_MIN_WIDTH = 560;

/** Team 面板最小宽度（与 panelRegistry team.minWidth 一致）。 */
export const TEAM_MIN_WIDTH = 360;

/** 非 single 布局需要同时容纳 Tasks 主组、1 条 sash、Team 右组的最小 Dock 宽度。 */
export const MIN_SPLIT_DOCK_WIDTH =
  TASKS_MIN_WIDTH + DOCK_SASH_WIDTH + TEAM_MIN_WIDTH;

export function isNarrowWindow(windowWidth: number): boolean {
  return windowWidth <= NARROW_WINDOW_MAX;
}

/**
 * 单栏（sidebar 展开）可用的 Dock 宽度 = window - sidebar - 6px resizer。
 * sidebarWidth 应传「实际显示宽度」（clamp 后）。
 */
export function singleDockWidth(windowWidth: number, sidebarWidth: number): number {
  return windowWidth - sidebarWidth - SIDEBAR_RESIZER_WIDTH;
}

/**
 * single 变体的面板最小宽度：Dock 本身 ≥560 时仍用声明值（保证 Tasks 可读）；
 * 只有 Dock <560 的极端场景（Electron 960 窗口 200% zoom → 480 CSS viewport）才降到
 * 实际 Dock 宽度，由容器查询单列布局接管，避免强制 560 造成横向裁切。
 */
export function effectivePanelMinWidth(
  declaredWidth: number,
  single: boolean,
  dockWidth: number,
): number {
  if (!single) return declaredWidth;
  return Math.min(declaredWidth, Math.max(320, Math.round(dockWidth)));
}

/**
 * 侧栏宽度上限：所有窗口统一 `min(480, window - 560 - 6)`（tasks 560 + sidebar resizer 6）。
 * - 1440：min(480, 874)=480（保留宽窗 480）
 * - 1000：min(480, 434)=434（非 narrow 也守住 tasks 560，避免 1000 宽 handoff 时被挤）
 * 注意：只限制「显示/拖拽」宽度，不改写 localStorage 中用户保存的 preferred——回到宽屏后可恢复。
 */
export function sidebarMaxWidth(windowWidth: number): number {
  return Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(
      SIDEBAR_MAX_WIDTH,
      windowWidth - TASKS_MIN_WIDTH - SIDEBAR_RESIZER_WIDTH,
    ),
  );
}

/** 按窗口宽度钳制侧栏宽度（180..480，窄窗额外保证实际 Dock ≥ TASKS_MIN_WIDTH）。 */
export function clampSidebarWidth(width: number, windowWidth: number): number {
  const max = sidebarMaxWidth(windowWidth);
  const rounded = Number.isFinite(width) ? Math.round(width) : SIDEBAR_DEFAULT_WIDTH;
  return Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, rounded));
}

/**
 * 侧栏拖拽的宽度状态。preferred 是用户持久化值，displayed 是当前会话的显示覆盖值。
 * - 宽窗拖拽：改 preferred，清 display；
 * - 窄窗拖拽：只改 displayed，preferred 保持不变（不写 localStorage）。
 */
export type SidebarWidthState = {
  preferred: number;
  displayed: number | null;
};

export function resizeSidebarWidth(
  state: SidebarWidthState,
  windowWidth: number,
  requestedWidth: number,
): SidebarWidthState {
  const next = clampSidebarWidth(requestedWidth, windowWidth);
  if (isNarrowWindow(windowWidth)) {
    return { preferred: state.preferred, displayed: next };
  }
  return { preferred: next, displayed: null };
}

/** 当前应渲染的侧栏宽度：宽窗永远回到 preferred（display override 不跨宽度档）。 */
export function displayedSidebarWidth(
  state: SidebarWidthState,
  windowWidth: number,
): number {
  // t214：窄窗时 displayed 也必须按「新 window 的 sidebarMaxWidth」再 clamp 一次；
  // 宽窗忽略 displayed，直接 clamp preferred（回到 1440 恢复原值/或 480 上限）。
  const raw = isNarrowWindow(windowWidth) ? (state.displayed ?? state.preferred) : state.preferred;
  return clampSidebarWidth(raw, windowWidth);
}

/**
 * 拖拽结束的提交结果：窄窗不持久化 preferred（返回 persist=false），只有宽窗或显式重置
 * 才写 localStorage；displayed 覆盖值保留到离开窄窗/显式重置。
 */
export function commitSidebarWidth(
  state: SidebarWidthState,
  windowWidth: number,
): SidebarWidthState & { persist: boolean } {
  if (isNarrowWindow(windowWidth)) {
    return { ...state, persist: false };
  }
  return { preferred: state.preferred, displayed: null, persist: true };
}

/** 窗口跨宽度档时清理 display override：回到宽窗必须恢复 preferred。 */
export function sidebarWidthStateForWindow(
  state: SidebarWidthState,
  windowWidth: number,
): SidebarWidthState {
  if (!isNarrowWindow(windowWidth)) {
    return state.displayed === null ? state : { preferred: state.preferred, displayed: null };
  }
  if (state.displayed === null) return state;
  const clamped = clampSidebarWidth(state.displayed, windowWidth);
  return clamped === state.displayed
    ? state
    : { preferred: state.preferred, displayed: clamped };
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
