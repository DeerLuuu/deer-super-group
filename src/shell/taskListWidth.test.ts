import { describe, expect, it } from "vitest";
import {
  TASK_LIST_DEFAULT_WIDTH,
  TASK_LIST_MAX_WIDTH,
  clampTaskListWidth,
  commitTaskListWidth,
  displayedTaskListWidth,
  isNarrowTaskListWidth,
  resizeTaskListWidth,
  taskListMaxWidth,
  taskListWidthStateForLayout,
} from "./taskListWidth.js";

describe("task list preferred/displayed width", () => {
  it("keeps a wide-layout preferred width and persists clamped committed value", () => {
    expect(taskListMaxWidth(1440)).toBe(TASK_LIST_MAX_WIDTH);
    expect(displayedTaskListWidth({ preferred: 500, displayed: null }, 1440)).toBe(500);
    const resized = resizeTaskListWidth({ preferred: 500, displayed: null }, 1440, 900);
    expect(resized).toEqual({ preferred: 520, displayed: null });
    expect(commitTaskListWidth(resized, 1440)).toMatchObject({ preferred: 520, persist: true });
  });

  it("only changes displayed in a narrow layout and preserves preferred on return to wide", () => {
    expect(isNarrowTaskListWidth(960)).toBe(true);
    expect(isNarrowTaskListWidth(1440)).toBe(false);
    const initial = { preferred: 500, displayed: null };
    // Displayed is clamped to 499, preferred stays 500.
    expect(displayedTaskListWidth(initial, 960)).toBe(499);
    const dragged = resizeTaskListWidth(initial, 960, 300);
    expect(dragged).toEqual({ preferred: 500, displayed: 300 });
    const committed = commitTaskListWidth(dragged, 960);
    expect(committed.persist).toBe(false);
    expect(committed.preferred).toBe(500);
    // Layout switch back clears display override and restores preferred.
    expect(taskListWidthStateForLayout(dragged, 1440)).toEqual({ preferred: 500, displayed: null });
    expect(displayedTaskListWidth(dragged, 1440)).toBe(500);
  });

  it("re-clamps a display override when the layout shrinks and preserves preferred in steps", () => {
    const state = { preferred: 500, displayed: 450 };
    expect(taskListWidthStateForLayout(state, 760)).toEqual({ preferred: 500, displayed: 395 });
    expect(displayedTaskListWidth(state, 760)).toBe(395);
    // Keyboard step in narrow changes displayed only.
    const stepped = resizeTaskListWidth(
      { preferred: 500, displayed: 300 },
      760,
      300 + 16,
    );
    expect(stepped.preferred).toBe(500);
    expect(stepped.displayed).toBe(316);
  });

  it("handles defaults/invalid values through the shared clamp", () => {
    expect(TASK_LIST_DEFAULT_WIDTH).toBe(380);
    expect(clampTaskListWidth(Number.NaN, 1440)).toBe(380);
    expect(clampTaskListWidth(-2, 1440)).toBe(280);
    expect(clampTaskListWidth(9999, 760)).toBe(395);
    expect(taskListWidthStateForLayout({ preferred: 380, displayed: null }, 760)).toEqual({
      preferred: 380,
      displayed: null,
    });
  });
});
