import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RiskApprovalRequest } from "../shared/types.js";
import { RISK_APPROVAL_TIMEOUT_MS } from "../shared/approval.js";
import { fullThrottleBudget, policyCheck } from "./permission.js";
import { AppService } from "./service.js";
import { Store } from "./store.js";
import { createBuiltinTools, ToolRegistry, type ToolContext } from "./tools.js";

/**
 * t58 IF-05 / IF-08：auto_risk 高风险人类审批链路 + 敏感路径写入策略。
 * 覆盖：单次批准、拒绝、超时、无回调兜底、非 auto_risk 不请求审批、
 * full_access 放行并审计、服务端审批一次性与超时、Agent 无自行批准路径、FT 正交。
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  vi.useRealTimers();
});

function makeWorkspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "deer-approval-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeToolContext(
  worktreePath: string,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  const store = new Store(":memory:");
  cleanups.push(() => store.close());
  return {
    workspaceId: "ws_approval",
    workspacePath: worktreePath,
    worktreePath,
    taskId: "task_approval",
    runId: "run_approval",
    agentId: "agent_approval",
    agentName: "Builder",
    store,
    permission: "auto_risk",
    ...overrides,
  };
}

function makeService(): AppService {
  const root = mkdtempSync(path.join(os.tmpdir(), "deer-approval-service-"));
  const service = new AppService(path.join(root, "data"));
  cleanups.push(() => {
    service.close();
    rmSync(root, { recursive: true, force: true });
  });
  return service;
}

function riskEvents(ctx: ToolContext) {
  return ctx.store
    .listEvents({ aggregateId: ctx.taskId })
    .filter((event) => event.type === "permission.risk_vote")
    .map((event) => event.payload as { decision?: string; result?: string });
}

describe("IF-05：auto_risk 高风险人类审批（ToolRegistry）", () => {
  it("批准只对该次调用生效；第二次调用重新请求审批", async () => {
    const root = makeWorkspace();
    let calls = 0;
    const ctx = makeToolContext(root, {
      requestApproval: async () =>
        calls++ === 0
          ? { approved: true, outcome: "approved" }
          : { approved: false, outcome: "denied" },
    });
    const registry = new ToolRegistry().registerAll(createBuiltinTools());

    const first = await registry.execute(
      "fs.write",
      { path: ".ssh/config", content: "Host *\n" },
      ctx,
    );
    expect(first.ok).toBe(true);
    expect(existsSync(path.join(root, ".ssh", "config"))).toBe(true);

    const second = await registry.execute(
      "fs.write",
      { path: ".ssh/config", content: "Host *\n" },
      ctx,
    );
    expect(second.ok).toBe(false);
    expect(calls).toBe(2);

    const decisions = riskEvents(ctx).map((payload) => payload.decision);
    expect(decisions).toContain("human_approved");
    expect(decisions).toContain("human_denied");
    expect(riskEvents(ctx).every((payload) => payload.result !== undefined)).toBe(true);
  });

  it("拒绝写 human_denied 并拒绝执行；超时写 human_required 且不执行", async () => {
    const root = makeWorkspace();
    const registry = new ToolRegistry().registerAll(createBuiltinTools());

    const deniedCtx = makeToolContext(root, {
      requestApproval: async () => ({ approved: false, outcome: "denied" }),
    });
    const denied = await registry.execute(
      "fs.write",
      { path: ".env", content: "SECRET=1" },
      deniedCtx,
    );
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("人类已拒绝");
    expect(existsSync(path.join(root, ".env"))).toBe(false);
    expect(riskEvents(deniedCtx).some((payload) => payload.decision === "human_denied")).toBe(true);
    expect(
      deniedCtx.store
        .listEvents({ aggregateId: deniedCtx.taskId })
        .some((event) => event.type === "tool.denied"),
    ).toBe(true);

    const timeoutCtx = makeToolContext(root, {
      requestApproval: async () => ({ approved: false, outcome: "timeout" }),
    });
    const timedOut = await registry.execute(
      "shell.run",
      { command: "rm -rf node_modules" },
      timeoutCtx,
    );
    expect(timedOut.ok).toBe(false);
    expect(timedOut.error).toContain("超时");
    expect(
      riskEvents(timeoutCtx).some((payload) => payload.decision === "human_required"),
    ).toBe(true);
  });

  it("无审批回调时不静默放行（按未批准处理并写 human_required）", async () => {
    const root = makeWorkspace();
    const ctx = makeToolContext(root); // 没有 requestApproval
    const registry = new ToolRegistry().registerAll(createBuiltinTools());
    const result = await registry.execute("fs.write", { path: ".env", content: "X=1" }, ctx);
    expect(result.ok).toBe(false);
    expect(existsSync(path.join(root, ".env"))).toBe(false);
    expect(riskEvents(ctx).some((payload) => payload.decision === "human_required")).toBe(true);
  });

  it("非 auto_risk 不触发人类审批：workspace_write 直接拒绝，full_access 放行并审计", async () => {
    const root = makeWorkspace();
    const registry = new ToolRegistry().registerAll(createBuiltinTools());
    let approvalCalls = 0;
    const requestApproval = async () => {
      approvalCalls += 1;
      return { approved: true, outcome: "approved" as const };
    };

    const wsCtx = makeToolContext(root, { permission: "workspace_write", requestApproval });
    const denied = await registry.execute("fs.write", { path: ".env", content: "A=1" }, wsCtx);
    expect(denied.ok).toBe(false);
    expect(approvalCalls).toBe(0);

    const fullCtx = makeToolContext(root, { permission: "full_access", requestApproval });
    const allowed = await registry.execute(
      "fs.write",
      { path: "secrets/.env.local", content: "B=2" },
      fullCtx,
    );
    expect(allowed.ok).toBe(true);
    expect(existsSync(path.join(root, "secrets", ".env.local"))).toBe(true);
    expect(approvalCalls).toBe(0);
    expect(
      riskEvents(fullCtx).some(
        (payload) => payload.decision === "full_access_allowed" && payload.result === "allowed",
      ),
    ).toBe(true);
  });

  it("Agent 没有可自行批准的路径：工具清单里没有审批/权限工具", () => {
    const names = createBuiltinTools().map((tool) => tool.name);
    expect(names.some((name) => /approval|permission/i.test(name))).toBe(false);
    expect(names.some((name) => name.includes("respondRisk"))).toBe(false);
  });

  it("Full Throttle 与权限正交：read_only 写入仍拒绝，预算覆盖不含 permission 字段", () => {
    expect(policyCheck("read_only", "fs.write", { path: "a.ts", content: "x" }).allowed).toBe(
      false,
    );
    // 敏感路径在 auto_risk 下仍必须人类确认（FT 不改变分级）
    expect(
      policyCheck("auto_risk", "fs.write", { path: ".ssh/config", content: "x" }).action,
    ).toBe("human_confirm");
    expect(
      Object.keys(
        fullThrottleBudget({
          maxOutputTokens: 8192,
          contextWindow: 128000,
          thinkingEnabled: true,
          thinkingEffort: "medium",
        }),
      ),
    ).not.toContain("permission");
  });
});

describe("IF-05：审批生命周期（AppService）", () => {
  function approvalRequest() {
    return {
      workspaceId: "ws_approval",
      taskId: "task_approval",
      agentName: "Builder",
      toolName: "fs.write",
      target: ".ssh/config",
      risk: "high" as const,
      reason: "auto_risk：高风险操作必须人类确认",
    };
  }

  it("人工回执一次性消费：第二次回执返回 false", async () => {
    const service = makeService();
    const requests: RiskApprovalRequest[] = [];
    service.onRiskApproval((request) => requests.push(request));

    const pending = service.requestRiskApproval(approvalRequest());
    expect(requests).toHaveLength(1);
    expect(service.respondRiskApproval(requests[0].requestId, true)).toBe(true);
    await expect(pending).resolves.toEqual({ approved: true, outcome: "approved" });
    expect(service.respondRiskApproval(requests[0].requestId, true)).toBe(false);
  });

  it("超时按未批准解析，超时后不能再批准（刷新/重开会话不残留批准）", async () => {
    vi.useFakeTimers();
    const service = makeService();
    const requests: RiskApprovalRequest[] = [];
    service.onRiskApproval((request) => requests.push(request));

    const pending = service.requestRiskApproval(approvalRequest());
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RISK_APPROVAL_TIMEOUT_MS + 1);
    await expect(pending).resolves.toEqual({ approved: false, outcome: "timeout" });
    expect(service.respondRiskApproval(requests[0].requestId, true)).toBe(false);
  });

  it("没有 renderer 监听时仍按超时兜底（不静默放行）", async () => {
    vi.useFakeTimers();
    const service = makeService();
    const pending = service.requestRiskApproval(approvalRequest());
    await vi.advanceTimersByTimeAsync(RISK_APPROVAL_TIMEOUT_MS + 1);
    await expect(pending).resolves.toEqual({ approved: false, outcome: "timeout" });
  });
});
