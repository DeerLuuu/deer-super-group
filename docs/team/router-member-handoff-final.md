# Router 推荐 → 成员创建交接 G5 · 最终集成验收（t418）

- **任务**：t418 — 最终集成 G5：Router 推荐成员 → 一键创建交接
- **集成人**：sol
- **PR**：https://github.com/DeerLuuu/deer-super-group/pull/57（**MERGED**；head `c55d7c2`；squash merge `392dfa7`）
- **基线**：main `2f49755`；合并后 main `392dfa7`
- **结论**：**PASS**。`/team` 只读推荐 → 现有新建成员 Modal 预填 → 人工确认/取消/重名/Mock 分支全部落地；不自动创建、不自动分配任务；`createAgent` 唯一入口、默认 `read_only`；三档/aria 通过；PR 已合并、worktree/branch 清理。

---

## 0. 验收摘要

| 验收项 | 结论 |
|---|---|
| 推荐/预填/确认/取消可追溯 | **PASS**：t415 实现 → t416 PASS → t440 repair → t441 review pass |
| 独立三命令 | **PASS**：typecheck 0；build 0（455 modules）；clean main serial 135 文件/954 |
| 不自动创建/唯一入口/read_only | **PASS**：仅 `/team` 推荐；Modal 需人工确认；createAgent 唯一；默认 read_only |
| 三档/aria | **PASS**：1440/960/480 命令补全 + 1440/480 真实模型 Modal；combobox/listbox/activedescendant/focus/Esc |
| 最终文档 + PR/合并/worktree | **PASS**：本文件；PR #57 MERGED `392dfa7`；本任务 worktree/branch 清理 |

---

## 1. 追溯链

| 阶段 | 任务/产物 | 结论 |
|---|---|---|
| 实现 | t415 PR #57 | `/team` 命令、只读推荐、TeamDialog 预填、取消/重名/Mock、三档截图 |
| 验证 | t416 `router-member-handoff-verification.md` | PASS；N1–N5 |
| 修复 | t440 | 无匹配 Enter 发送、真实 Modal/Esc 回焦、App 级 dispatch、panelDeps、真实模型截图 |
| 复审 | t441 `router-member-handoff-review-2.md` | pass；N1 重复 openPanel 等非阻塞 |
| 集成 | t418（本文件） | PASS、合并、清理 |

---

## 2. 入口与推荐/预填

- 仅显式 `/team` / `/team <描述>`（trim、大小写不敏感）触发；`/teamfoo`、普通“推荐成员/招人”不调用推荐、不弹 Modal；未知 `/xxx` 作为普通消息发送。
- `/` 打开命令面板：`/clear`、`/compact`、`/team` 说明/过滤/无匹配/Esc/Arrow/Enter 插入/Tab/鼠标；`combobox` + `listbox` + `aria-activedescendant`；插入后光标在末尾；`/team ` 参数模式隐藏候选。
- `/team` → 只读 `recommendMembers` → 成功后自动打开现有 `TeamDialog` 新建成员 Modal：
  - Router 推荐 tab；候选姓名/角色/职责/推荐理由/建议模型预填；
  - 默认 `read_only`；`确认聘用` 才调用现有 `createAgent`；编辑后聘用；取消/关闭/逐候选不创建；
  - 多候选逐个；重名禁用；Mock/无模型/错误只 toast，不弹窗。
- 不自动创建、不自动分配任务；不改 `createAgent` 通道/权限/gate；`service.ts` 仅新增提示词文本（不改变工具权限）。

---

## 3. 关键实现边界

- `src/shared/routerMemberHandoff.ts`：`parseTeamCommand` 严格命令边界、`dispatchChatSubmission` 统一 `/clear`/`/compact`/`/team`/普通发送、`extractRecommendationCandidates` 只接受成功推荐结果。
- `App.tsx`：`handleTeamCommand` 只调用只读推荐并设置 `recommendedMembers`；`TeamDashboard` 收到候选后打开现有创建 Modal；`panelDeps` 加入 recommendedMembers，已打开 Team 面板可更新。
- `TeamDashboard`：复用既有 `TeamDialog` 创建流程；候选预填；`read_only` 默认；重名校验；取消/关闭不创建。
- `kernel/service.ts`：仅 Router 提示词增加「普通聊天引导使用 /team，不自动创建」；无新 IPC/schema/权限/创建通道。
- 无自动分配任务；不新增数据源；无新依赖。

