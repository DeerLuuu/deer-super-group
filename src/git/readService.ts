import { createHash } from "node:crypto";
import type { RepoInfo, GitResult, GitErrorCode } from "./types.js";
import { GitExec } from "./gitExec.js";
import { attachLayout } from "./graph.js";
import {
  isReadPath,
  isReadRef,
  isReadSha,
  type GitCommitDetail,
  type GitCommitNode,
  type GitDiffPage,
  type GitDiffParams,
  type GitGraphPage,
  type GitReadRef,
  type GitReadRepo,
  type GitRefsSnapshot,
  type GitWorkingFile,
  type GitWorkingStatus,
} from "./readTypes.js";

const GRAPH_LIMIT = 500;
const GRAPH_TOTAL = 2000;
const REF_LIMIT = 500;
const FILE_LIMIT = 500;
const STATUS_LIMIT = 1000;
const DIFF_MAX = 1_048_576;
const GRAPH_FORMAT = "%H%x00%P%x00%an%x00%aI%x00%cI%x00%s%x1e";
const REF_FORMAT = "%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)";

function fail(errorCode: GitErrorCode, message: string): GitResult<never> {
  return { ok: false, errorCode, message, retryable: false };
}

function result<T>(value: T): GitResult<T> {
  return { ok: true, value };
}

function failFrom(source: GitResult<unknown>): GitResult<never> {
  return {
    ok: false,
    errorCode: source.errorCode ?? "GIT_READ_INTERNAL",
    message: source.message ?? "git read failed",
    retryable: source.retryable ?? false,
  };
}

function parseRemote(remote: string | null): string | null {
  if (!remote) return null;
  try {
    const url = new URL(remote);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return remote.replace(/\/\/[^/@]+@/, "//").replace(/\/$/, "");
  }
}

function parseFiles(output: string): GitWorkingFile[] {
  const parts = output.split("\0");
  const files: GitWorkingFile[] = [];
  for (const part of parts) {
    if (!part || part.length < 3) continue;
    const xy = part.slice(0, 2);
    let filePath = part.slice(3);
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
      // porcelain v1 -z appends the destination as a separate NUL field
      continue;
    }
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      try {
        filePath = JSON.parse(filePath);
      } catch {
        // keep raw
      }
    }
    if (!filePath) continue;
    const file: GitWorkingFile = { path: filePath, status: xy.trim() || "?", staged: false };
    if (xy === "??") {
      file.status = "?";
    } else if (xy.includes("U") || xy === "AA" || xy === "DD") {
      file.status = "U";
    } else {
      file.staged = xy[0] !== " ";
      if (!file.staged && xy[1] !== " ") file.status = xy[1];
      else if (file.staged) file.status = xy[0];
    }
    files.push(file);
  }
  return files;
}

function parseNameStatus(output: string): GitWorkingFile[] {
  const files: GitWorkingFile[] = [];
  const parts = output.split("\0").filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    const status = parts[index];
    if (/^[RC]/.test(status)) {
      const from = parts[index + 1];
      const to = parts[index + 2];
      if (from && to) files.push({ path: to, status: status[0], staged: false });
      index += 2;
      continue;
    }
    const filePath = parts[index + 1];
    if (filePath) files.push({ path: filePath, status: status[0] ?? "?", staged: false });
    index += 1;
  }
  return files.slice(0, FILE_LIMIT);
}

function parseCommitNodes(output: string): Array<Omit<GitCommitNode, "lane" | "color" | "parentLanes" | "openEdges">> {
  const records = output.split("\x1e").map((item) => item.replace(/^\r?\n/, "")).filter(Boolean);
  const nodes: Array<Omit<GitCommitNode, "lane" | "color" | "parentLanes" | "openEdges">> = [];
  for (const record of records) {
    const fields = record.split("\0");
    if (fields.length < 6) continue;
    const sha = fields[0]?.trim() ?? "";
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) continue;
    nodes.push({
      sha,
      shortSha: sha.slice(0, 8),
      parents: fields[1] ? fields[1].split(/\s+/).filter(Boolean) : [],
      authorName: fields[2] ?? "",
      authorTime: fields[3] ?? "",
      committerTime: fields[4] ?? "",
      subject: fields[5] ?? "",
      refs: [],
    });
  }
  return nodes;
}

