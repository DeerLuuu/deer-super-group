/**
 * DW1-3（t548）：自研 Dock 渲染器。
 * DockTree 递归渲染 LayoutNode：split → flex 容器 + DockSash 分隔条；
 * group → DockGroup（tablist + PanelHost active 面板 + 单一落点提示）。
 * 消费 useDockLayoutController.layout（受控状态），命令全部经 controller.dispatch。
 */
import { memo } from "react";
import { PANEL_DEFS, type PanelKey } from "./panelRegistry";
import type { DockLayout, LayoutGroup, LayoutNode, LayoutSplit } from "./layoutModel";
import DockGroup from "./DockGroup";
import DockSash from "./DockSash";

export interface DockTreeProps {
  layout: DockLayout;
  onActivate: (panel: PanelKey) => void;
  onClose: (panel: PanelKey) => void;
  onResize: (splitId: string, index: number, delta: number) => void;
  /** t576：双击 sash 恢复布局。 */
  onResetSplit?: (splitId: string) => void;
  onDrop: (panel: PanelKey, target: PanelKey, position: "center" | "left" | "right" | "above" | "below") => void;
}

function nodeFlexStyle(node: LayoutNode, index: number, parent: LayoutSplit): string {
  const weight = parent.sizes[index] ?? 1 / parent.children.length;
  return `${weight} 1 0%`;
}

function TreeSplit({
  split,
  layout,
  props,
}: {
  split: LayoutSplit;
  layout: DockLayout;
  props: DockTreeProps;
}) {
  "use no memo";
  const children: React.ReactNode[] = [];
  split.children.forEach((child, index) => {
    // 在相邻 pane 之间插入 sash（sash i 调整 children[i-1] 权重）。
    if (index > 0) {
      children.push(
        <DockSash
          key={`sash-${split.id}-${index}`}
          axis={split.axis}
          aria-label={`调整分栏 ${index + 1}/${split.children.length}`}
          onResize={(delta) => props.onResize(split.id, index - 1, delta)}
          onReset={() => props.onResetSplit?.(split.id)}
        />,
      );
    }
    children.push(
      <div
        key={child.id}
        className="docktree-pane"
        style={{ flex: nodeFlexStyle(child, index, split) }}
        role="presentation"
      >
        <TreeNode node={child} layout={layout} props={props} />
      </div>,
    );
  });
  return (
    <div
      className="docktree-split"
      data-axis={split.axis}
      style={{ flexDirection: split.axis === "horizontal" ? "row" : "column" }}
      role="presentation"
    >
      {children}
    </div>
  );
}

function TreeNode({
  node,
  layout,
  props,
}: {
  node: LayoutNode;
  layout: DockLayout;
  props: DockTreeProps;
}) {
  "use no memo";
  if (node.kind === "split") {
    return <TreeSplit split={node} layout={layout} props={props} />;
  }
  return <TreeGroup group={node} props={props} />;
}

function TreeGroup({ group, props }: { group: LayoutGroup; props: DockTreeProps }) {
  "use no memo";
  return (
    <DockGroup
      group={group}
      panelDefs={PANEL_DEFS}
      onActivate={props.onActivate}
      onClose={props.onClose}
      onDrop={props.onDrop}
    />
  );
}

/** 递归渲染布局树（memo：layout 引用不变即跳过）。 */
function DockTreeImpl(props: DockTreeProps & { layout: DockLayout }) {
  "use no memo";
  const { layout, ...rest } = props;
  return (
    <div className="docktree-root" data-variant={layout.variant} role="presentation">
      <TreeNode node={layout.root} layout={layout} props={rest as DockTreeProps} />
    </div>
  );
}

const DockTree = memo(DockTreeImpl);
export default DockTree;
