# 首用就绪、错误恢复与空态（t247 / P0-7）

## 1. 首用就绪卡

`src/shell/firstRunData.ts` 从现有 snapshot 派生，不新增数据源：

| 检查 | 来源 |
|---|---|
| 工作区 | `snapshot.workspace.path` |
| 模型 | `settings.models` + `settings.model` |
| Key / Mock | `settings.mock` 或 provider `apiKeySource !== "none"` |
| 成员 | 非 Router、非 offline 成员数 |

- 显示条件：未就绪，或工作区为空（无任务且无对话）。
- 卡片显示工作区身份、模型/Key/Mock、成员数；未就绪只给**唯一** CTA（打开工作区 / 设置模型 / 配置 Key / 创建成员），就绪空工作区给「开始对话」。
- 「稍后」折叠为 `首用就绪检查` chip，不阻塞主界面；状态诚实，不因 Router 存在而显示可执行。
- 截图：`docs/team/t247-first-run-1440.png`、`-960.png`。

## 2. 错误恢复横条

`src/shell/errorRecovery.ts` + `ErrorRecoveryBar`：

- 先用共享 `sanitizeErrorText` 脱敏（`sk-*`、Authorization、URL 凭据、provider body 等），再分类。
- 分类：未配置 Key / 认证失败 / 限额限流 / 网络失败 / 未知。
- 每类只给 1 个恢复动作：
  - Key/认证 → 去设置；
  - 限额 → 切换模型（打开设置）；
  - 网络 → 重试（refresh + loadChat）；
  - 未知 → 查看详情（显示同一脱敏摘要）。
- 关闭是唯一 secondary；不展示原始 provider body/凭据；不新增敏感信息。

## 3. 空态 CTA

| 面板 | 图标 | 一句解释 | CTA |
|---|---|---|---|
| Chat | ◎ | 和 Router 讨论目标 | 开始对话（聚焦 composer） |
| Team | ✦ | 创建执行成员 | 新建成员（仅 Router 时） |
| Tasks | ✓ | 还没有任务 | + 新建任务（唯一） |
| Memory | ◇ | 发布记忆条目 | + 发布记忆条目（既有） |
| Mail | ✉ | 给成员/Router 发邮件 | 发邮件（既有） |

空态不写入数据、不改变 WorkflowRail/NeedsMe 投影。

## 4. 术语（gate 不变）

- 任务交付批准：`批准任务交付`（aria 明确 task delivery gate）。
- 代码评审通过：`ReviewSection` 代码评审（说明「代码评审通过不等于任务交付批准」）。
- 合并确认：只在合并队列执行（Team「合并队列」aria-label；Git tab 说明「Git/入队不是合并确认」）。
- 未通过 review 不能 merge 的既有 gate 不变。

## 5. 测试 / 验证

新增：
- `firstRunData.test.ts`（3）：缺 Key CTA、无成员 CTA、就绪对话、Mock、已有内容隐藏。
- `FirstRunCard.test.tsx`：4 检查、唯一 primary、折叠 chip。
- `errorRecovery.test.ts`（2）：分类/单一动作、凭据脱敏。
- `ErrorRecoveryBar.test.tsx`：认证错误只显示一个 primary 并回调设置。
- `terminology.test.ts`：三类批准文案/aria guard。

```text
pnpm typecheck
pnpm build
pnpm test
```

## 6. 风险 / 回滚

- 仅 UI/派生逻辑；无新数据源、权限/状态机/gate 变更。
- 首用卡可用「稍后」折叠；错误横条关闭不改变底层状态。
- 回滚删除 t247 提交即可；相关文件独立（firstRun/errorRecovery/EmptyState 调用）。
