import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DeerCanvas, DeerQuestion } from "./shared/interactive.js";
import type { ChatQuestionRecord } from "./shared/types.js";
import ChatContent from "./ChatContent.js";

/**
 * t64：助手消息内容切分 SSR（设计 §7.1/§7.2 / AC-01/07/18/30/31）。
 */

const canvas: DeerCanvas = {
  protocol: "deer-canvas",
  version: 1,
  kind: "flowchart",
  title: "实现流程",
  nodes: [
    { id: "a", label: "写协议", kind: "step", status: "done" },
    { id: "b", label: "渲染画布", kind: "step", status: "active" },
  ],
  edges: [{ id: "e1", from: "a", to: "b", kind: "flow" }],
  groups: [],
};

const question: DeerQuestion = {
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
  ],
};

function fence(language: string, value: unknown): string {
  return ["```" + language, JSON.stringify(value, null, 2), "```"].join("\n");
}

function questionRecord(): ChatQuestionRecord {
  return {
    id: "chat_1#b1",
    workspaceId: "ws",
    agentId: "agent",
    messageId: "chat_1",
    blockIndex: 1,
    title: question.title,
    payload: question,
    status: "pending",
    answer: null,
    createdAt: new Date().toISOString(),
    answeredAt: null,
    expiresAt: null,
  };
}

describe("ChatContent 分段（AC-01/18）", () => {
  it("文本 + 画布 + 提问分段渲染，文本段仍走 Markdown", () => {
    const content = [
      "## 实现计划",
      "",
      "先看流程：",
      "",
      fence("deer-canvas", canvas),
      "",
      "再确认范围：",
      "",
      fence("deer-question", question),
    ].join("\n");
    const questions = new Map([[questionRecord().id, questionRecord()]]);
    const html = renderToStaticMarkup(
      <ChatContent
        role="assistant"
        messageId="chat_1"
        content={content}
        questions={questions}
        questionsLoaded
        onAnswerQuestion={() => undefined}
      />,
    );
    expect(html).toContain("<h2>实现计划</h2>");
    expect(html).toContain("canvas-card");
    expect(html).toContain("实现流程");
    expect(html).toContain("写协议");
    expect(html).toContain("question-card");
    expect(html).toContain("回答问题");
    expect(html).not.toContain('"protocol"');
  });

  it("用户消息永远纯文本，不解析 deer-canvas（AC-30）", () => {
    const html = renderToStaticMarkup(
      <ChatContent role="user" content={fence("deer-canvas", canvas)} messageId="m" />,
    );
    expect(html).toContain("chat-plain");
    expect(html).not.toContain("canvas-card");
    expect(html).toContain("deer-canvas");
  });

  it("非法画布 → 回退卡片，其余文本正常渲染（AC-07）", () => {
    const content = [
      "下面的画布坏了：",
      "",
      "```deer-canvas",
      "{not json",
      "```",
      "",
      "但我还能继续说话。",
    ].join("\n");
    const html = renderToStaticMarkup(
      <ChatContent role="assistant" content={content} messageId="m" />,
    );
    expect(html).toContain("画布数据无效");
    expect(html).toContain("E_JSON");
    expect(html).toContain("但我还能继续说话");
    expect(html).not.toContain("canvas-node");
  });

  it("流式预览剥离未闭合 fence，不裸露半截 JSON（AC-31）", () => {
    const content = '正在生成：\n```deer-canvas\n{"protocol":"deer-canvas","kind"';
    const html = renderToStaticMarkup(
      <ChatContent role="assistant" content={content} streaming messageId="m" />,
    );
    expect(html).toContain("正在生成画布…");
    expect(html).not.toContain("protocol");
    expect(html).not.toContain("deer-canvas");
  });

  it("问题状态未加载/缺失时卡片禁用但不崩溃（AC-32）", () => {
    const content = fence("deer-question", question);
    const loading = renderToStaticMarkup(
      <ChatContent role="assistant" content={content} messageId="m" questionsLoaded={false} />,
    );
    expect(loading).toContain("问题状态加载中");
    const missing = renderToStaticMarkup(
      <ChatContent role="assistant" content={content} messageId="m" questions={new Map()} questionsLoaded />,
    );
    expect(missing).toContain("E_NOT_PERSISTED");
  });
});
