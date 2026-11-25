// 基础环境 + 按需自给 验收：
//   python/node/gcc/g++/java 可用（JVM 内置）；rustc 未装 → NEED_RUNTIME 且带 pkg 指引；
//   npm/npx 由 libdshnpm.so 增量补丁内置（不联网也要能跑）；
//   pkg 工具能进 guest 调 apk（离线命令证明路由正确）。
const PORT = +(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 9227);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); setTimeout(() => rej(new Error("ws-timeout")), 8000); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await ev(`(() => {
  window.__b = { results: {} };
  window.DSHHost.onToolResult = (id, result) => { window.__b.results[id] = result; };
  return 'hooked';
})()`);
let seq = 0;
async function toolCall(name, args, timeoutMs = 240000) {
  const callId = `b-${++seq}`;
  const trig = await ev(`(() => { try { window.DSHNativeKernel.toolCall(${JSON.stringify(callId)}, ${JSON.stringify(name)}, ${JSON.stringify(JSON.stringify(args))}); return "ok"; } catch (e) { return "EXC:" + e; } })()`);
  if (trig !== "ok") throw new Error(`toolCall ${name} 触发失败: ${trig}`);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await ev(`window.__b.results[${JSON.stringify(callId)}] || null`);
    if (r != null) return { json: JSON.parse(r), ms: Date.now() - t0 };
    await sleep(250);
  }
  throw new Error(`toolCall ${name} 超时`);
}
const ok = (cond, label, extra = "") => console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  | " + extra : ""}`);

// 1) 基础运行时
const p1 = await toolCall("python", { description: "python 探针", code: "print(6*7)" });
ok(/42/.test(JSON.stringify(p1.json)), "python → 42", JSON.stringify(p1.json).slice(0, 100));
const n1 = await toolCall("node", { description: "node 探针", code: "console.log(6*7)" });
ok(/42/.test(JSON.stringify(n1.json)), "node → 42", JSON.stringify(n1.json).slice(0, 100));
// node 22 由 libdshnode.so 增量补丁原子替换 /usr/bin/node 而来；
// 只测 6*7 的话 node 20 与 22 都会通过，补丁没生效也看不出来。
const nver = await toolCall("node", { description: "node 版本探针", code: "console.log(process.version)" });
ok(/v22\./.test(JSON.stringify(nver.json)), "node → v22.x（libdshnode.so 补丁生效）", JSON.stringify(nver.json).slice(0, 140));

// 1b) npm 增量补丁：libdshnpm.so 解出来的 npm 必须能直接启动，且不依赖联网装包。
//     pkg manager=npm 会走 guestExec("/usr/bin/npm") → guardGuestEntry 的符号链接
//     判定 → 真正执行 npm-cli.js，一条断言同时覆盖「入口存在 / 链接不悬空 / shebang 可用」。
const npmV = await toolCall("pkg", { description: "npm 版本探针", manager: "npm", args: ["--version"] });
ok(/10\.9\.1/.test(JSON.stringify(npmV.json)), "npm --version → 10.9.1（内置补丁，未联网）", JSON.stringify(npmV.json).slice(0, 160));
const npmCfg = await toolCall("pkg", { description: "npm cli 完整性探针", manager: "npm", args: ["config", "get", "registry"] });
ok(/registry\.npmjs\.org/.test(JSON.stringify(npmCfg.json)), "npm cli 完整加载（config get registry）", JSON.stringify(npmCfg.json).slice(0, 160));

