#!/usr/bin/env node
/**
 * 把 dsh 的会话事件文件读成文本：`session.v4.jsonl.zstd` 是**追加写的多个 zstd 帧**，
 * 一次 `zstdDecompressSync` 只解得开第一帧（表现是「只剩 221 字节的头」）。
 * 这里按帧魔数切开逐帧解，输出合并后的 JSONL。
 *
 *   node scripts/emulator/zdump.mjs <session.v4.jsonl.zstd> [--stats]
 */
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

const file = process.argv[2];
if (!file) {
  console.error("用法：node zdump.mjs <session.v4.jsonl.zstd> [--stats]");
  process.exit(2);
}
const buf = readFileSync(file);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const marks = [];
let i = buf.indexOf(MAGIC);
while (i >= 0) {
  marks.push(i);
  i = buf.indexOf(MAGIC, i + 1);
}
let text = "";
for (let k = 0; k < marks.length; k++) {
  const end = k + 1 < marks.length ? marks[k + 1] : buf.length;
  try {
    text += zstdDecompressSync(buf.subarray(marks[k], end)).toString("utf8");
  } catch {
    // 坏帧跳过：解码是排障用的，不该被一帧拖死
  }
}

if (!process.argv.includes("--stats")) {
  process.stdout.write(text);
  process.exit(0);
}
const lines = text.split("\n").filter(Boolean);
const types = {};
for (const line of lines) {
  try {
    const o = JSON.parse(line);
    const key = o.type + (o.data?.event?.type ? ":" + o.data.event.type : "");
    types[key] = (types[key] || 0) + 1;
  } catch {
    // 非 JSON 行不计
  }
}
const images = [...text.matchAll(/"type":"image"[^}]*"mediaType":"([^"]+)"/g)].map((m) => m[1]);
console.log(JSON.stringify({ frames: marks.length, bytes: text.length, lines: lines.length, images, types }, null, 1));
