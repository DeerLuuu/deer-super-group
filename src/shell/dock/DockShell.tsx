/**
 * DW1-4（t556）：DockShell 只保留稳定契约与 v2 渲染器入口。
 *
 * - App 继续 import 默认 DockShell、DockHandle，契约不变；
 * - 自研 DockTree（DockShellV2）是唯一渲染器；
 * - 旧 renderer / v1 布局适配已删除。
 */
import DockShellV2 from "./DockShellV2";
import type { PanelKey } from "./panelRegistry";

export type DockHandle = {
  openPanel: (key: PanelKey) => void;
  getOpenPanelKeys: () => PanelKey[];
  closeActivePanel: () => void;
  resetLayout: () => void;
  resetAllLayouts: () => void;
  moveActivePanel: (direction: "left" | "right" | "above" | "below") => void;
  resizeActiveGroup: (delta: number) => void;
};

export type { DockShellV2Props as DockShellProps } from "./DockShellV2";

export default DockShellV2;
