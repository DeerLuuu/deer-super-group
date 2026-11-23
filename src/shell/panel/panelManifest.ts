/**
 * MF1-1（t568）：编译期 PanelManifest。
 *
 * 单一来源：标题/默认分组/尺寸/renderer/关闭性/routeTab/loader/能力边界。
 * panelRegistry.PANEL_DEFS 由本表派生；App 的 lazy loader 也复用 panelLoaders。
 * 不包含远程 URL；运行时只查表，不 fetch 配置。
 */
import type { PanelDef, PanelKey } from "../dock/panelRegistry";
import { PANEL_LOADERS, type LazyPanelKey } from "./panelLoaders";

export type PanelGroup = "work" | "team" | "git" | "aux" | "settings";

export type PanelLoaderDescriptor =
  | { kind: "lazy"; load: (typeof PANEL_LOADERS)[LazyPanelKey] }
  | { kind: "eager"; component: string };

export interface PanelCapabilities {
  reads: string[];
  writes: string[];
  requiresPermission?: string;
}

export interface PanelManifest extends PanelDef {
  /** 面板契约版本，不是应用版本。 */
  version: 1;
  group: PanelGroup;
  icon: string;
  loader: PanelLoaderDescriptor;
  capabilities: PanelCapabilities;
}

const lazy = (key: LazyPanelKey): PanelLoaderDescriptor => ({
  kind: "lazy",
  load: PANEL_LOADERS[key],
});
const eager = (component: string): PanelLoaderDescriptor => ({ kind: "eager", component });

const caps = (reads: string[], writes: string[] = []): PanelCapabilities => ({ reads, writes });

