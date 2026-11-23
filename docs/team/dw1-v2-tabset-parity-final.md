# Dock v2 默认 tab 集 parity · 最终集成验收（t607）

- **任务**：t607 — 最终集成 Dock v2 默认 tab 集（t604 实现 → t605 PASS → t606 review）
- **PR**：[#89](https://github.com/DeerLuuu/deer-super-group/pull/89) — **MERGED（squash）**
- **合并提交**：`9099299`
- **实现文档**：`docs/team/v2-default-parity.md`、`docs/team/v2-parity.md`
- **验证/复审**：`docs/team/dock-v2-default-parity-verification.md`（t605 PASS）、`dock-v2-default-parity-review.md`（t606 pass）
- **Parity 结论**：**默认 tab 集差异已关闭**；默认仍 dockview。
- **默认切换结论**：**仍需 Captain/用户确认，本任务不自动切。**

## 1. panels/active 可追溯

`defaultLayout`（`src/shell/dock/layoutModel.ts`）：

- mainPanels = `MAIN_GROUP_ORDER` 中非 `defaultClosed`：**chat / tasks / mailbox / board**。
- wide/medium/narrow：主组 `[chat,tasks,mailbox,board]` active `chat`，team 右组 `[team]` active `team`（权重沿用 VARIANT_WEIGHTS）。
- single：仅主组四项，无 team、无 settings。
- **settings 不在默认 tab 集**；仍注册（`editable/closable=false`），可通过启动器/命令打开。
- **已有 v2 store 不迁移、不重写**；仅新默认布局生成逻辑变化。
- 新增 `defaultTabParity.test.ts`：wide/medium/narrow/single 的 panels/active/组数与 dockview fixture 严格相等，并断言 settings 不在默认。

## 2. 独立复跑（PR HEAD `e6a8033`，main `fef6d86`）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；477 modules；vendor-dockview 保留
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 186 files / 1253 tests passed
```

## 3. 默认 dockview / 已有 store 不变

- 1440/960/480：v2 与 dockview 均 tabs **5/4/4**、groups **2/1/1**、根无横向。
- 默认 `dockview=true / docktree=0`；v2 opt-in 后反转；旧引擎保留。
- v2 store 仅新布局生成逻辑改变；已有 store 不迁移/不重写。
- PR 仅 `layoutModel`/default test/docs/parity 脚本/截图；无业务/依赖/gate/schema/IPC/权限变更。

## 4. Parity 结论（明确）

| 维度 | 结论 |
|---|---|
| 默认 panels/active | PASS（与 dockview fixture 严格相等） |
| settings 非默认、可打开 | PASS（注册仍可经启动器/命令打开） |
| 已有 v2 store | 不迁移、不重写 |
| 三档 tabs/groups | 5/4/4、2/1/1；无横向 |
| 默认引擎 | dockview；v2 opt-in |
| **默认切换** | **不做**；需 Captain/用户确认 |

- 上一轮 t603 遗留的 “v2 settings 6 vs dockview 5” 差异已由本 PR 关闭。
- 默认是否切到 v2 仍需 Captain/用户产品确认；本任务保持 dockview。

## 5. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #89 | MERGED（squash） |
| merge commit | `9099299` |
| main | `9099299` + 本报告提交 |
| t604 worktree | 已移除（旧 t604 harness Electron 占用，已终止） |
| t604 branch | 已删除（local/remote） |
| 当前 worktree | 主工作区 + 其他任务 t576 |

## 6. 遗留（非阻塞）

1. settings 可打开仅断言注册，未做启动器真实点击（N1 low）。
2. 已有 v2 store 不重写缺少独立单测（N2 low）。
3. 既有并行测试时序 timeout（N3 info）。

**最终结论：Dock v2 默认 tab 集 parity PASS，PR #89 已 squash 合并 `9099299`；wide/medium/narrow/single 默认 panels/active 与 dockview 严格一致，settings 非默认但可打开，已有 store 不变，三档 tabs 5/4/4、groups 2/1/1；上一轮 tab 集差异已关闭；默认仍 dockview，切换需 Captain/用户确认。**
