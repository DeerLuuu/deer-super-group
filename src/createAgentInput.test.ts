import { describe, expect, it } from "vitest";
import type { CreateAgentInput } from "./shared/types.js";
import { stripCreateAgentPermission } from "./shared/memberRecommendation.js";

describe("t278 CreateAgentInput permission guard", () => {
  it("does not accept permission in the typed create input", () => {
    const input: CreateAgentInput = {
      workspaceId: "w1",
      name: "Builder",
      role: "engineer",
      systemPrompt: "",
      persona: "",
      agentsMd: "",
      model: null,
      // @ts-expect-error t278: createAgent must not accept a permission override.
      permission: "workspace_write",
    };
    expect("permission" in input).toBe(true);
  });

  it("strips permission and unknown fields at the IPC boundary", () => {
    const payload = stripCreateAgentPermission({
      workspaceId: "w1",
      name: "Builder",
      role: "engineer",
      systemPrompt: "",
      persona: "",
      agentsMd: "",
      model: null,
      permission: "full_access",
      isRouter: true,
    } as CreateAgentInput & { permission: string; isRouter: boolean });
    expect(payload).not.toHaveProperty("permission");
    expect(payload).not.toHaveProperty("isRouter");
    expect(payload.name).toBe("Builder");
  });
});
