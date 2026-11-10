# DeerSuperGroup 行级评审与合并门禁 · 最终集成报告（t156）

- **任务**：t156 `[integration]` 集成验收：行级评审
- **设计依据**：`docs/team/line-review-design.md`（t148/t150/t151；PR #7 已合并 `5a99385`）
- **实现文档**：`docs/team/line-review-implementation.md`（t154/t159/t163）
- **最终基线**：`main` = `e29af04`（PR #10 squash 合并，2026-11-10T00:31:26Z）
- **验收环境**：Windows / pnpm 12 / Node 24；无 Electron 窗口（真机人工项单列）
- **结论**：**4/4 验收通过**（评审链 + PR 合并 + diff/评论/blocker/门禁/UI 全链路 + 三命令 + 文档）

---

## 1. 验收结论（t156 acceptance 4/4）

| # | 验收项 | 结论 | 证据 |
|---|--------|------|------|
| 1 | t155 pass，t154 PR 已合并 | ✅ | 设计：t151 pass，PR #7 MERGED（`5a99385`）。实现：t154 → t155 needs_revision（F1 required gate 可被自动合并绕过 / F2 diff 绕过 GitExec 安全层 / F3 AC 覆盖不足）→ t159 修复 → t160 needs_revision → t163 修复（全状态 gate、GitExec 安全参数、UI grid、AC 边界）→ **t164 verdict=pass**（N1–N3 仅低优先，不阻塞）。PR #10 head `8f2e7fb`、`mergeStateStatus=CLEAN`、`mergeable=MERGEABLE`，集成轮 `gh pr merge 10 --squash` → **MERGED `e29af04`**；t154 worktree 已清理（`pnpm branch:remove t154-line-review`，worktree 移除 + 本地分支删除）。 |
| 2 | diff/评论/blocker/门禁/UI 全链路可追溯 | ✅ | `src/review/{types,store,diff,anchor,service}.ts` + `src/review/ui/ReviewSection.tsx` 全部在 main；ReviewSection 挂载任务详情（`App.tsx:3207`）；`review=1` 深链 + 命令面板入口；IPC 40 个 review 类型/方法；electron `git:merge-approve` / `git:merge-start` → `assertMergeAllowed`，`git:merge-process` → `assertQueueAllowed`（main.ts:250/257/261）；review 测试 29 例（service 17 / anchor 4 / diff 4 / diff.git 2 / UI 2）全绿。 |
| 3 | typecheck/build/test 全绿 | ✅ | main `e29af04`：exit 0 / 0 / 0（详见 §5）。 |
| 4 | `docs/team/line-review-final.md` 交付 | ✅ | 本文件（集成报告，含实现映射、评审链、AC 复核、验证、低优先项与后续）。 |

---

## 2. 评审与合并链路

| 轮次 | 任务 | 结论 | 关键内容 |
|------|------|------|----------|
| 设计 | t148/t150/t151 | pass | P0 仅模式切换、`requiredApprovals` lowering 移 P1；AC-RV-32/P1-REV-01 一致；PR #7 合并 `5a99385` |
| 实现 | t154（kai） | completed | `src/review/` + IPC + main gate + ReviewSection；40 文件 / 480 测试 |
| 首轮评审 | t155（max） | **needs_revision** | F1 `git:merge-process` 绕过 required gate；F2 `ReviewDiffProvider` 裸 `execFile`、diff 未统一 redact；F3 AC 覆盖不足（reanchor rename/base、review=1、grid、通知去重等） |
| 修复 2 | t159（kai） | completed | `assertQueueAllowed` 覆盖 ready/merging/updating；diff 复用 GitExec；partial AC 补 UI/深链/rename/rollback/PR event；41 文件 / 487 |
| 复审 2 | t160（max） | needs_revision | gate 未覆盖 queued/waiting_checks/waiting_review；GitExec allowlist 参数缺失；UI 非 grid；AC 仍 partial |
| 修复 3 | t163（kai） | completed | 全状态 `assertQueueAllowed`；GitExec 安全参数（no-ext-diff/no-textconv/no-color/find-renames/cat-file）；ReviewSection `role=grid/row/gridcell`+roving+200 行窗口；AC-RV-15/18/27/31 更新；41 文件 / 492 |
| **终审** | **t164（max）** | **pass** | 全状态 gate、diff 安全、UI grid、AC 边界/rollback/rename anchor/PR event 全部闭环；N1–N3 低优先不阻塞 |
| 合并 | 集成轮（ray） | MERGED | PR #10 `8f2e7fb` → squash `e29af04`；t154 worktree/branch 清理 |

> 说明：t155/t160 作为中间轮次保持 `failed`（首轮/二轮结论），最终门禁由 **t164 pass** 承接，与 t70→t95、t71→t131、t65→t81 的团队口径一致。

