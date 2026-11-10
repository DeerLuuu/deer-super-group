import { describe, expect, it } from "vitest";
import { runAgentLoop } from "./loop.js";
import { MockClient } from "./model.js";
import {
  ToolRegistry,
  toolAllowedByPolicy,
  type ToolContext,
  type ToolDefinition,
} from "./tools.js";

function tool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ ok: true }),
  };
}

const context = {
  workspaceId: "ws",
  workspacePath: ".",
  worktreePath: ".",
  taskId: "",
  runId: "run",
  agentId: "agent",
  agentName: "Router",
  store: {} as ToolContext["store"],
  permission: "read_only",
} satisfies ToolContext;

describe("t171 tool policy", () => {
  it("uses chat context policy instead of agent role", () => {
    expect(toolAllowedByPolicy(tool("task.complete"), { mode: "chat" })).toBe(false);
    expect(toolAllowedByPolicy(tool("fs.read"), { mode: "chat" })).toBe(true);
    expect(toolAllowedByPolicy(tool("task.complete"), { mode: "task", taskId: "t1" })).toBe(true);
    expect(toolAllowedByPolicy(tool("task.complete"), { mode: "task" })).toBe(false);
  });

  it("filters schemas and rejects unavailable tool execution", async () => {
    const registry = new ToolRegistry().registerAll([
      tool("fs.read"),
      tool("task.complete"),
    ]);
    expect(registry.list({ mode: "chat" }).map((item) => item.name)).toEqual(["fs.read"]);
    const denied = await registry.execute("task.complete", {}, context, { mode: "chat" });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("not available");
    const allowed = await registry.execute("fs.read", {}, context, { mode: "chat" });
    expect(allowed.ok).toBe(true);
  });

  it("runs a chat tool loop but rejects task.complete without task context", async () => {
    let completed = false;
    const registry = new ToolRegistry().registerAll([
      {
        name: "fs.list",
        description: "list",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ entries: ["README.md"] }),
      },
      {
        name: "task.complete",
        description: "complete",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          completed = true;
          return { ok: true };
        },
      },
    ]);
    const result = await runAgentLoop({
      client: new MockClient(),
      model: "mock",
      systemPrompt: "SYSTEM",
      userMessage: "do the work",
      tools: registry,
      toolContext: context,
      toolPolicy: { mode: "chat", taskId: null },
      maxSteps: 5,
    });
    expect(result.text).toContain("任务已完成");
    expect(completed).toBe(false);
  });
});
