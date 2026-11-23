import { describe, expect, it } from "vitest";
import { computeDropPosition } from "./dropPosition";

describe("t576 computeDropPosition", () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 };

  it("returns nearest edge within 25%", () => {
    expect(computeDropPosition(110, 150, rect)).toBe("left");
    expect(computeDropPosition(490, 150, rect)).toBe("right");
    expect(computeDropPosition(300, 60, rect)).toBe("above");
    expect(computeDropPosition(300, 240, rect)).toBe("below");
  });

  it("uses nearest axis when diagonal", () => {
    // near top-left: x=8%, y=20% → left is nearer than above.
    expect(computeDropPosition(132, 90, rect)).toBe("left");
    // near top-right: x=92%, y=5% → above is nearer than right.
    expect(computeDropPosition(468, 60, rect)).toBe("above");
  });

  it("returns center when all four edges are farther than 25%", () => {
    expect(computeDropPosition(300, 150, rect)).toBe("center");
    expect(computeDropPosition(260, 110, rect)).toBe("center");
  });

  it("clamps pointer outside the rect and handles empty rect", () => {
    expect(computeDropPosition(0, 150, rect)).toBe("left");
    expect(computeDropPosition(9999, 150, rect)).toBe("right");
    expect(computeDropPosition(300, 9999, rect)).toBe("below");
    expect(computeDropPosition(100, 50, { left: 0, top: 0, width: 0, height: 0 })).toBe("center");
  });
});
