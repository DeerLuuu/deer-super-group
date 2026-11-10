import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { BoardKind, MessageKind, PermissionMode } from "../shared/types.js";
import type { Store } from "./store.js";
import { isSensitivePath, isSensitiveWrite, policyCheck } from "./permission.js";

/** t58 IF-05：高风险调用的人类审批结果（单次生效；超时视为未批准）。 */
export type RiskApprovalOutcome = {
  approved: boolean;
  outcome: "approved" | "denied" | "timeout";
};

const execFileAsync = promisify(execFile);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-electron",
  "build",
  ".next",
  ".turbo",
  ".deer",
  "coverage",
]);

const DENIED_READ = new Set([".env", ".env.local", ".env.production", "id_rsa", "id_ed25519", "credentials.json"]);

export interface ToolContext {
  workspaceId: string;
  workspacePath: string;
  worktreePath: string;
  taskId: string;
  runId: string;
  agentId: string;
  agentName: string;
  store: Store;
  signal?: AbortSignal;
  onEvent?: (type: string, payload: unknown) => void;
  /** DESIGN §15：执行层权限（每次工具调用前硬门禁）。 */
  permission?: PermissionMode;
  /**
   * DESIGN §15.3 / t58 IF-05：auto_risk 高风险时请求人类审批（单次生效）。
   * 由主进程注入（renderer 弹窗回执）；Agent 无自行批准路径——该回调只走人类 UI 链路。
   */
  requestApproval?: (input: {
    toolName: string;
    target: string;
    risk: "low" | "medium" | "high";
    reason: string;
  }) => Promise<RiskApprovalOutcome>;
}

/** 审批弹窗展示的「目标」：写路径 / shell 命令 / 其余参数摘要。 */
export function describeTarget(name: string, args: unknown): string {
  if (name === "fs.write") {
    const target = (args as { path?: unknown })?.path;
    return typeof target === "string" ? target : name;
  }
  if (name === "shell.run") {
    const command = (args as { command?: unknown })?.command;
    return typeof command === "string" ? command.slice(0, 160) : name;
  }
  try {
    return JSON.stringify(args ?? {}).slice(0, 160);
  } catch {
    return name;
  }
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: unknown, ctx: ToolContext): Promise<unknown>;
}

/**
 * t171：工具可用性由上下文策略决定，而不是由成员角色决定。
 * - chat：没有任务投影，不能调用 task.complete；
 * - task：完整工具集；
 * - 所有成员（包括 Router）走同一 registry + permission/approval 门禁。
 */
export interface ToolPolicy {
  mode: "chat" | "task";
  taskId?: string | null;
}

export function toolAllowedByPolicy(
  tool: Pick<ToolDefinition, "name">,
  policy: ToolPolicy | undefined,
): boolean {
  if (!policy) return true;
  if (policy.mode === "chat" && tool.name === "task.complete") return false;
  if (tool.name === "task.complete" && !policy.taskId) return false;
  return true;
}

