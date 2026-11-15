# 大 diff 搜索与 trace 分页 · 最终集成验收（t363）

- **任务**：t363 — 最终集成 D1：大 diff 搜索/trace 分页
- **集成人**：sol
- **PR**：https://github.com/DeerLuuu/deer-super-group/pull/68（**MERGED**；head `aa19591`；squash merge `0ab1b27`）
- **基线**：PR 原 base `7585765`；合并前同步 main `4015ee1`（background console）；合并后 main `0ab1b27`
- **结论**：**PASS**。diff 搜索/高亮/计数/跳转、大 diff 两步完整加载/TOO_LARGE、trace 100 窗口分页/过滤/跳转全部落地；20k/三档/aria 证据完整；无 schema/权限/IPC 变更；PR 已合并、worktree/branch 清理。

---

## 0. 验收摘要

| 验收项 | 结论 |
|---|---|
| 搜索/大 diff/trace 分页可追溯 | **PASS**：t360 实现 → t485 真实证据+3 修复 → t486 PASS → t489 repair → t490 review pass |
| 独立三命令 | **PASS**：typecheck 0；build 0（465 modules）；clean main serial 167 文件/1106 |
| 20k 行/TOO_LARGE/三档/aria | **PASS**：20k 单测；8.3MB TOO_LARGE role=alert；1440/960/480 无横向；trace/搜索 aria |
| 无 schema/权限变更 | **PASS**：未改 electron/main/preload/schema/permissions；仅 git/tasks/UI/styles/docs/tests |
| 最终文档 + PR/合并/worktree | **PASS**：本文件；PR #68 MERGED `0ab1b27`；worktree/branch 清理 |

---

## 1. 追溯链

| 阶段 | 任务/产物 | 结论 |
|---|---|---|
| 实现 | t360 PR #68 | diff 搜索、两步完整 diff、trace 分页 |
| 真实证据/修复 | t485（head `ac6ef8c`） | 三档 CDP；修 gitExec maxBuffer/trace rAF 竞态/page 截断 |
| 验证 | t486 `diff-trace-verification-2.md` | PASS |
| 修复 | t489（head `c25ce7b`） | 并排 sideMatchStats/Enter parity；1440×900 证据 |
| 复审 | t490 `diff-trace-review-2.md` | pass |
| 集成 | t363（本文件） | PASS、合并、清理 |

---

## 2. 功能验收

### Diff 搜索

- 搜索框过滤/高亮，计数 `1/10 行 · 10 处`；Enter / Shift+Enter 循环定位；无结果显示「无匹配」；清除恢复文件列表。
- 统一与并排视图共用；并排统计 `sideMatchStats` 以过滤后的 SideRow 行数为 hitRows、old/new 命中累加 totalMatches，Enter 循环与 DOM 行严格一致（t489）。
- 真实键盘输入/CDP 证据：marks 10 / rows 10 / 计数 1/10→Enter 2/10；无结果→清除 files=1；1440×900 `t489-walkthrough-1440x900.json`。

### 大 diff

- 默认截断 + 「加载完整 diff」两步确认；1MB 展示上限，big.txt 展开 1,000,000 字节（400 行）后截断提示消失。
- 8.3MB huge.txt → `GIT_READ_TOO_LARGE: diff exceeds 8MB stdout limit` role=alert，应用不卡顿/不退出。
- t485 走查修复 `gitExec` maxBuffer 被 stderr CRLF 警告掩盖导致 noIndex 吞错返回空 diff 的真实缺陷。

### Trace 分页/过滤/跳转

- 263 条事件 → 最新 100 窗口；类型过滤 `tool.call` → 52；点击跳转 `data-trace-seq=7` focus=7。
- 「加载更早」100→200；顶部锚点保持（scrollTop 0）；`pending-jump` + `useLayoutEffect` + 全量展开修复 rAF 竞态/窗口外目标。
- 失败重试、seq 去重、类型过滤、分页保持、aria 状态由 t360/t485 测试覆盖。

