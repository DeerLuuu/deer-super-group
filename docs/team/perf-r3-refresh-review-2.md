# P0-8 R3 复审：刷新去重 / 事件驱动（t289 / t288）

- **评审人**：ivy
- **基线**：`main 29d33fa`；PR #43 / `feature/t282-perf-r3-refresh` HEAD `2d2d379`
- **范围**：t288 对 t284 F1/F2/F3/F4 的修复；事件映射、手动刷新、stale 语义
- **方法**：静态代码 + 独立命令；未修改生产代码
- **结论**：**needs_revision**；1 high + 2 low。事件映射、域 stale 标注和手动失败路径已补，但手动刷新成功只清 UI stale，不清 `RefreshCoordinator.stale`，协调器会继续丢弃后续事件。

---

## 1. 独立验证

```text
pnpm typecheck  # exit 0
pnpm build      # exit 0（434 modules；js1,295.98 kB/gzip358.56；css259.61 kB/gzip31.83）
pnpm test       # plain 2 个既有 5s timeout（openai/watchdog）；t288 extended 98 文件/778
```

- PR #43 OPEN/MERGEABLE；worktree clean；head 2d2d379。
- 已确认：
  - `cost.*`/`provider.*` → watchdog+snapshot；`pr.*` → mergeQueue+snapshot；`run.handoff_created` → runs+watchdog；mapping 单测与 fake-IPC 集成通过。
  - `onStale(domains)` 传失败域；stale notice 标注任务/调度/看门狗/队列/运行/trace，带 `data-stale-domains`；成功/工作区切换清空。
  - 手动刷新失败设置 stale + `invalidateAll` 进入协调器 backoff；成功清 UI stale；`appRefreshIntegration` 覆盖失败 stale/成功清除。
  - 原 coordinator coalesce/单飞/seq gap/generation/backoff/invalidateAll 保持；无 R1/R2、权限/gate/数据层变更。

---

## 2. Findings

### F1 · 手动刷新成功不清 `RefreshCoordinator.stale`，后续事件仍被丢弃（high / P1）

**问题**：`App.refresh()` 成功后只：
```ts
setRefreshStale(false);
setStaleDomains(new Set());
```
但 `RefreshCoordinator` 自己的 `stale` 标志没有清除。`notify()` 开头：
```ts
if (this.stale) return;
```
因此一旦协调器因 3 次失败进入 stale，用户点击手动刷新成功、UI 的 stale notice 消失，**协调器仍处于 stale**；之后新的 task/watchdog/merge 事件全部被 `notify` 丢弃，界面会在无提示状态下再次陈旧，直到 `online`/`visibilitychange` 触发 `invalidateAll`。

t288 的 `appRefreshIntegration` manual 用例用 fake pipeline 的 `stale` 变量断言，**没有断言 `coordinator.isStale()`**，所以未覆盖该路径。

**证据**：
- `src/App.tsx` `refresh()` 成功分支只 setState；
- `src/shell/refreshCoordinator.ts` `notify()` 的 `if (this.stale) return;`；`invalidateAll()` 只在手动失败分支调用；
- `src/shell/appRefreshIntegration.test.ts` manual 用例的 `isStale` 是 fake 的 UI 变量，不是 coordinator 状态。

**影响**：手动“恢复”只修 UI，不修事件驱动；用户以为已恢复，实际自动刷新已停。
**验收句**：**手动刷新成功必须清除 coordinator stale/failures（新增 `markRecovered()` 或复用 `invalidateAll` 的安全恢复语义），并断言 `coordinator.isStale() === false` 后下一条事件能触发 flush。**

### F2 · 手动刷新失败仍 `void refresh(...)`，调用方没有错误承载（medium / P2）

**问题**：t288 让 `refresh()` 失败 `throw` 并 `invalidateAll`，但 UI 手动按钮仍是 `onClick={() => void refresh(...)}`；没有 catch/toast/错误提示。失败时用户只看到 stale notice，无法知道是手动刷新失败还是自动刷新失败；未处理 rejection 也会进入控制台。
**证据**：`App.tsx:3459` 手动按钮；`refresh()` catch throw；t287 N1 仍部分存在。
**验收句**：**手动按钮捕获 refresh 错误并显示明确 toast/inline 文案；不要把 rejection 留给 void。**

### F3 · 手动刷新成功未同步 generation/lastSeq（low / P3）

**问题**：`refresh()` 递增 `refreshTokenRef` 并直接执行 full refresh，但不更新 `refreshGenerationRef`/`refreshLastSeqRef`，也不走 coordinator 的 generation。当前 UI 不使用这两个 ref（N3），但作为恢复路径，后续若用它们判断代际会出现“手动成功但 generation 未推进”的不一致。
**验收句**：**在文档/代码中明确手动刷新不参与 generation，或成功时同步 generation/lastSeq；避免两个恢复路径语义分裂。**

### F4 · run.model_fallback / run.member_switched 仍只映射 runs（low / P3）

**问题**：t288 补了 `run.handoff_created` → runs+watchdog，但同一 watchdog 事件表里的 `run.model_fallback` / `run.member_switched` 仍落入通用 `run.` → 仅 runs。若 RunHistory/handoff 展示依赖 watchdog snapshot 的 handoff，这两个事件不会刷新 watchdog。F1 主路径已修，剩这一处事件等价性需要确认。
**验收句**：**确认 model_fallback/member_switched 是否影响 watchdog handoff/cooldown；若影响，映射 runs+watchdog；若不，加注释与测试固定。**

---

## 3. 验收映射

| 验收 | 结果 | 说明 |
|---|---|---|
| 去重/不漏事件/seq gap 有证据 | passed | coalesce/单飞/seq gap/generation/backoff 测试保持 |
| 轮询移除后有可靠事件更新路径 | passed | cost/provider/pr/handoff 映射已补；F4 为 low 等价性 |
| Rail/Workflow/NeedsMe/panel 不陈旧 | failed | F1 手动成功不清 coordinator stale，后续事件被丢弃；F2 手动失败无 UI 错误 |
| 无 R1/R2 混入/gate/权限/数据层 | passed | 仅 App/coordinator/tests；无 R1/R2、gate/权限/数据层 |
| 三命令 | passed（extended） | typecheck/build 0；plain 2 个既有 5s timeout；extended 778 |
| verdict/findings | needs_revision | F1 high + F2 medium + F3/F4 low |

---

## 4. 结论

**needs_revision**。t288 的事件映射、域级 stale 提示、手动失败 backoff 都有效，F1 主路径已闭合；但手动刷新成功只清 UI stale，不清协调器 stale，后续事件仍被丢弃，这是 R3 恢复语义的真实缺口。补 F1 的 coordinator recovery + 测试，F2 错误反馈后即可复审；F3/F4 low 可同轮处理。
