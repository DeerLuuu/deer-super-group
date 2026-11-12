# t352 · G1 Git 写闭环（stage / unstage / commit / .gitignore）

- **实现**：lin（GLM 席位，DeepSeek 路由执行）
- **范围**：Git Graph 工作区的本地写操作闭环；无 push / force / remote；不改任务级 Git 流程、PR、merge gate、权限。
- **验证**：`pnpm typecheck` ✅ · `pnpm build` ✅ · `pnpm test -- --max-workers=1` **885/885 ✅**（默认并行受本机既有重测试超时影响，见 §5；串行全量已复跑通过）。

## 1. IPC 写通道

| 通道 | 入参（zod strict） | 行为 |
|---|---|---|
| `git:stage` | workspaceId + paths[1..500] | `git add -- <paths>`（argv 白名单新形态） |
| `git:unstage` | workspaceId + paths | `git reset -- <paths>`（unstage；禁 `--hard`/`<commit>` 形态） |
| `git:commit-create` | workspaceId + title(1..100, 无换行) + body?(≤5000) | 只提交已暂存文件；CommitGuard 前置；`git commit --no-verify -m` |
| `git:ignore-preview` | workspaceId | 读取现有 .gitignore，计算缺失模板行 + 完整预览 |
| `git:ignore-apply` | workspaceId | 仅追加缺失行（补换行、不覆盖），审计后生效 |

- 通道名说明：任务描述写 `git:commit`，但该通道已被只读提交详情（t301）占用，写通道命名为 **`git:commit-create`**（preload 侧 `gitCreateCommit`），语义无歧义。
- 安全基线：全部经 `GitExec.run` —— `execFile` 无 shell、argv 白名单（`validateGitArgs` 新增 `add --` / `reset --` 两个受控形态，路径逐一 `isSafePath`）、超时、`GIT_TERMINAL_PROMPT=0`；`RepoLock`（`graphWriteLock`）按 workspace 串行；写路径双校验：`isReadPath`（拒绝绝对路径 / `..` / `.git/**`）+ `path.resolve` 后必须仍在仓库根内。
- 审计事件（workspace 聚合，actor=`git-graph`，经 t68 eventRegistry zod 校验）：`git.staged` / `git.unstaged` / `git.committed` / `git.ignore_updated`；事件类型 35→39。审计失败不回滚已成功的本地写（与 init 同策略）。

## 2. 文件与交互变化

- `src/git/writeTypes.ts`（新增）：写结果类型、`GITIGNORE_TEMPLATE`（node_modules/ dist/ dist-electron/ branches/ .env .env.* !.env.example *.log .DS_Store）、IPC 参数 zod schema。
- `src/git/gitService.ts`：`stage` / `unstage` / `commitFiles` / `ignorePreview` / `ignoreApply` + `graphWriteContext` / `resolveRepoPaths` / `parseStagedPaths`；提交成功后清 repo 缓存。
- `src/git/gitExec.ts`：`add -- <paths>`、`reset -- <paths>` 白名单形态（≤500 路径）；`add .`、`reset --hard`、`reset <commit>` 均拒绝。
- `src/git/commitGuard.ts`：抽出 `checkPath`，新增 **`checkPaths(worktreePath, paths)`** —— 只检查已暂存路径，未暂存的问题文件不阻塞提交（原 `scan` 行为不变，任务收尾 `add -A` 仍全量扫描）。
- `src/git/events.ts` / `src/git/types.ts`：4 个新事件 + 8 个 `GIT_WRITE_*` 错误码。
- `src/git/ui/GitGraphPanel.tsx`（工作区 tab）：
  - **staged 与 未暂存/未跟踪 分组**，每行 checkbox + 单行 diff；组头「全选」checkbox + 「暂存选中 (N)」/「取消暂存选中 (N)」批量按钮；stage/unstage 只刷新工作区状态，不重载提交图（避免大历史时写按钮长时间阻塞）；commit 后刷新状态与图。
  - **提交框**：标题必填（≤100）+ 正文可选；按钮显示「提交（N 个文件）」，无暂存时禁用；说明文案明示「不自动暂存其余改动；仅本地提交，无推送」。
  - **CommitGuard 拒绝 inline 提示**：`GIT_WRITE_GUARD_BLOCKED` 等错误显示在 `role="alert"` 块，附「重试刷新 / 关闭」。
  - **空仓库首提引导**：仅在 repo/工作区探测完成后、`repo.headSha === null` 时显示「首次提交」三步引导卡（t389 修复：不能让加载中的 `repo=null` 闪出首提引导）；unborn 分支上 `git reset --`（unstage）可用。
  - **.gitignore**：工具栏「生成 .gitignore」→ 预览 Modal（现有内容折叠可查、`+ ` 前缀展示将追加行）→「追加缺失行」；应用后作为未跟踪文件出现在工作区。
  - aria：checkbox 带 `aria-label`（全选类）、错误 `role="alert"`、成功 `role="status"`、提交表单 `aria-label`；成功提示 8s 自动消失。顶栏 badge 「只读」→「本地可写」。
  - **t389 走查修复**：Dock 在 1440/960/480 视口切换时可能重挂 Git 面板；按 workspaceId 记住最后视图（graph/detail/workspace），重挂后恢复工作区 tab，避免暂存勾选上下文丢失；stage/unstage 改为 `reloadGraph:false`；.gitignore 预览在“将创建”分支也明确「仅写入模板行、不覆盖现有文件」。
