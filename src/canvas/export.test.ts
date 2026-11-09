import { describe, expect, it } from "vitest";
import type { DeerCanvas } from "../shared/interactive.js";
import {
  FALLBACK_CANVAS_THEME,
  canvasFileSlug,
  escapeXml,
  renderCanvasSvg,
  sanitizeMermaidLabel,
  toMermaid,
  validateMermaid,
} from "./export.js";
import { computeCanvasLayout } from "./layout.js";

/**
 * t64：导出单测（设计 §4.8/§8.3 / AC-20）。
 */

function flowchart(): DeerCanvas {
  return {
    protocol: "deer-canvas",
    version: 1,
    kind: "flowchart",
    title: "实现流程",
    direction: "TB",
    nodes: [
      { id: "a", label: "写协议", kind: "step", status: "done" },
      { id: "b", label: "评审", kind: "decision", status: "active" },
      { id: "c", label: "上线", kind: "milestone", status: "planned" },
      { id: "d", label: "风险", kind: "risk", status: "blocked" },
      { id: "e", label: "备注", kind: "note", status: "planned" },
    ],
    edges: [
      { id: "e1", from: "a", to: "b", kind: "flow" },
      { id: "e2", from: "b", to: "c", kind: "flow", label: "通过" },
      { id: "e3", from: "a", to: "d", kind: "relates" },
    ],
    groups: [],
  };
}

function dependency(): DeerCanvas {
  return {
    protocol: "deer-canvas",
    version: 1,
    kind: "dependency",
    title: "依赖",
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
  };
}

function roadmap(): DeerCanvas {
  return {
    protocol: "deer-canvas",
    version: 1,
    kind: "roadmap",
    title: "路线图",
    groups: [
      { id: "p1", label: "P1", order: 0 },
      { id: "p2", label: "P2", order: 1 },
    ],
    nodes: [
      { id: "a", label: "A", kind: "step", status: "done", groupId: "p1" },
      { id: "b", label: "B", kind: "step", status: "planned", groupId: "p2" },
    ],
    edges: [{ id: "e1", from: "a", to: "b", kind: "flow" }],
  };
}

function mindmap(multiParent = false): DeerCanvas {
  const edges: DeerCanvas["edges"] = [
    { id: "e1", from: "root", to: "t1", kind: "contains" },
    { id: "e2", from: "root", to: "t2", kind: "contains" },
    { id: "e3", from: "t1", to: "leaf", kind: "contains" },
  ];
  if (multiParent) {
    edges.push({ id: "e4", from: "t2", to: "leaf", kind: "contains" });
  }
  return {
    protocol: "deer-canvas",
    version: 1,
    kind: "mindmap",
    title: "导图",
    nodes: [
      { id: "root", label: "根", kind: "root", status: "active" },
      { id: "t1", label: "分支 1", kind: "topic", status: "planned" },
      { id: "t2", label: "分支 2", kind: "topic", status: "planned" },
      { id: "leaf", label: "叶子", kind: "note", status: "planned" },
    ],
    edges,
    groups: [],
  };
}

