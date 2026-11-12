# P1-2 历史分页 / 翻译恢复 / 轮次重试 · 最终集成验收（t332）

- **任务**：t332 — 集成验收 P1-2，最终集成 t329 + t333/t335 + t334/t336 评审
- **实现**：PR #49 / `feature/t329-history-pagination` @ `7445691`（base main `9fe566f`）
- **验证**：t334 复验 **PASS**（`docs/team/history-translation-recovery-verification-2.md`）
- **评审**：t336 复审 **PASS**（`docs/team/history-translation-recovery-review.md`）
- **PR**：[#49](https://github.com/DeerLuuu/deer-super-group/pull/49) — **MERGED（squash）**
- **合并提交**：`2cbbb71`
- **实现文档**：`docs/team/history-translation-recovery.md`
- **结论**：**PASS，已合并**；worktree 已清理，仅 main。

## 1. 结论

P1-2 已完成最终集成验收：

- **分页**：Chat 初始最近 40 条，加载更早每次 +40；成功合并才推进 `nextBefore`，失败/异常保留可见范围并可重试；`scrollTopAfterPrepend`/`applyHistoryScrollPreservation` 直接写真实滚动容器，prepend 后视口不跳。
- **翻译**：历史 reasoning 共用 `translateHistoryText` 缓存；失败保留原文 + “机翻失败” + 单条重试，不自动无限重试；设置保存成功/翻译指纹变化触发 revision bump + clear，已挂载 reasoning 清旧译文并按需重译。
- **在途请求**：`ChatTurnHistoryReasoning`/`ChatMessageReasoning` 各带 requestId + AbortController + revision 快照；revision 变化先 abort/递增 id，旧响应/旧错误不得覆盖新译文（A slow→B fast→A late 测试保持 B）。
- **轮次失败/取消**：t175 terminal 原因与重试保持；重试仅预填 composer，不发送、不重复用户消息；terminal 回放去重。
- 1440/960 截图沿用；键盘/aria 既有 Chat tabs/composer 行为不变；无消息 schema/权限/gate/数据源变更。

## 2. 需求→实现→验证追溯

| 验收项 | 实现落点 | 验证证据 |
|---|---|---|
| 初始 40 / +40 分页 | App + ChatView + chatHistory | t334 §3；t336 |
| prepend 滚动保持 | `applyHistoryScrollPreservation` 写 node.scrollTop | chatHistory.test 120/700→420；t334 |
| 分页失败不推进/可重试 | `loadEarlierChatTurns` boolean + ChatView await | ChatView 失败测试 message0 未出现；t334/t336 |
| 翻译缓存/失败保留原文/单条重试 | translationCache + reasoning UI | translationCache/App 测试；t334 |
| 设置变化失效/重译 | App translationRevision + clear/bump | translationRevisionApp.test 0→1；t334/t336 |
| 在途旧翻译不覆盖新 | requestId/AbortController/revision guard | t335/t336 复审；ChatTurnUi 测试 |
| 轮次失败/取消重试 | terminal reason/retry 预填 composer | 既有 chat terminal 测试；t329/t334 |
| 1440/960/键盘/aria | 截图 + 既有 Chat tabs/composer | t329 截图；114→117 回归 |
| 无 schema/权限/gate/数据源 | diff 仅 renderer/shared/chat/tests/docs | PR diff；t334/t336 |

## 3. 独立复跑（合并后 main `2cbbb71`）

工作目录：`S:\DeerSuperGroup`（仅 main）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；445 modules
                 # index 312.26 kB / gzip 93.09
                 # vendor-react 206.75 kB / gzip 64.81
                 # CSS index 128.50 kB / gzip 22.05
pnpm test -- --testTimeout=20000 --maxWorkers=2
                 # 117 files / 848 tests passed
```

> 默认 `pnpm test` 仍有既有 openai/watchdog/git 5s 并发 timeout；非本 PR 引入，CI 建议单独超时/串行（t329/t334 已记录）。

## 4. 回归与范围

- **分页/滚动**：加载更早按钮 loading/失败重试/已到最早；成功 prepend 后 scrollTop 保持；server false/throw 不出现旧消息、不推进可见。
- **翻译**：缓存命中不重复请求；失败保留原文 + 单条重试；revision/设置变化清旧译文并重译；在途旧请求不覆盖新 revision。
- **终态**：t175 terminal 原因、重试预填 composer（不发送）、回放去重；Chat tabs/composer/键盘/aria 既有行为保持。
- **范围**：`src/App.tsx`、`src/shared/chatHistory*`、`translationCache*`、`src/shell/chat/`、`src/shell/translationRevisionApp.test*`、`src/styles.css`、tests/docs；`src/kernel/chatTurnUi.test.tsx` 为测试-only 改动（无 kernel 生产代码）。无 schema/IPC/kernel 生产/权限/gate/数据源/依赖变更。
- **截图**：`docs/team/t329-history-translation-1440.png`、`t329-history-translation-960.png`。

## 5. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #49 | MERGED（squash） |
| merge commit | `2cbbb71` |
| main | `2cbbb71`（+ 本报告提交） |
| 实现 worktree | 已移除（清理时终止遗留 t329-ui Electron） |
| 实现 branch | 已删除 |
| 当前 worktree | 仅 `S:\DeerSuperGroup` main |
| 合并后三命令 | typecheck 0 / build 0 / test 117 files/848 |

## 6. 遗留（P1 发布前可补，不阻塞）

1. **无 480 截图**：本批保留 1440/960；窄窗 Chat 历史分页/翻译布局未单独截 480（N1）。
2. **滚动测试为容器 shape**：`applyHistoryScrollPreservation` 用真实容器属性但非浏览器 layout；无像素级 CLS（N2）。
3. **AbortController 未下传 IPC**：本地 abort 阻止 UI 覆盖，但底层请求仍可能完成；低信息（N3）。
4. **失败/取消截图**：本轮未新增失败/取消截图，沿用终端文案测试（N4）。
5. **既有 5s 并发 flake**：非本 PR；建议 CI 串行/提高慢测 timeout（N5）。

**最终结论：P1-2 PASS，PR #49 已 squash 合并到 main `2cbbb71`；历史分页/滚动保持、翻译失效与请求守卫、分页失败保持、轮次终态/重试均已集成验证；无消息 schema/权限/gate/数据源变更；遗留仅发布前可补的 480 截图/CLS/abort 下传项。**