---

## 3. 三档 / 20k / aria

- 真实 Electron/CDP：1440×1200、960×900、480×800；960 搜索框可见，480 无横向；截图：
  - `t485-diff-search-1440.png`、`t485-bigdiff-confirm-1440.png`、`t485-toolarge-1440.png`、`t485-trace-1440.png`、`t485-git-960.png`、`t485-git-480.png`、`t489-diff-search-1440x900.png`。
- 20k 行量化由组件测试覆盖（t360 新增 28 例，含 20k 行搜索/渲染）；真实 1440 Dock pane <560 时并排按钮禁用、以 unified 视图为准（JSON 披露）。
- `role=alert` TOO_LARGE 内联，应用 `alive=true`；aria-label/计数/无结果状态保留。

---

## 4. 范围 / 回归

- PR 23 文件：`src/git/{gitExec,readService,ui/GitDiffViewer,GitGraphPanel,gitWorkingDiff.css,gitDiffSearch}`、`src/shell/tracePaging`、`src/App.tsx`、`src/styles.css`、`scripts/seedDiffTraceFixture.test.ts`、docs/证据。
- 未改 `electron/main.ts`、`electron/preload.ts`、schema、权限、gate、IPC 通道；无新依赖。
- 全量 167 文件/1106 用例（含 background console #69、EPIPE guard、G15 等 main 合并）通过。
- 同步 main 后无冲突；PR base 由 7585765 更新至 4015ee1，最终 squash `0ab1b27`。

---

## 5. 验证命令

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **exit 0** |
| `pnpm build` | **exit 0**：465 modules；index 363.98 kB / gzip 108.38；GitGraphPanel 51.86 / gzip 14.80；GitGraph CSS 20.36；index CSS 143.84 / gzip 24.45 |
| `pnpm test`（PR worktree，2 workers） | **exit 0**：167 文件/1106 |
| `pnpm test -- --testTimeout=20000 --maxWorkers=1`（干净 detached main） | **exit 0**：167 文件/1106 |

> 主工作区有 `branches/**` 历史目录/其他任务，默认 Vitest 可能扫入；集成使用干净 detached main checkout。主工作区 `.gitignore`/`.npmrc`/`.electron-runtime` 等本地内容非本任务。

---

## 6. 非阻塞项

| ID | 内容 |
|---|---|
| N1 medium | 1440 Dock pane <560 自动 unified，并排按钮禁用；已在 JSON/截图披露，真实并排逻辑由组件测试覆盖 |
| N2 low | 20k 行量化仅组件测试；真实 1440×1200 截图非 20k |
| N3 low | t485 截图 1440×1200（非 1440×900）；t489 补 1440×900 |
| N4 low | 既有并发 5s timeout/fake-timer flake |

---

## 7. 合并 / 清理

- 同步 main `4015ee1` 后 push head `aa19591`；PR #68 **squash merged** → main `0ab1b27`。
- `pnpm branch:remove t360-diff-trace-paging` 成功：worktree/local branch 删除。
- remote branch 删除。
- 集成临时 clean checkout 删除。
- `git worktree list` 仅主 worktree；本任务清理完成。

---

## 8. 最终 AC

| AC | 证据 | 结论 |
|---|---|---|
| 搜索/大 diff/trace 分页可追溯 | t360/t485/t486/t489/t490 + §2–4 | PASS |
| 独立三命令 | typecheck 0 / build 0 / clean 167/1106 | PASS |
| 20k/TOO_LARGE/三档/aria | 20k 单测；8.3MB alert；三档截图 | PASS |
| 无 schema/权限变更 | diff 范围只有 git/tasks/UI/docs/tests | PASS |
| 最终文档 + PR/合并/worktree | 本文件；PR #68 MERGED `0ab1b27`；cleanup | PASS |

**集成结论：PASS，可交付。**