export interface ToolResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: ToolDefinition[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  list(
    policy?: ToolPolicy,
  ): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return [...this.tools.values()]
      .filter((tool) => toolAllowedByPolicy(tool, policy))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
  }

  async execute(
    name: string,
    args: unknown,
    ctx: ToolContext,
    policy?: ToolPolicy,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `unknown tool: ${name}` };
    if (!toolAllowedByPolicy(tool, policy)) {
      return { ok: false, error: `tool not available in ${policy?.mode ?? "current"} context: ${name}` };
    }
    // DESIGN §15.2：权限是执行层硬门禁，每次工具调用前检查。
    if (ctx.permission) {
      const decision = policyCheck(ctx.permission, name, args);
      if (decision.action === "risk_vote") {
        // §15.3：中风险 → 快速评审投票（规则评审者，Agent 不能给自己放行）
        const vote = await this.runQuickVote(name, args, ctx, decision.risk);
        if (!vote.allowed) {
          this.recordDenied(ctx, name, args, vote.reason, decision.risk, vote.event);
          return { ok: false, error: vote.reason };
        }
        // t55 集成修复 IF-02：投票放行也要写 permission.risk_vote（原实现只在拒绝时写）。
        this.recordRiskDecision(ctx, name, args, decision.risk, "approved", vote.event);
      } else if (decision.action === "human_confirm") {
        // t58 IF-05（DESIGN §15.3 第 4 条）：高风险 → 人类审批 UI（单次生效）。
        let result: RiskApprovalOutcome = { approved: false, outcome: "timeout" };
        if (ctx.requestApproval) {
          try {
            const outcome = await ctx.requestApproval({
              toolName: name,
              target: describeTarget(name, args),
              risk: decision.risk,
              reason: decision.reason,
            });
            // 防御：回调返回异常形状时按未批准处理，绝不默认放行。
            if (outcome && typeof outcome.approved === "boolean") result = outcome;
          } catch {
            result = { approved: false, outcome: "timeout" };
          }
        }
        if (result.approved) {
          // 批准仅对该次调用生效：写审计后放行本次执行；不改变 Agent 权限、不产生持久批准。
          this.recordRiskDecision(ctx, name, args, decision.risk, "approved", {
            decision: "human_approved",
            target: describeTarget(name, args),
            voters: ["human"],
          });
        } else {
          const decisionLabel =
            result.outcome === "denied" ? "human_denied" : "human_required";
          this.recordRiskDecision(ctx, name, args, decision.risk, "rejected", {
            decision: decisionLabel,
            target: describeTarget(name, args),
          });
          this.recordDenied(
            ctx,
            name,
            args,
            result.outcome === "denied"
              ? "auto_risk：人类已拒绝该高风险操作（单次拒绝，重试会再次请求审批）"
              : "auto_risk：高风险操作等待人类批准超时，未执行（可重试以再次请求审批）",
            decision.risk,
          );
          return {
            ok: false,
            error:
              result.outcome === "denied"
                ? "auto_risk：人类已拒绝该高风险操作"
                : "auto_risk：高风险操作需人类确认，等待批准超时未执行",
          };
        }
      } else if (!decision.allowed) {
        // t55 集成修复 IF-02：auto_risk 高风险（human_confirm）也要留下可审计的风险决策事件；
        // read_only/workspace_write 的拒绝仍只写 tool.denied（permission.risk_vote 仅用于风险分级结果）。
        if (ctx.permission === "auto_risk") {
          this.recordRiskDecision(ctx, name, args, decision.risk, "human_required");
        }
        this.recordDenied(ctx, name, args, decision.reason, decision.risk);
        return { ok: false, error: decision.reason };
      } else if (ctx.permission === "auto_risk") {
        // §15.3：低风险自动放行也要写审计事件（记录理由）
        ctx.store.appendEvent({
          aggregateType: "task",
          aggregateId: ctx.taskId,
          type: "permission.risk_vote",
          actor: `agent:${ctx.agentName}`,
          payload: {
            tool: name,
            risk: decision.risk,
            voters: [],
            votes: [],
            decision: "auto_allowed",
            reason: decision.reason,
          },
        });
      }
      // t58 IF-08：full_access 仍放行敏感/高风险操作，但必须留下可审计的风险事件。
      // （workspace_write 在策略层拒绝；auto_risk 走人类审批；这里只补 full_access 的审计。）
      if (ctx.permission === "full_access" && decision.risk === "high") {
        this.recordRiskDecision(ctx, name, args, decision.risk, "approved", {
          decision: "full_access_allowed",
          reason: decision.reason,
        });
      }
    }
    try {
      return { ok: true, value: await tool.execute(args, ctx) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** §15.3 中风险快速评审：Router + 一名其他成员的规则投票，多数放行；无 quorum 升级人类。 */
  private async runQuickVote(
    name: string,
    args: unknown,
    ctx: ToolContext,
    risk: "low" | "medium" | "high",
  ): Promise<{ allowed: boolean; reason: string; event?: unknown }> {
    const agents = ctx.store.listAgents(ctx.workspaceId);
    const voters = [
      agents.find((agent) => agent.isRouter),
      agents.find((agent) => !agent.isRouter && agent.id !== ctx.agentId),
    ].filter((agent): agent is NonNullable<typeof agent> => Boolean(agent));
    if (voters.length < 2) {
      return {
        allowed: false,
        reason: "auto_risk：中风险需要 ≥2 名评审者，当前无评审 quorum，升级为人类确认（请人工执行或切换权限模式）",
        event: { decision: "human_required", voters: voters.map((v) => v.name), votes: [] },
      };
    }
    // 规则评审者：敏感写入投反对，其余工作区内写操作投赞成（可审计、可解释）
    const votes = voters.map((voter) => ({
      voter: voter.name,
      vote: isSensitiveWrite(name, args) ? "reject" : "approve",
    }));
    const approves = votes.filter((item) => item.vote === "approve").length;
    const approved = approves > votes.length / 2;
    const reason = approved
      ? `auto_risk：中风险经快速评审投票放行（${approves}/${votes.length} 赞成）`
      : "auto_risk：中风险评审投票未过半数，拒绝执行";
    return {
      allowed: approved,
      reason,
      event: {
        tool: name,
        risk,
        voters: votes.map((item) => item.voter),
        votes,
        decision: approved ? "approved" : "rejected",
      },
    };
  }

  /**
   * t55 集成修复 IF-02（DESIGN §15.3 第 5 条）：把风险决策写 permission.risk_vote。
   * 不阻断执行：审计写失败只静默降级。
   */
  private recordRiskDecision(
    ctx: ToolContext,
    name: string,
    args: unknown,
    risk: "low" | "medium" | "high",
    decision: "approved" | "human_required" | "rejected",
    voteEvent?: unknown,
  ): void {
    try {
      ctx.store.appendEvent({
        aggregateType: "task",
        aggregateId: ctx.taskId,
        type: "permission.risk_vote",
        actor: `agent:${ctx.agentName}`,
        payload: {
          tool: name,
          risk,
          decision,
          result: decision === "approved" ? "allowed" : "denied",
          ...(voteEvent && typeof voteEvent === "object"
            ? (voteEvent as Record<string, unknown>)
            : {}),
          arguments: JSON.stringify(args ?? {}).slice(0, 300),
        },
      });
    } catch {
      // 审计事件写入失败不阻断判定路径
    }
  }

  /** 拒绝写 tool.denied 事件（任务审计流），并回给模型可读的原因。 */
  private recordDenied(
    ctx: ToolContext,
    name: string,
    args: unknown,
    reason: string,
    risk: "low" | "medium" | "high",
    voteEvent?: unknown,
  ): void {
    const payload = {
      tool: name,
      permission: ctx.permission,
      risk,
      reason,
      arguments: JSON.stringify(args ?? {}).slice(0, 400),
      vote: voteEvent ?? null,
    };
    ctx.onEvent?.("tool.denied", payload);
    try {
      ctx.store.appendEvent({
        aggregateType: "task",
        aggregateId: ctx.taskId,
        type: "tool.denied",
        actor: `agent:${ctx.agentName}`,
        payload,
      });
      if (voteEvent) {
        ctx.store.appendEvent({
          aggregateType: "task",
          aggregateId: ctx.taskId,
          type: "permission.risk_vote",
          actor: `agent:${ctx.agentName}`,
          payload: { ...(voteEvent as Record<string, unknown>), tool: name, risk },
        });
      }
    } catch {
      // 事件写入失败不阻断拒绝路径
    }
  }
}

function resolveInside(root: string, relative: string): string {
  if (relative.includes("\0")) throw new Error("invalid path");
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const a = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
  const b = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  if (b !== a && !b.startsWith(`${a}${path.sep}`)) {
    throw new Error(`path escapes workspace: ${relative}`);
  }
  return resolved;
}

async function listDir(root: string, relative: string, depth: number) {
  const target = resolveInside(root, relative);
  const entries = await fs.readdir(target, { withFileTypes: true });
  const result: Array<{ path: string; type: "file" | "dir"; size?: number }> = [];
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = path.posix.join(relative === "." ? "" : relative, entry.name);
    result.push({
      path: rel,
      type: entry.isDirectory() ? "dir" : "file",
      size: entry.isFile() ? (await fs.stat(path.join(target, entry.name))).size : undefined,
    });
  }
  if (depth > 1) {
    for (const entry of result.filter((item) => item.type === "dir")) {
      try {
        result.push(...(await listDir(root, entry.path, depth - 1)));
      } catch {
        // ignore unreadable directories
      }
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

async function* walkFiles(root: string, relative = ".", maxFiles = 800): AsyncGenerator<string> {
  let count = 0;
  const stack = [relative];
  while (stack.length) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(resolveInside(root, current), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const rel = current === "." ? entry.name : `${current}/${entry.name}`;
      if (entry.isDirectory()) stack.push(rel);
      else if (entry.isFile()) {
        yield rel;
        count += 1;
        if (count >= maxFiles) return;
      }
    }
  }
}

const fsList: ToolDefinition = {
  name: "fs.list",
  description: "List files and directories inside the working directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path relative to the working directory." },
      depth: { type: "number", description: "1-3 levels of recursion." },
    },
  },
  async execute(args, ctx) {
    const parsed = z
      .object({ path: z.string().default("."), depth: z.number().int().min(1).max(3).default(1) })
      .parse(args ?? {});
    return listDir(ctx.worktreePath, parsed.path, parsed.depth);
  },
};

