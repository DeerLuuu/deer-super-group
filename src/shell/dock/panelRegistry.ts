/**
 * t50 Dock 布局：面板注册表 + 默认布局 spec + 持久化（依据 docs/team/dock-layout-design.md §4/§8）。
 * 稳定 spec 只在本文件维护；dockview 的 toJSON 快照作为不透明负载存入 localStorage。
 */
import { MIN_SPLIT_DOCK_WIDTH, NARROW_WINDOW_MAX } from "./narrowWindow";

export type RouteTabString =
  | "tasks"
  | "team"
  | "chat"
  | "mailbox"
  | "board"
  | "settings"
  | "context"
  | "polls"
  | "watchdog";

export type PanelKey =
  | "chat"
  | "team"
  | "context"
  | "tasks"
  | "runs"
  | "mailbox"
  | "board"
  | "polls"
  | "watchdog"
  | "settings"
  | "planDraft"
  | "gitGraph"
  | "mergeQueue";

export type PanelDef = {
  key: PanelKey;
  title: string;
  component: string;
  /** 映射到 hash 路由的 tab；context 不进 hash。 */
  routeTab: RouteTabString | null;
  renderer: "always" | "onlyWhenVisible";
  minWidth: number;
  minHeight: number;
  closable: boolean;
  defaultGroup: "main" | "team";
  defaultClosed?: boolean;
};

/** §4.2 面板注册表（单例：每个 key 只有一个实例）。 */
export const PANEL_DEFS: Record<PanelKey, PanelDef> = {
  chat: {
    key: "chat",
    title: "对话",
    component: "chat",
    routeTab: "chat",
    renderer: "always",
    minWidth: 420,
    minHeight: 320,
    closable: true,
    defaultGroup: "main",
  },
  team: {
    key: "team",
    title: "团队",
    component: "team",
    routeTab: "team",
    renderer: "always",
    minWidth: 360,
    minHeight: 320,
    closable: true,
    defaultGroup: "team",
  },
  context: {
    key: "context",
    title: "上下文",
    component: "context",
    routeTab: "context",
    renderer: "always",
    minWidth: 280,
    minHeight: 240,
    closable: true,
    defaultGroup: "main",
    defaultClosed: true,
  },
  tasks: {
    key: "tasks",
    title: "任务",
    component: "tasks",
    routeTab: "tasks",
    renderer: "always",
    minWidth: 560,
    minHeight: 360,
    closable: true,
    defaultGroup: "main",
  },
  runs: {
    key: "runs",
    title: "运行",
    component: "runs",
    // t69：运行面板是任务域的子视图；打开时路由仍为 tasks，hash 用 r=<runId> 深链。
    routeTab: "tasks",
    renderer: "always",
    minWidth: 380,
    minHeight: 320,
    closable: true,
    defaultGroup: "main",
    // 默认布局不新增面板（设计 §9.5「Dock 布局不变」）；需要时从面板启动器/任务页打开。
    defaultClosed: true,
  },
  mailbox: {
    key: "mailbox",
    title: "邮箱",
    component: "mailbox",
    routeTab: "mailbox",
    renderer: "onlyWhenVisible",
    minWidth: 480,
    minHeight: 320,
    closable: true,
    defaultGroup: "main",
  },
  board: {
    key: "board",
    title: "记忆",
    component: "board",
    routeTab: "board",
    renderer: "onlyWhenVisible",
    minWidth: 360,
    minHeight: 280,
    closable: true,
    defaultGroup: "main",
  },
  polls: {
    key: "polls",
    title: "投票",
    component: "polls",
    routeTab: "polls",
    renderer: "onlyWhenVisible",
    minWidth: 430,
    minHeight: 320,
    closable: true,
    defaultGroup: "main",
    defaultClosed: true,
  },
  watchdog: {
    key: "watchdog",
    title: "看门狗",
    component: "watchdog",
    routeTab: "watchdog",
    renderer: "onlyWhenVisible",
    minWidth: 420,
    minHeight: 320,
    closable: true,
    defaultGroup: "main",
    defaultClosed: true,
  },
  planDraft: {
    key: "planDraft",
    title: "计划草案",
    component: "planDraft",
    // 草案由 Chat 入口显式打开，不新增 hash 路由。
    routeTab: null,
    renderer: "onlyWhenVisible",
    minWidth: 560,
    minHeight: 420,
    closable: true,
    defaultGroup: "main",
    defaultClosed: true,
  },
  settings: {
    key: "settings",
    title: "设置",
    component: "settings",
    routeTab: "settings",
    renderer: "onlyWhenVisible",
    minWidth: 560,
    minHeight: 400,
    closable: false, // §7.4：设置本地草稿保护，v1 不可关闭
    defaultGroup: "main",
  },
  gitGraph: {
    key: "gitGraph",
    title: "版本图",
    component: "gitGraph",
    routeTab: null,
    renderer: "onlyWhenVisible",
    minWidth: 360,
    minHeight: 300,
    closable: true,
    defaultGroup: "main",
    defaultClosed: true,
  },
  mergeQueue: {
    key: "mergeQueue",
    title: "合并队列",
    component: "mergeQueue",
    // 队列面板是任务域的高频子视图；打开时路由仍为 tasks，?merge=1 深链负责恢复。
    routeTab: null,
    renderer: "onlyWhenVisible",
    minWidth: 360,
    minHeight: 320,
    closable: true,
    defaultGroup: "main",
    defaultClosed: true,
  },
};

