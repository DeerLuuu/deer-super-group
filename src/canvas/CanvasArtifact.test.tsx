import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DeerCanvas } from "../shared/interactive.js";
import CanvasArtifact from "./CanvasArtifact.js";
import CanvasCard from "./CanvasCard.js";
import CanvasFallback from "./CanvasFallback.js";

/**
 * t64：画布组件 SSR 结构与安全断言（设计 §13.3 / AC-02/03/08/14）。
 * 不引入 jsdom：交互逻辑由 layout/interaction 纯函数测试覆盖。
 */

function fourKinds(): DeerCanvas[] {
  return [
    {
      protocol: "deer-canvas",
      version: 1,
      kind: "mindmap",
      title: "导图",
      nodes: [
        { id: "root", label: "根主题", kind: "root", status: "active" },
        { id: "a", label: "分支 A", kind: "topic", status: "planned" },
        { id: "b", label: "分支 B", kind: "topic", status: "review" },
      ],
      edges: [
        { id: "e1", from: "root", to: "a", kind: "contains" },
        { id: "e2", from: "root", to: "b", kind: "contains" },
      ],
      groups: [],
    },
    {
      protocol: "deer-canvas",
      version: 1,
      kind: "flowchart",
      title: "流程",
      nodes: [
        { id: "a", label: "写协议", kind: "step", status: "done" },
        { id: "b", label: "评审", kind: "decision", status: "active" },
        { id: "c", label: "风险", kind: "risk", status: "blocked" },
      ],
      edges: [
        { id: "e1", from: "a", to: "b", kind: "flow" },
        { id: "e2", from: "a", to: "c", kind: "relates" },
      ],
      groups: [],
    },
    {
      protocol: "deer-canvas",
      version: 1,
      kind: "roadmap",
      title: "路线图",
      nodes: [
        { id: "a", label: "P0 工作项", kind: "step", status: "done", groupId: "p0" },
        { id: "b", label: "P1 里程碑", kind: "milestone", status: "planned", groupId: "p1" },
      ],
      edges: [{ id: "e1", from: "a", to: "b", kind: "flow" }],
      groups: [
        { id: "p0", label: "P0 阶段", order: 0, tone: "accent", status: "active" },
        { id: "p1", label: "P1 阶段", order: 1, tone: "purple", status: "planned" },
      ],
    },
    {
      protocol: "deer-canvas",
      version: 1,
      kind: "dependency",
      title: "依赖图",
      nodes: [
        { id: "t1", label: "设计", kind: "task", status: "done" },
        { id: "t2", label: "实现", kind: "task", status: "active" },
        { id: "ship", label: "交付", kind: "milestone", status: "planned" },
      ],
      edges: [
        { id: "e1", from: "t1", to: "t2", kind: "depends" },
        { id: "e2", from: "t2", to: "ship", kind: "depends" },
      ],
      groups: [],
    },
  ];
}

describe("CanvasArtifact SSR（AC-02/03）", () => {
  it("四类画布都渲染节点标签、状态属性与容器 ARIA", () => {
    for (const artifact of fourKinds()) {
      const html = renderToStaticMarkup(<CanvasArtifact artifact={artifact} />);
      expect(html).toContain('role="application"');
      expect(html).toContain(`交互画布：${artifact.title}`);
      for (const node of artifact.nodes) {
        expect(html).toContain(`data-node-id="${node.id}"`);
        expect(html).toContain(`data-status="${node.status}"`);
      }
      expect(html).toContain(artifact.nodes[0].label);
    }
  });

  it("状态双编码：颜色标记 + 中文状态在节点 aria-label 中", () => {
    const html = renderToStaticMarkup(<CanvasArtifact artifact={fourKinds()[1]} />);
    expect(html).toContain("✓");
    expect(html).toContain("完成");
    expect(html).toContain("进行中");
    expect(html).toContain("阻塞");
  });

  it("恶意节点标签被 React 转义，不出现可执行标签（AC-08）", () => {
    const artifact: DeerCanvas = {
      protocol: "deer-canvas",
      version: 1,
      kind: "flowchart",
      title: '<img src=x onerror="alert(1)">',
      nodes: [
        {
          id: "a",
          label: '<img src=x onerror="alert(1)">',
          kind: "step",
          status: "planned",
        },
        {
          id: "b",
          label: '</script><script>alert(1)</script>',
          kind: "step",
          status: "planned",
        },
      ],
      edges: [],
      groups: [],
    };
    const html = renderToStaticMarkup(<CanvasArtifact artifact={artifact} />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
    // 恶意文本只能以转义后的文本出现，不能成为真实事件属性/标签。
    expect(html).not.toMatch(/<img\s/);
    expect(html).not.toContain('onerror="');
  });

  it("非法标签内容不进入样式/链接属性", () => {
    const artifact: DeerCanvas = {
      ...fourKinds()[1],
      nodes: [
        {
          id: "a",
          label: '<a href="javascript:alert(1)">点我</a>',
          kind: "step",
          status: "planned",
        },
      ],
      edges: [],
      groups: [],
    };
    const html = renderToStaticMarkup(<CanvasArtifact artifact={artifact} />);
    // 只作为转义文本出现，不产生真实链接。
    expect(html).not.toContain("<a href");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("&lt;a href=&quot;javascript:");
  });
});

describe("CanvasCard SSR", () => {
  it("卡片展示标题/计数/操作与画布视口", () => {
    const artifact = fourKinds()[1];
    const html = renderToStaticMarkup(
      <CanvasCard artifactKey="m#b0" artifact={artifact} raw="{raw:true}" />,
    );
    expect(html).toContain("canvas-card");
    expect(html).toContain(artifact.title);
    expect(html).toContain("3 节点 · 2 边");
    expect(html).toContain("导出");
    expect(html).toContain("原始数据");
    expect(html).toContain("canvas-viewport");
    expect(html).not.toContain("{raw:true}");
  });
});

describe("CanvasFallback SSR（AC-07）", () => {
  it("展示错误码和转义后的原始 JSON，不渲染任何节点", () => {
    const raw = '{"protocol":"deer-canvas","nodes":[<bad>]}';
    const html = renderToStaticMarkup(
      <CanvasFallback
        raw={raw}
        error={{ code: "E_JSON", message: "交互块不是合法 JSON", detail: "Unexpected token" }}
      />,
    );
    expect(html).toContain("E_JSON");
    expect(html).toContain("画布数据无效");
    expect(html).not.toContain("canvas-node");
    expect(html).toContain("查看原始数据");
  });
});
