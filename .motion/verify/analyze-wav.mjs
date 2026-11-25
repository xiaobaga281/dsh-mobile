// 从探针日志里抠出 dataUrl,解码 WAV,做基本统计(峰度/过零/RMS 分段),判断是不是真语音
import { readFileSync } from "node:fs";
const raw = readFileSync(process.argv[2] || "C:\\Users\\25616\\AppData\\Local\\Temp\\zcode-bash-hMPRUt\\session_86f0ca0179701146b3eedb15c07f40f7\\call_8beaa4de1d294f069d37c087-stdout.log", "utf8");
const m = raw.match(/synth: (\{"ok".*?\})\r?\nfrontendPick/s) || raw.match(/synth: (\{"ok".*?"segments":\d+\})/s);
if (!m) { console.log("no synth json"); process.exit(1); }
const j = JSON.parse(m[1].replace(/\\"/g, '"').replace(/\\\//g, "/"));
console.log("ok:", j.ok, "durMs:", j.durMs, "bytes:", j.bytes, "ms:", j.ms);
const b64 = j.dataUrl.split(",")[1];
const buf = Buffer.from(b64, "base64");
// parse WAV
const dataIdx = buf.indexOf("data");
const fmt = buf.indexOf("fmt ");
const channels = buf.readUInt16LE(fmt + 10);
const rate = buf.readUInt32LE(fmt + 12);
const bits = buf.readUInt16LE(fmt + 22);
const pcm = buf.subarray(dataIdx + 8);
const n = pcm.length / 2;
console.log("rate:", rate, "ch:", channels, "bits:", bits, "samples:", n);
const s = new Int16Array(n);
for (let i = 0; i < n; i++) s[i] = pcm.readInt16LE(i * 2);
// overall stats
let peak = 0, sumsq = 0, zc = 0;
for (let i = 0; i < n; i++) { const a = Math.abs(s[i]); if (a > peak) peak = a; sumsq += s[i] * s[i]; if (i && (s[i] < 0) !== (s[i-1] < 0)) zc++; }
console.log("peak:", peak, "rms:", Math.round(Math.sqrt(sumsq / n)), "zcr/sec:", Math.round(zc / (n / rate)));
// per-100ms RMS to see speech envelope
const win = rate / 10;
const rows = [];
for (let off = 0; off + win <= n; off += win) {
  let sq = 0; for (let i = off; i < off + win; i++) sq += s[i] * s[i];
  rows.push(Math.round(Math.sqrt(sq / win)));
}
console.log("100ms RMS envelope:", rows.join(","));
// distinct values histogram (top 10) — 语音不会只有几个离散值
const hist = new Map();
for (let i = 0; i < n; i += 7) hist.set(s[i], (hist.get(s[i]) || 0) + 1);
const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log("top sampled values:", top.map(([v, c]) => `${v}(${(c * 7 / n * 100).toFixed(1)}%)`).join(" "));
