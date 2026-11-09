import type { PermissionMode } from "../shared/types.js";

/**
 * DESIGN §15.2/§15.3：执行层权限门禁与风险分级（纯函数，可单测）。
 * 权限不是提示词约束——每次工具调用前由 ToolRegistry 硬检查；
 * 拒绝写 tool.denied 事件并回给模型。
 */

export type ToolRisk = "read" | "write" | "shell";

/** Tool Registry 风险标注：每个内置工具一档（未标注的工具按 write 处理）。 */
export const TOOL_RISK: Record<string, ToolRisk> = {
  "fs.list": "read",
  "fs.read": "read",
  "fs.search": "read",
  "fs.write": "write",
  "shell.run": "shell",
  "git.status": "read",
  "git.diff": "read",
  "task.list": "read",
  "task.get": "read",
  "task.complete": "write",
  "mailbox.send": "write",
  "mailbox.list": "read",
  "mailbox.read": "read",
  "board.post": "write",
  "board.list": "read",
  "memo.write": "write",
  "memo.search": "read",
};

export type RiskLevel = "low" | "medium" | "high";

/** workspace_write / auto_risk-low 允许的受限只读 shell 命令（前缀匹配，大小写不敏感）。 */
const READONLY_SHELL_PREFIXES = [
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "ls",
  "dir",
  "cat ",
  "type ",
  "head ",
  "tail ",
  "grep ",
  "rg ",
  "find ",
  "where ",
  "node --version",
  "node -v",
  "npm --version",
  "npm -v",
  "pnpm --version",
  "pnpm -v",
  "python --version",
  "echo ",
];

/**
 * shell 组合语法黑名单（t55 集成修复 IF-01）：只读白名单是前缀匹配，
 * 若命令带串联/管道/重定向/命令替换，`git status && rm -rf .` 或 `ls; rm -rf .`
 * 会被误判为低风险而在 workspace_write / auto_risk-low 下直接执行——
 * DESIGN §15.2 要求「任何可能越界的命令升级为审批」，这里一律拒绝。
 */
