import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppService } from "./service.js";
import type { CreatePollRequest } from "../shared/poll.js";
import { PollError } from "../shared/poll.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

async function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "deer-poll-service-"));
  const workspaceA = path.join(root, "a");
  const workspaceB = path.join(root, "b");
  mkdirSync(workspaceA, { recursive: true });
  mkdirSync(workspaceB, { recursive: true });
  writeFileSync(path.join(workspaceA, "README.md"), "# A\n", "utf8");
  writeFileSync(path.join(workspaceB, "README.md"), "# B\n", "utf8");
  const service = new AppService(path.join(root, "data"));
  const wsA = await service.openWorkspace(workspaceA);
  const wsB = await service.openWorkspace(workspaceB);
  cleanups.push(() => {
    service.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { service, wsA, wsB };
}

async function createInput(workspaceId: string, overrides: Partial<CreatePollRequest> = {}): Promise<CreatePollRequest> {
  return {
    workspaceId,
    scope: "team",
    title: "poll decision test",
    mode: "multi",
    maxSelections: 1,
    thresholdRule: "gt",
    thresholdValue: 0,
    quorum: 0,
    options: [{ label: "A" }, { label: "B" }],
    ...overrides,
  };
}

describe("t152 poll service trust boundary", () => {
  it("binds human actor to user, ignores forged createdBy/actor/voterId, and validates workspace", async () => {
    const { service, wsA, wsB } = await setup();
    const input = await createInput(wsA.id);
    const forgedInput = { ...input, createdBy: "evil" } as CreatePollRequest & { createdBy: string };
    const created = service.createPoll(forgedInput);
    expect(created.createdBy).toBe("user");
    expect(created.workspaceId).toBe(wsA.id);

    const forgedCast = {
      pollId: created.id,
      voterType: "human" as const,
      selections: [created.options[0].id],
      voterId: "evil",
    };
    const cast = service.castPoll(wsA.id, forgedCast);
    expect(cast.ballots[0]?.voterId).toBe("user");

    const forgedClose = { pollId: created.id, actor: "evil" };
    const closed = service.closePoll(wsA.id, forgedClose);
    expect(closed.status).toBe("closed");
    const closeEvent = service.store.listEvents({ aggregateId: created.id }).find((event) => event.type === "poll.closed");
    expect(closeEvent?.actor).toBe("user");

    const foreign = service.createPoll(await createInput(wsB.id));
    expect(() => service.getPoll(wsA.id, foreign.id)).toThrow(PollError);
    expect(() =>
      service.castPoll(wsA.id, { pollId: foreign.id, voterType: "human", selections: [foreign.options[0].id] }),
    ).toThrow(PollError);
    expect(() => service.closePoll(wsA.id, { pollId: foreign.id })).toThrow(PollError);
    expect(service.getPoll(wsB.id, foreign.id).workspaceId).toBe(wsB.id);
  });

  it("validates agent voters against the workspace and refuses close of non-human-created polls", async () => {
    const { service, wsA, wsB } = await setup();
    const poll = service.createPoll(await createInput(wsA.id));
    const agentA = service.store.createAgent({
      workspaceId: wsA.id,
      name: "alice",
      role: "engineer",
      systemPrompt: "",
      persona: "",
      agentsMd: "",
      model: null,
    });
    const agentB = service.store.createAgent({
      workspaceId: wsB.id,
      name: "bob",
      role: "engineer",
      systemPrompt: "",
      persona: "",
      agentsMd: "",
      model: null,
    });
    const voted = service.castPoll(wsA.id, {
      pollId: poll.id,
      voterType: "agent",
      voterId: agentA.id,
      selections: [poll.options[0].id],
    });
    expect(voted.ballots.some((ballot) => ballot.voterId === agentA.id)).toBe(true);
    expect(() =>
      service.castPoll(wsA.id, {
        pollId: poll.id,
        voterType: "agent",
        voterId: agentB.id,
        selections: [poll.options[1].id],
      }),
    ).toThrow(PollError);
    expect(() =>
      service.castPoll(wsA.id, {
        pollId: poll.id,
        voterType: "agent",
        selections: [poll.options[0].id],
      }),
    ).toThrow(PollError);

    const foreignCreated = service.store.createPoll({
      ...(await createInput(wsA.id)),
      createdBy: "agent-x",
    });
    expect(() => service.closePoll(wsA.id, { pollId: foreignCreated.id })).toThrow(PollError);
  });

  it("writes decision through MemoryStore: user source, domain, active status and FTS search", async () => {
    const { service, wsA } = await setup();
    const poll = service.createPoll(await createInput(wsA.id, { title: "poll decision test" }));
    service.castPoll(wsA.id, {
      pollId: poll.id,
      voterType: "human",
      selections: [poll.options[0].id],
    });
    const closed = service.closePoll(wsA.id, { pollId: poll.id });
    expect(closed.decision?.boardEntryId).toBeTruthy();
    const snapshot = service.memory.snapshot(wsA.id);
    const entry = snapshot.entries.find((item) => item.id === closed.decision?.boardEntryId);
    expect(entry).toBeTruthy();
    expect(entry?.source).toBe("user");
    expect(entry?.sourceRef).toBeNull();
    expect(entry?.board).toBe("decisions");
    expect(entry?.status).toBe("active");
    expect(entry?.contentHash).toBeTruthy();
    expect(snapshot.domains.some((domain) => domain.name === "decisions")).toBe(true);
    const search = service.memory.search({ workspaceId: wsA.id, query: "poll decision test", scopes: ["board"] });
    expect(search.hits.some((hit) => hit.entityId === closed.decision?.boardEntryId)).toBe(true);
  });

  it("anonymous API returns only the viewer ballot while audit keeps voter actor", async () => {
    const { service, wsA } = await setup();
    const poll = service.createPoll(await createInput(wsA.id, {
      title: "anonymous decision",
      anonymous: true,
      thresholdRule: "gt",
      thresholdValue: 0,
    }));
    service.castPoll(wsA.id, {
      pollId: poll.id,
      voterType: "human",
      selections: [poll.options[0].id],
    });
    service.store.castPoll({
      pollId: poll.id,
      voterId: "other-voter",
      voterType: "human",
      selections: [poll.options[1].id],
    });
    const viewed = service.getPoll(wsA.id, poll.id);
    expect(viewed.anonymous).toBe(true);
    expect(viewed.ballots).toHaveLength(1);
    expect(viewed.ballots[0]?.voterId).toBe("user");
    expect(JSON.stringify(viewed)).not.toContain("other-voter");
    const listed = service.listPolls(wsA.id).find((item) => item.id === poll.id);
    expect(listed?.ballots).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("other-voter");
    const votedEvent = service.store.listEvents({ aggregateId: poll.id }).find((event) => event.type === "poll.voted" && event.actor === "other-voter");
    expect(votedEvent).toBeTruthy();
  });
});
