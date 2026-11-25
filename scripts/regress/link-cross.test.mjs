// 回归：Step 6 跨网连接（隧道默认 + 直连高级），手机与电脑两端一起钉。
// 守六件事：① 端到端信封两端参数逐字节一致（盐/info/字段名/base64 变体）；
// ② 直连才做指纹固定，隧道走系统信任链 —— 拿自签那套去连公共 CA 等于放弃校验；
// ③ 下载物与自签证书只落插件自己目录，卸载能清干净（不在 ~/.dsh 留残留）；
// ④ 口令是现取的：面板重置配对后，旧配对串立刻打不开；
// ⑤ 公网明文仍然一律拒绝（新加的两条路都是 https，不该为此放开 http）；
// ⑥ 连上就落到电脑会话，且断开后不残留电脑视图。
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) console.log(`  ✔ ${name}`);
  else { console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ""}`); fails.push(name); }
};

const js = read("app/src/main/assets/web/app.js");
const css = read("app/src/main/assets/web/styles.css");
const crypto = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/link/LinkCrypto.kt");
const transport = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/link/LinkTransport.kt");
const bridge = read("app/src/main/java/ai/deepseek/harness/mobile/bridge/LinkBridge.kt");
const netpol = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/NetPolicy.kt");

const pluginRoot = join(root, "..", "dsh-mobile-link");
if (!existsSync(pluginRoot)) {
  console.error(`✘ 旁边找不到插件目录 ${pluginRoot} —— 跨网这一条是两端一起的，守卫必须两边都读到`);
  process.exit(1);
}
const readPlugin = (p) => readFileSync(join(pluginRoot, p), "utf8");
const e2e = readPlugin("e2e.mjs");
const rpc = readPlugin("rpc.mjs");
const direct = readPlugin("direct.mjs");
const tunnel = readPlugin("tunnel.mjs");
const relaySrc = readPlugin("relay/server.mjs");
const pluginIndex = readPlugin("index.js");
const pkg = JSON.parse(readPlugin("package.json"));

/* ① 信封参数两端一致 */
ok("手机端 HKDF 盐与 Node 一致", crypto.includes('"dsh-mobile-link-v1"') && e2e.includes("'dsh-mobile-link-v1'"));
ok("手机端 HKDF info 与 Node 一致", crypto.includes('"rpc-aes-256-gcm"') && e2e.includes("'rpc-aes-256-gcm'"));
ok("信封字段名两端一致（v/iv/ct/tag）",
  ["\"v\", 1", '"iv"', '"ct"', '"tag"'].every((s) => crypto.includes(s)) &&
  ["v: 1", "iv:", "ct:", "tag:"].every((s) => e2e.includes(s)));
ok("手机端用标准 base64（非 android.util，JVM 单测跑得动）",
  crypto.includes("java.util.Base64") && !crypto.includes("android.util.Base64"));
ok("GCM 标签 128 位", crypto.includes("TAG_BITS = 128") && e2e.includes("tag.length !== 16"));
ok("跨语言测试向量在两端各钉一份",
  read("app/src/test/java/ai/deepseek/harness/mobile/kernel/link/LinkCryptoTest.kt").includes("fc51d6f157b737e157160344a01d98aa353fe4461b3422f934b931688d91eba0")
  && readPlugin(".test/cross.mjs").includes("fc51d6f157b737e157160344a01d98aa353fe4461b3422f934b931688d91eba0"));

/* ② 只有直连固定指纹 */
ok("secure() 只作用于 direct", /fun secure\([\s\S]{0,200}?if \(mode != MODE_DIRECT\) return/.test(transport));
ok("直连按 SHA-256 指纹比对证书", transport.includes("LinkCrypto.sha256Hex(leaf.encoded)") && transport.includes("CertificateException"));
ok("指纹不匹配时不连接（抛异常而不是放行）", transport.includes("证书指纹对不上"));
ok("解不开的应答不采信（响应也是信封）", transport.includes("LinkCrypto.decryptJson(parsed, key)"));

/* ③ 落盘与卸载 */
ok("下载目录默认在插件自己目录内", tunnel.includes("process.env.DSH_MOBILE_LINK_STORE || PLUGIN_ROOT") && tunnel.includes("join(STORE_ROOT, 'bin')"));
ok("卸载清理只动插件自己的文件", tunnel.includes("purgeDownloaded") && /cloudflared|tls\\.json|tunnel/.test(tunnel));
ok("下载后要 --version 自检才执行", tunnel.includes("'--version'") && /looksLikeCloudflared/.test(tunnel));
ok("不自称 cloudflared 就删掉不执行", /下载下来的程序不自称 cloudflared/.test(tunnel));
ok("证书落盘（重启不换指纹）", direct.includes("loadOrCreateCert") && tunnel.includes("join(STORE_ROOT, 'data')"));
ok("四个跨网模块都随插件发布", ["e2e.mjs", "rpc.mjs", "direct.mjs", "tunnel.mjs"].every((f) => pkg.files.includes(f)));
/* 装载身份必须只有一个名字。真机实锤：profile 里登记旧名 `@local/dsh-mobile-link`，
   而插件自带 patch 用正名 `dsh-mobile-link` 插 host 行 —— 同一份 client.js 被两条路各装载一次，
   harness 按「文件里声明的 id」判重，直接 web boot 失败（整个桌面端起不来）。 */
const clientId = (/id: '([^']+)'/.exec(readPlugin("client.js")) || [])[1];
const patchName = (/name: '([^']+)'/.exec(readPlugin("cordis.patch.yml")) || [])[1];
ok("client 声明的 id = 包名 = patch 里的名字", clientId === pkg.name && patchName === pkg.name, `client=${clientId} patch=${patchName} pkg=${pkg.name}`);

/* ④ 口令现取 + 关闭即断 */
ok("RPC 房间口令是 getter", rpc.includes("roomKey()") && /roomKey: \(\) =>|o\.roomKey/.test(rpc));
ok("直连口令也是 getter（重置后旧串立刻失效）", /key: \(\) => state\.key/.test(readPlugin("index.js")));
ok("关闭联动一起关掉公网入口", readPlugin("index.js").includes("crossStop(undefined)"));
ok("插件卸载时收掉子进程与端口", readPlugin("index.js").includes("'mobile-link: cross'"));

/* ⑤ 配对串与明文策略 */
ok("配对串前缀两端一致", crypto.includes('"dshlink1:"') && rpc.includes("'dshlink1:'"));
ok("配对串拒绝非 https 与短口令", crypto.includes('url.startsWith("https://")') && crypto.includes("key.length < 8"));
ok("公网明文仍然一律拒绝（没为跨网放开 http）", netpol.includes("公网明文 HTTP 不安全"));

/* ⑥ 前端：粘贴入口、自动进入、诚实回退 */
ok("设置里有粘贴配对串入口", js.includes("linkPairPaste") && js.includes("linkPasteBtn"));
/* 入口必须真的通向新面板：rc.190 真机实锤 —— 设置里那一行还指着旧的混合面板，
   而旧面板的构造函数又被一个同名局部变量盖掉，点「连接电脑」只留一个 TypeError。 */
ok("设置「连接电脑」这一行走 Link.enter", js.includes('const rowHost = $("#rowHost"); if (rowHost) rowHost.addEventListener("click", () => Link.enter());'));
ok("旧的混合连接面板已删除", !js.includes("const sheetHost = () =>") && !js.includes("openSheet(sheetHost())"));
ok("局域网直连 Web UI 单独成面板", js.includes("const sheetHostDirect = () =>") && js.includes("linkHostDirect"));
ok("剪贴板读不到时说实话", js.includes("长按输入框选「粘贴」"));
ok("配对成功自动进电脑会话", js.includes("Link.autoEnter = true") && js.includes('Link.open(pick.id, title, "pair")'));
ok("连法写进标题（局域网/隧道/直连）", js.includes("电脑（隧道）") && js.includes("电脑（直连）") && js.includes("modeLabel()"));
ok("连续够不着电脑时退出电脑视图并说明原因", js.includes('this.leave();') && js.includes("已回到本机会话"));
ok("指纹核对用等宽面板显示", css.includes(".fp-code") && js.includes("linkFpOk"));
ok("解除配对清掉跨网凭据", bridge.includes('remove("link.url")') && bridge.includes('remove("link.fp")') && bridge.includes('remove("link.mode")'));

/* 派生断言：模式状态要一路带到请求上 */
ok("LinkBridge 按 mode 分派传输", bridge.includes("LinkTransport.isCross(mode())") && bridge.includes("LinkTransport.call("));
ok("401 时清掉本地令牌", bridge.includes('remove("link.token").apply()'));

/* 电脑这一侧的请求调度：一个慢请求不许拖死其它请求（真机实锤：模型切换点不动） */
const host = readPlugin("index.js");
ok("取回的帧进常驻 worker 池，不等结果", host.includes("pumpFrames(ctx)") && host.includes("frameWorkers.size < FRAME_CONCURRENCY") && host.includes("const FRAME_CONCURRENCY = 4"));
ok("取活循环不因慢请求停摆（只入队不 await 整批）", !/await runBounded\(data\.frames/.test(host) && !/await answerFrame\(frame, ctx\)\s*\n\s*\/\/ 无论/.test(host));
ok("关掉联动时丢弃排队中的帧", /stopRelayLoop\(\)[\s\S]{0,220}frameQueue\.length = 0/.test(host));
ok("模型目录落盘 + 后台刷新（开选择器不再等 provider）", host.includes("CATALOG_TTL_MS") && host.includes("refreshCatalog(controller)") && host.includes("state.catalog = fresh"));
ok("慢路径（目录/历史）给更长帧预算", host.includes('SLOW_FRAME_TIMEOUT_MS') && host.includes("startsWith('/session/')"));
ok('历史窗口收窄到一屏（大会话不再 20 秒出不来）', (() => {
  const m = /const HISTORY_LIMIT = (\d+)/.exec(host)
  return m !== null && Number(m[1]) <= 100
})());
ok("会话应答带上当前模型（归一成扁平形状）", host.includes("selected: selectionOf(merged.modelSelection)") && host.includes("function selectionOf("));

/* 上下文占用：电脑端输入框下面那个圆环。提示级投影不带 contextPressure 时要补读一次，
   但只在缺这个键时才多读 —— 别让每次轮询都重放一遍日志。 */
ok("上下文投影缺键时补读一次（并按会话缓存）", host.includes("async function contextFallback(") && host.includes("contextCache.get(sessionId)") && /async function withContext\([\s\S]{0,160}contextOf\(values\) !== null/.test(host));
ok("占用明细随快照回传（系统/工具/对话）", host.includes("function breakdownOf(") && host.includes("breakdown: breakdownOf(merged)"));

const webIndex = read("app/src/main/assets/web/index.html");
ok("上下文圆环住在输入框里（＋ 与模型胶囊之间）", webIndex.includes('id="pcContext"') && webIndex.includes('pc-ctx-ring') && webIndex.indexOf('id="pcContext"') < webIndex.indexOf('id="btnPcModel"') && webIndex.indexOf('id="btnAttach"') < webIndex.indexOf('id="pcContext"') && js.includes("function pcContextHtml()"));
ok("模型浮层能切思考强度", js.includes('data-pc-effort-set=""') && /pcPopoverClick[\s\S]{0,1200}data-pc-effort-set/.test(js));
ok("流式只重画自己那枚气泡（整表重建会乱滚）", js.includes("paintLiveNode()") && /paintLiveNode\(\) \{[\s\S]{0,900}textEl\.__painted/.test(js) && /paintLiveNode\(\) \{[\s\S]{0,1400}morphHTML\(textEl/.test(js) && !/paintLive\(\) \{[\s\S]{0,400}renderThread\(\);\s*scrollToBottom\(\);/.test(js));
ok("轮询批量只渲染一次（每条都重建会反复贴底）", js.includes("this.appended = true") && js.includes("if (this.appended) {"));
ok("浮层材质与本机同一套玻璃", /\.composer\.is-pc \{[\s\S]{0,900}var\(--glass-a\)/.test(css) && /\.pc-pop-card \{[\s\S]{0,400}var\(--glass-strong\)/.test(css));
ok("列表里的状态行居中", /\.sheet-list > \.sheet-caption \{[\s\S]{0,120}text-align: center/.test(css));

/* 电脑会话的流：只追加、只 patch，不整表重建；自己写的滚动不许被当成用户意图 */
ok("轮询批量不再整表重建", js.includes("if (this.needRender)") && js.includes("else settleFollow();") && !/if \(this\.appended\) \{[\s\S]{0,80}renderThread\(\);\s*scrollToBottom\(\);/.test(js));
ok("收尾的转圈行就地 patch", js.includes("for (const node of fixed) patchNode(node);"));
ok("发送只追加气泡",
  /const mine = NODES\.user\(\{ text, atts: imgAtt\.map\(/.test(js)
  && js.includes("push(mine, false);") && js.includes("Link.turnAnchor = mine"));
ok("思考/工具行用桌面同款字形", webIndex.includes('id="i-d-think"') && webIndex.includes('id="i-d-api"') && js.includes('thinking: "i-d-think"') && js.includes("function toolCatOf("));

/* 电脑会话的交付卡：以前电脑上 present 成功了，手机端只有过程组多一行，卡片整块缺失 */
ok("present 参数解析成交付清单（对象 / JSON 字符串都认）",
  /function presentFilesOf\(args\)/.test(js) && /JSON\.parse\(a\)/.test(js) && /Array\.isArray\(a\.files\)/.test(js));
ok("present 成功才落卡（失败与在途都不落）",
  /if \(item\.name === "present"\) item\.files = presentFilesOf\(message\.args\);/.test(js)
  && /if \(item && !message\.isError && item\.files && item\.files\.length\) this\.deliverable\(item\.files, seq\);/.test(js));
ok("电脑交付卡等本轮静默后才落（present 之后常还有收尾正文，running 也会短暂为 false）",
  /deliverable\(files, seq\) \{[\s\S]{0,900}this\.pendingDeliveries\.push\(\{ files, seq:[^}]{0,80}anchor:[\s\S]{0,220}if \(!this\.running\) this\.scheduleFlush\(\);/.test(js)
  && /this\.running = Boolean\(json\.running\);[\s\S]{0,900}this\.scheduleFlush\(\);/.test(js)
  && /scheduleFlush\(\) \{[\s\S]{0,300}setTimeout\([\s\S]{0,100}this\.flushDeliveries\(\);/.test(js));
ok("落卡前先把还在转圈的工具行收口（卡片不能压着没跑完的工具行）",
  /flushDeliveries\(\) \{[\s\S]{0,300}this\.finishRunningTools\(\);/.test(js)
  && /finishRunningTools\(\) \{[\s\S]{0,800}for \(const node of fixed\) patchNode\(node\);/.test(js));
ok("同一条 present 结果重复下发只落一张卡（seq 缺失时按本轮锚点去重）",
  /const key = \(Number\(seq\) \|\| 0\) \+ "\|" \+ turn \+ "\|" \+ files\.map\(\(f\) => f\.path\)\.join\("\|"\);/.test(js)
  && /if \(this\.deliveredKeys\.has\(key\)\) return;/.test(js));
ok("落卡定时器不许写进别的会话的桶",
  /flushDeliveries\(\) \{[\s\S]{0,500}thread\.__sid !== "pc:" \+ state\.pcSession\.id/.test(js));
ok("交付卡落在这一轮之后、下一条用户消息之前",
  /placeCard\(node, anchor\) \{[\s\S]{0,500}while \(at < thread\.length && thread\[at\]\.kind !== "user"\) at\+\+;/.test(js)
  && /placeCard\(node, anchor\) \{[\s\S]{0,1200}insertAnchored\(nextEl, nodeHTMLUid\(node\)\)/.test(js));
ok("收尾卡跟着本轮一起收口（后到的收尾正文不会把卡压在中间）",
  /node\.__tail = true;/.test(js)
  && /pinTailCards\(\) \{[\s\S]{0,1800}host\.insertBefore\(el, nextEl\)/.test(js)
  && /if \(role === "user"\) this\.releaseTailCards\(\);/.test(js)
  && /if \(role !== "user"\) this\.pinTailCards\(\);/.test(js));
ok("电脑交付卡不假装能在手机上打开",
  /const pc = !!n\.pc;/.test(js) && /\$\{pc \? "" : ` data-open-file=/.test(js)
  && /const img = !pc && isImageName/.test(js) && /\.deliver-item\.is-static/.test(css));

