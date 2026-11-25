// 验证修复：合成不冻 JS 线程 + tryNow 必然收敛 + 语音回聊失败收面板
const PORT = 9227;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, (m) => res(m)); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const m = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (m.result?.exceptionDetails) return { __EXC: m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text };
  return m.result?.result?.value;
};

await ev(`(() => { window.__hb = 0; setInterval(() => window.__hb++, 200); return 1; })()`);

console.log("== 1. 异步合成期间 JS 心跳存活 ==");
console.log(JSON.stringify(await ev(`(async () => {
  const VB = window.DSHCompanion && document; // 占位
  // 直接走 VoiceBubble.doSynth（模拟陪伴语音条），合成会走到原生后台线程
  const t0 = Date.now();
  let synthSettled = null;
  const V = window.__dsh; // 拿不到 VoiceBubble 的话走 DSHHost.onSynth 路径验证
  // 触发一次异步合成（若 synthVoiceAsync 桥在，将立即返回不阻塞）
  const hasAsync = !!(window.DSHNativeKernel || true);
  try {
    // 通过内部通路触发：随便造一条语音气泡
    const r = await new Promise((res) => {
      window.__synthProbe = res;
      // VoiceBubble 不在全局；用 SpeechOut.speakAsVoice 作为公开入口
      const SpeechOut = window.__dsh && window.__dsh.SpeechOut;
      if (SpeechOut) { SpeechOut.speakAsVoice("你好呀，在吗？", 1, {}); }
      // 轮询等合成结果落进 DOM（pending 消失或失败气泡）
      const t = setInterval(() => {
        const el = document.querySelector("#messages .voice-msg");
        if (el && !el.querySelector(".vm-loading")) { clearInterval(t); res({ done: true, ms: Date.now() - t0 }); }
        if (Date.now() - t0 > 30000) { clearInterval(t); res({ done: false, timeout: true }); }
      }, 300);
    });
    return { synth: r, hb_during: window.__hb };
  } catch (e) { return { __ERR: String(e) }; }
})()`)));

const hbNow = await ev(`window.__hb`);
await new Promise((r) => setTimeout(r, 1000));
console.log("hb grows:", hbNow, "->", await ev(`window.__hb`));

console.log("== 2. tryNow 收敛性（无网络也应超时返回） ==");
console.log(JSON.stringify(await ev(`(async () => {
  try {
    window.DSHCompanion.save({ enabled: true, nextDueAt: 0 });
    const t0 = Date.now();
    await window.DSHCompanion.tryNow();
    return { settled: true, ms: Date.now() - t0 };
  } catch (e) { return { settled: "err", err: String(e && e.message || e) }; }
})()`)));
console.log("toast after:", JSON.stringify(await ev(`(() => { const t = document.querySelector("#toast"); return { text: t.textContent, on: t.classList.contains("is-on") }; })()`)));
console.log("pending:", await ev(`window.DSHCompanion.pending`));
process.exit(0);
