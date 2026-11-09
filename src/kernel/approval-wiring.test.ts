import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RiskApprovalRequest } from "../shared/types.js";
import { RISK_APPROVAL_TIMEOUT_MS } from "../shared/approval.js";
import { AppService } from "./service.js";
import { Store } from "./store.js";
import { createBuiltinTools, ToolRegistry, type ToolContext } from "./tools.js";

/**
 * t60 集成回归：主进程审批评审生命周期（AppService）与执行层门禁（ToolRegistry）
 * 的端到端连通。approval.test.ts 分别用 stub 覆盖两侧；本文件验证真实接线：
 * - 批准经 service.respondRiskApproval 回执后只执行该次调用，第二次调用重新请求；
 * - 120s 超时由服务端按未批准解析，工具层写 human_required + tool.denied 且不落盘；
 * - 已消费的 requestId 不可重放（防止刷新/重开残留批准）。
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  vi.useRealTimers();
});

function makeService(): AppService {
  const root = mkdtempSync(path.join(os.tmpdir(), "deer-approval-wiring-"));
  const service = new AppService(path.join(root, "data"));
  cleanups.push(() => {
    service.close();
    rmSync(root, { recursive: true, force: true });
  });
  return service;
}

/** 与 service.runTask 的注入方式一致：auto_risk + 主进程 requestRiskApproval。 */
function makeContext(worktreePath: string, service: AppService): ToolContext {
  const store = new Store(":memory:");
  cleanups.push(() => store.close());
  return {
    workspaceId: "ws_wiring",
    workspacePath: worktreePath,
    worktreePath,
    taskId: "task_wiring",
    runId: "run_wiring",
    agentId: "agent_wiring",
    agentName: "Builder",
    store,
    permission: "auto_risk",
    requestApproval: (input) =>
      service.requestRiskApproval({
        workspaceId: "ws_wiring",
        taskId: "task_wiring",
        agentName: "Builder",
        ...input,
      }),
  };
}

async function waitForRequest(requests: RiskApprovalRequest[], count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (requests.length < count) {
    if (Date.now() > deadline) throw new Error("approval request not emitted");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("t60 集成：AppService 审批 ↔ ToolRegistry 端到端", () => {
  it("批准单次生效：第一次批准执行，第二次重新请求并按拒绝处理", async () => {
    const service = makeService();
    const wsRoot = mkdtempSync(path.join(os.tmpdir(), "deer-wiring-ws-"));
    cleanups.push(() => rmSync(wsRoot, { recursive: true, force: true }));
    const requests: RiskApprovalRequest[] = [];
    service.onRiskApproval((request) => requests.push(request));
    const ctx = makeContext(wsRoot, service);
    const registry = new ToolRegistry().registerAll(createBuiltinTools());

    const first = registry.execute("fs.write", { path: ".ssh/config", content: "Host *\n" }, ctx);
    await waitForRequest(requests, 1);
    expect(requests[0].toolName).toBe("fs.write");
    expect(requests[0].risk).toBe("high");
    expect(service.respondRiskApproval(requests[0].requestId, true)).toBe(true);
    expect((await first).ok).toBe(true);
    expect(existsSync(path.join(wsRoot, ".ssh", "config"))).toBe(true);

    // 第二次同目标：必须重新请求审批（批准不缓存、不持久）
    const second = registry.execute("fs.write", { path: ".ssh/config", content: "Host *\n" }, ctx);
    await waitForRequest(requests, 2);
    expect(requests[1].requestId).not.toBe(requests[0].requestId);
    expect(service.respondRiskApproval(requests[1].requestId, false)).toBe(true);
    const denied = await second;
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("人类已拒绝");
    // 已消费的 requestId 不能重放
    expect(service.respondRiskApproval(requests[0].requestId, true)).toBe(false);

    const decisions = ctx.store
      .listEvents({ aggregateId: "task_wiring" })
      .filter((event) => event.type === "permission.risk_vote")
      .map((event) => (event.payload as { decision?: string }).decision);
    expect(decisions).toContain("human_approved");
    expect(decisions).toContain("human_denied");
  });

  it("超时：服务端按未批准解析，工具层写 human_required 且不执行", async () => {
    vi.useFakeTimers();
    const service = makeService();
    const wsRoot = mkdtempSync(path.join(os.tmpdir(), "deer-wiring-ws2-"));
    cleanups.push(() => rmSync(wsRoot, { recursive: true, force: true }));
    const requests: RiskApprovalRequest[] = [];
    service.onRiskApproval((request) => requests.push(request));
    const ctx = makeContext(wsRoot, service);
    const registry = new ToolRegistry().registerAll(createBuiltinTools());

    const pending = registry.execute("fs.write", { path: ".env", content: "A=1" }, ctx);
    await vi.advanceTimersByTimeAsync(RISK_APPROVAL_TIMEOUT_MS + 5);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("超时");
    expect(existsSync(path.join(wsRoot, ".env"))).toBe(false);
    // 超时后回执必须失效，不允许补批准
    expect(service.respondRiskApproval(requests[0].requestId, true)).toBe(false);
    const events = ctx.store.listEvents({ aggregateId: "task_wiring" });
    expect(
      events.some(
        (event) =>
          event.type === "permission.risk_vote" &&
          (event.payload as { decision?: string }).decision === "human_required",
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "tool.denied")).toBe(true);
  });
});
