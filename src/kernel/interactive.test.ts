import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppService } from "./service.js";
import type { ChatMessage, ChatQuestionRecord } from "../shared/types.js";

/**
 * t64：主进程 ingest 与提问状态机单测（设计 §9.4 / AC-10/11/12/16/23/28/29）。
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "deer-interactive-"));
  const workspacePath = path.join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const service = new AppService(path.join(root, "data"));
  cleanups.push(() => {
    service.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { service, root, workspacePath };
}

async function openWorkspace(service: AppService, workspacePath: string) {
  const workspace = await service.openWorkspace(workspacePath);
  const router = service.getSnapshot(workspace.id).agents.find((agent) => agent.isRouter)!;
  return { workspace, router };
}

async function askCanvas(service: AppService, workspaceId: string) {
  const reply = await service.sendChat(workspaceId, "帮我画一张实现流程图");
  if (!reply) throw new Error("no reply");
  return reply;
}

async function askQuestion(service: AppService, workspaceId: string) {
  const reply = await service.sendChat(workspaceId, "帮我做一个表单确认一下范围");
  if (!reply) throw new Error("no reply");
  return reply;
}

function firstQuestion(service: AppService, workspaceId: string): ChatQuestionRecord {
  const questions = service.listChatQuestions(workspaceId);
  expect(questions.length).toBeGreaterThan(0);
  return questions[0];
}

function validAnswer() {
  return {
    platform: "desktop",
    features: ["flow", "ask"],
    notes: "",
    confirm: true,
  };
}

describe("ingest：画布索引与提问落库", () => {
  it("助手消息里的合法 deer-canvas 被索引（幂等、写审计事件）", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router } = await openWorkspace(service, workspacePath);
    const reply = await askCanvas(service, workspace.id);
    expect(reply.content).toContain("deer-canvas");

    const artifacts = service.listChatArtifacts(workspace.id, router.id);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].kind).toBe("flowchart");
    expect(artifacts[0].id).toBe(`${reply.id}#b0`);
    expect(artifacts[0].payload.nodes.length).toBeGreaterThan(2);
    const events = service.store.listEvents({ aggregateId: artifacts[0].id });
    expect(events.some((event) => event.type === "chat.artifact_ingested")).toBe(true);

    // 重复 ingest 幂等：不新增记录、不重复事件。
    const again = service.ingestAssistantInteractive(workspace.id, router.id, reply);
    expect(again.artifacts).toBe(0);
    expect(service.listChatArtifacts(workspace.id, router.id)).toHaveLength(1);
  });

  it("助手消息里的合法 deer-question 落库为 pending（带 expiresAt）", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router } = await openWorkspace(service, workspacePath);
    await askQuestion(service, workspace.id);
    const questions = service.listChatQuestions(workspace.id, router.id);
    expect(questions).toHaveLength(1);
    expect(questions[0].status).toBe("pending");
    expect(questions[0].payload.fields).toHaveLength(4);
    expect(questions[0].expiresAt).not.toBeNull();

    const events = service.store.listEvents({ aggregateId: questions[0].id });
    expect(events.some((event) => event.type === "chat.question_created")).toBe(true);
  });

  it("非法块不落库，只写 chat.interactive_invalid（不阻断对话）", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router } = await openWorkspace(service, workspacePath);
    const message = service.store.addChatMessage({
      workspaceId: workspace.id,
      agentId: router.id,
      role: "assistant",
      content: "坏的画布：\n```deer-canvas\n{not json}\n```",
    });
    const result = service.ingestAssistantInteractive(workspace.id, router.id, message);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe("E_JSON");
    expect(service.listChatArtifacts(workspace.id)).toHaveLength(0);
    const events = service.store.listEvents({ aggregateId: message.id });
    const invalid = events.find((event) => event.type === "chat.interactive_invalid");
    expect(invalid).toBeDefined();
    expect((invalid?.payload as { code?: string }).code).toBe("E_JSON");
  });
});

describe("提问状态机：回答 / 幂等 / 校验 / 过期 / 取消", () => {
  it("回答成功：answered + 格式化 answerText + 审计事件不含答案值", async () => {
    const { service, workspacePath } = setup();
    const { workspace } = await openWorkspace(service, workspacePath);
    await askQuestion(service, workspace.id);
    const question = firstQuestion(service, workspace.id);

    const result = service.answerChatQuestion({
      workspaceId: workspace.id,
      questionId: question.id,
      values: validAnswer(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.question.status).toBe("answered");
    expect(result.question.answer?.values.platform).toBe("desktop");
    expect(result.answerText.startsWith("[回答表单]")).toBe(true);
    expect(result.answerText).toContain("- 优先平台：桌面 Electron（默认）");
    expect(result.answerText).toContain("- P0 必须包含：流程图、提问表单");
    expect(result.answerText).toContain("- 按以上范围开始实现：确认");

    const events = service.store.listEvents({ aggregateId: question.id });
    const answered = events.find((event) => event.type === "chat.question_answered")!;
    const payload = answered.payload as { changed?: boolean; fieldIds?: string[] };
    expect(payload.changed).toBe(true);
    expect(payload.fieldIds?.length).toBeGreaterThan(0);
    // 审计事件不含答案值。
    expect(JSON.stringify(answered.payload)).not.toContain("desktop");
  });

  it("重复回答：changed=false，answerText 一致，不产生第二条回答", async () => {
    const { service, workspacePath } = setup();
    const { workspace } = await openWorkspace(service, workspacePath);
    await askQuestion(service, workspace.id);
    const question = firstQuestion(service, workspace.id);
    const first = service.answerChatQuestion({
      workspaceId: workspace.id,
      questionId: question.id,
      values: validAnswer(),
    });
    const second = service.answerChatQuestion({
      workspaceId: workspace.id,
      questionId: question.id,
      values: { ...validAnswer(), platform: "web" },
    });
    expect(first.ok && first.changed).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.changed).toBe(false);
    expect(second.answerText).toBe(first.answerText);
  });

  it("答案校验：必填缺失 / 非法选项 / 额外 key → E_INVALID_ANSWER + fieldErrors", async () => {
    const { service, workspacePath } = setup();
    const { workspace } = await openWorkspace(service, workspacePath);
    await askQuestion(service, workspace.id);
    const question = firstQuestion(service, workspace.id);

    const missing = service.answerChatQuestion({
      workspaceId: workspace.id,
      questionId: question.id,
      values: {},
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe("E_INVALID_ANSWER");
      expect(missing.fieldErrors?.length).toBeGreaterThan(0);
    }

    const tampered = service.answerChatQuestion({
      workspaceId: workspace.id,
      questionId: question.id,
      values: { ...validAnswer(), features: ["hack"] },
    });
    expect(tampered.ok).toBe(false);

    const extra = service.answerChatQuestion({
      workspaceId: workspace.id,
      questionId: question.id,
      values: { ...validAnswer(), extraKey: "x" },
    });
    expect(extra.ok).toBe(false);
    if (!extra.ok) {
      expect(extra.fieldErrors?.some((error) => error.code === "unknown_field")).toBe(true);
    }

    // 失败的提交不改变状态。
    expect(firstQuestion(service, workspace.id).status).toBe("pending");
  });

  it("过期：list 惰性清算为 expired，提交返回 E_EXPIRED 且不落库", async () => {
    const { service, workspacePath } = setup();
    const { workspace } = await openWorkspace(service, workspacePath);
    await askQuestion(service, workspace.id);
    const question = firstQuestion(service, workspace.id);
    const past = "2020-01-01T00:00:00.000Z";
    service.store.db
      .prepare("UPDATE chat_questions SET expires_at = ? WHERE id = ?")
      .run(past, question.id);

    const listed = service.listChatQuestions(workspace.id);
    expect(listed[0].status).toBe("expired");
    const events = service.store.listEvents({ aggregateId: question.id });
    expect(events.some((event) => event.type === "chat.question_expired")).toBe(true);

    const result = service.answerChatQuestion({
      workspaceId: workspace.id,
      questionId: question.id,
      values: validAnswer(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("E_EXPIRED");
    expect(service.store.getChatQuestion(question.id)?.answer).toBeNull();
  });

  it("取消：cancelled；再次取消幂等；取消后回答 E_CLOSED", async () => {
    const { service, workspacePath } = setup();
    const { workspace } = await openWorkspace(service, workspacePath);
    await askQuestion(service, workspace.id);
    const question = firstQuestion(service, workspace.id);

    const cancelled = service.cancelChatQuestion({
      workspaceId: workspace.id,
      questionId: question.id,
    });
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) expect(cancelled.question.status).toBe("cancelled");
    const again = service.cancelChatQuestion({
      workspaceId: workspace.id,
      questionId: question.id,
    });
    expect(again.ok).toBe(true);

    const answer = service.answerChatQuestion({
      workspaceId: workspace.id,
      questionId: question.id,
      values: validAnswer(),
    });
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.code).toBe("E_CLOSED");

    const events = service.store.listEvents({ aggregateId: question.id });
    expect(events.filter((event) => event.type === "chat.question_cancelled")).toHaveLength(1);
  });

  it("已回答后取消 → E_CLOSED", async () => {
    const { service, workspacePath } = setup();
    const { workspace } = await openWorkspace(service, workspacePath);
    await askQuestion(service, workspace.id);
    const question = firstQuestion(service, workspace.id);
    service.answerChatQuestion({
      workspaceId: workspace.id,
      questionId: question.id,
      values: validAnswer(),
    });
    const result = service.cancelChatQuestion({
      workspaceId: workspace.id,
      questionId: question.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("E_CLOSED");
  });

  it("跨工作区回答/列表被拒绝，画布同隔离", async () => {
    const { service, workspacePath, root } = setup();
    const { workspace } = await openWorkspace(service, workspacePath);
    await askQuestion(service, workspace.id);
    await askCanvas(service, workspace.id);
    const question = firstQuestion(service, workspace.id);
    const artifact = service.listChatArtifacts(workspace.id)[0];

    const secondPath = path.join(root, "second");
    mkdirSync(secondPath, { recursive: true });
    const second = await service.openWorkspace(secondPath);

    const answer = service.answerChatQuestion({
      workspaceId: second.id,
      questionId: question.id,
      values: validAnswer(),
    });
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.code).toBe("E_WORKSPACE_MISMATCH");
    expect(service.listChatQuestions(second.id)).toHaveLength(0);
    expect(service.listChatArtifacts(second.id)).toHaveLength(0);
    expect(service.getChatArtifact(second.id, artifact.id)).toBeNull();
  });

  it("Router 回复中提交 → E_BUSY，且不改变状态", async () => {
    const { service, workspacePath } = setup();
    const { workspace } = await openWorkspace(service, workspacePath);
    await askQuestion(service, workspace.id);
    const question = firstQuestion(service, workspace.id);
    const internals = service as unknown as {
      chatAborts: Map<string, AbortController>;
    };
    internals.chatAborts.set(workspace.id, new AbortController());
    try {
      const result = service.answerChatQuestion({
        workspaceId: workspace.id,
        questionId: question.id,
        values: validAnswer(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("E_BUSY");
      expect(service.store.getChatQuestion(question.id)?.status).toBe("pending");
    } finally {
      internals.chatAborts.delete(workspace.id);
    }
  });

  it("问题不存在 → E_NOT_FOUND", async () => {
    const { service, workspacePath } = setup();
    const { workspace } = await openWorkspace(service, workspacePath);
    const result = service.answerChatQuestion({
      workspaceId: workspace.id,
      questionId: "missing#b0",
      values: validAnswer(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("E_NOT_FOUND");
  });
});

describe("上下文与历史", () => {
  it("getContext 增加交互段，Router 系统提示包含协议 v1", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router } = await openWorkspace(service, workspacePath);
    await askCanvas(service, workspace.id);
    await askQuestion(service, workspace.id);

    const context = service.getContext(workspace.id, router.id);
    const system = context.sections.find((section) => section.id === "system");
    expect(system?.content).toContain("deer-canvas");
    expect(system?.content).toContain("deer-question");
    const interactive = context.sections.find((section) => section.id === "interactive");
    expect(interactive).toBeDefined();
    expect(interactive?.kind).toBe("history");
    expect(interactive?.content).toContain("[画布]");
    expect(interactive?.content).toContain("[待回答]");
    expect(interactive?.meta).toContain("1 张画布");
    expect(interactive?.meta).toContain("1 个待回答");
  });

  it("消息 content 保留原始 fenced JSON（UI 事实源），不因压缩丢失", async () => {
    const { service, workspacePath } = setup();
    const { workspace, router } = await openWorkspace(service, workspacePath);
    const reply = await askCanvas(service, workspace.id);
    const chat = service.listChat(workspace.id, router.id);
    const stored = chat.find((message: ChatMessage) => message.id === reply.id);
    expect(stored?.content).toContain("```deer-canvas");
    expect(stored?.content).toContain('"protocol": "deer-canvas"');
  });
});
