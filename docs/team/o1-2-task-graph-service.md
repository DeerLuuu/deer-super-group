# O1-2锛歍askGraphService 鍐欒矾寰?+ 浜嬩欢 + PlanDraft 鍘熷瓙寤哄浘

- **浠诲姟**锛歵502 鈥?O1-2锛圓RCH v2 搂2.4/搂2.6 migrate 闃舵锛?- **鑼冨洿**锛氫换鍔?owner/dependency 鐨勫敮涓€鍐欒竟鐣屻€乺elation+鏃у垪闀滃儚+鏂板浜嬩欢鍚屼簨鍔°€丳lanDraft/router plan 鍘熷瓙寤哄浘锛涗笉鏀?scheduler/UI 璇汇€乺eview/merge gate銆佹潈闄愩€両PC銆?- **缁撹**锛歚TaskGraphService` + Store 鍙楁帶 graph 鍐欒矾寰勮惤鍦帮紱浜嬩欢涓庡叧绯?闀滃儚鍚屼簨鍔★紱澶辫触鍥炴粴锛汸lanDraft/router plan 鍗曚簨鍔″缓鍥俱€?
## 1. 鍐欒竟鐣?
`src/kernel/taskGraphService.ts`锛?
- `createTask(ownerId?, dependsOn?)`锛氭牎楠?owner/deps 鍚庡垱寤?task锛坄task.created` 鎼哄甫瀹屾暣 owner/deps 蹇収锛夈€?- `setOwner(taskId, ownerId, {assignedBy, reason, actor})`锛氭牎楠屽悓 workspace/瀛樺湪鎬э紱鏇存柊 `task_owners` + `tasks.owner_id`锛沘ppend `task.owner_changed`銆?- `setDependencies(taskId, dependsOn, {reason, actor})`锛氭牎楠屽悓 workspace/瀛樺湪鎬?鑷緷璧?閲嶅/鐜?鈮?00锛涙洿鏂?`task_dependencies` + `tasks.depends_on`锛沘ppend `task.dependencies_changed`锛涙寜渚濊禆鐘舵€侀噸绠?ready/blocked锛坄task.status_changed`锛夈€?- `updateTask` 鏅€氬瓧娈碉紙鏍囬/鎻忚堪/status/branch 绛夛級浠嶇敱 Store 澶勭悊锛涘惈 owner/deps 鐨?patch 鐢?Store 鍐呴儴璺敱鍒板悓涓€ graph 鍘熻锛屼緵鏃ц皟鐢ㄦ柟锛堝 out-of-scope git merge captain锛変繚鎸佸彈鎺ч暅鍍忋€?
绋冲畾閿欒鐮侊細`TASK_NOT_FOUND`銆乣TASK_OWNER_NOT_FOUND`銆乣TASK_OWNER_WORKSPACE_MISMATCH`銆乣TASK_DEPENDENCY_NOT_FOUND`銆乣TASK_DEPENDENCY_WORKSPACE_MISMATCH`銆乣TASK_DEPENDENCY_SELF`銆乣TASK_DEPENDENCY_DUPLICATE`銆乣TASK_DEPENDENCY_CYCLE`銆乣TASK_DEPENDENCY_LIMIT`銆乣TASK_HAS_DEPENDENTS`锛涘潎鎶?`TaskGraphError.code`銆?
## 2. 鍚屼簨鍔?/ 浜嬩欢

