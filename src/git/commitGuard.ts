import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { GitExec } from "./gitExec.js";

const SENSITIVE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "id_rsa",
  "id_ed25519",
  "credentials.json",
]);
const SENSITIVE_DIRS = [".ssh", ".aws", ".deer", ".deer-git", "node_modules"];
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
];

export interface GuardResult {
  ok: boolean;
  blocked: boolean;
  reason?: string;
  files: string[];
}

function isSensitive(relative: string): boolean {
  const normalized = relative.replace(/\\/g, "/");
  const base = path.basename(normalized).toLowerCase();
  if (SENSITIVE_NAMES.has(base)) return true;
  if (base.startsWith(".env.") && base !== ".env.example") return true;
  if (/\.(pem|key|p12|pfx)$/i.test(base)) return true;
  const parts = normalized.split("/");
  return parts.some((part) => SENSITIVE_DIRS.includes(part));
}

/**
 * Pre-commit guard: inspect staged/worktree files before `git add -A`.
 * Rejects sensitive paths, oversized/binary files and obvious secrets.
 */
export class CommitGuard {
  constructor(private readonly git: GitExec) {}

  /** 单个文件的守卫检查；返回 null 表示通过，否则为拒绝原因。 */
  private checkPath(worktreePath: string, relative: string): string | null {
    const normalized = relative.replace(/\\/g, "/");
    if (isSensitive(normalized)) {
      return `sensitive file: ${normalized}`;
    }
    try {
      const filePath = path.join(worktreePath, normalized);
      const stat = statSync(filePath);
      if (stat.isFile() && stat.size > 5 * 1024 * 1024) {
        return `file too large: ${normalized}`;
      }
      if (stat.isFile() && stat.size <= 512 * 1024 && !/\.(png|jpg|jpeg|gif|webp|zip|gz|pdf|woff2?)$/i.test(normalized)) {
        const content = readFileSync(filePath, "utf8");
        if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
          return `secret-looking content: ${normalized}`;
        }
      }
    } catch {
      // deleted files can fail stat; fine
    }
    return null;
  }

  async scan(worktreePath: string): Promise<GuardResult> {
    const status = await this.git.run(["status", "--porcelain", "-z"], { cwd: worktreePath });
    if (status.code !== 0) {
      return { ok: false, blocked: true, reason: "cannot read git status", files: [] };
    }
    const entries = status.stdout.split("\0").filter(Boolean);
    const files: string[] = [];
    for (const entry of entries) {
      const relative = entry.length > 3 ? entry.slice(3) : "";
      if (!relative) continue;
      files.push(relative);
      const reason = this.checkPath(worktreePath, relative);
      if (reason) return { ok: false, blocked: true, reason, files };
    }
    return { ok: true, blocked: false, files };
  }

  /**
   * t352 G1：只扫描给定路径（用户已暂存的文件），不阻塞工作区里
   * 未暂存的问题文件。返回 null 表示全部通过，否则为第一个拒绝原因。
   */
  checkPaths(worktreePath: string, paths: string[]): string | null {
    for (const relative of paths) {
      const reason = this.checkPath(worktreePath, relative);
      if (reason) return reason;
    }
    return null;
  }
}
