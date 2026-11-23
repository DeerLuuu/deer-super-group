/**
 * MF1-1（t568）：面板编译期 loader 映射。
 *
 * - 只保留现有动态 import；不引入运行时微前端/iframe/module federation；
 * - panelManifest 引用本表，App 也引用同一张表，避免 loader 两处定义；
 * - eager 面板不在此表，manifest 用 eager descriptor 保持同步渲染。
 */
import type { ComponentType } from "react";

export type PanelLoader = () => Promise<{ default: ComponentType<any> }>;

export const PANEL_LOADERS = {
  planDraft: () => import("../PlanDraftPanel"),
  gitGraph: () => import("../../git/ui/GitGraphPanel"),
  mergeQueue: () =>
    import("../../git/ui/MergeQueuePanel").then((module) => ({
      default: module.MergeQueuePanel,
    })),
  team: () => import("../../TeamDashboard"),
  board: () => import("../MemoryWorkbench"),
  polls: () => import("../PollPanel"),
  settings: () => import("../../SettingsView"),
} satisfies Record<string, PanelLoader>;

export type LazyPanelKey = keyof typeof PANEL_LOADERS;

export function isLazyPanelKey(key: string): key is LazyPanelKey {
  return Object.prototype.hasOwnProperty.call(PANEL_LOADERS, key);
}
