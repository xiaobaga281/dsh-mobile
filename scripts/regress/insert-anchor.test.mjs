// 回归：往对话流「中间」插节点时视口不能动。
// 真机症状：本轮交付文件卡片出现时，列表先滚进历史里再滚回来（电脑会话里
// 上一轮迟到的思考/工具/正文插回原位时同形）。
// 两层根因（模拟器逐帧采样抓出来的）：
//   1) .chat-scroll 关了 overflow-anchor（自己管锚定），视口上方插入一段高度时
//      浏览器不补偿 → 插入后必须自己把「距底距离」补回去（insertAnchored）；
//   2) CSS 给 .chat-scroll 开了 scroll-behavior:smooth，而流式跟手是每帧写一次
//      scrollTop：smooth 把每帧写入变成「从头重启的补间」，视口永远追不上内容，
//      甩开几百像素后等写入停下才滑回来 = 用户看到的「滚进历史再滚回来」。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const js = read("app/src/main/assets/web/app.js");
const css = read("app/src/main/assets/web/styles.css");
const fails = [];
const ok = (name, cond) => {
  if (cond) console.log(`  ✔ ${name}`);
  else { console.log(`  ✘ ${name}`); fails.push(name); }
};

ok("锚定插入器存在且自己补偿视口",
  /function insertAnchored\(anchorEl, html\)/.test(js)
  && js.includes("const keepFromBottom = sc.scrollHeight - sc.scrollTop;")
  && /if \(above \|\| followBottomOn\) (setScrollTop\(sc|ChatScroll\._write\(sc), Math\.max\(0, sc\.scrollHeight - keepFromBottom\)\)/.test(js));

// 视口上方插入时浏览器不会补偿：这条是「必须手动补偿」的前提，别被顺手删掉
ok("滚动容器仍由 JS 管锚定", /\.scroll-area, \.chat-scroll \{[\s\S]{0,400}overflow-anchor: none/.test(css));

ok("交付物卡片走锚定插入（两处都算）",
  (js.match(/insertAnchored\(tailMsg, nodeHTMLUid\(node\)\)/g) || []).length >= 2
  && !js.includes('tailMsg.insertAdjacentHTML("beforebegin"'));

ok("交付物插入后不再补一次缓动贴底",
  !/insertAnchored\(tailMsg, nodeHTMLUid\(node\)\);[\s\S]{0,400}if \(followBottomOn\) scrollToBottom\(\);/.test(js));

ok("表情/图片进流也走锚定插入",
  /function flowAction\(node\)[\s\S]{0,400}insertAnchored\(tailMsg, nodeHTMLUid\(node\)\)/.test(js));

ok("电脑会话迟到的内容插回原位也锚定",
  /placeBeforeTurn\(node\)[\s\S]{0,700}insertAnchored\(el, nodeHTMLUid\(node\)\)/.test(js));

/* 真正的元凶（模拟器逐帧抓出来的）：CSS 给 .chat-scroll 开了 scroll-behavior:smooth，
   而流式跟手是「每帧写一次 scrollTop」。smooth 会让每次写入变成「从头重启的补间」，
   读取值永远停在上一帧 —— 内容涨得比补间快，视口被甩开几百像素，写入一停才滑回来。
   所以：对话流容器不许有 CSS smooth，跟手/贴底一律走 setScrollTop（instant）。 */
ok("对话流容器不吃 CSS smooth（程序化滚动交给 JS）",
  !/\.chat-scroll[\s\S]{0,90}\{[^}]*scroll-behavior:\s*smooth/.test(css)
  && !/\.chat-scroll,\s*\.sheet-body \{[\s\S]{0,120}scroll-behavior:\s*smooth/.test(css));

// 流式跟手与收尾贴底必须经「唯一写入点」，不许裸写 scrollTop。
// 允许两种写法：直接 setScrollTop（旧），或走 ChatScroll（rc.202 起的意图层）。
ok("流式跟手与收尾贴底走唯一写入点，不裸写 scrollTop",
  /function streamFollow\(\)[\s\S]{0,900}(setScrollTop\(sc, sc\.scrollHeight\)|ChatScroll\.stick\(sc\))/.test(js)
  && /function settleFollow\(\)[\s\S]{0,700}(setScrollTop\(sc, sc\.scrollHeight\)|ChatScroll\.toBottom\(sc\))/.test(js)
  && !/sc\.scrollTop = sc\.scrollHeight/.test(js)
  && !/scRt\.scrollTop = scRt\.scrollHeight/.test(js));

ok("分帧补历史的两处视口补偿也是 instant",
  !/sc\.scrollTop = sc\.scrollHeight - before/.test(js)
  && /(setScrollTop\(sc, sc\.scrollHeight - before\)|ChatScroll\._write\(sc, sc\.scrollHeight - before\))/.test(js)
  && /requestAnimationFrame\(\(\) => \{ (setScrollTop\(scRt|ChatScroll\._write\(scRt), prevTop\); \}\)/.test(js));

// 补间和逐帧贴底会抢写入：谁先到谁说话，后到的那条曲线必须自己退场
ok("缓动补间遇到别的写入者已到位就立刻退场",
  /const step = \(now\) => \{[\s\S]{0,600}\(delta > 0 && cur >= target - 1\) \|\| \(delta < 0 && cur <= target \+ 1\)/.test(js));

/* 中段插入还有一层只有看指针才发现的坑：thread 里 splice 了一枚已渲染的节点，
   但「尾部队下一个要灌的下标」renderTailFrom 没跟着 +1。paintLiveNode 的兜底条件
   是 renderTailFrom !== thread.length —— 差 1 也算差，下一次流式 paint 会把整张对话
   清空重灌（刚插的那一下全页闪一遍）。所以每个中段插入都必须 keepTailSync(at)。 */
const inserts = (js.match(/thread\.splice\(at, 0, node\)/g) || []).length;
const syncs = (js.match(/keepTailSync\(at\)/g) || []).length;
ok("每个中段插入都维持尾部队指针（" + inserts + " 处插入 / " + syncs + " 处同步）",
  inserts >= 5 && syncs >= inserts - 1
  && /function keepTailSync\(at\) \{\s*\n\s*if \(at <= renderTailFrom\) renderTailFrom \+= 1;/.test(js)
  && !/if \(renderTailFrom <= at\) renderTailFrom \+= 1;/.test(js));

/* 思考那一行要「跟着输出走」：截断看开头等于把说到点上的部分藏起来。
   实现是把可视位置钉到文字末尾（scrollLeft），不是补间动画 —— 输出多长就跟多远。 */
ok("摘要行钉在最新内容上（思考行 + 有实时输出的工具行；普通工具行不动）",
  /function syncThinkTail\(\) \{/.test(js)
  && /const TAIL_SEL = "\.pg-label, \.is-think \.pg-sum, \.pg-sum\.is-live, \.pc-think-brief"/.test(js)
  /* 每一行各自判溢出：收起时组体 display:none、clientWidth=0，老实现「只钉最后一条 + 没宽度就
     return」会让组头再也不滚（用户实测：展开再收起，那一行停在开头） */
  && /for \(const el of all\)/.test(js)
  && /const to = w \? el\.scrollWidth - w : 0;/.test(js)
  && /if \(el\.scrollLeft !== to\) el\.scrollLeft = to;/.test(js)
  /* 收起态用户看到的「那一行」是组头：摘要必须挂到 running.detail 并进标题，否则组头永远只写「正在思考…」 */
  && /if \(g\.running && g\.running\.cat === "thinking"\) g\.running\.detail = sum;/.test(js)
  && /return g\.running\.detail && !g\.open \? `\$\{base\} · \$\{g\.running\.detail\}` : base;/.test(js));
ok("展开的思考正文：组收起时组头继续更新；正文有高度上限、贴底跟随",
  /if \(m\.open && g\.open\) \{/.test(js)
  && /const stick = bodyEl\.dataset\.stick !== "0";/.test(js)
  && /if \(stick\) bodyEl\.scrollTop = bodyEl\.scrollHeight;/.test(js)
  && /contains\("pg-think-text"\)[\s\S]{0,260}dataset\.stick = "0"/.test(js)
  && /max-height: min\(45vh, 380px\);[\s\S]{0,80}overflow-y: auto;/.test(css)
  /* 组展开、行没展开：组内那行摘要也要跟着输出走（以前只有 patchNode 那一刻的快照） */
  && js.includes('[data-pg-row="${g.members.indexOf(m)}"]')
  && /querySelector\(sel \+ " \.pg-sum"\)/.test(js));

/* 展开的思考正文是 md() 的产物，不只是纯文本：代码块 / 长链接 / 表格都可能横着长。
   模拟器实测（「宽思考」）：正文框 clientWidth=380 而 scrollWidth=981 —— 一条命令
   那么长的一行直接顶出屏幕右边，用户看到的正是「展开后被手机屏幕截断」。
   根因不在正文框，在代码块那条规则原先挂在 .assistant-text 下面：
   思考正文里的 <pre> 退回默认 white-space: pre，一行不折。 */
ok("思考正文不横向截断：md() 代码块的折行规则全局生效（不再只挂 .assistant-text）",
  /^pre\.code \{[\s\S]{0,220}max-width: 100%;/m.test(css)
  && /^pre\.code code \{[\s\S]{0,260}white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;/m.test(css)
  && !/\.assistant-text pre\.code/.test(css));
ok("锚定挂在组头直写 / patchNode / appendTail / 锚定插入 / 整表重绘 上",
  (js.match(/syncThinkTail\(\);/g) || []).length >= 6
  && /lab\.textContent = title;[\s\S]{0,240}syncThinkTail\(\);/.test(js)
  && /morphOuter\(el, nodeHTMLUid\(n\)\);[\s\S]{0,40}syncThinkTail\(\);/.test(js)
  /* 组展开 / 收起不走 patchNode：挂在 #messages 的尺寸观察上补钉；没宽度时不钉 */
  && /tailRaf = requestAnimationFrame\(\(\) => \{ tailRaf = 0; syncThinkTail\(\); \}\)/.test(js));
/* 为什么不用负 text-indent：它会被 scrollWidth 再算一遍，每测一次更负一点
   （实测 -131 → -411 → -1139 → -1339），最后整行字滚出可视区，用户看到「只剩图标」。 */
ok("钉尾用 scrollLeft，不再用会自我放大的负缩进",
  !/last\.style\.textIndent/.test(js)
  && !/pgMarquee/.test(js) && !/pgMarquee/.test(css)
  && /\.pg-label\.is-tail,[\s\S]{0,120}\.pc-think-brief\.is-tail \{ text-overflow: clip; \}/.test(css));
/* 摘要必须是「最新那一段」而且永不为空：末段在段落边界上就是空的（模型每段以空行收尾、
   整段思考也常以空行结束），旧实现直接取 parts[length-1] → 那一行被清成只剩「思考」两个字
   （模拟器实测：161 字的思考，24 帧里 20 帧组头没有任何内容）。 */
ok("摘要取「最新那一段」，末段为空时往前找，不再从开头截",
  /const parts = String\(m\.text \|\| ""\)\.split\(/.test(js)
  && /for \(let i = parts\.length - 1; i >= 0; i--\)/.test(js)
  && /if \(p\) return p;/.test(js)
  && !/return String\(parts\[parts\.length - 1\]/.test(js)
  && /function pageClipTail\(text, n\)/.test(js)
  && /return t\.length <= n \? t : "…" \+ t\.slice\(-\(n - 1\)\);/.test(js)
  && /const brief = pageClipTail\(String\(n\.text \|\| ""\)/.test(js));

/* 展开后正文就在下面：那一行不再重复摘要（否则像半句话，用户明确不要） */
ok("展开的思考行与展开的组头都不再重复摘要",
  /\$\{sum && !m\.open \? `<i class="pg-sep">/.test(js)
  && /g\.running\.detail && !g\.open/.test(js)
  && /\$\{brief && !n\.open \? `<span class="pc-think-brief">/.test(js));

/* 工具行实时输出：内核读一块、合帧器攒一段，前端只 morph 变化的那一行。
   四条都要钉住 —— 少一条就分别变成「半截 stdout 冒充结果」「一块刷一次压满主线程」
   「几十 MB 构建日志整条留在内存里」「已经画完的行被迟到的输出改写」。 */
ok("工具行实时输出：增量落进行、合批 morph、截尾留最新、结束时让位给正式结果",
  /toolOutput\(id, chunk\) \{/.test(js)
  && /if \(!m \|\| m\.status !== "run"\) return;/.test(js)
  && /m\.__live = acc\.length > LIVE_OUT_MAX \? acc\.slice\(-LIVE_OUT_MAX\) : acc;/.test(js)
  && /this\.queueLivePatch\(m\);/.test(js)
  && /if \(!g \|\| g\.closed\) return;\s*\n\s*this\.patchGroupRow\(g, mm\);/.test(js)
  && /m\.__live = "";/.test(js)
  && /const live = running \? lastLine\(m\.__live\) : "";/.test(js)
  && /String\(m\.out \|\| ""\)\.trim\(\) \|\| \(running \? String\(m\.__live \|\| ""\)\.trim\(\) : ""\)/.test(js)
  /* 展开着看输出时贴底跟随（用户上翻过就不动他）—— 与展开的思考正文同一套 stick 规矩 */
  && /if \(box && box\.dataset\.stick !== "0"\) box\.scrollTop = box\.scrollHeight;/.test(js)
  && /\.contains\("pg-think-text"\) && !el\.classList\.contains\("io-sec"\)/.test(js)
  && /\.pg-sum\.is-live\.is-tail,/.test(css));

ok("行级 patch 走 morphOuter：morphHTML 只喂容器内容，否则旧行会被套进一个新行里",
  /function morphOuter\(el, html\) \{/.test(js)
  && /morphOuter\(row, m\.type === "think" \? thinkRowHTML\(m, i\) : toolRowHTML\(m, i\)\);/.test(js)
  && /morphOuter\(el, nodeHTMLUid\(n\)\);/.test(js)
  /* 同类调用点一起钉住：任何把「行级 HTML」喂给 morphHTML 的写法都会重现同一个嵌套 */
  && !/morphHTML\(row,/.test(js)
  && !/morphHTML\(el, nodeHTMLUid/.test(js));

console.log(fails.length ? `\n✘ ${fails.length} 项未通过：${fails.join("、")}` : "\n插入锚定守卫全部通过");
process.exit(fails.length ? 1 : 0);
