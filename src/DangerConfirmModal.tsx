import { useEffect, useRef, useState } from "react";
import Modal from "./Modal";

/**
 * t167：删除任务/成员的二级确认。
 * 第一次确认展示影响面；第二次必须输入对象名称，避免误点。
 */
export default function DangerConfirmModal({
  title,
  description,
  subject,
  subjectLabel,
  impact,
  confirmLabel = "永久删除",
  onClose,
  onConfirm,
}: {
  title: string;
  description: string;
  /** 需要用户逐字输入的名称/标题。 */
  subject: string;
  subjectLabel: string;
  impact: string[];
  confirmLabel?: string;
  onClose: () => void;
  onConfirm: () => Promise<boolean> | boolean;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (step === 2) inputRef.current?.focus();
  }, [step]);

  const matched = typed.trim() === subject.trim();

  async function confirm() {
    if (!matched || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await onConfirm();
      if (ok === false) return;
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={step === 1 ? title : "最后确认"}
      description={step === 1 ? description : "此操作不可撤销"}
      onClose={onClose}
      className="danger-modal"
      portal
    >
      <div className="danger-modal-body">
        <div className="danger-modal-icon" aria-hidden="true">
          !
        </div>
        {step === 1 ? (
          <>
            <div className="danger-modal-lead">
              即将删除 <strong>{subject}</strong>。请先确认影响范围。
            </div>
            <ul className="danger-impact">
              {impact.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <div className="modal-foot">
              <button type="button" className="ghost" onClick={onClose}>
                取消
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => setStep(2)}
              >
                继续确认
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="danger-modal-lead">
              请输入{subjectLabel} <strong>{subject}</strong> 以确认删除。
            </div>
            <label className="danger-type-field">
              <span className="muted tiny">{subjectLabel}</span>
              <input
                ref={inputRef}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                placeholder={subject}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                aria-label={`输入${subjectLabel}确认删除`}
              />
            </label>
            {error && (
              <div className="error banner" role="alert">
                {error}
              </div>
            )}
            <div className="modal-foot">
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setStep(1);
                  setTyped("");
                  setError(null);
                }}
                disabled={busy}
              >
                返回
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={!matched || busy}
                onClick={() => void confirm()}
              >
                {busy ? "删除中…" : confirmLabel}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
