#!/usr/bin/env node
/**
 * verify-facts.mjs — 交叉核对 docs/facts.json 与「真源」（代码/清单/产物）。
 *
 * 与 gen-facts --check 的分工：
 *   gen-facts --check  只要 docs/facts.json 与当前派生结果逐字节一致即可；
 *   verify-facts       逐项复核每类事实的来源，并检查三处版本一致性，
 *                      失败时给出「哪一项、期望、实际」的可读报告。
 *
 * 用法：
 *   node scripts/verify-facts.mjs [--root <dir>] [--check-readme]
 *
 * 检查项：
 *   1. docs/facts.json 存在且可解析
 *   2. version.properties（若存在）↔ facts；build.gradle 已接线（versionName = appVersionName）
 *      若 version.properties 不存在，则 build.gradle 的字面量 ↔ facts
 *   3. ToolCatalog put() 去重数 ↔ facts.tools
 *   4. app/src/test 的 @Test 数 ↔ facts.tests
 *   5. AndroidManifest 生效权限 ↔ facts.permissions.effective
 *   7. --check-readme：README 不再出现「权限仅 INTERNET/VIBRATE」式手写断言，
 *      且包含指向 docs/facts.json 的指针（默认只告警，加 --check-readme 才失败）
 *
 * 退出码：0 全部通过；1 有不一致；2 用法/环境错误。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPermissions, readTests, readTools, readVersion } from './gen-facts.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..')
const FACTS_REL = 'docs/facts.json'

const RED = '\u001b[31m'
const GREEN = '\u001b[32m'
const DIM = '\u001b[2m'
const RESET = '\u001b[0m'

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, checkReadme: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check-readme') options.checkReadme = true
    else if (arg === '--root') {
      const value = argv[index + 1]
      if (!value) throw new Error('--root requires a directory')
      options.root = resolve(value)
      index += 1
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function readProperties(path) {
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

/** @param {string} root */
function checkVersion(root, facts, failures, notes) {
  const propsPath = join(root, 'version.properties')
  const gradlePath = join(root, 'app/build.gradle.kts')
  const gradle = existsSync(gradlePath) ? readFileSync(gradlePath, 'utf8') : ''

  if (existsSync(propsPath)) {
    const props = readProperties(propsPath)
    const code = Number.parseInt(props.versionCode ?? '', 10)
    if (props.versionName !== facts.versionName) {
      failures.push(`version.properties versionName=${props.versionName} 与 facts=${facts.versionName} 不一致`)
    }
    if (code !== facts.versionCode) {
      failures.push(`version.properties versionCode=${props.versionCode} 与 facts=${facts.versionCode} 不一致`)
    }
    if (!/versionName\s*=\s*appVersionName/.test(gradle) || !/versionCode\s*=\s*appVersionCode/.test(gradle)) {
      failures.push('app/build.gradle.kts 未接线到 version.properties（应使用 versionName = appVersionName / versionCode = appVersionCode）')
    }
    if (facts.versionSource !== 'version.properties') {
      failures.push(`facts.versionSource=${facts.versionSource}，但 version.properties 存在（应为 version.properties）`)
    }
    notes.push(`版本来源 version.properties: ${props.versionName}/${props.versionCode}`)
  } else {
    const name = /versionName\s*=\s*"([^"]+)"/.exec(gradle)
    const code = /versionCode\s*=\s*(\d+)/.exec(gradle)
    if (!name || name[1] !== facts.versionName) failures.push('build.gradle versionName 与 facts 不一致（且无 version.properties）')
    if (!code || Number.parseInt(code[1], 10) !== facts.versionCode) failures.push('build.gradle versionCode 与 facts 不一致（且无 version.properties）')
    notes.push('版本来源 app/build.gradle.kts（无 version.properties）')
  }

  const derived = readVersion(root)
  if (derived.versionName !== facts.versionName || derived.versionCode !== facts.versionCode) {
    failures.push(`readVersion() 派生=${derived.versionName}/${derived.versionCode} 与 facts 不一致`)
  }
}

