import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppService } from "./service.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "deer-chat-context-"));
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

describe("t170 chat context commands", () => {
  it("clears messages and reports counts", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router } = await open(service, workspacePath);
    for (let i = 0; i < 3; i += 1) {
      service.store.addChatMessage({
        workspaceId: workspace.id,
        agentId: router.id,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i}`,
      });
    }
    const result = service.clearChatContext(workspace.id);
    expect(result.removedMessages).toBe(3);
    expect(service.listChat(workspace.id, router.id)).toEqual([]);
    expect(
      service.store
        .listEvents({ aggregateId: workspace.id, aggregateType: "chat", limit: 20 })
        .some((event) => event.type === "chat.context_cleared"),
    ).toBe(true);
  });

  it("compacts older messages into a system summary before the recent tail", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router } = await open(service, workspacePath);
    for (let i = 0; i < 12; i += 1) {
      service.store.addChatMessage({
        workspaceId: workspace.id,
        agentId: router.id,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `turn ${i} ${"x".repeat(20)}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      });
    }
    const result = service.compactChatContext(workspace.id);
    expect(result.summarizedMessages).toBe(4);
    expect(result.keptMessages).toBe(8);
    expect(result.summary).toContain("上下文压缩");
    const messages = service.listChat(workspace.id, router.id);
    expect(messages).toHaveLength(9);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("已将 4 条");
    expect(messages.at(-1)?.content).toContain("turn 11");
  });

  it("does nothing when the conversation is already short", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router } = await open(service, workspacePath);
    service.store.addChatMessage({
      workspaceId: workspace.id,
      agentId: router.id,
      role: "user",
      content: "only",
    });
    const result = service.compactChatContext(workspace.id);
    expect(result.summarizedMessages).toBe(0);
    expect(service.listChat(workspace.id, router.id)).toHaveLength(1);
  });

  it("projects messages and tool events into a trajectory ledger", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router } = await open(service, workspacePath);
    service.store.addChatMessage({
      workspaceId: workspace.id,
      agentId: router.id,
      role: "user",
      content: "检查项目",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    service.store.addChatMessage({
      workspaceId: workspace.id,
      agentId: router.id,
      role: "assistant",
      content: "已检查",
      reasoning: "我先查看根目录，再读取配置文件。",
      createdAt: "2026-01-01T00:00:03.000Z",
    });
    service.store.appendEvent({
      aggregateType: "chat",
      aggregateId: workspace.id,
      type: "chat.tool_call",
      actor: "agent:Router",
      payload: {
        agentId: router.id,
        callId: "call-1",
        name: "fs.list",
        arguments: '{"path":"."}',
      },
      occurredAt: "2026-01-01T00:00:01.000Z",
    });
    service.store.appendEvent({
      aggregateType: "chat",
      aggregateId: workspace.id,
      type: "chat.tool_result",
      actor: "agent:Router",
      payload: {
        agentId: router.id,
        callId: "call-1",
        name: "fs.list",
        ok: true,
        value: { entries: 3 },
      },
      occurredAt: "2026-01-01T00:00:02.000Z",
    });
    const entries = service.getChatTrajectory(workspace.id, router.id);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "user",
      "tool_call",
      "tool_result",
      "reasoning",
      "assistant",
    ]);
    expect(entries[1]).toMatchObject({ title: "fs.list", status: "ok", callId: "call-1" });
    expect(entries[2]?.status).toBe("ok");
  });

  it("keeps one thinking segment on each side of a tool call", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router } = await open(service, workspacePath);
    service.store.addChatMessage({
      workspaceId: workspace.id,
      agentId: router.id,
      role: "user",
      content: "检查项目",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const append = (type: string, payload: Record<string, unknown>, at: string) =>
      service.store.appendEvent({
        aggregateType: "chat",
        aggregateId: workspace.id,
        type,
        actor: "agent:Router",
        payload: { agentId: router.id, ...payload },
        occurredAt: at,
      });
    append("chat.reasoning", { step: 1, text: "先列目录" }, "2026-01-01T00:00:01.000Z");
    append(
      "chat.tool_call",
      { callId: "call-1", name: "fs.list", arguments: "{}", step: 1 },
      "2026-01-01T00:00:02.000Z",
    );
    append(
      "chat.tool_result",
      { callId: "call-1", name: "fs.list", ok: true, value: { entries: 1 }, step: 1 },
      "2026-01-01T00:00:03.000Z",
    );
    append("chat.reasoning", { step: 2, text: "再读配置" }, "2026-01-01T00:00:04.000Z");
    service.store.addChatMessage({
      workspaceId: workspace.id,
      agentId: router.id,
      role: "assistant",
      content: "配置已读取",
      reasoning: "最终思考不应重复",
      createdAt: "2026-01-01T00:00:05.000Z",
    });
    const entries = service.getChatTrajectory(workspace.id, router.id);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "user",
      "reasoning",
      "tool_call",
      "tool_result",
      "reasoning",
      "assistant",
    ]);
    expect(entries.filter((entry) => entry.kind === "reasoning")).toHaveLength(2);
    expect(entries[1]).toMatchObject({ step: 1, detail: "先列目录" });
    expect(entries[4]).toMatchObject({ step: 2, detail: "再读配置" });
  });
});
