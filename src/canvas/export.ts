import {
  CANVAS_KIND_LABEL,
  CANVAS_STATUS_LABEL,
  EDGE_KIND_LABEL,
  sanitizeText,
  type CanvasStatus,
  type DeerCanvas,
  type DeerCanvasNode,
} from "../shared/interactive.js";
import type { CanvasLayout, PositionedNode } from "./layout.js";

/**
 * t64：画布导出（Mermaid / SVG；设计 §4.8 / §8.3 / AC-20）。
 *
 * 安全规则：
 * - 模型给的 id 不直接进入导出文本：节点映射为 n0…，分组映射为 g0…；
 * - 标签先清洗控制字符/双向字符，再去掉能破坏 Mermaid 语法的字符；
 * - 不输出 classDef/style/click/linkStyle 等指令，不引用外部 URL/字体/图片；
 * - SVG 字符串由纯函数自绘，所有文本 escapeXml，无 foreignObject/script/事件属性。
 */

export type ExportResult =
  | { ok: true; text: string; warnings: string[] }
  | { ok: false; error: string };

export interface CanvasTheme {
  bg: string;
  panel: string;
  panelStrong: string;
  border: string;
  borderStrong: string;
  text: string;
  muted: string;
  accent: string;
  status: Record<CanvasStatus, string>;
}

/** styles.css 中的 :root token 兜底值（测试/无 DOM 环境使用）。 */
export const FALLBACK_CANVAS_THEME: CanvasTheme = {
  bg: "#0d1117",
  panel: "#151b24",
  panelStrong: "#1a222d",
  border: "#263041",
  borderStrong: "#344054",
  text: "#e6edf3",
  muted: "#8b98a9",
  accent: "#58a6ff",
  status: {
    planned: "#bc8cff",
    active: "#58a6ff",
    blocked: "#d29922",
    review: "#79c0ff",
    done: "#3fb950",
    failed: "#f85149",
    cancelled: "#8b98a9",
  },
};

/**
 * 从容器读取主题 token（浏览器）；读取失败/无 DOM 时回退常量表。
 * 只读取颜色字面量，不写入 DOM。
 */
