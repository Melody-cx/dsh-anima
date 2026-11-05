// scripts/audit-response.mjs — 回答质检器（命令行入口）
//
// 用法（三种输入，任选其一）：
//   node scripts/audit-response.mjs --text-file reply.txt
//   node scripts/audit-response.mjs --text "……"
//   node scripts/audit-response.mjs --stdin            （从管道读）
//
// 选项：
//   --strict      启用 R08 / R11 / R12（误报率高，默认关）
//   --ledger=off|three|five   对账档位，默认 three
//   --json        输出 JSON（给别的程序吃）
//
// 退出码：0 没有 high 级问题；1 有；2 用法错误。
//
// 这个脚本的立场：它是**给人用的**，不是给我自己用的。我调用它 = 自检，
// 而自检的结论不能由被检查者签发。所以插件内部不会调用它。
//
// 它输出的每一条都带规则号 + 原文摘录，便于你直接对照原文判断真假：
// 它不写「通过」，只写「这次检查了哪些、没查哪些」。

import { readFile } from 'node:fs/promises'
import { checkResponse, QUALITY_RULES, UNCOVERABLE_RULES } from '../lib/quality.mjs'

const argv = process.argv.slice(2)

function argValue(name) {
  const hit = argv.find((a) => a === name || a.startsWith(`${name}=`))
  if (!hit) return null
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1)
  const i = argv.indexOf(hit)
  return argv[i + 1] ?? null
}

const hasFlag = (name) => argv.includes(name)

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const ledgerRaw = argValue('--ledger') ?? 'three'
  const ledgerLevel = ['off', 'three', 'five'].includes(ledgerRaw) ? ledgerRaw : 'three'
  const strict = hasFlag('--strict')
  const asJson = hasFlag('--json')

  let text = null
  if (hasFlag('--stdin')) text = await readStdin()
  else if (argValue('--text-file')) text = await readFile(argValue('--text-file'), 'utf8')
  else if (argValue('--text')) text = argValue('--text')
  else {
    console.error('用法：node scripts/audit-response.mjs [--text-file 文件 | --text "文本" | --stdin] [--strict] [--ledger=off|three|five] [--json]')
    process.exitCode = 2
    return
  }

  const result = checkResponse(text, { ledgerLevel, strict: strict || undefined })

  if (asJson) {
    console.log(JSON.stringify({ ...result, text }, null, 2))
    process.exitCode = result.findings.length > 0 ? 1 : 0
    return
  }

  const lines = []
  lines.push(`字数：${result.meta.chars}`)
  lines.push(`对账档位：${ledgerLevel}${strict ? '（严格模式）' : ''}`)
  lines.push('')
  if (result.meta.triggers.length > 0) {
    lines.push('命中对账触发：')
    for (const hit of result.meta.triggers) lines.push(`  - [${hit.tier}] ${hit.name}｜…${hit.excerpt}…`)
  } else {
    lines.push('命中对账触发：无')
  }
  lines.push('')
  if (result.findings.length === 0) {
    lines.push('可机械判定的项目：未发现问题。')
  } else {
    lines.push(`发现 ${result.findings.length} 处：`)
    for (const f of result.findings) {
      lines.push(`  [${f.ruleId} ${f.name}] ${f.detail}`)
      lines.push(`      原文：…${String(f.excerpt ?? '').slice(0, 80)}…`)
    }
  }
  lines.push('')
  lines.push(`本次检查了：${result.checked.join('、')}`)
  const un = QUALITY_RULES.filter((r) => result.uncovered.includes(r.id))
  lines.push(`本次未查：${un.length === 0 ? '无' : un.map((r) => `${r.id} ${r.name}（${r.catchMode === 'human' ? '机器判不了' : '本档位未启用'}）`).join('、')}`)
  lines.push('')
  lines.push(`注意：机器判不了的永远有 ${UNCOVERABLE_RULES.join('、')} 这 ${UNCOVERABLE_RULES.length} 条，别把这份输出当成「十二条全过」。`)

  console.log(lines.join('\n'))
  process.exitCode = result.findings.length > 0 ? 1 : 0
}

await main()
