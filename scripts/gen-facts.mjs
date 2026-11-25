#!/usr/bin/env node
/**
 * gen-facts.mjs — 事实生成器（dsh-mobile 版 verify-doc 机制的底座）。
 *
 * 为什么存在：README 里的版本号、工具数、单测数、权限清单、APK 大小/sha 过去
 * 靠人手维护，必然漂移（实测出现过「权限仅 INTERNET/VIBRATE」与 20 条真实权限
 * 并存）。这里把这些断言从代码/产物重新算出来，落到 docs/facts.json；
 * README 只放指向 docs/facts.json 的指针，不再手写数字。
 *
 * 用法：
 *   node scripts/gen-facts.mjs            # 生成/覆盖 docs/facts.json
 *   node scripts/gen-facts.mjs --check    # 只比对，不一致 exit 1（CI 用）
 *   node scripts/gen-facts.mjs --print    # 打印到 stdout，不写文件
 *   node scripts/gen-facts.mjs --root <dir>   # 在构建副本里生成（Lead 用）
 *
 * 数据来源（均为只读）：
 *   version.properties / app/build.gradle.kts   versionName + versionCode
 *   app/src/main/java 下 kernel/plugin/ToolCatalog.kt   put("name") 去重计数
 *   app/src/test 下所有 .kt 文件                 @Test 计数
 *   app/src/main/AndroidManifest.xml            生效权限（剔除 tools:node="remove"）
 *   （APK size/sha 不进 facts：那是发布产物的属性，由 release-manifest.json 负责，
 *     否则干净检出/CI 没有 APK 时 facts 无法逐字节复现）
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..')
const FACTS_REL = 'docs/facts.json'

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, out)
    else if (entry.isFile()) out.push(abs)
  }
  return out
}

/** @param {string} root */
export function readVersion(root) {
  const propsPath = join(root, 'version.properties')
  if (existsSync(propsPath)) {
    const props = Object.fromEntries(
      readFileSync(propsPath, 'utf8')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line !== '' && !line.startsWith('#'))
        .map(line => {
          const eq = line.indexOf('=')
          return eq === -1 ? [line, ''] : [line.slice(0, eq).trim(), line.slice(eq + 1).trim()]
        }),
    )
    const code = Number.parseInt(props.versionCode ?? '', 10)
    if (props.versionName && Number.isInteger(code)) {
      return { versionName: props.versionName, versionCode: code, versionSource: 'version.properties' }
    }
  }

  const gradlePath = join(root, 'app/build.gradle.kts')
  if (!existsSync(gradlePath)) throw new Error(`missing ${relative(root, gradlePath)}`)
  const gradle = readFileSync(gradlePath, 'utf8')
  const name = /versionName\s*=\s*"([^"]+)"/.exec(gradle)
  const code = /versionCode\s*=\s*(\d+)/.exec(gradle)
  if (!name || !code) throw new Error('cannot parse versionName/versionCode from app/build.gradle.kts')
  return { versionName: name[1], versionCode: Number.parseInt(code[1], 10), versionSource: 'app/build.gradle.kts' }
}

/** @param {string} root */
export function readTools(root) {
  const catalog = join(root, 'app/src/main/java/ai/deepseek/harness/mobile/kernel/plugin/ToolCatalog.kt')
  if (!existsSync(catalog)) throw new Error(`missing ${relative(root, catalog)}`)
  const text = readFileSync(catalog, 'utf8')
  const names = [...text.matchAll(/^\s*put\("([a-z0-9_]+)"/gm)].map(match => match[1])
  const unique = [...new Set(names)].sort()
  return { catalogEntries: names.length, uniqueTools: unique.length, toolNames: unique }
}

/** @param {string} root */
export function readTests(root) {
  const testRoot = join(root, 'app/src/test')
  const files = walk(testRoot).filter(file => file.endsWith('.kt'))
  let annotations = 0
  for (const file of files) annotations += (readFileSync(file, 'utf8').match(/@Test\b/g) ?? []).length
  return { files: files.length, annotations }
}

/** @param {string} root */
export function readPermissions(root) {
  const manifest = join(root, 'app/src/main/AndroidManifest.xml')
  if (!existsSync(manifest)) throw new Error(`missing ${relative(root, manifest)}`)
  const text = readFileSync(manifest, 'utf8')
  const blocks = text.match(/<uses-permission\b[\s\S]*?\/>/g) ?? []
  const effective = new Set()
  const removed = new Set()
  for (const block of blocks) {
    const name = /android:name\s*=\s*"([^"]+)"/.exec(block)
    if (!name) continue
    if (/tools:node\s*=\s*"remove"/.test(block)) removed.add(name[1])
    else effective.add(name[1])
  }
  return {
    effective: [...effective].sort(),
    removedByTools: [...removed].sort(),
    effectiveCount: effective.size,
  }
}

