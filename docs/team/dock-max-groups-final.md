# Dock 最大分栏设置 · 最终集成验收（t211）

- **任务**：t211 — 集成验收 Dock 最大分栏设置（P0-1 后续小功能）
- **集成人**：sol（Systems Engineer）
- **日期**：2026-11-12
- **基线**：main `fc4cbd3`（t197 P0-1 集成后）
- **PR**：https://github.com/DeerLuuu/deer-super-group/pull/34（**MERGED**；head `c951d75`；squash merge `63f8503`）
- **结论**：**PASS**。默认 6、范围 2–8、Settings「界面」入口、DockShell 动态上限、即时生效且不重建布局全部落地；6/7、2/3、8/9 边界与刷新持久化通过；三命令独立复跑通过；PR 已合并，worktree/branch 已清理。

---

## 0. 验收摘要

| 验收项 | 结论 |
|---|---|
| 默认 6 / 范围 2–8 / 设置即时生效可追溯 | **PASS**：LayoutSettings + Settings「界面」+ App `maxGroups` + DockShell `canAddDockGroup` |
| 独立 typecheck/build/test | **PASS**：0 / 0 / 63 文件 640 用例 |
| 6/7/2/8 边界与刷新持久化 | **PASS**：dockGroups 4 + layoutSettings 4 + SettingsView 1；真实 Electron default6→save8→reload8→restore6 |
| Dock/深链/快捷键/窄窗/权限无回归 | **PASS**：全量套件；diff 仅 13 文件，无 kernel/permission/electron/Git/记忆/评审改动 |
| 最终文档 | **PASS**：本文件 |
| PR/合并/worktree | **PASS**：PR #34 MERGED `63f8503`；worktree/local/remote 分支已清理 |

---

## 1. 追溯链（t208–t211）

| 阶段 | 任务/报告 | 结论 |
|---|---|---|
| 实现 | t208（ray） | LayoutSettings（默认 6、2–8、normalize/clamp）；Settings「界面」分区；DockShell maxGroups prop；鼠标/键盘统一 `canAddDockGroup`；布局不 rebuild；测试/截图/docs |
| 独立验证 | t209（noor） | PASS：默认/范围/持久化/6–7/2–3/8–9；Settings 保存 payload；真实 Electron metrics；N1–N5 low |
| 评审 | t210（nova） | **verdict=pass**：13 文件、无 blocker；N1 注释旧 4 组、N2 无组件级 no-rebuild 测试、N3 空串→2、N4 toast kind 等 low |
| 集成 | t211（sol） | 本文件：独立三命令、边界/持久化/回归、截图目视、合并与清理 |

报告：`docs/team/dock-max-groups.md`、`dock-max-groups-verification.md`、`dock-max-groups-review.md`。

---

## 2. PR / 基线 / 范围

- **PR #34**：`feature/t208-dock-max-groups` → `main`，**MERGED**（squash `63f8503`），head `c951d75`，base `fc4cbd3`（含 t197 P0-1）。
- **diff 13 文件 / +451 / -9**：
  - `src/shared/types.ts`：`LayoutSettings`、`DEFAULT_MAX_DOCK_GROUPS=6`、2–8、`normalizeLayoutSettings`；
  - `src/kernel/store.ts`：`layout.settings` 持久化、get/save、旧 payload 省略 layout 时保留；
  - `src/SettingsView.tsx`：新增「界面」分区、2–8 下拉、默认标记、说明、dirty/保存 payload/status；
  - `src/App.tsx`：Settings Modal 描述 + `DockShell maxGroups={snapshot.settings.layout?.maxDockGroups ?? 6}`；
  - `src/shell/dock/dockGroups.ts`：`effectiveMaxDockGroups`/`canAddDockGroup`/`dockGroupLimitMessage`；
  - `src/shell/dock/DockShell.tsx`：maxGroups prop、`groupLimitRef`、鼠标 `onWillDrop` + 键盘 `moveActivePanel` 统一上限；maxGroups 不在 variant/rebuild effect deps；
  - 测试：`dockGroups.test.ts` 4、`layoutSettings.test.ts` 4、`SettingsView.test.tsx` +1；
  - docs/截图/metrics：`dock-max-groups.md`、`t208-settings-interface-{6,8}.png`、`t208-settings-metrics.json`。
- **未改**：`src/kernel/execution/`、`src/git/`、`src/memory/`、`src/review/`、`electron/`、权限/审批/调度/tool policy。
- **Dock 存档 schema/深链/快捷键/窄窗**：未改；maxGroups 变化只更新 `groupLimitRef`，不触发 `buildDefaultLayout`。

---

## 3. 独立命令复跑

### 3.1 PR worktree（head `c951d75`）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **exit 0** |
| `pnpm build` | **exit 0**：411 modules；js **1,233.53 kB / gzip 338.87**；css **246.17 kB / gzip 29.72**；electron main 1.5MB、preload 11.7kB |
| `pnpm test` | **exit 0**：**63 文件 / 640 用例**（最终独立全量） |

### 3.2 合并后 clean main（`63f8503` + 本文件前）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **exit 0** |
| `pnpm build` | **exit 0**：411 modules；同尺寸 |
| `pnpm test` | **exit 0**：**63 文件 / 640 用例** |

> 说明：本轮在主机高负载下曾出现 2 次既有 5s timeout（`src/kernel/openai.test.ts`、`watchdog.test.tsx` 的 stale-pause 用例），重跑后 640/640 全绿；与 t209/t210 记录的既有 watchdog 5s flake 一致，不是本功能回归。最终证据以 clean main 全绿为准。

---

## 4. 功能验收

### 4.1 默认值与范围

