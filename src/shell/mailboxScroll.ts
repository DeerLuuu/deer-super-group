export interface MailboxScrollItem {
  id: string;
  offsetTop: number;
  offsetHeight: number;
}

export interface MailboxScrollAnchor {
  id: string | null;
  offset: number;
}

export interface MailboxScrollState {
  thread: MailboxScrollAnchor;
  message: MailboxScrollAnchor;
}

export const EMPTY_MAILBOX_SCROLL_STATE: MailboxScrollState = {
  thread: { id: null, offset: 0 },
  message: { id: null, offset: 0 },
};

/**
 * t405 F1：用「第一可见项 id + 相对偏移」而不是绝对 scrollTop 做锚点。
 * 线程按 lastActivity 重排或新消息插入顶部时，仍能恢复同一锚点。
 */
export function captureMailboxAnchor(
  items: readonly MailboxScrollItem[],
  scrollTop: number,
): MailboxScrollAnchor {
  const firstVisible =
    items.find((item) => item.offsetTop + item.offsetHeight > Math.max(0, scrollTop)) ??
    items[0] ??
    null;
  if (!firstVisible) return { id: null, offset: 0 };
  return {
    id: firstVisible.id,
    // 允许负 offset：第一可见项可能从视口顶下方开始（padding/间距），
    // 保留它才能精确恢复原 scrollTop，而不是把该项强行对齐到顶部。
    offset: scrollTop - firstVisible.offsetTop,
  };
}

export function restoreMailboxScrollTop(
  items: readonly MailboxScrollItem[],
  anchor: MailboxScrollAnchor,
): number | null {
  if (!anchor.id) return null;
  const item = items.find((candidate) => candidate.id === anchor.id);
  if (!item) return null;
  return Math.max(0, item.offsetTop + anchor.offset);
}

export function captureMailboxScrollState(
  threadItems: readonly MailboxScrollItem[],
  threadScrollTop: number,
  messageItems: readonly MailboxScrollItem[],
  messageScrollTop: number,
): MailboxScrollState {
  return {
    thread: captureMailboxAnchor(threadItems, threadScrollTop),
    message: captureMailboxAnchor(messageItems, messageScrollTop),
  };
}

export function parseMailboxScrollState(raw: string | null): MailboxScrollState {
  if (!raw) return { ...EMPTY_MAILBOX_SCROLL_STATE };
  try {
    const value = JSON.parse(raw) as Partial<MailboxScrollState> | null;
    const thread = value?.thread;
    const message = value?.message;
    return {
      thread: {
        id: typeof thread?.id === "string" ? thread.id : null,
        offset:
          typeof thread?.offset === "number" && Number.isFinite(thread.offset)
            ? thread.offset
            : 0,
      },
      message: {
        id: typeof message?.id === "string" ? message.id : null,
        offset:
          typeof message?.offset === "number" && Number.isFinite(message.offset)
            ? message.offset
            : 0,
      },
    };
  } catch {
    return { ...EMPTY_MAILBOX_SCROLL_STATE };
  }
}

export function serializeMailboxScrollState(state: MailboxScrollState): string {
  return JSON.stringify(state);
}
