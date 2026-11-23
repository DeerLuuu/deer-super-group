/**
 * DW1-3（t548）：DockGroup——tablist + 激活面板 + 拖放区域。
 * - tab 顺序 = group.panels；active 高亮；roving tabIndex（active 0 其余 -1）；
 * - Arrow/Home/End 在组内移动焦点（键盘激活）；settings 无关闭按钮（closable=false）；
 * - PanelHost 只挂 active 面板（renderer 规则/懒加载由 PanelHost 内部处理）；
 * - tab 可拖拽（HTML5 DnD）→ DockDropZone 显示 center/edge 目标。
 * - 错误边界：面板渲染异常显示内联错误，不拖垮整棵 Dock 树。
 */
import { Component, useRef, type DragEvent, type ReactNode } from "react";
import { PanelHost } from "../panel/PanelHost";
import type { PanelDef, PanelKey } from "./panelRegistry";
import type { LayoutGroup } from "./layoutModel";
import DockDropZone from "./DockDropZone";

interface GroupErrorBoundaryProps {
  panelKey: PanelKey;
  children: ReactNode;
}
interface GroupErrorBoundaryState {
  error: Error | null;
}
class PanelErrorBoundary extends Component<GroupErrorBoundaryProps, GroupErrorBoundaryState> {
  state: GroupErrorBoundaryState = { error: null };
  static getDerivedStateFromError(error: Error): GroupErrorBoundaryState {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="docktree-panel-error" role="alert">
          面板「{this.props.panelKey}」渲染出错：{String(this.state.error.message ?? this.state.error)}
        </div>
      );
    }
    return this.props.children;
  }
}

export interface DockGroupProps {
  group: LayoutGroup;
  panelDefs: Record<PanelKey, PanelDef>;
  onActivate: (panel: PanelKey) => void;
  onClose: (panel: PanelKey) => void;
  onDrop: (
    panel: PanelKey,
    target: PanelKey,
    position: "center" | "left" | "right" | "above" | "below",
  ) => void;
}

export default function DockGroup({
  group,
  panelDefs,
  onActivate,
  onClose,
  onDrop,
}: DockGroupProps) {
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([]);
  // t555/F3：always panel 常驻；onlyWhenVisible 首次激活后 keepalive（不卸载）。
  const mountedRef = useRef<Set<PanelKey>>(new Set());

  function focusTab(index: number) {
    const clamped = Math.max(0, Math.min(group.panels.length - 1, index));
    tabsRef.current[clamped]?.focus();
  }

  function onTabKeyDown(event: React.KeyboardEvent, index: number) {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      focusTab(index + 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      focusTab(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusTab(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusTab(group.panels.length - 1);
    } else if (event.key === "Delete") {
      const panel = group.panels[index];
      if (panelDefs[panel].closable) onClose(panel);
    }
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
  }

  function onDropEvent(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const panel = event.dataTransfer.getData("application/x-deer-panel") as PanelKey;
    if (!panel) return;
    const edge = (event.currentTarget as HTMLElement).dataset.dropzone;
    onDrop(panel, group.active ?? group.panels[0], (edge || "center") as "center");
  }

  const active = group.active ?? group.panels[0] ?? null;

  return (
    <section className="docktree-group" data-group={group.id} aria-label="面板组">
      <div className="docktree-tabs-bar">
        <div className="docktree-tabs" role="tablist" aria-label={`面板组 ${group.id}`}>
          {group.panels.map((panel, index) => {
            const def = panelDefs[panel];
            const isActive = panel === active;
            return (
              <button
                key={panel}
                ref={(node) => {
                  tabsRef.current[index] = node;
                }}
                type="button"
                role="tab"
                id={`docktree-tab-${group.id}-${panel}`}
                aria-selected={isActive}
                aria-controls={`docktree-panel-${group.id}-${panel}`}
                tabIndex={isActive ? 0 : -1}
                className={isActive ? "docktree-tab active" : "docktree-tab"}
                data-panel={panel}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData("application/x-deer-panel", panel);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onClick={() => onActivate(panel)}
                onKeyDown={(event) => onTabKeyDown(event, index)}
              >
                <span className="docktree-tab-title">{def.title}</span>
              </button>
            );
          })}
        </div>
        {active && panelDefs[active].closable ? (
          // t555/F1：close 放在 tablist 外，原生 button、Tab 可达；tab 内不再画可点 ×。
          <button
            type="button"
            className="docktree-group-close"
            aria-label={`关闭${panelDefs[active].title}`}
            title={`关闭${panelDefs[active].title}（Delete）`}
            onClick={() => onClose(active)}
          >
            ×
          </button>
        ) : null}
      </div>
      <div
        className="docktree-body"
        role="presentation"
        onDragOver={onDragOver}
        onDrop={onDropEvent}
        data-dropzone="center"
      >
        {group.panels.map((panel) => {
          const isActive = panel === active;
          // t555/F3：always 常驻；onlyWhenVisible 首次激活时挂载，之后 hidden keepalive。
          const isMounted =
            panelDefs[panel].renderer === "always" ||
            panel === active ||
            mountedRef.current.has(panel);
          if (isMounted) mountedRef.current.add(panel);
          // t550/F3：非激活 PanelHost 用 hidden 保留挂载，切 tab 不丢草稿/输入/滚动状态；
          // t550/F4：每个 tab 的 aria-controls 始终有真实 tabpanel（隐藏但存在）。
          return (
            <div
              key={panel}
              id={`docktree-panel-${group.id}-${panel}`}
              role="tabpanel"
              aria-labelledby={`docktree-tab-${group.id}-${panel}`}
              className={`docktree-panel${isActive ? " active" : ""}`}
              data-panel={panel}
              data-mounted={isMounted ? "true" : "false"}
              hidden={!isActive}
            >
              {isMounted ? (
                <PanelErrorBoundary panelKey={panel}>
                  <PanelHost panelKey={panel} />
                </PanelErrorBoundary>
              ) : null}
            </div>
          );
        })}
        {/* 边缘 dropzone 指示（CSS hover 高亮；drop 事件冒泡到 body 用 data-dropzone 判定）。 */}
        {(["left", "right", "above", "below"] as const).map((position) => (
          <DockDropZone
            key={position}
            position={position}
            target={group.active ?? group.panels[0]}
            onDrop={onDrop}
          />
        ))}
      </div>
    </section>
  );
}
