import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * C25 模态框可用性基线：全部弹窗共用的 Modal 原语。
 * - Esc 关闭（有未保存内容时先确认）；
 * - 打开时聚焦首个可聚焦元素；
 * - Tab / Shift+Tab 焦点陷阱；
 * - 关闭后焦点归还触发按钮；
 * - role="dialog" + aria-modal + aria-label；
 * - 打开期间锁定背景滚动；
 * - backdrop 点击与「关闭」按钮走同一条关闭路径（同样受未保存确认保护）。
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (node) => node.offsetParent !== null || node === document.activeElement,
  );
}

export default function Modal({
  title,
  description,
  onClose,
  /** 为 true 时关闭（Esc / backdrop / 关闭按钮）需先经 window.confirm 确认。 */
  confirmClose = false,
  className = "",
  /** t64：可选初始焦点（提问弹窗聚焦首个字段）；不传时沿用「首个可聚焦元素」。 */
  initialFocusRef,
  portal = true,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  confirmClose?: boolean;
  className?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** t168：Dock 面板可能有 transform/overflow；默认 portal 到 body，覆盖全屏层级。 */
  portal?: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const confirmCloseRef = useRef(confirmClose);
  confirmCloseRef.current = confirmClose;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialogRef.current;
    if (node) {
      // t64：优先使用调用方指定的初始焦点（提问弹窗首个字段），默认行为不变。
      const explicit = initialFocusRef?.current ?? null;
      const focusable = getFocusable(node);
      const target = explicit ?? focusable[0] ?? node;
      target.focus();
    }
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      restoreFocusRef.current?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function requestClose() {
      if (confirmCloseRef.current) {
        const ok = window.confirm("有未保存的内容，确定关闭吗？");
        if (!ok) return;
      }
      onCloseRef.current();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
        return;
      }
      if (event.key === "Tab") {
        const node = dialogRef.current;
        if (!node) return;
        const items = getFocusable(node);
        if (items.length === 0) {
          event.preventDefault();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  function requestClose() {
    if (confirmCloseRef.current) {
      const ok = window.confirm("有未保存的内容，确定关闭吗？");
      if (!ok) return;
    }
    onClose();
  }

  const content = (
    <div className="modal-backdrop" onMouseDown={requestClose}>
      <div
        className={`modal ${className}`}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="panel-title">{title}</div>
            {description && <div className="muted tiny">{description}</div>}
          </div>
          <button type="button" className="ghost tiny" onClick={requestClose}>
            关闭
          </button>
        </div>
        {children}
      </div>
    </div>
  );
  return portal && typeof document !== "undefined"
    ? createPortal(content, document.body)
    : content;
}
