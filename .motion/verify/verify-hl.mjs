import { writeFileSync } from "node:fs";
const PORT = 9227;
const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = l.find((x) => x.type === "page") || l[0];
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
let i = 0; const m = new Map();
ws.addEventListener("message", (e) => { const d = JSON.parse(e.data); if (d.id && m.has(d.id)) { m.get(d.id)(d); m.delete(d.id); } });
const s = (me, pa = {}) => new Promise((res, rej) => { const k = ++i; m.set(k, (x) => x.error ? rej(new Error(x.error.message)) : res(x.result)); ws.send(JSON.stringify({ id: k, method: me, params: pa })); });
const ev = async (e) => { const r = await s("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); return r.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tap = async (sel) => {
  const pt = await ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;const b=el.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`);
  if (!pt) return false;
  await s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: pt.x, y: pt.y, id: 1 }] });
  await sleep(40);
  await s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  return true;
};
const checks = [];
const check = (name, ok, extra = "") => { checks.push({ name, ok, extra }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); };

// 1) 进会话（reload 后多半停在会话列表；点第一行）
let screen = await ev(`document.querySelector(".screen.is-active")?.dataset.screen`);
if (screen !== "chat") {
  await ev(`document.querySelector('.tab[data-tab="sessions"]')?.click(); 1`);
  await sleep(700);
  await tap("#screen-sessions .sess-row");
  await sleep(1800);
}
const msgs = await ev(`document.querySelectorAll("#messages .msg").length`);
check("进入有内容的会话", msgs > 0, `msgs=${msgs}`);

// 2) 选一个出现>=2次的中文/英文词作为关键词
const kw = await ev(`(() => {
  const txt = (document.querySelector("#messages")?.innerText || "").replace(/\\s+/g, " ");
  const cand = txt.match(/[一-龥]{2,4}|[A-Za-z]{3,8}/g) || [];
  const freq = {};
  for (const w of cand) freq[w] = (freq[w] || 0) + 1;
  const hit = Object.keys(freq).filter(w => freq[w] >= 2).sort((a,b)=>freq[b]-freq[a])[0];
  return hit || "";
})()`);
check("找到可复现关键词", !!kw, `kw=${kw}`);

// 3) 开搜索（更多 → 在对话中搜索）
await tap("#btnChatMore");
await sleep(700);
await ev(`document.querySelector('.sheet-item[data-act="search"]')?.click(); 1`);
await sleep(500);
const on = await ev(`document.documentElement.classList.contains("search-on")`);
check("search-on 类已挂上（回到底部按钮避让开关）", on === true);

// 4) 输入关键词
await ev(`(() => { const i = document.querySelector("#input"); i.value = ${JSON.stringify(kw)}; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
await sleep(400);

// 5) 断言：生成了 mark，且当前命中带 hl-cur；计数签显示 N/N
const r1 = await ev(`(() => {
  const marks = [...document.querySelectorAll("#messages mark.hl")];
  const cur = document.querySelectorAll("#messages mark.hl-cur").length;
  const count = document.querySelector(".mode-chip.search .mc-text")?.textContent || "";
  return { total: marks.length, cur, count, sample: (marks[0]?.textContent || "") };
})()`);
check("命中字符被 <mark> 包裹（绿高亮）", r1.total >= 2, `marks=${r1.total} 样例=${r1.sample}`);
check("当前命中带 hl-cur", r1.cur >= 1, `cur=${r1.cur}`);
check("计数签显示 1/N", r1.count.startsWith("1/") && /\d/.test(r1.count), `count=${r1.count}`);

// 6) 回到底部按钮避让：搜索态下比 dock 顶至少高 40px（基线 16 + 搜索 52 = 68）。
//    短会话滚动余量不足、按钮本就隐藏，这里强制让其可见只为了量几何（不参与真实显隐判断）。
const tb = await ev(`(() => {
  const btn = document.querySelector("#toBottom");
  if (!btn) return { shown: false };
  btn.hidden = false;                 // 强制可见，仅用于测量
  const dock = document.querySelector(".composer-dock").getBoundingClientRect();
  const b = btn.getBoundingClientRect();
  const gap = Math.round(dock.top - b.bottom);
  btn.hidden = true;                  // 还原真实显隐
  return { shown: true, gap };
})()`);
check("搜索态回到底部按钮避让（浮在搜索签上方）", tb.shown && tb.gap >= 40, JSON.stringify(tb));

// 7) 跳转下一处：hl-cur 数量保持、计数变 2/N
await ev(`document.querySelector("#btnSend")?.click(); 1`);
await sleep(500);
const r2 = await ev(`(() => {
  const cur = document.querySelectorAll("#messages mark.hl-cur").length;
  const count = document.querySelector(".mode-chip.search .mc-text")?.textContent || "";
  return { cur, count };
})()`);
check("下一处后 hl-cur 仍在且计数前进", r2.cur >= 1 && r2.count.startsWith("2/") && /\d/.test(r2.count), JSON.stringify(r2));

// 8) 退出搜索：mark 全部还原、search-on 摘除、输入框草稿找回
await ev(`document.querySelector("[data-search-close]")?.click(); 1`);
await sleep(400);
const r3 = await ev(`(() => {
  return {
    marks: document.querySelectorAll("#messages mark").length,
    on: document.documentElement.classList.contains("search-on"),
    draft: document.querySelector("#input").value,
  };
})()`);
check("退出后 mark 全部 unwrap 还原", r3.marks === 0, `marks=${r3.marks}`);
check("退出后 search-on 摘除（避让复位）", r3.on === false);

// 9) 截图：搜索态绿高亮
await tap("#btnChatMore"); await sleep(600);
await ev(`document.querySelector('.sheet-item[data-act="search"]')?.click(); 1`); await sleep(400);
await ev(`(() => { const i = document.querySelector("#input"); i.value = ${JSON.stringify(kw)}; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
await sleep(400);
const shot = await s("Page.captureScreenshot", { format: "png" });
writeFileSync("D:/1/dsh-mobile/.motion/verify/hl-active.png", Buffer.from(shot.data, "base64"));
console.log("shot saved");

ws.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} PASS ===`);
process.exit(failed.length ? 1 : 0);
