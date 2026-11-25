// 回归：guest 的 node 必须保持 22 LTS，且升级链路不能把基础镜像弄坏。
//
// 背景：基础 rootfs（Alpine v3.20）自带 node 20.15.1，与 musl 动态链接的
// libuv/libicu/libbrotli 等一整套库绑死。直接换 nodejs.org 官方 linux 二进制
// 是 glibc 跑不了；换 Alpine 自带包又得连带换库 = 重建 100MB+ 主载荷。
// 方案：libdshnode.so 增量补丁，取 unofficial-builds 的 *-musl 半静态构建
// （DT_NEEDED 只剩 ld-musl + libgcc_s，基础 rootfs 已有），只留 bin/node，
// 解包后原子替换 /usr/bin/node；失败时旧 node 20 原封不动。
//
// 载荷不入库（CI 上没有），断言只盯装配代码与生成脚本；载荷深度校验由
// `python scripts/build-node-patch.py --check` 负责。
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const rt = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/KernelRuntime.kt");
const gen = read("scripts/build-node-patch.py");
const ignore = read(".gitignore");
const probe = read(".motion/verify/verify-base-env.mjs");

function check(name, cond, hint) {
  if (!cond) throw new Error(`FAIL: ${name} —— ${hint}`);
}

// 1) 三个分支都要打补丁
{
  const start = rt.indexOf("fun prepareProotRootfs(");
  const body = rt.slice(start, rt.indexOf("writeGuestResolv(ready)", start));
  const calls = (body.match(/ensureNodePatch\(dest, bb\)/g) || []).length;
  check("prepareProotRootfs 三个分支都调 ensureNodePatch", calls === 3,
    `找到 ${calls} 处（应为 3）—— 冷启动/热重进某条路径会退回 node 20`);
}

// 2) 装配：幂等标记、xz 解包、原子替换、失败降级
{
  const start = rt.indexOf("private fun ensureNodePatch(");
  const body = rt.slice(start, rt.indexOf("private fun ensureSetarchPatch(", start));
  check("ensureNodePatch 存在", start > 0, "node 补丁装配被删了");
  check("版本常量是 22 LTS", /const val NODE_PATCH_VERSION = "v22\./.test(rt),
    "版本又退回 20 或写死成别的大版本");
  check("独立标记 .dsh-node-ready + 版本比对",
    /\.dsh-node-ready/.test(body) && /mark\.readTextOrNull\(\) == NODE_PATCH_VERSION/.test(body),
    "换补丁版本不触发重解，或每次 guest 执行都重新解 30MB");
  check("用 xz 解包且先 relink xz applet",
    /"-xJf"/.test(body) && /relink\(File\(bb\.binPath, "xz"\)/.test(body),
    "busybox -J 要外部 xz applet，没 relink 会解包失败");
  check("解包失败留日志出口", /Log\.w\("DSHRuntime", "node 补丁解包失败/.test(body),
    "静默失败后用户只看到 node 还是 20，没有任何线索");
  check("原子替换 /usr/bin/node 且失败保留 node 20",
    /staged\.renameTo\(File\(dest, "usr\/bin\/node"\)\)/.test(body)
      && /保留 node 20/.test(body),
    "直接覆盖或删旧文件会在补丁失败时让 guest 连 node 都没有");
  check("解包后补 exec 位", /setExecutable\(true, false\)/.test(body),
    "宿主 umask 可能抹掉 exec 位，node 会 permission denied");
}

// 3) 生成脚本：可复现、只取 node、校验架构与版本
{
  check("生成脚本入库且双 ABI 输出",
    existsSync(join(root, "scripts/build-node-patch.py"))
      && /arm64-v8a/.test(gen) && /x86_64/.test(gen) && /libdshnode\.so/.test(gen),
    "载荷变成一次性手工产物，换台机器复现不出来");
  check("来源是 unofficial-builds 的 musl 构建",
    /unofficial-builds\.nodejs\.org/.test(gen) && /-musl\.tar\.xz/.test(gen),
    "换回 glibc 官方构建会在 musl rootfs 里报 No such file or directory");
  check("只取 bin/node，不把自带 npm/corepack 混进来",
    /endswith\("\/bin\/node"\)/.test(gen) && /MEMBER = "\.\/usr\/bin\/node\.dsh22"/.test(gen),
    "官方 tar 自带 npm 会与 libdshnpm.so 互相覆盖");
  check("生成脚本校验 ELF 架构与版本串",
    /elf_machine/.test(gen) && /VERSION\.encode\(\) not in data/.test(gen),
    "拿错 ABI/版本的包会到真机上才暴露");
  check("载荷被 .gitignore 排除",
    /app\/src\/complete\/jniLibs\/\*\/libdshnode\.so/.test(ignore),
    "30MB ×2 的构建产物进了仓库");
}

// 4) 真机验收要能看出版本（不然「升级了」只是自我声明）
check("真机验收脚本断言 node 22",
  /v22\./.test(probe) && /process\.version/.test(probe),
  "只测 6*7 的话，node 20 和 22 都会通过，升级没生效也发现不了");
check("PROOT_ENTRY 仍指向 /usr/bin/node（补丁替换的就是它）",
  /"node" to "\/usr\/bin\/node"/.test(rt),
  "入口改了但补丁没跟着改，绝对路径会绕过新 node");

console.log("✔ node-patch: 三分支装配 / 原子替换可降级 / musl 来源 / 版本验收 都在");
