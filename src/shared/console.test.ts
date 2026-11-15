import { describe, expect, it } from "vitest";
import {
  consoleInputSchema,
  consoleSessionSchema,
  consoleStartSchema,
  consoleWorkspaceSchema,
} from "./console.js";

describe("t448 console IPC schemas", () => {
  it("accepts valid start payloads and rejects unknown/oversized fields", () => {
    expect(
      consoleStartSchema.safeParse({
        workspaceId: "ws-1",
        command: "pnpm test",
        title: "tests",
        cwd: ".",
      }).success,
    ).toBe(true);
    expect(
      consoleStartSchema.safeParse({ workspaceId: "ws-1", command: "x", extra: true }).success,
    ).toBe(false);
    expect(consoleStartSchema.safeParse({ workspaceId: "ws-1", command: "" }).success).toBe(false);
    expect(
      consoleStartSchema.safeParse({ workspaceId: "ws-1", command: "x".repeat(4097) }).success,
    ).toBe(false);
  });

  it("bounds stdin/session/workspace ids and rejects unknown fields", () => {
    expect(consoleWorkspaceSchema.safeParse({ workspaceId: "ws-1" }).success).toBe(true);
    expect(consoleWorkspaceSchema.safeParse({ workspaceId: "" }).success).toBe(false);
    expect(consoleSessionSchema.safeParse({ workspaceId: "ws", sessionId: "con_1" }).success).toBe(
      true,
    );
    expect(
      consoleInputSchema.safeParse({
        workspaceId: "ws",
        sessionId: "con_1",
        data: "x".repeat(4097),
      }).success,
    ).toBe(false);
    expect(
      consoleInputSchema.safeParse({
        workspaceId: "ws",
        sessionId: "con_1",
        data: "ok",
        extra: 1,
      }).success,
    ).toBe(false);
  });
});