- `DEFAULT_MAX_DOCK_GROUPS = 6`；`MIN=2`、`MAX=8`；`normalizeMaxDockGroups` 非法回 6、越界 clamp。
- fresh store 默认 6；App 旧 snapshot 缺 layout 时回退 6；DockShell 传 `maxGroups`。
- 测试：dockGroups 默认/undefined/string/number/clamp；layoutSettings fresh default、8/99/1 clamp、非数字回 6。

### 4.2 设置入口与即时生效

- Settings 左侧新增「界面」：`最大分栏数` 2–8 下拉，默认 6 标记；说明“保存后立即生效，不会重置当前布局；已超过新上限的已有分栏保留，只拒绝继续拆分”。
- 保存走既有 `saveSettings` IPC；`handleSaveSettings` 成功后 `refresh(workspace.id)`，snapshot 的 `settings.layout` 立即传给 DockShell（无需新 IPC）。
- 截图/metrics：
  - default：`layout.maxDockGroups=6`、select=6；
  - saved8：8、已保存；
  - afterReload：仍 8；
  - restored6：恢复 6（不污染开发 profile）。
- `SettingsView.test.tsx` 新增：点击「界面」→ 选 8 → 保存 → payload.layout.maxDockGroups=8、dirty 清、显示已保存。

### 4.3 分栏边界

`canAddDockGroup(currentGroups, maxGroups) = currentGroups < clamp(maxGroups)`；DockShell 鼠标 `onWillDrop` 与键盘 `moveActivePanel` 共用：

| 上限 | 6 组再拆 | 7 组再拆 | 2 组再拆 | 8 组再拆 |
|---|---|---|---|---|
| 6（默认） | 允许第 6 组 | **拒绝第 7 组** | — | — |
| 2 | — | — | **拒绝第 3 组** | — |
| 8 | — | 允许第 8 组 | — | **拒绝第 9 组** |

- 测试：6 允许/7 拒绝、8 允许/9 拒绝、2 允许/3 拒绝；`dockGroupLimitMessage` 显示当前上限（非硬编码 4）。
- 拒绝文案为 `最多 N 个分栏，请先拖回合并`；`center` 合并放行，拆分型 drop 才计入新组。

### 4.4 持久化与不重置布局

- `settings` 表 key `layout.settings`；`saveLlmSettings` 仅当传入 `layout` 时写，旧调用省略 layout 保留原值；文件 store 重开保持 7。
- maxGroups 变化只更新 `groupLimitRef`，不在变体 effect (`[dockWidth, windowWidth]`) 中；不调用 `buildDefaultLayout`，现有 tab/组/深链/选中不重置。
- N2 low：缺少 DockShell 组件级 rerender 断言；当前由实现检查 + helper 单测 + 真实 Electron 保存/刷新截图覆盖；不阻塞。

---

## 5. 回归检查

- 全量 63/640 覆盖：permission/approval/execution、git/merge queue、memory、review、watchdog、chat、canvas、deeplink、DockShell/narrowWindow、Modal/modalStack 等。
- 变更不含 `electron/`，无新 IPC/通道；无权限/审批/内核/Git/记忆/评审语义改动。
- 深链/快捷键/窄窗：DockShell 仅新增 maxGroups prop 与上限 helper；t194–t197 的 single/Team within/sidebar 逻辑保持不变（PR base 已含 `fc4cbd3`）。
- PR 无冲突、squash merge 后 main clean。

---

## 6. 已知低优先 / 后续

| ID | 内容 | 处理 |
|---|---|---|
| N1 | DockShell 顶部注释仍写“最多 4 组”（行为已用 maxGroups，当前上限动态） | 低；后续文案清理，不影响功能 |
| N2 | 无 DockShell 组件级“maxGroups 变化不 reset”测试 | 低；真实 Electron 保存/刷新证据 + ref 实现；后续可补 |
| N3 | `normalizeMaxDockGroups("")` 得 2 而非默认 6 | 低；仅异常输入；后续清理 |
| N4 | 上限拒绝 toast kind=success | 低；文案已显示当前上限；后续改 warning/info |
| N5 | 既有 watchdog/openai 5s timeout flake | 非本功能；高负载下重跑通过，继续观察 |
| P1 | Dock 多分栏实际拖拽/键盘到 6–8 组无人工截图 | helper 测试 + 代码路径；真实 Electron 当前 workspace 无需 6–8 组；发布前可人工冒烟 |

---

## 7. 合并与清理

- PR #34 **已 squash merge** → main `63f8503`。
- worktree `branches/t208-dock-max-groups` 已删除。
- local branch `feature/t208-dock-max-groups` 已删除；remote branch 已删除。
- 本地 main 先 rebase 到 `63f8503`，保留 t210 review doc commit（`851b468`）；本文件后续提交。
- 当前 `git worktree list` 仅主 worktree；PR 状态 MERGED。

---

## 8. 最终验收

| AC | 证据 | 结论 |
|---|---|---|
| 默认 6/范围 2–8/设置即时生效可追溯 | LayoutSettings、Settings「界面」、App maxGroups、DockShell canAdd、保存后 refresh、截图/metrics | PASS |
| typecheck/build/test 独立通过 | PR head 与 clean main：0/0/63 文件 640 用例；build 411 modules | PASS |
| 6/7/2/8 边界与刷新持久化 | dockGroups 4 + layoutSettings 4；真实 Electron default6→save8→reload8→restore6 | PASS |
| Dock/深链/快捷键/窄窗/权限无回归 | 全量套件；13 文件无 kernel/permission/electron/Git/记忆/评审；maxGroups 不在 rebuild effect | PASS |
| 新增 `docs/team/dock-max-groups-final.md` | 本文件 | PASS |
| PR/合并/worktree | PR #34 MERGED 63f8503；worktree/local/remote branch 清理 | PASS |

**集成结论：PASS，可交付。**
