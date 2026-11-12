import { z } from "zod";
import type { GitResult } from "./types.js";

export type GitReadRefKind = "head" | "local" | "remote" | "tag";

export interface GitReadRef {
  name: string;
  fullName: string;
  kind: GitReadRefKind;
  sha: string;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
}

export interface GitRefsSnapshot {
  refs: GitReadRef[];
  truncated: boolean;
}

export interface GitReadRepo {
  workspaceId: string;
  workspacePath: string;
  root: string;
  headSha: string | null;
  branch: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  baseBranch: string | null;
  remote: string | null;
  shallow: boolean;
  bare: boolean;
  gitVersion: string | null;
  generatedAt: string;
}

export interface GitCommitNode {
  sha: string;
  shortSha: string;
  parents: string[];
  authorName: string;
  authorTime: string;
  committerTime: string;
  subject: string;
  refs: string[];
  lane: number;
  color: number;
  parentLanes: Array<{ sha: string; lane: number; kind: "first" | "merge" }>;
  openEdges?: Array<{ lane: number; kind: "missing-parent" }>;
}

export interface GitGraphPage {
  repo: GitReadRepo;
  commits: GitCommitNode[];
  refs: GitReadRef[];
  graphVersion: string;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
  totalLoaded: number;
  truncated: boolean;
  layout: { laneCount: number; maxLanes: number; truncatedLanes: boolean };
}

export interface GitWorkingFile {
  path: string;
  status: string;
  staged: boolean;
  sizeBytes?: number | null;
  binary?: boolean;
  submodule?: boolean;
}

export interface GitWorkingStatus {
  repo: GitReadRepo;
  staged: GitWorkingFile[];
  unstaged: GitWorkingFile[];
  untracked: GitWorkingFile[];
  conflicts: GitWorkingFile[];
  submodules: GitWorkingFile[];
  truncated: boolean;
}

export interface GitCommitDetail {
  node: GitCommitNode;
  body: string;
  changedFiles: GitWorkingFile[];
  stats: { files: number; insertions: number; deletions: number };
  diff: GitDiffPage;
}

export type GitDiffScope = "working" | "staged" | "commit";

export interface GitDiffParams {
  scope: GitDiffScope;
  sha?: string;
  path?: string;
  context?: number;
  maxBytes?: number;
}

export interface GitDiffFile {
  path: string;
  oldPath?: string;
  status: string;
  binary: boolean;
  submodule: boolean;
  truncated: boolean;
  hunks: Array<{ header: string; lines: Array<{ kind: "+" | "-" | " "; text: string }> }>;
}

export interface GitDiffPage {
  files: GitDiffFile[];
  bytes: number;
  truncated: boolean;
  binary: boolean;
  submodule: boolean;
  reason?: "max-bytes" | "max-files" | "binary" | "submodule" | "unsupported";
}

export type GitReadResult<T> = GitResult<T>;

const refPattern = /^[A-Za-z0-9._/-]{1,200}$/;
const shaPattern = /^[0-9a-f]{7,64}$/i;

export function isReadRef(value: string): boolean {
  return (
    refPattern.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.startsWith("-") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock")
  );
}

export function isReadSha(value: string): boolean {
  return shaPattern.test(value);
}

export function isReadPath(value: string): boolean {
  if (!value || value.length > 260) return false;
  if (/[\0-\x1f\x7f]/.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value)) return false;
  const normalized = value.replace(/\\/g, "/");
  if (normalized.includes("..") || normalized.startsWith(".git/") || normalized === ".git") return false;
  return true;
}

export const gitGraphParamsSchema = z
  .object({
    limit: z.number().int().min(1).max(500).default(200),
    offset: z.number().int().min(0).max(2000).default(0),
    ref: z.string().max(200).optional(),
  })
  .strict();

export const gitRefsParamsSchema = z
  .object({ limit: z.number().int().min(1).max(500).default(200) })
  .strict();

export const gitDiffParamsSchema = z
  .object({
    scope: z.enum(["working", "staged", "commit"]),
    sha: z.string().max(64).optional(),
    path: z.string().max(260).optional(),
    context: z.number().int().min(0).max(20).default(3),
    maxBytes: z.number().int().min(4096).max(1_048_576).default(262_144),
  })
  .strict();

export const gitCommitParamsSchema = z.object({ sha: z.string().max(64) }).strict();
export const gitWorkspaceIdSchema = z.string().min(1).max(200);
