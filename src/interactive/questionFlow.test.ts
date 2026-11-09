import { describe, expect, it } from "vitest";
import {
  answerAlreadySent,
  isComposerFocusWithin,
  isEditableElement,
  shouldAutoOpenQuestion,
} from "./questionFlow.js";

/**
 * t80 F5/F6：回答重发去重与自动弹窗条件（App 集成逻辑的纯函数部分）。
 */

describe("answerAlreadySent（F5）", () => {
  it("空对话 → 未发送", () => {
    expect(answerAlreadySent([], "[回答表单] 确认范围")).toBe(false);
  });

  it("最后一条用户消息内容等于 answerText（含前后空白）→ 已发送", () => {
    const messages = [
      { role: "user", content: "你好" },
      { role: "assistant", content: "请回答" },
      { role: "user", content: "  [回答表单] 确认范围\n\n- A：B  " },
    ];
    expect(answerAlreadySent(messages, "[回答表单] 确认范围\n\n- A：B")).toBe(true);
  });

  it("回答后模型已回复（最后一条是 assistant）→ 仍视为已发送", () => {
    const messages = [
      { role: "user", content: "[回答表单] 确认范围" },
      { role: "assistant", content: "收到，继续实现。" },
    ];
    expect(answerAlreadySent(messages, "[回答表单] 确认范围")).toBe(true);
  });

  it("最后一条用户消息是别的回答 → 未发送", () => {
    const messages = [
      { role: "user", content: "[回答表单] 旧问题" },
      { role: "assistant", content: "好的" },
      { role: "user", content: "继续" },
    ];
    expect(answerAlreadySent(messages, "[回答表单] 确认范围")).toBe(false);
  });

  it("空 answerText 视为已发送（避免空消息重发）", () => {
    expect(answerAlreadySent([], "   ")).toBe(true);
  });

  it("没有用户消息但最后一条消息等于 answerText → 已发送", () => {
    expect(answerAlreadySent([{ role: "assistant", content: "x" }], "x")).toBe(true);
  });
});

describe("isEditableElement（F6）", () => {
  it("input/textarea/contenteditable 视为已聚焦输入控件", () => {
    expect(isEditableElement({ tagName: "INPUT" })).toBe(true);
    expect(isEditableElement({ tagName: "textarea" })).toBe(true);
    expect(isEditableElement({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("按钮/空/无焦点不视为输入控件", () => {
    expect(isEditableElement({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableElement({ tagName: "DIV" })).toBe(false);
    expect(isEditableElement(null)).toBe(false);
    expect(isEditableElement(undefined)).toBe(false);
  });

  it("composer 容器内的按钮子元素也算 composer 焦点（不抢焦点）", () => {
    const inComposer = {
      tagName: "BUTTON",
      closest: (selector: string) => (selector === ".chat-composer" ? {} : null),
    };
    expect(isComposerFocusWithin(inComposer)).toBe(true);
    expect(isComposerFocusWithin({})).toBe(false);
    expect(isComposerFocusWithin(null)).toBe(false);
  });
});

describe("shouldAutoOpenQuestion（F6 / DEC-10）", () => {
  const base = {
    questionsLoaded: true,
    panelVisible: true,
    windowFocused: true,
    otherModalOpen: false,
    composerFocused: false,
    composerHasDraft: false,
    chatBusy: false,
    deferred: false,
    alreadyAutoOpened: false,
  };

  it("全部条件满足才自动打开", () => {
    expect(shouldAutoOpenQuestion(base)).toBe(true);
  });

  it.each([
    ["问题未加载", { questionsLoaded: false }],
    ["对话面板不可见", { panelVisible: false }],
    ["窗口无焦点", { windowFocused: false }],
    ["有其他弹窗", { otherModalOpen: true }],
    ["composer 已聚焦", { composerFocused: true }],
    ["composer 有草稿", { composerHasDraft: true }],
    ["Router 正在回复", { chatBusy: true }],
    ["用户已延后", { deferred: true }],
    ["已自动打开过", { alreadyAutoOpened: true }],
  ])("%s → 不自动打开", (_label, patch) => {
    expect(shouldAutoOpenQuestion({ ...base, ...patch })).toBe(false);
  });
});
