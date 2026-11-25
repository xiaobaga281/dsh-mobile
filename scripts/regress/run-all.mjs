#!/usr/bin/env node
/**
 * run-all.mjs — 跑遍 scripts/regress/ 下的全部 *.test.mjs，汇总结果。
 *
 * 这些是**纯 Node 的回归守卫**：抽取 app.js / styles.css 的真实源码片段跑断言，
 * 不需要设备、不需要 Gradle，秒级完成。每一条都对应一个真机上出过的 bug
 * （见同目录 README.md 的对照表）。
 *
 * 用法：
 *   node scripts/regress/run-all.mjs           # 跑全部
 *   node scripts/regress/run-all.mjs search    # 只跑名字含 search 的
 *
 * 退出码：任一用例失败即 1（供 scripts/gates/run-gates.mjs 的 web-regress gate 判定）。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const filter = process.argv[2] ?? ''
const files = readdirSync(HERE)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => f.includes(filter))
  .sort()

if (!files.length) {
  console.error(`run-all: 没有匹配的用例（filter=${filter || '(空)'}）`)
  process.exit(1)
}

const results = []
for (const file of files) {
  const started = Date.now()
  const r = spawnSync(process.execPath, [join(HERE, file)], { stdio: 'inherit', cwd: resolve(HERE, '../..') })
  results.push({ file, ok: r.status === 0, elapsed: ((Date.now() - started) / 1000).toFixed(2) })
}

console.log('\n──────── 回归汇总 ────────')
for (const r of results) console.log(`${r.ok ? '✔' : '✘'} ${r.file}  ${r.elapsed}s`)
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
