import { describe, expect, it } from "vitest";
import { deriveFirstRunState, resolveFirstRunKeyStatus } from "./firstRunData.js";

const base = {
  workspaceName: "Demo",
  workspacePath: "S:\\demo",
  tasksCount: 0,
  messagesCount: 0,
  workerCount: 1,
  modelCount: 1,
  modelId: "provider_default:deepseek-flash",
  modelLabel: "DeepSeek Flash · Default",
  mock: false,
  keyReady: true,
};

describe("t247 first-run readiness", () => {
  it("shows honest blocking checks and one CTA for missing key", () => {
    const state = deriveFirstRunState({ ...base, keyReady: false });
    expect(state.ready).toBe(false);
    expect(state.show).toBe(true);
    const credentials = state.checks.find((check) => check.key === "credentials");
    expect(credentials!.ok).toBe(false);
    expect(credentials!.detail).toContain("未配置");
    expect(state.action).toEqual({ kind: "settings-key", label: "配置 API Key" });
  });

  it("uses Team CTA when no worker, and chat CTA when ready on empty workspace", () => {
    const noMember = deriveFirstRunState({ ...base, workerCount: 0 });
    expect(noMember.action.kind).toBe("team");
    const ready = deriveFirstRunState(base);
    expect(ready.ready).toBe(true);
    expect(ready.action).toEqual({ kind: "chat", label: "开始对话" });
  });

  it("treats Mock as credentials-ready and hides the card once workspace has content", () => {
    const mock = deriveFirstRunState({ ...base, mock: true, keyReady: false });
    expect(mock.ready).toBe(true);
    expect(mock.keyDetail).toContain("Mock");
    const populated = deriveFirstRunState({ ...base, tasksCount: 2, messagesCount: 3 });
    expect(populated.show).toBe(false);
  });

  it("checks only the current model provider (A has key, B missing → not ready)", () => {
    const providers = [
      { id: "a", name: "Provider A", apiKeySource: "local" as const },
      { id: "b", name: "Provider B", apiKeySource: "none" as const },
    ];
    const currentB = resolveFirstRunKeyStatus(providers, { providerId: "b" });
    expect(currentB).toMatchObject({ keyReady: false, providerName: "Provider B" });
    const state = deriveFirstRunState({
      ...base,
      keyReady: currentB.keyReady,
      keyProviderName: currentB.providerName,
    });
    expect(state.ready).toBe(false);
    expect(state.action).toEqual({ kind: "settings-key", label: "配置 API Key" });
    expect(state.keyDetail).toContain("Provider B");
    expect(resolveFirstRunKeyStatus(providers, { providerId: "a" }).keyReady).toBe(true);
    expect(resolveFirstRunKeyStatus(providers, null).keyReady).toBe(false);
  });
});
