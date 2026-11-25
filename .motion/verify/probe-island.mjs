// 灵动岛实测：驱动 phone_* 工具（走 DSHNativeKernel.toolCall → kernel.exec 真实路径），
// 验证胶囊高度（孔径 + 上下各 5px）、点按同一窗口原地展开成卡片、hide/show、窗口存在性。
import { execSync } from "node:child_process";
import fs from "node:fs";

const PORT = 9227;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page" && p.url.includes("appassets"));
if (!page) { console.log("FAIL  没找到 appassets 页面目标"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, l, d = "") => console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "  | " + String(d).replace(/\s+/g, " ").slice(0, 150) : ""}`);
// adb 一律走绝对路径：这台机器上 Git Bash 的 PATH 时有时无，
// 之前跑过一次「'adb' 不是内部或外部命令」把整条验证误判成产品失败。
const ADB = process.env.ADB || "D:/1/tools/android-sdk/platform-tools/adb.exe";
const shot = (name) => {
  const buf = execSync(`"${ADB}" exec-out screencap -p`, { maxBuffer: 1 << 25 });
  fs.writeFileSync(`.motion/verify/island-${name}.png`, buf);
  console.log(`SHOT  island-${name}.png`);
};
const dumpsys = () => execSync(`"${ADB}" shell dumpsys window windows`, { maxBuffer: 1 << 24 }).toString();
const adbTap = (x, y) => execSync(`"${ADB}" shell input tap ${x} ${y}`);
shot("0-prewarm"); // 首张 screencap 冷启动要几秒，先预热免得错过展开态（3.5s 收缩）

// 0) 桥可达 + 结果捕获钩子（emitRaw 每次现读 window.DSHHost.onToolResult，覆盖生效）
const bridge = await ev(`(() => {
  if (!window.DSHNativeKernel || !window.DSHNativeKernel.toolCall) return "no-bridge";
  window.__tres = {};
  const h = window.DSHHost;
  if (h && h.onToolResult) {
    const orig = h.onToolResult.bind(h);
    h.onToolResult = (id, json) => { window.__tres[id] = json; try { orig(id, json); } catch (e) {} };
  }
  return "hooked";
})()`);
ok(bridge === "hooked", "内核桥可达 + 结果钩子挂上", bridge);
const tool = async (name, args) => {
  const tid = "t" + Math.random().toString(36).slice(2, 7);
  await ev(`window.DSHNativeKernel.toolCall(${JSON.stringify(tid)}, ${JSON.stringify(name)}, ${JSON.stringify(JSON.stringify(args || {}))}); 1`);
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    let r = await ev(`window.__tres[${JSON.stringify(tid)}] || null`);
    if (r) {
      try { r = typeof r === "string" ? JSON.parse(r) : r; } catch (_) { return { ok: false, raw: String(r).slice(0, 100) }; }
      // 桥返回 {ok, output: <工具 JSON 字符串>}，解一层
      if (r && typeof r.output === "string") { try { return JSON.parse(r.output); } catch (_) { return { ok: false, raw: r.output.slice(0, 100) }; } }
      return r;
    }
  }
  return { ok: false, error: "工具 10s 没回结果" };
};

// 1) screen_read：岛应展开显示「读屏 · N 元素 · app」
const r1 = await tool("screen_read", { max_elements: 40 });
ok(r1.ok === true, "screen_read 执行", JSON.stringify(r1).slice(0, 120));
console.log(`      app=${r1.app} elements=${r1.interactive_count} screen=${JSON.stringify(r1.screen)}`);
shot("1-expanded");

// 2) 静默 >3.5s：应收成简略胶囊（只剩「读屏」）
await sleep(4200);
shot("2-collapsed");

// 3) phone_island 自定义文案（模型报进度的通道）
const r3 = await tool("phone_island", { action: "text", text: "实测：填表 2/5" });
ok(r3.ok === true, "phone_island text", JSON.stringify(r3).slice(0, 80));
shot("3-custom");

// 4) 按键 + 换应用后读屏：detail 带前台包名
const r4 = await tool("phone_key", { key: "home" });
ok(r4.ok === true, "phone_key home", JSON.stringify(r4).slice(0, 80));
await sleep(400);
const r5 = await tool("screen_read", { max_elements: 20 });
ok(r5.ok === true, "桌面 screen_read", `app=${r5.app}`);
shot("4-after-home");

// 5) 坐标点击（桌面壁纸空白处，无害）
const r6 = await tool("phone_tap", { x: 540, y: 1400 });
ok(r6.ok === true, "phone_tap 执行", JSON.stringify(r6).slice(0, 100));
shot("5-tap");

// 6) 窗口存在性 + hide/show
const hasIsland = dumpsys().includes("DSHControlIsland");
ok(hasIsland, "dumpsys 可见悬浮窗窗口（DSHControlIsland）");
await tool("phone_island", { action: "hide" });
await sleep(600);
const gone = !dumpsys().includes("DSHControlIsland");
await tool("phone_island", { action: "show" });
await sleep(600);
const back = dumpsys().includes("DSHControlIsland");
ok(gone && back, "hide 后窗口消失、show 后恢复", `gone=${gone} back=${back}`);

// 7) 收起几何：高度 = 视觉孔径 66px + 上下各 5px = 76px
// 视觉窗口现在恒为最大卡片尺寸（永不 resize），几何量测改看全透明热区窗口：
// 它的尺寸 == 当前可见形状的尺寸，且它不画任何像素，怎么切都看不见。
const frameOf = () => {
  const m = dumpsys().match(/Window\{[^}]+ DSHControlIslandTouch\}[\s\S]*?frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  return m ? { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4], w: +m[3] - +m[1], h: +m[4] - +m[2] } : null;
};
const idle = frameOf();
ok(idle && idle.h >= 70 && idle.h <= 82, "收起态：孔径 66px + 上下各 5px = 76px", `h=${idle?.h}px w=${idle?.w}px`);
ok(idle && idle.w < 420, "胶囊已缩短（旧版 468px 近半屏）", `w=${idle?.w}px`);
// 挖孔外包盒中心约 551px（本机实测），屏幕中心 540；胶囊必须绕孔心对称，
// 允许 20px 容差。文案长短变化也不该把胶囊中心推走。
ok(idle && Math.abs(idle.x1 + idle.w / 2 - 551) <= 20,
  "摄像头在胶囊正中（胶囊以孔心为轴）", `center=${idle?.x1 + idle?.w / 2} w=${idle?.w}`);

// 7b) 胶囊宽度是常量：长文案只能跑马灯 / 精简，绝不能把胶囊撑长
const w0 = frameOf()?.w;
await tool("phone_island", { action: "text", text: "这是一个特别特别长的超长状态文案用来验证胶囊宽度恒定" });
await sleep(350);
const w1 = frameOf()?.w;
shot("3b-long-text");
ok(w0 != null && w1 === w0, "长文案不改变胶囊默认宽度（固定文字槽 + 跑马灯）", `w ${w0}->${w1}`);

// 7c) 静态守卫：动画帧里不许再出现窗口参数更新（逐帧 relayout 就是卡顿根因）
const src = fs.readFileSync(
  "app/src/main/java/ai/deepseek/harness/mobile/kernel/plugin/builtin/device/ControlIslandPlugin.kt",
  "utf8",
);
const listener = src.slice(src.indexOf("addUpdateListener"), src.indexOf("addListener(object"));
ok(listener.length > 0 && !listener.includes("updateOverlay") && listener.includes("invalidate("),
  "展开动画纯 Canvas 重绘，逐帧不触发窗口 relayout");
const switchCount = (src.match(/svc\.updateOverlay\(/g) || []).length;
ok(switchCount === 1, "只有透明热区会更新窗口参数（视觉窗口 0 次）", `calls=${switchCount}`);
// 左右晃动的根：窗口 x/width 只要变过，就有「旧 Surface buffer + 新窗口位置」的
// 错位帧，整块岛瞬移 pillX-cardX ≈ 309px。根治 = 视觉窗口一个字段都不改。
const apply = src.slice(src.indexOf("private fun applyWindowMode"), src.indexOf("private fun pillLabel"));
ok(apply.includes("touchParams") && !/\bp\.(width|height|x|y)\s*=/.test(apply),
  "形态切换只改透明热区，视觉窗口几何零改动");
ok(src.includes("FLAG_NOT_TOUCHABLE") && (src.match(/attachOverlay\(/g) || []).length === 2,
  "视觉窗口不可点 + 独立透明热区（不吞顶部点击）");
const geom = src.slice(src.indexOf("private fun geom()"), src.indexOf("override fun onDraw"));
ok(geom.includes("val cCard = cardW / 2f") && geom.includes("val c = cCard + dxOffset") &&
  geom.includes("gL = c - half") && geom.includes("gR = c + half")
  && !geom.includes("if (!wide)") && !geom.includes("width <"),
  "形状以孔心为轴；设置页的水平偏移只在收起态生效，展开时归中");
// translationX 曾经是「窗口切换错位」的元凶：窗口 x 变了、内容却已按新坐标画。
// 现在视觉窗口恒定，唯一允许的 translationX 是设置页给的胶囊偏移（pillDx），
// 它不参与任何窗口切换 —— 有第二处赋值就说明旧补偿思路又回来了。
const txAssigns = [...src.matchAll(/\.translationX\s*=\s*([^\n]+)/g)].map((m) => m[1].trim());
ok(txAssigns.length > 0 && txAssigns.every((x) => x.includes("pillDx")),
  "唯一 translationX 是设置页偏移（不用于窗口切换补偿）", txAssigns.join(" / "));
ok(src.includes("pillW, pillH, Gravity.TOP or Gravity.CENTER_HORIZONTAL"),
  "胶囊靠 CENTER_HORIZONTAL 居中（屏幕绝对位置恒定）");
ok(src.includes("0f, 0f, 0f, h.coerceAtLeast(1f)"),
  "渐变纯垂直，全过程中颜色连续");
// 卡片内容必须给挖孔让位：标题只在孔左栏，详情压到孔下沿之后
ok(src.includes("val titleW =") && src.includes("titleW, LinearLayout.LayoutParams.WRAP_CONTENT"),
  "卡片标题固定在挖孔左侧（字不会被摄像头盖住）");
ok(src.includes("minimumHeight = headMinH") && src.includes("val holeBottom ="),
  "详情正文压到挖孔下沿之后");
// 留白必须跟着孔径走：固定像素在换机型时比例会完全变样（用户问过两次）
const geo = fs.readFileSync(
  "app/src/main/java/ai/deepseek/harness/mobile/kernel/plugin/builtin/device/IslandGeometry.kt",
  "utf8",
);
ok(!src.includes("EDGE_PAD_PX") && src.includes("IslandGeometry.edgePadPx"),
  "胶囊高度走 IslandGeometry（按孔径比例），不是写死像素");
ok(geo.includes("EDGE_PAD_RATIO") && geo.includes("EDGE_PAD_MIN_DP") && geo.includes("EDGE_PAD_MAX_DP"),
  "留白比例带上下限（小孔不贴边、大孔不变厚黑边）");

// 8) 点按 = **同一个窗口**原地长成卡片：变宽变高、顶边 y 不动、没有第二个岛窗口
ok(dumpsys().includes("DSHControlIsland"), "点按前窗口仍在");
await sleep(4000); // 先等静默，从稳定态开始点
// 按窗口实际 frame 取点，别写死坐标：不同机型/挖孔下胶囊位置不一样
const tapX = idle.x2 - 18;
const tapY = Math.round((idle.y1 + idle.y2) / 2);
adbTap(tapX, tapY);
await sleep(700);
let open = frameOf();
// 冷启动后第一次点按可能被系统吞（无障碍服务刚绑定、首帧还没就绪）。
// 之前这会让「展开」假红一次 —— 自愈重试一次，别把环境波动当成产品缺陷。
if (open && idle && open.w <= idle.w + 20) {
  adbTap(tapX, tapY);
  await sleep(900);
  open = frameOf();
}
shot("6-tap-expanded");
// 切换前后「胶囊左边缘的屏幕绝对坐标」必须完全相等：
//   窄窗口 = pillX + 0                      宽窗口 progress=0 = cardX + (cardW-pillW)/2
// 不等就说明宽窄窗口没共轴，或内容被同步补偿过 —— 用户看到的就是左右跳一下。
ok(open && idle && Math.abs(idle.x1 - (open.x1 + (open.w - idle.w) / 2)) <= 2,
  "窗口切换前后胶囊屏幕位置恒等（无左右瞬移）",
  `窄=${idle?.x1} 宽=${open?.x1}+${((open?.w - idle?.w) / 2)}`);
const titles = [...new Set(dumpsys().match(/DSHControlIsland[A-Za-z]*/g) || [])];
ok(open && open.w > idle.w * 2 && open.h > idle.h + 40,
  "同一窗口原地展开成卡片（变宽变高）", `w ${idle.w}->${open?.w}  h ${idle.h}->${open?.h}`);
ok(open && open.h < 300, "卡片按内容测高，下半不留大片空白", `h=${open?.h}px`);
ok(open && Math.abs(open.y1 - idle.y1) <= 2,
  "展开前后顶边 y 不变（不是另挂一张卡）", `y1 ${idle.y1}->${open?.y1}`);
ok(titles.includes("DSHControlIsland") && titles.includes("DSHControlIslandTouch")
  && !titles.some((t) => t.includes("Card")),
  "只有一个可见岛窗口（另一个是全透明点击层，不是另挂的卡片）",
  `titles=${titles.join(",")}`);
adbTap(tapX, tapY);
await sleep(700);
shot("7-tap-collapsed");
const folded = frameOf();
ok(folded && Math.abs(folded.w - idle.w) <= 2 && Math.abs(folded.h - idle.h) <= 2,
  "再点收回胶囊尺寸", `w=${folded?.w} h=${folded?.h}`);
const png = (f) => fs.readFileSync(`.motion/verify/island-${f}.png`);
const a = png("6-tap-expanded"), b = png("7-tap-collapsed");
let diff = 0; const step = Math.max(1, Math.floor(a.length / 4096));
for (let i = 0; i < a.length; i += step) if (a[i] !== b[i]) diff++;
// 不要求两张 PNG 字节数相等：画面不同压缩后长度本就不一样，只比内容差异桶数
ok(diff > 4, "点按展开/收起有视觉变化", `diffBuckets=${diff}`);

process.exit(0);
