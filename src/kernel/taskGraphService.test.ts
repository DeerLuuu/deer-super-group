import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Store } from "./store.js";
import { TaskGraphService } from "./taskGraphService.js";
import { rebuildProjections, projectionDigest } from "./execution/projections.js";

function setup() {
  const store = new Store(":memory:");
  const workspace = store.createWorkspace("W", "/tmp/t502-workspace");
  const agent = store.createAgent({
    workspaceId: workspace.id,
    name: "Worker",
    role: "engineer",
    systemPrompt: "",
    persona: "",
    agentsMd: "",
    model: null,
  });
  return { store, workspace, agent, graph: new TaskGraphService(store) };
}

function createTask(
  graph: TaskGraphService,
  workspaceId: string,
  title: string,
  extra: { ownerId?: string | null; dependsOn?: string[] } = {},
) {
  return graph.createTask({
    workspaceId,
    title,
    description: "",
    acceptance: [],
    ...extra,
  });
}

function eventTypes(store: Store, taskId: string): string[] {
  return store.listEvents({ aggregateId: taskId }).map((event) => event.type);
}

describe("TaskGraphService O1-2", () => {
  it("creates owner/dependency facts in relation tables and the legacy mirror", () => {
    const { store, workspace, agent, graph } = setup();
    const a = createTask(graph, workspace.id, "A");
    const b = createTask(graph, workspace.id, "B", {
      ownerId: agent.id,
      dependsOn: [a.id],
    });

    expect(b.ownerId).toBe(agent.id);
    expect(b.dependsOn).toEqual([a.id]);
    expect(store.getTask(b.id)).toMatchObject({ ownerId: agent.id, dependsOn: [a.id] });
    expect(
      store.db.prepare("SELECT owner_id, depends_on FROM tasks WHERE id = ?").get(b.id),
    ).toMatchObject({ owner_id: agent.id, depends_on: JSON.stringify([a.id]) });
    expect(
      store.db.prepare("SELECT agent_id FROM task_owners WHERE task_id = ?").get(b.id),
    ).toMatchObject({ agent_id: agent.id });
    expect(
      store.db.prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?").all(b.id),
    ).toEqual([{ depends_on_task_id: a.id }]);
    expect(eventTypes(store, b.id)).toEqual(["task.created"]);
    store.close();
  });

  it("writes owner/dependencies and additive events idempotently in one transaction", () => {
    const { store, workspace, agent, graph } = setup();
    const a = createTask(graph, workspace.id, "A");
    const b = createTask(graph, workspace.id, "B");
    const initial = eventTypes(store, b.id).length;

    graph.setOwner(b.id, agent.id, { reason: "assign" });
    expect(store.getTask(b.id)?.ownerId).toBe(agent.id);
    expect(eventTypes(store, b.id)).toEqual(["task.created", "task.owner_changed"]);
    graph.setOwner(b.id, agent.id, { reason: "assign" });
    expect(eventTypes(store, b.id)).toHaveLength(2);

    graph.setDependencies(b.id, [a.id], { reason: "plan" });
    expect(store.getTask(b.id)?.dependsOn).toEqual([a.id]);
    expect(eventTypes(store, b.id)).toEqual([
      "task.created",
      "task.owner_changed",
      "task.dependencies_changed",
      "task.status_changed",
    ]);
    graph.setDependencies(b.id, [a.id], { reason: "plan" });
    expect(eventTypes(store, b.id)).toHaveLength(4);

    const updatedPayloads = store
      .listEvents({ aggregateId: b.id })
      .filter((event) => event.type === "task.updated")
      .map((event) => event.payload as Record<string, unknown>);
    expect(updatedPayloads).toEqual([]);
    expect(eventTypes(store, b.id).length).toBeGreaterThan(initial);
    store.close();
  });

  it("validates owner/dependency workspace/existence/self/duplicate/cycle and rolls back", () => {
    const { store, workspace, agent, graph } = setup();
    const a = createTask(graph, workspace.id, "A");
    const b = createTask(graph, workspace.id, "B");
    const other = store.createWorkspace("Other", "/tmp/t502-other");
    const otherAgent = store.createAgent({
      workspaceId: other.id,
      name: "Other",
      role: "engineer",
      systemPrompt: "",
      persona: "",
      agentsMd: "",
      model: null,
    });
    const foreign = createTask(graph, other.id, "Foreign");
    const beforeEvents = store.listEvents({ aggregateId: b.id }).length;

    expect(() => graph.setOwner(b.id, "missing-agent")).toThrow(
      expect.objectContaining({ code: "TASK_OWNER_NOT_FOUND" }),
    );
    expect(() => graph.setOwner(b.id, otherAgent.id)).toThrow(
      expect.objectContaining({ code: "TASK_OWNER_WORKSPACE_MISMATCH" }),
    );
    expect(() => graph.setDependencies(b.id, ["missing-task"])).toThrow(
      expect.objectContaining({ code: "TASK_DEPENDENCY_NOT_FOUND" }),
    );
    expect(() => graph.setDependencies(b.id, [foreign.id])).toThrow(
      expect.objectContaining({ code: "TASK_DEPENDENCY_WORKSPACE_MISMATCH" }),
    );
    expect(() => graph.setDependencies(b.id, [b.id])).toThrow(
      expect.objectContaining({ code: "TASK_DEPENDENCY_SELF" }),
    );
    expect(() => graph.setDependencies(b.id, [a.id, a.id])).toThrow(
      expect.objectContaining({ code: "TASK_DEPENDENCY_DUPLICATE" }),
    );
    graph.setDependencies(b.id, [a.id]);
    expect(() => graph.setDependencies(a.id, [b.id])).toThrow(
      expect.objectContaining({ code: "TASK_DEPENDENCY_CYCLE" }),
    );
    expect(store.getTask(a.id)?.dependsOn).toEqual([]);
    expect(store.getTask(b.id)?.ownerId).toBeNull();
    expect(store.listEvents({ aggregateId: b.id }).length).toBeGreaterThan(beforeEvents);
    store.close();
  });

  it("rolls back owner if a combined graph patch later fails", () => {
    const { store, workspace, agent, graph } = setup();
    const a = createTask(graph, workspace.id, "A");
    const b = createTask(graph, workspace.id, "B");
    const eventsBefore = store.listEvents({ aggregateId: b.id }).length;
    expect(() =>
      store.updateTask(b.id, { ownerId: agent.id, dependsOn: [b.id] }),
    ).toThrow(expect.objectContaining({ code: "TASK_DEPENDENCY_SELF" }));
    expect(store.getTask(b.id)?.ownerId).toBeNull();
    expect(store.getTask(b.id)?.dependsOn).toEqual([]);
    expect(store.listEvents({ aggregateId: b.id })).toHaveLength(eventsBefore);
    expect(store.getTask(a.id)?.dependsOn).toEqual([]);
    store.close();
  });

  it("rejects more than 100 dependencies", () => {
    const { store, workspace, graph } = setup();
    const target = createTask(graph, workspace.id, "Target");
    const many = Array.from({ length: 101 }, (_, index) =>
      createTask(graph, workspace.id, `Dependency ${index}`),
    );
    expect(() => graph.setDependencies(target.id, many.map((task) => task.id))).toThrow(
      expect.objectContaining({ code: "TASK_DEPENDENCY_LIMIT" }),
    );
    store.close();
  });

  it("keeps A-B-A-B graph changes in the event log and replays the final state", () => {
    const { store, workspace, graph } = setup();
    const ownerA = store.createAgent({
      workspaceId: workspace.id,
      name: "Owner A",
      role: "engineer",
      systemPrompt: "",
      persona: "",
      agentsMd: "",
      model: null,
    });
    const ownerB = store.createAgent({
      workspaceId: workspace.id,
      name: "Owner B",
      role: "engineer",
      systemPrompt: "",
      persona: "",
      agentsMd: "",
      model: null,
    });
    const a = createTask(graph, workspace.id, "A");
    const b = createTask(graph, workspace.id, "B");

    graph.setOwner(b.id, ownerA.id);
    graph.setOwner(b.id, ownerB.id);
    graph.setOwner(b.id, ownerA.id);
    graph.setOwner(b.id, ownerB.id);
    graph.setDependencies(b.id, [a.id]);
    graph.setDependencies(b.id, []);
    graph.setDependencies(b.id, [a.id]);
    graph.setDependencies(b.id, []);

    const ownerEvents = store
      .listEvents({ aggregateId: b.id })
      .filter((event) => event.type === "task.owner_changed");
    const dependencyEvents = store
      .listEvents({ aggregateId: b.id })
      .filter((event) => event.type === "task.dependencies_changed");
    expect(ownerEvents).toHaveLength(4);
    expect(dependencyEvents).toHaveLength(4);
    expect(new Set(ownerEvents.map((event) => event.idempotencyKey)).size).toBe(4);
    expect(new Set(dependencyEvents.map((event) => event.idempotencyKey)).size).toBe(4);

    rebuildProjections(store);
    expect(store.getTask(b.id)).toMatchObject({ ownerId: ownerB.id, dependsOn: [] });
    expect(
      store.db.prepare("SELECT owner_id, depends_on FROM tasks WHERE id = ?").get(b.id),
    ).toMatchObject({ owner_id: ownerB.id, depends_on: "[]" });
    expect(
      store.db.prepare("SELECT agent_id FROM task_owners WHERE task_id = ?").get(b.id),
    ).toMatchObject({ agent_id: ownerB.id });
    expect(store.db.prepare("SELECT * FROM task_dependencies WHERE task_id = ?").all(b.id)).toEqual([]);
    store.close();
  });

  it("resets ready/blocked when dependency satisfaction changes", () => {
    const { store, workspace, graph } = setup();
    const a = createTask(graph, workspace.id, "A");
    const b = createTask(graph, workspace.id, "B");
    graph.setDependencies(b.id, [a.id]);
    expect(store.getTask(b.id)?.status).toBe("blocked");
    store.updateTask(a.id, { status: "done" });
    graph.setDependencies(b.id, [a.id]);
    expect(store.getTask(b.id)).toMatchObject({ status: "ready", blockedReason: null });
    graph.setDependencies(b.id, []);
    expect(store.getTask(b.id)?.status).toBe("ready");
    store.close();
  });

  it("raises TASK_HAS_DEPENDENTS when deleting a parent", () => {
    const { store, workspace, graph } = setup();
    const parent = createTask(graph, workspace.id, "Parent");
    const child = createTask(graph, workspace.id, "Child");
    graph.setDependencies(child.id, [parent.id]);
    expect(() => graph.deleteTask(parent.id)).toThrow(
      expect.objectContaining({ code: "TASK_HAS_DEPENDENTS" }),
    );
    expect(store.getTask(parent.id)).not.toBeNull();
    store.close();
  });

  it("projects task.deleted by removing task, relation rows and runs from rebuild", () => {
    const { store, workspace, agent, graph } = setup();
    const a = createTask(graph, workspace.id, "A");
    const b = createTask(graph, workspace.id, "B", {
      ownerId: agent.id,
      dependsOn: [a.id],
    });
    expect(store.getTask(b.id)).not.toBeNull();
    graph.deleteTask(b.id);
    expect(store.getTask(b.id)).toBeNull();
    const digestAfterDelete = projectionDigest(store);
    expect(digestAfterDelete.tasks.blocked).toBe(0);

    rebuildProjections(store);
    expect(store.getTask(b.id)).toBeNull();
    expect(
      store.db.prepare("SELECT * FROM task_owners WHERE task_id = ?").all(b.id),
    ).toEqual([]);
    expect(
      store.db.prepare("SELECT * FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?").all(b.id, b.id),
    ).toEqual([]);
    expect(projectionDigest(store)).toEqual(digestAfterDelete);
    expect(store.listEvents({ aggregateId: b.id }).some((event) => event.type === "task.deleted")).toBe(
      true,
    );
    store.close();
  });

  it("replays graph events into relation tables", () => {
    const { store, workspace, agent, graph } = setup();
    const a = createTask(graph, workspace.id, "A");
    const b = createTask(graph, workspace.id, "B", { ownerId: agent.id });
    graph.setDependencies(b.id, [a.id], { reason: "replay" });
    expect(store.getTask(b.id)).toMatchObject({ ownerId: agent.id, dependsOn: [a.id] });

    rebuildProjections(store);
    expect(store.getTask(b.id)).toMatchObject({ ownerId: agent.id, dependsOn: [a.id] });
    expect(
      store.db.prepare("SELECT agent_id FROM task_owners WHERE task_id = ?").get(b.id),
    ).toMatchObject({ agent_id: agent.id });
    expect(
      store.db.prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?").all(b.id),
    ).toEqual([{ depends_on_task_id: a.id }]);
    store.close();
  });

  it("keeps direct SQL owner/dependency writes inside the controlled Store mirror", () => {
    const serviceSource = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
    const kernelSource = readFileSync(new URL("./execution/kernel.ts", import.meta.url), "utf8");
    const gitSource = readFileSync(new URL("../git/gitService.ts", import.meta.url), "utf8");
    for (const source of [serviceSource, kernelSource, gitSource]) {
      expect(source).not.toMatch(/UPDATE\s+tasks\s+SET\s+(owner_id|depends_on)/i);
      expect(source).not.toMatch(/UPDATE\s+task_(owners|dependencies)/i);
    }
    expect(gitSource).toContain("this.tasks.createTask");
    expect(gitSource).toContain("this.tasks.setOwner");
  });
});
