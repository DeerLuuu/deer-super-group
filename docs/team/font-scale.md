# F1 鐣岄潰瀛楀彿涓夋。锛坱364 / t491 repair-round-2锛?
## 1. 鍔熻兘涓庡瓧鍙峰彛寰?
Settings銆岀晫闈€嶆柊澧?**灏?/ 鏍囧噯 / 澶?* 涓夋。锛岄粯璁ゆ爣鍑嗭紱鐢?CSS `--font-scale` 绛夋瘮缂╂斁鏍稿績 UI 鏂囨湰銆?
| 妗ｄ綅 | factor | 姝ｆ枃/鎺т欢 | 灏忓瓧/鐘舵€?| 鑱婂ぉ/Markdown | 浠ｇ爜/鎬濊€?缈昏瘧 pre |
|---|---:|---:|---:|---:|---:|
| 灏?| 0.92 | 12px | 10px | 13px | 13px |
| 鏍囧噯锛堥粯璁わ級 | 1 | 13px | 11px | 14px | 14px |
| 澶?| 1.15 | 15px | 13px | 16px | 16px |

- 鏍囧噯妗ｆ槑纭负 **姝ｆ枃 13 / 鑱婂ぉ路浠ｇ爜 14**锛涙帶浠?`12.5 * scale`銆?- 灏?澶ф寜鍚屼竴 factor 璁＄畻锛屾樉绀哄€煎洓鑸嶄簲鍏ワ紱CSS 瀹為檯鍊兼槸 `calc(<鍩哄噯px> * var(--font-scale))`銆?
## 2. 瀹炵幇涓庤鐩?
- `src/shared/types.ts`锛歚FontScale`銆乣FONT_SCALE_OPTIONS`锛堝惈 body/small/chat/code px锛夈€乣normalizeFontScale`/`fontScaleFactor`锛沗LayoutSettings.fontScale?` 榛樿 standard锛岄潪娉曞€?clamp銆?- `src/SettingsView.tsx`锛氬師鐢?`fieldset` + `role=radiogroup` radio锛坄aria-label="鐣岄潰瀛楀彿锛氬皬/鏍囧噯/澶?`锛夛紝涓夋。 px 涓庡瓧鍙烽瑙堬紱fontScale 杩涘叆 dirty/fingerprint锛屼繚瀛?payload 鎼哄甫锛屾垚鍔熷悗鏇存柊 baseline銆?- `src/App.tsx`锛歴napshot 鎭㈠銆佷繚瀛樺悗绔嬪嵆 set銆乣.app` 娉ㄥ叆 `--font-scale`/`data-font-scale`锛屽苟鍚屾 `document.documentElement` 瑕嗙洊 Settings portal銆?- `src/styles.css`锛?  - `--font-base-size: 13px*scale`銆乣--font-chat-size: 14px*scale`銆乣--font-code-size: 14px*scale`銆乣--font-small-size: 11px*scale`銆乣--font-control-size: 12.5px*scale`銆?  - `.chat-bubble`/`.chat-content`/`.markdown-body` 鍙?Markdown 鐨?**p/li/ul/ol/blockquote/鏍囬/table/code/pre** 绾冲叆鍙橀噺锛?  - `.chat-turn-reasoning pre`銆乣.chat-turn-live pre`銆乣.chat-turn-translation pre` 浣跨敤 **code** 鍙橀噺锛況easoning/translation label/status 浣跨敤 small锛?  - Task `.tasks-layout/.task-row/.task-detail-panel`锛孧ailbox `.mailbox-layout/.mailbox-thread-row/.mailbox-thread-body/.message-row` 浣跨敤 base锛?  - 鎺т欢锛坆utton/input/select/textarea/label锛変娇鐢?control 鍙橀噺锛沗.tiny` 浣跨敤 small 鍙橀噺銆?
### 2.1 鏄庣‘鏈?涓嶅畬鍏ㄧ缉鏀捐寖鍥?
鏈疄鐜颁笉鏄€滃叏 UI 姣忎釜鍍忕礌鏂囨湰閮界瓑姣斺€濓紝浠ヤ笅淇濇寔鏃㈡湁纭紪鐮佹垨鏈韩涓嶆槸姝ｆ枃锛?
- 鍥炬爣 glyph銆丼VG 鍥惧舰/鍥捐〃鍧愭爣杞淬€佸钩鍙板師鐢熸帶浠跺唴閮ㄦ枃瀛楋紱
- 灏戦噺楂樺瘑搴?**10鈥?2.5px 寰爣绛?鐘舵€?chip/瑙掓爣**锛堜粛鎸夋棦鏈?token/鍏ㄥ眬 floor 鏄剧ず锛夛紝鏈€愪釜鏀瑰啓涓哄彉閲忥紱
- 閭欢/浠诲姟鐨勪釜鍒〃鏍?绛夐珮瀵嗗害鍏冩暟鎹繚鐣欐棦鏈夊浐瀹氬€硷紱Chat/Task/Mailbox 鐨勪富瑕佹鏂囥€佸垪琛ㄣ€佷唬鐮?thinking/缈昏瘧宸茬撼鍏ュ彉閲忋€?- 棰滆壊/瀵规瘮搴︺€佸姩鐢?`prefers-reduced-motion` 鏈敼銆?
## 3. 鐪熷疄 Electron 璇佹嵁