- `src/git/ui/gitGraph.css`：`.git-check` / `.git-file-row` / `.git-first-commit` / `.git-write-error` / `.git-write-ok` / `.git-commit-box` / `.git-ignore-*`。
- `electron/main.ts` + `electron/preload.ts` + `src/shared/ipc.ts`：5 个通道（可选方法 `gitStage?/gitUnstage?/gitCreateCommit?/gitIgnorePreview?/gitIgnoreApply?`，老 preload 降级时 UI 自动隐藏写控件并只读）。
- `src/Modal.tsx`：两个 effect 增加 `typeof document === "undefined"` 守卫（node 测试渲染无 document；DOM 行为零变化）。

## 3. 无回归边界

- 任务级 Git 流程（worktree/lease/fencing、finalizeRun 的 `commitAll`+全量 guard 扫描、push/PR/merge queue）零改动；`add -A`/`commit -m`/`push` 白名单原形态保留。
- 无 push / force / remote 新通道；`reset` 白名单只放行 `-- <paths>` unstage 形态。

## 4. 测试（21 条新增/调整，全绿）

- `src/git/gitWrite.test.ts`（12 用例，真实临时仓库 + 真实 Store/事件）：
  - argv 白名单：`add --`/`reset --` 受控形态接受，`..`/绝对路径/`.git`/`add .`/`reset --hard`/`reset HEAD~1` 拒绝；
  - stage/unstage 真实生效（porcelain 断言）+ `git.staged`/`git.unstaged` 审计事件；
  - commit：只提交已暂存（wip.txt 留在工作区）、title+body 进入提交信息、`git.committed` 事件、unborn 仓库首次提交；
  - CommitGuard：staged `.env` / 私钥内容拒绝（HEAD 不动）、未暂存问题文件不阻塞正常提交、空暂存 `GIT_WRITE_NOTHING_STAGED`、标题校验；
  - .gitignore：预览（无文件→全模板）、应用（新文件、未跟踪出现）、**幂等仅追加缺失行**（`dist/` 不重复）、自定义内容保留、无尾换行补行、非 Git 工作区 `GIT_WRITE_NOT_REPO`。
- `src/git/ui/GitGraphPanel.test.tsx`（t352 +2 / t389 增强）：勾选/全选→批量暂存→提交表单→成功提示→.gitignore 预览 Modal；unborn 仓库首提引导 + 无暂存时提交禁用；t389 新增「repo 探测未完成不闪首提引导」回归，并断言 stage 不触发 graph 重载、Dock 重挂后恢复 workspace 视图、Modal 始终声明仅追加不覆盖。
- `src/git/git.test.ts`：事件类型计数 35→39。

## 5. 已知边界 / 偏差（供评审判断）

1. **`git:commit` 通道名占用**：写通道为 `git:commit-create`（§1）。
2. **并行满载测试偶发**：`pnpm test`（默认并行）在本机对 watchdog/kernel/git 等重测试有既有偶发超时——t389 实测默认并行 9 项超时、单测/串行均通过；串行 `pnpm test -- --max-workers=1` 下 **124 文件 / 885 用例全绿**（t352 基线 883，本轮 +2）。这是机器负载/既有 5s timeout，不是 G1 行为失败。
3. Windows 下 temp 仓库清理为 best-effort（既有模式）。
4. `.gitignore` >256KB 拒绝预览（防误读大文件）。
5. **三档截图已由 t389 补齐**：1440/960/480 的真实 Electron/CDP 证据见 §6；不再保留“未产出截图”偏差。

