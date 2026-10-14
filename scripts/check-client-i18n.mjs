// scripts/check-client-i18n.mjs — 客户端字典完整性检查
//
// 客户端设置页里所有 `t('xxx')` 的 key 都必须能在 zh/en 字典里找到，
// 否则界面上会直接显示原始 key（`user.bioHint` 这种），用户看不懂。
// 反过来，字典里没被用到的 key 只是冗余，不算错误 —— 允许存在。
//
// 做法：不 import 客户端模块（它依赖 window.__ModuleLoader__ 与 react），
// 而是把源码当文本解析出 `t('...')` 调用与两个词典的顶层 key。
//
// 运行：node scripts/check-client-i18n.mjs
// 退出码：0 通过；1 有缺失。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client', 'index.mjs'), 'utf8')

// ---- 1. 收集用到的 key ----
const used = new Set()
// t('key') / t("key") / navT('key')
for (const match of source.matchAll(/\bt\(\s*['"]([A-Za-z0-9_.]+)['"]\s*\)/g)) used.add(match[1])
// 模板串形式 t(`opt.style.${value}`) —— 前缀式，单独收集前缀
const prefixes = new Set()
for (const match of source.matchAll(/\bt\(\s*`([A-Za-z0-9_.]+)\$\{/g)) prefixes.add(match[1])

// ---- 2. 收集两个词典的 key ----
function collectDict(name) {
  const start = source.indexOf(`const ${name} = {`)
  if (start < 0) throw new Error(`找不到词典 ${name}`)
  // 找到词典的闭合大括号：按行扫描，第一行开始记深度。
  const lines = source.slice(start).split('\n')
  let depth = 0
  let end = -1
  for (let i = 0; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end >= 0) break
  }
  if (end < 0) throw new Error(`词典 ${name} 未闭合`)
  const body = lines.slice(0, end + 1).join('\n')
  const keys = new Set()
  for (const match of body.matchAll(/^\s*['"]([A-Za-z0-9_.]+)['"]\s*:/gm)) keys.add(match[1])
  return keys
}

const zh = collectDict('zh')
const en = collectDict('en')

// ---- 3. 校验 ----
const missingZh = [...used].filter((key) => !zh.has(key)).sort()
const missingEn = [...used].filter((key) => !en.has(key)).sort()
const zhEnDiff = [
  ...[...en].filter((key) => !zh.has(key)).map((key) => `${key} (只有 en)`),
  ...[...zh].filter((key) => !en.has(key)).map((key) => `${key} (只有 zh)`)
].sort()

// 前缀式 key：确认至少有一个以该前缀开头的 key 存在。
const missingPrefixes = [...prefixes].filter(
  (prefix) => ![...zh].some((key) => key.startsWith(prefix))
)

console.log(`字典 zh=${zh.size} key，en=${en.size} key`)
console.log(`源码用到 ${used.size} 个字面 key、${prefixes.size} 个前缀式 key`)

let failed = false
if (missingZh.length > 0) {
  failed = true
  console.log(`\nFAIL zh 缺 ${missingZh.length} 个 key：`)
  for (const key of missingZh) console.log(`  - ${key}`)
}
if (missingEn.length > 0) {
  failed = true
  console.log(`\nFAIL en 缺 ${missingEn.length} 个 key：`)
  for (const key of missingEn) console.log(`  - ${key}`)
}
if (missingPrefixes.length > 0) {
  failed = true
  console.log(`\nFAIL 前缀式 key 在 zh 里无任何匹配：`)
  for (const prefix of missingPrefixes) console.log(`  - ${prefix}*`)
}
if (zhEnDiff.length > 0) {
  failed = true
  console.log(`\nFAIL zh/en 不对称 ${zhEnDiff.length} 处：`)
  for (const item of zhEnDiff) console.log(`  - ${item}`)
}

if (failed) {
  console.log('\nFAILED')
  process.exit(1)
}
console.log('\nPASSED 字典完整、zh/en 对称')
