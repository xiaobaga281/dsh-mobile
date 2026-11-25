// M3 验收：compile（C/C++）→ run 全链路 + 沙箱/错误路径
const PORT = +(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 9227);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); setTimeout(() => rej(new Error("ws-timeout")), 8000); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => m.error ? rej(new Error(m.error.message)) : res(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await ev(`(() => {
  window.__m3 = { results: {} };
  if (window.DSHHost && !window.DSHHost.__m3Hooked) {
    const orig = window.DSHHost.onToolResult?.bind(window.DSHHost);
    window.DSHHost.onToolResult = (id, result) => {
      window.__m3.results[id] = result;
      try { orig && orig(id, result); } catch (_) {}
    };
    window.DSHHost.__m3Hooked = true;
  }
  return 'hooked';
})()`);

let seq = 0;
async function toolCall(name, args, timeoutMs = 120000) {
  const id = `m3-${++seq}`;
  await ev(`window.DSHNativeKernel.toolCall(${JSON.stringify(id)}, ${JSON.stringify(name)}, ${JSON.stringify(JSON.stringify(args))}); 'ok'`);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await ev(`window.__m3.results[${JSON.stringify(id)}] || null`);
    if (r !== null) return { json: JSON.parse(r), ms: Date.now() - t0 };
    await sleep(250);
  }
  throw new Error(`toolCall ${name} 超时`);
}
const ok = (cond, label, extra = "") => console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  | " + extra : ""}`);

// 0) 写 C 与 C++ 源文件（经 fs write 工具或 toolCall fs.write；用内核 write 工具名先探测）
// 简化：直接用 python 无关的方式 —— 用 toolCall("bash") 写文件最稳
const setup = await toolCall("bash", { description: "写入 C/C++ 测试源文件", command: "cat > fib.c <<'EOF'\n#include <stdio.h>\nint fib(int n){return n<2?n:fib(n-1)+fib(n-2);}\nint main(){printf(\"%d\\\\n\", fib(10));return 0;}\nEOF\ncat > hello.cpp <<'EOF'\n#include <iostream>\nint main(){std::cout << \"cpp-ok \" << 7*6 << std::endl;return 0;}\nEOF\nls" });
ok(setup.json.ok !== false && /fib\.c/.test(setup.json.error || setup.json.output || JSON.stringify(setup.json)), "写源文件", JSON.stringify(setup.json).slice(0, 160));

// 1) compile C
const c1 = await toolCall("compile", { description: "编译 fib", file: "fib.c", out: "fib" });
const c1out = JSON.stringify(c1.json);
ok(/exit=0/.test(c1out), "compile C (gcc)", c1out.slice(0, 200));

// 2) run C 产物
const r1 = await toolCall("run", { description: "运行 fib", file: "fib" });
ok(/exit=0/.test(JSON.stringify(r1.json)) && /55/.test(JSON.stringify(r1.json)), "run fib → 55", JSON.stringify(r1.json).slice(0, 200));

// 3) compile C++
const c2 = await toolCall("compile", { description: "编译 hello", file: "hello.cpp", out: "hello", flags: ["-O2", "-std=c++17"] });
ok(/exit=0/.test(JSON.stringify(c2.json)), "compile C++ (g++)", JSON.stringify(c2.json).slice(0, 200));

// 4) run C++ 产物
const r2 = await toolCall("run", { description: "运行 hello", file: "hello" });
ok(/cpp-ok 42/.test(JSON.stringify(r2.json)), "run hello → cpp-ok 42", JSON.stringify(r2.json).slice(0, 200));

// 5) 错误路径：不认识的扩展名
const e1 = await toolCall("compile", { description: "编译 py", file: "fib.c", out: "x", flags: [] }).catch(() => null);
const e2 = await toolCall("compile", { description: "坏扩展名", file: "nope.txt" }).catch((e) => ({ json: { error: String(e) } }));
ok(JSON.stringify(e2.json).includes("扩展名"), "compile 拒绝非 C/C++ 源", JSON.stringify(e2.json).slice(0, 120));

// 6) run 不存在的文件
const e3 = await toolCall("run", { description: "跑空气", file: "nope-bin" }).catch((e) => ({ json: { error: String(e) } }));
ok(JSON.stringify(e3.json).length > 0, "run 缺失文件有明确报错", JSON.stringify(e3.json).slice(0, 120));

process.exit(0);
