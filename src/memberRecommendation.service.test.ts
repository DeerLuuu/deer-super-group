import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const client = vi.hoisted(() => ({
  complete: vi.fn(),
}));

vi.mock("./kernel/model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./kernel/model.js")>();
  return {
    ...actual,
    createLlmClientForModel: () => ({
      complete: client.complete,
      stream: async function* () {},
    }),
  };
});

import { AppService } from "./kernel/service.js";
import { defaultModelProfile, defaultProviderProfile } from "./shared/models.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  client.complete.mockReset();
  while (cleanup.length) cleanup.pop()?.();
});

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "deer-rec-"));
  const workspacePath = path.join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const service = new AppService(path.join(root, "data"));
  const provider = defaultProviderProfile(
    { baseUrl: "https://example.com/v1", baseUrlEnv: "", apiKey: "test-key", apiKeyEnv: "" },
    "p1",
    "Provider",
  );
  const model = defaultModelProfile("glm-5.3", "p1");
  service.saveSettings({
    baseUrl: provider.baseUrl,
    baseUrlEnv: "",
    apiKey: provider.apiKey,
    apiKeyEnv: "",
    providers: [provider],
    model: model.id,
    models: [model],
    mock: false,
  });
  cleanup.push(() => {
    service.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { service, workspacePath };
}

describe("t278 recommendation failure codes", () => {
  it("maps 429 and 401 to explicit codes without creating agents", async () => {
    const { service, workspacePath } = setup();
    const workspace = await service.openWorkspace(workspacePath);
    const before = service.getSnapshot(workspace.id).agents.length;

    client.complete.mockRejectedValueOnce(new Error("429 rate limit"));
    await expect(
      service.recommendMembers({ workspaceId: workspace.id, mode: "team-gap" }),
    ).resolves.toMatchObject({ ok: false, code: "RECOMMEND_RATE_LIMITED" });

    client.complete.mockRejectedValueOnce(new Error("401 unauthorized"));
    await expect(
      service.recommendMembers({ workspaceId: workspace.id, mode: "team-gap" }),
    ).resolves.toMatchObject({ ok: false, code: "RECOMMEND_AUTH_FAILED" });
    expect(service.getSnapshot(workspace.id).agents.length).toBe(before);
  });

  it("maps timeout and empty candidates without fabricating members", async () => {
    vi.useFakeTimers();
    const { service, workspacePath } = setup();
    const workspace = await service.openWorkspace(workspacePath);
    const before = service.getSnapshot(workspace.id).agents.length;

    client.complete.mockImplementationOnce(
      (request: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const pending = service.recommendMembers({ workspaceId: workspace.id, mode: "team-gap" });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toMatchObject({ ok: false, code: "RECOMMEND_TIMEOUT" });

    client.complete.mockResolvedValueOnce({
      text: JSON.stringify({ candidates: [] }),
      reasoning: "",
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    await expect(
      service.recommendMembers({
        workspaceId: workspace.id,
        mode: "description",
        description: "需要 QA",
      }),
    ).resolves.toMatchObject({ ok: false, code: "RECOMMEND_EMPTY" });
    expect(service.getSnapshot(workspace.id).agents.length).toBe(before);
  });

  it("redacts recent chat secrets before building the provider prompt", async () => {
    const { service, workspacePath } = setup();
    const workspace = await service.openWorkspace(workspacePath);
    const router = service.getSnapshot(workspace.id).agents.find((agent) => agent.isRouter)!;
    const store = (
      service as unknown as {
        store: { addChatMessage(input: unknown): unknown };
      }
    ).store;
    store.addChatMessage({
      workspaceId: workspace.id,
      agentId: router.id,
      role: "user",
      content: "sk-live-ABC123456 Authorization: Bearer abc.def token=secret123",
    });
    service.createTask({
      workspaceId: workspace.id,
      title: "Fix sk-live-TASKTITLE123456",
      description: "detail sk-live-TASKDESC123456",
      acceptance: [],
    });
    client.complete.mockResolvedValueOnce({
      text: JSON.stringify({ candidates: [] }),
      reasoning: "",
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    await service.recommendMembers({ workspaceId: workspace.id, mode: "team-gap" });
    const request = client.complete.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = request.messages.map((message) => message.content).join("\n");
    expect(prompt).not.toContain("sk-live-ABC123456");
    expect(prompt).not.toContain("Bearer abc.def");
    expect(prompt).not.toContain("secret123");
    expect(prompt).not.toContain("sk-live-TASKTITLE123456");
    expect(prompt).not.toContain("sk-live-TASKDESC123456");
  });
});
