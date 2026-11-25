# 动效 v2 联合作业契约（P1 + P2 + P3）

> 所有队员开工前必读。本文件是唯一契约，冲突时以本文件为准；需要改契约先问 Lead。

## 0. 环境与基线

- 运行时已就位：`app/src/main/assets/web/motion.js`（全局 `window.Motion`，在 app.js 之前加载）。
- **没有代码基线副本**：`.motion-baseline/web/` 已于 rc.202 删除 —— 它是本契约作业期间的一次快照，
  早已落后数千行且没有任何脚本引用，留着只会被误当成「参照实现」。要比对静止态请用
  `node scripts/motion_probe.mjs --label before/after` 出两份 JSON 对比（label 是结果标签，不是目录）。
- 调试开关：`?motion=legacy`（旧行为）、`?motion=reduce`（强制减弱）、`?motionDebug=1`（HUD）。
- 唯一允许的动画驱动者：`Motion`。它写 `transform / opacity / width / height`。
  **CSS 里这些属性不能保留 transition**，否则逐帧写入会互相打架。

## 1. 文件所有权（严禁越界）

| 文件 | 所有者 | 说明 |
|---|---|---|
| `app/src/main/assets/web/styles.css` | **css** | 只改样式；按 §3 清单 |
| `app/src/main/assets/web/app.js`：`go()`/`settleScreenTween()`/`DSHHandleBack` 函数体（页面切换）+ 按压拖拽区 | **js-a** | 按压、滚动、Tab、分段、页面切换 |
| `app/src/main/assets/web/app.js` 第 4700–4770、7290–7360、9300–9360 行区域 | **js-b** | 左滑、面板、浮窗 |
| `motion.js` / `index.html` / `sync-web.mjs` | Lead | 不要改 |
| `.motion/verify/`、`scripts/motion_probe.mjs` | verify | 不要改 |

**app.js 编辑规则**：只允许 `edit` 精确替换（唯一锚点），**禁止 `write` 整文件**。遇到版本冲突（FS_STALE_VERSION）就重新 `read` 再改。两人改同一文件不同函数，互不触碰对方函数体。

## 2. 统一写法

```js
const M = window.Motion;
const MODERN = !!(M && !M.legacy);
const REDUCE = () => !!(M && M.reduced && M.reduced());
```

- `MODERN` 为 false：保留原逻辑（fallback），不要用 `M`。
- `REDUCE()` 为 true：不做位移/缩放/弹簧，直接落位（`M.set` 写终值或走原逻辑）。
- 跟手写值：`M.set(el, {x, scale, opacity})`（立即写，不补间）。
- 落位：`M.springTo(el, props, {preset, velocity, max, onComplete})`。
  同一元素重复 `springTo` 会自动从「当前值 + 当前速度」接管，**不要先手动清样式**。
- 平台元素：`M.value({from,to,preset,onUpdate})`（滚动等数值弹簧）。
- 结束时清场：`M.clear(el)`（去掉内联 transform/opacity/width/height）。若终值必须保留（例如面板关闭后停在下方），不要 clear，等类名接管。
- 事件里不要用 `setTimeout` 猜动画结束；用 `onComplete`（可加一个更长的保险超时）。

## 3. styles.css 必改清单（css 队员）

在文件末尾新增 `/* ===== 动效 v2 ===== */` 段，按下述覆盖；**不要删原段**（保留回滚能力，靠后置覆盖生效）：

```css
:root{
  --dur-instant:120ms; --dur-fast:180ms; --dur-base:240ms; --dur-slow:320ms;
  --ease-enter: cubic-bezier(.22,1,.36,1);
}
/* 页面切换期间：离场页继续可见但不吃触摸 */
.screen.is-leaving{ visibility:visible; pointer-events:none; }

/* 1) 交给 Motion 的属性：摘掉 CSS 过渡 */
.screen{ transition: none; }
.screen.is-active{ transform:none; }
.sheet{ transition: none; }
.sheet-backdrop{ transition: none; }
.tab-indicator{ transition: none; }
.effort-seg-ind{ transition: none; }
.session-item{ transition: background-color .16s; }
.popover{ animation: none; transition: none; }
.popover.is-closing{ animation: none; }

/* 2) 按压由 JS 统一驱动：去掉这些 :active 上的 transform */
.icon-btn:active,.sess-act:active,.pop-item:active,.pop-chip:active,
.pop-link:active,.mode-chip:active,.voice-btn:active,.tab:active .ico{ transform:none; }

/* 3) 仍走 CSS 的微过渡：补上缺的 */
.tab .ico{ transition: transform .14s var(--ease-standard); }
.seg{ transition: background-color .12s, color .12s; }

/* 4) 减弱动效：保持现有 * 的 .01ms 规则即可，不要删 */
```

