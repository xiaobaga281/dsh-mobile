#!/usr/bin/env node
/**
 * run-gates.mjs — dsh-mobile 的统一门禁选择器（对应桌面 DSH 的 scripts/run-gates.ts）。
 *
 * 桌面做法：gate 声明 id/needs/env，按 lane（ci-static / ci-coverage / ci-snapshot…）
 * 组装；本地只跑与改动相关的 lane，CI 跑全量。这里保留同样的模式选择器，
 * 但把 lane 收敛到手机端真正存在的四类：
 *
 *   static       产物一致性 + 前端回归 + 文档事实 + 交叉校验 + lint（不需要设备，秒级）
 *   unit         JVM 单测（解析 JUnit XML 汇总，不信任 CLI 退出码）
 *   instrumented 设备/模拟器上的 androidTest（无 androidTest 源时明确 SKIP）
 *   release      assembleRelease + 签名校验 + APK 体积/版本/事实
 *   all          static → unit → release（instrumented 另加 --with-device）
 *
 * 用法：
 *   node scripts/gates/run-gates.mjs static
 *   node scripts/gates/run-gates.mjs unit --offline
 *   node scripts/gates/run-gates.mjs all --keep-going
 *   node scripts/gates/run-gates.mjs static --no-gradle      # 只跑文档/事实门
 *   node scripts/gates/run-gates.mjs release --max-apk-mb 130
 *
 * 选项：
 *   --root <dir>       在构建副本上跑（默认脚本所在项目根）
 *   --offline          Gradle 追加 --offline（依赖缓存需已预热）
 *   --no-gradle        跳过所有 Gradle 调用（文档/CI 静态环境用）
 *   --keep-going       某 gate 失败后继续跑剩余 gate（默认 fail-fast）
 *   --with-device      all 模式额外跑 instrumented
 *   --max-apk-mb <n>   standard flavor 的 APK 体积预算（默认 100 MiB）
 *   --max-complete-apk-mb <n>  complete flavor 的预算（默认 260 MiB，内置 Alpine rootfs）
 *
 * 产物布局：assembleRelease 按 flavor + ABI 拆包，APK 在
 * app/build/outputs/apk/<standard|complete>/release/ 下（不再有单包 app-release.apk）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..', '..')
const IS_WINDOWS = process.platform === 'win32'

const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const YELLOW = '\u001b[33m'
const DIM = '\u001b[2m'
const RESET = '\u001b[0m'

function parseArgs(argv) {
  const options = {
    mode: 'static',
    root: DEFAULT_ROOT,
    offline: false,
    noGradle: false,
    keepGoing: false,
    withDevice: false,
    maxApkMb: 100,
    maxCompleteApkMb: 260,
  }
  const modes = new Set(['static', 'unit', 'device', 'instrumented', 'release', 'all'])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (modes.has(arg)) options.mode = arg
    else if (arg === '--root') {
      options.root = resolve(argv[index + 1] ?? '')
      index += 1
    } else if (arg === '--offline') options.offline = true
    else if (arg === '--no-gradle') options.noGradle = true
    else if (arg === '--keep-going') options.keepGoing = true
    else if (arg === '--with-device') options.withDevice = true
    else if (arg === '--max-apk-mb') {
      const value = Number.parseInt(argv[index + 1] ?? '', 10)
      if (!Number.isInteger(value) || value <= 0) throw new Error('--max-apk-mb requires a positive integer')
      options.maxApkMb = value
      index += 1
    } else if (arg === '--max-complete-apk-mb') {
      const value = Number.parseInt(argv[index + 1] ?? '', 10)
      if (!Number.isInteger(value) || value <= 0) throw new Error('--max-complete-apk-mb requires a positive integer')
      options.maxCompleteApkMb = value
      index += 1
    } else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function run(label, command, args, options, extra = {}) {
  const started = Date.now()
  process.stdout.write(`${DIM}▶ ${label}: ${command} ${args.join(' ')}${RESET}\n`)
  // Windows 上 .bat/.cmd 不能直接 spawn（Node 18.20+ 的 EINVAL 安全限制），
  // 必须经 shell；这里只用于本仓库自己的 gradlew.bat / apksigner.bat，
  // 参数中不含需要转义的空格路径（SDK/项目均在无空格路径下）。
  const needsShell = IS_WINDOWS && /\.(bat|cmd)$/i.test(command)
  const result = spawnSync(command, args, {
    cwd: extra.cwd ?? options.root,
    stdio: 'inherit',
    env: process.env,
    shell: needsShell,
  })
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  if (result.error) {
    return { label, ok: false, elapsed, detail: result.error.message }
  }
  return { label, ok: result.status === 0, elapsed, detail: `exit ${result.status}` }
}

/** 跑一条只读探针命令并拿 stdout（失败返回空串）—— 用于「有没有设备」这类探测。 */
function execSyncSafe(command, args = []) {
  try {
    const r = spawnSync(command, args, { encoding: 'utf8' })
    return r.stdout ?? ''
  } catch (_) {
    return ''
  }
}