鐜锛氱湡瀹?Electron锛坄dist` 鏋勫缓锛岄殧绂?userData锛夛紝Chat/Task/Mailbox 鏉ヨ嚜瀹為檯 App 璺敱锛汣hat 鍦?fixture 鐨?Dock overlay 榛樿 hidden锛屾埅鍥炬椂浠呭皢鏃㈡湁 `.dv-render-overlay` 璁句负 visible锛堜笉鏀?Chat/Markdown DOM/瀛楀彿锛夛紝walkthrough `mode` 瀛楁宸叉姭闇层€俆ask/Mailbox 璧?`#/tasks`銆乣#/mailbox` 瀹為檯璺敱銆?
### 3.1 Chat / Task / Mailbox 3脳3

| Chat | 1440 | 960 | 480 |
|---|---|---|---|
| 灏?| ![](t364-chat-small-1440.png) | ![](t364-chat-small-960.png) | ![](t364-chat-small-480.png) |
| 鏍囧噯 | ![](t364-chat-standard-1440.png) | ![](t364-chat-standard-960.png) | ![](t364-chat-standard-480.png) |
| 澶?| ![](t364-chat-large-1440.png) | ![](t364-chat-large-960.png) | ![](t364-chat-large-480.png) |

| Task | 1440 | 960 | 480 |
|---|---|---|---|
| 灏?| ![](t364-tasks-small-1440.png) | ![](t364-tasks-small-960.png) | ![](t364-tasks-small-480.png) |
| 鏍囧噯 | ![](t364-tasks-standard-1440.png) | ![](t364-tasks-standard-960.png) | ![](t364-tasks-standard-480.png) |
| 澶?| ![](t364-tasks-large-1440.png) | ![](t364-tasks-large-960.png) | ![](t364-tasks-large-480.png) |

| Mailbox | 1440 | 960 | 480 |
|---|---|---|---|
| 灏?| ![](t364-mailbox-small-1440.png) | ![](t364-mailbox-small-960.png) | ![](t364-mailbox-small-480.png) |
| 鏍囧噯 | ![](t364-mailbox-standard-1440.png) | ![](t364-mailbox-standard-960.png) | ![](t364-mailbox-standard-480.png) |
| 澶?| ![](t364-mailbox-large-1440.png) | ![](t364-mailbox-large-960.png) | ![](t364-mailbox-large-480.png) |

