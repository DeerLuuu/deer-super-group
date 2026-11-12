import type { GitResult } from "./types.js";

export type GitInitProbeStatus =
  | "ready"
  | "already-repo"
  | "nested-repo"
  | "git-missing"
  | "version-low"
  | "not-writable"
  | "invalid-repo"
  | "unsupported"
  | "not-found"
  | "not-directory"
  | "check-failed"
  | "workspace-missing";

export interface GitInitProbe {
  workspaceId: string;
  workspacePath: string;
  root: string | null;
  status: GitInitProbeStatus;
  canInitialize: boolean;
  branch: "main";
  gitVersion: string | null;
  reason: string | null;
}

export interface GitInitResult {
  workspaceId: string;
  workspacePath: string;
  root: string;
  branch: "main";
  headSha: null;
  auditEventId: string | null;
  initialized: true;
}

export type GitInitResponse = GitResult<GitInitResult>;
