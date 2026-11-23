# RC1-0 React Compiler spike + renderer build boundary锛坱510锛?
## 1. 缁撹

鍦?Vite 8.3.6 + React 19.3.1 + `@vitejs/plugin-react` 5.1.2 涓嬶紝React Compiler **鍙敤**锛屼絾 RC1-0 鍙仛杈圭晫鍑嗗涓庡崟缁勪欢 spike锛?*涓嶆敼鐢熶骇缁勪欢銆佷笉鏀瑰彉榛樿鏋勫缓璇箟**锛?
- 鏂板鍥哄畾 devDependency锛歚babel-plugin-react-compiler@1.0.0`锛?*MIT**锛寀npacked **3,880,402 bytes锛堢害 3.88 MB锛?*锛屾棤杩愯鏃朵緷璧栵紱
- 鍙厑璁?`src/shell/SkipLink.tsx` 涓€涓潪鍏抽敭缁勪欢锛沰ernel/review/watchdog/memory/shared/electron/scripts/tests 鍏ㄩ儴鎺掗櫎锛?- `pnpm build` 榛樿 **涓嶅惎鐢?*缂栬瘧鍣紙鍩虹嚎涓嶅彉锛夛紱`pnpm build:compiler` 閫氳繃 `RC1_COMPILER=1` 鏄惧紡澶嶇幇 spike锛?- 榛樿 `pnpm test` 涓嶇紪璇戯紱`pnpm test:compiler` 閫氳繃 `VITEST_REACT_COMPILER=1` 瀹氬悜缂栬瘧 SkipLink锛?- 鏃?DB schema/浜嬩欢/鏉冮檺/IPC/runtime 渚濊禆鍙樻洿銆?
## 2. 渚濊禆涓庤鍙瘉

| 椤?| 鍊?|
|---|---|
| package | `babel-plugin-react-compiler` |
| version | **1.0.0**锛坧ackage.json 鍥哄畾绮剧‘鐗堟湰锛?|
| license | **MIT** |
| unpacked size | **3,880,402 bytes**锛坄pnpm view ... dist.unpackedSize`锛?|
| dependency | `@babel/types ^7.26.0`锛坉ev 宸ュ叿閾撅級 |
| runtime | **鏃?*锛坉evDependency锛涗笉寮曞叆 `react-compiler-runtime`锛?|

## 3. 缂栬瘧杈圭晫

`src/shell/reactCompilerBoundary.ts`锛堢函閰嶇疆锛屼笉杩涘叆 renderer runtime锛夛細

