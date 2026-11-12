import { useState } from "react";
import { classifyErrorRecovery, type ErrorRecovery } from "./errorRecovery.js";

export default function ErrorRecoveryBar({
  message,
  onOpenSettings,
  onOpenModels,
  onRetry,
  onClose,
}: {
  message: string;
  onOpenSettings: () => void;
  onOpenModels: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const recovery: ErrorRecovery = classifyErrorRecovery(message);

  function runAction() {
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
        </div>
        <div className="row gap">
          <button type="button" className="primary tiny" onClick={runAction}>
            {recovery.action.label}
          </button>
          <button type="button" className="ghost tiny" onClick={onClose} aria-label="关闭错误提示">
            关闭
          </button>
        </div>
      </div>
      {showDetail ? (
        <pre className="error-recovery-detail" aria-label="脱敏错误详情">
          {recovery.summary}
        </pre>
      ) : null}
    </div>
  );
}
