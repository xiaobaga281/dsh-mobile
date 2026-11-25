// 回归：npm 增量补丁的装配不能被绕过或 degradation 成「联网装」。
//
// 背景：基础 rootfs 只有 node 单二进制，pkg manager=npm 指向不存在的 /usr/bin/npm，
// 而缺失提示又让用户「联网装 npm」—— 用缺失的入口装它自己，真机上是死循环。
// 解法是仿 libdshgit.so 做 libdshnpm.so（scripts/build-npm-patch.py 从 Alpine
// npm .apk 重组，纯 JS 双 ABI 共用）+ KernelRuntime.ensureNpmPatch 幂等解包。
//
// 载荷本身被 .gitignore 排除（CI 上没有这份文件），所以这里只盯装配代码与生成脚本；
// 载荷内容的深度校验由 `python scripts/build-npm-patch.py --check` 负责。
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const rt = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/KernelRuntime.kt");
const gen = read("scripts/build-npm-patch.py");
const ignore = read(".gitignore");
const probe = read(".motion/verify/verify-base-env.mjs");

function check(name, cond, hint) {
  if (!cond) throw new Error(`FAIL: ${name} —— ${hint}`);
}

// 1) 唯一入口的三个分支都要检查补丁（fast-path / 重载 / 首次解包）
{
  const start = rt.indexOf("fun prepareProotRootfs(");
  const body = rt.slice(start, rt.indexOf("writeGuestResolv(ready)", start));
  const calls = (body.match(/ensureNpmPatch\(dest, bb\)/g) || []).length;
  check("prepareProotRootfs 三个分支都调 ensureNpmPatch", calls === 3,
    `找到 ${calls} 处（应为 3）—— 漏一个分支就会在冷启动/热重进某条路径上出现 npm 不可用`);
}

// 2) 幂等判定必须看 npm-cli.js 本体，不能看 /usr/bin/npm（那是相对 symlink）
{
  const start = rt.indexOf("private fun ensureNpmPatch(");
  const body = rt.slice(start, rt.indexOf("private fun ensureSetarchPatch(", start));
  check("ensureNpmPatch 存在", start > 0, "npm 补丁装配被删了");
  check("幂等看 npm-cli.js 本体 + 独立标记",
    /isRegularFileNoFollow\(cli\) && mark\.isFile/.test(body) && /npm-cli\.js/.test(body),
    "只看 /usr/bin/npm 这个链接的话，只解出链接没解出 node_modules 也会误判「已装好」");
  check("有独立指纹标记（不靠主载荷大小变化才重解）",
    body.includes('.dsh-npm-ready') && /mark\.writeText/.test(body),
    "git 补丁的既有欠账：补丁自身升级不触发重解；npm 别照抄");
  check("解包失败留日志出口并保留 tar 输出",
    /android\.util\.Log\.w\("DSHRuntime"[\s\S]{0,200}解包失败/.test(body) && /inputStream\.readBytes\(\)/.test(body),
    "解包失败又被静默吞掉 —— 真机上只会看到 npm 失效，没有任何诊断线索");
  check("补 exec 位（宿主 umask 可能抹掉）",
    /setExecutable\(true, false\)/.test(body),
    "npm-cli.js 是 #!/usr/bin/env node 脚本，没有 exec 位会 permission denied");
  check("载荷名与解包参数对齐 git 补丁",
    body.includes('"libdshnpm.so"') && body.includes('"-xzf"'),
    "载荷名或 gzip 格式改了，nativeLibraryDir 取不到 / busybox 解不开");
}

// 3) 生成脚本：可复现（git 补丁最大的欠账就是没有生成脚本）
{
  check("生成脚本入库且能输出双 ABI 载荷",
    existsSync(join(root, "scripts/build-npm-patch.py"))
      && /arm64-v8a/.test(gen) && /x86_64/.test(gen) && /libdshnpm\.so/.test(gen),
    "载荷是一次性手工产物的话，换台机器就再也复现不出来");
  check("生成脚本校验必需成员与 0 ELF",
    /npm-cli\.js/.test(gen) && /npx-cli\.js/.test(gen) && /ELF/.test(gen),
    "载荷里混进 ELF 就不能双 ABI 共用同一份了，必须拦住");
  check("载荷被 .gitignore 排除",
    /app\/src\/complete\/jniLibs\/\*\/libdshnpm\.so/.test(ignore),
    "2MB 的构建产物进了仓库，之后每次改都要带一份二进制 diff");
}

// 4) 注册表与真机验收
check("PROOT_ENTRY 仍把 npm 指到 /usr/bin/npm",
  /"npm" to "\/usr\/bin\/npm"/.test(rt),
  "入口改了但补丁解出来的路径没跟着改，guardGuestEntry 会一直报 NEED_RUNTIME");
check("真机验收脚本有 npm 断言（含不联网口径）",
  /manager: "npm"/.test(probe) && /10\.9\.1/.test(probe) && /未联网/.test(probe),
  "没有真机断言的话，「npm 装好了」只是代码里的自我声明");

console.log("✔ npm-patch: 三分支装配 / 本体幂等 / 失败有出口 / 生成脚本可复现 / 真机验收 都在");