- allowlist锛歚src/shell/SkipLink.tsx`锛?- exclude锛歚electron/`銆乣scripts/`銆乣src/kernel/`銆乣src/review/`銆乣src/watchdog/`銆乣src/memory/`銆乣src/shared/`銆乣dist/`銆乣dist-electron/`銆乣node_modules/`銆乣**/*.test.*`銆乣**/__tests__/**`锛?- `isReactCompilerBuild`锛氶粯璁?`false`锛沗RC1_COMPILER=1` 涓?`command=build` 鎵嶅惎鐢紱`VITEST`/`NODE_ENV=test` 寮哄埗鍏抽棴锛沗VITEST_REACT_COMPILER=1` 鏄嫭绔嬪畾鍚戞祴璇曞紑鍏筹紱
- `reactCompilerPluginOptions.sources` 鏄枃浠剁骇鏈€缁?guard锛岄槻姝?Vite 鎶婃彃浠跺簲鐢ㄥ埌 allowlist 澶栵紱
- `scripts/build-electron.mjs` 瀹屽叏鏈帴鍏?Babel/Compiler锛沚oundary test 璇诲彇鑴氭湰鏂█鏃?`babel-plugin-react-compiler`/`reactCompilerBoundary`銆?
Vite 閰嶇疆锛?
- `pnpm build` / `vite build`锛歚react()` 榛樿锛屾棤 Babel compiler锛?- `pnpm build:compiler`锛歚cross-env RC1_COMPILER=1 vite build && pnpm build:electron`锛?- `pnpm test`锛歏itest 鐨?Vite 閰嶇疆 branch 妫€娴?`VITEST`锛屼笉鍔犺浇鎻掍欢锛?- `pnpm test:compiler`锛歚cross-env VITEST_REACT_COMPILER=1 vitest run ...` 瀹氬悜楠岃瘉 SkipLink + boundary銆?
## 4. Spike 閲忓寲

浠呯紪璇?`src/shell/SkipLink.tsx`锛岀敓浜ф簮鐮佹湭鏀瑰姩銆傝褰曡 `docs/team/rc1-build-metrics.json`銆?
| 鎸囨爣 | 榛樿 build锛堟棤 compiler锛?| `build:compiler` | 鍙樺寲 |
|---|---:|---:|---:|
| 鎬昏€楁椂锛堟湰鏈?warm锛?| **1018 ms** | **2357 ms** | +1339 ms |
| Vite renderer build | **242 ms** | **1570 ms** | +1328 ms |
| `index` | 369,017 B / gzip 109.84 kB | 369,147 B / gzip 109.92 kB | **+130 B** |
| `vendor-react` | 206,755 B / gzip 64.81 kB | 206,922 B / gzip 64.91 kB | **+167 B** |
| CSS | 150,017 B / gzip 25.44 kB | 150,017 B / gzip 25.44 kB | 0 |
| renderer sourcemap | 鍏抽棴锛堟棦鏈夐厤缃級 | 鍏抽棴锛堟湭鏀癸級 | 鏃犲彉鍖?|

- 杈撳嚭 hash锛氶粯璁?`index-fKm9xc49.js` / `vendor-react-BUpqyDsC.js`锛沜ompiler `index-DckQwIra.js` / `vendor-react-Bcerwr7Q.js`銆?- compiler runtime 鐢?React 19 鐩爣鎵胯浇锛屾湭鏂板 runtime package锛汦lectron main/preload 杈撳嚭涓庤€楁椂鏈彈 compiler 褰卞搷锛坋sbuild 鐙珛鏋勫缓锛夈€?- 鍗曠粍浠?Babel pass 鐨勫浐瀹氬紑閿€鏄庢樉锛堢害 +1.3s锛夛紝杩欐槸 RC1-1 鎵╁ぇ allowlist 鍓嶉渶瑕佺户缁噺鍖栫殑鎴愭湰锛涙湰 PR 涓嶅洜姝ゅ紑鍚粯璁ょ紪璇戙€?
## 5. 楠岃瘉

- `pnpm typecheck` 鈫?**0**
- `pnpm build` 鈫?**0**锛堥粯璁ゅ熀绾匡紱index 369.01 kB / gzip 109.84锛孋SS 150.01/gzip 25.44锛?- `pnpm build:compiler` 鈫?**0**锛坈ompiler 杈撳嚭濡備笂锛?- `pnpm test -- --max-workers=1 --testTimeout=20000` 鈫?**174 鏂囦欢 / 1136 鐢ㄤ緥鍏ㄧ豢**
- `pnpm test:compiler` 鈫?**2 鏂囦欢 / 6 鐢ㄤ緥鍏ㄧ豢**
- 杈圭晫娴嬭瘯 `src/shell/reactCompilerBoundary.test.ts`锛氱増鏈?璁稿彲璇併€侀粯璁ゆ祴璇曚笉缂栬瘧銆乤llowlist/exclude銆乲ernel/electron/scripts 鎺掗櫎銆丒lectron 鏋勫缓鑴氭湰鏃?compiler銆?- 鏃犵敓浜х粍浠?`"use memo"`/`"use no memo"` 鏀瑰姩锛涙湭鍒犻櫎鎵嬪伐 memo锛涙棤涓氬姟閫昏緫鍙樻洿銆?
## 6. 鍥炴粴

1. `pnpm build` 淇濇寔榛樿涓嶇紪璇戯紱鏃犻渶鍥炴粴鐢熶骇璇箟锛?2. 鍒犻櫎 `build:compiler` / `test:compiler` scripts锛?3. 鍒犻櫎 `babel-plugin-react-compiler` devDependency锛坄pnpm remove -D`锛夛紱
4. 鍒犻櫎 `reactCompilerBoundary.ts`/test 涓?`vite.config.ts` Babel wiring锛?5. `pnpm install && pnpm build && pnpm test` 鍥炲埌鍩虹嚎銆?
鏃?schema/DB/浜嬩欢/鏉冮檺/IPC 杩佺Щ锛沗dist`/`dist-electron` 閲嶆柊鐢熸垚鍗冲彲銆?
## 7. 鍚庣画锛堥潪鏈?PR锛?
- RC1-1锛歛nnotation 璇曠偣 3鈥? 涓潪 Dock 缁勪欢锛岄獙璇?effect/closure/focus 琛屼负涓?render 璁℃暟锛?- RC1-2锛歚src/shell/**` + `src/git/ui/**` infer 鐧藉悕鍗?opt-out锛?- RC1-3锛欴W1-4 鍚庡叏 renderer锛汻C1-4锛氶棬绂?娓呯悊銆傛湰 PR 涓嶆敼鐢熶骇缁勪欢锛屼笉鎻愬墠瀹屾垚杩欎簺闃舵銆?
[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

