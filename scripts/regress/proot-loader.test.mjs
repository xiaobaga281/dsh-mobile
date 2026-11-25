// 回归：PROOT_LOADER 必须是 nativeLibraryDir 里的**真实 .so 文件**，不能是 filesDir 里的符号链接。
//
// 用户真机实测（2026-11-09，明确纠正过一次「误报」判断）：
//   DSH 把 proot 与 loader 都打进 APK 了，prootHostEnv() 也确实设了 PROOT_LOADER，
//   但值指向 filesDir/runtime/proot/loader —— 一个指向 nativeLibraryDir 的**符号链接**。
//   proot 要把 loader open/mmap 进 guest 进程，真机上经过这个链接会失败，报
//   "the loader was not found or doesn't work"，于是 guest 里的 node/python 全部
//   exec 失败。手动 `export PROOT_LOADER=/data/app/.../lib/<abi>/libdshloader.so`
//   （真实文件）后一切正常。
//   libdshproot.so 里硬编码的 Termux 默认路径只是「没覆盖时的兜底」，报错文案相同，
//   极易误判成「压根没设环境变量」—— 设了，只是**值不可用**。
//
// 所以守卫不只要看「有没有 PROOT_LOADER」，还要看它从哪来。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rt = readFileSync(
  join(root, "app/src/main/java/ai/deepseek/harness/mobile/kernel/KernelRuntime.kt"),
  "utf8",
);

function check(name, cond, hint) {
  if (!cond) throw new Error(`FAIL: ${name} —— ${hint}`);
}

// 1) ProotEnv 必须持有 nativeLibraryDir，并让 loader 优先取真实 .so
{
  const start = rt.indexOf("data class ProotEnv(");
  const body = rt.slice(start, rt.indexOf("fun ensureRootfs(", start));
  check("ProotEnv 同时持有链接目录与 nativeLibraryDir",
    start > 0 && /data class ProotEnv\(val dir: File, val native: File\)/.test(body),
    "拿不到 nativeLibraryDir 就无法给出用户实测可用的真实 .so 路径");
  check("loader 走 realOrLink（真实 .so 优先）",
    /val loader: File get\(\) = realOrLink\("libdshloader\.so", "loader"\)/.test(body)
      && /val loader32: File get\(\) = realOrLink\("libdshloader32\.so", "loader32"\)/.test(body),
    "又退化成 File(dir, \"loader\") 符号链接 —— 真机上 proot 会报 loader was not found");
  check("realOrLink 只在真实文件可读时才用它",
    /real\.isFile && real\.canRead\(\)/.test(body) && /File\(native, so\)/.test(body),
    "真实 .so 不存在时必须有回退，否则连报错机会都没有");
  check("proot 本体仍走符号链接（精确名/argv[0] 需要）",
    /val proot: File get\(\) = File\(dir, "proot"\)/.test(body),
    "proot 本体是宿主直接 exec，符号链接可用，别一起改坏");
}

// 2) 装配完要自检，且失败有出口（这是上次静默失效的根因）
{
  const start = rt.indexOf("fun ensureProotEnv(");
  const body = rt.slice(start, rt.indexOf("data class ProotEnv(", start));
  check("装配构造 ProotEnv(dir, nativeDir) 并返回它",
    /val env = ProotEnv\(dir, nativeDir\)/.test(body) && /return env/.test(body),
    "构造时把 nativeLibraryDir 丢了，loader 拿不到真实路径");
  check("装配完验 loader 可读且非空，失败留 Log.w",
    /env\.loader\.isFile/.test(body) && /canRead\(\)/.test(body)
      && /length\(\) == 0L/.test(body) && /android\.util\.Log\.w\("DSHRuntime"/.test(body),
    "不自检就等 proot 抛英文错误；用户只能看到 node/python 全挂");
  check("符号链接失败不再让整套 proot 直接返回 null",
    /val bad = links\.filter/.test(body) && /relink 目标|装配失败/.test(body),
    "单个链接失败就整体禁用 proot，且没有任何诊断 —— 旧行为");
}

// 3) relink 的静默失败必须修掉（注释里早写过「链接永久失效（踩过）」）
{
  const start = rt.indexOf("private fun relink(");
  const body = rt.slice(start, rt.indexOf("fun ensureBusyboxEnv(", start));
  check("relink 失败留日志", /onFailure\s*\{/.test(body) && /Log\.w\("DSHRuntime"/.test(body),
    "createSymbolicLink 抛异常又被吞掉，链接永久失效且无人知道");
  check("relink 用 NOFOLLOW_LINKS 判断链接本体",
    /LinkOption\.NOFOLLOW_LINKS/.test(body),
    "link.exists() 跟随目标，悬空链接会被误判、跳过删除，正是踩过的坑");
  check("relink 同时验证目标可读", /target\.canRead\(\)/.test(body),
    "只验链接存在不够，目标被 SELinux 挡住时仍会失败");
}

// 4) 启动 guest 前再验一次，错误转成可读 NEED_RUNTIME
{
  const start = rt.indexOf("private fun prootHostEnv(");
  const body = rt.slice(start, rt.indexOf("private fun spawn(", start));
  check("prootHostEnv 用 env.loader 的绝对路径给 PROOT_LOADER",
    /"PROOT_LOADER" to loader\.absolutePath/.test(body),
    "又把 filesDir 符号链接塞给 proot 了");
  check("启动前验 loader 可用并留 Log.w",
    /!loader\.isFile \|\| !loader\.canRead\(\)/.test(body)
      && /Log\.w\("DSHRuntime", "PROOT_LOADER 指向的文件不可用/.test(body),
    "loader 不可用时让 proot 报英文错误，模型无从下手");
}

// 5) NEED_RUNTIME:proot 要说清是 loader 问题
{
  const start = rt.indexOf("fun needRuntime(");
  const body = rt.slice(start, rt.indexOf("fun exec(", start));
  check("装配失败时给出 loader 相关的可读原因",
    /name == "proot" && prootEnv == null/.test(body) && /libdshloader\.so/.test(body),
    "用户只能看到 '运行环境不可用'，不知道是 loader 没接好");
}

console.log("✔ proot-loader: loader 走真实 .so / 装配自检 / relink 不再静默 / 可读错误 都在");
