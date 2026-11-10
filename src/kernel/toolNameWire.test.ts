import { describe, expect, it } from "vitest";
import { decodeToolName, encodeToolName } from "./model.js";
import { createBuiltinTools } from "./tools.js";

describe("t172 tool wire names", () => {
  it("encodes dotted internal names to provider-safe names and round-trips", () => {
    for (const tool of createBuiltinTools()) {
      const wire = encodeToolName(tool.name);
      expect(wire).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(decodeToolName(wire)).toBe(tool.name);
    }
    expect(encodeToolName("memory.memo.write")).toBe("memory__memo__write");
    expect(decodeToolName("memory__memo__write")).toBe("memory.memo.write");
  });
});
