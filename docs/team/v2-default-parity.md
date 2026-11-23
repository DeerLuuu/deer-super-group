# Dock v2 默认 tab 集对齐（t604 / parity 剩余项）

- **任务**：t604，关闭 t600/t603 parity 唯一未解决项
- **分支**：`feature/t604-default-tab-parity`，基线 main `fef6d86`
- **范围**：`src/shell/dock/layoutModel.ts` + 默认布局/parity 测试、文档/截图/脚本
- **默认引擎**：仍 dockview；v2 仅 opt-in；不删除旧引擎

## 1. 差异清单（对齐前）

dockview `buildDefaultLayout`（v1 fixture）：
- 主组：`MAIN_GROUP_ORDER` 中非 `defaultClosed` 的面板 = `chat, tasks, mailbox, board`，active `chat`；
- wide/medium/narrow：额外 `team` 右组，active `team`；
- single：只有主组，不创建 `team`；
- `settings` 不是默认 tab（由独立弹窗/启动器打开）。

v2 `defaultLayout(variant)` 对齐前：
- wide/medium/narrow 主组 = `chat, tasks, mailbox, board, settings`（多 settings）；
- single = `chat, tasks, mailbox, board, team, settings`（多 team + settings）。

**唯一差异：v2 默认主组多 settings；single 多 team/settings。**

## 2. 修复

`defaultLayout` 现在：
- `mainPanels = MAIN_GROUP_ORDER.filter(key => !PANEL_DEFS[key].defaultClosed)` = `chat/tasks/mailbox/board`；
- wide/medium/narrow：main 组 + `team` 右组，active `chat`/`team`，split 权重仍 `VARIANT_WEIGHTS`；
- single：main 组仅 `chat/tasks/mailbox/board`，active `chat`；
- `settings` 仍注册为 PanelKey、`closable:false`，可经启动器/命令打开；只是不再默认 tab；
- 不改 `PANEL_DEFS`/注册表/loader；已有 v2 store 不迁移、不重写（只有无存档时使用新默认）。

## 3. 测试

- `src/shell/dock/defaultTabParity.test.ts`：
  - 用显式 `DOCKVIEW_DEFAULT_FIXTURE` 对 wide/medium/narrow/single 的 panel 列表、active、组数做**严格相等**断言；
  - 断言所有默认布局不含 `settings`，但 `PANEL_DEFS.settings` 仍存在（可打开）。
- `layoutModel.test` 同步更新 default 断言；
- `layoutOps` split 测试在 single 打开 team 后再验证 max groups 拒绝；
- 全量 serial 结果见任务报告。

## 4. 三档 / side-by-side（v2 vs dockview）

`docs/team/t600-parity-walkthrough.json` 更新：
- v2 1440/960/480 = 5/4/4 tabs、2/1/1 groups、scrollWidth=viewport；
- dockview 默认 = 5/4/4 tabs、2/1/1 groups；
- 默认 dockview `dockview=true/trees=0`；v2 opt-in `trees=1/dockview=false`。
- 截图：`t600-v2-{1440,960,480}.png`、`t600-dockview-{1440,960,480}.png`；v2 1440 主组仅 对话/任务/邮箱/记忆，团队右组同名。

## 5. Parity 结论

- 默认 tab 集差异 **关闭**；交互/几何/持久化此前已 PASS。
- 默认仍保持 **dockview**；是否把 v2 切为默认由 Captain/用户确认，本 PR 不切换。
- 旧引擎/dockview bundle 保留；无新依赖、无业务/gate/schema/IPC/权限变更。
