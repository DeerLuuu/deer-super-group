# 记忆工作台与运行时接入（t123）

> 设计依据：`docs/team/memory-system-design.md`（t89 通过）与已合并的记忆核心 `src/memory/`（t101）。
> 分支：`feature/t123-memory-workbench`；独立 worktree `branches/t123-memory-workbench/`；PR 待创建。
> 本文记录**实际接线**、验证、AC 映射与遗留；不改 `src/memory/` 核心 schema/算法。

## 1. 交付范围

| 层 | 文件 | 说明 |
|----|------|------|
| 运行时适配 | `src/shared/memoryRuntime.ts` | MemoryStore/MemoryService 构造、human/agent actor、workspace/agent 归属校验、输入长度/枚举/TTL 校验、snapshot/search/board/memo/maintenance/context |
| Agent 工具 | `src/shared/memoryTools.ts` | `memory.search`、`memory.context`、`memory.memo.write`、`memory.board.list`、`memory.board.post`；无 pin/verify/archive/decide/promote 路径 |
| IPC 类型 | `src/shared/ipc.ts` | 15 个 memory/board/memo 方法 + `getMemoryContext` |
| 主进程 | `electron/main.ts` | `memory:snapshot/search/maintenance/context`、`board:*`、`memo:*` 通道；统一 `handle` 错误包装 |
| preload | `electron/preload.ts` | 仅类型转发，无业务逻辑、无 token |
| 服务接线 | `src/kernel/service.ts` | `AppService.memory`、工具注册、worker prompt 注入 memory context、`memory.context_injected` 审计、`getContext` 增加 memory section |
| UI | `src/shell/MemoryWorkbench.tsx` | 黑板/备忘录/归档审批三页签；领域 Tab、状态/TTL/stale/pin、提升 decision、归档审批、检索结果 citations/breakdown/budget、成员私有备忘录 |
| App 集成 | `src/App.tsx`、`TeamDashboard.tsx`、`CommandPalette.tsx`、`shell/dock/panelRegistry.ts` | `board` panel/route 保留，显示名改「记忆」；团队页入口；命令面板/深链仍走 `#/board?b=` |
| 样式 | `src/styles.css` | 仅主题 token（无 hex/rgb 裸色）；窄窗、focus-visible、reduced-motion |
| 测试 | `src/shared/memoryRuntime.test.ts`、`src/shell/MemoryWorkbench.test.tsx` | 运行时读/写/治理/校验、SSR 三页签/ARIA/loading |

## 2. 运行时接线

- `AppService` 构造 `MemoryRuntime`；MemoryStore 迁移失败时 `memory.available=false`，IPC/UI 显示错误，不影响其他面板。
- **P0 仅人类治理**：pin/verify/TTL/archive propose/decide/promote 只走 human actor IPC；Agent 工具表没有这些命令；Agent memo 写入强制 `agentId=ctx.agentId`。
- **owner 四层过滤**：UI 只有显式选择成员才传 `agentId`；MemoryRuntime 校验 agent 属于 workspace；MemoryService 再强制 agent scope；snapshot 未传 agent 时 memos 为空。
- **检索**：`searchMemory` 强制 scopes 不含 doc（P1），query≤200/limit≤50/budget≤4000；UI 显示 citations、score breakdown、used/max/omitted。
- **上下文**：worker Run 在 system prompt 后注入 memory context（600 token 预算，untrusted header 由核心生成）；发 `memory.context_injected` 审计（无正文）；`getContext` 增加 `memory` section，可在上下文面板查看。
- **工具**：`createMemoryTools(this.memory)` 注册在 builtin 工具之后；工具输出裁剪，不含 contentHash/他人私有 memo。

## 3. UI 行为

- 三页签 `role=tablist/tab/tabpanel`，←/→/Home/End；页签选择 localStorage 持久化，损坏回退黑板。
- 黑板：领域 Tab（含计数）、状态（活跃/待复核/已归档）、kind chips；卡片显示 kind/domain/confidence/pin/TTL/stale/verified/source/refs；操作常显：置顶（aria-pressed）、复核、TTL、提升决策、建议归档、复制引用；已归档只读显示。
- 备忘录：成员选择器（Router 默认）、tags/kind/搜索、私有提示；复核/提升/归档。
- 归档审批：pending 数量 badge；优先显示 entrySnapshot，旧提案无快照回退提示；批准/拒绝走 Modal；「检查过期条目」调用 human maintenance。
- 检索：内联结果区（非 dropdown），`details` 可展开，citations 可复制，`role=status` 播报；空/降级/错误文案；无 hover-only。
- 发布/备忘录/审批/提升均复用 `Modal`（Esc/焦点陷阱/遮罩确认）；成功/失败 `Toast`（App 注入 `pushToast`）。
- 窄窗 CSS：≤700px 工具栏纵向、操作按钮换行；`prefers-reduced-motion` 关闭动画；仅用主题 token。

