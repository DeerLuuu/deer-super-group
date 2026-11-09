/**
 * t80：提问流程的纯逻辑（便于单测；不依赖 DOM/IPC）。
 * - F5：回答发送失败后的重发去重（最后一条用户消息 / 最后一条消息是否已是 answerText）；
 * - F6：自动弹窗条件中「composer/输入控件已聚焦」的判定。
 */

export interface ChatLikeMessage {
  role: string;
  content: string;
}

/**
 * 回答是否已经在当前对话里（避免「重新发送回答」重复生成用户消息）。
 * 判定：最后一条用户消息内容 === answerText，或最后一条消息内容 === answerText。
 */
export function answerAlreadySent(
  messages: ReadonlyArray<ChatLikeMessage>,
  answerText: string,
): boolean {
  const trimmed = answerText.trim();
  if (!trimmed) return true;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    return message.content.trim() === trimmed;
  }
  const last = messages[messages.length - 1];
  return Boolean(last && last.content.trim() === trimmed);
}

/** 当前焦点是否在可编辑控件（input/textarea/contenteditable）里。 */
export function isEditableElement(
  active: { tagName?: string; isContentEditable?: boolean } | null | undefined,
): boolean {
  if (!active) return false;
  const tag = (active.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || Boolean(active.isContentEditable);
}

/**
 * 当前焦点是否仍在 composer 容器内（含发送/停止等按钮子元素）。
 * 与 isEditableElement 组合使用，避免自动弹窗抢走 composer 内的焦点。
 */
export function isComposerFocusWithin(
  active: { closest?: (selector: string) => unknown } | null | undefined,
  selector = ".chat-composer",
): boolean {
  if (!active || typeof active.closest !== "function") return false;
  return Boolean(active.closest(selector));
}

export interface AutoOpenConditions {
  questionsLoaded: boolean;
  panelVisible: boolean;
  windowFocused: boolean;
  otherModalOpen: boolean;
  composerFocused: boolean;
  composerHasDraft: boolean;
  chatBusy: boolean;
  deferred: boolean;
  alreadyAutoOpened: boolean;
}

/**
 * t80 F6 / 设计 DEC-10：是否允许自动打开某个待回答问题。
 * 任一条件不满足都不弹窗（卡片仍常驻；新问题走 info toast）。
 */
export function shouldAutoOpenQuestion(conditions: AutoOpenConditions): boolean {
  if (!conditions.questionsLoaded) return false;
  if (!conditions.panelVisible) return false;
  if (!conditions.windowFocused) return false;
  if (conditions.otherModalOpen) return false;
  if (conditions.composerFocused) return false;
  if (conditions.composerHasDraft) return false;
  if (conditions.chatBusy) return false;
  if (conditions.deferred) return false;
  if (conditions.alreadyAutoOpened) return false;
  return true;
}
