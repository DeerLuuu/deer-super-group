import { describe, expect, it } from "vitest";
import type { Agent } from "./types.js";
import {
  chatAbortKey,
  chatAgentOptions,
  isRouterOnlyChatCommand,
  resolveChatAgent,
} from "./chatAgent.js";

const agent = (id: string, name: string, isRouter: boolean): Agent => ({
  id,
  workspaceId: "ws",
  name,
  role: isRouter ? "Router" : "Designer",
  systemPrompt: "",
  persona: "",
  agentsMd: "",
  model: null,
  permission: "workspace_write",
  isRouter,
  status: "idle",
  createdAt: "",
});

const router = agent("router", "Router", true);
const member = agent("a1", "Mika", false);

describe("t424 chat agent helpers", () => {
  it("resolves a requested agent and falls back to Router for invalid ids", () => {
    expect(resolveChatAgent([member, router], "a1")?.id).toBe("a1");
    expect(resolveChatAgent([member, router], "missing")?.id).toBe("router");
    expect(resolveChatAgent([member, router], null)?.id).toBe("router");
  });

  it("orders Router first in switcher options", () => {
    expect(chatAgentOptions([member, router]).map((item) => item.id)).toEqual([
      "router",
      "a1",
    ]);
  });

  it("isolates abort keys by workspace and agent", () => {
    expect(chatAbortKey("ws", "a1")).toBe("ws:a1");
    expect(chatAbortKey("ws", "a1")).not.toBe(chatAbortKey("ws", "router"));
  });

  it("detects Router-only slash commands without matching /teamfoo", () => {
    expect(isRouterOnlyChatCommand("/clear")).toBe(true);
    expect(isRouterOnlyChatCommand(" /TEAM 缺人 ")).toBe(true);
    expect(isRouterOnlyChatCommand("/compact")).toBe(true);
    expect(isRouterOnlyChatCommand("/teamfoo")).toBe(false);
    expect(isRouterOnlyChatCommand("please /clear")).toBe(false);
  });
});
