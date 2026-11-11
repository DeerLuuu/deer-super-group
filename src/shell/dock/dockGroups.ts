import { normalizeMaxDockGroups } from "../../shared/types.js";

/**
 * t208：Dock 最大分栏数（2–8，默认 6）。
 * 设置页只负责写 LayoutSettings；DockShell 每次渲染取当前值，不重建布局。
 */
export function effectiveMaxDockGroups(value: unknown): number {
  return normalizeMaxDockGroups(value);
}

/** 当前已有 currentGroups 组时，是否还允许再拆一组。 */
export function canAddDockGroup(currentGroups: number, maxGroups: unknown): boolean {
  return currentGroups < effectiveMaxDockGroups(maxGroups);
}

export function dockGroupLimitMessage(maxGroups: unknown): string {
  return `最多 ${effectiveMaxDockGroups(maxGroups)} 个分栏，请先拖回合并`;
}