/** 主组 tab 顺序（§5.3）：对话在前。 */
export const MAIN_GROUP_ORDER: PanelKey[] = [
  "chat",
  "tasks",
  "mailbox",
  "board",
];

export type DockVariant = "wide" | "medium" | "narrow" | "single";

/** §5.1 比例。 */
export const VARIANT_WEIGHTS: Record<
  DockVariant,
  { main: number; team: number }
> = {
  wide: { main: 58, team: 42 },
  medium: { main: 56, team: 44 },
  narrow: { main: 52, team: 48 },
  single: { main: 100, team: 0 },
};

/**
 * §4.4 + t194：变体选择。
 *
 * - 窗口 ≤960（960/900/760 及 Electron 最小窗）一律 single：即使侧栏折叠后 Dock 变宽，
 *   也不回到 narrow/medium 的 right split（否则 Tasks 560 + Team 360 会互相挤压）。
 * - 非 single 需同时容纳 Tasks 主组（≥560）与 Team 右组（≥360），Dock <920 直接 single；
 *   因此旧 narrow（760–900）在「Task 始终存在」前提下不再产生，保留类型只为兼容旧布局存档。
 * - 1440（Dock≈1190）→ wide；1100 默认侧栏折叠（Dock≈1036）→ medium，保持既有行为。
 */
export function selectVariant(
  dockWidth: number,
  windowWidth: number = Number.POSITIVE_INFINITY,
): DockVariant {
  if (windowWidth <= NARROW_WINDOW_MAX) return "single";
  // 兼容既有纯 Dock 宽度调用（旧布局存档/单测）：不传 windowWidth 时保留 760/900/1100 档位。
  if (!Number.isFinite(windowWidth)) {
    if (dockWidth >= 1100) return "wide";
    if (dockWidth >= 900) return "medium";
    if (dockWidth >= 760) return "narrow";
    return "single";
  }
  if (dockWidth < MIN_SPLIT_DOCK_WIDTH) return "single";
  if (dockWidth >= 1100) return "wide";
  return "medium";
}

/**
 * 面板插入位置：single 变体一律 within（tab），非 single 时 Team 保持右侧分栏。
 * Team 在 single 下不再强制 right split（t194/P0-1）。
 */
export function panelInsertDirection(
  variant: DockVariant,
  key: PanelKey,
): "right" | "within" {
  return variant !== "single" && key === "team" ? "right" : "within";
}

// ---------- 持久化（§8） ----------

export type DockStore = {
  schema: "deer.dock.state";
  version: 1;
  updatedAt: string;
  variants: Partial<
    Record<DockVariant, { layout: unknown; activePanel: string | null }>
  >;
};

export function storageKey(workspaceId: string): string {
  return `deer.dock.v1.${workspaceId}`;
}

const MAX_STORE_BYTES = 64 * 1024;

export function loadStore(workspaceId: string): DockStore | null {
  try {
    const raw = localStorage.getItem(storageKey(workspaceId));
    if (!raw) return null;
    if (raw.length > MAX_STORE_BYTES) throw new Error("oversized");
    const parsed = JSON.parse(raw) as DockStore;
    if (parsed?.schema !== "deer.dock.state" || parsed?.version !== 1) {
      throw new Error("schema mismatch");
    }
    if (typeof parsed.variants !== "object" || parsed.variants === null) {
      throw new Error("bad variants");
    }
    return parsed;
  } catch {
    // §8.3：损坏 → 删除并回退默认
    try {
      localStorage.removeItem(storageKey(workspaceId));
    } catch {
      /* ignore */
    }
    return null;
  }
}

export function saveStore(workspaceId: string, store: DockStore): boolean {
  try {
    const payload = JSON.stringify(store);
    if (payload.length > MAX_STORE_BYTES) return false;
    localStorage.setItem(storageKey(workspaceId), payload);
    return true;
  } catch {
    return false;
  }
}

export function clearStore(workspaceId: string): void {
  try {
    localStorage.removeItem(storageKey(workspaceId));
  } catch {
    /* ignore */
  }
}

export function routeTabFromPanel(key: PanelKey): RouteTabString | null {
  return PANEL_DEFS[key].routeTab;
}
