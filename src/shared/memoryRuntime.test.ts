import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../kernel/store.js";
import { MemoryRuntime } from "./memoryRuntime.js";

const dirs: string[] = [];

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deer-memory-runtime-"));
  dirs.push(dir);
  const store = new Store(path.join(dir, "deer.db"));
  const workspace = store.createWorkspace("ws", dir);
  const agent = store.createAgent(
    {
      workspaceId: workspace.id,
      name: "ray",
      role: "engineer",
      systemPrompt: "",
      persona: "",
      agentsMd: "",
      model: null,
    },
    false,
  );
  const runtime = new MemoryRuntime(store);
  return { store, workspace, agent, runtime };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows lock; process exit cleans temp
    }
  }
});

describe("MemoryRuntime", () => {
  it("exposes board/memo read-write and filters memos by agent", () => {
    const { store, workspace, agent, runtime } = setup();
    expect(runtime.available).toBe(true);
    const posted = runtime.postBoard({
      workspaceId: workspace.id,
      board: "frontend",
      kind: "decision",
      content: "Use panel-level isolation for Dock.",
      confidence: "high",
    });
    expect(posted.ok).toBe(true);
    if (!posted.ok) throw new Error(posted.error.message);
    expect(posted.value.board).toBe("frontend");

    const memo = runtime.createMemo({
      workspaceId: workspace.id,
      agentId: agent.id,
      kind: "lesson",
      content: "Vitest alias needs a fixture.",
      tags: ["test"],
    });
    expect(memo.ok).toBe(true);
    const snapshot = runtime.snapshot(workspace.id, { agentId: agent.id });
    expect(snapshot.counts.boardActive).toBe(1);
    expect(snapshot.memos.some((item) => item.tags.includes("test"))).toBe(true);

    const search = runtime.search({ workspaceId: workspace.id, agentId: agent.id, query: "Dock" });
    expect(search.hits.length).toBeGreaterThan(0);
    expect(search.hits[0].citations.length).toBeGreaterThan(0);
    expect(search.budget.maxTokens).toBeGreaterThan(0);

    expect(runtime.searchForAgent({ workspaceId: workspace.id, agentId: agent.id, query: "Dock" }).hits.length).toBeGreaterThan(0);
    store.close();
  });

  it("keeps human governance paths and rejects bad input", () => {
    const { store, workspace, runtime } = setup();
    const posted = runtime.postBoard({
      workspaceId: workspace.id,
      board: "ops",
      kind: "fact",
      content: "Deploy window is Tuesday.",
    });
    if (!posted.ok) throw new Error(posted.error.message);
    const verified = runtime.verifyBoard(workspace.id, posted.value.id, "high");
    expect(verified.ok).toBe(true);
    const pinned = runtime.pin(workspace.id, posted.value.id, true);
    expect(pinned.ok).toBe(true);
    const proposed = runtime.proposeArchive(workspace.id, posted.value.id, "manual", "outdated");
    expect(proposed.ok).toBe(false);
    expect(proposed.ok ? "" : proposed.error.code).toBe("MEMORY_PINNED");
    expect(runtime.postBoard({ workspaceId: workspace.id, board: "", kind: "fact", content: "x" }).ok).toBe(false);
    expect(() => runtime.snapshot("missing")).toThrow(/workspace/);
    store.close();
  });

  it("approves an archive proposal and restores the archived entry (P1 additive)", () => {
    const { store, workspace, runtime } = setup();
    const posted = runtime.postBoard({
      workspaceId: workspace.id,
      board: "ops",
      kind: "fact",
      content: "Old deployment note.",
    });
    if (!posted.ok) throw new Error(posted.error.message);
    const proposal = runtime.proposeArchive(workspace.id, posted.value.id, "manual", "superseded");
    if (!proposal.ok) throw new Error(proposal.error.message);
    const decided = runtime.decideArchive(workspace.id, proposal.value.id, "approve", "ok");
    expect(decided.ok).toBe(true);
    expect(runtime.snapshot(workspace.id, { includeArchived: true }).entries.find((entry) => entry.id === posted.value.id)?.status).toBe("archived");
    const restored = runtime.restoreBoardEntry(workspace.id, posted.value.id);
    expect(restored.ok).toBe(true);
    expect(restored.ok ? restored.value.status : "").toBe("active");
    store.close();
  });
});
