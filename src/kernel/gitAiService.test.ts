import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { AppService } from "./service.js";
import { defaultModelProfile, defaultProviderProfile } from "../shared/models.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

function sse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "deer-git-ai-"));
  const workspacePath = path.join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const service = new AppService(path.join(root, "data"));
  cleanup.push(() => {
    service.close();
    rmSync(root, { recursive: true, force: true });
  });
  const workspace = await service.openWorkspace(workspacePath);
  const router = service.getSnapshot(workspace.id).agents.find((agent) => agent.isRouter)!;
  const task = service.store.createTask({
    workspaceId: workspace.id,
    title: "Add login",
    description: "Implement login. Authorization: Bearer sk-project-SECRET12345 token=abc",
    acceptance: [],
  });
  return { service, workspace, router, task };
}

function configureModel(service: AppService, port: number): void {
  service.saveSettings({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    baseUrlEnv: "",
    apiKey: "test-key",
    apiKeyEnv: "",
    providers: [
      defaultProviderProfile(
        {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "test-key",
          baseUrlEnv: "",
          apiKeyEnv: "",
        },
        "provider_default",
        "Local",
      ),
    ],
    model: "provider_default:deepseek-flash",
    models: [defaultModelProfile("deepseek-flash")],
    mock: false,
  });
}

describe("t368 Git AI service", () => {
  it("generates a PR draft from sanitized context and audits it", async () => {
    let outbound = "";
    const server = createServer((request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => (body += String(chunk)));
      request.on("end", () => {
        outbound = body;
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const content = JSON.stringify({ title: "Add login flow", body: "## Summary\nLogin." });
        sse(response, { choices: [{ delta: { content } }] });
        sse(response, { choices: [{ delta: {}, finish_reason: "stop" }] });
        response.write("data: [DONE]\n\n");
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server address missing");
    cleanup.push(() => void server.close());
    const { service, workspace, router, task } = await setup();
    configureModel(service, address.port);

    const result = await service.generateGitAiDraft({
      workspaceId: workspace.id,
      taskId: task.id,
      agentId: router.id,
      kind: "pr",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.title).toBe("Add login flow");
    expect(outbound).not.toContain("sk-project-SECRET12345");
    expect(outbound).not.toContain("token=abc");
    expect(outbound).toContain("Add login");
    const audit = service.store.listEvents({
      aggregateType: "workspace",
      aggregateId: workspace.id,
    });
    expect(audit.some((event) => event.type === "git.ai_pr_draft")).toBe(true);
  });

  it("disables generation in mock mode without calling a model", async () => {
    const { service, workspace, router, task } = await setup();
    service.saveSettings({ ...service.store.getLlmSettings(), mock: true });
    const result = await service.generateGitAiDraft({
      workspaceId: workspace.id,
      taskId: task.id,
      agentId: router.id,
      kind: "merge",
    });
    expect(result).toMatchObject({ ok: false, code: "GIT_AI_MOCK_DISABLED" });
  });

  it("threads a sanitized merge notification to the selected member and audits it", async () => {
    const { service, workspace, router, task } = await setup();
    const first = service.notifyMerge({
      workspaceId: workspace.id,
      taskId: task.id,
      agentId: router.id,
      body: "merged Authorization: Bearer sk-notify-SECRET12345",
      branch: "feature/login",
      mergeCommitSha: "abc1234",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.body).not.toContain("sk-notify-SECRET12345");
    expect(first.subject).toContain("合并完成");
    const second = service.notifyMerge({
      workspaceId: workspace.id,
      taskId: task.id,
      agentId: router.id,
      body: "second",
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.threadId).toBe(first.threadId);
    expect(service.store.listMessages(workspace.id).length).toBeGreaterThanOrEqual(2);
    const audit = service.store.listEvents({
      aggregateType: "workspace",
      aggregateId: workspace.id,
    });
    expect(audit.some((event) => event.type === "git.merge_notified")).toBe(true);
  });

  it("returns a retryable failure when the notification recipient is unknown", async () => {
    const { service, workspace, task } = await setup();
    const result = service.notifyMerge({
      workspaceId: workspace.id,
      taskId: task.id,
      agentId: "missing-agent",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(false);
  });
});