const fsRead: ToolDefinition = {
  name: "fs.read",
  description: "Read a UTF-8 text file inside the working directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "number", description: "1-based first line." },
      limit: { type: "number", description: "Max lines, default 400." },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const parsed = z
      .object({
        path: z.string(),
        offset: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(2000).default(400),
      })
      .parse(args);
    // t58 IF-08：工具层纵深防御不再只看 basename——.ssh/config 这类路径同样拒绝读取。
    if (
      DENIED_READ.has(path.basename(parsed.path).toLowerCase()) ||
      isSensitivePath(parsed.path)
    ) {
      throw new Error(`refusing to read sensitive file: ${parsed.path}`);
    }
    const target = resolveInside(ctx.worktreePath, parsed.path);
    const stat = await fs.stat(target);
    if (stat.size > 2_000_000) throw new Error("file too large (>2MB)");
    const raw = await fs.readFile(target, "utf8");
    if (raw.includes("\0")) throw new Error("binary file is not supported");
    const lines = raw.split(/\r?\n/);
    const selected = lines.slice(parsed.offset - 1, parsed.offset - 1 + parsed.limit);
    return {
      path: parsed.path,
      totalLines: lines.length,
      content: selected.map((line, index) => `${parsed.offset + index}: ${line}`).join("\n"),
      truncated: parsed.offset - 1 + parsed.limit < lines.length,
    };
  },
};

