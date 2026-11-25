// 对话内搜索（复用输入框）+ 回到底部按钮 的真机整链验收
// 用法：模拟器已装 debug 包并完成 adb forward tcp:9227
const PORT = 9227;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => m.error ? rej(new Error(m.error.message)) : res(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tap = async (sel) => {
  const pt = await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (!pt) return false;
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: pt.x, y: pt.y, id: 1 }] });
  await sleep(40);
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  return true;
};
const checks = [];
const check = (name, ok, info = "") => { checks.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  → " + info : ""}`); };

await send("Page.reload", {});
await sleep(6000);

// 1) 进入一个有内容的会话（行打开走指针手势，必须发真实触摸，el.click() 无效）
let msgs = await ev(`document.querySelectorAll("#messages .msg").length`);
if (!msgs) {
  await ev(`document.querySelector('.tab[data-tab="sessions"]')?.click(); 1`);
  await sleep(600);
  await tap("#screen-sessions .sess-row");
  await sleep(1800);
  msgs = await ev(`document.querySelectorAll("#messages .msg").length`);
}
check("会话里有消息可搜", msgs > 0, `${msgs} 条`);
if (!msgs) { console.log("没有可用会话，中止"); ws.close(); process.exit(1); }

// 2) 留个草稿（进搜索前），打开更多面板 → 在对话中搜索
await ev(`(() => { const i = document.querySelector("#input"); i.value = "我的草稿"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
await tap("#btnChatMore");
await sleep(700);
const opened = await ev(`!!document.querySelector('.sheet-item[data-act="search"]')`);
check("更多面板有搜索入口", opened);
await ev(`document.querySelector('.sheet-item[data-act="search"]')?.click(); 1`);
await sleep(600);

// 3) 接管态断言
const mode = await ev(`(() => {
  const dock = document.querySelector(".composer-dock");
  const input = document.querySelector("#input");
  const use = document.querySelector("#btnSend use");
  return {
    searching: dock?.classList.contains("is-searching"),
    attachHidden: getComputedStyle(document.querySelector("#btnAttach")).display === "none",
    sendIcon: use?.getAttribute("href"),
    placeholder: input?.getAttribute("placeholder"),
    enterkey: input?.getAttribute("enterkeyhint"),
    chip: !!document.querySelector("#modeBar .mode-chip.search"),
  };
})()`);
check("输入框进入搜索接管态", mode.searching === true && mode.attachHidden && mode.sendIcon === "#i-chevron-down",
  JSON.stringify(mode));
check("placeholder 与 enterkeyhint 切换", mode.placeholder === "在对话中搜索" && mode.enterkey === "search");
check("modeBar 出现搜索签", mode.chip);

// 4) 输关键词 → 命中。挑一个至少命中 2 条消息的子串（没有就退而取首条前 4 字）
const kw = await ev(`(() => {
  const texts = [...document.querySelectorAll("#messages .msg")].map((el) => (el.textContent || "").trim());
  for (const t of texts) {
    for (let len = 6; len >= 2; len--) {
      const s = t.slice(0, len);
      if (s && texts.filter((x) => x.includes(s)).length >= 2) return s;
    }
  }
  return (texts[0] || "").slice(0, 4);
})()`);
check("取到关键词", !!kw, kw);
await ev(`(() => { const i = document.querySelector("#input"); i.value = ${JSON.stringify(kw)}; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
await sleep(500);
const hit = await ev(`(() => {
  const chip = document.querySelector("#modeBar .mode-chip.search .mc-text");
  return { count: chip?.textContent, hits: document.querySelectorAll("#messages .msg.is-hit").length };
})()`);
check("命中描边 + 计数", hit.hits > 0 && /\\d+\\/ && String(hit.count).includes("/"), JSON.stringify(hit));

// 5) 发送键 = 下一处（多条时计数应 +1）
const before = hit.count;
await ev(`document.querySelector("#btnSend").click(); 1`);
await sleep(300);
const after = await ev(`document.querySelector("#modeBar .mode-chip.search .mc-text")?.textContent`);
check("发送键跳下一处", before !== after, `${before} → ${after}`);

// 6) 退出还原（搜索态里打的字会被丢弃，草稿应在退出时找回）
await ev(`document.querySelector("[data-search-close]")?.click(); 1`);
await sleep(300);
const restored = await ev(`(() => {
  const input = document.querySelector("#input");
  const use = document.querySelector("#btnSend use");
  return {
    searching: document.querySelector(".composer-dock")?.classList.contains("is-searching"),
    draft: input?.value,
    placeholder: input?.getAttribute("placeholder"),
    sendIcon: use?.getAttribute("href"),
    hitLeft: document.querySelectorAll("#messages .msg.is-hit").length,
    chipLeft: !!document.querySelector("#modeBar .mode-chip.search"),
  };
})()`);
check("退出后草稿/图标/placeholder 全还原",
  !restored.searching && restored.draft === "我的草稿" && restored.placeholder === "发消息给 Agent…" &&
  restored.sendIcon === "#i-send" && !restored.hitLeft && !restored.chipLeft, JSON.stringify(restored));

// 7) 回到底部按钮：几何 + 动画。
//    显隐逻辑（离底 >120px 浮出）本轮没动，不动它；这里直接把按钮显出来量
//    「与输入框的间距」和「三点常驻跳跃」—— 这两处才是本轮改的。
const tb = await ev(`(() => {
  const btn = document.querySelector("#toBottom");
  if (!btn) return { shown: false };
  btn.hidden = false;
  return new Promise((res) => setTimeout(() => {
    const b = btn.getBoundingClientRect();
    const dock = document.querySelector(".composer-dock").getBoundingClientRect();
    const dot = getComputedStyle(btn.querySelector(".tb-dot"));
    res({
      shown: true,
      gap: Math.round(dock.top - b.bottom),
      anim: dot.animationName, dur: dot.animationDuration,
      count: document.querySelectorAll("#messages .msg").length,
    });
  }, 400));
})();
`);
check("回到底部按钮在输入框上方且不相叠", tb.shown && tb.gap >= 12, JSON.stringify(tb));
check("三点常驻跳跃动画", tb.anim === "tbHop", `anim=${tb.anim} dur=${tb.dur}`);

// 8) 截图留档
import { writeFileSync } from "node:fs";
await send("Page.captureScreenshot", { format: "png" }).then((r) => {
  if (r?.data) writeFileSync("D:/1/dsh-mobile/.motion/verify/search-composer.png", Buffer.from(r.data, "base64"));
});

const fails = checks.filter((c) => !c.ok).length;
console.log(fails ? `FAILURES: ${fails}` : "ALL PASS");
ws.close();
process.exit(fails ? 1 : 0);
