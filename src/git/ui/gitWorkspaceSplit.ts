/**
 * t432（G9）：Git 历史与工作区之间的水平分隔条——纯函数与常量。
 *
 * 布局行（.git-st-layout）：
 *   history: minmax(180px, 1fr) | filter: 30px | splitter: 6px | workspace: var(--git-workspace-h, 300px)
 *
 * 约束：工作区 ≥ 160px；历史 ≥ 180px（由此推导工作区上限）；
 * 容器太矮（放不下 160+36+180）时分隔条隐藏（≤560 短高 / ≤719 三 tab 由 CSS 处理）。
 */

import type { CSSProperties } from "react";

export const GIT_WS_MIN = 160;
export const GIT_WS_DEFAULT = 300;
export const GIT_HISTORY_MIN = 180;
export const GIT_FILTER_ROW = 30;
export const GIT_SPLITTER_ROW = 6;

/** 键盘单步调整量（像素）。 */
export const GIT_WS_KEY_STEP = 16;

/** 除工作区外的固定行高（filter + splitter）。 */
export const GIT_FIXED_ROWS = GIT_FILTER_ROW + GIT_SPLITTER_ROW;

/** 工作区高度上限 = 容器高 - 历史最小 180 - 固定行 36；结果可小于 GIT_WS_MIN（此时容器不可用）。 */
export function maxWorkspaceHeight(containerHeight: number): number {
  return containerHeight - GIT_HISTORY_MIN - GIT_FIXED_ROWS;
}

/** 容器是否放得下分隔布局（历史 ≥180 + 工作区 ≥160 + 固定行 36）。 */
export function splitterUsable(containerHeight: number): boolean {
  return Number.isFinite(containerHeight) && maxWorkspaceHeight(containerHeight) >= GIT_WS_MIN;
}

/** clamp 到 [160, max(container-216, 160)]；container 非法（0/NaN/∞）时只 clamp 下限。 */
export function clampWorkspaceHeight(height: number, containerHeight: number): number {
  const max = splitterUsable(containerHeight)
    ? maxWorkspaceHeight(containerHeight)
    : Number.POSITIVE_INFINITY;
  const value = Number.isFinite(height) ? height : GIT_WS_DEFAULT;
  return Math.round(Math.min(Math.max(value, GIT_WS_MIN), max));
}

/**
 * 拖拽映射：工作区占据容器最底行，因此新高度 = 容器底部 - 指针 Y（相对容器顶部）。
 * splitterCenterY 为指针相对容器顶部的偏移；结果 clamp。
 */
export function workspaceHeightFromPointer(
  containerHeight: number,
  pointerOffsetFromTop: number,
): number {
  return clampWorkspaceHeight(containerHeight - pointerOffsetFromTop, containerHeight);
}

/** 键盘调整：ArrowUp 增大工作区、ArrowDown 减小（各 16px），Home 最小、End 最大。 */
export function workspaceHeightAfterKey(
  height: number,
  key: "ArrowUp" | "ArrowDown" | "Home" | "End",
  containerHeight: number,
): number {
  switch (key) {
    case "ArrowUp":
      return clampWorkspaceHeight(height + GIT_WS_KEY_STEP, containerHeight);
    case "ArrowDown":
      return clampWorkspaceHeight(height - GIT_WS_KEY_STEP, containerHeight);
    case "Home":
      return clampWorkspaceHeight(GIT_WS_MIN, containerHeight);
    case "End":
      return clampWorkspaceHeight(
        splitterUsable(containerHeight)
          ? maxWorkspaceHeight(containerHeight)
          : GIT_WS_DEFAULT,
        containerHeight,
      );
    default:
      return clampWorkspaceHeight(height, containerHeight);
  }
}

// ---------- 持久化（按 workspaceId；非法值回退默认 300，无历史兼容要求） ----------

export function workspaceHeightStorageKey(workspaceId: string): string {
  return `deer.git.workspaceHeight.${workspaceId}`;
}

export function loadWorkspaceHeight(
  workspaceId: string,
  containerHeight: number = Number.POSITIVE_INFINITY,
): number {
  try {
    const raw = localStorage.getItem(workspaceHeightStorageKey(workspaceId));
    if (raw === null) return clampWorkspaceHeight(GIT_WS_DEFAULT, containerHeight);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return clampWorkspaceHeight(GIT_WS_DEFAULT, containerHeight);
    return clampWorkspaceHeight(parsed, containerHeight);
  } catch {
    return clampWorkspaceHeight(GIT_WS_DEFAULT, containerHeight);
  }
}

export function saveWorkspaceHeight(workspaceId: string, height: number): void {
  try {
    localStorage.setItem(workspaceHeightStorageKey(workspaceId), String(Math.round(height)));
  } catch {
    /* localStorage 不可用时忽略（不阻塞 UI） */
  }
}

/** 布局容器上的 CSS 变量样式（驱动 grid 第 4 行）。 */
export function workspaceHeightStyle(height: number): CSSProperties {
  return { "--git-workspace-h": `${Math.round(height)}px` } as CSSProperties;
}