// 2) C/C++
await toolCall("bash", { description: "写源文件", command: "printf '#include <stdio.h>\\nint main(){printf(\"%%d\\\\n\", 7*6);return 0;}' > b.c && printf '#include <iostream>\\nint main(){std::cout << 6*7 << std::endl;}' > b.cpp && echo ok" });
const c1 = await toolCall("compile", { description: "编译 C", file: "b.c", out: "b" });
ok(/exit=0/.test(JSON.stringify(c1.json)), "compile C", JSON.stringify(c1.json).slice(0, 90));
const r1 = await toolCall("run", { description: "运行 C 产物", file: "b" });
ok(/42/.test(JSON.stringify(r1.json)), "run → 42", JSON.stringify(r1.json).slice(0, 90));
const c2 = await toolCall("compile", { description: "编译 C++", file: "b.cpp", out: "bcpp" });
ok(/exit=0/.test(JSON.stringify(c2.json)), "compile C++（g++）", JSON.stringify(c2.json).slice(0, 90));

// 3) JVM（内置）：现场手写 class 打包 jar，跑真字节码
const PY = `
import struct, zipfile, os
def utf8(s):
    b = s.encode()
    return b'\\x01' + struct.pack('>H', len(b)) + b
def cls(i):
    return b'\\x07' + struct.pack('>H', i)
cp = [utf8('T'), cls(1), utf8('java/lang/Object'), cls(3),
      utf8('main'), utf8('([Ljava/lang/String;)V'), utf8('Code')]
b = b'\\xca\\xfe\\xba\\xbe' + struct.pack('>HH', 0, 52) + struct.pack('>H', len(cp)+1) + b''.join(cp)
b += struct.pack('>HHH', 0x0021, 2, 4) + struct.pack('>H', 0) + struct.pack('>H', 0)
b += struct.pack('>H', 1) + struct.pack('>HHH', 0x0009, 5, 6)
code = b'\\xb1'
attr = struct.pack('>H', 7) + struct.pack('>I', 2+2+4+len(code)+2+2) + struct.pack('>HH', 0, 1) + struct.pack('>I', len(code)) + code + struct.pack('>HH', 0, 0)
b += struct.pack('>H', 1) + attr + struct.pack('>H', 0)
open('T.class', 'wb').write(b)
with zipfile.ZipFile('probe.jar', 'w') as z:
    z.writestr('META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\\r\\nMain-Class: T\\r\\n\\r\\n')
    z.writestr('T.class', b)
print('jar', os.path.getsize('probe.jar'))
`;
await toolCall("python", { description: "手写 class 打包 jar", code: PY });
let javaOk = 0;
for (let i = 0; i < 3; i++) {
  const j = await toolCall("java", { description: "运行 probe.jar", file: "probe.jar", flags: ["-Xshare:off"], timeoutMs: 120000 });
  if (/exit=0/.test(JSON.stringify(j.json))) javaOk++;
  else console.log("  java 失败样本:", JSON.stringify(j.json).slice(0, 110));
}
ok(javaOk >= 2, `java 运行 jar（3 次中 ${javaOk} 次成功）`, "");

// 4) rustc 未装：干净 NEED_RUNTIME + pkg 指引
await toolCall("bash", { description: "写 rust 源", command: "printf 'fn main(){}' > b.rs && echo ok" });
const ru = await toolCall("rustc", { description: "rustc 未装探针", file: "b.rs", out: "br" });
const ruOut = String(ru.json.error || ru.json.output || "");
ok(!ru.json.ok && /NEED_RUNTIME:rustc/.test(ruOut) && /pkg/.test(ruOut) && !/proot error/.test(ruOut),
  "rustc → NEED_RUNTIME + pkg 指引", ruOut.slice(0, 130));

// 5) pkg 工具：进 guest 调 apk
const k1 = await toolCall("pkg", { description: "apk 版本", manager: "apk", args: ["--version"] });
ok(/apk-tools/.test(JSON.stringify(k1.json)), "pkg apk --version", JSON.stringify(k1.json).slice(0, 100));
const k2 = await toolCall("pkg", { description: "查已装 musl", manager: "apk", args: ["info", "-e", "musl"] });
ok(/exit=0/.test(JSON.stringify(k2.json)), "pkg apk info（本地 db）", JSON.stringify(k2.json).slice(0, 100));

process.exit(0);
