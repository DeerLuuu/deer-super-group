import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DeerQuestion } from "../shared/interactive.js";
import type { ChatQuestionRecord } from "../shared/types.js";
import QuestionCard from "./QuestionCard.js";

/**
 * t64：问题卡片四状态 SSR 断言（设计 §6.2 / AC-32）。
 */

const definition: DeerQuestion = {
  protocol: "deer-question",
  version: 1,
  title: "确认范围",
  fields: [
    {
      id: "platform",
      kind: "single",
      label: "优先平台",
      required: true,
      options: [
        { id: "desktop", label: "桌面 Electron" },
        { id: "web", label: "浏览器 Web" },
      ],
    },
    {
      id: "features",
      kind: "multi",
      label: "P0 必须包含",
      required: true,
      options: [
        { id: "flow", label: "流程图" },
        { id: "ask", label: "提问表单" },
      ],
    },
  ],
};

function record(overrides: Partial<ChatQuestionRecord> = {}): ChatQuestionRecord {
  return {
    id: "chat_1#b0",
    workspaceId: "ws",
    agentId: "agent",
    messageId: "chat_1",
    blockIndex: 0,
    title: definition.title,
    payload: definition,
    status: "pending",
    answer: null,
    createdAt: new Date().toISOString(),
    answeredAt: null,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    ...overrides,
  };
}

describe("QuestionCard SSR（AC-32）", () => {
  it("pending：显示待回答与「回答问题」入口", () => {
    const html = renderToStaticMarkup(
      <QuestionCard questionId="chat_1#b0" question={definition} record={record()} questionsLoaded />,
    );
    expect(html).toContain("待回答");
    expect(html).toContain("回答问题");
    expect(html).toContain("2 个字段");
    expect(html).toContain("查看字段");
    expect(html).toContain("剩余");
  });

  it("answered：显示答案摘要，不再显示回答入口", () => {
    const html = renderToStaticMarkup(
      <QuestionCard
        questionId="chat_1#b0"
        question={definition}
        questionsLoaded
        record={record({
          status: "answered",
          answeredAt: new Date().toISOString(),
          answer: {
            values: { platform: "desktop", features: ["flow", "ask"] },
            answeredAt: new Date().toISOString(),
          },
        })}
      />,
    );
    expect(html).toContain("已回答");
    expect(html).toContain("优先平台");
    expect(html).toContain("桌面 Electron");
    expect(html).toContain("流程图、提问表单");
    expect(html).not.toContain("回答问题");
  });

  it("expired / cancelled 展示终态文案", () => {
    const expired = renderToStaticMarkup(
      <QuestionCard
        questionId="q"
        question={definition}
        questionsLoaded
        record={record({ status: "expired" })}
      />,
    );
    expect(expired).toContain("已过期");
    expect(expired).not.toContain("回答问题");
    const cancelled = renderToStaticMarkup(
      <QuestionCard
        questionId="q"
        question={definition}
        questionsLoaded
        record={record({ status: "cancelled" })}
      />,
    );
    expect(cancelled).toContain("已取消");
    expect(cancelled).not.toContain("回答问题");
  });

  it("记录缺失：加载中 vs E_NOT_PERSISTED（不无限 loading）", () => {
    const loading = renderToStaticMarkup(
      <QuestionCard questionId="q" question={definition} questionsLoaded={false} />,
    );
    expect(loading).toContain("问题状态加载中");
    expect(loading).toContain("disabled");

    const missing = renderToStaticMarkup(
      <QuestionCard questionId="q" question={definition} questionsLoaded />,
    );
    expect(missing).toContain("E_NOT_PERSISTED");
    expect(missing).not.toContain("回答问题");
  });
});
