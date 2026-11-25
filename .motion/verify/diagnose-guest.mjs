// 真机 guest 环境诊断：一次性回答「/dev、DNS、git、npm 到底通不通」。
//
// 为什么要有它：代码上 prootArgs 有 `-b /dev`、prootHostEnv 有 PROOT_LOADER、
// 补丁里有 git/npm，但这些都只是「装配意图」。真机上 SELinux、ROM 的 devtmpfs、
// 运营商 DNS 都可能让 bind 或解析失效 —— 只有 guest 里亲自看一眼才算数。
// 用户实测报告过 /dev 空、git rc=128、getaddrinfo EAI_AGAIN，用本脚本把现场取回来。
//
// 用法（App 已装 + WebView 调试端口已转发）：
//   node .motion/verify/diagnose-guest.mjs [--port 9227]
// 把输出整段贴回即可，不需要解读。
const PORT = +(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 9227);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", rej);
  setTimeout(() => rej(new Error("ws-timeout")), 8000);
});
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await ev(`(() => {
  window.__diag = { results: {} };
  window.DSHHost.onToolResult = (id, result) => { window.__diag.results[id] = result; };
  return 'hooked';
})()`);

let seq = 0;
async function toolCall(name, args, timeoutMs = 120000) {
  const callId = `diag-${++seq}`;
  const trig = await ev(`(() => { try { window.DSHNativeKernel.toolCall(${JSON.stringify(callId)}, ${JSON.stringify(name)}, ${JSON.stringify(JSON.stringify(args))}); return "ok"; } catch (e) { return "EXC:" + e; } })()`);
  if (trig !== "ok") throw new Error(`toolCall ${name} 触发失败: ${trig}`);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await ev(`window.__diag.results[${JSON.stringify(callId)}] || null`);
    if (r != null) return JSON.parse(r);
    await sleep(250);
  }
  throw new Error(`toolCall ${name} 超时`);
}

const DIAG_CODE = String.raw`
const fs = require('fs');
const cp = require('child_process');
const dns = require('dns');
const say = (k, v) => console.log('DIAG ' + k + ' = ' + String(v).replace(/\n/g, ' | '));

say('node.version', process.version);
say('cwd', process.cwd());

// 1) /dev：proot -b /dev 到底有没有生效
try {
  const names = fs.readdirSync('/dev').sort();
  say('dev.count', names.length);
  say('dev.sample', names.slice(0, 24).join(','));
  for (const n of ['null', 'zero', 'random', 'urandom', 'tty']) {
    let st = 'MISSING';
    try { st = fs.statSync('/dev/' + n).isCharacterDevice() ? 'chr-ok' : 'present-not-chr'; } catch (e) { st = 'MISSING:' + e.code; }
    say('dev.' + n, st);
  }
  try { fs.writeFileSync('/dev/null', 'x'); say('dev.null.writable', 'ok'); } catch (e) { say('dev.null.writable', 'FAIL:' + e.message); }
} catch (e) { say('dev', 'FAIL:' + e.message); }

// 2) DNS：resolv.conf + 真实解析
try { say('resolv.conf', fs.existsSync('/etc/resolv.conf') ? fs.readFileSync('/etc/resolv.conf', 'utf8').trim() : 'MISSING'); }
catch (e) { say('resolv.conf', 'FAIL:' + e.message); }
try { say('dns.lookup', dns.getServers ? dns.getServers().join(',') : 'n/a'); } catch (e) { say('dns.lookup', e.message); }
dns.lookup('registry.npmjs.org', (err, addr) => {
  say('dns.registry.npmjs.org', err ? 'FAIL:' + err.code + ':' + err.message : 'ok:' + addr);
});

// 3) git：版本 + 在临时目录 init（rc=128 的现场）
try { say('git.version', cp.execSync('git --version 2>&1', { encoding: 'utf8' }).trim()); }
catch (e) { say('git.version', 'FAIL rc=' + e.status + ' ' + String(e.stdout || e.message).trim()); }
try {
  const d = '/tmp/dsh-git-probe-' + process.pid;
  fs.mkdirSync(d, { recursive: true });
  const out = cp.execSync('cd ' + d + ' && git init 2>&1 && git config user.email a@b.c && git config user.name probe && echo hi > a.txt && git add a.txt && git commit -m init 2>&1', { encoding: 'utf8' });
  say('git.init+commit', 'ok: ' + out.trim().replace(/\n/g, ' | '));
} catch (e) { say('git.init+commit', 'FAIL rc=' + e.status + ' ' + String(e.stdout || e.message).trim()); }

// 4) npm：增量补丁是否解出来了
for (const p of ['/usr/bin/npm', '/usr/bin/npx', '/usr/lib/node_modules/npm/bin/npm-cli.js']) {
  try { say('npm.path.' + p, fs.realpathSync(p)); } catch (e) { say('npm.path.' + p, 'MISSING:' + e.code); }
}
try { say('npm.version', cp.execSync('/usr/bin/npm --version 2>&1', { encoding: 'utf8' }).trim()); }
catch (e) { say('npm.version', 'FAIL rc=' + e.status + ' ' + String(e.stdout || e.message).trim()); }
try { say('npx.version', cp.execSync('/usr/bin/npx --version 2>&1', { encoding: 'utf8' }).trim()); }
catch (e) { say('npx.version', 'FAIL rc=' + e.status + ' ' + String(e.stdout || e.message).trim()); }

// 5) 出网：npm registry 是否可达（DNS 之外的第二道门槛）
try {
  const https = require('https');
  const req = https.get('https://registry.npmjs.org/-/ping', (r) => { say('https.registry', 'status=' + r.statusCode); r.resume(); });
  req.setTimeout(6000, () => { say('https.registry', 'TIMEOUT'); req.destroy(); });
  req.on('error', (e) => say('https.registry', 'FAIL:' + e.code + ':' + e.message));
} catch (e) { say('https.registry', 'FAIL:' + e.message); }
`;

console.log("=== 真机 guest 环境诊断 ===");
const out = await toolCall("node", { description: "guest 环境诊断", code: DIAG_CODE });
console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
console.log("=== 诊断结束：把上面整段贴回来即可 ===");
ws.close();
