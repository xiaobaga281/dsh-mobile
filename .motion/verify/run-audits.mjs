#!/usr/bin/env node
/**
 * run-audits.mjs — 依次跑 .test/audit1..5.mjs（改前回归基线）
 * =========================================================
 * 关键点：
 *  - 审计脚本把截图写到相对路径 .test/xxx.png。为了**不改动现有 .test/ 文件**，
 *    这里把子进程的 CWD 放在 .motion/verify/audit-run/，并预先建好同名 .test/ 子目录，
 *    截图就落在 .motion/verify/audit-run/.test/ 里。
 *  - 每个脚本都新起一个 node 进程（各自 CDP 连接），跑之前重建一次 adb forward，
 *    因为环境里 adb daemon 会被回收、forward 也随之丢失。
 *  - 结果写 .motion/verify/<label>/audit.json
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const TEST_DIR = path.join(ROOT, ".test");
const ADB = "D:/1/tools/android-sdk/platform-tools/adb.exe";
const PORT = 9223;
const LABEL = (() => {
  const i = process.argv.indexOf("--label");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "baseline";
})();
const OUT_DIR = path.resolve(".motion/verify", LABEL);
const RUN_DIR = path.resolve(".motion/verify/audit-run");
const PER_AUDIT_TIMEOUT = 200000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adb(args) {
  return execFileSync(ADB, args, { encoding: "utf8", timeout: 25000 });
}

async function ensureForward() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
    const l = await r.json();
    if (Array.isArray(l) && l.length) return true;
  } catch (_) {}
  for (let i = 0; i < 3; i++) {
    try {
      adb(["start-server"]);
      let serial = "emulator-5554";
      const devs = adb(["devices"]).split(/\r?\n/).filter((x) => /\tdevice$/.test(x.trim()));
      if (devs.length) serial = devs[0].split("\t")[0].trim();
      adb(["-s", serial, "wait-for-device"]);
      const sock = adb(["-s", serial, "shell", "cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | head -1"]).trim();
      if (sock) {
        try { adb(["-s", serial, "forward", "--remove", `tcp:${PORT}`]); } catch (_) {}
        adb(["-s", serial, "forward", `tcp:${PORT}`, `localabstract:${sock}`]);
      }
    } catch (_) {}
    await sleep(600);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
      const l = await r.json();
      if (Array.isArray(l) && l.length) return true;
    } catch (_) {}
  }
  return false;
}

const PKG = "ai.deepseek.harness.mobile";
const COMPONENT = "ai.deepseek.harness.mobile/.MainActivity";

/** 强制重启 App：每个审计脚本都假设自己从会话页开始，而上一个脚本可能停在对话页/浮层。 */
async function resetApp() {
  let serial = "emulator-5554";
  try {
    const devs = adb(["devices"]).split(/\r?\n/).filter((x) => /\tdevice$/.test(x.trim()));
    if (devs.length) serial = devs[0].split("\t")[0].trim();
    adb(["-s", serial, "shell", "am", "force-stop", PKG]);
    adb(["-s", serial, "shell", "am", "start", "-W", "-n", COMPONENT]);
  } catch (_) {}
  await sleep(4500);
}

function runOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [file], {
      cwd: RUN_DIR,
      windowsHide: true,
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    const killTimer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      err += `\n[killed after ${PER_AUDIT_TIMEOUT}ms]`;
    }, PER_AUDIT_TIMEOUT);
    child.on("close", (code) => {
      clearTimeout(killTimer);
      const lines = out.split(/\r?\n/).filter((l) => l.trim());
      const json = [];
      const other = [];
      for (const l of lines) {
        const t = l.trim();
        if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
          try { json.push(JSON.parse(t)); continue; } catch (_) {}
        }
        other.push(t);
      }
      // audit1 之类会先打多行 JSON、再打一行 "ERRORS: ..."；把前半段单独解析成清单
      let inventory = null;
      try {
        inventory = JSON.parse(out);
      } catch (_) {
        const cut = out.indexOf("ERRORS:");
        if (cut > 0) {
          try { inventory = JSON.parse(out.slice(0, cut)); } catch (_) {}
        }
      }
      resolve({
        script: path.basename(file),
        inventory,
        exitCode: code,
        durationMs: Date.now() - started,
        timedOut: /\[killed after/.test(err),
        errorLines: err.split(/\r?\n/).filter((l) => l.trim()).slice(0, 30),
        logCount: json.length,
        log: json,
        stdout: other.slice(0, 60),
        // 审计脚本有的打印多行 JSON（audit1），不能只留单行解析结果，原文全存
        stdoutRaw: out.length > 200000 ? out.slice(-200000) : out,
      });
    });
  });
}

async function main() {
  fs.mkdirSync(path.join(RUN_DIR, ".test"), { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const files = [];
  for (let i = 1; i <= 5; i++) {
    const f = path.join(TEST_DIR, `audit${i}.mjs`);
    if (fs.existsSync(f)) files.push(f);
  }
  console.log(`[audit] 找到 ${files.length} 个审计脚本`);

  const results = [];
  for (const f of files) {
    await resetApp();
    const ok = await ensureForward();
    if (!ok) {
      results.push({ script: path.basename(f), errorLines: ["CDP 不可达，跳过"], skipped: true });
      console.log(`[audit] ${path.basename(f)} 跳过（CDP 不可达）`);
      continue;
    }
    console.log(`[audit] 跑 ${path.basename(f)} ...`);
    const r = await runOne(f);
    results.push(r);
    const errs = (r.log || []).flatMap((x) => (x && x.errors) || []).filter((x) => x && String(x).length);
    console.log(`[audit]   exit=${r.exitCode} ${r.durationMs}ms  log=${r.logCount}  err=${errs.length}`);
    await sleep(600);
  }

  const summary = {
    label: LABEL,
    generatedAt: new Date().toISOString(),
    appVersionHint: "rc.98 (baseline APK)",
    total: results.length,
    ok: results.filter((r) => r.exitCode === 0 && !r.skipped).length,
    failed: results.filter((r) => r.exitCode !== 0 && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    results,
  };
  fs.writeFileSync(path.join(OUT_DIR, "audit.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(`\n[audit] ok=${summary.ok} failed=${summary.failed} skipped=${summary.skipped}`);
  console.log(`[audit] 写入 ${path.join(OUT_DIR, "audit.json")}`);
}

main().catch((e) => {
  console.error("[audit] 失败:", e.stack || e.message);
  process.exit(1);
});
