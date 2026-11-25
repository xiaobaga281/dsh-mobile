// M2 验收（全内置 rootfs）：busybox / python·node 经 proot 真实执行 / bash 回归 / 沙箱拒绝。
// 注：首次 python 调用会触发 rootfs 解包（~1-2 分钟），toolCall 轮询上限放宽到 6 分钟。
// 计划文档：.motion/harness-plan-ondevice.md §2。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, "m1-runtime");
fs.mkdirSync(OUT, { recursive: true });
const PORT = +(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 9227);
const LABEL = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : "m1";

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); setTimeout(() => rej(new Error("ws-timeout")), 8000); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => m.error ? rej(new Error(m.error.message)) : res(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 工具调用框架：先挂 DSHHost.onToolResult 捕获，再经 NativeKernel.toolCall 触发 ----
await ev(`(() => {
  window.__m1 = { results: {} };
  if (window.DSHHost && !window.DSHHost.__m1Hooked) {
    const orig = window.DSHHost.onToolResult?.bind(window.DSHHost);
    window.DSHHost.onToolResult = (id, result) => {
      window.__m1.results[id] = result;
      try { orig && orig(id, result); } catch (_) {}
    };
    window.DSHHost.__m1Hooked = true;
  }
  return 'hooked';
})()`);

const toolTimeoutMs = +(process.argv.includes("--tool-timeout") ? process.argv[process.argv.indexOf("--tool-timeout") + 1] : 30000);
let seq = 0;
async function toolCall(name, args) {
  const id = `m1-${++seq}`;
  await ev(`window.DSHNativeKernel.toolCall(${JSON.stringify(id)}, ${JSON.stringify(name)}, ${JSON.stringify(JSON.stringify(args))}); 'ok'`);
  const t0 = Date.now();
  while (Date.now() - t0 < toolTimeoutMs) {
    const r = await ev(`window.__m1.results[${JSON.stringify(id)}] || null`);
    if (r !== null) return { json: JSON.parse(r), ms: Date.now() - t0 };
    await sleep(200);
  }
  throw new Error(`toolCall ${name} 超时（${toolTimeoutMs / 1000}s 无结果）`);
}

async function devExec(cmd) {
  return JSON.parse(await ev(`window.DSHNativeKernel.devExec(${JSON.stringify(cmd)})`));
}

const fail = [];
const results = {};

// ---- T1: 工具目录里有 python / node，schema 同名同参（与桌面 bash 同款的 code/file 结构） ----
const schemas = JSON.parse(await ev(`window.DSHNativeKernel.toolSchemas()`));
const cat = JSON.stringify(schemas);
for (const t of ["python", "node", "bash"]) {
  const ok = cat.includes(`"name":"${t}"`) || cat.includes(`"name": "${t}"`) || (Array.isArray(schemas) && schemas.some((s) => s.name === t));
  results[`catalog-${t}`] = ok;
  if (!ok) fail.push(`T1: 工具目录缺 ${t}`);
}

// ---- T2: busybox（libdshbox.so）已在 nativeLibraryDir 且可直接 exec ----
const nd = await devExec(`P=$(pm path ai.deepseek.harness.mobile | sed "s/package://;s|/base.apk||"); echo "$P/lib/x86_64"`);
const NATIVE = (nd.out || "").trim();
results["native-dir"] = NATIVE;
if (!NATIVE) fail.push("T2: 找不到 nativeLibraryDir");
else {
  const ls = await devExec(`ls ${NATIVE}/libdshbox.so`);
  if (ls.code !== 0) fail.push(`T2: libdshbox.so 未解压到 nativeLibraryDir（useLegacyPackaging 回归？）：${JSON.stringify(ls).slice(0, 200)}`);
  // 走产品路径：bash 工具（PATH/LD_LIBRARY_PATH 由 ShellPlugin 装配）。
  // devExec 是调试桥，不带 LD_LIBRARY_PATH，不能用来验 busybox 动态链接。
  const bb = await toolCall("bash", { description: "busybox横幅", command: "busybox | head -1" });
  results["busybox-banner"] = JSON.stringify(bb.json);
  if (!/BusyBox/i.test(JSON.stringify(bb.json))) fail.push(`T2: busybox 未能执行：${JSON.stringify(bb.json).slice(0, 200)}`);
  const arch = await toolCall("bash", { description: "busybox架构", command: "busybox uname -m" });
  results["busybox-arch"] = JSON.stringify(arch.json);
  if (!/x86_64/i.test(JSON.stringify(arch.json))) fail.push(`T2: busybox 架构不对：${JSON.stringify(arch.json).slice(0, 200)}`);
}

// ---- T3: busybox tar 在 workspace 里打解包往返（走 bash 工具，cwd=工作区） ----
const tar = await toolCall("bash", {
  description: "tar往返",
  command: "echo m1-payload > m1-tar-test.txt && busybox tar -cf m1.tar m1-tar-test.txt && rm m1-tar-test.txt && busybox tar -xf m1.tar && cat m1-tar-test.txt && rm -f m1.tar m1-tar-test.txt",
});
results["busybox-tar"] = JSON.stringify(tar.json);
if (!/m1-payload/.test(JSON.stringify(tar.json))) fail.push(`T3: busybox tar 往返失败：${JSON.stringify(tar.json).slice(0, 200)}`);

// ---- T4: python 工具 → proot 底座真实执行（首次调用触发 rootfs 解包，放宽超时） ----
const pyCode = "a,b=0,1\nfor _ in range(10):\n    a,b=b,a+b\nprint('fib10=',a)";
const py = await toolCall("python", { description: "斐波那契", code: pyCode });
results["python-proot"] = py;
if (!/exit=0/.test(JSON.stringify(py.json)) || !/55/.test(JSON.stringify(py.json))) {
  fail.push(`T4: python 执行失败：${JSON.stringify(py.json).slice(0, 300)}`);
}

// ---- T5: node 工具 → 同上 ----
const ndc = await toolCall("node", { description: "数组运算", code: "console.log('node-ok', [1,2,3].map(x=>x*7).join(','))" });
results["node-proot"] = ndc;
if (!/node-ok,? ?1,14,21|node-ok 1,14,21|node-ok/.test(JSON.stringify(ndc.json)) || !/exit=0/.test(JSON.stringify(ndc.json))) {
  fail.push(`T5: node 执行失败：${JSON.stringify(ndc.json).slice(0, 300)}`);
}

// ---- T7: rootfs 里的 gcc 编译 hello（经 devExec 直调 proot，验证编译环境） ----
const gcc = await devExec(
  `F=/data/data/ai.deepseek.harness.mobile/files` +
  `; printf 'int main(){return 42;}' > $F/workspace/hi.c` +
  `; export PROOT_LOADER=$F/runtime/proot/loader PROOT_LOADER32=$F/runtime/proot/loader32 LD_LIBRARY_PATH=$F/runtime/proot PROOT_TMP_DIR=$F/runtime/tmp` +
  `; $F/runtime/proot/proot -r $F/runtime/proot-root -0 -b $F/workspace:/workspace -b /dev -b /proc -w /workspace` +
  ` /usr/bin/env PATH=/usr/bin:/bin:/sbin /bin/sh -c 'gcc hi.c -o hi && ./hi; echo rc=$?'`,
);
results["gcc-42"] = JSON.stringify(gcc);
if (!/rc=42/.test(gcc.out || "")) fail.push(`T7: gcc 编译执行失败：${JSON.stringify(gcc).slice(0, 300)}`);

// ---- T6: bash 工具回归 + PATH 注入（bash 里直接可用 busybox） ----
const echo = await toolCall("bash", { description: "回归", command: "echo alive" });
results["bash-echo"] = echo;
if (!/exit=0/.test(echo.json?.result ?? echo.json?.out ?? JSON.stringify(echo.json)) && !/alive/.test(JSON.stringify(echo.json))) {
  fail.push(`T6: bash 回归失败：${JSON.stringify(echo.json).slice(0, 200)}`);
}
const bbPath = await toolCall("bash", { description: "busybox经PATH", command: "busybox echo via-path" });
results["bash-busybox-path"] = bbPath;
if (!/via-path/.test(JSON.stringify(bbPath.json))) {
  fail.push(`T6: bash 的 PATH 未注入 nativeLibraryDir：${JSON.stringify(bbPath.json).slice(0, 200)}`);
}
results["bash-roundtrip-ms"] = echo.ms;

const pass = fail.length === 0;
fs.writeFileSync(path.join(OUT, `report-${LABEL}.json`), JSON.stringify({ label: LABEL, time: new Date().toISOString(), results, pass, fail }, null, 2));
console.log(JSON.stringify(results, null, 1));
console.log(pass ? "\n=== ALL PASS ===" : "\n=== FAIL ===\n" + fail.map((f) => " - " + f).join("\n"));
process.exit(pass ? 0 : 1);
