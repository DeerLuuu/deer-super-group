import { useState } from "react";
import type { InteractiveError } from "../shared/interactive";
import { copyText } from "./export";

/**
 * t64：非法/危险画布回退卡片（设计 §4.9 / §5.7）。
 *
 * - 展示错误码 + 一句中文原因 + 首个错误路径（不显示堆栈/文件路径）；
 * - 原始 JSON 放在 React 转义的 <pre> 中，可折叠、可复制，不执行；
 * - 不渲染任何节点/边（DEC-11 原子失败）。
 */
export default function CanvasFallback({
  raw,
  error,
}: {
  raw: string;
  error: InteractiveError;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState("");
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const trimmed = raw.slice(0, 64 * 1024);

  async function handleCopy() {
    const ok = await copyText(trimmed);
    if (ok) {
      setCopied("已复制原始数据");
      setFallbackText(null);
      return;
    }
    setFallbackText(trimmed);
    setCopied("复制失败：请手动复制下方文本");
  }

  return (
    <div className="canvas-fallback" role="group" aria-label="画布数据无效">
      <div className="canvas-fallback-head">
        <span className="canvas-fallback-icon" aria-hidden="true">
          ⚠
        </span>
        <div>
          <div className="canvas-fallback-title">
            画布数据无效 · <span className="mono">{error.code}</span>
          </div>
          <div className="muted tiny">{error.message}</div>
          {error.detail && <div className="muted tiny mono ellipsis">{error.detail}</div>}
        </div>
        <div className="canvas-fallback-actions">
          <button
            type="button"
            className="ghost tiny"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "收起原始数据" : "查看原始数据"}
          </button>
          <button type="button" className="ghost tiny" onClick={() => void handleCopy()}>
            复制
          </button>
        </div>
      </div>
      <div className="muted tiny" role="status" aria-live="polite">
        {copied}
      </div>
      {open && <pre className="canvas-fallback-raw">{trimmed}</pre>}
      {fallbackText !== null && (
        <textarea
          readOnly
          value={fallbackText}
          rows={6}
          aria-label="画布原始数据"
          className="canvas-fallback-textarea"
        />
      )}
    </div>
  );
}
