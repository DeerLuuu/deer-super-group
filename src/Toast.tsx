import { useCallback, useEffect, useRef, useState } from "react";

/**
 * C26 全局反馈：右下角轻量 toast。
 * - 成功操作给「动作 + 对象」反馈，可带一个可点击动作（如「查看」）；
 * - 自动消失（默认 5s），hover 暂停计时；
 * - 最多同时保留 3 条，新 toast 挤掉最旧的；
 * - aria-live：成功为 polite（role=status），错误为 assertive（role=alert）。
 */

export type ToastItem = {
  id: number;
  /** t64：新增 info（中性提示，role=status），用于「新问题到达」等场景。 */
  kind: "success" | "error" | "info";
  message: string;
  detail?: string;
  action?: { label: string; onClick: () => void };
};

const MAX_TOASTS = 3;
const DEFAULT_DURATION = 5000;

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const pushToast = useCallback((toast: Omit<ToastItem, "id">) => {
    setToasts((prev) => {
      const next = [...prev, { ...toast, id: ++idRef.current }];
      return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
    });
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  return { toasts, pushToast, dismissToast };
}

export function ToastHost({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="toast-host" aria-live="polite">
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastRow({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: (id: number) => void;
}) {
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(DEFAULT_DURATION);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  function start() {
    startedAtRef.current = Date.now();
    timerRef.current = window.setTimeout(() => onDismiss(toast.id), remainingRef.current);
  }

  function pause() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAtRef.current));
    setPaused(true);
  }

  function resume() {
    setPaused(false);
    start();
  }

  useEffect(() => {
    start();
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={`toast toast-${toast.kind} ${paused ? "paused" : ""}`}
      role={toast.kind === "error" ? "alert" : "status"}
      onMouseEnter={pause}
      onMouseLeave={resume}
    >
      <div className="toast-body">
        <div className="toast-message">{toast.message}</div>
        {toast.detail && <div className="toast-detail muted tiny">{toast.detail}</div>}
      </div>
      <div className="toast-actions">
        {toast.action && (
          <button
            type="button"
            className="ghost tiny"
            onClick={() => {
              toast.action?.onClick();
              onDismiss(toast.id);
            }}
          >
            {toast.action.label}
          </button>
        )}
        <button
          type="button"
          className="ghost tiny toast-close"
          aria-label="关闭提示"
          onClick={() => onDismiss(toast.id)}
        >
          ×
        </button>
      </div>
    </div>
  );
}
