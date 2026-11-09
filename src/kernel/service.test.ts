import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatEvent } from "../shared/types.js";
import { defaultModelProfile, defaultProviderProfile } from "../shared/models.js";
import { AppService } from "./service.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "deer-test-"));
  const workspacePath = path.join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(path.join(workspacePath, "README.md"), "# Demo\n\nA tiny repo.\n", "utf8");
  const service = new AppService(path.join(root, "data"));
  cleanup.push(() => {
    service.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { service, workspacePath };
}

describe("AppService", () => {
  it("opens a workspace and creates a Router", async () => {
    const { service, workspacePath } = setup();
    const workspace = await service.openWorkspace(workspacePath);
    const snapshot = service.getSnapshot(workspace.id);
    expect(snapshot.agents.some((agent) => agent.isRouter)).toBe(true);
    expect(snapshot.workspace.overview).toContain("README.md");
  });

  it("plans tasks with dependencies in mock mode", async () => {
    const { service, workspacePath } = setup();
    const workspace = await service.openWorkspace(workspacePath);
    const tasks = await service.plan(workspace.id, "给项目加一个健康检查接口");
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    const snapshot = service.getSnapshot(workspace.id);
    expect(snapshot.tasks.some((task) => task.dependsOn.length > 0)).toBe(true);
  });

  it("resolves the API key and base URL from system environment variables", async () => {
    process.env.DEER_TEST_API_KEY = "env-secret";
    process.env.DEER_TEST_BASE_URL = "https://env.example.com/v1";
    try {
      const { service } = setup();
      const info = service.saveSettings({
        baseUrl: "https://example.com/v1",
        baseUrlEnv: "DEER_TEST_BASE_URL",
        apiKey: "",
        apiKeyEnv: "DEER_TEST_API_KEY",
        providers: [
          defaultProviderProfile(
            {
              baseUrl: "https://example.com/v1",
              baseUrlEnv: "DEER_TEST_BASE_URL",
              apiKey: "",
              apiKeyEnv: "DEER_TEST_API_KEY",
            },
            "provider_default",
            "Test Provider",
          ),
        ],
        model: "test-model",
        models: [defaultModelProfile("test-model")],
        mock: false,
      });
      expect(info.apiKeySource).toBe("env");
      expect(info.apiKeyEnvActive).toBe("DEER_TEST_API_KEY");
      expect(info.apiKeyEnvSet).toBe(true);
      expect(info.baseUrlSource).toBe("env");
      expect(info.baseUrlEnvActive).toBe("DEER_TEST_BASE_URL");
      expect(info.effectiveBaseUrl).toBe("https://env.example.com/v1");
    } finally {
      delete process.env.DEER_TEST_API_KEY;
      delete process.env.DEER_TEST_BASE_URL;
    }
  });

  it("stores multiple providers and multiple models", () => {
    const { service } = setup();
    const p1 = defaultProviderProfile(
      { baseUrl: "https://one.example/v1", baseUrlEnv: "", apiKey: "one", apiKeyEnv: "" },
      "p1",
      "Provider One",
    );
    const p2 = defaultProviderProfile(
      { baseUrl: "https://two.example/v1", baseUrlEnv: "", apiKey: "two", apiKeyEnv: "" },
      "p2",
      "Provider Two",
    );
    const info = service.saveSettings({
      baseUrl: p1.baseUrl,
      baseUrlEnv: "",
      apiKey: p1.apiKey,
      apiKeyEnv: "",
      providers: [p1, p2],
      model: "p2:deepseek",
      models: [
        defaultModelProfile("deepseek", "p1"),
        defaultModelProfile("deepseek", "p2"),
      ],
      mock: true,
    });

    expect(info.providers.map((provider) => provider.id)).toEqual(["p1", "p2"]);
    expect(info.models.map((model) => model.id)).toEqual(["p1:deepseek", "p2:deepseek"]);
    expect(info.model).toBe("p2:deepseek");
  });

  it("updates a member and validates model selection", async () => {
    const { service, workspacePath } = setup();
    const workspace = await service.openWorkspace(workspacePath);
    service.saveSettings({
      baseUrl: "https://example.com/v1",
      baseUrlEnv: "",
      apiKey: "",
      apiKeyEnv: "",
      providers: [defaultProviderProfile({}, "provider_default", "Default")],
      model: "provider_default:deepseek-flash",
      models: [defaultModelProfile("deepseek-flash")],
      mock: true,
    });
    const agent = service.createAgent({
      workspaceId: workspace.id,
      name: "Builder",
      role: "engineer",
      systemPrompt: "one",
      persona: "",
      agentsMd: "",
      model: null,
    });

    const updated = service.updateAgent({
      id: agent.id,
      name: "Builder Two",
      role: "reviewer",
      model: "provider_default:deepseek-flash",
      systemPrompt: "two",
    });
    expect(updated.name).toBe("Builder Two");
    expect(updated.role).toBe("reviewer");
    expect(updated.model).toBe("provider_default:deepseek-flash");
    expect(updated.systemPrompt).toBe("two");

    expect(() =>
      service.updateAgent({ id: agent.id, model: "missing/model" }),
    ).toThrow(/not in the configured model list/);
  });

  it("chats with Router and exposes context sections", async () => {
    const { service, workspacePath } = setup();
    const workspace = await service.openWorkspace(workspacePath);

    const events: ChatEvent[] = [];
    const off = service.onChatEvent((event) => events.push(event));
    const reply = await service.sendChat(workspace.id, "这个项目怎么跑起来？");
    off();

    expect(reply?.role).toBe("assistant");
    expect(reply?.content).toContain("Router");
    expect(events.some((event) => event.type === "delta")).toBe(true);
    expect(events.some((event) => event.type === "done")).toBe(true);

    const chat = service.listChat(workspace.id);
    expect(chat.length).toBe(2);
    expect(chat[0].role).toBe("user");

    const context = service.getContext(workspace.id);
    expect(context.sections.some((section) => section.kind === "system")).toBe(true);
    expect(context.sections.some((section) => section.kind === "history")).toBe(true);
    expect(context.tools.length).toBeGreaterThan(0);

    const task = service.createTask({
      workspaceId: workspace.id,
      title: "Inspect",
      description: "Inspect the workspace",
      acceptance: ["done"],
    });
    const taskContext = service.getContext(workspace.id, undefined, task.id);
    expect(taskContext.taskTitle).toBe("Inspect");
    expect(taskContext.sections.some((section) => section.kind === "task")).toBe(true);
  });

  it("runs a task end-to-end with the mock model", async () => {
    const { service, workspacePath } = setup();
    const workspace = await service.openWorkspace(workspacePath);
    service.createAgent({
      workspaceId: workspace.id,
      name: "Builder",
      role: "engineer",
      systemPrompt: "You are a careful engineer.",
      persona: "",
      agentsMd: "",
      model: null,
    });
    // DESIGN §15.2：新成员默认 read_only；端到端用例显式授予工作区写权限。
    const snapshot0 = service.getSnapshot(workspace.id);
    const builder = snapshot0.agents.find((agent) => agent.name === "Builder")!;
    service.updateAgent({ id: builder.id, permission: "workspace_write" });
    const task = service.createTask({
      workspaceId: workspace.id,
      title: "Inspect the repository",
      description: "List files and report what you find.",
      acceptance: ["a summary is recorded"],
    });

    await service.runTask(task.id);

    const snapshot = service.getSnapshot(workspace.id);
    const updated = snapshot.tasks.find((item) => item.id === task.id);
    expect(updated?.status).toBe("done");
    expect(updated?.summary).toContain("已完成任务");

    const trace = service.getTaskTrace(task.id);
    expect(trace.some((event) => event.type === "tool.call")).toBe(true);
    expect(trace.some((event) => event.type === "run.completed")).toBe(true);
  });
});
