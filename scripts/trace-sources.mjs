#!/usr/bin/env node
// 追踪每条已采纳记忆的出处，并把结果写回 sourceRef。
//
// 为什么需要它：remember 工具允许 sourceRef 留空，而「没有来源的记忆日后无法核对真假」。
// 21 条旧记忆的 sourceRef 全是空的，这个脚本负责把能查的查出来、查不到的如实标成不可考。
//
// 判据（三档，强度递减）：
//   用户原话   —— 你本人在某条 user/message 里说过同样的话
//   助手转述   —— 只在我（assistant/message）的答复里找到，没找到你的原话
//   来源不可考 —— 全部会话日志里都没有可核对的原文
//
// 「说过同样的话」怎么判：不用整串精确匹配，因为记忆库里存的是我改写过、
// 压缩过、加了标点的版本，跟原话不可能逐字相同 —— 精确匹配只会把真正的
// 出处判成「不可考」，那是最坏的一种错。
// 这里改用「最长公共子串」：先按 6 字切片做候选筛选，再对候选算精确的
// 最长公共子串长度。阈值取 10 字 —— 10 个字连续相同，基本排除巧合。
//
// 必须排除的两类命中（这是关键，否则全是假阳性）：
//   · system/message —— 那是提示词快照，anima 自己把记忆注入回去，等于回声
//   · plugin:* 来源   —— 插件注入的提醒，不是谁说的话
//
// 用法：
//   node scripts/trace-sources.mjs                 # 只看，不写
//   node scripts/trace-sources.mjs --apply         # 真写进 sourceRef
//   node scripts/trace-sources.mjs --apply --url http://127.0.0.1:PORT
//
// 退出码：0 = 全部处理完 / 1 = 有写失败或回读不一致 / 2 = 参数或连接错误

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { request as httpRequest } from 'node:http'
import { readSessionEvents } from './zstd-frames.mjs'

const SESSIONS_ROOT =
  process.env.DSH_SESSIONS_DIR ?? path.join(os.homedir(), '.dsh', 'sessions')

function argOf(name, fallback) {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] ?? fallback : fallback
}

// 不猜端口：宿主每次启动的端口是随机的。写死一个默认值，脚本会安静地连到
// 上一个或别的进程，然后把那份数据当成当前这次的写进 sourceRef。
const rawUrl = argOf('--url', '')
if (rawUrl === '') {
  console.error('用法：node scripts/trace-sources.mjs [--apply] --url http://127.0.0.1:PORT')
  console.error('（端口请从宿主启动日志或 Web GUI 地址里取，本脚本不提供默认值。）')
  process.exit(2)
}
const url = rawUrl.replace(/\/+$/, '')
const apply = process.argv.includes('--apply')
const verbose = process.argv.includes('--verbose')

const parsedUrl = new URL(url)
const hostname = parsedUrl.hostname
const port = Number(parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80))

// 用 node:http 而不是全局 fetch：fetch 的 keep-alive 连接在 process.exit 时会
// 与仍挂着的 handle 撞上，Windows 上以 libuv 断言崩溃退出 —— 数据写完了、
// 退出码却是假的。无 keep-alive 让事件循环自己走空，退出码才可信。
async function getJson(pathname, init = {}) {
  const body = init.body === undefined ? undefined : String(init.body)
  const payload = await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname,
        port,
        path: pathname,
        method: init.method ?? 'GET',
        headers: body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        agent: false
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { data += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }))
      }
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
  let json
  try {
    json = JSON.parse(payload.text)
  } catch {
    throw new Error(`${pathname} 返回的不是 JSON（HTTP ${payload.status}）：${payload.text.slice(0, 200)}`)
  }
  if (payload.status < 200 || payload.status >= 300) {
    throw new Error(`${pathname} HTTP ${payload.status}：${json?.error ?? payload.text.slice(0, 200)}`)
  }
  return json
}

const squash = (s) => String(s ?? '').replace(/\s+/g, '')