---

## 3. 最终代码映射（main `e29af04`）

| 模块 | 文件 | 关键实现 |
|------|------|----------|
| 类型 | `src/review/types.ts` | ReviewConfig/Target/DiffFile/Thread/Comment/Decision/ReviewSummary；severity blocker/major/minor/info；mode required/advisory/off |
| 存储 | `src/review/store.ts` | 独立 `review_schema`（config/target/diff files/reviewers/threads/comments/decisions/reanchor log）；target 与 head/diff_hash 绑定；评论 edited/deleted 用 bodyHash 入事件（正文不入事件）；thread resolve/reopen |
| diff/SHA | `src/review/diff.ts` | 只读 git diff/cat-file/unified parser/分页/截断/二进制识别；复用 `GitExec`（allowlist + hooksPath + realpath + redactSecrets；no-ext-diff/no-textconv/no-color/find-renames） |
| anchor | `src/review/anchor.ts` | 旧行 + 上下文唯一匹配；duplicate/deleted/rename/base 前进；outdated 标记与 reanchor log |
| 服务 | `src/review/service.ts` | target 懒创建（首建 required）；decision revision（request_changes→approve/reject）；remove/replace reviewer；config 危险变更 confirm + 清 `approved_head_sha`/`checks_waived` + 回 waiting_review；`assertMergeAllowed`/`assertQueueAllowed` 全状态门禁 |
| UI | `src/review/ui/ReviewSection.tsx` | 任务详情内评审区（不新增 Dock）；diff 行 `role=grid/row/gridcell` + `aria-rowcount/rowindex` + roving tabIndex/Arrow/Enter；200 行窗口 + 上一页/下一页；评论/线程/blocker/decision；`role=alert` 错误、`role=status` 播报；`review=1` 聚焦 |
| IPC | `src/shared/ipc.ts`、`electron/main.ts`、`electron/preload.ts` | review:* 全套（summary/diff/threads/comments/resolve/reopen/severity/decisions/assign/remove/replace/target/config）；主进程 gate 前置 |
| 接线 | `src/App.tsx`、`src/CommandPalette.tsx`、`src/shared/deeplink.ts`、`src/styles.css` | 任务详情 ReviewSection；`review=1` 深链、命令面板「打开评审」；样式 28 个 `.review-*` 规则 |
| 安全/审计 | `src/git/gitExec.ts` | allowlist 扩展（diff/cat-file/rev-parse/merge-base 只读）；`redactSecrets` 统一输出；review 事件 `target_created/author_unknown/thread/comment/decision/config`；PR event best-effort `ensureTarget` |

**与 Git/合并队列**：`git:merge-approve`/`merge-start` → `assertMergeAllowed(taskId)`；`git:merge-process` → `assertQueueAllowed(workspaceId)`；覆盖 queued/waiting_checks/waiting_review/ready/merging/updating，required + autoMerge 的 queued/waiting_checks 不 entering merging（service.test 断言）。`src/git` 仅改 `gitExec` allowlist，未改合并队列语义。

---

## 4. AC 复核（行级评审 P0）

| AC 组 | 结论 | 证据 |
|-------|------|------|
| diff/SHA/diff_hash/rebase re-anchor（AC-RV-02/03/04/31 等） | ✅ | `diff.git.test` 真实 git diff/redaction；`anchor.test` unique/duplicate/deleted/rename/base 前进；target lazy 创建绑定 head SHA/diff_hash；`review=1` 深链与命令面板入口 |
| 评论/线程/edited/deleted/blocker/remove-replace/decision（AC-RV-05–12/17/19） | ✅ | `service.test` 17 例：thread/comment/edit/delete、blocker→resolve→approve、request_changes→approve revision、remove/replace reviewer、config mode、author_unknown、bodyHash 审计 |
| required/advisory/off 与 approved_head_sha/checks 门禁（AC-RV-13/14/15/18/27/32） | ✅ | `assertMergeAllowed`（approve/start）+ `assertQueueAllowed`（process，全状态）；required+autoMerge queued/waiting_checks 不 merging；config required↔off/advisory 危险变更 confirm、清批准/waiver、回 waiting_review；unavailable_reason fail-closed + rollback |
| UI/ARIA/窄屏/大 diff（AC-RV-20/23/26/28 等） | ✅ | ReviewSection 真实挂载；grid/row/gridcell + aria-rowcount/rowindex + roving Arrow/Enter；200 行窗口/分页（N1 非虚拟列表低优先）；`role=alert/status`；样式窄屏；组件测试 |
| 安全（AC-RV-25 等） | ✅ | ReviewDiffProvider 复用 GitExec 白名单/hooksPath/realpath；统一 `redactSecrets`；评论正文不入事件（bodyHash）；Agent 写拒绝；作者快照防自批；diff 上限/分页 |
| 通知/审计/与 PR 链路（AC-RV-19/24 等） | ✅ | review.* 事件 + `review.author_unknown`；PR event best-effort ensureTarget + 去重；通知失败不阻断；decision 写 decision 记录；与 Git PR head 变化联动（head 变化清审批） |
| 既有能力回归 | ✅ | main-only 41 文件 / 492 用例全绿：权限 44、审批 11、service 7、kernel 43、Git AC-MQ 全套、Poll 2 文件、记忆 5 文件、画布/提问、Markdown、星图、Dock、深链等；PR #10 未触碰 kernel/memory/watchdog/permission/approval。 |