- `t364-font-panels-walkthrough.json`锛?7/27 鏂█閫氳繃锛涙瘡妗?姣忓搴﹁褰?`scrollWidth===innerWidth`銆乴ayout rect>0銆佸疄闄?computed font锛?  - Chat bubble/markdown/code锛歚12.88/14/16.1px`锛?  - Task row锛歚11.96/13/14.95px`锛?  - Mailbox thread body锛歚11.96/13/14.95px`銆?- 涓夋。 480 鍧囨棤鏍圭骇妯悜瑁佸垏锛汿ask/Mailbox 鍐呴儴婊氬姩淇濇寔鍙敤銆侻ailbox 480 鍐呴儴 layout 浠嶆湁 878px锛堟棦鏈?mailbox 鍙屽垪鍐呴儴瀹藉害锛夛紝鏍圭骇 `scrollWidth` 480銆佹埅鍥炬棤椤甸潰妯悜瑁佸垏锛涜鍐呴儴瀹藉害涓烘棦鏈夊竷灞€琛屼负锛屼笉鍦ㄦ湰 PR 閲嶆帓銆?- 浠ｇ爜/thinking/缈昏瘧涓撻」锛歚t364-font-chat-code-thinking.json` + `t364-chat-thinking-standard-1440.png`锛汣hat Markdown fenced code 涓?reasoning pre 鍧?14px/1.65 鏍囧噯锛況easoning 灞曞紑鍙銆?- 鐪熷疄 Chat 缈昏瘧锛歚t364-font-chat-translation.json` + `t364-chat-translation-standard-1440.png`锛涘睍寮€ reasoning 鐨勩€岃瘧鏂囥€嶅悗 `.chat-turn-translation pre` computed **14px/23.1px锛?.65锛?*锛宭abel **11px/16.5px锛坰mall锛?*锛涚炕璇?provider 涓?Bing锛岀洰鏍?zh-Hans锛屾湭浼€?DOM銆?
![Chat translation](t364-chat-translation-standard-1440.png)

- Settings 棰勮鍙﹁褰曚笁妗?translation 10.12/11/12.65px锛屼笌 Chat 鐪熷疄缈昏瘧鍏辩敤 small 鍙橀噺銆?
### 3.2 Settings 3脳3

| 妗ｄ綅 | 1440 | 960 | 480 |
|---|---|---|---|
| 灏?| ![](t364-font-small-1440.png) | ![](t364-font-small-960.png) | ![](t364-font-small-480.png) |
| 鏍囧噯 | ![](t364-font-standard-1440.png) | ![](t364-font-standard-960.png) | ![](t364-font-standard-480.png) |
| 澶?| ![](t364-font-large-1440.png) | ![](t364-font-large-960.png) | ![](t364-font-large-480.png) |

`t364-font-settings-walkthrough.json` 9/9锛歜ody 11.96/13/14.95銆乸review 11.96/13/14.95銆乧ode 12.88/14/16.1銆乼hinking/translation 10.12/11/12.65锛?80 modal 瀹?432锛坸24/right456锛夛紝鏃犳í鍚戙€?
## 4. 閿洏 / dirty / 鎸佷箙鍖?/ 瀵规瘮搴?/ 琛岄珮

- `t364-font-radio-keyboard.json`锛氱劍鐐瑰湪鈥滄爣鍑嗏€濆悗鎸?ArrowRight锛岀劍鐐?閫変腑鍙樹负鈥滃ぇ鈥濓紱`t364-font-radio-keyboard-1440.png` 鏈夊彲瑙?focus ring銆傚師鐢?radio 缁勫叡 3 涓€?- `t364-font-save-refresh.json`锛歭arge鈫抯mall 淇濆瓨鍚庡嵆鏃?`--font-scale=0.92`銆乥ody 11.96px銆乻mall checked锛汸age.reload 鍚庝繚鎸併€俤irty guard/payload 鐢?`src/shell/fontScaleSettings.test.tsx` 瑕嗙洊锛涢潪娉曞€?clamp 鐢?`src/shared/fontScale.test.ts` 瑕嗙洊銆?- 瀵规瘮搴︼細棰滆壊 token 鏈敼锛岃绠楀€?`t364-font-contrast.json`锛氭鏂?`#e6edf3` on `#0d1117` = **16.02**銆乷n panel = **14.64**锛沵uted = **6.45/5.90**锛涚姸鎬佺豢/榛?绾?绱?钃?= 7.45/7.50/5.65/7.51/7.49锛坴s bg锛夈€傚潎涓庡瓧鍙峰ぇ灏忔棤鍏炽€?- 琛岄珮锛欳hat content 23.1px/14 = **1.65**锛汳arkdown 23.8/14 = **1.7**锛況easoning pre 23.1/14 = **1.65**锛汿ask row 19.5/13 = **1.5**锛汳ailbox thread body 20.8/13 = **1.6**銆傝繖浜涜鍒欐湭鏀广€?- 鍔ㄦ晥锛氭湭鏂板 animation/transition锛涙棦鏈?`prefers-reduced-motion` 瑙勫垯淇濇寔銆?- 200% 鍙ｅ緞锛氭部鐢ㄦ湰浠撳簱鏃㈡湁 a11y 鍩虹嚎鈥斺€旂湡瀹?Electron **480 CSS 瑙嗗彛**瀹炴祴锛涗笉瀹ｇО OS 200%/DPR2銆?80 涓夋。鎴浘涓?`scrollWidth` 鏂█宸茶褰曪紱绯荤粺绾?200% 璧版煡涓烘棦鏈夊熀绾跨害瀹氥€?
## 5. 楠岃瘉

- `pnpm typecheck` exit 0銆?- `pnpm build` exit 0锛坕ndex 364.80 kB / gzip 108.71锛泇endor 414.89 / 97.22锛夈€?- `pnpm test -- --max-workers=1 --testTimeout=20000`锛?69 鏂囦欢 / 1110 鐢ㄤ緥鍏ㄧ豢锛坋xit 0锛夈€?- CI 瀹介檺锛氭湰浠撳簱鏃㈡湁 plain test 5s timeout flake锛涙湰 PR 浣跨敤 serial/extended锛坄--max-workers=1 --testTimeout=20000`锛夐獙璇侊紝涓嶆妸鏃㈡湁骞惰 timeout 褰掑洜浜庢湰 PR銆?
## 6. 椋庨櫓涓庡洖婊?
- 瀛楀彿浠?UI scale锛屼笉鏀规暟鎹?鏉冮檺/IPC/schema/渚濊禆锛涙棫 `layout.settings` 缂?fontScale 鑷姩鍥炴爣鍑嗐€?- 娈嬩綑鍥哄畾寰爣绛惧凡鍦?搂2.1 鏄庣ず锛屼笉瀹ｇО鎵€鏈夋枃鏈畬鏁寸瓑姣斻€?- 鍥炴粴锛歳evert 鏈?PR commit锛涙棤杩佺Щ銆?
[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

