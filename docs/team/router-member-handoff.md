# Router 推荐成员 → 一键创建交接（t415 / G5）

- **任务**：t415 实现 G5：Chat Router 成员推荐交接到 TeamDashboard 创建表单，保留人工确认。
- **分支**：`feature/t415-router-member-handoff`
- **范围**：只读 `recommendMembers` + 现有 Team create Modal；不新增 schema/IPC 创建通道；不自动创建/分配任务；`createAgent` 仍是唯一创建入口。
- **结论**：实现完成，待独立评审/合并。

## 1. 入口：`/team` 命令（唯一触发）

用户在 Chat 输入框发送：

```text
/team
/team 缺一个可访问性评审
/TEAM 需要一个发布工程师
```

规则（App `handleSendChat` 命令层，与 `/clear`、`/compact` 同层）：

- `trim` 后、大小写不敏感，**只有 `^/team(\s+描述)?$` 才进入推荐流程**；
- `/team` 不进入普通 `sendChat`，不会把命令原文作为普通聊天发给 Router；
- `/team <描述>` 以 `description` 模式调用只读推荐；无参数以 `team-gap` 模式；
- 普通消息即使包含「推荐成员/招人/缺什么角色」也**不**调用 `recommendMembers`、**不**弹 Team Modal；Router prompt 会提示用户使用 `/team 推荐成员`；
- 未知 `/xxx` 仍可作为普通消息发送（按原 composer 发送方式），不会被命令解析拦截。

## 2. 命令补全面板

Chat composer 输入以 `/` 开头时显示命令补全（`App.ChatView`）：

| 命令 | 说明 |
|---|---|
| `/clear` | 清空当前对话上下文 |
| `/compact` | 压缩上下文，保留最近对话 |
| `/team` | 推荐成员并打开新建成员弹窗（可带描述） |

行为：

- 实时按前缀过滤：`/c` → clear/compact；`/t` → team；无匹配显示「无匹配命令」；
- ArrowUp/Down 移动高亮；Enter 选中并**插入命令文本**（不直接发送）；Tab 补全；Esc 关闭；鼠标点击可选；
- 插入 `/team ` 后进入参数模式并隐藏补全；
- composer 保持焦点；textarea `role=combobox` + `aria-autocomplete=list`、`aria-expanded`、`aria-controls`、`aria-activedescendant`；面板 `role=listbox`、项 `role=option`、`aria-selected`；
- 面板绝对定位在 composer 上方、`z-index:80`、max-height + overflow，三档不裁切；480 边距收紧。

## 3. 推荐 → 自动打开创建 Modal

1. `/team` → App 调用 `window.deer.recommendMembers`（现有只读 API，不新增 IPC）。
2. 成功且候选非空 → `setRecommendedMembers(candidates)` + `openPanel("team")`；TeamDashboard 接收 candidates，自动打开**现有「新建成员」Modal**（`AgentDialog`），默认 `Router 推荐` tab，候选卡片显示：
   - 姓名 / 角色 / 切入点（responsibilities）/ 理由 / 建议模型；
   - read_only、skills/risks、详情。
3. 不自动创建：卡片「聘用」先展开「确认聘用」；确认后走现有 `onCreate`（`createAgent`），默认 `read_only`；「编辑后聘用」进入现有手动表单，字段可编辑；取消/关闭 Modal 不创建；多候选一次选择一个（不批量自动建）。
4. 失败/空候选：只 toast 错误，不打开 Modal；重名候选沿用 `nameConflict`（禁用聘用并提示编辑）；Mock/无模型时推荐 API 返回错误，不打开 Modal；Modal 内若缺失模型/Mock 会显示提示并禁用聘用（防御性）。
5. 焦点/Esc/回焦复用统一 `Modal`；真实 Electron `/team` 自动弹窗后按 Esc，焦点回到 Chat composer（`aria-label=给 Router 发消息`）；取消关闭不创建。Team panel 的 `recommendedMembers` 已加入 `panelDeps`，否则 PanelHost 缓存不会让已打开的 Team 面板收到新候选。

## 4. 范围与安全

- 不新增 schema/IPC/权限/gate/数据层；不自动创建成员、不自动分配任务；不修改 `createAgent` 语义。
- 推荐仍是只读；创建仍由 TeamDashboard 的用户确认提交；`read_only` 默认不变。
- 推荐契约错误码/模型校验沿用现有 `RecommendMembersResponse`（MOCK_UNSUPPORTED/NO_MODEL_CONFIGURED/RECOMMEND_*）。
- 不改变现有 Chat `/clear`、`/compact`、普通发送、历史/工具轨迹。

## 5. 测试与运行

新增/更新：

- `src/shared/routerMemberHandoff.test.ts`：`/team`、`/TEAM`、前导空格、`/team 参数` 解析；普通文字/`/teamfoo` 不触发；候选提取；`dispatchChatSubmission` 的 `/unknown`、`/teamfoo` send、`/team` team、`/clear`/`/compact` 分支。
- `src/kernel/chatTurnUi.test.tsx`：命令面板打开/过滤/键盘/鼠标/Esc/无匹配；无匹配 Enter 关闭并 onSend；`/unknown`、`/teamfoo` 走 send 且不插入；ArrowUp/focus/aria-activedescendant 与 480 键盘路径；参数模式隐藏。
- `src/shell/panel/panelHost.test.tsx`：`recommendedMembers` 只 bump team，不误渲染其他面板。
- `src/shell/routerMemberHandoff.test.tsx`：候选自动打开、预填字段、聘用前不创建、确认后 `read_only` 创建、编辑、取消/关闭不创建、重名禁用、Mock 禁用。
- `src/kernel/service.ts`：Router prompt 明确普通聊天要用 `/team`、不创建成员；无普通意图推荐调用。

```text
pnpm typecheck   # 0
pnpm build       # 0（455 modules）
pnpm test -- --testTimeout=20000 --maxWorkers=1
                 # 135 files / 954 tests passed
```

> 默认并行有既有 openai/watchdog 5s timeout；serial 全绿。

## 6. 截图

- `docs/team/t415-command-1440.png`
- `docs/team/t415-command-960.png`
- `docs/team/t415-command-480.png`
- `docs/team/t415-team-modal-1440.png`（真实模型推荐，3 候选自动弹窗）
- `docs/team/t415-team-modal-480.png`

真实 Electron + 临时 userData 副本；`/team` 调用真实 `deepseek-flash` 推荐模型自动打开 Team 新建成员 Modal；Esc 后 CDP 断言 `activeElement` 回到 Chat composer。

## 7. 风险 / 回滚 / 遗留

- **回滚**：移除 `/team` 命令分支与 `CHAT_COMMANDS`/命令面板、TeamDashboard `recommendedMembers` 初始化；不影响普通 Chat/创建入口。
- `/team` 带描述会触发一次真实只读推荐模型调用；无模型/Mock 返回错误且不弹窗。
- 推荐候选仍需用户在 Modal 内确认；不自动分配任务。
- 已知非阻塞：命令补全没有独立 480 键盘截图；真实模型推荐取决于配置；自动 Modal 截图未伪造。
