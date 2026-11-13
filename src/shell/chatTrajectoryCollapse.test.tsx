// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ChatTrajectoryPanel } from "../App.js";
import type { ChatTrajectoryEntry } from "../shared/types.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: {
      findAllByType: (type: string) => Array<{ props: Record<string, unknown>; children: unknown[] }>;
      findAllByProps: (props: Record<string, unknown>) => Array<{ props: Record<string, unknown> }>;
    };
    update: (element: unknown) => unknown;
    toJSON: () => unknown;
  };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entries: ChatTrajectoryEntry[] = [
  {
    id: "entry-user",
    kind: "user",
    title: "请检查接口",
    detail: "user detail",
    createdAt: "2026-01-01T00:00:01.000Z",
    step: 1,
    status: "ok",
  },
  {
    id: "entry-reasoning",
    kind: "reasoning",
    title: "分析依赖",
    detail: "reasoning detail",
    createdAt: "2026-01-01T00:00:02.000Z",
    step: 2,
    status: "running",
  },
  {
    id: "entry-tool",
    kind: "tool_call",
    title: "run_tests",
    detail: "tool detail",
    createdAt: "2026-01-01T00:00:03.000Z",
    step: 3,
    status: "error",
  },
];

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (value && typeof value === "object" && "children" in value) {
    return textOf((value as { children?: unknown }).children);
  }
  return "";
}

function render(entriesToRender = entries) {
  let renderer: ReturnType<typeof create> | null = null;
  act(() => {
    renderer = create(
      <ChatTrajectoryPanel entries={entriesToRender} loading={false} onRefresh={vi.fn()} />,
    );
  });
  return renderer!;
}

function summaryButtons(renderer: ReturnType<typeof create>) {
  return renderer.root.findAllByType("button").filter((button) => button.props.className === "chat-trajectory-summary");
}

describe("t462 ChatTrajectoryPanel collapse", () => {
  it("renders every trajectory default-collapsed with complete summary", () => {
    const renderer = render(entries);
    const summaries = summaryButtons(renderer);
    expect(summaries).toHaveLength(3);
    expect(summaries.every((summary) => summary.props["aria-expanded"] === false)).toBe(true);
    expect(summaries[0].props["aria-controls"]).toBe("chat-trajectory-detail-entry-user");
    const output = textOf(renderer.toJSON());
    expect(output).toContain("请检查接口");
    expect(output).toContain("分析依赖");
    expect(output).toContain("run_tests");
    expect(output).toContain("step");
    expect(output).toContain("2");
    expect(output).toContain("运行中");
    const details = renderer.root.findAllByProps({ role: "region" });
    expect(details).toHaveLength(3);
    expect(details.every((detail) => detail.props.hidden === true)).toBe(true);
  });

  it("expands and collapses on summary click, updating aria-expanded", async () => {
    const renderer = render(entries);
    let summary = summaryButtons(renderer)[0];
    await act(() => {
      (summary.props.onClick as () => void)();
    });
    summary = summaryButtons(renderer)[0];
    expect(summary.props["aria-expanded"]).toBe(true);
    const detail = renderer.root.findAllByProps({ role: "region" })[0];
    expect(detail.props.hidden).toBe(false);
    expect(textOf(detail)).toContain("user detail");
    await act(() => {
      (summary.props.onClick as () => void)();
    });
    expect(summaryButtons(renderer)[0].props["aria-expanded"]).toBe(false);
    expect(renderer.root.findAllByProps({ role: "region" })[0].props.hidden).toBe(true);
  });

  it("keeps per-entry expansion across filters and refresh", async () => {
    const renderer = render(entries);
    const reasoning = summaryButtons(renderer)[1];
    await act(() => {
      (reasoning.props.onClick as () => void)();
    });
    const filterReasoning = renderer.root
      .findAllByType("button")
      .find((button) => textOf(button.children).includes("思考"));
    expect(filterReasoning).toBeTruthy();
    await act(() => {
      (filterReasoning!.props.onClick as () => void)();
    });
    expect(summaryButtons(renderer)).toHaveLength(1);
    expect(summaryButtons(renderer)[0].props["aria-expanded"]).toBe(true);
    const allFilter = renderer.root
      .findAllByType("button")
      .find((button) => textOf(button.children).includes("全部"));
    await act(() => {
      (allFilter!.props.onClick as () => void)();
    });
    expect(summaryButtons(renderer)).toHaveLength(3);
    expect(summaryButtons(renderer)[1].props["aria-expanded"]).toBe(true);
    await act(() => {
      renderer.update(
        <ChatTrajectoryPanel entries={[...entries]} loading={false} onRefresh={vi.fn()} />,
      );
    });
    expect(summaryButtons(renderer)[1].props["aria-expanded"]).toBe(true);
  });

  it("truncates long detail at 6000 characters only when expanded", async () => {
    const longEntry: ChatTrajectoryEntry = {
      ...entries[0],
      id: "entry-long",
      detail: "x".repeat(7000),
    };
    const renderer = render([longEntry]);
    const summary = summaryButtons(renderer)[0];
    await act(() => {
      (summary.props.onClick as () => void)();
    });
    const detail = renderer.root.findAllByProps({ role: "region" })[0];
    const pre = renderer.root.findAllByType("pre")[0];
    expect(textOf(pre)).toHaveLength(6001);
    expect(textOf(pre).endsWith("…")).toBe(true);
    expect(textOf(detail)).toContain("…");
  });
});
