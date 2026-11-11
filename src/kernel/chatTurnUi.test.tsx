// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { Agent, ChatAssistantTurn, ChatMessage } from "../shared/types.js";
import { ChatTurnHistoryProcess, ChatView } from "../App.js";

interface ChatRenderer {
  root: {
    findAllByType: (type: string) => Array<{ props: Record<string, unknown>; children: unknown[] }>;
    findByType: (type: string) => { props: Record<string, unknown> };
  };
  toJSON: () => unknown;
  update: (element: unknown) => void;
}

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => ChatRenderer;
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (value && typeof value === "object") return textOf((value as { children?: unknown }).children);
  return "";
}

async function render(element: unknown): Promise<ChatRenderer> {
  let renderer: ChatRenderer | null = null;
  await act(async () => {
    renderer = create(element);
  });
  if (!renderer) throw new Error("renderer not created");
  return renderer as ChatRenderer;
}

function assistantFixture(): ChatAssistantTurn {
  return {
    id: "turn:u1:assistant:a1",
    messageId: "a1",
    content: "最终回复",
    reasoning: "",
    steps: [
      {
        step: 1,
        reasoning: [
          { id: "r1", step: 1, text: "先检查工具", source: "event" },
        ],
        tools: [
          {
            callId: "c1",
            name: "fs.read",
            arguments: '{"path":"a"}',
            status: "ok",
            value: "ok",
            step: 1,
            callSeq: 1,
            resultSeq: 2,
          },
        ],
      },
    ],
    status: "complete",
    legacy: { reasoningFromMessage: false, toolsMissing: false, stepFallback: false },
    truncated: false,
  };
}

function chatMessage(id: string, role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id,
    workspaceId: "ws",
    agentId: "agent",
    role,
    content,
    reasoning: "",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("t172 App UI history process", () => {
  it("opens process/step/thinking lazily; translation only starts on thinking expand and runs once", async () => {
    const translate = vi.fn(async () => "机翻结果");
    const renderer = await render(
      <ChatTurnHistoryProcess assistant={assistantFixture()} translate={translate} />,
    );
    expect(textOf(renderer.toJSON())).toContain("执行过程");
    expect(translate).not.toHaveBeenCalled();
    const details = renderer.root.findByType("details");
    await act(() => {
      (details.props.onToggle as (event: unknown) => void)({
        currentTarget: { open: true },
      });
    });
    expect(textOf(renderer.toJSON())).toContain("段思考");
    const stepButton = renderer.root
      .findAllByType("button")
      .find((button) => textOf(button.children).includes("段思考"));
    expect(stepButton).toBeTruthy();
    await act(() => {
      (stepButton!.props.onClick as () => void)();
    });
    expect(translate).not.toHaveBeenCalled();

    const thinkingButton = renderer.root
      .findAllByType("button")
      .find((button) => textOf(button.children).includes("字") && textOf(button.children).includes("思考"));
    expect(thinkingButton).toBeTruthy();
    await act(async () => {
      (thinkingButton!.props.onClick as () => void)();
      await Promise.resolve();
    });
    expect(translate).toHaveBeenCalledTimes(1);
    expect(textOf(renderer.toJSON())).toContain("机翻结果");

    const closeButton = renderer.root
      .findAllByType("button")
      .find((button) => textOf(button.children).includes("原文"));
    expect(closeButton).toBeTruthy();
    const toggleAgain = renderer.root
      .findAllByType("button")
      .find((button) => textOf(button.children).includes("字") && textOf(button.children).includes("思考"));
    await act(() => {
      (toggleAgain!.props.onClick as () => void)();
    });
    const reopen = renderer.root
      .findAllByType("button")
      .find((button) => textOf(button.children).includes("字") && textOf(button.children).includes("思考"));
    await act(async () => {
      (reopen!.props.onClick as () => void)();
      await Promise.resolve();
    });
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it("falls back to original text and shows the failure state", async () => {
    const translate = vi.fn(async () => {
      throw new Error("offline");
    });
    const renderer = await render(
      <ChatTurnHistoryProcess assistant={assistantFixture()} translate={translate} />,
    );
    const details = renderer.root.findByType("details");
    await act(() => {
      (details.props.onToggle as (event: unknown) => void)({
        currentTarget: { open: true },
      });
    });
    const stepButton = renderer.root
      .findAllByType("button")
      .find((button) => textOf(button.children).includes("段思考"));
    await act(() => {
      (stepButton!.props.onClick as () => void)();
    });
    const thinkingButton = renderer.root
      .findAllByType("button")
      .find((button) => textOf(button.children).includes("字") && textOf(button.children).includes("思考"));
    await act(async () => {
      (thinkingButton!.props.onClick as () => void)();
      await Promise.resolve();
    });
    const html = textOf(renderer.toJSON());
    expect(html).toContain("先检查工具");
    expect(html).toContain("机翻失败");
  });

  it("does not attach live tools to a persisted assistant bubble", async () => {
    const assistant = assistantFixture();
    const messages = [
      chatMessage("u1", "user", "问题"),
      {
        ...chatMessage("a1", "assistant", "最终回复"),
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ];
    const props = {
      messages,
      tools: [
        {
          callId: "stale",
          name: "fs.read",
          arguments: "{}",
          status: "ok" as const,
          step: 1,
        },
      ],
      reasoningSegments: [],
      turnByAssistant: new Map([["a1", assistant]]),
      translateHistoryText: async () => "译文",
      view: "chat" as const,
      onViewChange: () => {},
      trajectory: [],
      trajectoryLoading: false,
      onRefreshTrajectory: () => {},
      stream: "",
      reasoning: "",
      busy: false,
      input: "",
      onInput: () => {},
      onSend: () => {},
      onStop: () => {},
      questions: new Map(),
      questionsLoaded: true,
      pendingQuestionCount: 0,
      onOpenFirstQuestion: () => {},
      onAnswerQuestion: () => {},
      onToast: () => {},
      taskContext: null,
      taskContextSource: null,
      onReturnToSource: undefined,
      onClearTaskContext: () => {},
      onOpenContextPanel: () => {},
      contextBusy: false,
      onClearContext: () => {},
      onCompactContext: () => {},
      overview: null,
      routerAgent: { permission: "full_access", model: null } as Agent,
      modelOptions: [],
      fullThrottle: false,
      onModelChange: () => {},
      onPermissionChange: () => {},
      onFullThrottleChange: () => {},
    };
    const renderer = await render(<ChatView {...props} />);
    const output = textOf(renderer.toJSON());
    expect(output.match(/执行过程/g)).toHaveLength(1);
    expect(output).not.toContain("生成中");
    expect(output).toContain("历史记录");
  });
});
