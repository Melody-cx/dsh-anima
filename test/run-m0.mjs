// test/run-m0.mjs —— 跑 M0 十二条样例
//
// 用法：node test/run-m0.mjs [--json]
// 退出码：0 全部可判定的样例都符合预期；1 有不符；2 用法错误。
//
// 三条不许违反的规则（写在这里是因为它们最容易被下一次修改破坏）：
//   1. 「机器判不了」的规则**不计入通过**，只计入「已固化形态 / 未验」。
//   2. 反例被误报同样算失败 —— 误报会让人把检查器整个关掉。
//   3. 汇总里必须出现真实数字；没有数字的「全部通过」这句话，本身就是 R02。

import { checkResponse, QUALITY_RULES } from '../lib/quality.mjs'
import { M0_CASES } from './fixtures/m0-rules.mjs'

const STRICT_RULES = new Set(['R08', 'R11', 'R12'])
const HUMAN_RULES = new Set(QUALITY_RULES.filter((r) => r.catchMode === 'human').map((r) => r.id))

const results = M0_CASES.map((c) => {
  const strict = STRICT_RULES.has(c.ruleId)
  const out = checkResponse(c.text, { ledgerLevel: 'three', strict })
  const hit = out.findings.some((f) => f.ruleId === c.ruleId)
  const verifiable = !HUMAN_RULES.has(c.ruleId)
  const ok = !verifiable ? null : hit === c.shouldCatch
  return {
    id: c.id,
    ruleId: c.ruleId,
    note: c.note,
    shouldCatch: c.shouldCatch,
    caught: hit,
    verifiable,
    ok,
    findings: out.findings.map((f) => `${f.ruleId}: ${f.detail}`)
  }
})

const verifiable = results.filter((r) => r.verifiable)
const passed = verifiable.filter((r) => r.ok === true)
const failed = verifiable.filter((r) => r.ok === false)
const unverified = results.filter((r) => !r.verifiable)

const ruleStats = QUALITY_RULES.map((rule) => {
  const rows = results.filter((r) => r.ruleId === rule.id)
  const v = rows.filter((r) => r.verifiable)
  return {
    ruleId: rule.id,
    name: rule.name,
    catchMode: rule.catchMode,
    cases: rows.length,
    passed: v.filter((r) => r.ok === true).length,
    failed: v.filter((r) => r.ok === false).length,
    status: summarizeStatus(v)
  }
})

// 汇总状态：没有可验用例时不能说「通过」，也不能说「失败」——那是机器判不了。
function summarizeStatus(rows) {
  if (rows.length === 0) return '未验（机器判不了，仅固化形态）'
  return rows.every((r) => r.ok) ? '通过' : '失败'
}

function tagOf(row) {
  if (!row.verifiable) return '·'
  return row.ok ? '✓' : '✗'
}

function detailOf(row) {
  if (!row.verifiable) return '未验（机器判不了）'
  if (row.ok) return row.shouldCatch ? '已抓到' : '未误报'
  return row.shouldCatch ? '漏报' : '误报'
}


if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ results, ruleStats }, null, 2))
} else {
  const lines = []
  lines.push('M0 十二条样例结果')
  lines.push('='.repeat(46))
  for (const row of results) {
    lines.push(`${tagOf(row)} ${row.id} [${row.ruleId}] ${detailOf(row)}  ${row.note}`)
  }
  lines.push('='.repeat(46))
  lines.push(`可判定样例：${verifiable.length} 个，通过 ${passed.length}，失败 ${failed.length}`)
  lines.push(`不可判定样例：${unverified.length} 个（R03 / R05 / R06 / R07 / R10）—— 它们不是通过，只是把形态固化下来了`)
  lines.push('')
  lines.push('按规则分类：')
  for (const s of ruleStats) lines.push(`  ${s.ruleId} ${s.name}｜${s.catchMode}｜${s.passed} 过 / ${s.failed} 败 / ${s.cases} 例｜${s.status}`)
  if (failed.length > 0) {
    lines.push('')
    lines.push('失败明细：')
    for (const f of failed) lines.push(`  ${f.id}: ${f.findings.length === 0 ? '（无任何发现）' : f.findings.join(' | ')}`)
  }
  console.log(lines.join('\n'))
}

process.exitCode = failed.length > 0 ? 1 : 0