function nodepath(script) {
  return join('scripts', script)
}

/** 解析 JUnit XML，汇总通过/失败/跳过；同时要求结果文件存在。 */
function summarizeUnitResults(root) {
  // flavor 拆分后任务名带 flavor 前缀：testDebugUnitTest 在这个工程里不存在
  const dir = join(root, 'app/build/test-results/testStandardDebugUnitTest')
  if (!existsSync(dir)) return { ok: false, detail: `找不到测试结果目录 ${dir}（先跑 testStandardDebugUnitTest）` }
  const files = readdirSync(dir).filter(name => name.endsWith('.xml'))
  if (files.length === 0) return { ok: false, detail: `${dir} 下没有 XML 结果` }
  let tests = 0
  let failures = 0
  let errors = 0
  let skipped = 0
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8')
    const head = /<testsuite\b[^>]*>/.exec(text)
    if (!head) continue
    const attr = name => {
      const match = new RegExp(`${name}="([^"]*)"`).exec(head[0])
      return match ? Number.parseInt(match[1], 10) : 0
    }
    tests += attr('tests')
    failures += attr('failures')
    errors += attr('errors')
    skipped += attr('skipped')
  }
  const ok = tests > 0 && failures + errors === 0
  return {
    ok,
    detail: `${tests} tests, ${failures} failures, ${errors} errors, ${skipped} skipped, ${files.length} suites`,
  }
}

function gradleCommand(root) {
  const wrapper = IS_WINDOWS ? 'gradlew.bat' : './gradlew'
  const wrapperPath = join(root, IS_WINDOWS ? 'gradlew.bat' : 'gradlew')
  if (existsSync(wrapperPath)) return { command: wrapper, cwd: root }
  return null
}

function gradleArgs(args, options) {
  return options.offline ? [...args, '--offline'] : args
}

/**
 * 发布产物清单：assembleRelease 按 flavor + ABI 拆分，APK 落在
 * app/build/outputs/apk/<flavor>/release/ 下（不再是单个 app-release.apk）。
 * 仓库根目录的 DSH-Mobile-*.apk 是历史发布副本，也一并收集。
 */
function releaseApks(root) {
  const out = []
  const base = join(root, 'app/build/outputs/apk')
  if (existsSync(base)) {
    for (const flavor of readdirSync(base)) {
      const dir = join(base, flavor, 'release')
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir)) {
        if (name.endsWith('.apk')) out.push({ file: join(dir, name), flavor })
      }
    }
  }
  try {
    for (const name of readdirSync(root)) {
      if (!/^DSH-Mobile-.*\.apk$/.test(name)) continue
      out.push({ file: join(root, name), flavor: name.includes('-standard-') ? 'standard' : 'complete' })
    }
  } catch {
    // 根目录不可读时忽略
  }
  return out
}

function apksignerPath(root) {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? (() => {
    const local = join(root, 'local.properties')
    if (!existsSync(local)) return null
    const match = /sdk\.dir\s*=\s*(.+)/.exec(readFileSync(local, 'utf8'))
    return match ? match[1].replace(/\\\\/g, '\\').replace(/\\:/g, ':').trim() : null
  })()
  if (!sdk) return null
  const buildTools = join(sdk, 'build-tools')
  if (!existsSync(buildTools)) return null
  const versions = readdirSync(buildTools).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  for (const version of versions) {
    const candidate = join(buildTools, version, IS_WINDOWS ? 'apksigner.bat' : 'apksigner')
    if (existsSync(candidate)) return candidate
  }
  return null
}

