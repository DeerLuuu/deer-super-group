/**
 * t50 Dock 布局：面板注册表 + 默认布局 spec + 持久化（依据 docs/team/dock-layout-design.md §4/§8）。
 * 稳定 spec 只在本文件维护；dockview 的 toJSON 快照作为不透明负载存入 localStorage。
 */

export type RouteTabString =
  | "tasks"
  | "team"
  | "chat"
  | "mailbox"
  | "board"
  | "settings";

export type PanelKey =
  | "chat"
  | "team"
  | "context"
  | "tasks"
  | "mailbox"
  | "board"
  | "settings";

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
    routeTab: null,
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
    title: "黑板",
    component: "board",
    routeTab: "board",
    renderer: "onlyWhenVisible",
    minWidth: 360,
    minHeight: 280,
    closable: true,
    defaultGroup: "main",
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
};

/** 主组 tab 顺序（§5.3）：对话在前。 */
export const MAIN_GROUP_ORDER: PanelKey[] = [
  "chat",
  "tasks",
  "mailbox",
  "board",
  "settings",
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

/** §4.4：变体选择（自上而下匹配第一个满足的档位）。 */
export function selectVariant(dockWidth: number): DockVariant {
  if (dockWidth >= 1100) return "wide";
  if (dockWidth >= 900) return "medium";
  if (dockWidth >= 760) return "narrow";
  return "single";
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
