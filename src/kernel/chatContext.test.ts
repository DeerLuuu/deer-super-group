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
});
