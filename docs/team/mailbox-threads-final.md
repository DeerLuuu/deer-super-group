# M1 邮箱线程化 · 最终集成验收（t359）

- **任务**：t359 — 集成验收 M1，最终集成 t356 + t405 + t409 + t410 复审
- **实现**：PR #55 / `feature/t356-mailbox-threads` @ `249a4cb`（base main `e2ac41a`）
- **复验**：t406 独立复验 **PASS**（`docs/team/mailbox-threads-verification-2.md`）
- **复审**：t410 复审 **PASS**（`docs/team/mailbox-threads-review-2.md`）
- **PR**：[#55](https://github.com/DeerLuuu/deer-super-group/pull/55) — **MERGED（squash）**
- **合并提交**：`5d958f6`
- **实现文档**：`docs/team/mailbox-threads.md`
- **结论**：**PASS，已合并**；t356 worktree/branch 已清理（main 另有其他任务的 active worktree）。

## 1. 结论

M1 邮箱线程化已完成最终集成验收：

- **线程派生**：`deriveMailboxThreads` 优先真实 `parentId`；存量 `thread_id` 聚合；仅整条 thread 无真实 parent 的 legacy 数据按 `thread_id + createdAt` 线性兼容；A→B/A→C 分支；`threadId=根消息 id`，`threadKey` 保留 DB 键。
- **列表/回复链**：按最近活动排序、参与者/消息数/未读/摘要；同 thread 多封聚合；完整回复链缩进（0/14/28px）且 depth/indent 上限 12/6（最大 84px）；当前线程高亮。
- **未读**：按工作区 localStorage 存 read state，刷新/重开 round-trip；全部已读；read ids 按当前消息裁剪；新消息置顶不打断选中。
- **搜索/过滤**：主题/摘要/参与者/正文；成员下拉；无邮件/无结果空态；筛选隐藏当前选中线程时显示显式空态并可清除筛选。
- **深链/跨面板**：`#/mailbox?m=` 定位到包含消息的线程；App 级 Command Palette mock → `onOpenMessage` → MailboxView 定位；真实 Palette UI 由 CommandPalette 测试覆盖。
- **刷新保持**：`mailboxScroll` 锚点（stable id + offset）+ sessionStorage + layout effect；1440/960/480 before/after 刷新滚动/选中/回复链保持，新消息插入后锚点保持。
- **可访问性/三档**：线程列表 `role=listbox/option`、roving tabIndex（active 0/其余 -1）、Arrow/Home/End、`aria-selected`；1440/960/480 无横向。
- **范围**：无新 IPC/权限；未改 Git/PR/merge/gate；read/scroll 仅 UI 存储。**数据模型新增 `messages.parent_id` 可空列（additive migration，旧行 NULL）**，见 §5 N1。

## 2. 需求→实现→验证追溯

| 验收项 | 实现落点 | 验证证据 |
|---|---|---|
| 线程投影/存量兼容 | `shared/mailboxThreads.ts` | mailboxThreads.test；t406/t410 |
| 真实 parentId 回复链 | `Store.parent_id` + `parentId` | store.mailbox.test 真实 DB round-trip/迁移；t410 |
| 列表/聚合/最近活动 | App MailboxView | t356 walkthrough；t406 |
| 未读/全部已读 | read state helper | t356/t405 walkthrough；t406 |
| 搜索/成员过滤/空态 | MailboxView | t356 8 张截图；t406 |
| 刷新/新消息锚点 | mailboxScroll | t405/t409 before/after metrics；t406 |
| 深度/缩进上限 | 12/6 | 50 层测试；t406 |
| 深链/跨面板 | `#/mailbox?m=`/Palette | mailboxAppThread.test；t406 |
| 三档/aria | CSS + listbox/roving | 1440/960/480 截图；t409/t410 |
| 无新 IPC/权限 | diff 仅 UI/shared/store 迁移 | PR diff；t410 |

## 3. 独立复跑（PR worktree HEAD `249a4cb`）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；451 modules
                 # index 324.91 kB / gzip 96.87
                 # CSS 132.84 kB / gzip 22.68
                 # vendor 414.89 / 97.22
pnpm test -- --testTimeout=20000 --maxWorkers=1
                 # 130 files / 922 tests passed
```

> 默认并行仍存在既有 openai/watchdog 5s timeout；serial 全绿。t410 同结论；非本 PR 引入。

## 4. 三档与证据

- 1440：`t356-mailbox-1440.png`、`t356-mailbox-1440-thread.png`、`t356-mailbox-1440-reply.png`、`t356-mailbox-1440-read.png`、`t405-mailbox-1440-scroll-before/after-*.png`。
- 960：`t356-mailbox-960.png`、`t356-mailbox-960-thread.png`、`t409-mailbox-960-before/after.png`（listTop/chainTop/anchor/active 保持，无横向）。
- 480：`t356-mailbox-480.png`、`t356-mailbox-480-thread.png`、`t409-mailbox-480-before/after.png`（scrollWidth=innerWidth）。
- Walkthrough：`t356-mailbox-walkthrough.json`（3 线程、thread_id 3 封聚合、未读 6→全部已读、搜索/过滤/回复预填/ArrowDown aria）；`t405-mailbox-walkthrough.json`；`t409-mailbox-parent-roundtrip.json`（真实 UI 回复→SQLite parent_id）；`t409-mailbox-small-refresh.json`。

## 5. 合并/清理状态与遗留

| 项 | 状态 |
|---|---|
| PR #55 | MERGED（squash） |
| merge commit | `5d958f6` |
| main | `5d958f6`（+ 本报告提交） |
| 实现 worktree | 已移除 |
| 实现 branch | 已删除 |
| 当前其他 worktree | `t401-git-working-diff`（其他任务，未触碰） |

**非阻塞遗留**：

1. **N1 medium（数据模型）**：新增可空 `messages.parent_id` 是 additive schema migration；旧行 NULL、幂等、失败关闭连接。产品/发布说明需确认该 schema 范围；回滚可保留列。它不新增 IPC/外部数据源/权限，但严格意义上不再是“无 schema 变化”。本报告如实记录，未阻塞 M1 集成。
2. **N2 medium**：`parentId` 未在 Store 校验存在性/同 workspace， forged IPC 可写 orphan/跨线程 parent。
3. **N3 low**：回复父节点默认选中线程根，非最后一条；深链到具体回复时才是该回复。
4. **N4 low**：960/480 before/after 截图像素相同，metrics 一致属有意截取同一位置。
5. **N5 low**：App 级 Palette 为 mock；真实 Palette UI 由 CommandPalette.test 覆盖。
6. **N6 low**：旧行 NULL + 混合新老数据时局部 orphan 按顶层展示，已文档化。
7. **N7 info**：plain 并行 5s 既有 flake，serial 130/922 全绿。

**最终结论：M1 PASS，PR #55 已 squash 合并到 main `5d958f6`；线程派生/回复链/未读/搜索/刷新保持/三档/aria 集成验证通过；无新 IPC/权限/外部数据源；`messages.parent_id` 可空 additive migration 作为 N1 需产品确认，不阻塞本次集成。**