export function readCanvasTheme(element: HTMLElement | null): CanvasTheme {
  if (!element || typeof window === "undefined" || typeof getComputedStyle !== "function") {
    return FALLBACK_CANVAS_THEME;
  }
  try {
    const style = getComputedStyle(element);
    const read = (name: string, fallback: string): string => {
      const value = style.getPropertyValue(name).trim();
      return value || fallback;
    };
    const status = {} as Record<CanvasStatus, string>;
    for (const key of Object.keys(FALLBACK_CANVAS_THEME.status) as CanvasStatus[]) {
      const token = key === "planned" ? "ready" : key === "active" ? "running" : key;
      status[key] = read(`--status-${token}`, FALLBACK_CANVAS_THEME.status[key]);
    }
    return {
      bg: read("--bg-2", FALLBACK_CANVAS_THEME.bg),
      panel: read("--panel", FALLBACK_CANVAS_THEME.panel),
      panelStrong: read("--panel-2", FALLBACK_CANVAS_THEME.panelStrong),
      border: read("--border", FALLBACK_CANVAS_THEME.border),
      borderStrong: read("--border-2", FALLBACK_CANVAS_THEME.borderStrong),
      text: read("--text", FALLBACK_CANVAS_THEME.text),
      muted: read("--muted", FALLBACK_CANVAS_THEME.muted),
      accent: read("--accent", FALLBACK_CANVAS_THEME.accent),
      status,
    };
  } catch {
    return FALLBACK_CANVAS_THEME;
  }
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

const MERMAID_FORBIDDEN = [
  "classDef",
  "linkStyle",
  "click",
  "style",
  "javascript:",
  "%%{",
  "`",
  ":::",
  "href",
  "call ",
];

/** 标签清洗：去除控制字符/双向字符，去掉会破坏 Mermaid 语法的字符。 */
export function sanitizeMermaidLabel(label: string, maxLength = 120): string {
  const cleaned = sanitizeText(label)
    .replace(/["']/g, "'")
    .replace(/[[\]{}()<>`|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, maxLength) || "（无标题）";
}

function nodeShape(node: DeerCanvasNode, id: string, label: string): string {
  switch (node.kind) {
    case "decision":
      return `${id}{"${label}"}`;
    case "milestone":
      return `${id}(["${label}"])`;
    case "risk":
      return `${id}[["${label}"]]`;
    default:
      return `${id}["${label}"]`;
  }
}

function mermaidEdge(kind: "flow" | "depends" | "contains" | "relates"): string {
  if (kind === "relates") return "-.->";
  if (kind === "contains") return "---";
  return "-->";
}

function isMindmapTree(artifact: DeerCanvas): boolean {
  const parents = new Map<string, number>();
  for (const edge of artifact.edges) {
    if (edge.kind === "relates") continue;
    parents.set(edge.to, (parents.get(edge.to) ?? 0) + 1);
  }
  if (Array.from(parents.values()).some((count) => count > 1)) return false;
  // 环检测。
  const adjacency = new Map<string, string[]>();
  for (const node of artifact.nodes) adjacency.set(node.id, []);
  for (const edge of artifact.edges) {
    if (edge.kind === "relates") continue;
    adjacency.get(edge.from)?.push(edge.to);
  }
  const state = new Map<string, 0 | 1 | 2>();
  for (const node of artifact.nodes) state.set(node.id, 0);
  const visit = (id: string): boolean => {
    state.set(id, 1);
    for (const next of adjacency.get(id) ?? []) {
      const current = state.get(next) ?? 0;
      if (current === 1) return false;
      if (current === 0 && !visit(next)) return false;
    }
    state.set(id, 2);
    return true;
  };
  for (const node of artifact.nodes) {
    if ((state.get(node.id) ?? 0) === 0 && !visit(node.id)) return false;
  }
  return true;
}

/**
 * t80 F7：按折叠后的可见布局裁剪 artifact，供 Mermaid / SVG 导出使用。
 * - 只保留可见节点；
 * - 只保留两端都可见的边；
 * - 只保留仍被可见节点引用的分组（保持原顺序）。
 */
export function visibleCanvasArtifact(artifact: DeerCanvas, layout: CanvasLayout): DeerCanvas {
  const visibleIds = new Set(
    layout.nodes.filter((node) => !node.hidden).map((node) => node.node.id),
  );
  const nodes = artifact.nodes.filter((node) => visibleIds.has(node.id));
  const edges = artifact.edges.filter(
    (edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to),
  );
  const referencedGroups = new Set(
    nodes
      .map((node) => node.groupId)
      .filter((groupId): groupId is string => Boolean(groupId)),
  );
  return {
    ...artifact,
    nodes,
    edges,
    groups: artifact.groups.filter((group) => referencedGroups.has(group.id)),
  };
}

/** 校验生成结果：只允许受控指令集；返回 null 表示安全。 */
export function validateMermaid(text: string): string | null {
  // 先把标签内容挖空，避免「label 里出现 style 字样」被误判为指令。
  const skeleton = text
    .replace(/"[^"]*"/g, '""')
    .replace(/\[\[[^\]]*\]\]/g, "[[]]")
    .replace(/\[[^\]]*\]/g, "[]")
    .replace(/\(\([^)]*\)\)/g, "(())")
    .replace(/\([^)]*\)/g, "()");
  for (const token of MERMAID_FORBIDDEN) {
    if (skeleton.includes(token)) return `包含不受支持的 Mermaid 指令：${token}`;
  }
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(flowchart (TD|TB|BT|RL|LR)|mindmap|end)$/.test(trimmed)) continue;
    if (/^subgraph g\d+\[".*"\]$/.test(trimmed)) continue;
    if (/^n\d+(\["[^"]*"\]|\{"[^"]*"\}|\(\["[^"]*"\]\)|\[\["[^"]*"\]\])$/.test(trimmed)) continue;
    if (/^ {2,}n\d+(\[[^[\]()]*\]|\(\([^()]*\)\))$/.test(line)) continue;
    if (/^n\d+ (-->|---|-\.->)(\|[^|]*\|)? n\d+$/.test(trimmed)) continue;
    return `包含无法识别的 Mermaid 行：${trimmed.slice(0, 60)}`;
  }
  return null;
}

export function toMermaid(artifact: DeerCanvas): ExportResult {
  const warnings: string[] = [];
  const nodeIdMap = new Map<string, string>();
  artifact.nodes.forEach((node, index) => nodeIdMap.set(node.id, `n${index}`));
  const groupIdMap = new Map<string, string>();
  artifact.groups.forEach((group, index) => groupIdMap.set(group.id, `g${index}`));

  if (artifact.kind === "mindmap") {
    if (!isMindmapTree(artifact)) {
      warnings.push("思维导图不是树结构，已降级为 flowchart");
    } else {
      const children = new Map<string, DeerCanvasNode[]>();
      for (const node of artifact.nodes) children.set(node.id, []);
      for (const edge of artifact.edges) {
        if (edge.kind === "relates") continue;
        const from = artifact.nodes.find((node) => node.id === edge.from);
        const to = artifact.nodes.find((node) => node.id === edge.to);
        if (from && to) children.get(from.id)?.push(to);
      }
      const roots = artifact.nodes.filter((node) => node.kind === "root");
      const rootId = roots[0]?.id ?? artifact.nodes[0]?.id;
      const lines = ["mindmap"];
      const rendered = new Set<string>();
      const walk = (nodeId: string, depth: number): void => {
        const node = artifact.nodes.find((item) => item.id === nodeId);
        if (!node || rendered.has(nodeId)) return;
        rendered.add(nodeId);
        const label = sanitizeMermaidLabel(node.label);
        const id = nodeIdMap.get(nodeId) ?? "n0";
        if (depth === 0) {
          lines.push(`  ${id}((${label}))`);
        } else {
          lines.push(`${"  ".repeat(depth + 1)}${id}[${label}]`);
        }
        for (const child of children.get(nodeId) ?? []) walk(child.id, depth + 1);
      };
      if (rootId) walk(rootId, 0);
      for (const node of artifact.nodes) {
        if (!rendered.has(node.id)) walk(node.id, 0);
      }
      const text = lines.join("\n");
      const invalid = validateMermaid(text);
      if (invalid) return { ok: false, error: invalid };
      return { ok: true, text, warnings };
    }
  }

  const direction = artifact.kind === "dependency" ? "LR" : artifact.direction ?? "TB";
  const lines = [`flowchart ${direction}`];
  const groupedNodes = new Set<string>();
  for (const group of artifact.groups) {
    const members = artifact.nodes.filter((node) => node.groupId === group.id);
    if (members.length === 0) continue;
    const groupId = groupIdMap.get(group.id) ?? "g0";
    lines.push(`  subgraph ${groupId}["${sanitizeMermaidLabel(group.label)}"]`);
    for (const node of members) {
      const id = nodeIdMap.get(node.id);
      if (!id) continue;
      groupedNodes.add(node.id);
      lines.push(`    ${nodeShape(node, id, sanitizeMermaidLabel(node.label))}`);
    }
    lines.push("  end");
  }
  for (const node of artifact.nodes) {
    if (groupedNodes.has(node.id)) continue;
    const id = nodeIdMap.get(node.id);
    if (!id) continue;
    lines.push(`  ${nodeShape(node, id, sanitizeMermaidLabel(node.label))}`);
  }
  for (const edge of artifact.edges) {
    const from = nodeIdMap.get(edge.from);
    const to = nodeIdMap.get(edge.to);
    if (!from || !to) continue;
    const arrow = mermaidEdge(edge.kind);
    const label = edge.label ? `|${sanitizeMermaidLabel(edge.label, 40)}|` : "";
    lines.push(`  ${from} ${arrow}${label} ${to}`);
  }
  const text = lines.join("\n");
  const invalid = validateMermaid(text);
  if (invalid) return { ok: false, error: invalid };
  return { ok: true, text, warnings };
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function svgNodeShape(node: PositionedNode, theme: CanvasTheme): string {
  const { x, y, w, h, node: data } = node;
  const stroke = theme.status[data.status];
  const fill = theme.panel;
  const common = `fill="${fill}" stroke="${stroke}" stroke-width="1.5"`;
  if (data.kind === "milestone") {
    const points = `${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`;
    return `<polygon points="${points}" ${common} />`;
  }
  if (data.kind === "decision") {
    const inset = 22;
    const points = `${x + inset},${y} ${x + w - inset},${y} ${x + w},${y + h / 2} ${x + w - inset},${y + h} ${x + inset},${y + h} ${x},${y + h / 2}`;
    return `<polygon points="${points}" ${common} />`;
  }
  if (data.kind === "risk") {
    const points = `${x + 14},${y} ${x + w - 14},${y} ${x + w},${y + 14} ${x + w - 14},${y + h} ${x + 14},${y + h} ${x},${y + 14}`;
    return `<polygon points="${points}" ${common} />`;
  }
  const dash = data.kind === "note" ? ' stroke-dasharray="6 4"' : "";
  const radius = data.kind === "root" ? 24 : 10;
  let out = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" ${common}${dash} />`;
  if (data.kind === "root") {
    out += `<rect x="${x + 4}" y="${y + 4}" width="${w - 8}" height="${h - 8}" rx="${radius - 4}" fill="none" stroke="${stroke}" stroke-width="1" opacity="0.55" />`;
  }
  return out;
}

function truncateLabel(label: string, maxLength: number): string {
  return label.length > maxLength ? `${label.slice(0, maxLength - 1)}…` : label;
}

export function renderCanvasSvg(
  artifact: DeerCanvas,
  layout: CanvasLayout,
  theme: CanvasTheme = FALLBACK_CANVAS_THEME,
): ExportResult {
  const bounds = layout.bounds;
  const width = Math.ceil(bounds.width);
  const height = Math.ceil(bounds.height);
  if (width <= 0 || height <= 0) return { ok: false, error: "画布没有可导出的内容" };
  if (width > 4096 || height > 4096) {
    return { ok: false, error: `画布尺寸 ${width}×${height} 超过 4096，请折叠分组后再导出` };
  }
  const warnings: string[] = [];
  const title = sanitizeText(artifact.title);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${bounds.minX} ${bounds.minY} ${width} ${height}" role="img" aria-label="${escapeXml(`${CANVAS_KIND_LABEL[artifact.kind]}：${title}`)}">`,
    `<rect x="${bounds.minX}" y="${bounds.minY}" width="${width}" height="${height}" fill="${theme.bg}" />`,
    `<defs><marker id="deer-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${theme.borderStrong}" /></marker></defs>`,
  ];

  for (const lane of layout.lanes) {
    parts.push(
      `<rect x="${lane.x}" y="${lane.y}" width="${Math.max(0, lane.w)}" height="${lane.h}" rx="8" fill="${theme.panelStrong}" stroke="${theme.border}" stroke-width="1" />`,
    );
    if (lane.label) {
      parts.push(
        `<text x="${lane.x + 12}" y="${lane.y + 22}" font-size="12" fill="${theme.muted}" font-family="Segoe UI, Microsoft YaHei, sans-serif">${escapeXml(truncateLabel(lane.label, 18))}</text>`,
      );
    }
  }
  for (const box of layout.groupBoxes) {
    parts.push(
      `<rect x="${box.x}" y="${box.y}" width="${Math.max(0, box.w)}" height="${box.h}" rx="12" fill="${theme.panelStrong}" stroke="${theme.border}" stroke-width="1" stroke-dasharray="4 4" />`,
    );
    parts.push(
      `<text x="${box.x + 10}" y="${box.y + 16}" font-size="11" fill="${theme.muted}" font-family="Segoe UI, Microsoft YaHei, sans-serif">${escapeXml(truncateLabel(box.group.label, 16))}</text>`,
    );
  }

  for (const edge of layout.edges) {
    if (edge.hidden || !edge.path) continue;
    const dash = edge.kind === "relates" || edge.back ? ' stroke-dasharray="5 4"' : "";
    const marker = edge.kind === "flow" || edge.kind === "depends" ? ' marker-end="url(#deer-arrow)"' : "";
    const stroke = edge.back ? theme.status.failed : theme.borderStrong;
    parts.push(
      `<path d="${edge.path}" fill="none" stroke="${stroke}" stroke-width="1.25" opacity="0.9"${dash}${marker} />`,
    );
  }

  for (const node of layout.nodes) {
    if (node.hidden) continue;
    parts.push(svgNodeShape(node, theme));
    const label = truncateLabel(sanitizeText(node.node.label), 18);
    parts.push(
      `<text x="${node.x + node.w / 2}" y="${node.y + node.h / 2 + 4}" font-size="12" text-anchor="middle" fill="${theme.text}" font-family="Segoe UI, Microsoft YaHei, sans-serif">${escapeXml(label)}</text>`,
    );
    parts.push(
      `<text x="${node.x + node.w - 10}" y="${node.y + 14}" font-size="10" text-anchor="end" fill="${theme.status[node.node.status]}">${escapeXml(CANVAS_STATUS_LABEL[node.node.status])}</text>`,
    );
  }

  parts.push(
    `<text x="${bounds.minX + 12}" y="${bounds.maxY - 12}" font-size="10" fill="${theme.muted}" font-family="Segoe UI, Microsoft YaHei, sans-serif">${escapeXml(`${CANVAS_KIND_LABEL[artifact.kind]} · ${layout.nodes.filter((node) => !node.hidden).length} 节点 · 由 DeerSuperGroup 导出`)}</text>`,
  );
  parts.push("</svg>");
  const text = parts.join("\n");
  // 导出安全：不允许 script/foreignObject/外部 URL/事件属性。
  const unsafe = /<script|<foreignObject|\son[a-z]+=|(?:href|src)="(?!\s*#)/i.exec(text);
  if (unsafe) return { ok: false, error: `SVG 包含不允许的内容：${unsafe[0]}` };
  const edgeKinds = new Set(layout.edges.filter((edge) => !edge.hidden).map((edge) => EDGE_KIND_LABEL[edge.kind]));
  if (edgeKinds.size > 0) {
    warnings.push(`包含边类型：${Array.from(edgeKinds).join("、")}`);
  }
  return { ok: true, text, warnings };
}

// ---------------------------------------------------------------------------
// 文件名与浏览器下载
// ---------------------------------------------------------------------------

const SAFE_SLUG_PATTERN = /[^\p{L}\p{N}_-]+/gu;

/** 文件名 slug：去掉路径分隔符/控制字符，只保留字母/数字/汉字/_/-。 */
export function canvasFileSlug(title: string, maxLength = 48): string {
  const cleaned = sanitizeText(title)
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(SAFE_SLUG_PATTERN, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
  return cleaned || "canvas";
}

export function exportFileName(kind: string, title: string, extension: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 13);
  return `deer-canvas-${kind}-${canvasFileSlug(title)}-${stamp}.${extension}`;
}

/** 仅浏览器路径：Blob 下载；无 DOM 时返回 false（不抛异常）。 */
export function downloadText(filename: string, text: string, mime: string): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined") return false;
  try {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

/** 仅浏览器路径：优先 clipboard API，失败返回 false（由 UI 提供只读 textarea 兜底）。 */
export async function copyText(value: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