- `setOwner`/`setDependencies` 鍦?`Store.withTransaction` 鍐呭啓 relation + 鏃у垪 + 浜嬩欢锛涘け璐ユ暣浣?ROLLBACK锛堝惈 owner/deps/闀滃儚/浜嬩欢锛夈€?- 鏂颁簨浠讹紙schemaVersion=2锛夛細
  - `task.owner_changed`锛歚{taskId, from, to, assignedBy, reason}`锛涘箓绛夐敭 `task:<id>:owner:<from|none>:<to|none>:v<eventCount>`锛堢増鏈繚璇?A鈫払鈫扐鈫払 鍥涙鐪熷疄鍙樻洿閮借惤搴擄紱澶辫触閲嶈瘯/閲嶅鍚屽€间粛骞傜瓑锛夈€?  - `task.dependencies_changed`锛歚{taskId, from[], to[], reason}`锛涘箓绛夐敭 `task:<id>:deps:<hash(from)>:<hash(to)>:v<eventCount>`銆?- `task.updated` 涓嶅啀鎵胯浇 owner/deps锛堟櫘閫?UI patch 缁х画锛夛紱`task.created` 淇濈暀瀹屾暣蹇収銆?- 浜嬩欢娉ㄥ唽琛ㄦ柊澧?`task.owner_changed`/`task.dependencies_changed`/`task.deleted` zod strict schema锛沗task.deleted` 鎶曞奖浼氬垹闄?task/owner/dependency/run/summary 琛岋紝閲嶅缓鏃朵笉浼氭妸宸插垹闄や换鍔′粠鏃?task.created 澶嶆椿銆?- projection replay 澧炲姞 owner/deps 浜嬩欢澶勭悊锛屽苟娓呴櫎/閲嶅缓 relation 琛岋紱`rebuildProjections` 鍏堟竻 relation 鍐嶆竻 tasks锛岄伩鍏?RESTRICT銆?- `gitService` 鐨?conflict task create/merge-captain owner 鍐欏叆鏀硅蛋 `TaskGraphService`锛涘叏浠撴棤 service 澶?owner/deps SQL銆?
## 3. PlanDraft / router plan

- `confirmPlan`锛氬灞?`withTransaction` 鍐呯敤 `TaskGraphService.createTask`锛坥wner锛? `setDependencies`锛坉raft id鈫抰ask id锛? priority + `router.plan` 骞傜瓑浜嬩欢锛涗换涓€澶辫触鏁存壒鍥炴粴銆?- `plan`锛圧outer 鐢熸垚璁″垝锛夛細鍚屾牱鍖呭崟浜嬪姟锛屼换鍔?渚濊禆/`router.plan` 涓€璧锋彁浜わ紱涓嶅啀閫愪釜 `createTask` 鍚庡啀 update deps銆?- owner/deps 鏍￠獙澶辫触浼氬洖婊氭暣鎵癸紝涓嶇暀涓嬩换鍔?杈?浜嬩欢銆?
## 4. 娴嬭瘯

`src/kernel/taskGraphService.test.ts`锛?1 渚嬶級锛?
- create owner/deps + 鏃у垪/relation 闀滃儚/浜嬩欢锛?- setOwner/setDeps 骞傜瓑銆佷簨浠堕『搴忋€乣task.updated` 涓嶅惈 owner/deps锛?- A鈫払鈫扐鈫払 owner/deps 鍥涙鐪熷疄鍙樻洿鍧囦繚鐣欙紝`rebuildProjections` 鍚?relation/鏃у垪/鏈€缁堢姸鎬佷竴鑷达紱
- owner 缂哄け/璺?workspace銆佷緷璧栫己澶?璺?workspace/鑷緷璧?閲嶅/鐜牎楠屽強鍥炴粴锛?- 缁勫悎 graph patch 鍚庢澶辫触鏃?owner 鍥炴粴锛?- >100 渚濊禆澶辫触锛?- 渚濊禆婊¤冻/鍥為€€鏃?ready/blocked 鐘舵€?reset锛?- `TASK_HAS_DEPENDENTS` deleteTask 鎷掔粷锛?- rebuildProjections 鍚?relation 鍙粠浜嬩欢鎭㈠锛?- create鈫抩wner/deps鈫抎elete鈫抮ebuildProjections锛歵ask=null銆乺elation 鏃犺銆乨igest 涓嶈鏁般€乼ask.deleted 浜嬩欢淇濈暀锛?- kernel/service/git 婧愭棤鐩存帴 owner/deps SQL锛坓it 璧?TaskGraphService锛夈€?
`src/git/git.test.ts` 鏂板 conflict task merge-captain owner 缁?TaskGraphService 鐨勬祴璇曪紱`src/kernel/planDraft.test.ts` 8 渚嬫柊澧?non-null owner 鎸佷箙鍖栥€傚叏閲?174 鏂囦欢/1144 鐢ㄤ緥閫氳繃銆?
## 5. 鍛戒护

```text
pnpm typecheck
pnpm build
pnpm test -- --testTimeout=30000 --maxWorkers=1
```
