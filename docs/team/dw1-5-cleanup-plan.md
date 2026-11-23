# DW1-5 清理计划

- **状态**：计划（不在 t562 执行删除）
- **负责人**：ren（实现） / ivy（评审） / kai（集成）
- **明确期限**：**2026-12-15**（Asia/Shanghai）完成 v1 残留清理复核；若 0.0.1 在此前发布，则在发布后 7 天内完成。
- **触发条件**：DW1-4 合并（PR #82）且 0.0.1 发布窗口确认；不得在用户声明 0.0.1 之前删除用户数据。

## 清理范围

1. **v1 布局 key**：`deer.dock.state*` / `deer.dock.v1.*` 旧 localStorage 备份。t556 保留不删、不读；DW1-5 先导出/备份审计，再按 bb-104（0.0.1 前不做历史兼容）删除。
2. **历史脚本文本**：`scripts/t530-cdp.mjs`、`scripts/t548-cdp.mjs` 已改 v2-only；DW1-5 复核是否移除 t530/t548 历史脚本或归档到 docs。
3. **历史文档**：`docs/team/dock-layout*`、`dockview-removal*` 保留 ADR 历史，不参与运行时 grep 门禁。
4. **残留 token/CSS**：`--dv-*` 变量名是视觉 token 兼容层，不是 dockview 依赖；DW1-5 评估是否重命名为 `--dock-*`（非必须，单独 PR）。
5. **验证门禁**：`rg -i dockview src package.json vite.config.ts pnpm-lock.yaml` 为空；`dist/assets` 无 `vendor-dockview`；DockHandle 七方法契约测试保留。

## 不删除

- 用户 v1 布局备份在 t556 保留；不自动迁移到 v2。
- 面板内容、权限、merge/review gate、schema/IPC 不因 DW1-5 改变。

## 期限后的动作

- 2026-12-15 当日由 ren 提交清理 PR（v1 key 删除命令 + 残留 grep 报告），ivy 复审、kai 集成；若用户尚未宣布 0.0.1，则只完成审计、不删除 key，并重新记录下一期限。
