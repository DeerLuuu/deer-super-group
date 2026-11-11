// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import TaskWorkspaceTabs from "./TaskWorkspaceTabs.js";
import type { TaskWorkspaceTab } from "./taskWorkspaceData.js";
import { taskWorkspacePanelId } from "./taskWorkspaceData.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: {
      findAllByType: (type: string) => Array<{ props: Record<string, unknown>; children: unknown[] }>;
      findAllByProps: (props: Record<string, unknown>) => Array<{ props: Record<string, unknown> }>;
    };
  };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (value && typeof value === "object") return textOf((value as { children?: unknown }).children);
  return "";
}

describe("t241 TaskWorkspaceTabs", () => {
  it("renders five ARIA tabs with roving tabindex and keyboard navigation", async () => {
    const onChange = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<TaskWorkspaceTabs tab="overview" onChange={onChange} counts={{ runs: 2 }} />);
    });
    const tabs = renderer!.root.findAllByProps({ role: "tab" });
    expect(tabs.map((tab) => textOf(tab.props.children).trim().slice(0, 2))).toEqual([
      "概览",
      "运行",
      "评审",
      "Gi",
      "历史",
    ]);
    expect(tabs[0]!.props["aria-selected"]).toBe(true);
    expect(tabs[0]!.props.tabIndex).toBe(0);
    expect(tabs[1]!.props.tabIndex).toBe(-1);
    expect(tabs[1]!.props["aria-controls"]).toBe("task-panel-runs");
    expect(taskWorkspacePanelId("runs")).toBe("task-panel-runs");

    await act(() => {
      (tabs[1]!.props.onClick as () => void)();
    });
    expect(onChange).toHaveBeenCalledWith("runs");

    await act(() => {
      (renderer!.root.findAllByProps({ role: "tablist" })[0]!.props.onKeyDown as (event: unknown) => void)({
        key: "End",
        preventDefault: vi.fn(),
        currentTarget: { querySelector: () => null },
      });
    });
    expect(onChange).toHaveBeenCalledWith("history");
  });

  it("moves active tab with Arrow/Home/End and keeps aria-controls on the active panel", async () => {
    function Harness() {
      const [tab, setTab] = useState<TaskWorkspaceTab>("overview");
      return <TaskWorkspaceTabs tab={tab} onChange={setTab} />;
    }
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<Harness />);
    });
    const tablist = () =>
      renderer!.root.findAllByProps({ role: "tablist" })[0]!;
    const activeTab = () =>
      renderer!.root.findAllByProps({ role: "tab" }).find((tab) => tab.props["aria-selected"]);
    const press = async (key: string) => {
      await act(() => {
        (tablist().props.onKeyDown as (event: unknown) => void)({
          key,
          preventDefault: vi.fn(),
          currentTarget: { querySelector: () => null },
        });
      });
    };

    await press("ArrowRight");
    expect(activeTab()!.props["aria-controls"]).toBe("task-panel-runs");
    await press("End");
    expect(activeTab()!.props["aria-controls"]).toBe("task-panel-history");
    await press("Home");
    expect(activeTab()!.props["aria-controls"]).toBe("task-panel-overview");
    await press("ArrowLeft");
    expect(activeTab()!.props["aria-controls"]).toBe("task-panel-history");
  });
});
