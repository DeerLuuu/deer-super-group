import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
  const root = mkdtempSync(path.join(os.tmpdir(), "deer-chat-agent-"));
  const workspacePath = path.join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(path.join(workspacePath, "README.md"), "# Demo\n", "utf8");
  const service = new AppService(path.join(root, "data"));
  cleanup.push(() => {
    service.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { service, workspacePath };
}

async function open(service: AppService, workspacePath: string) {
  const workspace = await service.openWorkspace(workspacePath);
  const router = service.getSnapshot(workspace.id).agents.find((agent) => agent.isRouter)!;
  const member = service.createAgent({
    workspaceId: workspace.id,
    name: "Mika",
    role: "Designer",
    systemPrompt: "Member instructions",
    persona: "",
    agentsMd: "",
    model: null,
  });
  return { workspace, router, member };
}

function useStreamingProvider(service: AppService, port: number) {
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
        "Default",
      ),
    ],
    model: "provider_default:deepseek-flash",
    models: [defaultModelProfile("deepseek-flash")],
    mock: false,
  });
}

describe("t424 agent chat routing", () => {
  it("sends to the selected member, attributes messages/events, and skips ingest", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router, member } = await open(service, workspacePath);
    const events: ChatEvent[] = [];
    const off = service.onChatEvent((event) => events.push(event));
    const reply = await service.sendChat(workspace.id, member.id, "hello member");
    off();

    expect(reply?.agentId).toBe(member.id);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.agentId === member.id)).toBe(true);
    expect(service.listChat(workspace.id, member.id).every((m) => m.agentId === member.id)).toBe(
      true,
    );
    expect(service.listChat(workspace.id, router.id)).toHaveLength(0);
    expect(service.listChatQuestions(workspace.id, member.id)).toHaveLength(0);
    expect(service.listChatArtifacts(workspace.id, member.id)).toHaveLength(0);
  });

  it("keeps Router clear/compact from touching member history", async () => {
    const { service, workspacePath } = setup();
    const { workspace, member } = await open(service, workspacePath);
    await service.sendChat(workspace.id, member.id, "member history");
    const before = service.listChat(workspace.id, member.id).length;
    expect(before).toBeGreaterThan(0);
    service.clearChatContext(workspace.id);
    expect(service.listChat(workspace.id, member.id)).toHaveLength(before);
    service.compactChatContext(workspace.id);
    expect(service.listChat(workspace.id, member.id)).toHaveLength(before);
  });

  it("rejects an agent id outside the workspace and isolates abort keys", async () => {
    const { service, workspacePath } = setup();
    const { workspace, member } = await open(service, workspacePath);
    await expect(service.sendChat(workspace.id, "missing", "x")).rejects.toThrow(
      /agent not found/,
    );

    let received!: () => void;
    const requestSeen = new Promise<void>((resolve) => {
      received = resolve;
    });
    const server = createServer((request, response) => {
      received();
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "wait" } }] })}\n\n`);
      request.on("close", () => response.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server address missing");
    useStreamingProvider(service, address.port);
    try {
      const pending = service.sendChat(workspace.id, member.id, "cancel member");
      await requestSeen;
      const aborts = (service as unknown as { chatAborts: Map<string, AbortController> })
        .chatAborts;
      expect(aborts.has(`${workspace.id}:${member.id}`)).toBe(true);
      expect(aborts.has(workspace.id)).toBe(false);
      service.cancelChat(workspace.id, member.id);
      expect(await pending).toBeNull();
      expect(aborts.size).toBe(0);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
