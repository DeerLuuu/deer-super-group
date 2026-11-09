import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DeerQuestion } from "../shared/interactive.js";
import type { ChatQuestionRecord } from "../shared/types.js";
import QuestionModal from "./QuestionModal.js";

/**
 * t64：提问弹窗 SSR 结构与 ARIA 断言（设计 §6.7 / AC-09/14）。
 */

const definition: DeerQuestion = {
  protocol: "deer-question",
  version: 1,
  title: "确认 P0 实现范围",
  description: "回答后我会按你的选择继续推进。",
  fields: [
    {
      id: "platform",
      kind: "single",
      label: "优先平台",
      required: true,
      options: [
        { id: "desktop", label: "桌面 Electron（默认）" },
        { id: "web", label: "浏览器 Web" },
      ],
    },
    {
      id: "features",
      kind: "multi",
      label: "P0 必须包含",
      description: "可多选；至少 1 项",
      required: true,
      min: 1,
      max: 4,
      options: [
        { id: "flow", label: "流程图" },
        { id: "ask", label: "提问表单" },
      ],
    },
    {
      id: "notes",
      kind: "text",
      label: "补充说明",
      required: false,
      placeholder: "可留空",
      maxLength: 500,
      multiline: true,
    },
    { id: "confirm", kind: "confirm", label: "按以上范围开始实现", required: true, danger: false },
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

function renderModal(overrides: Partial<ChatQuestionRecord> = {}) {
  return renderToStaticMarkup(
    <QuestionModal
      question={record(overrides)}
      index={0}
      total={2}
      busy={false}
      onSubmit={async () => ({ ok: true })}
      onDefer={() => undefined}
      onCancel={async () => undefined}
    />,
  );
}

describe("QuestionModal SSR（AC-09/14）", () => {
  it("四种字段分别渲染为 radio / checkbox / textarea / confirm", () => {
    const html = renderModal();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("问题：确认 P0 实现范围");
    expect(html).toContain("问题 1/2");
    expect((html.match(/<fieldset/g) ?? []).length).toBe(4);
    expect(html).toContain("<legend");
    expect(html).toContain('type="radio"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<textarea");
    expect(html).toContain("确认");
    expect(html).toContain("不确认");
    expect(html).toContain("已选");
    expect(html).toContain("提交回答");
    expect(html).toContain("稍后回答");
    expect(html).toContain("取消提问");
    expect(html).toContain("回答会作为一条消息发送给当前配置的模型");
    expect(html).toContain('aria-label="必填"');
  });

  it("t80 F4：radiogroup/legend 的 aria-labelledby 指向存在的 legend id", () => {
    const html = renderModal();
    const labelledBy = Array.from(html.matchAll(/aria-labelledby="([^"]+)"/g)).map(
      (match) => match[1],
    );
    // single / multi / confirm 三组 + 文本控件的 aria-label 不在此列。
    expect(labelledBy.length).toBeGreaterThanOrEqual(3);
    for (const id of labelledBy) {
      expect(html).toContain(`id="${id}"`);
      expect(id.endsWith("-legend")).toBe(true);
    }
    // 文本控件有可访问名称（aria-label）。
    expect(html).toContain('<textarea');
    expect(html).toContain('aria-label="补充说明"');
    // 初始无错误时组级 aria-invalid=false。
    expect(html).toContain('aria-invalid="false"');
  });

  it("t80 F4：字段错误时组级 aria-invalid=true 且 aria-describedby 指向错误文本", () => {
    const html = renderToStaticMarkup(
      <QuestionModal
        question={record()}
        index={0}
        total={1}
        busy={false}
        initialErrors={[
          { fieldId: "notes", code: "too_long", message: "「补充说明」最多 500 字" },
        ]}
        onSubmit={async () => ({ ok: true })}
        onDefer={() => undefined}
        onCancel={async () => undefined}
      />,
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("「补充说明」最多 500 字");
    const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}"`);
  });

  it("选项/字段文本被转义，不渲染 HTML/Markdown", () => {
    const malicious: DeerQuestion = {
      ...definition,
      title: '<img src=x onerror="alert(1)">',
      fields: [
        {
          id: "pick",
          kind: "single",
          label: "<b>选一个</b>",
          required: true,
          options: [
            { id: "a", label: '<img src=x onerror="alert(1)">' },
            { id: "b", label: "[点我](javascript:alert(1))" },
          ],
        },
      ],
    };
    const html = renderToStaticMarkup(
      <QuestionModal
        question={record({ payload: malicious })}
        index={0}
        total={1}
        busy={false}
        onSubmit={async () => ({ ok: true })}
        onDefer={() => undefined}
        onCancel={async () => undefined}
      />,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<a href");
  });

  it("busy 时提交按钮 disabled + aria-busy", () => {
    const html = renderToStaticMarkup(
      <QuestionModal
        question={record()}
        index={0}
        total={1}
        busy
        onSubmit={async () => ({ ok: true })}
        onDefer={() => undefined}
        onCancel={async () => undefined}
      />,
    );
    expect(html).toContain("Router 正在回复");
    expect(html).toContain("disabled");
  });
});