---

## 4. 三档 / aria

真实 Electron/CDP 截图（PR 内）：

- `docs/team/t415-command-1440.png` / `t415-command-960.png` / `t415-command-480.png`：`/` 命令面板三档，不裁切；
- `docs/team/t415-team-modal-1440.png` / `t415-team-modal-480.png`：真实模型 `/team` 自动打开候选 Modal（1440/480）。

- 键盘：ArrowUp/Down、Enter 插入（不发送）、Tab、Esc、鼠标；`aria-activedescendant`；真实 textarea `/unknown`、`/teamfoo` 断言 `onSend=1` 且不插入命令。
- 真实 `/team` Modal：Esc 后焦点回 Chat composer；Team 自动打开/取消/关闭不创建；480 键盘路径。
- 集成目视复核：1440 Modal 宽度/候选可读；480 Modal 可滚动、操作按钮可达；命令菜单无横向溢出。

---

## 5. 验证命令

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **exit 0** |
| `pnpm build` | **exit 0**：455 modules；index 328.08 kB / gzip 97.87；TeamDashboard 46.34 / gzip 14.56；CSS 133.61 / gzip 22.77；main 1.6MB/preload 13.4 |
| PR head `pnpm test -- --testTimeout=20000 --maxWorkers=2` | **exit 0**：135 文件/954 用例 |
| clean main serial `pnpm test -- --testTimeout=20000 --maxWorkers=1` | **exit 0**：135 文件/954 用例 |

> 主工作区并行 t432 worktree 会使 Vitest 默认扫描 `branches/**`，集成用干净 detached main checkout 运行；2-worker 在该环境曾出现 worker 崩溃（133/932 + 2 worker errors），serial 全绿；CI 无并行 worktree 不受影响。

---

## 6. 回归 / 范围

- 全量 135 文件/954 用例通过：Chat/命令补全、Team/成员创建、Router 提示、panelDeps、Git/G1/GitInit/Diff、mailbox、Settings、rail/Workflow/NeedsMe/Dock/窄窗。
- 无新 IPC/schema/权限/数据源/依赖；`createAgent` 唯一创建入口；新成员默认 `read_only`；不自动分配任务。
- 非阻塞：`handleTeamCommand` 连续调用 `openPanel("team")` 两次（t441 N1 low）；`onConfirm` void handler（N2 low）；焦点主要以真实走查（N3）；默认 5s flake（N4 info）。
- 工作区其他任务 t432 worktree 保留（非本任务）；本任务 worktree 已清理。

---

## 7. 合并 / 清理

- PR #57 **squash merged** → main `392dfa7`。
- worktree `branches/t415-router-member-handoff` 删除。
- local/remote `feature/t415-router-member-handoff` 删除。
- 集成临时 clean checkout worktree 删除。
- `git worktree list`：主 worktree + 其他任务 t432 worktree。

---

## 8. 最终 AC

| AC | 证据 | 结论 |
|---|---|---|
| 推荐/预填/确认/取消可追溯 | t415/t416/t440/t441 + §2–4 | PASS |
| 独立三命令 | typecheck 0 / build 0 / serial 135/954 | PASS |
| 不自动创建/唯一入口/read_only | §3；Modal 人工确认；createAgent 唯一；默认 read_only | PASS |
| 三档/aria | 1440/960/480 命令；1440/480 Modal；combobox/listbox/activedescendant/focus/Esc | PASS |
| 最终文档 + PR/合并/worktree | 本文件；PR #57 MERGED `392dfa7`；cleanup | PASS |

**集成结论：PASS，可交付。**
