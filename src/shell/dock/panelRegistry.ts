/**
 * t50 Dock 布局：面板注册表 + 默认布局 spec。
 *
 * t568/MF1-1：定义元数据搬到 src/shell/panel/panelManifest.ts（编译期 manifest）；
 * 本文件只做类型、派生 PANEL_DEFS 与布局工具，仍保持原公开 API。
 * DW1 rollback：恢复 dockview v1 DockStore/LAYOUT_KEYS 持久化，v2 store 不再读写。
 */
import { MIN_SPLIT_DOCK_WIDTH, NARROW_WINDOW_MAX } from "./narrowWindow";
import { PANEL_MANIFEST_INDEX } from "../panel/panelManifest";
import { LAYOUT_KEYS } from "../../shared/layoutPersistence.js";

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
  | "mergeQueue"
  | "console";

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

/** 由编译期 manifest 派生；保持旧的纯数据形状与 Object 顺序。 */
export const PANEL_DEFS: Record<PanelKey, PanelDef> = Object.fromEntries(
  (Object.keys(PANEL_MANIFEST_INDEX) as PanelKey[]).map((key) => {
    const manifest = PANEL_MANIFEST_INDEX[key];
    return [
      key,
      {
        key: manifest.key,
        title: manifest.title,
        component: manifest.component,
        routeTab: manifest.routeTab,
        renderer: manifest.renderer,
        minWidth: manifest.minWidth,
        minHeight: manifest.minHeight,
        closable: manifest.closable,
        defaultGroup: manifest.defaultGroup,
        defaultClosed: manifest.defaultClosed,
      },
    ];
  }),
) as Record<PanelKey, PanelDef>;

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
  return `${LAYOUT_KEYS.dockPrefix}${workspaceId}`;
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
