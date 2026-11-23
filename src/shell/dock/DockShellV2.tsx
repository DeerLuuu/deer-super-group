/**
 * DW1-3（t548）：v2 Dock Shell——消费 useDockLayoutController + DockTree。
 *
 * - DockHandle 与 legacy DockShell 同契约（App 零改动）；
 * - 命令全部经 controller.dispatch（reduceDock 唯一入口）；
 * - 断点：selectVariant(dockWidth, windowWidth) → controller variant effect 切换；
 * - 键盘沿用 t56 改键（Ctrl+Shift+Alt+方向/Ctrl+Shift+Alt+[]/Ctrl+Alt+W）；
 * - settings 不可关闭（reducer 守卫 + notify）；planDraft 关闭走 onPanelClose。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { PANEL_DEFS, selectVariant, type DockVariant, type PanelKey } from "./panelRegistry";
import { useDockLayoutController } from "./layoutOps";
import type { DockLayout, LayoutGroup, LayoutNode, LayoutSplit } from "./layoutModel";
import { listGroups } from "./layoutModel";
import DockTree from "./DockTree";
import "./dockLayout.css";
import type { DockHandle } from "./DockShell";

type MoveDirection = "left" | "right" | "above" | "below";

function edgeGroup(node: LayoutNode, side: "start" | "end"): LayoutGroup | null {
  if (node.kind === "group") return node;
  const child = side === "start" ? node.children[0] : node.children[node.children.length - 1];
  return child ? edgeGroup(child, side) : null;
}

/**
 * t555/F2：按树 split 轴和父链找真正相邻的组，而不是扁平 group 顺序。
 * 例如 root horizontal [main, vertical [team, settings]]，team 的 below 是 settings；
 * 只有同轴祖先 split 的兄弟子树才构成方向邻居。
 */
