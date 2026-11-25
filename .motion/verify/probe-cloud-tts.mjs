// 云端语音模型探针：用本地假 TTS 服务跑通「配置 → UI → 请求 → 朗读/语音条 → 关掉回退」。
// 不依赖任何真实厂商账号；假服务返回一段 0.3s 的 wav，顺便把请求体记下来核对。
//
// 内置神经模型 / 经典男整条删除后，这个探针替代原来的 probe-voice / repro-voice /
// verify-bazong（那三个都依赖已删的 neuralStatus，留着只会假绿）。
import http from "node:http";
import { execFileSync } from "node:child_process";

const ADB = "D:/1/tools/android-sdk/platform-tools/adb.exe";
const PORT = 8898;
const ENDPOINT = `http://127.0.0.1:${PORT}/v1/audio/speech`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...args) => execFileSync(ADB, args, { encoding: "utf8", maxBuffer: 1 << 22 });

let fails = 0;
const ok = (cond, label, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) fails++;
};

function wavBytes() {
  const rate = 16000;
  const n = rate * 0.3;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 3000), 44 + i * 2);
  }
  return b;
}

const wav = wavBytes();
const requests = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (req.method !== "POST") { res.writeHead(404).end(); return; }
    requests.push({ url: req.url, headers: req.headers, body });
    console.log("  [假 TTS] POST", req.url, "body=", body.slice(0, 160));
    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length });
    res.end(wav);
  });
});
server.on("error", (e) => { console.error("FAIL  假 TTS 服务起不来：", e.message); process.exit(1); });
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
// 模拟器访问宿主 loopback 走 adb reverse（比 10.0.2.2 稳，也不用监听 0.0.0.0）
try { adb("reverse", `tcp:${PORT}`, `tcp:${PORT}`); } catch (e) { console.error("FAIL  adb reverse:", e.message); process.exit(1); }
console.log("probe start · 假 TTS 监听 127.0.0.1:" + PORT);