/** §5.4 面板 manifest；顺序不参与默认布局（默认布局由 MAIN_GROUP_ORDER 决定）。 */
export const PANEL_MANIFESTS = [
  {
    key: "chat",
    version: 1,
    title: "对话",
    component: "chat",
    routeTab: "chat",
    renderer: "always",
    minWidth: 420,
    minHeight: 320,
    closable: true,
    defaultGroup: "main",
    group: "work",
    icon: "chat",
    loader: eager("chat"),
    capabilities: caps(["chat.read"], ["chat.write"]),
  },
  {
    key: "team",
    version: 1,
    title: "团队",
    component: "team",
    routeTab: "team",
    renderer: "always",
    minWidth: 360,
    minHeight: 320,
    closable: true,
    defaultGroup: "team",
    group: "team",
    icon: "team",
    loader: lazy("team"),
    capabilities: caps(["team.read"], ["team.write"]),
  },
  {
    key: "context",
    version: 1,
    title: "上下文",
    component: "context",
    routeTab: "context",
    renderer: "always",
    minWidth: 280,
    minHeight: 240,
    closable: true,
    defaultGroup: "main",
    defaultClosed: true,
    group: "aux",
    icon: "context",
    loader: eager("context"),
    capabilities: caps(["task.context"]),
  },
  {
    key: "tasks",
    version: 1,
    title: "任务",
    component: "tasks",
    routeTab: "tasks",
    renderer: "always",
    minWidth: 560,
    minHeight: 360,
    closable: true,
    defaultGroup: "main",
    group: "work",
    icon: "tasks",
    loader: eager("tasks"),
    capabilities: caps(["tasks.read"], ["tasks.write"]),
  },
  {
    key: "runs",
    version: 1,
    title: "运行",
    component: "runs",
    routeTab: "tasks",
    renderer: "always",
    minWidth: 380,
    minHeight: 320,
    closable: true,
    defaultGroup: "main",
    defaultClosed: true,
    group: "work",
    icon: "runs",
    loader: eager("runs"),
    capabilities: caps(["runs.read"]),
  },
  {
    key: "mailbox",
    version: 1,
    title: "邮箱",
    component: "mailbox",
    routeTab: "mailbox",
    renderer: "onlyWhenVisible",
    minWidth: 480,
    minHeight: 320,
    closable: true,
    defaultGroup: "main",
    group: "work",
    icon: "mailbox",
    loader: eager("mailbox"),
    capabilities: caps(["mailbox.read"], ["mailbox.write"]),
  },
  {
    key: "board",
    version: 1,
    title: "记忆",
    component: "board",
    routeTab: "board",
    renderer: "onlyWhenVisible",
    minWidth: 360,
    minHeight: 280,
    closable: true,
    defaultGroup: "main",
    group: "work",
    icon: "board",
    loader: lazy("board"),
    capabilities: caps(["board.read"], ["board.write"]),
  },
  {
    key: "polls",
    version: 1,
    title: "投票",
    component: "polls",
    routeTab: "polls",
    renderer: "onlyWhenVisible",
    minWidth: 430,
    minHeight: 320,
    closable: true,
    defaultGroup: "main",
    defaultClosed: true,
    group: "aux",
    icon: "polls",
    loader: lazy("polls"),
    capabilities: caps(["polls.read"], ["polls.write"]),
  },
  {
    key: "watchdog",
    version: 1,
    title: "看门狗",
    component: "watchdog",
    routeTab: "watchdog",
    renderer: "onlyWhenVisible",
    minWidth: 420,
    minHeight: 320,
    closable: true,
    defaultGroup: "main",
    defaultClosed: true,
    group: "aux",
    icon: "watchdog",
    loader: eager("watchdog"),
    capabilities: caps(["watchdog.read"]),
  },
  {
    key: "planDraft",
    version: 1,
    title: "计划草案",
    component: "planDraft",
    routeTab: null,
    renderer: "onlyWhenVisible",
    minWidth: 560,
    minHeight: 420,
    closable: true,
    defaultGroup: "main",
    defaultClosed: true,
    group: "work",
    icon: "planDraft",
    loader: lazy("planDraft"),
    capabilities: caps(["plan.read"], ["plan.write"]),
  },
  {
    key: "settings",
    version: 1,
    title: "设置",
    component: "settings",
    routeTab: "settings",
    renderer: "onlyWhenVisible",
    minWidth: 560,
    minHeight: 400,
    closable: false,
    defaultGroup: "main",
    group: "settings",
    icon: "settings",
    loader: lazy("settings"),
    capabilities: caps(["settings.read"], ["settings.write"]),
  },
  {
    key: "gitGraph",
    version: 1,
    title: "版本图",
    component: "gitGraph",
    routeTab: null,
    renderer: "onlyWhenVisible",
    minWidth: 360,
    minHeight: 300,
    closable: true,
    defaultGroup: "main",
    defaultClosed: true,
    group: "git",
    icon: "gitGraph",
    loader: lazy("gitGraph"),
    capabilities: caps(["git.read"]),
  },
  {
    key: "mergeQueue",
    version: 1,
    title: "合并队列",
    component: "mergeQueue",
    routeTab: null,
    renderer: "onlyWhenVisible",
    minWidth: 360,
    minHeight: 320,
    closable: true,
    defaultGroup: "main",
    defaultClosed: true,
    group: "git",
    icon: "mergeQueue",
    loader: lazy("mergeQueue"),
    capabilities: caps(["git.read", "mergeQueue.read"], ["mergeQueue.operate"]),
  },
  {
    key: "console",
    version: 1,
    title: "控制台",
    component: "console",
    routeTab: null,
    renderer: "onlyWhenVisible",
    minWidth: 420,
    minHeight: 320,
    closable: true,
    defaultGroup: "main",
    defaultClosed: true,
    group: "aux",
    icon: "console",
    loader: eager("console"),
    capabilities: caps(["console.read"], ["console.write"]),
  },
] as const satisfies readonly PanelManifest[];

/** 运行时只查表，不做远程配置拉取。 */
export function indexPanelManifests(
  manifests: readonly PanelManifest[] = PANEL_MANIFESTS,
): Record<PanelKey, PanelManifest> {
  const index = {} as Record<PanelKey, PanelManifest>;
  for (const manifest of manifests) {
    if (index[manifest.key]) {
      throw new Error(`duplicate panel manifest: ${manifest.key}`);
    }
    index[manifest.key] = manifest;
  }
  return index;
}

export function getPanelManifest(key: string): PanelManifest | null {
  return Object.prototype.hasOwnProperty.call(PANEL_MANIFEST_INDEX, key)
    ? PANEL_MANIFEST_INDEX[key as PanelKey]
    : null;
}

export const PANEL_MANIFEST_INDEX = indexPanelManifests(PANEL_MANIFESTS);
