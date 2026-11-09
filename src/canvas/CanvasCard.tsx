import { useEffect, useMemo, useRef, useState } from "react";
import type { ToastItem } from "../Toast";
import {
  CANVAS_KIND_LABEL,
  type DeerCanvas,
} from "../shared/interactive";
import CanvasArtifact from "./CanvasArtifact";
import {
  copyText,
  downloadText,
  exportFileName,
  readCanvasTheme,
  renderCanvasSvg,
  toMermaid,
} from "./export";
import { computeCanvasLayout } from "./layout";

export type CanvasToastInput = Omit<ToastItem, "id">;

/**
 * t64：对话内画布卡片（设计 §4.6）。
 * - header：kind 徽章 / 标题 / 节点边计数 / 放大 / 导出 / 原始数据；
 * - 内联视口（CanvasArtifact），不阻塞对话滚动，不使用 Modal；
 * - 导出 Mermaid（复制/下载）与 SVG（下载），全部纯函数生成 + 清洗；
 * - 原始 JSON 放在可折叠 <pre> 中（React 转义，不执行）。
 */
export default function CanvasCard({
  artifactKey,
  artifact,
  raw,
  warnings,
  onToast,
}: {
  artifactKey: string;
  artifact: DeerCanvas;
  raw?: string;
  /** 协议层 warning（如 W_DUP_EDGE）；与布局 warning 合并展示。 */
  warnings?: string[];
  onToast?: (toast: CanvasToastInput) => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [width, setWidth] = useState(0);

  const layout = useMemo(() => computeCanvasLayout(artifact), [artifact]);
  const nodeCount = artifact.nodes.length;
  const edgeCount = artifact.edges.length;
  const rawJson = raw ?? JSON.stringify(artifact);
  const compact = width > 0 && width < 520;

  useEffect(() => {
    const element = cardRef.current;
    if (!element) return;
    const update = () => setWidth(Math.round(element.getBoundingClientRect().width));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function notify(kind: "success" | "error" | "info", message: string) {
    setStatus(message);
    onToast?.({ kind, message });
  }

  async function handleCopyMermaid() {
    const result = toMermaid(artifact);
    if (!result.ok) {
      notify("error", `导出失败：${result.error}`);
      return;
    }
    const copied = await copyText(result.text);
    if (copied) {
      notify("success", "Mermaid 已复制到剪贴板");
      setFallbackText(null);
      return;
    }
    setFallbackText(result.text);
    notify("error", "复制失败：已展开只读文本框，可手动复制");
  }

  function handleDownloadMermaid() {
    const result = toMermaid(artifact);
    if (!result.ok) {
      notify("error", `导出失败：${result.error}`);
      return;
    }
    const ok = downloadText(
      exportFileName("mermaid", artifact.title, "mmd"),
      result.text,
      "text/plain;charset=utf-8",
    );
    notify(ok ? "success" : "error", ok ? "Mermaid 文件已开始下载" : "下载失败：当前环境不支持");
  }

  function handleDownloadSvg() {
    const result = renderCanvasSvg(artifact, layout, readCanvasTheme(cardRef.current));
    if (!result.ok) {
      notify("error", `导出失败：${result.error}`);
      return;
    }
    const ok = downloadText(
      exportFileName("svg", artifact.title, "svg"),
      result.text,
      "image/svg+xml;charset=utf-8",
    );
    notify(ok ? "success" : "error", ok ? "SVG 文件已开始下载" : "下载失败：当前环境不支持");
  }

  async function handleCopyRaw() {
    const copied = await copyText(rawJson.slice(0, 64 * 1024));
    if (!copied) {
      setFallbackText(rawJson.slice(0, 64 * 1024));
      notify("error", "复制失败：已展开只读文本框，可手动复制");
      return;
    }
    notify("success", "原始 JSON 已复制");
  }

  return (
    <div
      className="canvas-card"
      ref={cardRef}
      data-width={width === 0 ? "regular" : compact ? "compact" : width < 760 ? "regular" : "wide"}
      data-artifact-key={artifactKey}
    >
      <div className="canvas-head">
        <div className="canvas-head-main">
          <span className="canvas-badge" aria-hidden="true">
            ▣
          </span>
          <div className="canvas-head-text">
            <div className="canvas-title">
              {artifact.title}
              <span className="canvas-kind">{CANVAS_KIND_LABEL[artifact.kind]}</span>
            </div>
            <div className="canvas-sub muted tiny">
              {nodeCount} 节点 · {edgeCount} 边
              {artifact.groups.length > 0 ? ` · ${artifact.groups.length} 分组` : ""}
              {artifact.summary ? ` · ${artifact.summary}` : ""}
            </div>
          </div>
        </div>
        <div className="canvas-head-actions">
          <button
            type="button"
            className="ghost tiny"
            aria-pressed={expanded}
            onClick={() => setExpanded((value) => !value)}
            title={expanded ? "还原画布高度" : "放大画布"}
          >
            {expanded ? "还原" : "放大"}
          </button>
          <div className="canvas-menu-wrap">
            <button
              type="button"
              className="ghost tiny"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              导出
            </button>
            {menuOpen && (
              <div className="canvas-menu" role="menu" aria-label="导出画布">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    void handleCopyMermaid();
                  }}
                >
                  复制 Mermaid
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    handleDownloadMermaid();
                  }}
                >
                  下载 Mermaid (.mmd)
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    handleDownloadSvg();
                  }}
                >
                  下载 SVG
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="ghost tiny"
            aria-expanded={rawOpen}
            onClick={() => setRawOpen((open) => !open)}
            title="查看原始 JSON"
          >
            原始数据
          </button>
        </div>
      </div>

      <CanvasArtifact
        artifact={artifact}
        compact={compact}
        height={expanded ? "min(560px, 60vh)" : "clamp(240px, 34vh, 420px)"}
      />

      <div className="canvas-footer">
        <span className="muted tiny" role="status" aria-live="polite">
          {status || "拖动平移 · 滚轮缩放 · 适应回到全景 · 单击节点看详情"}
        </span>
        {(warnings?.length ?? 0) + layout.warnings.length > 0 && (
          <span
            className="canvas-warning"
            title={[...(warnings ?? []), ...layout.warnings].join("、")}
          >
            {warningText([...(warnings ?? []), ...layout.warnings])}
          </span>
        )}
      </div>

      {rawOpen && (
        <div className="canvas-raw">
          <div className="canvas-raw-head">
            <span className="muted tiny">原始数据（只读）</span>
            <button type="button" className="ghost tiny" onClick={() => void handleCopyRaw()}>
              复制
            </button>
          </div>
          <pre>{rawJson.slice(0, 64 * 1024)}</pre>
        </div>
      )}

      {fallbackText !== null && (
        <div className="canvas-fallback-text">
          <label className="muted tiny">当前环境无法自动复制，请手动复制以下内容：</label>
          <textarea readOnly value={fallbackText} rows={6} aria-label="待复制内容" />
          <button type="button" className="ghost tiny" onClick={() => setFallbackText(null)}>
            关闭
          </button>
        </div>
      )}
    </div>
  );
}

function warningText(warnings: string[]): string {
  const labels: Record<string, string> = {
    W_DUP_EDGE: "重复边已去重",
    W_CYCLE: "存在环依赖",
    W_ROOT: "思维导图根不唯一",
    W_UNREACHABLE: "存在孤立节点",
    W_EMPTY_GROUP: "存在空分组",
    W_DENSITY: "标签密度过高",
  };
  return warnings.map((warning) => labels[warning] ?? warning).join(" · ");
}