注意：
- `.sheet.is-closing`、`.sheet.is-on` 的 transform 规则保留（JS 内联优先，不会冲突）。
- 不要改任何颜色/间距/圆角/字号/阴影/模糊值。
- 不要新增 `transform`/`opacity` 的 transition 到 `.sheet`、`.screen`、`.tab-indicator`、`.effort-seg-ind`、`.session-item`、`.popover`。
- 不要动 `@keyframes`（未使用的留着无害）。

## 4. 各面参数（js-a / js-b 的实现依据）

| 面 | 参数 |
|---|---|
| 按压 | `preset:'press'`；按下 `scale:.965`；拖动 >8px 叠 `skew`（dx*0.04，限 ±2°）；松手弹簧回 1；`pointercancel/blur` 立即回 1；`?motion=reduce` 完全不动 |
| Tab 指示器 | 拖动 1:1（`M.drag`，axis **xy**，threshold 3；rubber 分轴 `{x:{0.35/最大10px}, y:null}`）；横向：松手按最近项 + 速度投影，落位 `springTo({x,width},{preset:'press'})`；纵向：导航条整体形变（见下），松手专用 ζ≈0.61 弹簧（k300/c21，过冲≈9%）——**回弹速度必须按软饱和曲线局部斜率折算再夹 ±420px/s，禁止把手指原始 fling 直接灌进弹簧**（视觉速度只有手指的 0.05~0.31 倍，直灌 = 松手跳跃，rc.108）；重新抓取时 `M.kill(bar)` 无声打断旧回弹（`stop` 会 snap 到 0）；拖动期间 `M.set` |
| 分段控件 | 指示器 `x/width` 走 `press` 弹簧；底色 120ms |
| 底部面板 | 打开 `springTo(sheet,{y:0},{preset:'sheet'})` + 遮罩透明度；下拉 1:1（向上橡皮筋 0.2，最多 12px）；松手 `位移>28%` 或 `vy>0.35px/ms` → 关闭（`preset:'exit'`）；否则回 0；内容前 6 项错帧 14ms/6px |
| 锚定浮窗 | `transform-origin` 按落位（下方展开=top center，上方展开=bottom center）；入场 `scale .94→1` + 方向 6px，`preset:'bouncy'`；退场 140ms `exit` |
| 会话左滑 | 跟手 1:1，越界橡皮筋 0.15/最多 14px；松手判定 `x < -214*0.4` 或 `vx < -0.3`；落位 `preset:'press'`，终值 -214/0 |
| 页面切换 | Tab：入场 淡入+8px（240ms），离场 160ms 淡出；进入对话：入场从 +26% 宽推入（gentle ≤360ms），离场原地 scale .98 + **淡出到 0**（exit ≤280ms，**到 0 即在自身动画内独立收尾，禁止以中间不透明度驻留**）；返回反向 |
| 滚动 | 保留 `easedScrollTo` 曲线与时长；去掉 CSS `scroll-behavior` 后它成为唯一机制；触摸/滚轮立刻取消动画；`REDUCE()` 时直接跳 |

## 5. 页面切换实现要点（js-a）

```js
const TAB_ORDER = ["sessions","jobs","files","settings"];
function go(screen, opts) {
  // ...原有副作用...
  const from = state.screen;
  if (from === screen) { /* 原有刷新逻辑 */ return; }
  const dir = (opts && opts.dir) || pickDir(from, screen);
  state.screen = screen;
  const inEl = document.querySelector(`.screen[data-screen="${screen}"]`);
  const outEl = from ? document.querySelector(`.screen[data-screen="${from}"]`) : null;
  // 类名：inEl 立刻 is-active；outEl 加 is-leaving（保持可见、不吃触摸）
  // MODERN 且非 REDUCE：inEl 从 (dir==='back' ? -26% : 26%) 宽 / opacity .55 起步，
  //   outEl（push）= 原地 scale .98 + opacity → 0；outEl（pop/tab）= 滑出 + opacity → 0
  // onComplete：清内联样式、摘 is-leaving、恢复 zIndex
  // 否则：直接切类名
}
```