const SHELL_COMPOSITION_PATTERN = /[;&|<>`\r\n$]/;

export function isReadOnlyShell(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  if (!trimmed) return false;
  if (SHELL_COMPOSITION_PATTERN.test(trimmed)) return false;
  return READONLY_SHELL_PREFIXES.some((prefix) => {
    // 前缀必须落在词边界上：避免 `lsof` 被 `ls` 前缀命中。
    const normalized = prefix.trim();
    return trimmed === normalized || trimmed.startsWith(`${normalized} `);
  });
}

function toolRisk(name: string): ToolRisk {
  return TOOL_RISK[name] ?? "write";
}

/**
 * 敏感写入目标（t58 IF-08：策略层按「路径段」统一拦截，不依赖工具层 basename）。
 * 覆盖：.ssh/ · .aws/ · .gnupg/ · .kube/ · .docker/ 目录；dotenv 族（.env / .env.* / .envrc / .envrc.*）；
 * 私钥（id_rsa/id_dsa/id_ed25519/id_ecdsa 前缀、*.pem、*.key、*.p12、*.pfx、*.jks）；
 * credentials.json / known_hosts / authorized_keys / .netrc / .npmrc / .git-credentials / .pypirc；
 * .git/hooks/（git hooks）。按路径段匹配，避免只看 basename 漏掉 .ssh/config 这类文件。
 */
export function isSensitivePath(target: string): boolean {
  const segments = target.replace(/\\/g, "/").toLowerCase().split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (
      segment === ".ssh" ||
      segment === ".aws" ||
      segment === ".gnupg" ||
      segment === ".kube" ||
      segment === ".docker"
    ) {
      return true;
    }
    // t61：dotenv 族统一按路径段前缀判定（.env / .env.* / .envrc / .envrc.*），
    // 避免只覆盖 .env.* 而漏掉 .envrc、.envrc.local 这类 direnv 配置。
    if (
      segment === ".env" ||
      segment.startsWith(".env.") ||
      segment === ".envrc" ||
      segment.startsWith(".envrc.")
    ) {
      return true;
    }
    if (/^id_(rsa|dsa|ed25519|ecdsa)/.test(segment)) return true;
    if (
      segment.endsWith(".pem") ||
      segment.endsWith(".key") ||
      segment.endsWith(".p12") ||
      segment.endsWith(".pfx") ||
      segment.endsWith(".jks")
    ) {
      return true;
    }
    if (
      segment === "credentials.json" ||
      segment === "known_hosts" ||
      segment === "authorized_keys" ||
      segment === ".netrc" ||
      segment === ".npmrc" ||
      segment === ".git-credentials" ||
      segment === ".pypirc"
    ) {
      return true;
    }
    // git hooks 目录：.git/hooks/...
    if (segment === ".git" && segments[index + 1] === "hooks") return true;
  }
  return false;
}

export function isSensitiveWrite(name: string, args: unknown): boolean {
  if (name !== "fs.write") return false;
  const path = (args as { path?: unknown } | null)?.path;
  return typeof path === "string" && isSensitivePath(path);
}

/** §15.3 规则风险分级（路径、命令、目标）。 */
export function classifyRisk(name: string, args: unknown): RiskLevel {
  const risk = toolRisk(name);
  if (risk === "read") return "low";
  if (isSensitiveWrite(name, args)) return "high";
  if (risk === "shell") return isReadOnlyShell(String((args as { command?: unknown })?.command ?? ""))
    ? "low"
    : "high";
  return "medium"; // 工作区内写操作
}

export type PolicyAction = "allow" | "denied" | "risk_vote" | "human_confirm";

export type PolicyDecision = {
  action: PolicyAction;
  allowed: boolean;
  risk: RiskLevel;
  reason: string;
};

/** 每次工具调用前的硬门禁（不含 auto_risk 的投票执行，投票由执行层接手 risk_vote）。 */
export function policyCheck(
  permission: PermissionMode,
  name: string,
  args: unknown,
): PolicyDecision {
  const risk = classifyRisk(name, args);
  switch (permission) {
    case "read_only":
      if (risk === "low" && toolRisk(name) === "read") {
        return { action: "allow", allowed: true, risk, reason: "read_only 允许读操作" };
      }
      return {
        action: "denied",
        allowed: false,
        risk,
        reason: `read_only 拒绝${toolRisk(name) === "shell" ? " shell" : "写入"}操作：${name}`,
      };
    case "workspace_write": {
      // t58 IF-08：敏感路径写入在策略层统一拦截（不依赖工具层 basename；工具层检查保留为纵深防御）。
      if (isSensitiveWrite(name, args)) {
        return {
          action: "denied",
          allowed: false,
          risk: "high",
          reason: `workspace_write 拒绝敏感路径写入（.ssh/.aws/.gnupg/.env*/私钥/git hooks）：${
            String((args as { path?: unknown })?.path ?? name).slice(0, 80)
          }。如确需操作请切换 full_access（会写审计事件）`,
        };
      }
      if (risk === "high" && toolRisk(name) === "shell") {
        return {
          action: "denied",
          allowed: false,
          risk,
          reason: `workspace_write 仅允许受限只读 shell（如 git status/ls/cat），拒绝：${
            String((args as { command?: unknown })?.command ?? name).slice(0, 80)
          }`,
        };
      }
      return { action: "allow", allowed: true, risk, reason: "workspace_write 允许工作区内操作" };
    }
    case "full_access":
      return {
        action: "allow",
        allowed: true,
        risk,
        reason: risk === "high" ? "full_access 放行（已审计，高风险）" : "full_access 放行",
      };
    case "auto_risk":
      if (risk === "low") {
        return { action: "allow", allowed: true, risk, reason: "auto_risk：低风险自动放行" };
      }
      if (risk === "medium") {
        return {
          action: "risk_vote",
          allowed: false, // 由执行层完成快速投票后决定
          risk,
          reason: "auto_risk：中风险，发起快速评审投票",
        };
      }
      return {
        action: "human_confirm",
        allowed: false,
        risk,
        reason: "auto_risk：高风险操作必须人类确认，Agent 不能自行放行",
      };
    default:
      return { action: "denied", allowed: false, risk, reason: `unknown permission: ${permission}` };
  }
}

// ---------- Full Throttle（DESIGN §15.4） ----------

/** 参考 dsh-full-throttle：会话级高预算/no-holds-barred 系统提示注入。只改行为与预算，不碰权限。 */
export const FULL_THROTTLE_PROMPT = [
  "FULL THROTTLE MODE ENABLED.",
  "You are running with the user's explicit approval to use maximum effort and budget for this session.",
  "- Maximize reasoning depth and verification: check your work, consider alternatives, and prove correctness.",
  "- Do NOT shorten or simplify your output to save tokens; completeness and correctness come first.",
  "- Use the available output budget fully; prefer complete, production-quality deliverables over sketches.",
  "- When in doubt, verify with tools instead of guessing.",
  "This mode does NOT change your tool permissions, does not auto-approve any tool, and does not grant access beyond your current permission level.",
].join("\n");

export function withFullThrottle(systemPrompt: string): string {
  return `${systemPrompt}\n\n${FULL_THROTTLE_PROMPT}`;
}

/** 满血模式的执行层预算覆盖（不是权限）：输出预算翻倍、思考强度拉满、步数上限翻倍。 */
export function fullThrottleBudget(profile: {
  maxOutputTokens: number;
  contextWindow: number;
  thinkingEnabled: boolean;
  thinkingEffort: string;
}): {
  maxOutputTokens: number;
  reasoningEffort: string | undefined;
  maxStepsFactor: number;
} {
  return {
    maxOutputTokens: Math.min(profile.maxOutputTokens * 2, Math.max(profile.maxOutputTokens, 1_000_000)),
    reasoningEffort: profile.thinkingEnabled ? "max" : undefined,
    maxStepsFactor: 2,
  };
}
