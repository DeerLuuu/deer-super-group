import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultModelProfile, defaultProviderProfile } from "../shared/models.js";
import { AppService } from "./service.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

function sse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

let lastToolNames: string[] = [];

function handle(request: IncomingMessage, response: ServerResponse): void {
  if (request.url === "/v1/models") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "fake-model" }] }));
    return;
  }
  if (request.url === "/v1/chat/completions") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> };
        lastToolNames = (parsed.tools ?? [])
          .map((tool) => tool.function?.name ?? "")
          .filter(Boolean);
      } catch {
        lastToolNames = [];
      }
    });
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    sse(response, {
      id: "chatcmpl-1",
      choices: [{ index: 0, delta: { content: "Hello from fake model" }, finish_reason: null }],
    });
    sse(response, { id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    sse(response, { usage: { prompt_tokens: 10, completion_tokens: 5 } });
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  response.writeHead(404);
  response.end();
}

describe("OpenAI-compatible integration", () => {
  it("lists models and runs a task against a local endpoint", async () => {
    const server = createServer(handle);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;

    const root = mkdtempSync(path.join(os.tmpdir(), "deer-openai-"));
    const workspacePath = path.join(root, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(path.join(workspacePath, "README.md"), "# Demo\n", "utf8");
    const service = new AppService(path.join(root, "data"));
    cleanup.push(() => {
      service.close();
      rmSync(root, { recursive: true, force: true });
      void new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const workspace = await service.openWorkspace(workspacePath);
    service.saveSettings({
      baseUrl,
      baseUrlEnv: "DEER_TEST_BASE_URL",
      apiKey: "test-key",
      apiKeyEnv: "DEER_TEST_API_KEY",
      providers: [
        defaultProviderProfile(
          {
            baseUrl,
            baseUrlEnv: "DEER_TEST_BASE_URL",
            apiKey: "test-key",
            apiKeyEnv: "DEER_TEST_API_KEY",
          },
          "provider_default",
          "Fake Provider",
        ),
      ],
      model: "fake-model",
      models: [defaultModelProfile("fake-model")],
      mock: false,
    });
    service.createAgent({
      workspaceId: workspace.id,
      name: "Builder",
      role: "engineer",
      systemPrompt: "You are a careful engineer.",
      persona: "",
      agentsMd: "",
      model: "fake-model",
    });

    const result = await service.listModels(service.getSettings());
    expect(result.error).toBeUndefined();
    expect(result.models).toEqual(["fake-model"]);
    expect(result.source).toBe("local");

    const task = service.createTask({
      workspaceId: workspace.id,
      title: "Say hello",
      description: "Just answer with a short greeting.",
      acceptance: ["a result is recorded"],
    });
    await service.runTask(task.id);

    const updated = service.getSnapshot(workspace.id).tasks.find((item) => item.id === task.id);
    expect(updated?.status).toBe("done");
    expect(updated?.summary).toContain("Hello from fake model");
    const trace = service.getTaskTrace(task.id);
    expect(trace.some((event) => event.type === "assistant.message")).toBe(true);

    // t172：provider 只接受 [a-zA-Z0-9_-]；内部点号工具名必须在 wire 上编码。
    lastToolNames = [];
    await service.sendChat(workspace.id, "用一句话打个招呼");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lastToolNames.length).toBeGreaterThan(0);
    for (const name of lastToolNames) {
      expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });
});
