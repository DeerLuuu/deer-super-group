import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redactSecrets } from "./gitExec.js";
import type { PrInfo, PrProvider, RepoInfo } from "./types.js";

const execFileAsync = promisify(execFile);

function now(): string {
  return new Date().toISOString();
}

function parseRepo(remote: string | null): { owner: string; repo: string } | null {
  if (!remote) return null;
  const cleaned = remote.replace(/\.git$/, "");
  const ssh = cleaned.match(/git@[^:]+:(.+)$/);
  const https = cleaned.match(/https?:\/\/[^/]+\/(.+)$/);
  const value = ssh?.[1] ?? https?.[1] ?? null;
  if (!value) return null;
  const [owner, repo] = value.split("/");
  return owner && repo ? { owner, repo } : null;
}

async function gh(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("gh", args, {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, stdout: redactSecrets(result.stdout), stderr: redactSecrets(result.stderr) };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: redactSecrets(String(err.stdout ?? "")),
      stderr: redactSecrets(String(err.stderr ?? err.message ?? "gh failed")),
    };
  }
}

async function ghAuth(): Promise<boolean> {
  const result = await gh(["auth", "status"]);
  return result.ok;
}

function token(): string | null {
  return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;
}

function apiBase(host: string): string {
  return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
}

async function rest(
  repo: RepoInfo,
  pathName: string,
  init: RequestInit = {},
  host = "github.com",
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const auth = token();
  if (!auth) throw new Error("AUTH_MISSING");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${apiBase(host)}${pathName}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${auth}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "DeerSuperGroup/git",
        ...(init.headers ?? {}),
      },
    });
    const text = redactSecrets(await response.text());
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // ignore non-json
    }
    return { ok: response.ok, status: response.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

export class GitHubProvider implements PrProvider {
  readonly id = "github" as const;
  private host: string;

  constructor(host = "github.com") {
    this.host = host;
  }

  async detect(_repo: RepoInfo): Promise<boolean> {
    return (await ghAuth()) || Boolean(token());
  }

  private async view(owner: string, repo: string, number: number): Promise<PrInfo> {
    const result = await gh([
      "pr",
      "view",
      String(number),
      "--repo",
      `${owner}/${repo}`,
      "--json",
      "number,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid,baseRefName,mergedAt,mergeCommit",
    ]);
    if (!result.ok) throw new Error(result.stderr || "PR_NOT_FOUND");
    const data = JSON.parse(result.stdout) as Record<string, unknown>;
    const checks = Array.isArray(data.statusCheckRollup)
      ? (data.statusCheckRollup as Array<Record<string, unknown>>).map((item) => {
          const state = String(item.conclusion ?? item.state ?? "queued").toLowerCase();
          const status =
            state === "success"
              ? "passed"
              : state === "failure" || state === "cancelled" || state === "timed_out"
                ? "failed"
                : state === "pending" || state === "queued" || state === "in_progress"
                  ? "in_progress"
                  : "neutral";
          return {
            name: String(item.name ?? item.context ?? "check"),
            status: status as PrInfo["checks"][number]["status"],
          };
        })
      : [];
    const review =
      data.reviewDecision === "APPROVED"
        ? "approved"
        : data.reviewDecision === "CHANGES_REQUESTED"
          ? "changes_requested"
          : "pending";
    const state = String(data.state ?? "open").toLowerCase();
    const merged = state === "merged";
    const mergeCommit = data.mergeCommit as { oid?: string } | null | undefined;
    return {
      provider: "github",
      number: Number(data.number ?? number),
      url: data.url ? String(data.url) : null,
      state: merged ? "merged" : state === "closed" ? "closed" : data.isDraft ? "draft" : "open",
      headSha: String(data.headRefOid ?? ""),
      baseBranch: String(data.baseRefName ?? "main"),
      mergeable:
        data.mergeable === "CONFLICTING"
          ? "conflicting"
          : data.mergeable === "MERGEABLE"
            ? "mergeable"
            : "unknown",
      checks,
      review,
      mergedCommitSha: mergeCommit?.oid ?? null,
      updatedAt: now(),
    };
  }

  async createPr(input: {
    repo: RepoInfo;
    head: string;
    base: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<PrInfo> {
    const parsed = parseRepo(input.repo.remote);
    if (!parsed) throw new Error("PR_NOT_FOUND");
    const result = await gh([
      "pr",
      "create",
      "--repo",
      `${parsed.owner}/${parsed.repo}`,
      "--base",
      input.base,
      "--head",
      input.head,
      "--title",
      input.title,
      "--body",
      input.body,
      ...(input.draft ? ["--draft"] : []),
    ]);
    if (!result.ok) {
      if (!token()) throw new Error(result.stderr || "PR_CREATE_FAILED");
      const response = await rest(
        input.repo,
        `/repos/${parsed.owner}/${parsed.repo}/pulls`,
        {
          method: "POST",
          body: JSON.stringify({
            title: input.title,
            head: input.head,
            base: input.base,
            body: input.body,
            draft: Boolean(input.draft),
          }),
          headers: { "Content-Type": "application/json" },
        },
        this.host,
      );
      if (!response.ok) throw new Error(response.text || "PR_CREATE_FAILED");
      const data = response.json as Record<string, unknown>;
      return {
        provider: "github",
        number: Number(data.number ?? 0),
        url: data.html_url ? String(data.html_url) : null,
        state: data.draft ? "draft" : "open",
        headSha: String((data.head as { sha?: string } | undefined)?.sha ?? ""),
        baseBranch: String((data.base as { ref?: string } | undefined)?.ref ?? input.base),
        mergeable: "unknown",
        checks: [],
        review: "pending",
        mergedCommitSha: null,
        updatedAt: now(),
      };
    }
    const url = result.stdout.trim().split(/\s+/).pop() ?? "";
    const numberMatch = url.match(/\/pull\/(\d+)/);
    if (!numberMatch) throw new Error("PR_CREATE_FAILED");
    return this.view(parsed.owner, parsed.repo, Number(numberMatch[1]));
  }

  async refresh(repo: RepoInfo, pr: { number: number | null; branch: string }): Promise<PrInfo> {
    if (!pr.number) return this.manual(repo, pr.branch, "open");
    const parsed = parseRepo(repo.remote);
    if (!parsed) throw new Error("PR_NOT_FOUND");
    try {
      return await this.view(parsed.owner, parsed.repo, pr.number);
    } catch (error) {
      if (!token()) throw error;
      return this.restRefresh(repo, pr.number);
    }
  }

  async listChecks(repo: RepoInfo, pr: { number: number | null; branch: string }): Promise<PrInfo["checks"]> {
    return (await this.refresh(repo, pr)).checks;
  }

  async merge(
    repo: RepoInfo,
    pr: { number: number | null; branch: string; headSha: string },
    opts: { method: "squash" | "merge" | "rebase" },
  ): Promise<PrInfo> {
    if (!pr.number) throw new Error("PR_NOT_FOUND");
    const parsed = parseRepo(repo.remote);
    if (!parsed) throw new Error("PR_NOT_FOUND");
    const flag = opts.method === "squash" ? "--squash" : opts.method === "merge" ? "--merge" : "--rebase";
    const result = await gh([
      "pr",
      "merge",
      String(pr.number),
      "--repo",
      `${parsed.owner}/${parsed.repo}`,
      flag,
      "--match-head-commit",
      pr.headSha,
    ]);
    if (!result.ok) {
      if (/conflict/i.test(result.stderr)) throw new Error("MERGE_CONFLICT");
      if (!token()) throw new Error(result.stderr || "MERGE_FAILED");
      const response = await rest(
        repo,
        `/repos/${parsed.owner}/${parsed.repo}/pulls/${pr.number}/merge`,
        {
          method: "PUT",
          body: JSON.stringify({ sha: pr.headSha, merge_method: opts.method }),
          headers: { "Content-Type": "application/json" },
        },
        this.host,
      );
      if (!response.ok) throw new Error(response.text || "MERGE_FAILED");
      return this.restRefresh(repo, pr.number);
    }
    return this.refresh(repo, { number: pr.number, branch: pr.branch });
  }

  async close(repo: RepoInfo, pr: { number: number | null; branch: string }): Promise<void> {
    if (!pr.number) return;
    const parsed = parseRepo(repo.remote);
    if (!parsed) return;
    await gh([
      "pr",
      "close",
      String(pr.number),
      "--repo",
      `${parsed.owner}/${parsed.repo}`,
    ]);
  }

  async restRefresh(repo: RepoInfo, number: number): Promise<PrInfo> {
    const parsed = parseRepo(repo.remote);
    if (!parsed) throw new Error("PR_NOT_FOUND");
    const result = await rest(repo, `/repos/${parsed.owner}/${parsed.repo}/pulls/${number}`, {}, this.host);
    if (!result.ok) throw new Error(result.text || "PR_NOT_FOUND");
    const data = result.json as Record<string, unknown>;
    return {
      provider: "github",
      number,
      url: data.html_url ? String(data.html_url) : null,
      state: String(data.state ?? "open") as PrInfo["state"],
      headSha: String((data.head as { sha?: string } | undefined)?.sha ?? ""),
      baseBranch: String((data.base as { ref?: string } | undefined)?.ref ?? "main"),
      mergeable:
        data.mergeable === false ? "conflicting" : data.mergeable === true ? "mergeable" : "unknown",
      checks: [],
      review: "pending",
      mergedCommitSha: data.merge_commit_sha ? String(data.merge_commit_sha) : null,
      updatedAt: now(),
    };
  }

  private manual(repo: RepoInfo, branch: string, state: PrInfo["state"]): PrInfo {
    const parsed = parseRepo(repo.remote);
    const url = parsed && repo.remote
      ? `${repo.remote.replace(/\.git$/, "")}/compare/${repo.baseBranch}...${branch}?expand=1`
      : null;
    return {
      provider: "manual",
      number: null,
      url,
      state,
      headSha: "",
      baseBranch: repo.baseBranch,
      mergeable: "unknown",
      checks: [],
      review: "pending",
      mergedCommitSha: null,
      updatedAt: now(),
    };
  }
}

export class ManualProvider implements PrProvider {
  readonly id = "manual" as const;

  async detect(repo: RepoInfo): Promise<boolean> {
    return repo.remoteKind === "remote";
  }

  async createPr(input: {
    repo: RepoInfo;
    head: string;
    base: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<PrInfo> {
    return {
      provider: "manual",
      number: null,
      url: input.repo.remote
        ? `${input.repo.remote.replace(/\.git$/, "")}/compare/${input.base}...${input.head}?expand=1`
        : null,
      state: "manual_pending",
      headSha: "",
      baseBranch: input.base,
      mergeable: "unknown",
      checks: [],
      review: "pending",
      mergedCommitSha: null,
      updatedAt: now(),
    };
  }

  async refresh(repo: RepoInfo, pr: { number: number | null; branch: string }): Promise<PrInfo> {
    return {
      provider: "manual",
      number: null,
      url: repo.remote
        ? `${repo.remote.replace(/\.git$/, "")}/compare/${repo.baseBranch}...${pr.branch}?expand=1`
        : null,
      state: "manual_pending",
      headSha: "",
      baseBranch: repo.baseBranch,
      mergeable: "unknown",
      checks: [],
      review: "pending",
      mergedCommitSha: null,
      updatedAt: now(),
    };
  }

  async listChecks(): Promise<PrInfo["checks"]> {
    return [];
  }

  async merge(): Promise<PrInfo> {
    throw new Error("MERGE_REVIEW_REQUIRED");
  }

  async close(): Promise<void> {
    return;
  }
}

export class LocalProvider implements PrProvider {
  readonly id = "local" as const;

  async detect(repo: RepoInfo): Promise<boolean> {
    return repo.remoteKind === "none";
  }

  async createPr(input: {
    repo: RepoInfo;
    head: string;
    base: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<PrInfo> {
    return {
      provider: "local",
      number: null,
      url: null,
      state: "local",
      headSha: "",
      baseBranch: input.base,
      mergeable: "unknown",
      checks: [],
      review: "pending",
      mergedCommitSha: null,
      updatedAt: now(),
    };
  }

  async refresh(repo: RepoInfo, pr: { number: number | null; branch: string }): Promise<PrInfo> {
    void repo;
    return {
      provider: "local",
      number: null,
      url: null,
      state: "local",
      headSha: "",
      baseBranch: "main",
      mergeable: "unknown",
      checks: [],
      review: "pending",
      mergedCommitSha: null,
      updatedAt: now(),
    };
  }

  async listChecks(): Promise<PrInfo["checks"]> {
    return [];
  }

  async merge(): Promise<PrInfo> {
    throw new Error("MERGE_REVIEW_REQUIRED");
  }

  async close(): Promise<void> {
    return;
  }
}

export async function pickProvider(
  repo: RepoInfo,
  preference: "auto" | "github" | "manual" | "local",
  host = "github.com",
): Promise<PrProvider> {
  if (preference === "local") return new LocalProvider();
  if (preference === "manual") return new ManualProvider();
  if (repo.remoteKind === "none") return new LocalProvider();
  const github = new GitHubProvider(host);
  if (preference === "github") return github;
  if (await github.detect(repo)) return github;
  return new ManualProvider();
}

export function providerUrlHost(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.hostname : null;
  } catch {
    return null;
  }
}

export function compareUrl(repo: RepoInfo, branch: string): string | null {
  if (!repo.remote) return null;
  return `${repo.remote.replace(/\.git$/, "")}/compare/${repo.baseBranch}...${branch}?expand=1`;
}
