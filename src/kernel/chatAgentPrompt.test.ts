import { describe, expect, it } from "vitest";
import { INTERACTIVE_PROMPT_V1 } from "../shared/interactive.js";
import type { Agent, Workspace } from "../shared/types.js";
import { buildAgentSystemPrompt } from "./chatAgentPrompt.js";

const workspace = {
  id: "ws",
  name: "Demo",
  path: "S:/demo",
  overview: "Overview text",
} as Workspace;

const member = {
  id: "a1",
  workspaceId: "ws",
  name: "Mika",
  role: "Designer",
  systemPrompt: "Member instructions",
  persona: "Calm persona",
  agentsMd: "Member AGENTS",
  model: "deepseek-flash",
  permission: "workspace_write",
  isRouter: false,
  status: "idle",
  createdAt: "",
} as Agent;

describe("t424 buildAgentSystemPrompt", () => {
  it("contains member identity/instructions and workspace context", () => {
    const prompt = buildAgentSystemPrompt(member, workspace);
    expect(prompt).toContain("Mika");
    expect(prompt).toContain("Designer");
    expect(prompt).toContain("Member instructions");
    expect(prompt).toContain("Calm persona");
    expect(prompt).toContain("Member AGENTS");
    expect(prompt).toContain("Overview text");
  });

  it("does not inject Router-only interactive/canvas/team prompts", () => {
    const prompt = buildAgentSystemPrompt(member, workspace);
    expect(prompt).not.toContain(INTERACTIVE_PROMPT_V1);
    expect(prompt).not.toContain("deer-canvas");
    expect(prompt).not.toContain("deer-question");
    expect(prompt).not.toContain("Router, the coordinator");
    expect(prompt).not.toContain("Team:");
  });
});