function plan(mode, options) {
  const gates = []
  const add = gate => gates.push(gate)

  if (mode === 'static' || mode === 'all') {
    // 必须排在 web-regress / facts-* / contract-alignment 之前：
    // 它们是拿 app/src/main/assets/web/app.js 做判定的，产物一旦和 web/src 分叉，
    // 后面所有 gate 都会给一份过期产物背书（历史上 preview 落后 1599 行就是这么发生的）。
    add({ id: 'web-bundle', run: () => run('web-bundle', process.execPath, ['scripts/build-web.mjs', '--check'], options) })
    add({ id: 'web-regress', run: () => run('web-regress', process.execPath, ['scripts/regress/run-all.mjs'], options) })
    add({ id: 'facts-check', run: () => run('facts-check', process.execPath, [nodepath('gen-facts.mjs'), '--check', '--root', options.root], options) })
    add({ id: 'facts-verify', run: () => run('facts-verify', process.execPath, [nodepath('verify-facts.mjs'), '--root', options.root], options) })
    add({
      id: 'md-links',
      // 脚本已经在仓库里，这条是真检查：以前它去找一个不存在的文件，于是永远 SKIP，
      // 摘要里那行「(optional) md-links SKIP」就是把假绿当通过。
      run: () => run('md-links', process.execPath, ['scripts/verify-md-links.mjs', '--root', options.root], options),
    })
    if (!options.noGradle) {
      const gradle = gradleCommand(options.root)
      if (!gradle) add({ id: 'gradle-lint', optional: true, run: () => ({ label: 'gradle-lint', ok: true, elapsed: '0.0', detail: 'SKIP（无 wrapper）' }) })
      else add({ id: 'gradle-lint', run: () => run('gradle-lint', gradle.command, gradleArgs([':app:lintStandardDebug', '--console=plain', '--no-daemon'], options), options) })
    }
  }

  if (mode === 'unit' || mode === 'all') {
    const gradle = gradleCommand(options.root)
    if (options.noGradle) {
      add({ id: 'gradle-unit', optional: true, run: () => ({ label: 'gradle-unit', ok: true, elapsed: '0.0', detail: 'SKIP（--no-gradle，使用既有 test-results）' }) })
    } else if (!gradle) {
      add({ id: 'gradle-unit', run: () => ({ label: 'gradle-unit', ok: false, elapsed: '0.0', detail: '无 gradlew wrapper' }) })
    } else {
      add({ id: 'gradle-unit', run: () => run('gradle-unit', gradle.command, gradleArgs(['testStandardDebugUnitTest', '--console=plain', '--no-daemon'], options), options) })
    }
    add({
      id: 'unit-results',
      run: () => {
        const summary = summarizeUnitResults(options.root)
        return { label: 'unit-results', ok: summary.ok, elapsed: '0.0', detail: summary.detail }
      },
    })
    add({ id: 'facts-check', run: () => run('facts-check', process.execPath, [nodepath('gen-facts.mjs'), '--check', '--root', options.root], options) })
    add({ id: 'facts-verify', run: () => run('facts-verify', process.execPath, [nodepath('verify-facts.mjs'), '--root', options.root], options) })
  }

  if (mode === 'device' || (mode === 'all' && options.withDevice)) {
    // 设备 lane：跑 scripts/emulator/anchor_local.py（它自带断言与非零退出码）。
    // 为什么不补 app/src/androidTest：那要从头写 WebView 驱动（1~2 周），而这里的脚本
    // 已经能通过 CDP 直接读 DOM —— 布局/合成层这些事故现场只有它能看见。
    // 没有设备就 SKIP，不冒充覆盖；子命令用 DSH_EMU_CMD 选（默认 scroll）。
    const script = join(options.root, 'scripts/emulator/anchor_local.py')
    const cmd = process.env.DSH_EMU_CMD || 'scroll'
    if (!existsSync(script)) {
      add({ id: 'emulator-dynamic', optional: true, run: () => ({ label: 'emulator-dynamic', ok: true, elapsed: '0.0', detail: 'SKIP（无 scripts/emulator/anchor_local.py）' }) })
    } else {
      const hasDevice = (() => {
        try {
          const out = execSyncSafe('adb', ['devices'])
          return /\n\S+\tdevice/.test(out)
        } catch (_) { return false }
      })()
      if (!hasDevice) {
        add({ id: 'emulator-dynamic', optional: true, run: () => ({ label: 'emulator-dynamic', ok: true, elapsed: '0.0', detail: `SKIP（没有已连接设备；脚本与子命令「${cmd}」已就绪）` }) })
      } else {
        add({ id: 'emulator-dynamic', run: () => run('emulator-dynamic', 'python', [script, cmd], options) })
      }
    }
  }

  if (mode === 'instrumented' || (mode === 'all' && options.withDevice)) {
    const hasAndroidTest = existsSync(join(options.root, 'app/src/androidTest'))
    if (options.noGradle) {
      add({ id: 'gradle-instrumented', optional: true, run: () => ({ label: 'gradle-instrumented', ok: true, elapsed: '0.0', detail: 'SKIP（--no-gradle）' }) })
    } else if (!hasAndroidTest) {
      add({ id: 'gradle-instrumented', optional: true, run: () => ({ label: 'gradle-instrumented', ok: true, elapsed: '0.0', detail: 'SKIP（无 app/src/androidTest）' }) })
    } else {
      const gradle = gradleCommand(options.root)
      add({ id: 'gradle-instrumented', run: () => run('gradle-instrumented', gradle.command, gradleArgs(['connectedDebugAndroidTest', '--console=plain', '--no-daemon'], options), options) })
    }
  }

  if (mode === 'release' || mode === 'all') {
    if (options.noGradle) {
      add({ id: 'gradle-release', optional: true, run: () => ({ label: 'gradle-release', ok: true, elapsed: '0.0', detail: 'SKIP（--no-gradle，使用既有 APK）' }) })
    } else {
      const gradle = gradleCommand(options.root)
      if (!gradle) add({ id: 'gradle-release', run: () => ({ label: 'gradle-release', ok: false, elapsed: '0.0', detail: '无 gradlew wrapper' }) })
      else add({ id: 'gradle-release', run: () => run('gradle-release', gradle.command, gradleArgs(['assembleRelease', '--console=plain', '--no-daemon'], options), options) })
    }
    add({
      id: 'apk-signature',
      run: () => {
        const apks = releaseApks(options.root)
        if (!apks.length) return { label: 'apk-signature', ok: false, elapsed: '0.0', detail: '找不到 APK（先 assembleRelease）' }
        const signer = apksignerPath(options.root)
        if (!signer) return { label: 'apk-signature', ok: true, elapsed: '0.0', detail: `SKIP（找不到 apksigner，共 ${apks.length} 个 APK）` }
        let ok = true
        const rows = []
        for (const { file } of apks) {
          const result = run('apk-signature', signer, ['verify', '--print-certs', file], options)
          if (!result.ok) ok = false
          rows.push(`${basename(file)} ${result.ok ? 'ok' : 'FAIL'}`)
        }
        return { label: 'apk-signature', ok, elapsed: '0.0', detail: rows.join('；') }
      },
    })
    add({
      id: 'apk-budget',
      run: () => {
        const apks = releaseApks(options.root)
        if (!apks.length) return { label: 'apk-budget', ok: false, elapsed: '0.0', detail: '找不到 APK' }
        let ok = true
        const rows = []
        for (const { file, flavor } of apks) {
          // complete 通道内置 Alpine rootfs（每 ABI 100MB+），预算必须单独一档
          const budget = flavor === 'standard' ? options.maxApkMb : options.maxCompleteApkMb
          const mb = statSync(file).size / (1024 * 1024)
          if (mb > budget) ok = false
          rows.push(`${basename(file)} ${mb.toFixed(1)}/${budget} MiB`)
        }
        return { label: 'apk-budget', ok, elapsed: '0.0', detail: rows.join('；') }
      },
    })
    add({ id: 'facts-check', run: () => run('facts-check', process.execPath, [nodepath('gen-facts.mjs'), '--check', '--root', options.root], options) })
    add({ id: 'facts-verify', run: () => run('facts-verify', process.execPath, [nodepath('verify-facts.mjs'), '--root', options.root], options) })
  }

  return gates
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('usage: node scripts/gates/run-gates.mjs <static|unit|instrumented|release|all> [options]')
    console.log('options: --root <dir> --offline --no-gradle --keep-going --with-device')
    console.log('         --max-apk-mb <n>（standard，默认 100） --max-complete-apk-mb <n>（complete，默认 260）')
    return
  }

  const gates = plan(options.mode, options)
  if (gates.length === 0) {
    console.error(`run-gates: 模式 ${options.mode} 没有可执行的 gate`)
    process.exit(2)
  }

  const results = []
  let failed = 0
  for (const gate of gates) {
    let result
    try {
      result = gate.run()
    } catch (error) {
      result = { label: gate.id, ok: false, elapsed: '0.0', detail: error instanceof Error ? error.message : String(error) }
    }
    results.push(result)
    if (!result.ok) {
      failed += 1
      if (!options.keepGoing) break
    }
  }

  console.log(`\n${DIM}── gate summary (${options.mode}) ──${RESET}`)
  for (const result of results) {
    const mark = result.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
    const optional = result.detail.startsWith('SKIP') ? `${YELLOW}(optional)${RESET} ` : ''
    console.log(`  ${mark} ${optional}${result.label.padEnd(18)} ${result.elapsed}s  ${result.detail}`)
  }
  const skipped = gates.length - results.length
  if (skipped > 0) console.log(`${DIM}  ${skipped} gate(s) 未执行（fail-fast）${RESET}`)

  if (failed > 0) {
    console.error(`${RED}run-gates: ${failed} gate(s) failed${RESET}`)
    process.exit(1)
  }
  console.log(`${GREEN}run-gates: ${options.mode} 全部通过${RESET}`)
}

try {
  main()
} catch (error) {
  console.error(`run-gates: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
