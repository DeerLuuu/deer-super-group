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
  const root = mkdtempSync(path.join(os.tmpdir(), "deer-chat-turns-"));
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

describe("t168 getChatTurns service", () => {
  it("returns a typed history page and validates the agent", async () => {
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
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    const page = service.getChatTurns(workspace.id, router.id);
    expect(page).toMatchObject({
      workspaceId: workspace.id,
      agentId: router.id,
      projectionVersion: 1,
      hasMore: false,
    });
    expect(page.turns).toHaveLength(1);
    expect(page.turns[0]!.assistants[0]!.content).toBe("已检查");
    expect(() => service.getChatTurns(workspace.id, "agent_missing")).toThrow(
      /agent not found in workspace/,
    );
  });

  it("paginates turns with before/hasMore and keeps tool events in the right turn", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router } = await open(service, workspacePath);
    for (let index = 1; index <= 3; index += 1) {
      service.store.addChatMessage({
        workspaceId: workspace.id,
        agentId: router.id,
        role: "user",
        content: `q${index}`,
        createdAt: `2026-01-01T00:00:0${index}.000Z`,
      });
      service.store.addChatMessage({
        workspaceId: workspace.id,
        agentId: router.id,
        role: "assistant",
        content: `a${index}`,
        createdAt: `2026-01-01T00:00:0${index}.500Z`,
      });
    }
    service.store.appendEvent({
      aggregateType: "chat",
      aggregateId: workspace.id,
      type: "chat.tool_call",
      actor: "agent:Router",
      payload: {
        agentId: router.id,
        callId: "call-1",
        name: "fs.list",
        arguments: "{}",
      },
      occurredAt: "2026-01-01T00:00:02.100Z",
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
        value: { entries: 2 },
      },
      occurredAt: "2026-01-01T00:00:02.200Z",
    });

    const latest = service.getChatTurns(workspace.id, router.id, { limit: 1 });
    expect(latest.turns).toHaveLength(1);
    expect(latest.turns[0]!.turnId.startsWith("turn:")).toBe(true);
    expect(latest.turns[0]!.userMessage?.content).toBe("q3");
    expect(latest.turns[0]!.assistants[0]!.content).toBe("a3");
    expect(latest.hasMore).toBe(true);
    expect(latest.nextBefore).toBeTruthy();
    expect(latest.turns[0]!.assistants[0]!.steps).toEqual([]);

    const older = service.getChatTurns(workspace.id, router.id, {
      limit: 1,
      before: latest.nextBefore!,
    });
    expect(older.turns[0]!.userMessage?.content).toBe("q2");
    expect(older.turns[0]!.assistants[0]!.steps[0]!.tools[0]).toMatchObject({
      callId: "call-1",
      status: "ok",
      value: { entries: 2 },
    });
    expect(older.hasMore).toBe(true);
  });

  it("rejects malformed cursors without touching messages", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router } = await open(service, workspacePath);
    expect(() =>
      service.getChatTurns(workspace.id, router.id, { before: "not-a-cursor" }),
    ).toThrow(/invalid chat turn cursor/);
  });

  it("returns a stable error without creating a Router", async () => {
    const { service, workspacePath } = setup();
    const secondPath = path.join(path.dirname(workspacePath), "empty-workspace");
    mkdirSync(secondPath, { recursive: true });
    const empty = service.store.createWorkspace("空工作区", secondPath);
    expect(service.store.listAgents(empty.id)).toHaveLength(0);
    expect(() => service.getChatTurns(empty.id)).toThrow(/router not found in workspace/);
    expect(service.store.listAgents(empty.id)).toHaveLength(0);
  });

  it("rejects an agent from another workspace", async () => {
    const { service, workspacePath } = setup();
    const { workspace } = await open(service, workspacePath);
    const otherPath = path.join(path.dirname(workspacePath), "other-workspace");
    mkdirSync(otherPath, { recursive: true });
    const other = await service.openWorkspace(otherPath);
    const otherRouter = service.getSnapshot(other.id).agents.find((agent) => agent.isRouter);
    if (!otherRouter) throw new Error("other router missing");
    expect(() => service.getChatTurns(workspace.id, otherRouter.id)).toThrow(
      /agent not found in workspace/,
    );
  });

  it("keeps response trimming paginated: before returns the dropped older turns", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router } = await open(service, workspacePath);
    for (let index = 1; index <= 8; index += 1) {
      const userAt = `2026-01-01T00:00:${String(index * 2).padStart(2, "0")}.000Z`;
      const assistantAt = `2026-01-01T00:00:${String(index * 2 + 1).padStart(2, "0")}.000Z`;
      service.store.addChatMessage({
        workspaceId: workspace.id,
        agentId: router.id,
        role: "user",
        content: `q${index}-${"u".repeat(60_000)}`,
        createdAt: userAt,
      });
      service.store.addChatMessage({
        workspaceId: workspace.id,
        agentId: router.id,
        role: "assistant",
        content: `a${index}-${"a".repeat(60_000)}`,
        createdAt: assistantAt,
      });
    }
    const latest = service.getChatTurns(workspace.id, router.id, { limit: 20 });
    expect(latest.hasMore).toBe(true);
    expect(latest.nextBefore).toBeTruthy();
    expect(latest.turns[0]!.userMessage?.content.startsWith("q1-")).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(latest), "utf8")).toBeLessThanOrEqual(512 * 1024);

    const older = service.getChatTurns(workspace.id, router.id, {
      limit: 20,
      before: latest.nextBefore!,
    });
    expect(older.turns[0]!.userMessage?.content.startsWith("q1-")).toBe(true);
    expect(older.turns.length).toBeGreaterThan(0);
  });
});
