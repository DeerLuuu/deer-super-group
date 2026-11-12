import { z } from "zod";
import type { GitResult } from "./types.js";

/**
 * t352 G1：Git Graph 写闭环（stage/unstage/commit/.gitignore）的共享类型。
 * 全部为本地仓库操作：无 push / force / remote。
 */

export interface GitWritePathsResult {
  /** 实际生效的仓库相对路径（已验证）。 */
  paths: string[];
}

export interface GitCommitRename {
  oldPath: string;
  newPath: string;
}

export interface GitCommitCreateResult {
  sha: string;
  branch: string | null;
  /** 本次提交包含的文件（仓库相对路径）；R/C 同时含旧路径与新路径。 */
  files: string[];
  /** R/C 记录：CommitGuard 必须同时检查旧路径与新路径。 */
  renames?: GitCommitRename[];
  title: string;
}

export interface GitIgnorePreview {
  /** .gitignore 是否已存在。 */
  exists: boolean;
  /** 现有内容（不存在为空串）。 */
  existing: string;
  /** 将追加的缺失模板行（已存在则不重复）。 */
  additions: string[];
  /** 应用后的完整内容预览。 */
  preview: string;
}

export interface GitIgnoreApplyResult {
  /** 本次实际追加的行（无缺失时为空数组，不覆盖现有文件）。 */
  addedLines: string[];
  /** 是否新建了 .gitignore。 */
  created: boolean;
}

/** 内置 .gitignore 模板（仅追加缺失行，绝不覆盖既有内容）。 */
export const GITIGNORE_TEMPLATE: readonly string[] = [
  "node_modules/",
  "dist/",
  "dist-electron/",
  "branches/",
  ".env",
  ".env.*",
  "!.env.example",
  "*.log",
  ".DS_Store",
];

const gitWritePathPattern = z
  .string()
  .min(1)
  .max(260)
  .refine((value) => !/[\0-\x1f\x7f]/.test(value), "control characters")
  .refine((value) => !value.startsWith("/") && !value.startsWith("\\") && !/^[A-Za-z]:[\\/]/.test(value), "absolute path")
  .refine((value) => !value.replace(/\\/g, "/").includes(".."), "path traversal")
  .refine((value) => !value.replace(/\\/g, "/").startsWith(".git/") && value !== ".git", "git internals");

export const gitWritePathsSchema = z.array(gitWritePathPattern).min(1).max(500);

export const gitCommitTitleSchema = z
  .string()
  .trim()
  .min(1, "提交标题必填")
  .max(100)
  .refine((value) => !/[\r\n]/.test(value), "标题不能包含换行");

export const gitCommitBodySchema = z.string().max(5_000).optional();

export type GitWriteErrorCode =
  | "GIT_WRITE_BAD_PARAM"
  | "GIT_WRITE_NOT_REPO"
  | "GIT_WRITE_STAGE_FAILED"
  | "GIT_WRITE_UNSTAGE_FAILED"
  | "GIT_WRITE_NOTHING_STAGED"
  | "GIT_WRITE_GUARD_BLOCKED"
  | "GIT_WRITE_COMMIT_FAILED"
  | "GIT_WRITE_INTERNAL";

export function writeFail<T>(
  errorCode: GitWriteErrorCode,
  message: string,
  retryable = false,
): GitResult<T> {
  return { ok: false, errorCode, message, retryable };
}
