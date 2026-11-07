#!/usr/bin/env node
// 用真实语料验证 lib/retrospect.mjs 的判据命中率。只读，不写任何记忆库。
//
// 用法：
//   node scripts/probe-retrospect.mjs             # 全部会话
//   node scripts/probe-retrospect.mjs --days 7    # 只看最近 7 天
//
// 这个脚本存在的意义：判据表里的每一条阈值都是量出来的。谁想改正则，
// 先跑它看假阳性有没有变多 —— 不要凭"这样更像人话"就改。
import { listSessionFiles, readSessionEvents, toLeadEvents, isSubagentSession, hasZstdSupport, sessionsRoot } from './zstd-frames.mjs'
import { extractLeads, LEAD_KINDS } from '../lib/retrospect.mjs'

const argOf = (name, fallback) => {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] ?? fallback : fallback
}

if (!hasZstdSupport()) {
  console.error('这个 Node 不支持 zlib.zstdDecompressSync，无法读取会话日志。')
  console.error(`当前版本：${process.version}（需要 Node 22.19+ / 24+）`)
  process.exit(2)
}

const days = Number(argOf('--days', '0'))
const sinceMs = Number.isFinite(days) && days > 0 ? Date.now() - days * 86400000 : 0

const root = sessionsRoot()
const { files, rootExists, error } = listSessionFiles({ root, sinceMs })
if (!rootExists) {
  console.error(error)
  process.exit(2)
}

let rawMessages = 0
let realMessages = 0
const kindCount = Object.fromEntries(LEAD_KINDS.map((k) => [k, 0]))
const allLeads = []
let subagentSessions = 0
let mainSessions = 0
let failedFrames = 0

for (const entry of files) {
  let events
  try {
    const read = readSessionEvents(entry.file)
    events = read.events
    failedFrames += read.failedFrames
  } catch { continue }
  if (isSubagentSession(events)) {
    // subagent 会话里 source.kind 也是 'user'，但那些「用户发言」是父 agent 派活时
    // 写的任务书，不是人说的。整会话跳过。
    subagentSessions += 1
    continue
  }
  mainSessions += 1
  const leadEvents = toLeadEvents(events)
  rawMessages += leadEvents.length
  const sessionRef = entry.file.slice(root.length + 1).replace(/\\/g, '/').replace(/\/session\.v4\.jsonl\.zstd$/, '')
  const r = extractLeads({ events: leadEvents, maxLeads: 999, sessionRef })
  realMessages += r.scanned
  for (const lead of r.leads) {
    kindCount[lead.kind] += 1
    allLeads.push(lead)
  }
}

console.log(`会话目录：${root}`)
console.log(`会话文件 = ${files.length}（主 ${mainSessions} / subagent ${subagentSessions}）` + (sinceMs > 0 ? `，只看最近 ${days} 天` : ''))
console.log(`user/message 原始条数 = ${rawMessages}`)
console.log(`通过 isRealUserText 的真实发言 = ${realMessages}`)
console.log(`解压失败帧 = ${failedFrames}` + (failedFrames > 0 ? '（这部分内容不可见，统计不完整）' : ''))
console.log(`总线索数 = ${allLeads.length}`)
console.log('按类型：', JSON.stringify(kindCount))

console.log('\n=== 全部线索（按时间） ===')
const sorted = [...allLeads].sort((a, b) => String(a.at).localeCompare(String(b.at)))
for (const lead of sorted) {
  console.log(`[${lead.at}] (${lead.kind}) ${lead.text.replace(/\n/g, ' ')}\n    ← ${lead.sessionRef} seq=${lead.seq}`)
}
