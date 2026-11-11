// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { PlanDraft, PlanDraftTask, PlanSource } from "../shared/planDraft.js";
import PlanDraftPanel from "./PlanDraftPanel.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: {
      findAllByType: (type: string) => Array<{ props: Record<string, unknown>; children: unknown[] }>;
      findAllByProps: (props: Record<string, unknown>) => Array<{ props: Record<string, unknown> }>;
    };
    toJSON: () => unknown;
  };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (value && typeof value === "object") return textOf((value as { children?: unknown }).children);
  return "";
}

function source(): PlanSource {
  return {
    goal: "实现",
    goalSource: "composer",
    messages: [{ role: "user", content: "约束" }],
    summary: "",
    overview: "",
    characterCount: 3,
    digest: "1234abcd",
  };
}

function task(id: string, title: string, extra: Partial<PlanDraftTask> = {}): PlanDraftTask {
  return {
    id,
    title,
    description: "",
    acceptance: ["done"],
    dependsOn: [],
    ownerId: null,
    priority: 50,
    risks: [],
    unknowns: [],
    ...extra,
  };
}

function draft(tasks: PlanDraftTask[]): PlanDraft {
  return { source: source(), tasks };
}

describe("t231 PlanDraftPanel", () => {
  it("renders source/contracts and calls add/confirm/cancel callbacks", async () => {
    const onDraftChange = vi.fn();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <PlanDraftPanel
          draft={draft([task("a", "First"), task("b", "Second", { dependsOn: ["a"] })])}
          source={source()}
          issues={[]}
          agents={[]}
          busy={false}
          error={null}
          confirming={false}
          onDraftChange={onDraftChange}
          onGoalChange={() => {}}
          onConfirm={onConfirm}
          onCancel={onCancel}
          onRetry={() => {}}
        />,
      );
    });
    expect(textOf(renderer!.toJSON())).toContain("来源：当前对话");
    expect(textOf(renderer!.toJSON())).toContain("未分配负责人");
    const add = renderer!.root.findAllByType("button").find((button) => textOf(button.children).includes("添加任务"));
    await act(() => {
      (add!.props.onClick as () => void)();
    });
    expect(onDraftChange).toHaveBeenCalled();
    expect((onDraftChange.mock.calls[0]![0] as PlanDraft).tasks).toHaveLength(3);
    expect((onDraftChange.mock.calls[0]![0] as PlanDraft).tasks[2]!.id).toMatch(/^draft-\d+$/);
    expect(
      renderer!.root.findAllByProps({ "aria-live": "polite" }).length,
    ).toBeGreaterThan(0);

    const confirm = renderer!.root.findAllByType("button").find((button) => textOf(button.children).includes("确认创建"));
    await act(() => {
      (confirm!.props.onClick as () => void)();
    });
    expect(onConfirm).toHaveBeenCalledWith(false);
    const cancel = renderer!.root.findAllByType("button").find((button) => textOf(button.children).includes("取消"));
    await act(() => {
      (cancel!.props.onClick as () => void)();
    });
    expect(onCancel).toHaveBeenCalled();
  });

  it("blocks high-risk confirm until ack and shows validation errors", async () => {
    const onConfirm = vi.fn();
    const draftValue = draft([task("a", "Delete migration secret", { description: "delete data" })]);
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <PlanDraftPanel
          draft={draftValue}
          source={source()}
          issues={[
            {
              code: "TASK_TITLE_EMPTY",
              severity: "error",
              message: "任务标题不能为空",
              taskId: "a",
            },
          ]}
          agents={[]}
          busy={false}
          error={null}
          confirming={false}
          onDraftChange={() => {}}
          onGoalChange={() => {}}
          onConfirm={onConfirm}
          onCancel={() => {}}
          onRetry={() => {}}
        />,
      );
    });
    const confirm = renderer!.root.findAllByType("button").find((button) => textOf(button.children).includes("确认创建"));
    expect(confirm!.props.disabled).toBe(true);
    expect(textOf(renderer!.toJSON())).toContain("任务标题不能为空");
    const ack = renderer!.root.findAllByType("input").find((input) => input.props.type === "checkbox");
    expect(ack).toBeTruthy();
    await act(() => {
      (ack!.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    });
    // Still disabled because the error remains, despite ack.
    expect(confirm!.props.disabled).toBe(true);
  });
});