const fsWrite: ToolDefinition = {
  name: "fs.write",
  description: "Create or replace a UTF-8 text file inside the working directory.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
  async execute(args, ctx) {
    const parsed = z.object({ path: z.string(), content: z.string() }).parse(args);
    // t58 IF-08：敏感路径写由策略层统一裁决——
    // workspace_write 直接拒绝；auto_risk 高风险走人类审批（批准后可写）；full_access 放行并审计。
    // 工具层仅在「无权限上下文 / read_only / workspace_write」时做纵深防御（不再只靠 basename），
    // 避免与 full_access / 已批准审批的放行语义冲突。
    const sensitivePath =
      DENIED_READ.has(path.basename(parsed.path).toLowerCase()) || isSensitivePath(parsed.path);
    const toolGateEnforced =
      ctx.permission === undefined ||
      ctx.permission === "read_only" ||
      ctx.permission === "workspace_write";
    if (sensitivePath && toolGateEnforced) {
      throw new Error(`refusing to write sensitive file: ${parsed.path}`);
    }
    const target = resolveInside(ctx.worktreePath, parsed.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, parsed.content, "utf8");
    return { path: parsed.path, bytes: Buffer.byteLength(parsed.content, "utf8") };
  },
};

const fsSearch: ToolDefinition = {
  name: "fs.search",
  description: "Search text files for a literal string and return matching lines.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, path: { type: "string" }, limit: { type: "number" } },
    required: ["query"],
  },
  async execute(args, ctx) {
    const parsed = z
      .object({
        query: z.string().min(1),
        path: z.string().default("."),
        limit: z.number().int().min(1).max(100).default(30),
      })
      .parse(args);
    const matches: Array<{ path: string; line: number; text: string }> = [];
    for await (const file of walkFiles(ctx.worktreePath, parsed.path, 500)) {
      let raw: string;
      try {
        const stat = await fs.stat(resolveInside(ctx.worktreePath, file));
        if (stat.size > 1_000_000) continue;
        raw = await fs.readFile(resolveInside(ctx.worktreePath, file), "utf8");
      } catch {
        continue;
      }
      if (raw.includes("\0")) continue;
      const lines = raw.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].includes(parsed.query)) {
          matches.push({ path: file, line: i + 1, text: lines[i].slice(0, 300) });
          if (matches.length >= parsed.limit) return matches;
        }
      }
    }
    return matches;
  },
};

