# RC1-3 鍏?renderer infer锛坱564锛?
## 1. 鑼冨洿

鍦?RC1-2锛坰hell/git UI infer锛夊熀纭€涓婏紝灏?**`src/**/*.tsx`** 鍏ㄩ儴绾冲叆 React Compiler infer 鐨?allowlist锛?
- 鍖呭惈锛歚src/App.tsx`銆乣src/shell/**`锛堝惈 DW1-4 绋冲畾鍚庣殑 `src/shell/dock/**`銆乣PanelHost`銆乣LazyPanel`锛夈€乣src/git/ui/**`锛屼互鍙婂叾浣?renderer `.tsx`锛?- 鎺掗櫎锛堥潪 renderer/涓嶆敮鎸侊級锛歚src/kernel/`銆乣src/review/`銆乣src/watchdog/`銆乣src/memory/`銆乣src/shared/`銆乣electron/`銆乣scripts/`銆乣dist/`銆乣dist-electron/`銆乣node_modules/`銆佹墍鏈?`*.test.*`/`__tests__/**`銆侀潪 `.tsx`锛?- 榛樿 `pnpm build`/`pnpm test` **浠嶄笉缂栬瘧**锛沗build:compiler`/`test:compiler` 浣跨敤 `RC1_MODE=infer`锛?- 涓嶅垹闄ゆ墜宸?memo锛涗笉鏀逛笟鍔?API/鐘舵€佹満/鏉冮檺/gate/schema/IPC锛涙棤 runtime 渚濊禆銆?
## 2. 楂橀闄?opt-out锛?0 涓枃浠讹紝淇濈暀 RC1-2 鐨?11 涓?+ 鏂板 8 涓級

鏂板鐞嗙敱锛?
| 鏂囦欢 | 鐞嗙敱 |
|---|---|
| `src/App.tsx` | renderer 鏍圭姸鎬?璺敱/鏉冮檺/浜嬩欢妗?澶ч噺 effect锛岄闄╂渶楂橈紝淇濇寔鏍圭粍浠跺師璇箟 |
| `src/shell/LazyPanel.tsx` | Suspense/lazy 鐢熷懡鍛ㄦ湡涓庨敊璇噸璇曡竟鐣?|
| `src/shell/panel/PanelHost.tsx` | useSyncExternalStore/闈㈡澘璁㈤槄/鍙鎬ц竟鐣?|
| `src/shell/dock/DockShellV2.tsx` | 甯冨眬 controller 鍛戒护銆佺劍鐐广€佹柇鐐瑰垏鎹?|
| `src/shell/dock/DockTree.tsx` | 閫掑綊 split/group/pointer/鐒︾偣/鎷栨斁 |
| `src/shell/dock/DockGroup.tsx` | tablist/tab 鐒︾偣銆乸anel keepalive銆佸叧闂?鎷栨斁 |
| `src/shell/dock/DockSash.tsx` | pointer 鎷栨嫿/閿洏 Arrow/Home 璋冩暣灏哄 |
| `src/shell/dock/DockDropZone.tsx` | 鎷栨斁鐩爣/鍛戒腑鍖哄煙 |

RC1-2 宸叉湁鐨?11 涓?`use no memo`锛圫eparatorControl銆丒rrorRecoveryBar銆丗irstRunCard銆丆hatLiveBridge銆丮emoryWorkbench銆丳lanDraftPanel銆丳ollPanel銆丟itDiffViewer銆丟itGraphPanel銆丮ergeQueuePanel銆丟itAiDraft锛夊叏閮ㄤ繚鐣欏苟缁х画鐢?boundary test 鏍￠獙銆?
## 3. 鏋勫缓/鍖呬綋

| 鎸囨爣 | 榛樿 build锛堟棤 compiler锛?| 鍏?renderer infer | 鍙樺寲 |
|---|---:|---:|---:|
| 鎬昏€楁椂锛堟湰鏈?warm锛?| **1015 ms** | **6271 ms** | +5256 ms |
| Vite renderer | **221 ms** | **5070 ms** | +4849 ms |
| `index` | 384.02 kB / gzip 114.36 | 432.50 kB / gzip 136.92 | **+48.48 kB** |
| `vendor-react` | 210.54 kB / gzip 65.71 | 210.71 kB / gzip 65.81 | +0.17 kB |
| CSS | 151.25 kB / gzip 25.70 | 151.25 kB / gzip 25.70 | 0 |
| renderer sourcemap | 鍏抽棴锛堟棦鏈夛級 | 鍏抽棴锛堟湭鏀癸級 | 鏃?|
| Electron main/preload | 鏃㈡湁 esbuild | 鏃㈡湁 esbuild锛堟湭鎺?compiler锛?| 鏃?|

- 鍏?renderer infer 鐨勫浐瀹氬紑閿€鏄庢樉锛圴ite +4.85s/index +48.5kB锛夛紝杩欐槸鍏ㄩ噺缂栬瘧鑷姩 memo 鐨勭洿鎺ユ垚鏈紱涓嶅绉版€ц兘鎻愬崌銆?- 楂橀闄╂枃浠惰櫧鐒?no-memo锛屼粛鍙兘鍥犲悓鏂囦欢鍐呴儴闈炵粍浠跺嚱鏁?鏋勫缓 hash 鍙樺寲鍑虹幇鍦ㄤ骇鐗╀腑锛汥ock 缁勪欢鐢?DW1-4 绋冲畾娓叉煋鍣ㄦ彁渚涖€?
## 4. 鍗曟祴 / 涓夋。 / 浜や簰

- `pnpm test`锛堥粯璁や笉缂栬瘧锛夛細**180 鏂囦欢 / 1226 鐢ㄤ緥鍏ㄧ豢**锛坧lain 鏈夋棦鏈?5s flake锛泂erial/extended 288.93s 鍏ㄧ豢锛夈€?- `pnpm test:compiler`锛坕nfer锛夛細**87 鏂囦欢 / 440 鐢ㄤ緥鍏ㄧ豢**锛坮enderer shell/git/root 缁勪欢娴嬭瘯锛夈€?- 鐪熷疄 Electron锛坈ompiler build锛孲ettings 鐣岄潰锛夛細
  - 1440/960/480 涓夋。锛歚scrollWidth===innerWidth`锛汼ettings modal 瀹?1180/912/432锛屾棤妯悜锛?  - radio 3 涓紱ArrowRight锛氭爣鍑嗏啋澶э紝focus/aria 姝ｇ‘锛?  - 鎴浘 `t564-infer-settings-{1440,960,480}.png`銆佷氦浜?`t564-infer-settings-interaction-1440.png`銆?- 琛屼负锛氬叏閲忛粯璁ゆ祴璇曚笌 renderer compiler 娴嬭瘯鍧囬€氳繃锛涙棤鎵嬪伐 memo 鍒犻櫎/API/鐘舵€佹満鍙樻洿銆?
## 5. 楠岃瘉/鍥炴粴

- `pnpm typecheck` 鈫?0
- `pnpm build` 鈫?0锛堥粯璁ゆ棤 compiler锛?- `pnpm test` 鈫?180 鏂囦欢/1226锛坰erial/extended 鍏ㄧ豢锛沺lain 鏃㈡湁 5s flake锛?- `pnpm build:compiler` 鈫?0锛坕nfer锛?- `pnpm test:compiler` 鈫?87 鏂囦欢/440 鍏ㄧ豢

鍥炴粴锛氫繚鎸?`RC1_COMPILER` 鏈缃紱鎭㈠ RC1-2 allowlist锛坄src/shell/` + `src/git/ui/`锛夊苟鍒犻櫎 8 涓柊澧?no-memo 鏂囦欢鍒楄〃锛涗粠鑴氭湰绉婚櫎 `RC1_MODE=infer`锛涙棤闇€ DB/schema/IPC/鏉冮檺杩佺Щ銆?
[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