// 最长公共子串长度。只用来判「够不够像同一句话」，不参与任何语义判断。
function longestCommon(a, b) {
  if (a === '' || b === '') return 0
  const n = a.length
  const m = b.length
  let best = 0
  let prev = new Uint16Array(m + 1)
  let cur = new Uint16Array(m + 1)
  for (let i = 1; i <= n; i++) {
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= m; j++) {
      if (ca === b.charCodeAt(j - 1)) {
        const v = prev[j - 1] + 1
        cur[j] = v
        if (v > best) best = v
      } else {
        cur[j] = 0
      }
    }
    const tmp = prev
    prev = cur
    cur = tmp
    cur.fill(0)
  }
  return best
}

// 出处强度阈值：连续 10 个字相同才算「这句话有据可查」。
// 取 10 是因为中文 10 字已经足够长，几乎不可能是两个不同意思的巧合；
// 而取 6~8 会让「不自行延长流程」这种常用搭配到处命中。
const LCS_THRESHOLD = 10

// 只收「人说过的话」。system/message 与 plugin:* 一律不算 —— 前者是注入回声，
// 后者是插件自己的提醒。把这两类算进出处，等于让记忆自己给自己作证。
function spoken(event) {
  const type = event?.type
  if (type !== 'user/message' && type !== 'assistant/message') return null
  const data = event.data ?? {}
  const kind = String(data.source?.kind ?? data.message?.source?.kind ?? '')
  if (kind.startsWith('plugin:') || kind === 'system-prompt' || kind === 'skill-catalog' || kind === 'time-context' || kind === 'runtime-context') {
    return null
  }
  const parts = []
  const push = (content) => {
    for (const block of content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  if (data.message) push(data.message.content)
  push(data.content)
  const text = parts.join('\n')
  if (text.trim() === '') return null
  return { text: squash(text), who: type === 'user/message' ? 'user' : 'assistant' }
}

function readSession(file) {
  // 分帧与解压见 scripts/zstd-frames.mjs —— 这段逻辑原本在三个脚本里逐字重复。
  return readSessionEvents(file).events
}

function listSessions() {
  const out = []
  if (!fs.existsSync(SESSIONS_ROOT)) return out
  for (const bucket of fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    const bp = path.join(SESSIONS_ROOT, bucket.name)
    for (const dir of fs.readdirSync(bp, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const file = path.join(bp, dir.name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(file)) continue
      out.push({ id: dir.name, file, mtime: fs.statSync(file).mtimeMs })
    }
  }
  out.sort((a, b) => a.mtime - b.mtime)
  return out
}

async function main() {
  const state = await getJson('/api/anima/state')
  const adopted = state?.memories?.adopted ?? []
  if (adopted.length === 0) {
    console.log('没有已采纳记忆，无事可做。')
    return 0
  }
  console.log(`已采纳记忆 ${adopted.length} 条；会话目录 ${SESSIONS_ROOT}`)

  const probes = adopted.map((m) => {
    const full = squash(m.text)
    return {
      id: m.id,
      source: m.source,
      current: m.sourceRef,
      text: m.text,
      compact: full
    }
  })

  const sessions = listSessions()
  if (sessions.length === 0) {
    console.log('找不到任何会话日志，无法追踪出处。')
    return 2
  }

  const found = new Map()
  for (const s of sessions) {
    let events
    try {
      events = readSession(s.file)
    } catch {
      continue
    }
    for (const event of events) {
      const got = spoken(event)
      if (!got) continue
      for (const p of probes) {
        // 先用 6 字切片做廉价筛（子串命中才有可能是同一句话），再算精确 LCS。
        // 只做 LCS 会把每个会话都算一遍，21 条 × 上百条事件 × 27 个文件太慢。
        const sample = p.compact.slice(0, 6)
        if (sample.length < 6 || !got.text.includes(sample)) {
          // 开头六个字没命中时，退一步用中间一段再筛一次
          const mid = p.compact.slice(Math.floor(p.compact.length / 3), Math.floor(p.compact.length / 3) + 6)
          if (mid.length < 6 || !got.text.includes(mid)) continue
        }
        const score = longestCommon(p.compact, got.text)
        if (score < LCS_THRESHOLD) continue
        if (!found.has(p.id)) found.set(p.id, [])
        const list = found.get(p.id)
        if (list.some((h) => h.session === s.id && h.seq === event.seq)) continue
        list.push({ who: got.who, session: s.id, seq: event.seq, score })
      }
    }
  }
  console.log(`扫描 ${sessions.length} 个会话文件完成（阈值：连续 ${LCS_THRESHOLD} 字相同）`)

  const rows = []
  let nUser = 0
  let nAsst = 0
  let nNone = 0
  console.log('\n=== 逐条出处 ===')
  for (const p of probes) {
    const list = (found.get(p.id) ?? []).slice().sort((a, b) => a.seq - b.seq)
    const userHits = list.filter((h) => h.who === 'user')
    const asstHits = list.filter((h) => h.who === 'assistant')
    let verdict
    let ref
    if (userHits.length > 0) {
      verdict = '用户原话'
      ref = `用户原话@${userHits[0].session}#seq=${userHits[0].seq}`
      nUser++
    } else if (asstHits.length > 0) {
      verdict = '助手转述'
      ref = `助手转述@${asstHits[0].session}#seq=${asstHits[0].seq}（未找到你的原话）`
      nAsst++
    } else {
      verdict = '不可考'
      ref = '来源不可考（全部会话日志里没有可核对的原文）'
      nNone++
    }
    rows.push({ id: p.id, verdict, sourceRef: ref, current: p.current, text: p.text })
    console.log(`${verdict}  ${p.id}`)
    console.log(`        ${ref}`)
    if (verbose) console.log(`        ${squash(p.text).slice(0, 44)}`)
  }
  console.log(`\n合计：用户原话 ${nUser} / 助手转述 ${nAsst} / 不可考 ${nNone}`)

  // 已经有 sourceRef 且与新算出来的一致，就不重写
  const todo = rows.filter((r) => (r.current ?? '') !== r.sourceRef)
  if (todo.length === 0) {
    console.log('\n所有条目的 sourceRef 都已是目标值，没有要写的东西。')
    return 0
  }

  if (!apply) {
    console.log(`\n（--dry-run：将写 ${todo.length} 条，一个字节都没写。加 --apply 才真写。）`)
    return 0
  }

  const result = await getJson('/api/anima/memory/meta/batch', {
    method: 'POST',
    body: JSON.stringify({ items: todo.map((r) => ({ id: r.id, sourceRef: r.sourceRef })) })
  })
  const failed = (result.results ?? []).filter((r) => !r.ok)
  console.log(`\n提交 ${result.total} 条，实际写盘 ${result.written} 条，失败 ${failed.length} 条。`)
  for (const r of failed) console.log(`  失败 ${r.id}：${r.error}`)

  // 写完回读核对 —— 只看 POST 返回 200 等于信自己。
  const after = await getJson('/api/anima/state')
  const byId = new Map((after?.memories?.adopted ?? []).map((m) => [m.id, m]))
  let mismatch = 0
  for (const r of todo) {
    const now = byId.get(r.id)
    if (!now) {
      console.log(`  回读丢失 ${r.id}`)
      mismatch++
      continue
    }
    if ((now.sourceRef ?? '') !== r.sourceRef) {
      console.log(`  回读不一致 ${r.id}：期望「${r.sourceRef}」，实得「${now.sourceRef ?? '(无)'}」`)
      mismatch++
    }
  }
  console.log(mismatch === 0 ? '回读核对：全部一致。' : `回读核对：${mismatch} 条不一致。`)
  console.log('（本脚本只核对 sourceRef 是否落盘，不判断它读起来是否合理。）')
  return failed.length === 0 && mismatch === 0 ? 0 : 1
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    console.error(`失败：${err.message}`)
    process.exitCode = 2
  })
