import { describe, expect, it } from "vitest";
import {
  SECTION_RATIO_DEFAULT,
  attachSectionDrag,
  clampSectionRatio,
  ratioAfterDrag,
  ratioAfterKey,
} from "./gitWorkingLayout.js";

describe("t407 working section layout", () => {
  it("clamps pointer drag between 20 and 80 percent", () => {
    expect(ratioAfterDrag(38, 100, 400)).toBe(63);
    expect(ratioAfterDrag(38, 10_000, 400)).toBe(80);
    expect(ratioAfterDrag(38, -10_000, 400)).toBe(20);
    expect(ratioAfterDrag(38, 100, 0)).toBe(38);
    expect(clampSectionRatio(5)).toBe(20);
    expect(clampSectionRatio(99)).toBe(80);
  });

  it("supports ArrowUp/Down and Home with 20/80 clamp", () => {
    expect(ratioAfterKey(38, "ArrowDown")).toBe(43);
    expect(ratioAfterKey(38, "ArrowUp")).toBe(33);
    expect(ratioAfterKey(38, "Home")).toBe(SECTION_RATIO_DEFAULT);
    expect(ratioAfterKey(79, "ArrowDown")).toBe(80);
    expect(ratioAfterKey(21, "ArrowUp")).toBe(20);
    expect(ratioAfterKey(38, "Enter")).toBeNull();
  });

  it("wires pointerdown/move/up drag and removes listeners on pointerup", () => {
    const listeners = new Map<string, (event: { clientY: number }) => void>();
    const target = {
      addEventListener: (type: string, listener: (event: { clientY: number }) => void) => {
        listeners.set(type, listener);
      },
      removeEventListener: (type: string) => {
        listeners.delete(type);
      },
    };
    const ratios: number[] = [];
    const cleanup = attachSectionDrag({
      startY: 100,
      startRatio: 38,
      height: 400,
      onRatio: (ratio) => ratios.push(ratio),
      target,
    });
    expect(listeners.has("pointermove")).toBe(true);
    listeners.get("pointermove")!({ clientY: 180 });
    listeners.get("pointermove")!({ clientY: 10_000 });
    expect(ratios).toEqual([58, 80]);
    listeners.get("pointerup")!({ clientY: 0 });
    expect(listeners.size).toBe(0);
    cleanup();
  });
});
