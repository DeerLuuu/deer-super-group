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
  const root = mkdtempSync(path.join(os.tmpdir(), "deer-delete-test-"));
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

async function openWorkspace(service: AppService, workspacePath: string) {
  const workspace = await service.openWorkspace(workspacePath);
  const router = service.getSnapshot(workspace.id).agents.find((agent) => agent.isRouter);
  if (!router) throw new Error("router missing");
  return { workspace, router };
}

describe("t167 delete task/member", () => {
  it("deletes a member and leaves owned tasks unassigned", async () => {
    const { service, workspacePath } = setup();
    const { workspace } = await openWorkspace(service, workspacePath);
    const agent = service.createAgent({
      workspaceId: workspace.id,
      name: "Worker",
      role: "engineer",
      systemPrompt: "work",
      persona: "",
      agentsMd: "",
      model: null,
    });
    const task = service.createTask({
      workspaceId: workspace.id,
      title: "owned task",
      description: "",
      acceptance: [],
    });
    service.store.updateTask(task.id, { ownerId: agent.id });

    const result = service.deleteAgent(agent.id);
    expect(result.reassignedTasks).toBe(1);
    const snapshot = service.getSnapshot(workspace.id);
    expect(snapshot.agents.some((item) => item.id === agent.id)).toBe(false);
    expect(snapshot.tasks.find((item) => item.id === task.id)?.ownerId).toBeNull();
    expect(
      service.store
        .listEvents({ aggregateType: "workspace", limit: 20 })
        .some((event) => event.type === "agent.deleted"),
    ).toBe(true);
  });

  it("refuses to delete Router", async () => {
    const { service, workspacePath } = setup();
    const { router } = await openWorkspace(service, workspacePath);
    expect(() => service.deleteAgent(router.id)).toThrow("Router");
  });

  it("refuses to delete a member with an active run", async () => {
    const { service, workspacePath } = setup();
    const { workspace } = await openWorkspace(service, workspacePath);
    const agent = service.createAgent({
      workspaceId: workspace.id,
      name: "Busy",
      role: "engineer",
      systemPrompt: "work",
      persona: "",
      agentsMd: "",
      model: null,
    });
    const task = service.createTask({
      workspaceId: workspace.id,
      title: "busy task",
      description: "",
      acceptance: [],
    });
    service.store.createRun(task.id, agent.id);
    expect(() => service.deleteAgent(agent.id)).toThrow("Run");
  });

  it("deletes a task with its runs and summaries but keeps events", async () => {
    const { service, workspacePath } = setup();
    const { workspace } = await openWorkspace(service, workspacePath);
    const task = service.createTask({
      workspaceId: workspace.id,
      title: "deletable",
      description: "",
      acceptance: [],
    });
    const run = service.store.createRun(task.id, service.getSnapshot(workspace.id).agents[0].id);
    service.store.updateRun(run.id, { status: "completed", endedAt: new Date().toISOString() });
    service.store.saveSummary({
      taskId: task.id,
      runId: run.id,
      goal: "test",
      changes: [],
      files: [],
      tests: [],
      decisions: [],
      risks: [],
      openQuestions: [],
    });

    const result = service.deleteTask(task.id);
    expect(result.removedRuns).toBe(1);
    expect(result.removedSummaries).toBe(1);
    expect(service.getSnapshot(workspace.id).tasks.some((item) => item.id === task.id)).toBe(false);
    expect(service.listRuns(task.id)).toEqual([]);
    expect(service.store.getSummaryForTask(task.id)).toBeNull();
    expect(
      service.store
        .listEvents({ aggregateId: task.id, aggregateType: "task", limit: 20 })
        .some((event) => event.type === "task.deleted"),
    ).toBe(true);
  });

  it("refuses to delete a task with active runs or dependents", async () => {
    const { service, workspacePath } = setup();
    const { workspace } = await openWorkspace(service, workspacePath);
    const owner = service.getSnapshot(workspace.id).agents[0];
    const parent = service.createTask({
      workspaceId: workspace.id,
      title: "parent",
      description: "",
      acceptance: [],
    });
    const activeRun = service.store.createRun(parent.id, owner.id);
    expect(() => service.deleteTask(parent.id)).toThrow("Run");

    const dependency = service.createTask({
      workspaceId: workspace.id,
      title: "dependency",
      description: "",
      acceptance: [],
    });
    service.store.updateTask(parent.id, { status: "done" });
    service.store.updateRun(activeRun.id, { status: "completed", endedAt: new Date().toISOString() });
    service.store.updateTask(dependency.id, { dependsOn: [parent.id], status: "blocked" });
    expect(() => service.deleteTask(parent.id)).toThrow("依赖");
  });
});
