import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { AppService } from "./service.js";
import { defaultModelProfile, defaultProviderProfile } from "../shared/models.js";
import type { PlanDraftTask } from "../shared/planDraft.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

function setup(): AppService {
  const root = mkdtempSync(path.join(os.tmpdir(), "deer-plan-draft-"));
  const workspacePath = path.join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(path.join(workspacePath, "README.md"), "# Demo\n", "utf8");
  const service = new AppService(path.join(root, "data"));
  cleanup.push(() => {
    service.close();
    rmSync(root, { recursive: true, force: true });
  });
  return service;
}

function draftTask(id: string, title: string, extra: Partial<PlanDraftTask> = {}): PlanDraftTask {
  return {
    id,
    title,
    description: "",
    acceptance: [],
    dependsOn: [],
    ownerId: null,
    priority: 50,
    risks: [],
    unknowns: [],
    ...extra,
  };
}

async function ws(service: AppService) {
  const root = mkdtempSync(path.join(os.tmpdir(), "deer-plan-ws-"));
  const workspacePath = path.join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(path.join(workspacePath, "README.md"), "# Demo\n", "utf8");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return service.openWorkspace(workspacePath);
}

describe("t231 confirmPlan atomic/idempotent", () => {
  it("previewPlan is read-only even when the planner succeeds", async () => {
    const service = setup();
    const workspace = await ws(service);
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content: JSON.stringify({
                  tasks: [
                    {
                      title: "Preview task",
                      description: "read only",
                      acceptance: ["ok"],
                      dependsOn: [],
                    },
                  ],
                }),
              },
            },
          ],
        })}\n\n`,
      );
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
    const beforeTasks = service.getSnapshot(workspace.id).tasks.length;
    const beforeEvents = Number(
      (service.store.db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number })
        .count,
    );
    try {
      const result = await service.previewPlan(workspace.id, {
        goal: "preview only",
        goalSource: "composer",
        messages: [],
        summary: "",
        overview: "",
        characterCount: 12,
        digest: "preview-digest",
      });
      expect(result.ok).toBe(true);
      expect(result.draft?.tasks).toHaveLength(1);
      expect(service.getSnapshot(workspace.id).tasks).toHaveLength(beforeTasks);
      expect(
        Number(
          (service.store.db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number })
            .count,
        ),
      ).toBe(beforeEvents);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("preview source-limit failure has zero task side effects", async () => {
    const service = setup();
    const workspace = await ws(service);
    const before = service.getSnapshot(workspace.id).tasks.length;
    const result = await service.previewPlan(workspace.id, {
      goal: "too big",
      goalSource: "composer",
      messages: [],
      summary: "",
      overview: "",
      characterCount: 12_001,
      digest: "1234abcd",
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "SOURCE_TOO_LARGE" }),
    );
    expect(service.getSnapshot(workspace.id).tasks).toHaveLength(before);
  });

  it("creates a DAG once, preserves owner/priority/dependencies, and replays the same key", async () => {
    const service = setup();
    const workspace = await ws(service);
    const tasks = [
      draftTask("a", "First", { priority: 70 }),
      draftTask("b", "Second", { dependsOn: ["a"], priority: 30 }),
    ];
    const first = service.confirmPlan({
      workspaceId: workspace.id,
      sourceDigest: "source-digest",
      idempotencyKey: "key-1",
      tasks,
      ackHighRisk: false,
    });
    expect(first.alreadyConfirmed).toBe(false);
    expect(first.tasks).toHaveLength(2);
    expect(first.tasks[0]?.priority).toBe(70);
    expect(first.tasks[1]?.priority).toBe(30);
    expect(first.tasks[1]?.dependsOn).toEqual([first.tasks[0]?.id]);
    expect(first.tasks[1]?.status).toBe("blocked");

    const second = service.confirmPlan({
      workspaceId: workspace.id,
      sourceDigest: "source-digest",
      idempotencyKey: "key-1",
      tasks,
      ackHighRisk: false,
    });
    expect(second.alreadyConfirmed).toBe(true);
    expect(second.tasks.map((task) => task.id)).toEqual(first.tasks.map((task) => task.id));
    expect(service.getSnapshot(workspace.id).tasks).toHaveLength(2);
  });

  it("rejects cycle/invalid drafts without writing, and requires high-risk ack", async () => {
    const service = setup();
    const workspace = await ws(service);
    const before = service.getSnapshot(workspace.id).tasks.length;
    expect(() =>
      service.confirmPlan({
        workspaceId: workspace.id,
        sourceDigest: "d",
        idempotencyKey: "cycle",
        tasks: [
          draftTask("a", "A", { dependsOn: ["b"] }),
          draftTask("b", "B", { dependsOn: ["a"] }),
        ],
        ackHighRisk: false,
      }),
    ).toThrow(/PLAN_INVALID/);
    expect(service.getSnapshot(workspace.id).tasks).toHaveLength(before);

    expect(() =>
      service.confirmPlan({
        workspaceId: workspace.id,
        sourceDigest: "d",
        idempotencyKey: "risk",
        tasks: [draftTask("a", "Delete migration secret", { description: "delete data" })],
        ackHighRisk: false,
      }),
    ).toThrow(/PLAN_HIGH_RISK/);
    expect(service.getSnapshot(workspace.id).tasks).toHaveLength(before);
  });
});