const shellRun: ToolDefinition = {
  name: "shell.run",
  description: "Run a shell command in the working directory. Returns exit code, stdout and stderr.",
  parameters: {
    type: "object",
    properties: { command: { type: "string" }, timeoutMs: { type: "number" } },
    required: ["command"],
  },
  async execute(args, ctx) {
    const parsed = z
      .object({
        command: z.string().min(1),
        timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
      })
      .parse(args);
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "powershell.exe" : "/bin/bash";
    const shellArgs = isWindows
      ? ["-NoProfile", "-NonInteractive", "-Command", parsed.command]
      : ["-lc", parsed.command];
    const env = {
      PATH: process.env.PATH,
      Path: process.env.Path,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      SystemRoot: process.env.SystemRoot,
      ComSpec: process.env.ComSpec,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      CI: "1",
      TERM: "dumb",
    };

    return await new Promise((resolve) => {
      const child = spawn(shell, shellArgs, {
        cwd: ctx.worktreePath,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const cap = 200_000;
      const append = (current: string, chunk: Buffer) =>
        current.length >= cap ? current : current + chunk.toString("utf8");

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
        if (stdout.length >= cap) child.kill();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
        if (stderr.length >= cap) child.kill();
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, parsed.timeoutMs);
      const onAbort = () => child.kill();
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      child.on("close", (code) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        resolve({
          exitCode: code ?? -1,
          stdout: stdout.slice(0, cap),
          stderr: stderr.slice(0, cap),
          timedOut,
        });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        resolve({ exitCode: -1, stdout, stderr: `${stderr}\n${error.message}`, timedOut });
      });
    });
  },
};

const gitStatus: ToolDefinition = {
  name: "git.status",
  description: "Show git status for the working directory.",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx) {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-b"], {
      cwd: ctx.worktreePath,
      maxBuffer: 1_000_000,
    });
    return { status: stdout };
  },
};

const gitDiff: ToolDefinition = {
  name: "git.diff",
  description: "Show git diff (unstaged or staged) for the working directory.",
  parameters: { type: "object", properties: { staged: { type: "boolean" } } },
  async execute(args, ctx) {
    const parsed = z.object({ staged: z.boolean().default(false) }).parse(args ?? {});
    const { stdout } = await execFileAsync(
      "git",
      ["diff", ...(parsed.staged ? ["--cached"] : [])],
      { cwd: ctx.worktreePath, maxBuffer: 2_000_000 },
    );
    return { diff: stdout.slice(0, 150_000), truncated: stdout.length > 150_000 };
  },
};

const taskList: ToolDefinition = {
  name: "task.list",
  description: "List the tasks in this workspace with status and dependencies.",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx) {
    return ctx.store.listTasks(ctx.workspaceId).map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      ownerId: task.ownerId,
      dependsOn: task.dependsOn,
      summary: task.summary,
    }));
  },
};