function parseDiff(patch: string, maxBytes: number): GitDiffPage {
  const bytes = Buffer.byteLength(patch, "utf8");
  const truncated = bytes > maxBytes;
  const usable = truncated ? Buffer.from(patch, "utf8").subarray(0, maxBytes).toString("utf8") : patch;
  const files: GitDiffPage["files"] = [];
  let current: GitDiffPage["files"][number] | null = null;
  let binary = false;
  let submodule = false;
  for (const line of usable.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      const path = match?.[2] ?? "unknown";
      current = { path, status: "M", binary: false, submodule: false, truncated: false, hunks: [] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.status = "A";
    else if (line.startsWith("deleted file mode")) current.status = "D";
    else if (line.startsWith("rename from ")) current.oldPath = line.slice("rename from ".length);
    else if (line.startsWith("rename to ")) current.path = line.slice("rename to ".length);
    else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      current.binary = true;
      binary = true;
      current.status = current.status === "M" ? "M" : current.status;
    } else if (line.startsWith("Subproject commit ")) {
      current.submodule = true;
      submodule = true;
    } else if (line.startsWith("@@")) {
      current.hunks.push({ header: line, lines: [] });
    } else if (current.hunks.length > 0 && /^[+\- ]/.test(line)) {
      current.hunks[current.hunks.length - 1].lines.push({
        kind: line[0] as "+" | "-" | " ",
        text: line.slice(1),
      });
    }
  }
  if (current) files.push(current);
  const limited = files.slice(0, FILE_LIMIT);
  return {
    files: limited,
    bytes,
    truncated: truncated || limited.length < files.length,
    binary,
    submodule,
    reason: truncated ? "max-bytes" : limited.length < files.length ? "max-files" : binary ? "binary" : submodule ? "submodule" : undefined,
  };
}

export class GitReadService {
  private readonly git: GitExec;
  private readonly root: string;
  private readonly repo: RepoInfo & { root: string };
  private refCache: { refs: GitReadRef[]; at: number } | null = null;

  constructor(repo: RepoInfo & { root: string }, git: GitExec) {
    this.repo = repo;
    this.git = git;
    this.root = repo.root;
  }

  private async run(args: string[], timeoutMs = 20_000, maxBuffer = 8 * 1024 * 1024): Promise<{ stdout: string; stderr: string; code: number }> {
    return this.git.run(args, { cwd: this.root, timeoutMs, maxBuffer });
  }

  async repoInfo(): Promise<GitResult<GitReadRepo>> {
    const head = await this.run(["rev-parse", "HEAD"], 10_000, 1024 * 1024);
    const headSha = head.code === 0 ? head.stdout.trim() : null;
    const branchRaw = await this.run(["rev-parse", "--abbrev-ref", "HEAD"], 10_000, 1024 * 1024);
    const branch = branchRaw.code === 0 && branchRaw.stdout.trim() !== "HEAD" ? branchRaw.stdout.trim() : null;
    if (!headSha) return fail("GIT_READ_NO_COMMITS", "repository has no commits");
    const bare = (await this.run(["rev-parse", "--is-bare-repository"], 10_000, 1024 * 1024)).stdout.trim() === "true";
    const shallow = (await this.run(["rev-parse", "--is-shallow-repository"], 10_000, 1024 * 1024)).stdout.trim() === "true";
    let ahead = 0;
    let behind = 0;
    if (branch) {
      const count = await this.run(["rev-list", "--left-right", "--count", this.repo.baseBranch, "HEAD"], 10_000, 1024 * 1024);
      if (count.code === 0) {
        const [left, right] = count.stdout.trim().split(/\s+/).map(Number);
        ahead = Number.isFinite(right) ? right : 0;
        behind = Number.isFinite(left) ? left : 0;
      }
    }
    return result({
      workspaceId: "",
      workspacePath: this.repo.workspacePath,
      root: this.root,
      headSha,
      branch,
      detached: !branch,
      ahead,
      behind,
      baseBranch: this.repo.baseBranch,
      remote: parseRemote(this.repo.remote),
      shallow,
      bare,
      gitVersion: this.repo.gitVersion,
      generatedAt: new Date().toISOString(),
    });
  }

