# SourceTree 风格 Git 面板 G3 · 最终集成验收（t394）

- **任务**：t394 — 最终集成 G3：SourceTree 风格 Git 面板四区重排
- **集成人**：sol
- **PR**：https://github.com/DeerLuuu/deer-super-group/pull/54（**MERGED**；head `a645ea4`；squash merge `f7ea0b7`）
- **基线**：main `608bffa`；合并后 main `f7ea0b7`；t390 设计文档随本地 rebase 为 `742ab84` 后推送
- **结论**：**PASS**。四区布局/History/工作区/Inspector/筛选/搜索/排序/三档全部落地；G1 写语义、刷新、懒加载、面板隔离、`#/git` 入口无回归；PR 已合并、worktree/branch 清理。

---

## 0. 验收摘要

| 验收项 | 结论 |
|---|---|
| 四区/交互/三档可追溯 | **PASS**：t390 设计 → t391 实现 → t392 PASS → t398 修复 → t399 review pass |
| 独立三命令 | **PASS**：typecheck 0；build 0（449 modules）；test extended 125 文件/895 |
| 写操作/刷新/懒加载/入口无回归 | **PASS**：G1 IPC/服务未改；全量套件；#git/Command Palette/title/panelRegistry 不变 |
| 最终文档 + PR/合并/worktree | **PASS**：本文件；PR #54 MERGED `f7ea0b7`；worktree/branch 清理 |

---

## 1. 追溯链

| 阶段 | 任务/产物 | 结论 |
|---|---|---|
| 设计 | t390 `docs/team/git-panel-sourcetree-design.md` | 四区/三段断点/a11y/数据缺口决策 |
| 实现 | t391 PR #54 | GitGraphPanel orchestrator、SourceTree CSS、四区/三档 |
| 验证 | t392 `git-panel-sourcetree-verification.md` | PASS；N1–N5 非阻塞 |
| 修复 | t398 | table-only 排序、可见 commits 键盘、filter 绑定、480 nav 截图/签名 |
| 复审 | t399 `git-panel-sourcetree-review-2.md` | pass；N1 medium 零结果搜索 Inspector 旧选中，非阻塞 |
| 集成 | t394（本文件） | PASS、合并、清理 |

---

## 2. 四区布局

| 区域 | 内容 | 断点 |
|---|---|---|
| 左仓库导航 | History/工作区/Search；ref 搜索；local 分支树（当前加粗+点+ahead/behind）；标签/远程/HEAD/工作树；Stash 占位；文件状态/History 切换 | ≥1100 220px；720–1099 180px；<720 popover |
| 右上 History | working copy 置顶（WC 行）；lane（仅拓扑）；描述/日期/作者/提交列；ref chips；22px 行高；加载更早 | 三档均保留，窄屏隐藏次要列 |
| 中间筛选条 | 文件状态/排序（拓扑/日期）、紧凑模式、文件搜索；History 搜索描述/提交、Author Name、跳转提交、刷新 | 720–1099 折行；<720 紧凑 |
| 底部工作区 | 左 55% staged/未暂存/未跟踪/冲突 + 全选/批量 + 提交框；右 45% 固定 Inspector（commit 元数据/变更文件/diff） | ≥1100 左右；720–1099 工作区/Inspector 上下；<720 三 tab（历史/工作区/Diff） |

- 组件仍由 `GitGraphPanel` 编排；新样式在 `gitSourceTree.css`；未改 App/electron/panelRegistry/deeplink。
- 历史/工作区/Inspector 保持既有 G1 `stage/unstage/commit-create/.gitignore` handlers；CommitGuard、写锁、审计、首提引导均未改。

---

## 3. 交互与 a11y

- ref 搜索（分支/标签/远程）、History 文本过滤（描述/提交）、Author Name 过滤、跳转到提交 SHA、拓扑/日期排序、文件状态排序、紧凑列表、刷新。
- 日期/非拓扑排序隐藏 lane SVG 与 Lx 行号，避免错误拓扑；键盘导航使用过滤/排序后的可见 commits，选中不可见时自动跟随首条可见提交（t398 F2）。
- 480 左导航为 popover；480 三 tab（历史/工作区/Diff），无页面横向滚动；480 nav 打开态截图已补。
- aria：listbox/option roving、tablist（480）、tree/treeitem（导航）、checkbox aria-label、`role=alert`/`status`、focus/reduced-motion；继承 G1 的键盘/焦点行为。
- 数据边界：分支提交总数无只读字段，不伪造（当前分支用 ahead/behind）；Stash 仅「待接入」占位；不新增 IPC/数据层。