/** @param {string} root */
export function collectFacts(root = DEFAULT_ROOT) {
  const version = readVersion(root)
  return {
    versionName: version.versionName,
    versionCode: version.versionCode,
    versionSource: version.versionSource,
    tools: readTools(root),
    tests: readTests(root),
    permissions: readPermissions(root),
  }
}

/** 稳定序列化：固定键序、两空格缩进、结尾一个换行，保证 --check 可逐字节比对。 */
export function serializeFacts(facts) {
  const ordered = {
    versionName: facts.versionName,
    versionCode: facts.versionCode,
    versionSource: facts.versionSource,
    tools: {
      catalogEntries: facts.tools.catalogEntries,
      uniqueTools: facts.tools.uniqueTools,
      toolNames: facts.tools.toolNames,
    },
    tests: { files: facts.tests.files, annotations: facts.tests.annotations },
    permissions: {
      effectiveCount: facts.permissions.effectiveCount,
      effective: facts.permissions.effective,
      removedByTools: facts.permissions.removedByTools,
    },
  }
  return JSON.stringify(ordered, null, 2) + '\n'
}

function parseArgs(argv) {
  const options = { check: false, print: false, root: DEFAULT_ROOT, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') options.check = true
    else if (arg === '--print') options.print = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--root') {
      const value = argv[index + 1]
      if (!value) throw new Error('--root requires a directory')
      options.root = resolve(value)
      index += 1
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function firstDiff(expected, actual) {
  const a = expected.split('\n')
  const b = actual.split('\n')
  const limit = Math.max(a.length, b.length)
  for (let index = 0; index < limit; index += 1) {
    if (a[index] !== b[index]) {
      return `line ${index + 1}:\n  committed: ${JSON.stringify(a[index])}\n  generated: ${JSON.stringify(b[index])}`
    }
  }
  return 'content differs'
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('usage: node scripts/gen-facts.mjs [--check] [--print] [--root <dir>]')
    return
  }
  const facts = collectFacts(options.root)
  const serialized = serializeFacts(facts)

  if (options.print) {
    process.stdout.write(serialized)
    return
  }

  const factsPath = join(options.root, FACTS_REL)
  if (options.check) {
    if (!existsSync(factsPath)) {
      console.error(`gen-facts: ${FACTS_REL} 不存在，先运行 node scripts/gen-facts.mjs`)
      process.exit(1)
    }
    const committed = readFileSync(factsPath, 'utf8')
    if (committed !== serialized) {
      console.error(`gen-facts: ${FACTS_REL} 已过期（与代码/产物不一致）。`)
      console.error(firstDiff(committed, serialized))
      console.error('运行 `node scripts/gen-facts.mjs` 后提交该文件。')
      process.exit(1)
    }
    console.log(`gen-facts: ok（${facts.versionName}/${facts.versionCode}, ${facts.tools.uniqueTools} 工具, ${facts.tests.annotations} 单测, ${facts.permissions.effectiveCount} 权限）`)
    return
  }

  writeFileSync(factsPath, serialized)
  console.log(`gen-facts: wrote ${FACTS_REL}（${facts.versionName}/${facts.versionCode}, ${facts.tools.uniqueTools} 工具, ${facts.tests.annotations} 单测, ${facts.permissions.effectiveCount} 权限）`)
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error(`gen-facts: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}