## 4. AC 映射

| 验收 | 状态 | 证据/备注 |
|------|------|-----------|
| AppService/IPC/tools 记忆 API 可用 | passed | `AppService.memory`、15 个 IPC、5 个工具；typecheck/运行时测试 |
| 权限/审计/token 安全 | passed | human-only governance；agent tool 无治理；输入校验；无 token/正文入审计；`memory.context_injected` 仅计数 |
| 三页签、领域/TTL/stale/pin/提升/归档审批 | passed | MemoryWorkbench；SSR 三页签/ARIA/loading；archive propose/decide |
| 归档恢复（P1） | passed | `restoreBoardEntry` 人类恢复 + 已归档条目列表（additive SQL，不改 core schema） |
| 检索 citations/breakdown/预算 | passed | `SearchResults` 显示 citations、score breakdown、used/max/omitted；runtime 测试 |
| 任务上下文注入可见 | passed | worker prompt + `getContext` memory section + `memory.context_injected` 审计 |
| owner 四层过滤 / P0 人类治理 | passed | UI 显式 agentId；runtime 校验；MemoryService 过滤；无 Agent 治理工具/IPC |
| Dock/Markdown/Modal/Toast/主题/窄窗、键盘/ARIA/aria-live | passed | board panel 保留；Markdown/Modal/Toast；三页签键盘、focus-visible、窄窗；manual-only 键盘/窄屏走查待真机补充（P1） |
| 三命令全绿、独立 worktree/PR、最小改动 | 见 §5 | 三命令；新 worktree；未改 `src/memory/` |
| docs/team/memory-workbench.md | passed | 本文 |

## 5. 验证与遗留

### 验证（worktree）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0（399 modules；js 1,157.51 kB / gzip 318.08；css 217.99 kB / gzip 25.05；electron main 1.3mb / preload 7.5kb）
pnpm test        # 32 文件 / 436 用例（含 memory runtime 3 + MemoryWorkbench 2）
```

### 遗留 / 风险

1. **归档恢复 P1 已接线**：`restoreBoardEntry` 通过 additive SQL 恢复 archived 状态并重建索引；未改 `src/memory/` schema/service。后续若要并入核心，应迁移到 MemoryService。
2. **真机 Electron 冒烟**：无头环境未执行完整键盘/窄窗人工走查；SSR + CSS 断点 + focus-visible 为自动化证据，建议发布前补。
3. **MemoryStore 启动迁移**：首次启动会备份/VACUUM；大库启动耗时需 Tauri/Electron 实测；失败降级为 memory unavailable。
4. **Agent 旧工具**：`board.post/board.list/memo.write/memo.search` 仍走旧 Store（兼容），新增 `memory.*` 工具走新核心；两套并存期需迁移（P1）。
5. **事件注册**：`memory.context_injected` 等 Git/memory 事件尚未注册 t68 eventRegistry；当前走 Store.appendEvent，UI 用事件前缀刷新。
6. **IPC 与核心方法差异**：核心无 `setMemoExpiry`/restore，故未暴露对应 IPC；memo 过期通过创建时 `expiresInDays` 设置。
7. **scope 例外**：为注入工具/上下文，修改了 `src/kernel/service.ts`（不在 t123 原始 in-scope 列表）；属运行时接线必需的最小改动，需评审确认或调整 scope。

## 6. 回滚

- 关闭入口：UI/命令面板可回到旧 BoardView（保留 `board` panel key）；`MemoryRuntime` 失败自动降级。
- 代码回滚：删除 `memoryRuntime.ts`/`memoryTools.ts`/`MemoryWorkbench.tsx`，还原 `App.tsx`/`TeamDashboard.tsx`/`CommandPalette.tsx`/`panelRegistry.ts`/`styles.css`/IPC/preload/main/service；核心 `src/memory/` 不动，DB 新增表可保留（memory_schema 独立）。
- 数据：MemoryStore 自有迁移备份 `memory_schema`，不触碰 kernel `user_version`。
