/**
 * DW1-3（t548）：DockDropZone——拖放目标区域。
 * center = 合并为 tab；edge（left/right/above/below）= 相对目标组拆分。
 * 由 DockGroup body 挂载；dragover 高亮、drop 冒泡带 data-dropzone 判定位置。
 */
import type { DragEvent } from "react";
import type { PanelKey } from "./panelRegistry";

export type DropPosition = "center" | "left" | "right" | "above" | "below";

export interface DockDropZoneProps {
  position: Exclude<DropPosition, "center">;
  /** drop 目标面板（组 active）。 */
  target: PanelKey;
  onDrop: (panel: PanelKey, target: PanelKey, position: DropPosition) => void;
}

export default function DockDropZone({ position, target, onDrop }: DockDropZoneProps) {
  "use no memo";
  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
  }
  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const panel = event.dataTransfer.getData("application/x-deer-panel") as PanelKey;
    if (panel && panel !== target) onDrop(panel, target, position);
  }
  return (
    <div
      className={`docktree-dropzone edge ${position}`}
      data-dropzone={position}
      aria-hidden="true"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    />
  );
}