---

## 5. 三命令与测试计数（main `e29af04`）

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `pnpm typecheck` | 0 | `tsc --noEmit` 无错误 |
| `pnpm build` | 0 | `dist/assets/index-*.css` 225.85 kB（gzip 26.37 kB）；`index-*.js` 1,187.25 kB（gzip 325.78 kB）；`dist-electron/main.cjs` 1.3 MB、`preload.cjs` 9.8 kB |
| `pnpm test` | 0 | 见下 |

- **合并前（t154 worktree `8f2e7fb`）**：typecheck 0 / build 0 / test 0（41 文件 / 492 用例）。
- **main-only 权威口径**（`npx vitest run --dir src`）：**41 文件 / 492 用例**全部通过；`not wrapped in act` 警告 0。
- **仓库根 `pnpm test`**：**78 文件 / 978 用例**全部通过（含 `branches/t144-watchdog-cost` worktree 测试；t154 worktree 已在合并后清理）。
- 行级评审测试：`service.test 17`、`anchor.test 4`、`diff.test 4`、`diff.git.test 2`、`ReviewSection.test.tsx 2` = **29 例**。

---

## 6. 低优先项与已知边界（不阻塞，已由 t164 记录）

1. **N1（low）大 diff 虚拟化**：当前为 200 行窗口 + 分页，不是设计中的真正虚拟列表；AC-RV-26 证据按「窗口 + 分页」记录。后续可补虚拟化或正式调整 AC 证据。
2. **N2（low）gate 位置**：required 门禁在 `electron/main.ts` IPC 前置；`GitService/MergeQueue` 直接调用 `processQueue` 的内部路径无 gate。建议后续下沉到 GitService（需改 src/git，本轮遵循 out of scope 未动）。
3. **N3（low）ReviewSection 组件测试**：仅 2 项（grid/rowcount/Enter），缺 Arrow/Escape/窄屏/load-more 断言；建议补齐。
4. 未执行真实 Electron 人工冒烟（无窗口环境）：AC-RV-26/28/31 的 UI/大 diff/真机交互以组件测试 + 构建产物为准；建议发布前按设计 §13 清单补测。
5. checks 仍由 Git 侧负责（review gate 读取 checks 状态，不执行 CI）；review 表为 additive，不自动 drop。
6. 现有 workspace 默认 `advisory`；P0 单 human / 1 approval（多 human、requiredApprovals lowering 属 P1-REV-01）。
7. review 配置无独立设置面板（危险变更走任务页 service/config 接口；UI 后续补）。

---

## 7. 后续

1. **watchdog 成本 PR #9** 目前 OPEN（head 2bdf772），main 已前进到 `e29af04`，合并前需 `branch:sync` 并复跑三命令。
2. N1–N3 低优先改进可在独立小任务处理（虚拟列表、gate 下沉 GitService、UI 交互断言）。
3. 真实 Electron 人工冒烟：评论/blocker/decision/键盘/窄屏/深链。
4. 与 Git 合并队列的深度集成（checks 执行器、审批 UI 统一）按设计 P1 继续。

---

## 8. 复现

```bash
cd S:\DeerSuperGroup
git log --oneline -2          # e29af04 feat(review) ... (#10) / 996d4bb docs(poll) ...
pnpm install                  # 无新增依赖；沿用现有 node_modules
pnpm typecheck                # exit 0
pnpm build                    # exit 0
npx vitest run --dir src      # 41 files / 492 tests（main-only）
pnpm test                     # 78 files / 978 tests（含 branches/ worktree）
```

参考：
- 设计：`docs/team/line-review-design.md`（§12 AC、§13 人工清单）
- 实现：`docs/team/line-review-implementation.md`（§6 AC 映射、§7 边界）
- 合并记录：PR #7（`5a99385`，设计，MERGED）、PR #10（`e29af04`，实现，MERGED；head `8f2e7fb`）

---

> t156 集成验收完成：行级评审与合并门禁已在 main `e29af04` 合并，diff/评论/blocker/required 门禁/UI 全链路可追溯，三命令全绿；N1–N3 与真机人工冒烟为已披露低优先项，不阻塞本次集成结论。