  async refs(limit = 200): Promise<GitResult<GitRefsSnapshot>> {
    if (Date.now() - (this.refCache?.at ?? 0) < 10_000 && this.refCache) {
      return result({ refs: this.refCache.refs.slice(0, limit), truncated: this.refCache.refs.length > limit });
    }
    const output = await this.run(
      ["for-each-ref", `--format=${REF_FORMAT}`, "--sort=refname", "refs/heads", "refs/remotes", "refs/tags"],
      10_000,
      4 * 1024 * 1024,
    );
    if (output.code !== 0) return fail("GIT_READ_INTERNAL", output.stderr || "cannot read refs");
    const refs: GitReadRef[] = [];
    for (const line of output.stdout.split(/\r?\n/)) {
      const [fullName, sha, upstream, head] = line.split("\0");
      if (!fullName || !sha || !/^[0-9a-f]{7,64}$/i.test(sha)) continue;
      const kind = fullName.startsWith("refs/tags/")
        ? "tag"
        : fullName.startsWith("refs/remotes/")
          ? "remote"
          : head === "*"
            ? "head"
            : "local";
      refs.push({
        name: fullName.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "").replace(/^refs\/tags\//, ""),
        fullName,
        kind,
        sha,
        upstream: upstream || null,
      });
    }
    refs.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    this.refCache = { refs, at: Date.now() };
    return result({ refs: refs.slice(0, limit), truncated: refs.length > limit });
  }

  async graph(params: { limit: number; offset: number; ref?: string }): Promise<GitResult<GitGraphPage>> {
    const limit = Math.max(1, Math.min(GRAPH_LIMIT, params.limit));
    const offset = Math.max(0, Math.min(GRAPH_TOTAL - 1, params.offset));
    if (offset + limit > GRAPH_TOTAL) return fail("GIT_READ_BAD_PARAM", "offset + limit exceeds 2000");
    if (params.ref && !isReadRef(params.ref)) return fail("GIT_READ_BAD_REF", "invalid ref");
    const repo = await this.repoInfo();
    if (!repo.ok || !repo.value) return failFrom(repo);
    const refs = await this.refs(REF_LIMIT);
    if (!refs.ok || !refs.value) return failFrom(refs);
    const repoValue = repo.value;
    const refsValue = refs.value;
    const args = [
      "log",
      "--no-color",
      "--no-decorate",
      "--topo-order",
      "--parents",
      `--max-count=${limit + 1}`,
      `--skip=${offset}`,
      `--format=${GRAPH_FORMAT}`,
      ...(params.ref ? [params.ref] : ["--all"]),
    ];
    const output = await this.run(args, 20_000, 8 * 1024 * 1024);
    if (output.code !== 0) {
      if (/does not have any commits|unknown revision|bad revision/i.test(output.stderr)) {
        return fail("GIT_READ_NO_COMMITS", output.stderr.trim() || "no commits");
      }
      return fail("GIT_READ_INTERNAL", output.stderr || "cannot read graph");
    }
    const allNodes = parseCommitNodes(output.stdout);
    const hasMore = allNodes.length > limit;
    const nodes = allNodes.slice(0, limit);
    const shaSet = new Set(nodes.map((node) => node.sha));
    for (const node of nodes) {
      node.refs = refsValue.refs
        .filter((ref) => ref.sha === node.sha && ref.kind !== "remote")
        .map((ref) => ref.name)
        .slice(0, 8);
    }
    const laidOut = attachLayout(nodes, 16);
    const graphVersion = createHash("sha1")
      .update(`${repoValue.headSha ?? ""}:${refsValue.refs.map((ref) => `${ref.fullName}:${ref.sha}`).join(",")}`)
      .digest("hex");
    void shaSet;
    return result({
      repo: { ...repoValue, workspaceId: repoValue.workspaceId },
      commits: laidOut.commits,
      refs: refsValue.refs,
      graphVersion,
      offset,
      limit,
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
      totalLoaded: offset + nodes.length,
      truncated: offset + nodes.length >= GRAPH_TOTAL || laidOut.layout.truncatedLanes,
      layout: laidOut.layout,
    });
  }

  async status(): Promise<GitResult<GitWorkingStatus>> {
    const repo = await this.repoInfo();
    if (!repo.ok || !repo.value) return failFrom(repo);
    const output = await this.run(
      ["status", "--porcelain", "-z", "--untracked-files=all", "--ignore-submodules=none"],
      8_000,
      4 * 1024 * 1024,
    );
    if (output.code !== 0) return fail("GIT_READ_INTERNAL", output.stderr || "cannot read status");
    const files = parseFiles(output.stdout);
    const staged = files.filter((file) => file.staged && file.status !== "U");
    const unstaged = files.filter((file) => !file.staged && file.status !== "?" && file.status !== "U");
    const untracked = files.filter((file) => file.status === "?");
    const conflicts = files.filter((file) => file.status === "U");
    const repoValue = repo.value;
    return result({
      repo: repoValue,
      staged: staged.slice(0, STATUS_LIMIT),
      unstaged: unstaged.slice(0, STATUS_LIMIT),
      untracked: untracked.slice(0, STATUS_LIMIT),
      conflicts: conflicts.slice(0, STATUS_LIMIT),
      submodules: [],
      truncated: files.length > STATUS_LIMIT,
    });
  }

