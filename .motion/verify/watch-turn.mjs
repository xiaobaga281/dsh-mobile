// 旁听一轮对话直到真正结束：以会话日志的 turn/end（或 turn/error）为准。
// 不用"界面文字静止"判断——app_build 要跑三四分钟，这期间文字本来就不动。
//
// 用法：node .motion/verify/watch-turn.mjs [超时秒数]
import { execFileSync } from "node:child_process";

const LIMIT = Number(process.argv[2] || 900);
const sh = (cmd) => {
  try {
    return execFileSync("adb", ["shell", cmd], { encoding: "utf8", maxBuffer: 8 << 20, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return `${e.stdout || ""}${e.stderr || ""}`;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const file = sh("ls -t /data/data/ai.deepseek.harness.mobile/files/kernel/sessions/*.jsonl | head -1").trim();
console.log("会话日志:", file.split("/").pop());
const done = new Set();
const t0 = Date.now();
let lastSize = 0;

while ((Date.now() - t0) / 1000 < LIMIT) {
  await sleep(2500);

  // 系统安装弹窗出现就点「安装」（Agent 走到 app_install 时会弹）
  const focus = sh("dumpsys window | grep mCurrentFocus | head -1");
  if (/packageinstaller/i.test(focus)) {
    sh("uiautomator dump /sdcard/w.xml >/dev/null 2>&1");
    const xml = sh("cat /sdcard/w.xml");
    const m = [...xml.matchAll(/text="(安装|Install|INSTALL|更新|Update)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)][0];
    if (m) {
      sh(`input tap ${Math.round((+m[2] + +m[4]) / 2)} ${Math.round((+m[3] + +m[5]) / 2)}`);
      console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] 已点系统安装按钮`);
    }
  }

  const size = Number(sh(`stat -c %s ${file}`).trim() || 0);
  if (size <= lastSize) continue;
  lastSize = size;
  const tail = sh(`grep -o '"name":"[a-z_]*"' ${file} | tail -40`).trim();
  for (const name of tail.split("\n").map((x) => x.replace(/.*"name":"|"/g, "")).filter(Boolean)) {
    if (!done.has(name)) { done.add(name); console.log(`  [${
      ((Date.now() - t0) / 1000).toFixed(0)
    }s] 调用 ${name}`); }
  }
  const ends = sh(`grep -c '"type":"turn\\/\\(end\\|error\\)"' ${file}`).trim();
  if (ends && ends !== "0") {
    const lastLine = sh(`tail -c 600 ${file}`);
    console.log(`\n轮次结束（${((Date.now() - t0) / 1000).toFixed(0)}s）`);
    console.log("尾部事件:", lastLine.trim().slice(-260));
    process.exit(0);
  }
  if ((Date.now() - t0) / 1000 % 30 < 3) console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] 仍在进行…`);
}
console.log("超时未结束");
process.exit(1);