/* 一轮还在产出时贴底必须瞬时：补间追的是「出发那一刻的目标」，内容每帧在长就会落后（实测 2000px） */
ok("产出中的贴底不补间（缓动只留给用户主动跳转）",
  /function scrollToBottom\(force, instant\) \{[\s\S]{0,900}if \(!force && \(state\.busy \|\| Link\.running\)\)[\s\S]{0,200}(setScrollTop\(sc, sc\.scrollHeight\)|ChatScroll\.toBottom\(sc\))/.test(js));

/* 键盘 --kb 由原生注入，既不动 #messages 也不动 dock 高度：两种 RO 都不响，必须盯 documentElement 的 style */
ok("键盘高度变化会重新贴底",
  /rootEl\.__kbPin = true;[\s\S]{0,600}getPropertyValue\("--kb"\)[\s\S]{0,300}if \(followBottomOn\) settleFollow\(\);/.test(js)
  && /new MutationObserver\(pinOnKb\)\.observe\(rootEl, \{ attributes: true, attributeFilter: \["style"\] \}\)/.test(js));

/* ---- 电脑会话：入口画了就必须能点（rc.196 补的图片链路） ---- */
ok("电脑会话「添加图片」有实现，弹层入口真的调到它",
  /function pickPcImages\(\)/.test(js) && js.includes("pickPcImages();")
  && /id="pcImageInput"/.test(read("app/src/main/assets/web/index.html"))
  && /pcImgInput\.addEventListener\("change"[\s\S]{0,160}addPcImages\(files\)/.test(js));
ok("发送只有一个桥入口，图片走同一个方法（base64 与 mediaType 分开传）",
  /const images = imgAtt\.map\(\(a\) => \(\{ name: a\.name, mediaType: a\.type \|\| "image\/jpeg", data: b64OfDataUrl\(a\.dataUrl\) \}\)\);/.test(js)
  && /Native\.linkSend\("send-" \+ Date\.now\(\), state\.pcSession\.id, text, JSON\.stringify\(images\)\)/.test(js)
  && /Native\.linkSend\("send-" \+ Date\.now\(\), state\.pcSession\.id, text, "\[\]"\)/.test(js)
  && !/linkSendImages/.test(js) && !/fun linkSendImages/.test(bridge)
  && (bridge.match(/fun linkSend\(/g) || []).length === 1);
ok("只发图也能发：空文字 + 有附件时发送键可点",
  /if \(!text && !\(state\.pcSession && state\.attachments\.length\)\) return;/.test(js)
  && /const has = \$\("#input"\)\.value\.trim\(\)\.length > 0 \|\| \(!!state\.pcSession && state\.attachments\.length > 0\);/.test(js));
ok("图片先在手机里压到链路装得下（≤4 张 / 单张 ≤900k / 总量 ≤3.2M）",
  /const PC_IMG = \{ max: 4, per: 900_000, total: 3_200_000/.test(js)
  && /function shrinkImage\(file\)/.test(js) && /createImageBitmap|new Image\(\)/.test(js));
ok("非图片附件不假装发出去（说清楚是哪一条没发）",
  /if \(otherAtt\.length\) \{[\s\S]{0,160}没发出去/.test(js));
ok("只发图的回显用哨兵对掉（不会「发一条出两条」）",
  /const IMG_ECHO_KEY = "\\u0000image";/.test(js)
  && /expectEcho\(text, imgAtt\.length > 0\)/.test(js));
ok("空入口收干净：不再引用未定义的 sheetPcActions",
  !/sheetPcActions/.test(js));
ok("会话列表读失败显示真实原因并可重试（不再一律「暂无会话」）",
  /data-retry-sessions/.test(js) && /\(!q && state\.lastError\)/.test(js)
  && /会话列表没读出来/.test(js) && /state\.lastError = "";/.test(js));

/* ---- 两端上限要对得上：手机预算 ≤ 桌面校验 ≤ 中继单包 ---- */
ok("桌面端只收 4 张、限 png/jpeg/webp/gif",
  /if \(images\.length > 4\) throw new ApiError\(413, 'too-many-images'\)/.test(pluginIndex)
  && /IMAGE_TYPES = \['image\/png', 'image\/jpeg', 'image\/webp', 'image\/gif'\]/.test(pluginIndex));
ok("中继单包上限 ≥ 6MB，且排队另有字节兜底（条数不再是唯一护栏）",
  /MAX_BODY_BYTES = 6 \* 1024 \* 1024/.test(relaySrc)
  && /MAX_ROOM_QUEUE_BYTES = 24 \* 1024 \* 1024/.test(relaySrc)
  && /queue-too-large/.test(relaySrc) && /queueBytes/.test(relaySrc));
ok("超限请求读完再回 413（读到一半就断会把客户端连接池弄脏）",
  /if \(size > MAX_BODY_BYTES\) \{ over = true; continue \}/.test(relaySrc));

console.log(fails.length ? `\n✘ ${fails.length} 项未通过：${fails.join("、")}` : "\n跨网守卫全部通过");
process.exit(fails.length ? 1 : 0);
