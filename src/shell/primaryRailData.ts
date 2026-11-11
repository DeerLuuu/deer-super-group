import type { PanelKey } from "./dock/panelRegistry";

/** P0-2：五个一级入口；顺序即 rail 展示顺序。 */
export type PrimaryRailKey = Extract<PanelKey, "chat" | "tasks" | "team" | "board" | "mailbox">;

export type PrimaryRailEntry = {
  key: PrimaryRailKey;
  label: string;
  icon: string;
  title: string;
};

export const PRIMARY_RAIL_ENTRIES: readonly PrimaryRailEntry[] = [
  { key: "chat", label: "对话", icon: "◉", title: "对话（Chat）" },
  { key: "tasks", label: "任务", icon: "☰", title: "任务（Tasks）" },
  { key: "team", label: "团队", icon: "◈", title: "团队（Team）" },
  { key: "board", label: "记忆", icon: "▤", title: "记忆（Board）" },
  { key: "mailbox", label: "邮箱", icon: "✉", title: "邮箱（Mailbox）" },
];

const PRIMARY_RAIL_KEY_SET = new Set<string>(PRIMARY_RAIL_ENTRIES.map((entry) => entry.key));

export function isPrimaryRailKey(value: unknown): value is PrimaryRailKey {
  return typeof value === "string" && PRIMARY_RAIL_KEY_SET.has(value);
}

/**
 * 当前一级入口：优先 Dock 激活面板（仅五个入口之一），否则用 route tab。
 * runs/context/polls/watchdog/settings 不新增第二套状态，回退到 tab（runs→tasks）。
 */
export function railKeyForActive(
  activePanelKey: PanelKey | null | undefined,
  tab: string,
): PrimaryRailKey | null {
  if (activePanelKey && isPrimaryRailKey(activePanelKey)) return activePanelKey;
  if (isPrimaryRailKey(tab)) return tab;
  return null;
}

/**
 * 键盘方向键在 rail 内移动焦点（不触发打开）；Enter/Space 才打开。
 * 返回 null 表示该键不由 rail 处理。
 */
export function railFocusIndex(
  currentIndex: number,
  key: string,
  length: number,
): number | null {
  if (length <= 0) return null;
  if (key === "ArrowDown" || key === "ArrowRight") return (currentIndex + 1) % length;
  if (key === "ArrowUp" || key === "ArrowLeft") return (currentIndex - 1 + length) % length;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  return null;
}