  async commit(sha: string): Promise<GitResult<GitCommitDetail>> {
    if (!isReadSha(sha)) return fail("GIT_READ_BAD_PARAM", "invalid sha");
    const meta = await this.run(
      ["show", "-s", "--no-color", "--format=%H%x00%P%x00%an%x00%aI%x00%cI%x00%s%x00%b", sha],
      10_000,
      4 * 1024 * 1024,
    );
    if (meta.code !== 0) {
      return /unknown revision|bad object/i.test(meta.stderr)
        ? fail("GIT_REF_NOT_FOUND", "commit not found")
        : fail("GIT_READ_INTERNAL", meta.stderr || "cannot read commit");
    }
    const fields = meta.stdout.split("\0");
    const parents = fields[1] ? fields[1].split(/\s+/).filter(Boolean) : [];
    const refs = await this.refs(REF_LIMIT);
    const node: GitCommitNode = {
      sha: fields[0]?.trim() ?? sha,
      shortSha: (fields[0] ?? sha).slice(0, 8),
      parents,
      authorName: fields[2] ?? "",
      authorTime: fields[3] ?? "",
      committerTime: fields[4] ?? "",
      subject: fields[5] ?? "",
      refs: refs.ok && refs.value ? refs.value.refs.filter((ref) => ref.sha === sha).map((ref) => ref.name) : [],
      lane: 0,
      color: 0,
      parentLanes: parents.map((parent, index) => ({ sha: parent, lane: index, kind: index === 0 ? "first" : "merge" })),
      openEdges: [],
    };
    const names = await this.run(["show", "--no-color", "--name-status", "-z", "--format=", sha], 10_000, 4 * 1024 * 1024);
    const changedFiles = names.code === 0 ? parseNameStatus(names.stdout) : [];
    const numstat = await this.run(["show", "--no-color", "--numstat", "--format=", sha], 10_000, 4 * 1024 * 1024);
    let insertions = 0;
    let deletions = 0;
    if (numstat.code === 0) {
      for (const line of numstat.stdout.split(/\r?\n/)) {
        const [add, del] = line.split("\t");
        if (/^\d+$/.test(add ?? "")) insertions += Number(add);
        if (/^\d+$/.test(del ?? "")) deletions += Number(del);
      }
    }
    const diff = await this.diff({ scope: "commit", sha, context: 3, maxBytes: 262_144 });
    if (!diff.ok || !diff.value) return failFrom(diff);
    return result({
      node,
      body: fields[6] ?? "",
      changedFiles,
      stats: { files: changedFiles.length, insertions, deletions },
      diff: diff.value,
    });
  }

  async diff(params: GitDiffParams): Promise<GitResult<GitDiffPage>> {
    const context = Math.max(0, Math.min(20, params.context ?? 3));
    const maxBytes = Math.max(4096, Math.min(DIFF_MAX, params.maxBytes ?? 262_144));
    if (params.scope === "commit" && (!params.sha || !isReadSha(params.sha))) {
      return fail("GIT_READ_BAD_PARAM", "commit sha required");
    }
    if (params.path && !isReadPath(params.path)) return fail("GIT_READ_BAD_PATH", "invalid path");
    const args = ["show", "--no-color", "--no-ext-diff", "--no-textconv", "--format=", `--unified=${context}`];
    if (params.scope === "commit") {
      args.push(params.sha!);
    } else if (params.scope === "staged") {
      // `git diff --cached` with no range is the staged workspace snapshot.
      args.splice(0, args.length, "diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", `--unified=${context}`);
    } else {
      args.splice(0, args.length, "diff", "--no-color", "--no-ext-diff", "--no-textconv", `--unified=${context}`);
    }
    if (params.path) args.push("--", params.path);
    const output = await this.run(args, 15_000, 8 * 1024 * 1024);
    if (output.code !== 0) {
      if (/unknown revision|bad object/i.test(output.stderr)) return fail("GIT_REF_NOT_FOUND", "commit not found");
      return fail("GIT_READ_INTERNAL", output.stderr || "cannot read diff");
    }
    return result(parseDiff(output.stdout, maxBytes));
  }
}