// ---- CDP ----
const list = await (await fetch("http://127.0.0.1:9227/json/list")).json();
const page = list.find((p) => p.type === "page" && p.url.includes("appassets"));
if (!page) { console.error("FAIL  找不到 WebView 页面（确认 adb forward tcp:9227）"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let id = 0;
const pend = new Map();
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

const cfg = (o) => ev(`DSHNativeVoice.cloudTtsSet(${JSON.stringify(JSON.stringify(o))})`);
const readCfg = () => ev(`DSHNativeVoice.cloudTtsConfig()`);

try {
  // 0) 从干净状态起步
  await cfg({ enabled: false, endpoint: "", apiKey: "", model: "", clearKey: true });
  const before = JSON.parse(await readCfg());
  ok(!before.usable && !before.hasKey, "初始未配置：usable=false、无密钥", JSON.stringify(before));

  // 1) 设置页入口与表单
  await ev(`(() => { const b=document.querySelector('#sheet [data-close]'); if(b)b.click(); return 1; })()`);
  await sleep(300);
  await ev(`document.querySelector('[data-tab="settings"]')?.click(); 1`);
  await sleep(600);
  // 语音设置行在「插件」面板里（voicePluginPanel），不是设置主列表
  await ev(`document.querySelector('#rowPlugins')?.click(); 1`);
  await sleep(800);
  const nav = await ev(`JSON.stringify({ tab: document.querySelector('[data-tab="settings"]')?.className || '', row: !!document.querySelector('#cloudTts'), sheets: document.querySelectorAll('.row').length })`);
  console.log("  设置页状态:", nav);
  ok(await ev(`!!document.querySelector('#cloudTts')`), "设置页有「云端语音模型」入口");
  await ev(`document.querySelector('#cloudTts')?.click(); 1`);
  await sleep(500);
  const form = await ev(`JSON.stringify({
    title: document.querySelector('#sheetBody .sheet-title')?.textContent || '',
    main: ['ctUrl','ctKey','ctModel'].filter(x=>!!document.querySelector('#'+x)),
    adv: ['ctVoice','ctBody','ctHeaders'].filter(x=>!!document.querySelector('#'+x)),
    formatInput: !!document.querySelector('#ctFormat'),
  })`);
  const f = JSON.parse(form);
  ok(f.title === "云端语音模型" && f.main.length === 3 && f.adv.length === 3 && !f.formatInput,
    "主表单三项 + 高级三项，没有让用户填返回格式", form);

  // 2) 真实 UI 链路：填表 → 保存并试听 → 假服务收到请求
  const fill = `(() => {
    const set=(id,v)=>{const e=document.querySelector('#'+id); if(e) e.value=v;};
    set('ctUrl', ${JSON.stringify(ENDPOINT)});
    set('ctKey', 'sk-probe-key');
    set('ctModel', 'probe-tts-v1');
    set('ctVoice', 'probe-voice');
    const en=document.querySelector('#ctEnabled'); if(en) en.checked=true;
    return 1;
  })()`;
  await ev(fill);
  const n0 = requests.length;
  await ev(`document.querySelector('#btnCloudTest')?.click(); 1`);
  await sleep(1800);
  ok(requests.length > n0, "试听真的向所填厂商地址发了请求", `req ${n0} → ${requests.length}`);
  const last = requests[requests.length - 1] || {};
  let body = {};
  try { body = JSON.parse(last.body || "{}"); } catch (_) {}
  ok(body.model === "probe-tts-v1" && body.voice === "probe-voice" && body.input === VOICE_SAMPLE_SENTINEL(),
    "请求体带用户填的模型名 / 音色 / 文本", JSON.stringify(body).slice(0, 160));
  ok((last.headers?.authorization || "") === "Bearer sk-probe-key", "API Key 以 Bearer 发出");

  // 3) 配置回读脱敏 + 语音条走云端
  const saved = JSON.parse(await readCfg());
  ok(saved.usable && saved.hasKey && !JSON.stringify(saved).includes("sk-probe-key"),
    "配置回读不含密钥明文", JSON.stringify(saved).slice(0, 160));
  // 语音条走异步桥：同步 synthVoice 在云端没配好时会落回系统 TTS，
  // 模拟器上逐段 synthesizeToFile 能等满分钟级，把探针拖死。
  await ev(`(() => {
    window.__cloudBubble = null;
    const h = window.DSHHost;
    if (h) {
      const orig = h.onSynth && h.onSynth.bind(h);
      h.onSynth = (id, j) => { window.__cloudBubble = j; try { orig && orig(id, j); } catch (_) {} };
    }
    DSHNativeVoice.synthVoiceAsync("probe-cloud-1", "云端语音条测试", 1);
    return 1;
  })()`);
  let bubbleRaw = null;
  for (let i = 0; i < 40 && !bubbleRaw; i++) {
    await sleep(200);
    bubbleRaw = await ev(`window.__cloudBubble`);
  }
  let bubble = {};
  try { bubble = JSON.parse(bubbleRaw || "{}"); } catch (_) {}
  ok(bubble.ok && bubble.engine === "cloud" && String(bubble.dataUrl || "").startsWith("data:audio/wav"),
    "语音条用云端音频合成出 data URL", JSON.stringify(bubble).slice(0, 130));

  // 4) 关掉云端后不再发请求（回退系统 TTS）
  await cfg({ enabled: false, endpoint: ENDPOINT, apiKey: "", model: "probe-tts-v1" });
  const n1 = requests.length;
  await ev(`DSHNativeVoice.speak("回退系统语音", 1); 1`);
  await sleep(1200);
  ok(requests.length === n1, "关闭云端后朗读不再请求厂商（走系统 TTS）", `req ${n1} → ${requests.length}`);
  const off = JSON.parse(await readCfg());
  ok(!off.usable && off.hasKey, "关闭只停用，不清掉已保存的密钥", JSON.stringify(off).slice(0, 120));

  // 5) 收尾：清掉测试配置，别把假地址留给下次
  await cfg({ enabled: false, endpoint: "", apiKey: "", model: "", clearKey: true });
  console.log(`\n${fails === 0 ? "ALL PASS" : fails + " FAILED"}  云端语音模型探针（假服务收到 ${requests.length} 次请求）`);
} catch (e) {
  console.error("FAIL  探针异常：", e);
  fails++;
} finally {
  ws.close();
  server.close();
  process.exit(fails ? 1 : 0);
}

// 试听固定文本（与 web/src 的 VOICE_SAMPLE 保持一致，断言请求体用）
function VOICE_SAMPLE_SENTINEL() {
  return "你好呀，我是你的助手。今天的天气不错，要不要一起做点什么？";
}