/** @param {string} root */
function checkReadme(root, failures, warnings) {
  const readmePath = join(root, 'README.md')
  if (!existsSync(readmePath)) {
    warnings.push('README.md 不存在，跳过 README 断言检查')
    return
  }
  const readme = readFileSync(readmePath, 'utf8')

  // 只匹配「作为断言原句出现」的旧权限声明：行首（可带列表符号）直接就是
  // 「权限仅 INTERNET、VIBRATE」。README 里解释历史错误的句子（"此前手写的
  // 那份与真实清单不符"）或引用该句的说明不会命中，避免误报。
  const falseAssertion = /^[ \t]*(?:[-*][ \t]+)?权限仅[ \t]*`?INTERNET`?[ \t]*[、,，][ \t]*`?VIBRATE`?/m
  if (falseAssertion.test(readme)) {
    failures.push('README.md 仍把「权限仅 INTERNET、VIBRATE」当作当前事实——应改为指向 docs/facts.json 的指针')
  }
  if (!/docs\/facts\.json/.test(readme)) {
    warnings.push('README.md 未找到 docs/facts.json 指针（建议加一行「版本/工具数/权限/APK 见 docs/facts.json」）')
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const root = options.root
  const factsPath = join(root, FACTS_REL)
  const failures = []
  const warnings = []
  const notes = []

  if (!existsSync(factsPath)) {
    console.error(`verify-facts: ${FACTS_REL} 不存在，先运行 node scripts/gen-facts.mjs`)
    process.exit(1)
  }

  let facts
  try {
    facts = JSON.parse(readFileSync(factsPath, 'utf8'))
  } catch (error) {
    console.error(`verify-facts: ${FACTS_REL} 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }

  try {
    checkVersion(root, facts, failures, notes)

    const tools = readTools(root)
    if (tools.uniqueTools !== facts.tools.uniqueTools || tools.catalogEntries !== facts.tools.catalogEntries) {
      failures.push(
        `工具数不一致：facts=${facts.tools.uniqueTools}/${facts.tools.catalogEntries}，` +
          `ToolCatalog=${tools.uniqueTools}/${tools.catalogEntries}`,
      )
    }
    if (JSON.stringify(tools.toolNames) !== JSON.stringify(facts.tools.toolNames)) {
      const missing = facts.tools.toolNames.filter(name => !tools.toolNames.includes(name))
      const added = tools.toolNames.filter(name => !facts.tools.toolNames.includes(name))
      failures.push(`工具名集合不一致：facts 多 [${missing.join(', ')}]，源码多 [${added.join(', ')}]`)
    }
    notes.push(`ToolCatalog put() 去重: ${tools.uniqueTools}`)

    const tests = readTests(root)
    if (tests.annotations !== facts.tests.annotations || tests.files !== facts.tests.files) {
      failures.push(`单测统计不一致：facts=${facts.tests.annotations}/${facts.tests.files} 文件，源码=${tests.annotations}/${tests.files} 文件`)
    }
    notes.push(`@Test: ${tests.annotations}（${tests.files} 文件）`)

    const permissions = readPermissions(root)
    if (JSON.stringify(permissions.effective) !== JSON.stringify(facts.permissions.effective)) {
      const missing = facts.permissions.effective.filter(name => !permissions.effective.includes(name))
      const added = permissions.effective.filter(name => !facts.permissions.effective.includes(name))
      failures.push(`生效权限不一致：facts 多 [${missing.join(', ')}]，manifest 多 [${added.join(', ')}]`)
    }
    if (permissions.effectiveCount !== facts.permissions.effectiveCount) {
      failures.push(`权限条数不一致：facts=${facts.permissions.effectiveCount}，manifest=${permissions.effectiveCount}`)
    }
    notes.push(`生效权限: ${permissions.effectiveCount}（tools:node=remove ${permissions.removedByTools.length}）`)

    const readmeIssues = []
    checkReadme(root, readmeIssues, warnings)
    if (readmeIssues.length > 0) {
      if (options.checkReadme) failures.push(...readmeIssues)
      else warnings.push(...readmeIssues.map(text => `（--check-readme 会失败）${text}`))
    }
  } catch (error) {
    console.error(`verify-facts: 检查过程出错: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }

  for (const note of notes) console.log(`${DIM}· ${note}${RESET}`)
  for (const warning of warnings) console.log(`${DIM}! ${warning}${RESET}`)

  if (failures.length > 0) {
    console.error(`${RED}verify-facts: ${failures.length} 项不一致${RESET}`)
    for (const failure of failures) console.error(`${RED}  ✗ ${failure}${RESET}`)
    console.error('修复后运行 `node scripts/gen-facts.mjs` 并提交 docs/facts.json。')
    process.exit(1)
  }

  console.log(`${GREEN}verify-facts: ok（${facts.versionName}/${facts.versionCode}，${facts.tools.uniqueTools} 工具，${facts.tests.annotations} 单测，${facts.permissions.effectiveCount} 权限）${RESET}`)
}

main()
