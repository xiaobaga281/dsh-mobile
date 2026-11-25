// 灵动岛调参：位置 / 长度 / 上下留白 —— 实机验证
//   1) 设置页有「灵动岛」入口，点开是 3 个滑块
//   2) 推参数后窗口几何真的变（宽度 / 高度 / x 位置）
//   3) 恢复默认回到基线
import { execFileSync } from "node:child_process";

const ADB = "D:/1/tools/android-sdk/platform-tools/adb.exe";
const PORT = 9227;
const PKG = "ai.deepseek.harness.mobile";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (args) => execFileSync(ADB, args, { encoding: "utf8", maxBuffer: 1 << 24 });
const ok = (c, l, d = "") => console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "  | " + String(d).replace(/\s+/g, " ").slice(0, 180) : ""}`);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page" && p.url.includes("appassets"));
if (!page) { console.log("FAIL  没找到 appassets 页面"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => (await send("Runtime.evaluate", {
  expression: expr, returnByValue: true, awaitPromise: true,
})).result?.value;

const frame = () => {
  const s = adb(["shell", "dumpsys", "window", "windows"]);
  const m = s.match(/Window\{[^}]+ DSHControlIslandTouch\}[\s\S]*?frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  return m ? { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4], w: +m[3] - +m[1], h: +m[4] - +m[2] } : null;
};
const tune = async (t) => {
  const r = await ev(`(() => { try { return JSON.parse(window.DSHNativeKernel.islandTune(${JSON.stringify(JSON.stringify(t))}) || '{}'); } catch(e) { return {err:String(e)}; } })()`);
  await sleep(900); // 重建在主线程 post，等它跑完
  return r;
};

// 设置页入口 + 面板内容（走真实点击，不调内部函数）
const hasRow = await ev(`!!document.querySelector('#rowIsland')`);
ok(hasRow === true, "设置页有「灵动岛」入口");
const sheet = await ev(`(() => {
  const row = document.querySelector('#rowIsland');
  if (!row) return { err: 'no row' };
  row.click();
  return { title: document.querySelector('#sheetBody .sheet-title')?.textContent || '',
           inputs: [...document.querySelectorAll('#sheetBody .island-set input[type=range]')].map(x => x.id) };
})()`);
await sleep(300);
ok(sheet && sheet.title === "灵动岛" && sheet.inputs?.length === 4,
  "面板有 4 个滑块（水平 / 垂直 / 长度 / 内边距）", JSON.stringify(sheet));

// ---- 真实拖动：走前端 input 事件 → pushIslandTune → 桥 → 原生 ----
// 上一版探针直接调 islandTune()，于是「前端 islandTuneValue 漏了 dy」这件事它测不出来：
// 桥收得到参数、探针全绿，而用户在面板里拖同一个滑块毫无反应。
const drag = async (key, value) => {
  const r = await ev(`(() => {
    const el = document.querySelector('#is-${key}');
    if (!el) return { err: 'no #is-${key}' };
    el.value = ${value};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { value: el.value, label: document.querySelector('#iv-${key}')?.textContent || '' };
  })()`);
  await sleep(900);
  return r;
};

const dv0 = await drag("dy", 0);
const baseTune = frame();
ok(baseTune && baseTune.w > 0, "一拖滑块岛就自己出现（不用先手动 show）", JSON.stringify(baseTune));

const dv = await drag("dy", 60);
const fdy = frame();
ok(dv && !dv.err, "面板里有可拖动的垂直滑块", JSON.stringify(dv));
ok(fdy && baseTune && Math.abs(fdy.y1 - (baseTune.y1 + 60)) <= 4,
  "垂直滑块生效（走前端真实拖动）：热区 y +60",
  `${baseTune?.y1} → ${fdy?.y1}，读数=${dv?.label}`);
ok(fdy && fdy.w === baseTune.w && fdy.h === baseTune.h,
  "垂直偏移不改宽高（只移位，不变形）", JSON.stringify(fdy));

// 拖回 0 必须回原位 —— 否则「往上调不回去」等于单向卡死
await drag("dy", 0);
const fdy0 = frame();
ok(fdy0 && baseTune && Math.abs(fdy0.y1 - baseTune.y1) <= 3, "垂直拖回 0 回到原位", `y1=${fdy0?.y1}`);

for (const [k, v] of [["dy", 0], ["dx", 0]]) await drag(k, v);
await ev(`(() => { const b = document.querySelector('#sheet [data-close]'); if (b) b.click(); return 1; })()`);
await sleep(400);

// 先确保岛在
await ev(`window.DSHNativeKernel.toolCall('t0', 'phone_island', JSON.stringify({action:'show'})); 1`);
await sleep(1200);
const base = frame();
ok(base && base.w === 378 && base.h === 76, "基线：378×76", JSON.stringify(base));

// 长度 420 + 内边距 10 → 420 × 86
const r1 = await tune({ dx: 0, w: 420, pad: 10 });
const f1 = frame();
ok(r1?.ok === true, "参数被原生接受", JSON.stringify(r1));
ok(f1 && f1.w === 420, "长度滑块生效：宽度 378 → 420", JSON.stringify(f1));
ok(f1 && f1.h === 66 + 20, "内边距滑块生效：高度 76 → 86", JSON.stringify(f1));

// 水平位置 +80 → x 右移 80，宽高回默认
const r2 = await tune({ dx: 80, w: 0, pad: -1 });
const f2 = frame();
ok(f2 && Math.abs(f2.x1 - (base.x1 + 80)) <= 2, "位置滑块生效：x +80", `${base.x1} → ${f2?.x1}`);
ok(f2 && f2.w === 378 && f2.h === 76, "长度/留白回到默认", JSON.stringify(f2));

// 恢复默认
const r3 = await tune({ dx: 0, w: 0, pad: -1 });
const f3 = frame();
ok(f3 && f3.x1 === base.x1 && f3.w === base.w && f3.h === base.h, "恢复默认回到基线", JSON.stringify(f3));

// 越界夹取
const r4 = await tune({ dx: 999, w: 9999, pad: 999 });
const f4 = frame();
ok(r4?.dx === 200 && r4?.w === 520 && r4?.pad === 24, "越界值被夹住（不让岛跑出屏幕）", JSON.stringify(r4));
ok(f4 && f4.x2 <= 1080 && f4.x1 >= 0, "夹取后仍在屏幕内", JSON.stringify(f4));

// 收尾：回默认，别把调试值留在设备上
await tune({ dx: 0, w: 0, pad: -1 });
console.log("  已恢复默认");
process.exit(0);