## 6. t389 真实 Electron 三档截图与 UI/aria 走查

**方法**：worktree `feature/t352-git-write` 构建后，用隔离 userData + 临时 Git fixture 启动真实 Electron，CDP `Emulation.setDeviceMetricsOverride` + 显式 `window.dispatchEvent(new Event('resize'))`（必须显式通知 React，否则 Dock 仍按旧视口布局），截图与 DOM 断言脚本为 `scripts/gitwrite-cdp.mjs`（本任务辅助脚本，不进入生产）。fixture 由 env-gated `scripts/seedGitwriteFixture.test.ts` 创建，不写入真实 workspace。

### 6.1 截图索引

| 场景 | 1440 | 960 | 480 |
|---|---|---|---|
| 工作区写 UI（staged/未暂存分组、批量、提交框） | `docs/team/t352-1440-write-ui.png` | `docs/team/t352-960-write-ui.png` | `docs/team/t352-480-write-ui.png` |
| 空仓库首提三步引导 | `docs/team/t352-1440-first-commit.png` | `docs/team/t352-960-first-commit.png` | `docs/team/t352-480-first-commit.png` |
| .gitignore 预览 Modal（仅追加声明） | `docs/team/t352-1440-ignore-modal.png` | `docs/team/t352-960-ignore-modal.png` | `docs/team/t352-480-ignore-modal.png` |

补充证据：`t352-1440-ignore-modal-unborn.png`（unborn 模板）、`t352-1440-guard-blocked.png`（guard inline role=alert）、`t352-1440-committed.png`（真实提交后）、`t352-1440-unborn-committed.png`（首提成功）、`t352-1440-ignore-applied.png`（.gitignore 应用后出现在未跟踪）。960/480 截图使用单列视口 + `scrollIntoView` 到分组/提交区；未出现横向滚动（`document.documentElement.scrollWidth <= viewport`，960/480 均通过）。

### 6.2 走查结论

- `docs/team/t389-walkthrough-normal.json`：**22/22 PASS**，含勾选→`gitStage`→「已暂存 (1)」迁移、无暂存提交禁用、`.env` staged 后提交触发 **role=alert** inline guard、`.gitignore` Modal 声明「不覆盖任何现有文件」、Esc 关闭、键盘 Tab/Enter 激活批量暂存、unstage 回到未暂存、真实 commit HEAD 更新、ignore 应用后 `.gitignore` 出现在未跟踪。
- `docs/team/t389-walkthrough-unborn.json`：**10/10 PASS**，unborn 首提三步引导、空仓库 `.gitignore` Modal、首次提交后版本图出现提交。
- 关键 aria：全选未暂存/已暂存 checkbox `aria-label`、提交表单 `aria-label="提交已暂存文件"`、版本视图 `role=tablist aria-label="版本视图"`、`.gitignore` 按钮 title；Tab 可聚焦、Enter 激活「暂存选中」，不是只读静态断言。
- 走查中修复（均有测试）：
  1. repo 探测未完成时 `!repo?.headSha` 误显示首提引导 → 改为 `!loading && repo !== null && !repo.headSha`；新增 loading 回归。
  2. Dock 视口切换重挂导致 workspace view/暂存上下文丢失 → 按 workspaceId 记忆最后视图并主动加载 working；新增重挂断言。
  3. stage/unstage 后重载整图导致写按钮长时间 busy → 仅刷新 status（`reloadGraph:false`）；新增 graph 调用次数断言。
  4. 新建 .gitignore 的 Modal 未明确“不覆盖” → 无条件说明仅写入模板行/不覆盖，保留幂等文案；新增文案断言。

## 7. 人工冒烟清单（桌面环境）

1. 真实仓库 stage→unstage→commit→图刷新→「查看上下文/在任务页打开」链路。
2. 输入法/中文路径文件勾选暂存（GBK/UTF-8 文件名）。
3. 并发：两个窗口同时 stage 同一文件（RepoLock 串行，后者基于最新索引）。
4. 视口 1440→960→480 往返：Git 工作区视图保持、无横向滚动、键盘 Tab/Enter 可达。
