// 灵动岛 morph **逐帧**实测：录屏 → ffmpeg 抽 rgb24 → 扫描深色岛的水平边界。
// 验证两件用户能直接看到的事：
//   1. 展开/收起全程形状中心恒定（旧实现两条边行程不等，中心漂 20~30px → 来回晃动）；
//   2. 宽度单调变化，没有回弹 / 跳帧。
// 用法：先跑 probe-island.mjs 让岛处于收起态，再跑本脚本。
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ADB = process.env.ADB || "D:/1/tools/android-sdk/platform-tools/adb.exe";
const adb = (args, opts = {}) =>
  execFileSync(ADB, args, { encoding: "utf8", timeout: 30000, maxBuffer: 1 << 24, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, l, d = "") => console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "  | " + d : ""}`);

const frameOf = () => {
  const s = adb(["shell", "dumpsys", "window", "windows"]);
  // 视觉窗口尺寸恒定，形态尺寸改看全透明热区窗口（不画任何像素）
  const m = s.match(/Window\{[^}]+ DSHControlIslandTouch\}[\s\S]*?frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  return m ? { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4], w: +m[3] - +m[1] } : null;
};

let idle = frameOf();
// 上一轮可能停在展开态：用卡片右侧收起。别点 x≈492..610，那是系统挖孔保护区，
// ScreenDecorOverlay 会吞掉点击（看起来像「点了没反应」）。
for (let k = 0; k < 3 && idle && idle.w > 500; k++) {
  // 落在卡片右侧「收起」按钮一带，避开挖孔保护区与圆角边缘
  adb(["shell", "input", "tap", String(idle.x2 - 60), String(idle.y1 + 40)]);
  await sleep(700);
  idle = frameOf();
}
console.log("      当前 frame=" + JSON.stringify(idle));
if (!idle || idle.w > 500) {
  console.log("FAIL  岛未处于稳定收起态，请先跑 probe-island.mjs");
  process.exit(1);
}
const tapX = idle.x2 - 12;
const tapY = Math.round((idle.y1 + idle.y2) / 2);
console.log(`      收起态 frame w=${idle.w}  点按 (${tapX},${tapY})`);

const remote = "/sdcard/island-morph.mp4";
adb(["shell", "rm", "-f", remote]);
const rec = spawn(ADB, ["shell", "screenrecord", "--time-limit", "3", "--bit-rate", "6000000", remote],
  { stdio: "ignore" });
await sleep(700);
adb(["shell", "input", "tap", String(tapX), String(tapY)]); // 展开
await sleep(800);
adb(["shell", "input", "tap", String(tapX), String(tapY)]); // 收起
await new Promise((res) => rec.on("exit", res));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "island-motion-"));
const mp4 = path.join(tmp, "morph.mp4");
const raw = path.join(tmp, "frames.raw");
adb(["pull", remote, mp4]);

// 只裁屏幕顶部 130px，扫 y=64（胶囊垂直中线）。展开态这一行落在标题上方空白，
// 收起态虽有彩点/文字，但用「最左→最右深色像素」仍能拿准岛的两个外边界。
const W = 1080, H = 130, ROW = 64, STRIDE = W * 3, FRAME = STRIDE * H;
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4,
  "-vf", `crop=${W}:${H}:0:0,fps=30`, "-pix_fmt", "rgb24", "-f", "rawvideo", raw],
  { stdio: "pipe", maxBuffer: 1 << 26 });
const buf = fs.readFileSync(raw);
const frames = [];
for (let off = 0; off + FRAME <= buf.length; off += FRAME) {
  let l = -1, r = -1;
  for (let x = 0; x < W; x++) {
    const i = off + ROW * STRIDE + x * 3;
    if (buf[i] < 80 && buf[i + 1] < 85 && buf[i + 2] < 95) {
      if (l < 0) l = x;
      r = x;
    }
  }
  frames.push({ w: l < 0 ? 0 : r - l + 1, c: l < 0 ? null : (l + r) / 2 });
}
const valid = frames.filter((f) => f.w > 100);
if (valid.length < 6) {
  console.log(`FAIL  录屏没抓到岛（有效帧 ${valid.length}），检查 screenrecord / 阈值`);
  process.exit(1);
}

console.log("      逐帧 宽度/中心: " + frames.map((f) =>
  f.c === null ? "-" : `${Math.round(f.w)}@${Math.round(f.c)}`).join(" "));

// 剔除录屏编码伪影造成的离群帧（中心偏离中位数 > 40px 的必然不是岛）
const sorted = valid.map((f) => f.c).sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
const clean = valid.filter((f) => Math.abs(f.c - median) <= 40);
const outliers = valid.length - clean.length;
const avg = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
// 稳态帧（纯胶囊 / 纯卡片）中心必须一致；过渡帧受 H.264 运动补偿影响，
// 边缘量测会有 ±30px 噪声，那是录屏伪影不是渲染位移。
const steady = clean.filter((f) => f.w < idle.w * 1.08 || f.w > idle.w * 2.4).map((f) => f.c);
// 窗口切换那一帧 screenrecord 会把前后两帧编码混在一起（孤立尖峰），
// 用 90 分位偏差而不是 max-min：绝大多数稳态帧必须精确落在同一轴上。
const devs = steady.map((c) => Math.abs(c - median)).sort((a, b) => a - b);
const p90 = devs[Math.floor(devs.length * 0.9)];
ok(steady.length >= 4 && p90 <= 3, "稳态胶囊/卡片中心一致，切换无跳跃",
  `p90=${p90.toFixed(1)}px n=${steady.length}`);

// 关键：中心 vs 宽度做线性回归。旧实现 left/right 行程不等，中心随宽度
// 单向偏 20~30px，斜率会明显非零；现在以孔心为轴，斜率应≈0。
const mw = avg(clean.map((f) => f.w)), mc = avg(clean.map((f) => f.c));
let num = 0, den = 0;
for (const f of clean) { num += (f.w - mw) * (f.c - mc); den += (f.w - mw) ** 2; }
const slope = num / Math.max(1, den);
const span = Math.max(...clean.map((f) => f.w)) - Math.min(...clean.map((f) => f.w));
const predicted = Math.abs(slope * span);
ok(predicted <= 10, "中心与展开宽度无关（无系统性左右漂移）",
  `全程预测偏移=${predicted.toFixed(1)}px slope=${slope.toFixed(4)} outliers=${outliers}`);

const narrow = clean.filter((f) => f.w < idle.w * 1.3).map((f) => f.c);
const wide = clean.filter((f) => f.w > idle.w * 2).map((f) => f.c);
const bias = avg(wide) - avg(narrow);
ok(narrow.length >= 2 && wide.length >= 2 && Math.abs(bias) <= 6,
  "窄帧 / 宽帧中心均值一致",
  `窄=${avg(narrow).toFixed(1)} 宽=${avg(wide).toFixed(1)} bias=${bias.toFixed(1)}px`);

const ws = frames.map((f) => f.w);
const iMax = ws.indexOf(Math.max(...ws));
let back1 = 0;
for (let i = 1; i <= iMax; i++) if (ws[i] < ws[i - 1] - 4) back1++;
ok(back1 === 0, "展开段宽度单调，无回弹", `frames=0..${iMax} backs=${back1}`);
const minAfter = Math.min(...ws.slice(iMax));
let iEnd = ws.length - 1;
for (let i = iMax; i < ws.length; i++) if (ws[i] <= minAfter + 4) { iEnd = i; break; }
let back2 = 0;
for (let i = iMax + 1; i <= iEnd; i++) if (ws[i] > ws[i - 1] + 4) back2++;
ok(back2 === 0, "收起段宽度单调，无回弹", `frames=${iMax}..${iEnd} backs=${back2}`);
ok(Math.max(...ws) > idle.w * 2, "录屏确实抓到了展开态", `maxW=${Math.max(...ws)} idleW=${idle.w}`);

// 「整块左右跳一下」与「缓慢漂移」是两回事：旧版同步改 translationX、
// 窗口却要下一帧才 relayout，中间那一帧整块岛平移 pillX-cardX ≈ 309px。
// 30fps 录屏可能漏掉这 1 帧，但只要抓到相邻帧中心突跳几百 px 就必须判失败。
let jumps = 0;
for (let i = 1; i < frames.length; i++) {
  const a = frames[i - 1], b = frames[i];
  if (a.c !== null && b.c !== null && a.w > 100 && b.w > 100 && Math.abs(b.c - a.c) > 80) jumps++;
}
ok(jumps === 0, "相邻帧无整块左右瞬移（窗口切换帧不同步）", `jumps=${jumps}`);

// 导出关键帧胶片，肉眼复核「同一个岛自己长成卡片、没有另挂一张卡、没有左右摆动」
const maxW = Math.max(...ws);
const midW = (idle.w + maxW) / 2;
const findFrame = (pred) => frames.findIndex(pred);
const idxs = [...new Set([
  8,
  findFrame((f, i) => i > 15 && i < iMax && f.w > midW - 120 && f.w < maxW),
  iMax,
  findFrame((f, i) => i > iMax && f.w > idle.w * 1.1 && f.w < midW + 120),
  frames.length - 2,
].filter((i) => i >= 0))];
const filmstrip = ".motion/verify/island-morph-filmstrip.png";
const selectExpr = idxs.map((n) => `eq(n\\,${n})`).join("+");
try {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4,
    "-vf", `fps=30,select='${selectExpr}',crop=1080:280:0:0,scale=432:112,tile=${idxs.length}x1`,
    "-frames:v", "1", filmstrip], { stdio: "pipe", maxBuffer: 1 << 24 });
  console.log(`SHOT  ${filmstrip}  帧号=[${idxs.join(",")}]`);
} catch (e) {
  console.log(`WARN  胶片生成失败：${e.message.slice(0, 100)}`);
}

// 离群帧也导出来：必须肉眼确认是 H.264 编码伪影，还是真的整块岛瞬移。
// 之前把 >40px 的中心偏离一律当噪声剔除，正好把用户看到的「左右跳一下」掩盖了。
const bad = [];
frames.forEach((f, i) => {
  if (f.c !== null && f.w > 100 && Math.abs(f.c - median) > 40) bad.push(i);
});
if (bad.length) {
  const sel = bad.map((n) => `eq(n\\,${n})`).join("+");
  try {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4,
      "-vf", `fps=30,select='${sel}',crop=1080:130:0:0,scale=540:65,tile=${bad.length}x1`,
      "-frames:v", "1", ".motion/verify/island-morph-outliers.png"],
      { stdio: "pipe", maxBuffer: 1 << 24 });
    console.log(`SHOT  island-morph-outliers.png  离群帧=[${bad.join(",")}]`);
  } catch (e) {
    console.log(`WARN  离群帧导出失败：${e.message.slice(0, 100)}`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
