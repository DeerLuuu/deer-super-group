/**
 * DW1-3（t548）：v2 Dock Shell——消费 useDockLayoutController + DockTree。
 *
 * - DockHandle 与 legacy DockShell 同契约（App 零改动）；
 * - 命令全部经 controller.dispatch（reduceDock 唯一入口）；
 * - 断点：selectVariant(dockWidth, windowWidth) → controller variant effect 切换；
 * - 键盘沿用 t56 改键（Ctrl+Shift+Alt+方向/Ctrl+Shift+Alt+[]/Ctrl+Alt+W）；
 * - settings 不可关闭（reducer 守卫 + notify）；planDraft 关闭走 onPanelClose。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { PANEL_DEFS, selectVariant, type DockVariant, type PanelKey } from "./panelRegistry";
import { useDockLayoutController } from "./layoutOps";
import type { DockLayout } from "./layoutModel";
import { listGroups } from "./layoutModel";
import DockTree from "./DockTree";
import "./dockLayout.css";
import type { DockHandle } from "./DockShell";

type MoveDirection = "left" | "right" | "above" | "below";

export interface DockShellV2Props {
  workspaceId: string;
  dockWidth: number;
  windowWidth: number;
  maxGroups: number;
  initialPanelKey: PanelKey | null;
  onActivePanelChange: (key: PanelKey) => void;
  onPanelClose?: (key: PanelKey) => void;
  onNotify?: (message: string) => void;
}

const DockShellV2 = forwardRef<DockHandle, DockShellV2Props>(function DockShellV2(
  {
    workspaceId,
    dockWidth,
    windowWidth,
    maxGroups,
    initialPanelKey,
    onActivePanelChange,
    onPanelClose,
    onNotify,
  },
  ref,
) {
  const variant = selectVariant(dockWidth, windowWidth);
  const controller = useDockLayoutController({
    workspaceId,
    variant,
    maxGroups,
    onNotify,
    onActivatedPanel: onActivePanelChange,
  });
  const { dispatch, setVariant, resetAll, flush } = controller;

  const onActivePanelChangeRef = useRef(onActivePanelChange);
  onActivePanelChangeRef.current = onActivePanelChange;
  const onPanelCloseRef = useRef(onPanelClose);
  onPanelCloseRef.current = onPanelClose;
  const onNotifyRef = useRef(onNotify);
  onNotifyRef.current = onNotify;
  const layoutRef = useRef<DockLayout>(controller.layout);
  layoutRef.current = controller.layout;

  // 初始深链面板（不在布局时插入当前 active group 并激活——t52 IF-03）。
  const initialHandledRef = useRef(false);
  useEffect(() => {
    if (initialHandledRef.current || !initialPanelKey) return;
    initialHandledRef.current = true;
    dispatch({ type: "open", panel: initialPanelKey, cause: "deep-link" });
  }, [initialPanelKey, dispatch]);

  // 断点切换（controller variant effect 自动 setVariant；此处仅对齐 Dock 宽度语义）。
  useEffect(() => {
    void setVariant;
  }, [setVariant, variant]);

  const onActivate = useCallback(
    (panel: PanelKey) => dispatch({ type: "activate", panel }),
    [dispatch],
  );
  const onClose = useCallback(
    (panel: PanelKey) => {
      if (!PANEL_DEFS[panel].closable) {
        onNotifyRef.current?.(`「${PANEL_DEFS[panel].title}」不可关闭`);
        return;
      }
      onPanelCloseRef.current?.(panel);
      dispatch({ type: "close", panel });
    },
    [dispatch],
  );
  const onResize = useCallback(
    (splitId: string, index: number, delta: number) =>
      dispatch({ type: "resize", splitId, index, delta }),
    [dispatch],
  );
  const onDrop = useCallback(
    (
      panel: PanelKey,
      target: PanelKey,
      position: "center" | "left" | "right" | "above" | "below",
    ) =>
      dispatch({
        type: "dragDrop",
        panel,
        target,
        position: position === "center" ? "center" : "edge",
        ...(position !== "center" ? { edge: position } : {}),
      }),
    [dispatch],
  );

  function findAdjacentTarget(
    panel: PanelKey,
    direction: MoveDirection,
  ): { target: PanelKey; center: boolean } | null {
    // v2 无 dockview 相邻查询：用布局树顺序近似——按方向找同 split 的相邻 group。
    const groups = listGroups(layoutRef.current.root);
    const ownIndex = groups.findIndex((group) => group.panels.includes(panel));
    const own = groups[ownIndex];
    if (!own) return null;
    const horizontal = direction === "left" || direction === "right";
    const step = direction === "left" || direction === "above" ? -1 : 1;
    let candidate = ownIndex + step;
    while (candidate >= 0 && candidate < groups.length) {
      const group = groups[candidate];
      const sameAxis = horizontal; // 顶层 split 默认 horizontal；vertical 嵌套按同轴近似
      if (sameAxis) return { target: group.active ?? group.panels[0], center: true };
      candidate += step;
    }
    return null;
  }

  useImperativeHandle(ref, () => ({
    openPanel(key) {
      dispatch({ type: "open", panel: key, cause: "nav", anchor: "chat" });
    },
    getOpenPanelKeys() {
      return listGroups(layoutRef.current.root).flatMap((group) => group.panels);
    },
    closeActivePanel() {
      const groups = listGroups(layoutRef.current.root);
      const active = groups.find((group) => group.active)?.active ?? groups[0]?.active;
      if (!active) return;
      if (!PANEL_DEFS[active].closable) {
        onNotifyRef.current?.("设置面板不可关闭（保护未保存的配置草稿）");
        return;
      }
      onPanelCloseRef.current?.(active);
      dispatch({ type: "close", panel: active });
    },
    resetLayout() {
      dispatch({ type: "reset" });
      onNotifyRef.current?.("已恢复默认布局");
    },
    resetAllLayouts() {
      resetAll();
      onNotifyRef.current?.("已重置所有布局");
    },
    moveActivePanel(direction: MoveDirection) {
      const groups = listGroups(layoutRef.current.root);
      const active = groups.find((group) => group.active)?.active ?? groups[0]?.active;
      if (!active) return;
      const adjacent = findAdjacentTarget(active, direction);
      if (adjacent) {
        dispatch({ type: "move", panel: active, target: adjacent.target, position: "center" });
      } else {
        dispatch({ type: "split", panel: active, direction });
      }
    },
    resizeActiveGroup(delta: number) {
      // 键盘调宽：作用于包含 active 面板的第一个祖先 split 的对应 index。
      const layout = layoutRef.current;
      const groups = listGroups(layout.root);
      const activeGroup = groups.find((group) => group.active);
      if (!activeGroup) return;
      function findParentSplit(
        node: typeof layout.root,
        groupId: string,
      ): { split: { id: string }; index: number } | null {
        if (node.kind === "group") return null;
        for (let index = 0; index < node.children.length; index += 1) {
          const child = node.children[index];
          if (child.kind === "group" && child.id === groupId) {
            return { split: { id: node.id }, index };
          }
          const nested = findParentSplit(child, groupId);
          if (nested) return nested;
        }
        return null;
      }
      const parent = findParentSplit(layout.root, activeGroup.id);
      if (parent) {
        dispatch({
          type: "resize",
          splitId: parent.split.id,
          index: parent.index,
          delta: delta / 1000,
        });
      }
    },
  }));

  // 键盘：与 legacy 相同的 t56 改键。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const handle = ref as React.RefObject<DockHandle | null>;
      if (event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey) {
        if (event.key === "w" || event.key === "W") {
          event.preventDefault();
          handle.current?.closeActivePanel();
        }
        return;
      }
      if (event.ctrlKey && event.altKey && event.shiftKey && !event.metaKey) {
        const handleKeys: Record<string, MoveDirection> = {
          ArrowLeft: "left",
          ArrowRight: "right",
          ArrowUp: "above",
          ArrowDown: "below",
        };
        const direction = handleKeys[event.key];
        if (direction) {
          event.preventDefault();
          handle.current?.moveActivePanel(direction);
          return;
        }
        if (event.key === "[") {
          event.preventDefault();
          handle.current?.resizeActiveGroup(-40);
        } else if (event.key === "]") {
          event.preventDefault();
          handle.current?.resizeActiveGroup(40);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ref]);

  // 卸载 flush。
  useEffect(() => () => flush(), [flush]);

  return (
    <div className="docktree-shell" data-engine="v2" data-dock-engine-note="DW1-3">
      <DockTree
        layout={controller.layout}
        onActivate={onActivate}
        onClose={onClose}
        onResize={onResize}
        onDrop={onDrop}
        onPanelClose={onPanelClose}
      />
    </div>
  );
});

export default DockShellV2;
