// @ts-expect-error React 19 test renderer is shipped as JS without bundled types in this repo.
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import SeparatorControl from "./SeparatorControl.js";
import { clampSidebarWidth, sidebarMaxWidth } from "./dock/narrowWindow.js";
import { clampTaskListWidth, taskListMaxWidth } from "./taskListWidth.js";

const { act, create } = TestRenderer as {
  act: (callback: () => void | Promise<void>) => Promise<void> | void;
  create: (element: unknown) => {
    root: {
      findAllByProps: (props: Record<string, unknown>) => Array<{ props: Record<string, unknown> }>;
    };
  };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("t296 keyboard resizer", () => {
  it("exposes clamped aria values and steps with Arrow/Home", async () => {
    const onStep = vi.fn();
    const onReset = vi.fn();
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        <SeparatorControl
          label="调整侧栏宽度"
          value={480}
          min={180}
          max={394}
          onStep={onStep}
          onReset={onReset}
        />,
      );
    });
    const node = renderer!.root.findAllByProps({ role: "separator" })[0]!;
    expect(node.props["aria-valuenow"]).toBe(394);
    expect(node.props["aria-valuemax"]).toBe(394);
    await act(() => {
      (node.props.onKeyDown as (event: unknown) => void)({
        key: "ArrowRight",
        preventDefault: vi.fn(),
      });
    });
    expect(onStep).toHaveBeenCalledWith(16);
    await act(() => {
      (node.props.onKeyDown as (event: unknown) => void)({
        key: "Home",
        preventDefault: vi.fn(),
      });
    });
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("clamps sidebar widths to the viewport-specific maximum", () => {
    expect(sidebarMaxWidth(960)).toBe(394);
    expect(sidebarMaxWidth(900)).toBe(334);
    expect(sidebarMaxWidth(760)).toBe(194);
    expect(sidebarMaxWidth(480)).toBe(180);
    expect(clampSidebarWidth(480, 960)).toBe(394);
    expect(clampSidebarWidth(480, 900)).toBe(334);
    expect(clampSidebarWidth(480, 760)).toBe(194);
    expect(clampSidebarWidth(480, 480)).toBe(180);
    expect(taskListMaxWidth(960)).toBe(499);
    expect(taskListMaxWidth(900)).toBe(468);
    expect(taskListMaxWidth(760)).toBe(395);
    expect(taskListMaxWidth(480)).toBe(280);
    expect(clampTaskListWidth(520, 480)).toBe(280);
  });
});
