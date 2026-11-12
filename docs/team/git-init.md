# 工作区一键初始化 Git 仓库（t348）

- **任务**：t348 实现，依据 t347 设计 `docs/team/git-init-design.md`
- **分支**：`feature/t348-git-init`
- **范围**：只新增一次确认的 `git init`；不改现有 Git 写路径/PR/merge/权限/gate、不自动 add/commit、不生成 `.gitignore`、不建 remote/worktree。
- **状态**：实现完成，待独立评审/合并。

## 1. 交付

### 后端/API

- `src/git/gitInit.ts`：
  - `probeGitInit(workspacePath)` 零写探测：工作区存在/目录/可读、`.git`、Git 安装/版本（≥2.36）、父仓库、直接子仓库、可写性、bare；返回 `ready`/`already-repo`/`nested-repo`/`git-missing`/`version-low`/`not-writable`/`invalid-repo`/`unsupported`/`not-found`/`not-directory`/`check-failed`。
  - `initializeGitRepo(workspacePath)` 仅对 `ready` 执行 `git init --initial-branch=main`；`execFile` 无 shell，20s 超时，环境只保留 PATH/HOME/TEMP 等，不继承 `GIT_DIR`/`GIT_WORK_TREE`；init 前重新检查 `.git`，失败不删除既有 `.git`。
- `GitService.probeInit(workspaceId)` / `GitService.init(workspaceId)`：
  - 仅从 `Store.getWorkspace(workspaceId)` 取路径，不接受 renderer 传入路径；
  - `RepoLock` 串行；成功后清 `repoCache`；
  - 成功发审计 `git.repo_initialized`（workspaceId/root/branch/headSha:null），审计失败不回滚仓库。
- IPC：`git:init-probe`（只读）与 `git:init`（唯一写）只接受 workspaceId，经 `gitWorkspaceIdSchema` 校验；preload 暴露 `gitInitProbe`/`gitInit`。
- 新错误码：`GIT_INIT_ALREADY_REPO`、`GIT_INIT_NESTED_REPO`、`GIT_INIT_GIT_MISSING`、`GIT_INIT_VERSION_LOW`、`GIT_INIT_NOT_WRITABLE`、`GIT_INIT_NOT_FOUND`、`GIT_INIT_UNSUPPORTED`、`GIT_INIT_CHECK_FAILED`、`GIT_INIT_TIMEOUT`、`GIT_INIT_PARTIAL`、`GIT_INIT_WORKSPACE_MISSING`、`GIT_INIT_FAILED`。

### 空仓库读取语义

- `GitReadService.repoInfo()` 对 unborn repo 返回成功：`headSha:null`、`branch:"main"`（不再是 `GIT_READ_NO_COMMITS`）。
- `GitReadService.graph()` 对无提交仓库返回合法空 `GitGraphPage`（空 commits/refs，无更多页），UI 显示「main 尚无提交」，工作区 status 仍可读取。
- 既有 `detectRepo`/`repoFor` 行为不变；init 成功后清缓存使后续读取立即识别仓库。

### UI

- 新增 `GitInitModal`：确认 Modal 展示工作区、将创建 `<root>/.git`、默认分支 main；明确不修改现有文件、不 add/commit、不生成 `.gitignore`、不建 remote/PR/worktree；取消/Esc 不发请求，成功按钮 busy 时禁止重复提交；失败内联错误 + 重试。
- `GitGraphPanel` 首次加载先 `gitInitProbe`：
  - `ready` → 唯一主 CTA「初始化 Git 仓库」空态；
  - `already-repo` → 正常版本图；
  - nested/git-missing/version-low/not-writable/invalid/unsupported/check-failed → 原因说明，无 CTA；
  - probe 失败（IPC/未知）→ 普通错误 + 重试，不显示 CTA，避免误判。
- 成功：关闭 Modal、重新 probe/load，进入空仓库/正常 Graph，显示「Git 仓库已初始化（main，尚无提交）」；不自动提交。
- 入口只在 Git Graph 非 Git 空态；Settings/Command Palette 本批不重复入口。

### 样式/可访问性

- `git-init-empty`/Modal 卡片、480 宽度自适应；CTA 原生 button；错误 `role="alert"`，状态 `role="status"`，Modal 复用统一 `Modal`（Esc/Tab/focus/aria-modal）。
- 截图（真实 Electron + 临时 userData 副本，工作区 `Z:\GodotProject\按钮工厂` 非 Git）：
  - `docs/team/t348-1440-cta.png`、`t348-1440-modal.png`
  - `t348-960-cta.png`、`t348-480-cta.png`

## 2. 测试

新增：

- `src/git/gitInit.test.ts`（真实临时目录）：
  - 普通目录 probe `ready` 且不写 `.git`/`.gitignore`；
  - 真实 init 创建 `.git`、`main`、`headSha=null`、不 add（`ls-files` 空）、无 commit、无 `.gitignore`、文件未变；
  - 已存在仓库、父仓库内嵌套、直接子仓库拒绝且不覆盖；
  - 不存在/非目录明确返回；
  - init 后 `repoInfo`/`graph` 可读空仓库。
- `src/git/ui/GitInitPanel.test.tsx`：
  - probe=ready 唯一 CTA；nested 无 CTA；
  - 点击 CTA → Modal → 确认 init → 空仓库「main 尚无提交」；
  - 失败保留 Modal + inline 错误 + 重试。

更新：

- `git.test.ts` Git 事件类型数 34→35（新增 `git.repo_initialized`）。
- `readService.edge.test.ts` 空仓库从 `NO_COMMITS` 改为合法空读取（设计 t347 要求）。

## 3. 验证

```text
pnpm typecheck   # 0
pnpm build       # 0；448 modules
                 # index 315.09 kB / gzip 93.91
                 # GitGraphPanel 17.96 kB / gzip 6.02
                 # CSS index 130.68 kB / gzip 22.37
pnpm test -- --testTimeout=20000 --maxWorkers=2
                 # 122 files / 869 tests passed
```

> 默认 5s 并发 flake 为既有 openai/watchdog/git 环境问题；非本 PR 引入。

## 4. 风险 / 回滚 / 限制

- **安全**：只认 workspaceId→Store 路径；只工作区根；父/子仓库、`.git` 已存在、不可写、Git 缺失/版本低均拒绝；不覆盖任何文件；init 失败不误删既有 `.git`。
- **回滚**：删除 `git:init`/probe IPC、GitInit UI 与 `gitInit.ts`，恢复 `repoInfo`/graph 的 no-commits 语义；不影响现有 Git/PR/merge 路径。
- **限制**：
  - 不做首次 add/commit/首个 `.gitignore`（后续 P1）。
  - 不做 clone/import、remote/PR/worktree 创建。
  - 权限预检在 Windows ACL 下最终以 `git init` stderr 为准；失败可重试。
  - 非 Git 工作区位于父仓库/包含子仓库时只提示，不自动切换到父/子仓库。
  - 未新增 Settings/Command Palette 入口（设计允许可选，本批主入口唯一）。
