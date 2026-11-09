import { useState } from "react";
import type { InteractiveError } from "../shared/interactive";
import { copyText } from "../canvas/export";

/**
 * t64：非法提问回退卡片（设计 §5.7）：不可回答，只展示错误与原始 JSON。
 */
export default function QuestionFallback({
  raw,
  error,
}: {
  raw: string;
  error: InteractiveError;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const trimmed = raw.slice(0, 64 * 1024);

  async function handleCopy() {
    const ok = await copyText(trimmed);
    if (ok) {
      setStatus("已复制原始数据");
      setFallbackText(null);
      return;
    }
    setFallbackText(trimmed);
    setStatus("复制失败：请手动复制下方文本");
  }

  return (
    <div className="question-fallback" role="group" aria-label="表单数据无效">
      <div className="canvas-fallback-head">
        <span className="canvas-fallback-icon" aria-hidden="true">
          ⚠
        </span>
        <div>
          <div className="canvas-fallback-title">
            表单数据无效 · <span className="mono">{error.code}</span>
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
        {status}
      </div>
      {open && <pre className="canvas-fallback-raw">{trimmed}</pre>}
      {fallbackText !== null && (
        <textarea
          readOnly
          value={fallbackText}
          rows={6}
          aria-label="表单原始数据"
          className="canvas-fallback-textarea"
        />
      )}
    </div>
  );
}