describe("Mermaid 导出", () => {
  it("流程图：方向、形状与边类型", () => {
    const result = toMermaid(flowchart());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.startsWith("flowchart TB")).toBe(true);
    expect(result.text).toContain('n0["写协议"]');
    expect(result.text).toContain('n1{"评审"}');
    expect(result.text).toContain('n2(["上线"])');
    expect(result.text).toContain('n3[["风险"]]');
    expect(result.text).toContain("n0 --> n1");
    expect(result.text).toContain("n0 -.-> n3");
    expect(result.text).toContain("n1 -->|通过| n2");
    expect(validateMermaid(result.text)).toBeNull();
  });

  it("依赖图固定 LR，依赖箭头", () => {
    const result = toMermaid(dependency());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.startsWith("flowchart LR")).toBe(true);
    expect(result.text).toContain("n0 --> n1");
  });

  it("路线图：每个分组一个 subgraph", () => {
    const result = toMermaid(roadmap());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('subgraph g0["P1"]');
    expect(result.text).toContain('subgraph g1["P2"]');
    expect(result.text).toContain("end");
    expect(validateMermaid(result.text)).toBeNull();
  });

  it("思维导图：树结构生成 mindmap；非树降级 flowchart 并告警", () => {
    const tree = toMermaid(mindmap());
    expect(tree.ok).toBe(true);
    if (tree.ok) {
      expect(tree.text.startsWith("mindmap")).toBe(true);
      expect(tree.text).toContain("n0((根))");
      expect(validateMermaid(tree.text)).toBeNull();
    }
    const broken = toMermaid(mindmap(true));
    expect(broken.ok).toBe(true);
    if (broken.ok) {
      expect(broken.text.startsWith("flowchart")).toBe(true);
      expect(broken.warnings.join("")).toContain("降级");
    }
  });

  it("标签注入：无法新增 Mermaid 指令/边", () => {
    const malicious: DeerCanvas = {
      ...flowchart(),
      title: 'bad"] click n0 "http://evil',
      nodes: [
        {
          id: "a",
          label: ']; click n0 "http://evil"; --> n1',
          kind: "step",
          status: "planned",
        },
        { id: "b", label: "正常", kind: "step", status: "planned" },
      ],
      edges: [{ id: "e1", from: "a", to: "b", kind: "flow" }],
    };
    const result = toMermaid(malicious);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateMermaid(result.text)).toBeNull();
    expect(result.text).not.toMatch(/^\s*click\b/m);
    expect(result.text).not.toContain("<");
    // 每行都必须是受控语法。
    for (const line of result.text.split("\n")) {
      if (!line.trim()) continue;
      expect(validateMermaid(line) === null || /^(flowchart|mindmap|end|subgraph|n\d)/.test(line.trim())).toBe(true);
    }
  });

  it("validateMermaid 拒绝注入指令行", () => {
    expect(validateMermaid('flowchart TD\n  click n0 "http://evil"')).not.toBeNull();
    expect(validateMermaid("flowchart TD\n  classDef red fill:#f00")).not.toBeNull();
    expect(validateMermaid("flowchart TD\n  n0 --> n1\n  n1[\"ok\"]")).toBeNull();
  });

  it("sanitizeMermaidLabel 去掉换行/引号/括号", () => {
    const label = sanitizeMermaidLabel('a\nb"c[d]e(f)<g>`h`');
    expect(label).not.toMatch(/["[\]()<>`\n]/);
    expect(label.length).toBeGreaterThan(0);
  });
});

describe("SVG 导出", () => {
  it("包含背景/节点/状态/箭头，且无脚本与外部资源", () => {
    const artifact = flowchart();
    const layout = computeCanvasLayout(artifact);
    const result = renderCanvasSvg(artifact, layout, FALLBACK_CANVAS_THEME);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.startsWith("<svg")).toBe(true);
    expect(result.text).toContain('fill="#0d1117"');
    expect(result.text).toContain("写协议");
    expect(result.text).toContain("deer-arrow");
    expect(result.text).not.toContain("<script");
    expect(result.text).not.toContain("foreignObject");
    expect(result.text).not.toMatch(/\son[a-z]+=/i);
    expect(result.text).not.toMatch(/(?:href|src)="(?!\s*#)/i);
  });

  it("文本逃逸：</text><script> 被编码", () => {
    const artifact: DeerCanvas = {
      ...flowchart(),
      title: "</text><script>alert(1)</script>",
      nodes: [
        {
          id: "a",
          label: "</text><script>alert(1)</script>",
          kind: "step",
          status: "planned",
        },
      ],
      edges: [],
      groups: [],
    };
    const layout = computeCanvasLayout(artifact);
    const result = renderCanvasSvg(artifact, layout, FALLBACK_CANVAS_THEME);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain("<script");
    expect(result.text).toContain("&lt;/text&gt;");
    expect(result.text).toContain("&lt;script&gt;");
  });

  it("超过 4096 尺寸拒绝导出", () => {
    const artifact = flowchart();
    const layout = computeCanvasLayout(artifact);
    const huge = {
      ...layout,
      bounds: { minX: 0, minY: 0, maxX: 5000, maxY: 3000, width: 5000, height: 3000 },
    };
    const result = renderCanvasSvg(artifact, huge, FALLBACK_CANVAS_THEME);
    expect(result.ok).toBe(false);
  });

  it("escapeXml 覆盖五个字符", () => {
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });
});

describe("文件名安全", () => {
  it("去掉路径分隔符/控制字符/非法字符，保留中文", () => {
    const slug = canvasFileSlug('../../实现 流程<v1>:"*?"\u0000');
    expect(slug).not.toMatch(/[\\/:*?"<>|\u0000-\u001f]/);
    expect(slug).toContain("实现");
    expect(slug).toContain("流程");
    expect(slug.length).toBeLessThanOrEqual(48);
  });

  it("空标题回退 canvas", () => {
    expect(canvasFileSlug("   ")).toBe("canvas");
  });
});