---

## 4. 三档证据

真实 Electron/CDP 截图（PR 内）：

- `docs/team/t391-git-panel-1440.png`（1440×1000）：四区、History、工作区、固定 Inspector；
- `docs/team/t391-git-panel-960.png`（960×1000）：左 nav + 上下工作区/Inspector；
- `docs/team/t391-git-panel-480.png`（480×900）：三 tab、无页面横向；
- `docs/team/t391-git-panel-480-nav.png`（480×900）：导航 popover 打开态。

人工执行签名（t398）：2026-11-13 01:12 +08:00 / ren / 1440×1000、960×1000、480×900，写入 `docs/team/git-panel-sourcetree.md`。集成目视复核三档布局与 Inspector 可读性。

---

## 5. 回归 / 安全

- 写语义：G1 五通道、CommitGuard、写锁、审计、无 push/force、首提引导未改；本 PR 仅 UI/CSS/测试/docs，无 service/IPC/electron 变更。
- 刷新/懒加载/面板隔离：GitGraphPanel 仍由 `LazyPanel` 加载，刷新协调/仅可见渲染不变；`#/git`、`GitGraphPanel` panel key、标题「版本图」、Command Palette 不变。
- 全量 125 文件/895 用例通过：Git Graph/G1/Git 初始化/TaskVcs/PR/merge/review gate/Settings/rail/Workflow/NeedsMe/Dock/窄窗。
- 无新依赖、无权限/gate/数据 schema 变更；`changedPaths` 为空（概念 inScope）但实际 PR 仅列 9 个 UI/CSS/test/docs 文件，已核对范围。

---

## 6. 验证命令

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **exit 0** |
| `pnpm build` | **exit 0**：449 modules；index 315.15 kB / gzip 93.90；GitGraphPanel 33.31 kB / gzip 9.72；SourceTree CSS 12.50 kB / gzip 2.96；main 1.6MB/preload 13.4 |
| `pnpm test` 裸跑 | 既有 service/watchdog/git 5s 并发 timeout |
| `pnpm test -- --testTimeout=20000 --maxWorkers=2` | **exit 0**：**125 文件 / 895 用例** |

> 5s timeout 为既有机器负载/并发 flake；串行/扩展全量通过（t392/t399 同记录）。

---

## 7. 非阻塞项

| ID | 内容 |
|---|---|
| N1 medium | 零结果搜索时 Inspector 仍显示旧选中（Table 空态与 Inspector 未联动）；t399 记录 |
| N2 low | table-only 仍渲染 rows 包装（语义/视觉无影响） |
| N3 low | 480 nav 仅打开态截图，未覆盖关闭路径动画 |
| N4 low | 默认并行测试既有 5s flake |

---

## 8. 合并 / 清理

- PR #54 **squash merged** → main `f7ea0b7`。
- t390 设计文档本地 commit `0b093b9` 在 PR 合并后 rebase 为 `742ab84`，随本次推送保留。
- worktree `branches/t391-git-panel-sourcetree` 删除。
- local/remote `feature/t391-git-panel-sourcetree` 删除。
- `git worktree list` 仅主 worktree。

---

## 9. 最终 AC

| AC | 证据 | 结论 |
|---|---|---|
| 四区/交互/三档可追溯 | t390/t391/t392/t398/t399 + §2–4 | PASS |
| 独立三命令 | typecheck 0 / build 0 / extended 125/895 | PASS |
| 写操作/刷新/懒加载/入口无回归 | §5；无 IPC/service 变更；全量套件 | PASS |
| 最终文档 + PR/合并/worktree | 本文件；PR #54 MERGED `f7ea0b7`；cleanup | PASS |

**集成结论：PASS，可交付。**
