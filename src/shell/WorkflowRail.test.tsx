// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import WorkflowRail from "./WorkflowRail.js";
import type { NeedsMeItem, WorkflowProjection } from "./workflowData.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: {
      findAllByType: (type: string) => Array<{ props: Record<string, unknown>; children: unknown[] }>;
      findAllByProps: (props: Record<string, unknown>) => Array<{ props: Record<string, unknown>; children: unknown[] }>;
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

describe("t222 WorkflowRail", () => {
  it("renders six stages, current stage CTA and locates NeedsMe items", async () => {
    const projection: WorkflowProjection = {
      stage: "review",
      cta: { stage: "review", label: "去评审" },
      focusTaskId: "r1",
    };
    const needs: NeedsMeItem[] = [
      { id: "task:failed:f1", kind: "failed", title: "失败任务", detail: "重试", taskId: "f1" },
      { id: "merge:m1", kind: "merge", title: "待合并", detail: "合并", taskId: "t1" },
    ];
    const onStage = vi.fn();
    const onNeedsMe = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <WorkflowRail
          projection={projection}
          needs={needs}
          onStage={onStage}
          onNeedsMe={onNeedsMe}
        />,
      );
    });
    const buttons = renderer!.root.findAllByType("button");
    expect(buttons.filter((button) => textOf(button.children).match(/讨论|计划|运行|评审|交付|记忆/))).toHaveLength(6);
    const current = renderer!.root.findAllByProps({ "aria-current": "step" });
    expect(current).toHaveLength(1);
    expect(textOf(current[0]!.children)).toContain("去评审");
    await act(() => {
      (current[0]!.props.onClick as () => void)();
    });
    expect(onStage).toHaveBeenCalledWith("review", "r1");
    const planButton = buttons.find((button) => textOf(button.children).includes("计划"));
    expect(planButton).toBeTruthy();
    await act(() => {
      (planButton!.props.onClick as () => void)();
    });
    expect(onStage).toHaveBeenCalledWith("plan", null);

    const needsButton = buttons.find((button) => textOf(button.children).includes("需要我处理"));
    expect(needsButton).toBeTruthy();
    await act(() => {
      (needsButton!.props.onClick as () => void)();
    });
    expect(needsButton!.props["aria-expanded"]).toBe(true);
    expect(needsButton!.props["aria-controls"]).toBe("workflow-needs-list");
    const listbox = renderer!.root.findAllByProps({ role: "listbox" })[0];
    expect(listbox).toBeTruthy();
    expect(listbox!.props.id).toBe("workflow-needs-list");
    await act(() => {
      (listbox!.props.onKeyDown as (event: unknown) => void)({
        key: "ArrowDown",
        preventDefault: vi.fn(),
      });
    });
    const items = renderer!.root.findAllByProps({ role: "option" });
    expect(items).toHaveLength(2);
    expect(items[1]!.props["aria-selected"]).toBe(true);
    await act(() => {
      (items[0]!.props.onClick as () => void)();
    });
    expect(onNeedsMe).toHaveBeenCalledWith(needs[0]);
  });

  it("failed CTA is explicit navigation and carries the task id", async () => {
    const onStage = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <WorkflowRail
          projection={{
            stage: "run",
            cta: { stage: "run", label: "查看失败任务" },
            focusTaskId: "f1",
          }}
          needs={[]}
          onStage={onStage}
          onNeedsMe={() => {}}
        />,
      );
    });
    const current = renderer!.root.findAllByProps({ "aria-current": "step" })[0];
    expect(current).toBeTruthy();
    expect(textOf(current!.children)).toContain("查看失败任务");
    await act(() => {
      (current!.props.onClick as () => void)();
    });
    expect(onStage).toHaveBeenCalledWith("run", "f1");
  });

  it("unknown shows no fake CTA and empty NeedsMe adds no control", async () => {
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <WorkflowRail
          projection={{ stage: "unknown", cta: null, focusTaskId: null }}
          needs={[]}
          onStage={() => {}}
          onNeedsMe={() => {}}
        />,
      );
    });
    expect(renderer!.root.findAllByProps({ "aria-current": "step" })).toHaveLength(0);
    expect(textOf(renderer!.toJSON())).toContain("阶段未知");
    expect(
      renderer!.root
        .findAllByType("button")
        .some((button) => textOf(button.children).includes("需要我处理")),
    ).toBe(false);
    expect(renderer!.root.findAllByProps({ role: "progressbar" })).toHaveLength(0);
  });

  it("renders budget/alerts only with watchdog data and opens the panel", async () => {
    const onOpen = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <WorkflowRail
          projection={{ stage: "run", cta: null, focusTaskId: null }}
          needs={[]}
          watchdog={{ spentUsd: 1.25, limitUsd: 5, ratio: 0.25, softRatio: 0.8, openAlerts: 2, onOpen }}
          onStage={() => {}}
          onNeedsMe={() => {}}
        />,
      );
    });
    expect(renderer!.root.findAllByProps({ role: "group", "aria-label": "看门狗与今日预算" })).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ role: "progressbar" })).toHaveLength(1);
    const budget = renderer!.root.findAllByType("button").find((button) => String(button.props["aria-label"]).includes("今日预算"));
    expect(budget).toBeTruthy();
    await act(() => (budget!.props.onClick as () => void)());
    expect(onOpen).toHaveBeenCalledTimes(1);
    const alert = renderer!.root.findAllByProps({ "aria-label": "打开看门狗，2 个未处理告警" })[0];
    expect(alert).toBeTruthy();
    await act(() => (alert!.props.onClick as () => void)());
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});
