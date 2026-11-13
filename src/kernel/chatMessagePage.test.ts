import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppService } from "./service.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "deer-t477-"));
  const workspacePath = path.join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const service = new AppService(path.join(root, "data"));
  cleanup.push(() => {
    service.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { service, workspacePath };
}

describe("t477 paginated chat messages", () => {
  it("keeps the legacy no-options 100-message call and pages older by (createdAt,id)", async () => {
    const { service, workspacePath } = setup();
    const workspace = await service.openWorkspace(workspacePath);
    const router = service.getSnapshot(workspace.id).agents.find((agent) => agent.isRouter)!;
    for (let index = 0; index < 130; index += 1) {
      service.store.addChatMessage({
        workspaceId: workspace.id,
        agentId: router.id,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message ${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      });
    }

    const legacy = service.listChat(workspace.id, router.id);
    expect(legacy).toHaveLength(100);
    expect(legacy[0]!.content).toBe("message 30");
    expect(legacy[99]!.content).toBe("message 129");

    const oldest = legacy[0]!;
    const page = service.listChat(workspace.id, router.id, {
      limit: 20,
      before: { createdAt: oldest.createdAt, id: oldest.id },
    });
    expect(page).toHaveLength(20);
    expect(page[0]!.content).toBe("message 10");
    expect(page[19]!.content).toBe("message 29");
    expect(page.every((message) => message.createdAt < oldest.createdAt)).toBe(true);

    const latestPage = service.listChat(workspace.id, router.id, { limit: 5 });
    expect(latestPage.map((message) => message.content)).toEqual([
      "message 125",
      "message 126",
      "message 127",
      "message 128",
      "message 129",
    ]);
  });

  it("rejects an agent from another workspace", async () => {
    const { service, workspacePath } = setup();
    const workspace = await service.openWorkspace(workspacePath);
    const otherPath = path.join(path.dirname(workspacePath), "other");
    mkdirSync(otherPath, { recursive: true });
    const other = await service.openWorkspace(otherPath);
    const otherAgent = service.getSnapshot(other.id).agents[0]!;
    expect(() => service.listChat(workspace.id, otherAgent.id)).toThrow(/agent not found/);
  });
});
