// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import FirstRunCard from "./FirstRunCard.js";
import { deriveFirstRunState } from "./firstRunData.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: {
      findAllByType: (type: string) => Array<{ props: Record<string, unknown>; children: unknown[] }>;
      findAllByProps: (props: Record<string, unknown>) => Array<{ props: Record<string, unknown> }>;
    };
    update: (element: unknown) => void;
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

const state = deriveFirstRunState({
  workspaceName: "Demo",
  workspacePath: "S:\\demo",
  tasksCount: 0,
  messagesCount: 0,
  workerCount: 0,
  modelCount: 1,
  modelId: "p:m",
  modelLabel: "Model · Provider",
  mock: false,
  keyReady: true,
});

describe("t247 FirstRunCard", () => {
  it("shows four checks, one primary CTA and collapsible chip", async () => {
    const onAction = vi.fn();
    const onToggle = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <FirstRunCard state={state} collapsed={false} onToggle={onToggle} onAction={onAction} />,
      );
    });
    expect(renderer!.root.findAllByProps({ "aria-label": "就绪清单" })).toHaveLength(1);
    expect(
      renderer!.root.findAllByProps({ role: "region", "aria-label": "首用就绪" }),
    ).toHaveLength(1);
    expect(textOf(renderer!.toJSON())).toContain("创建团队成员");
    expect(renderer!.root.findAllByType("button").filter((button) => button.props.className === "primary small")).toHaveLength(1);
    const collapse = renderer!.root
      .findAllByType("button")
      .find((button) => textOf(button.children).includes("稍后"))!;
    expect(collapse.props["aria-expanded"]).toBe(true);
    expect(collapse.props["aria-controls"]).toBe("first-run-card-content");
    expect(renderer!.root.findAllByProps({ id: "first-run-card-content" }).length).toBe(1);
    await act(() => {
      (collapse.props.onClick as () => void)();
    });
    expect(onToggle).toHaveBeenCalled();
    await act(async () => {
      renderer!.update(
        <FirstRunCard state={state} collapsed onToggle={onToggle} onAction={onAction} />,
      );
    });
    expect(textOf(renderer!.toJSON())).toContain("首用就绪检查");
    const expand = renderer!.root
      .findAllByType("button")
      .find((button) => textOf(button.children).includes("首用就绪检查"))!;
    expect(expand.props["aria-expanded"]).toBe(false);
    expect(expand.props["aria-controls"]).toBe("first-run-card-content");
    expect(renderer!.root.findAllByProps({ id: "first-run-card-content" }).length).toBe(1);
  });
});
