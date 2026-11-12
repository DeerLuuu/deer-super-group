# Router 推荐成员三入口最终集成验收（t275）

- **任务**：t275 — 集成验收：Router 推荐成员 / 手动设定 / 描述生成
- **实现链**：t269 设计 → t272 三入口实现 → t273 独立验证 → t278 repair-round-2 → t280 repair-round-3 → t281 review pass
- **PR**：[#42](https://github.com/DeerLuuu/deer-super-group/pull/42) — **MERGED（squash）**
- **合并提交**：`3c45768`（2026-11-12）
- **实现文档**：`docs/team/router-member-recommendation.md`；设计 `router-member-recommendation-design.md`
- **验证/评审**：`router-member-recommendation-verification.md`、`-review.md`、`-review-2.md`
- **结论**：**PASS，可交付**；PR 已合并，t272 worktree/branch 已清理。

## 1. 结论

Router 推荐成员三入口已完成最终集成验收：

- **三入口**：新建成员 Modal 的 `Router 推荐 / 自己设定 / 描述生成` tabs；编辑已有成员不显示推荐 tab/CTA，仍只用手填。
- **默认入口**：真实模型（非 mock）默认 A（Router 推荐）；mock/无可用模型默认 B（自己设定），A/C 禁用并说明原因；不伪造推荐。
- **严格推荐 schema**：顶层 `candidates` 1–3；字段白名单/`additionalProperties=false`；模型必须在 `settings.models`；`permission` 只允许 `read_only`；重名/Router 名/未知字段/非法 model/错误 permission 整份拒绝；0 候选 `EMPTY`。
- **安全 prompt**：workspace/path/overview/member/task title+description/description/model label/recent 全部 `sanitizeErrorText` + 字段 cap；recent 每条约 500、最多 8 条；provider prompt 不含 secret/URL query/internal URL。
- **聘用**：显式两步确认；一次一个候选；编辑后聘用；双击 `hiringRef` 单飞；重名/Router 阻断；失败保留可重试；`writeThenRefresh` 刷新失败不重复创建。
- **唯一创建入口**：`createAgent` 唯一创建；store 固定 `read_only`；IPC `agent:create` `stripCreateAgentPermission` 丢弃 permission/isRouter 等未知字段；`recommendMembers` 只读不写 store；无新表/字段/迁移/批量 API。
- **失败/边界**：mock/无模型 A/C 禁用；429→`RECOMMEND_RATE_LIMITED`、401→`RECOMMEND_AUTH_FAILED`、timeout/empty 明确 code，inline error+重试/手动 fallback，不自动创建。
- **UI**：1440/960 截图；960 三 tab 单行无横向滚动；tab/aria/status/alert/group 存在；无 gate/权限语义/数据层变更。

## 2. 需求→实现→验证追溯

| 验收项 | 实现落点 | 验证证据 |
|---|---|---|
| 三入口 tabs | `TeamDashboard` 成员 Modal；`src/shared/memberRecommendation.ts` | memberRecommendation 8 例；t273 |
| 编辑无推荐 tab | `memberRecommendation.test.tsx` | `editing an existing member has no recommendation tabs/CTA` |
| 默认 A/B | 真实模型→A；mock/无模型→B | `defaults to Router tab...`、`disables A/C in mock mode` |
| 严格 schema/白名单 | shared schema | schema 5 例（未知字段/非法 model/permission/重名） |
| 1–3 候选/0 EMPTY | schema + service | schema 5；service 3；UI fallback |
| read_only | schema + store + IPC strip | createAgentInput 2；service `smuggles permission`；IPC guard |
| prompt 脱敏/cap | service `buildPrompt` + shared sanitizer | service redaction 3；schema prompt 测试 |
| 429/401/timeout/empty | service codes + UI inline | service 3；memberRecommendation 8 |
| 两步聘用/单飞 | TeamDashboard `hiringRef` | memberRecommendation 8（double confirm） |
| 重名/Router/role 冲突 | parser/UI | schema/service/UI |
| 刷新失败 writeThenRefresh | App handleCreateAgent | `writeThenRefresh` 2；UI |
| 唯一创建入口/无第二源 | `createAgent` only；recommend 只读 | service 9（read_only）；diff 无表 |
| 1440/960 | tabs/候选卡/表单 | `t272-member-recommend-1440.png`、`-960.png` |
| 无 gate/权限语义变更 | diff 无 gate/权限/调度 | 96/766 回归；t281 |

## 3. 独立验证（合并后 main）

工作目录：`S:\DeerSuperGroup`（main `3c45768`；worktree 仅 main）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；433 modules
                 # js 1,290.85 kB / gzip 356.89
                 # css 259.61 kB / gzip 31.83
                 # electron main 1.5 MB / preload 12.0 KB
pnpm test        # 默认 5s 下 openai/chat terminal flake；20s 超时 96 files / 766 tests 全绿
```

> 说明：PR worktree 默认 5s 首轮出现既有 openai/chat-turn-terminal 5s timeout（后者清理失败为 EPERM 次生错误）；`--testTimeout=20000` 后 96/766 全绿，合并后 main 同口径全绿。该 flake 与成员推荐无因果关系，保留为 P1 测试稳定性项。

## 4. 安全/聘用/1440/960 证据

1. **schema**：memberRecommendation.schema 5 例覆盖候选数、字段白名单、模型白名单、read_only、重名/Router/坏 JSON/未知字段。
2. **service**：3 例覆盖 429/401、timeout/empty、recent secret 脱敏；不写 store、不自动创建。
3. **prompt**：t280 注入 workspace/path/overview/任务标题/任务 description/描述/model label secret，provider prompt 不含原文。
4. **IPC**：`stripCreateAgentPermission` 丢弃 permission/isRouter 等未知字段；service 夹带 full_access 仍 read_only。
5. **UI**：8 例覆盖默认 tab/候选卡/显式两步聘用/double confirm/mock 禁用/失败 fallback/描述生成/编辑无 tab/manual read_only。
6. **1440/960**：截图覆盖 tabs/候选卡/表单；960 三 tab 单行，无横向滚动。
7. **无 gate/权限语义**：review/merge gate、任务状态机、Agent 权限模式未改；新成员实际 read_only。

## 5. 范围/兼容性检查

- PR #42 合并 22 文件：`src/TeamDashboard.tsx`、`src/App.tsx`、`src/shared/{memberRecommendation,types,ipc}.ts`、`src/kernel/{service,service.test}.ts`、`electron/{main,preload}.ts`、`styles.css`、tests、docs/截图。
- **无** `src/kernel/permission*`/`approval*`/`execution/`/scheduler、`src/memory/`、`src/git/`、`src/review/` 改动；无 gate/权限模式/任务状态机/数据层变更。
- 无 agent 表/字段/迁移/批量 API；`createAgent` 仍是唯一创建入口；recommend 只读。
- 合并前 PR #42 OPEN/MERGEABLE/CLEAN，head `b5a756e`（含 t273/t281 报告）；合并后 main `3c45768`；t272 worktree 已移除，branch 已删除。
- 清理时 t272 worktree 被遗留 `t272-ui` Electron 冒烟进程占用；终止该测试进程后由 `branch:remove`/目录删除完成，无生产影响。
- 当前 main 有 4 个与 t275 无关的未跟踪 docs（dock-max-groups、narrow-window 系列，属其他任务）；t275 未删除/修改它们。

## 6. 遗留项（P1/低优先，不阻塞）

1. **真实 Electron 全链路**：推荐→聘用→Team 刷新/权限展示有组件/service 测试，缺真实 Electron 端到端（t273 N6）。
2. **真实 provider 错误形态**：429/401/timeout 有映射；其他 provider body/网络错误需补 fixture。
3. **权限 defense-in-depth**：IPC strip + store read_only + CreateAgentInput 无 permission；后续新增入口仍需复用同一 guard。
4. **prompt 新字段**：当前自由文本统一 sanitize+cap；未来新增上下文源需加入同一测试矩阵。
5. **批量/多候选聘用**：一次一个（多候选备选）；批量 API 未做。
6. **既有 5s flake/EPERM 次生**：openai/chat terminal 偶发；建议提高慢测 timeout 或拆分 fake clock。

## 7. 合并/清理状态

| 项 | 状态 |
|----|------|
| PR #42 | MERGED（squash） |
| 实现 head / 文档 head | `9eb80ea` / `b5a756e` |
| merge commit | `3c45768` |
| main | `3c45768`（+ 本报告提交） |
| t272 worktree | 已移除（清理时终止遗留 `t272-ui` Electron 进程） |
| t272 branch | 已删除 |
| 当前 worktree | 仅 `S:\DeerSuperGroup` main |
| 最终三命令 | typecheck 0 / build 0 / test 96 files/766（20s 超时） |

**最终结论：PASS；Router 推荐/手动/描述生成三入口、严格 schema/白名单、安全 prompt、两步聘用与唯一 read_only 创建入口均已完成集成。残余为 P1 真机/provider 边界/测试稳定性项，不阻塞交付。**

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