const taskGet: ToolDefinition = {
  name: "task.get",
  description: "Read a task's details.",
  parameters: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
  async execute(args, ctx) {
    const parsed = z.object({ taskId: z.string() }).parse(args);
    const task = ctx.store.getTask(parsed.taskId);
    if (!task) throw new Error(`task not found: ${parsed.taskId}`);
    return task;
  },
};

const taskComplete: ToolDefinition = {
  name: "task.complete",
  description:
    "Mark the current task complete and attach a structured summary. Call this when the work is done.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string" },
      changes: { type: "array", items: { type: "string" } },
      files: { type: "array", items: { type: "string" } },
      tests: {
        type: "array",
        items: {
          type: "object",
          properties: {
            command: { type: "string" },
            status: { type: "string", enum: ["passed", "failed", "skipped"] },
          },
        },
      },
      decisions: { type: "array", items: { type: "string" } },
      risks: { type: "array", items: { type: "string" } },
      openQuestions: { type: "array", items: { type: "string" } },
    },
    required: ["summary"],
  },
  async execute(args, ctx) {
    const parsed = z
      .object({
        summary: z.string().min(1),
        changes: z.array(z.string()).default([]),
        files: z.array(z.string()).default([]),
        tests: z
          .array(z.object({ command: z.string(), status: z.enum(["passed", "failed", "skipped"]) }))
          .default([]),
        decisions: z.array(z.string()).default([]),
        risks: z.array(z.string()).default([]),
        openQuestions: z.array(z.string()).default([]),
      })
      .parse(args);
    const task = ctx.store.getTask(ctx.taskId);
    if (!task) throw new Error(`task not found: ${ctx.taskId}`);
    ctx.store.updateTask(ctx.taskId, {
      status: "done",
      summary: parsed.summary,
      endedAt: new Date().toISOString(),
    });
    ctx.store.saveSummary({
      taskId: ctx.taskId,
      runId: ctx.runId,
      goal: task.title,
      changes: parsed.changes,
      files: parsed.files,
      tests: parsed.tests,
      decisions: parsed.decisions,
      risks: parsed.risks,
      openQuestions: parsed.openQuestions,
    });
    ctx.store.appendEvent({
      aggregateType: "task",
      aggregateId: ctx.taskId,
      type: "task.summary",
      actor: `agent:${ctx.agentName}`,
      payload: parsed,
    });
    return { completed: true, summary: parsed.summary };
  },
};

const mailboxSend: ToolDefinition = {
  name: "mailbox.send",
  description: "Send an internal mailbox message to another team member or the Router.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "array", items: { type: "string" } },
      subject: { type: "string" },
      body: { type: "string" },
      kind: { type: "string", enum: ["request", "report", "question", "decision", "artifact", "review"] },
    },
    required: ["to", "subject", "body"],
  },
  async execute(args, ctx) {
    const parsed = z
      .object({
        to: z.array(z.string()).min(1),
        subject: z.string().min(1),
        body: z.string().min(1),
        kind: z
          .enum(["request", "report", "question", "decision", "artifact", "review"])
          .default("report"),
      })
      .parse(args);
    const message = ctx.store.addMessage({
      workspaceId: ctx.workspaceId,
      from: ctx.agentName,
      to: parsed.to,
      kind: parsed.kind as MessageKind,
      subject: parsed.subject,
      body: parsed.body,
      refs: [`task:${ctx.taskId}`],
    });
    return { sent: true, messageId: message.id };
  },
};

const mailboxList: ToolDefinition = {
  name: "mailbox.list",
  description: "List recent mailbox messages in this workspace.",
  parameters: { type: "object", properties: { limit: { type: "number" } } },
  async execute(args, ctx) {
    const parsed = z.object({ limit: z.number().int().min(1).max(100).default(20) }).parse(args ?? {});
    return ctx.store.listMessages(ctx.workspaceId, parsed.limit).map((message) => ({
      id: message.id,
      from: message.from,
      to: message.to,
      kind: message.kind,
      subject: message.subject,
      createdAt: message.createdAt,
    }));
  },
};

