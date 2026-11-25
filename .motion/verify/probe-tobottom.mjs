// 长会话夹具 + 回到底部按钮几何实测:
//   .to-bottom 的 rect vs .composer-dock 的 rect(是否重叠), --dock-h 与 dock.offsetHeight 是否一致。
const PORT = 9227;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[geom]", ...a);

// 0) 造一个长会话(60 条消息),写进 LocalDB 同一结构,再刷新
const n = await ev(`(() => {
  const KEY = "dsh.local.sessions";
  const idx = JSON.parse(localStorage.getItem(KEY) || "[]");
  if (idx.some(s => s.title === "probe-long")) return idx.find(s => s.title === "probe-long").id;
  const id = "s" + Date.now().toString(36);
  idx.unshift({ id, title: "probe-long", createdAt: Date.now(), updatedAt: Date.now() });
  localStorage.setItem(KEY, JSON.stringify(idx));
  const msgs = [];
  for (let i = 0; i < 30; i++) {
    msgs.push({ role: "user", content: "第" + i + "条:帮我看看这个问题的来龙去脉,越详细越好,麻烦了。", at: Date.now() - (60 - i) * 1000 });
    msgs.push({ role: "assistant", content: "第" + i + "条回复:好的,这个问题要从三个层面看。首先是表象,其次是成因,最后是解法。我把每一点都展开说一下,你可以对照着检查。", at: Date.now() - (60 - i) * 1000 + 500 });
  }
  localStorage.setItem("dsh.local.sess." + id, JSON.stringify({ id, messages: msgs, shot: null }));
  return id;
})()`);
log("session:", n);
await ev(`localStorage.setItem("dsh.perm", "full"); 1`);
await send("Page.reload", {});
await sleep(6500);

// 1) 打开该会话
const opened = await ev(`(() => {
  const rows = [...document.querySelectorAll(".sess-row, [data-session-id], .list .row")];
  const hit = rows.find(r => (r.textContent || "").includes("probe-long"));
  if (hit) { hit.click(); return "clicked"; }
  return "not-found:" + rows.length;
})()`);
log("open:", opened);
await sleep(2500);

// 2) 向上滚,让按钮出现
await ev(`(() => { const sc = document.querySelector("#chatScroll"); sc.scrollTop = Math.max(0, sc.scrollHeight - sc.clientHeight - 2000); return sc.scrollTop; })()`);
await sleep(600);

const geom = await ev(`(() => {
  const btn = document.querySelector("#toBottom");
  const dock = document.querySelector(".composer-dock");
  if (!btn || !dock) return { err: "missing" };
  const b = btn.getBoundingClientRect();
  const d = dock.getBoundingClientRect();
  const cs = getComputedStyle(btn);
  return {
    btnHidden: btn.hidden,
    btnRect: { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) },
    dockRect: { top: Math.round(d.top), bottom: Math.round(d.bottom), h: Math.round(d.height) },
    overlap: !btn.hidden && b.bottom > d.top,
    overlapPx: Math.round(b.bottom - d.top),
    dockH: getComputedStyle(document.documentElement).getPropertyValue("--dock-h"),
    dockOffsetH: dock.offsetHeight,
    kb: getComputedStyle(document.documentElement).getPropertyValue("--kb"),
    kbOpen: document.documentElement.classList.contains("kb-open"),
    bottomCss: cs.bottom,
    gapSetting: (parseFloat(cs.bottom) || 0),
  };
})()`);
log("geom:", JSON.stringify(geom, null, 1));

// 3) 键盘打开时的几何(模拟 focus 输入框)
await ev(`(() => { const t = document.querySelector("#input"); t.focus(); return 1; })()`);
await sleep(1200);
const geom2 = await ev(`(() => {
  const btn = document.querySelector("#toBottom");
  const dock = document.querySelector(".composer-dock");
  const b = btn.getBoundingClientRect();
  const d = dock.getBoundingClientRect();
  return {
    btnHidden: btn.hidden,
    btnBottom: Math.round(b.bottom), dockTop: Math.round(d.top),
    overlap: !btn.hidden && b.bottom > d.top, overlapPx: Math.round(b.bottom - d.top),
    dockH: getComputedStyle(document.documentElement).getPropertyValue("--dock-h"),
    dockOffsetH: dock.offsetHeight,
    kb: getComputedStyle(document.documentElement).getPropertyValue("--kb"),
    kbOpen: document.documentElement.classList.contains("kb-open"),
  };
})()`);
log("geom kb:", JSON.stringify(geom2, null, 1));
