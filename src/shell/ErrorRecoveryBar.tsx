import { useState } from "react";
import { classifyErrorRecovery, type ErrorRecovery } from "./errorRecovery.js";

export default function ErrorRecoveryBar({
  message,
  retryAction,
  onOpenSettings,
  onOpenModels,
  onRetry,
  onClose,
}: {
  message: string;
  retryAction?: { label: string; run: () => void };
  onOpenSettings: () => void;
  onOpenModels: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const recovery: ErrorRecovery = classifyErrorRecovery(message);
  const writeRetry = recovery.action.kind === "retry" ? retryAction : undefined;
  const actionLabel = writeRetry
    ? writeRetry.label
    : recovery.action.kind === "retry"
      ? "刷新"
      : recovery.action.kind === "details"
        ? "查看脱敏摘要"
        : recovery.action.label;

  function runAction() {
    if (writeRetry) {
      writeRetry.run();
      return;
    }
    if (recovery.action.kind === "settings") onOpenSettings();
    else if (recovery.action.kind === "model") onOpenModels();
    else if (recovery.action.kind === "retry") onRetry();
    else setShowDetail((value) => !value);
  }

  return (
    <div className="error-recovery" role="alert" aria-live="assertive">
      <div className="error-recovery-main">
        <div>
          <strong>{recovery.title}</strong>
          <div className="error-recovery-summary">{recovery.summary}</div>
          {recovery.action.kind === "retry" && !writeRetry ? (
            <div className="muted tiny">只刷新页面数据，不会重发原操作。</div>
          ) : null}
        </div>
        <div className="row gap">
          <button type="button" className="primary tiny" onClick={runAction}>
            {actionLabel}
          </button>
          <button type="button" className="ghost tiny" onClick={onClose} aria-label="关闭错误提示">
            关闭
          </button>
        </div>
      </div>
      {showDetail ? (
        <pre className="error-recovery-detail" aria-label="脱敏错误摘要">
          {recovery.summary}
        </pre>
      ) : null}
    </div>
  );
}
