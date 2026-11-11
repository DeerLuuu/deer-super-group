/**
 * t190：全局 Modal 栈。
 *
 * - LIFO：Esc/Tab 只由栈顶 Modal 处理；
 * - 有任意 Modal 时 App 根节点 inert；非栈顶 dialog 也 inert/aria-hidden；
 * - App 全局快捷键（Alt+1–6 / Ctrl+K）通过 hasOpenModal() 提前退出。
 *
 * 纯栈部分可在 Node 测试；DOM 同步只在浏览器存在 document 时执行。
 */

export type ModalToken = symbol;

const stack: ModalToken[] = [];
const elements = new Map<ModalToken, HTMLElement>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function syncDocument(): void {
  if (typeof document === "undefined") return;
  const root = document.getElementById("root");
  if (root) root.toggleAttribute("inert", stack.length > 0);
  const top = stack[stack.length - 1] ?? null;
  for (const [token, element] of elements) {
    const active = token === top;
    element.toggleAttribute("inert", !active);
    if (active) element.removeAttribute("aria-hidden");
    else element.setAttribute("aria-hidden", "true");
  }
}

export function pushModal(token: ModalToken): void {
  if (!stack.includes(token)) stack.push(token);
  syncDocument();
  notify();
}

export function registerModalElement(token: ModalToken, element: HTMLElement | null): void {
  if (!element) return;
  elements.set(token, element);
  syncDocument();
}

export function unregisterModalElement(token: ModalToken): void {
  if (elements.delete(token)) syncDocument();
}

export function popModal(token: ModalToken): void {
  const index = stack.lastIndexOf(token);
  if (index >= 0) stack.splice(index, 1);
  unregisterModalElement(token);
  syncDocument();
  notify();
}

export function topModalToken(): ModalToken | null {
  return stack[stack.length - 1] ?? null;
}

/** Esc/Tab/backdrop 是否应由该 token 处理。 */
export function isTopModal(token: ModalToken): boolean {
  return stack.length > 0 && stack[stack.length - 1] === token;
}

/** App 全局快捷键必须用它做门禁；不依赖 React 订阅。 */
export function hasOpenModal(): boolean {
  return stack.length > 0;
}

export function subscribeModalStack(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