export function findAdjacentPanelInLayout(
  layout: DockLayout,
  panel: PanelKey,
  direction: MoveDirection,
): PanelKey | null {
  const path: Array<{ split: LayoutSplit; index: number }> = [];
  function locate(node: LayoutNode): boolean {
    if (node.kind === "group") return node.panels.includes(panel);
    for (let index = 0; index < node.children.length; index += 1) {
      path.push({ split: node, index });
      if (locate(node.children[index]!)) return true;
      path.pop();
    }
    return false;
  }
  if (!locate(layout.root)) return null;
  const axis = direction === "left" || direction === "right" ? "horizontal" : "vertical";
  const step = direction === "left" || direction === "above" ? -1 : 1;
  for (let cursor = path.length - 1; cursor >= 0; cursor -= 1) {
    const entry = path[cursor]!;
    if (entry.split.axis !== axis) continue;
    const sibling = entry.split.children[entry.index + step];
    if (!sibling) continue;
    const target = edgeGroup(sibling, step > 0 ? "start" : "end");
    if (!target) continue;
    return target.active ?? target.panels[0] ?? null;
  }
  return null;
}

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
  // t550/F1：记录用户最近聚焦的组/面板，而不是永远取第一个 group.active。
  const [activePanel, setActivePanel] = useState<PanelKey | null>(initialPanelKey);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  // 命令在键盘/ref 回调中执行时可能早于 state commit；ref 作为同步真相。
  const activePanelRef = useRef<PanelKey | null>(initialPanelKey);
  const activeGroupIdRef = useRef<string | null>(null);
  const controller = useDockLayoutController({
    workspaceId,
    variant,
    maxGroups,
    onNotify,
    onActivatedPanel: (panel) => {
      const group = listGroups(layoutRef.current.root).find((item) =>
        item.panels.includes(panel),
      );
      activePanelRef.current = panel;
      if (group) activeGroupIdRef.current = group.id;
      if (group) setActiveGroupId(group.id);
      setActivePanel(panel);
      onActivePanelChange(panel);
    },
  });
  const { dispatch, setVariant, resetAll, flush } = controller;

  const onPanelCloseRef = useRef(onPanelClose);
  onPanelCloseRef.current = onPanelClose;
  const onNotifyRef = useRef(onNotify);
  onNotifyRef.current = onNotify;
  const layoutRef = useRef<DockLayout>(controller.layout);
  layoutRef.current = controller.layout;

  const rememberGroup = useCallback((groupId: string) => {
    const group = listGroups(layoutRef.current.root).find((item) => item.id === groupId);
    if (!group) return;
    activeGroupIdRef.current = group.id;
    activePanelRef.current = group.active ?? group.panels[0] ?? null;
    setActiveGroupId(group.id);
    setActivePanel(group.active ?? group.panels[0] ?? null);
  }, []);

  const rememberPanel = useCallback((panel: PanelKey) => {
    const group = listGroups(layoutRef.current.root).find((item) =>
      item.panels.includes(panel),
    );
    if (group) activeGroupIdRef.current = group.id;
    activePanelRef.current = panel;
    if (group) setActiveGroupId(group.id);
    setActivePanel(panel);
  }, []);

  const rememberFromTarget = useCallback(
    (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      if (!element || typeof element.closest !== "function") return;
      const groupElement = element.closest("[data-group]");
      const groupId = groupElement?.getAttribute("data-group");
      if (groupId) rememberGroup(groupId);
    },
    [rememberGroup],
  );

  // 布局变化（首次加载/断点/关闭）时，保证记录值仍指向现存的组和面板。
  useEffect(() => {
    const groups = listGroups(controller.layout.root);
    if (groups.length === 0) return;
    const group =
      groups.find((item) => item.id === activeGroupIdRef.current) ??
      groups.find((item) => activePanelRef.current && item.panels.includes(activePanelRef.current)) ??
      groups[0];
    if (!group) return;
    if (activeGroupIdRef.current !== group.id) {
      activeGroupIdRef.current = group.id;
      setActiveGroupId(group.id);
    }
    const panel =
      activePanelRef.current && group.panels.includes(activePanelRef.current)
        ? activePanelRef.current
        : (group.active ?? group.panels[0] ?? null);
    if (activePanelRef.current !== panel) {
      activePanelRef.current = panel;
      setActivePanel(panel);
    }
  }, [controller.layout]);

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
    (panel: PanelKey) => {
      rememberPanel(panel);
      dispatch({ type: "activate", panel });
    },
    [dispatch, rememberPanel],
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
    const target = findAdjacentPanelInLayout(layoutRef.current, panel, direction);
    return target ? { target, center: true } : null;
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
      const group =
        groups.find((item) => item.id === activeGroupIdRef.current) ??
        groups.find((item) => activePanelRef.current && item.panels.includes(activePanelRef.current)) ??
        groups[0];
      const active =
        activePanelRef.current && group?.panels.includes(activePanelRef.current)
          ? activePanelRef.current
          : (group?.active ?? group?.panels[0]);
      if (!active) return;
      if (!PANEL_DEFS[active].closable) {
        onNotifyRef.current?.("设置面板不可关闭（保护未保存的配置草稿）");
        return;
      }
      // t550/F2：onPanelClose 只在这里调用一次；DockGroup 不再重复调用。
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
      const group =
        groups.find((item) => item.id === activeGroupIdRef.current) ??
        groups.find((item) => activePanelRef.current && item.panels.includes(activePanelRef.current)) ??
        groups[0];
      const active =
        activePanelRef.current && group?.panels.includes(activePanelRef.current)
          ? activePanelRef.current
          : (group?.active ?? group?.panels[0]);
      if (!active) return;
      const adjacent = findAdjacentTarget(active, direction);
      if (adjacent) {
        dispatch({ type: "move", panel: active, target: adjacent.target, position: "center" });
      } else {
        dispatch({ type: "split", panel: active, direction });
      }
    },
    resizeActiveGroup(delta: number) {
      // 键盘调宽：作用于包含最近聚焦 active 面板的组所在 split。
      const layout = layoutRef.current;
      const groups = listGroups(layout.root);
      const activeGroup =
        groups.find((item) => item.id === activeGroupIdRef.current) ??
        groups.find((item) => activePanelRef.current && item.panels.includes(activePanelRef.current)) ??
        groups.find((item) => item.active);
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
    <div
      className="docktree-shell"
      data-engine="v2"
      data-dock-engine-note="DW1-3"
      onFocusCapture={(event) => rememberFromTarget(event.target)}
      onPointerDownCapture={(event) => rememberFromTarget(event.target)}
    >
      <DockTree
        layout={controller.layout}
        onActivate={onActivate}
        onClose={onClose}
        onResize={onResize}
        onDrop={onDrop}
      />
    </div>
  );
});

export default DockShellV2;
