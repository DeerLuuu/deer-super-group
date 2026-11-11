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
  });
});
