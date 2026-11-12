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
  const root = mkdtempSync(path.join(os.tmpdir(), "deer-chat-terminal-"));
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
  const router = service.getSnapshot(workspace.id).agents.find((agent) => agent.isRouter);
  if (!router) throw new Error("router missing");
  return { workspace, router };
}

describe("t175 terminal persistence", () => {
  it("persists a cancelled terminal after user message on cancel", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router } = await open(service, workspacePath);
    let received!: () => void;
    const requestSeen = new Promise<void>((resolve) => {
      received = resolve;
    });
    const server = createServer((request, response) => {
      received();
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "慢" } }] })}\n\n`);
      // Keep the stream open so sendChat waits until cancelChat aborts it.
      request.on("close", () => response.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server address missing");
    service.saveSettings({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      baseUrlEnv: "",
      apiKey: "test-key",
      apiKeyEnv: "",
      providers: [
        defaultProviderProfile(
          {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
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
    try {
      const events: ChatEvent[] = [];
      const off = service.onChatEvent((event) => events.push(event));
      const pending = service.sendChat(workspace.id, router.id, "取消这一轮");
      await requestSeen;
      service.cancelChat(workspace.id, router.id);
      const reply = await pending;
      off();

      expect(reply).toBeNull();
      const turn = service.getChatTurns(workspace.id, router.id).turns.find(
        (item) => item.userMessage?.content === "取消这一轮",
      );
      expect(turn?.status).toBe("cancelled");
      expect(turn?.terminal).toMatchObject({
        status: "cancelled",
        code: "ABORTED",
        retryable: true,
      });
      expect(turn?.assistants).toHaveLength(0);
      const terminalEvents = service.store.listChatTurnTerminalEvents(workspace.id);
      expect(terminalEvents).toHaveLength(1);
      const event = events.find((item) => item.type === "cancelled");
      expect(event).toMatchObject({
        userMessageId: turn?.userMessage?.id,
        terminalPersisted: true,
      });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("persists a sanitized error terminal when the provider fails", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router } = await open(service, workspacePath);
    service.saveSettings({
      baseUrl: "http://127.0.0.1:1/v1",
      baseUrlEnv: "",
      apiKey: "test-key",
      apiKeyEnv: "",
      providers: [
        defaultProviderProfile(
          { baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-secret-123", baseUrlEnv: "", apiKeyEnv: "" },
          "provider_default",
          "Default",
        ),
      ],
      model: "provider_default:deepseek-flash",
      models: [defaultModelProfile("deepseek-flash")],
      mock: false,
    });
    const events: ChatEvent[] = [];
    const off = service.onChatEvent((event) => events.push(event));
    await expect(service.sendChat(workspace.id, router.id, "触发一次网络失败")).rejects.toBeTruthy();
    off();

    const turn = service.getChatTurns(workspace.id, router.id).turns.find(
      (item) => item.userMessage?.content === "触发一次网络失败",
    );
    expect(turn?.status).toBe("error");
    expect(turn?.terminal?.status).toBe("error");
    expect(turn?.assistants).toHaveLength(0);
    expect(turn?.terminal?.message ?? "").not.toContain("sk-secret");
    const terminalEvents = service.store.listChatTurnTerminalEvents(workspace.id);
    expect(terminalEvents).toHaveLength(1);
    const event = events.find((item) => item.type === "error");
    expect(event).toMatchObject({ userMessageId: turn?.userMessage?.id, terminalPersisted: true });
  });

  it("sanitizes provider 401 body + Cookie/client/access/private secrets in persisted terminal", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router } = await open(service, workspacePath);
    const server = createServer((_request, response) => {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "bad credentials",
            client_secret: "cs-live-secret",
            accessToken: "at-live-secret",
            private_key: "pk-live-secret",
          },
          Cookie: "session=cookie-live-secret",
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server address missing");
    service.saveSettings({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      baseUrlEnv: "",
      apiKey: "test-key",
      apiKeyEnv: "",
      providers: [
        defaultProviderProfile(
          { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "test-key", baseUrlEnv: "", apiKeyEnv: "" },
          "provider_default",
          "Default",
        ),
      ],
      model: "provider_default:deepseek-flash",
      models: [defaultModelProfile("deepseek-flash")],
      mock: false,
    });
    try {
      const events: ChatEvent[] = [];
      const off = service.onChatEvent((event) => events.push(event));
      await expect(service.sendChat(workspace.id, router.id, "触发 provider 401")).rejects.toBeTruthy();
      off();
      const turn = service.getChatTurns(workspace.id, router.id).turns.find(
        (item) => item.userMessage?.content === "触发 provider 401",
      );
      expect(turn?.terminal?.status).toBe("error");
      expect(turn?.terminal?.message ?? "").not.toContain("cs-live-secret");
      expect(turn?.terminal?.message ?? "").not.toContain("at-live-secret");
      expect(turn?.terminal?.message ?? "").not.toContain("pk-live-secret");
      expect(turn?.terminal?.message ?? "").not.toContain("cookie-live-secret");
      expect(turn?.terminal?.message ?? "").toContain("provider 原始响应已隐藏");
      const terminalEvents = service.store.listChatTurnTerminalEvents(workspace.id);
      expect(terminalEvents).toHaveLength(1);
      const event = events.find((item) => item.type === "error");
      expect(event).toMatchObject({ userMessageId: turn?.userMessage?.id, terminalPersisted: true });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("records stage=tool and toolName when cancelled during a tool call", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router } = await open(service, workspacePath);
    service.updateAgent({ id: router.id, permission: "full_access" });
    const command =
      process.platform === "win32" ? "Start-Sleep -Seconds 2" : "sleep 2";
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_tool",
                    type: "function",
                    function: {
                      name: "shell.run",
                      arguments: JSON.stringify({ command, timeoutMs: 10_000 }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      );
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server address missing");
    service.saveSettings({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      baseUrlEnv: "",
      apiKey: "test-key",
      apiKeyEnv: "",
      providers: [
        defaultProviderProfile(
          {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
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
    try {
      const pending = service.sendChat(workspace.id, router.id, "工具中取消");
      const off = service.onChatEvent((event) => {
        if (event.type === "tool_call") service.cancelChat(workspace.id, router.id);
      });
      await pending;
      off();
      const turn = service.getChatTurns(workspace.id, router.id).turns.find(
        (item) => item.userMessage?.content === "工具中取消",
      );
      expect(turn?.status).toBe("cancelled");
      expect(turn?.terminal).toMatchObject({
        stage: "tool",
        tool: { callId: "call_tool", name: "shell.run" },
      });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("does not write a terminal for a successful assistant reply", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router } = await open(service, workspacePath);
    const reply = await service.sendChat(workspace.id, router.id, "正常成功");
    expect(reply?.role).toBe("assistant");
    expect(service.store.listChatTurnTerminalEvents(workspace.id)).toHaveLength(0);
    const turn = service.getChatTurns(workspace.id, router.id).turns.find(
      (item) => item.userMessage?.content === "正常成功",
    );
    expect(turn?.status).toBe("complete");
    expect(turn?.terminal).toBeNull();
    expect(turn?.retryable).toBe(false);
  });

  it("writes at most one terminal per userMessageId even on a cancel/error race", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router } = await open(service, workspacePath);
    const user = service.store.addChatMessage({
      workspaceId: workspace.id,
      agentId: router.id,
      role: "user",
      content: "race",
    });
    const payload = {
      version: 1,
      userMessageId: user.id,
      turnId: `turn:${user.id}`,
      agentId: router.id,
      status: "cancelled" as const,
      stage: "model" as const,
      code: "ABORTED",
      message: null,
      retryable: true,
      at: new Date().toISOString(),
    };
    const first = service.store.appendEventIdempotent({
      aggregateType: "chat",
      aggregateId: workspace.id,
      type: "chat.turn_cancelled",
      actor: "user",
      payload,
      idempotencyKey: `chat-turn-terminal:${user.id}`,
    });
    const second = service.store.appendEventIdempotent({
      aggregateType: "chat",
      aggregateId: workspace.id,
      type: "chat.turn_error",
      actor: "agent:Router",
      payload: { ...payload, status: "error", stage: "model", code: "LATE" },
      idempotencyKey: `chat-turn-terminal:${user.id}`,
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.event.id).toBe(first.event.id);
    expect(service.store.listChatTurnTerminalEvents(workspace.id)).toHaveLength(1);
    expect(service.getChatTurns(workspace.id, router.id).turns[0]!.terminal?.code).toBe("ABORTED");
  });

  it("keeps terminal events append-only through clear/compact without resurrecting orphan bubbles", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router } = await open(service, workspacePath);
    const old = service.store.addChatMessage({
      workspaceId: workspace.id,
      agentId: router.id,
      role: "user",
      content: "旧取消轮",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    service.store.appendEvent({
      aggregateType: "chat",
      aggregateId: workspace.id,
      type: "chat.turn_cancelled",
      actor: "user",
      idempotencyKey: `chat-turn-terminal:${old.id}`,
      payload: {
        version: 1,
        userMessageId: old.id,
        turnId: `turn:${old.id}`,
        agentId: router.id,
        status: "cancelled",
        stage: "model",
        code: "ABORTED",
        message: null,
        retryable: true,
        at: "2026-01-01T00:00:01.000Z",
      },
    });
    for (let index = 0; index < 12; index += 1) {
      service.store.addChatMessage({
        workspaceId: workspace.id,
        agentId: router.id,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `fill ${index}`,
        createdAt: `2026-01-01T00:01:${String(index).padStart(2, "0")}.000Z`,
      });
    }
    service.compactChatContext(workspace.id);
    expect(
      service.getChatTurns(workspace.id, router.id).turns.some(
        (turn) => turn.userMessage?.id === old.id,
      ),
    ).toBe(false);
    service.clearChatContext(workspace.id);
    expect(service.getChatTurns(workspace.id, router.id).turns).toHaveLength(0);
    expect(service.store.listChatTurnTerminalEvents(workspace.id)).toHaveLength(1);
  });

  it("keeps the old terminal when a retry starts a new user/assistant turn", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router } = await open(service, workspacePath);
    const first = service.store.addChatMessage({
      workspaceId: workspace.id,
      agentId: router.id,
      role: "user",
      content: "失败的问题",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    service.store.appendEvent({
      aggregateType: "chat",
      aggregateId: workspace.id,
      type: "chat.turn_error",
      actor: "agent:Router",
      idempotencyKey: `chat-turn-terminal:${first.id}`,
      payload: {
        version: 1,
        userMessageId: first.id,
        turnId: `turn:${first.id}`,
        agentId: router.id,
        status: "error",
        stage: "model",
        code: "PROVIDER_500",
        message: "failed",
        retryable: true,
        at: "2026-01-01T00:00:01.000Z",
      },
    });
    service.store.addChatMessage({
      workspaceId: workspace.id,
      agentId: router.id,
      role: "user",
      content: "失败的问题",
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    service.store.addChatMessage({
      workspaceId: workspace.id,
      agentId: router.id,
      role: "assistant",
      content: "重试成功",
      createdAt: "2026-01-01T00:00:03.000Z",
    });
    const turns = service.getChatTurns(workspace.id, router.id).turns;
    expect(turns).toHaveLength(2);
    expect(turns[0]!.status).toBe("error");
    expect(turns[0]!.terminal?.code).toBe("PROVIDER_500");
    expect(turns[1]!.status).toBe("complete");
    expect(turns[1]!.terminal).toBeNull();
  });
});