- `pickDir`：`chat` 一律 forward；从 `chat` 回 `sessions` 为 back；其余按 `TAB_ORDER` 索引差（大→小=back）。
- `DSHHandleBack` 里 `go("sessions")` 改成 `go("sessions",{dir:"back"})`。
- 注意：`inEl` 的 `is-active` 会让 CSS 立刻 `opacity:1`，JS 必须在**同一帧**写入起始内联值，避免闪一下。
- **离场终点不变量（rc.105 血泪）**：离场动画终点必须是 `opacity:0`；禁止像 rc.104 及以前那样把 push 离场页停在 `.55` 等中间值、挂到入场页收尾——真机实测表现为「进入对话后会话列表压暗残影 376ms，从半透明的对话页下透出」。正确做法：终点 0 + 该弹簧自身的 `onComplete` 提前收尾（摘 is-leaving、清内联），带 `screenTween!==st` 守卫防重入误清。
- 切换期间再次调用 `go`：先 `M.stop(inEl/outEl)` 并把上一轮离场页立即收尾（摘类、清样式），再开始新动画，避免叠层。

## 6. 面板/浮窗/左滑实现要点（js-b）

- 面板打开：`const h = sheet.getBoundingClientRect().height;` 先 `M.set(sheet,{y:h})`，再 `M.springTo(sheet,{y:0},{preset:'sheet'})`；遮罩 `M.springTo(backdrop,{opacity:1},{preset:'gentle',max:320})`。
- 面板关闭：遮罩先 `is-on` 摘掉（pointer-events 没了），再 `springTo(backdrop,{opacity:0})`；面板 `springTo(sheet,{y:h},{preset:'exit',max:420,onComplete:finish})`；`finish` 里摘 `is-on/is-closing`、`M.clear(sheet)`。
- 已打开再 `openSheet`：只做内容 120ms 淡入（`M.set(body,{opacity:0})` → `springTo(body,{opacity:1},{preset:'gentle',max:200})`），不动面板。
- 下拉关闭：`M.drag(sheet,{axis:'y',threshold:6,filter:e=>!!e.target.closest('.sheet-grab,.sheet-title'),rubber:{min:-12,max:9999,factor:.2},onMove,onEnd})`；`onMove`：`y=Math.max(-12,dy)`（向上只允许 -12 橡皮筋），`M.set(sheet,{y})`，遮罩 `M.set(backdrop,{opacity:1-y/h})`；`onEnd` 按 §4 判定。
- 浮窗：`placement='below'|'above'`；`origin` 与起始 y 方向按 §4。
- 左滑：`M.drag` 可直接用在 `#sessionsScroll` 上（`filter` 找 `.sess-row`，否则 false）；`onMove` 里 `M.set(item,{x})`；`onEnd` 里落位。
- 所有面板/浮窗动画必须可被下一次操作打断（重复调用 `springTo` 即可，不要 `stop` 后重来）。

## 7. 自测（每人提交前）

1. `node --check app.js`（js-a / js-b）或 `node --check styles.css` 不适用（css 用目测 + 浏览器）。
2. 打开 `?motionDebug=1`，操作本面 10 次，控制台零报错、HUD 无 `long` 持续增长。
3. 快速连点/连开/连关 20 次：无残留 `transform`（`getComputedStyle(el).transform` 最终为 `none` 或预期终值），无位移漂移。
4. `?motion=reduce`：本面所有位移/缩放消失，功能可用。
5. 报告给 Lead：改了哪些函数、行号、验收命令、遗留问题。

## 8. 验收阈值（Lead / verify 用）

- 按下 1 帧内有形变；松手 ≤260ms 归位；
- Tab 指示器拖动误差 ≤1px；松手 ≤350ms 落位，过冲 ≤2px；
- 导航条纵向形变（rc.107）：上拔只拉不位移出屏、下压只压不折叠；主方向一经判定不翻转；
  纵向手势不换页；松手 Q 弹必须有过零（欠阻尼回弹），终值归 0 且内联样式清空；
  松手回弹行程要有界（rc.108）：±90px 拖拽松手后 |y| 峰值 ≤14px、不得出现 20px+ 的
  「跳跃式」上蹿（手指 fling 必须按软饱和斜率折算）；
  切页图标不得重影（rc.108）：`ico-in/out` 动画类必须同步挂到 `.tab-blue` 克隆图标，
  动画期间两颗图标像素级重合；
  `.tabbar` 居中必须走布局（margin auto），transform 归动效层独占——
  任何 CSS transform 居中都会被动效写入冲掉（rc.107 实测 0.1px 偏差口径）；
- 面板 300–420ms 落位；下拉跟手；28% / 0.35px/ms 判定；
- 浮窗从锚点方向展开；翻转到上方时原点改变；
- 左滑按速度判定；越界橡皮筋不误触滚动；
- 进入/返回方向一致，无双层重影；返回后滚动位置不变；
- 静止态与改动前一致（`motion_probe.mjs` 两次 `--label` 结果对比，差异 <0.1%）。