const mailboxRead: ToolDefinition = {
  name: "mailbox.read",
  description: "Read one mailbox message by id.",
  parameters: { type: "object", properties: { messageId: { type: "string" } }, required: ["messageId"] },
  async execute(args, ctx) {
    const parsed = z.object({ messageId: z.string() }).parse(args);
    const message = ctx.store
      .listMessages(ctx.workspaceId, 500)
      .find((item) => item.id === parsed.messageId);
    if (!message) throw new Error(`message not found: ${parsed.messageId}`);
    return message;
  },
};

const boardPost: ToolDefinition = {
  name: "board.post",
  description: "Post an atomic entry to an expert blackboard.",
  parameters: {
    type: "object",
    properties: {
      board: { type: "string" },
      kind: {
        type: "string",
        enum: ["fact", "decision", "question", "warning", "artifact", "link"],
      },
      content: { type: "string" },
      refs: { type: "array", items: { type: "string" } },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      pinned: { type: "boolean" },
    },
    required: ["board", "kind", "content"],
  },
  async execute(args, ctx) {
    const parsed = z
      .object({
        board: z.string().min(1),
        kind: z.enum(["fact", "decision", "question", "warning", "artifact", "link"]),
        content: z.string().min(1),
        refs: z.array(z.string()).default([]),
        confidence: z.enum(["low", "medium", "high"]).default("medium"),
        pinned: z.boolean().default(false),
      })
      .parse(args);
    return ctx.store.postBoard({
      workspaceId: ctx.workspaceId,
      board: parsed.board,
      author: ctx.agentName,
      kind: parsed.kind as BoardKind,
      content: parsed.content,
      refs: parsed.refs,
      confidence: parsed.confidence,
      pinned: parsed.pinned,
    });
  },
};

const boardList: ToolDefinition = {
  name: "board.list",
  description: "List recent entries on a blackboard.",
  parameters: {
    type: "object",
    properties: { board: { type: "string" }, limit: { type: "number" } },
    required: ["board"],
  },
  async execute(args, ctx) {
    const parsed = z
      .object({ board: z.string(), limit: z.number().int().min(1).max(100).default(30) })
      .parse(args);
    return ctx.store.listBoard(ctx.workspaceId, parsed.board, parsed.limit).map((entry) => ({
      id: entry.id,
      author: entry.author,
      kind: entry.kind,
      content: entry.content,
      confidence: entry.confidence,
      pinned: entry.pinned,
      createdAt: entry.createdAt,
    }));
  },
};

const memoWrite: ToolDefinition = {
  name: "memo.write",
  description: "Write a private memo (lesson, failure, shortcut, preference) for this agent.",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["lesson", "failure", "shortcut", "preference"] },
      content: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["kind", "content"],
  },
  async execute(args, ctx) {
    const parsed = z
      .object({
        kind: z.enum(["lesson", "failure", "shortcut", "preference"]),
        content: z.string().min(1),
        tags: z.array(z.string()).default([]),
      })
      .parse(args);
    return ctx.store.addMemo({
      workspaceId: ctx.workspaceId,
      agentId: ctx.agentId,
      kind: parsed.kind,
      content: parsed.content,
      tags: parsed.tags,
    });
  },
};

const memoSearch: ToolDefinition = {
  name: "memo.search",
  description: "Search this agent's memos for a literal string.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "number" } },
    required: ["query"],
  },
  async execute(args, ctx) {
    const parsed = z
      .object({ query: z.string().min(1), limit: z.number().int().min(1).max(50).default(10) })
      .parse(args);
    return ctx.store.searchMemos(ctx.workspaceId, parsed.query, parsed.limit);
  },
};

export function createBuiltinTools(): ToolDefinition[] {
  return [
    fsList,
    fsRead,
    fsWrite,
    fsSearch,
    shellRun,
    gitStatus,
    gitDiff,
    taskList,
    taskGet,
    taskComplete,
    mailboxSend,
    mailboxList,
    mailboxRead,
    boardPost,
    boardList,
    memoWrite,
    memoSearch,
  ];
}
