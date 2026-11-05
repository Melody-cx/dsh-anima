#!/usr/bin/env node
// 回填已采纳记忆的类型 / 复核点。
//
// 为什么要有这个脚本而不是手点设置页：
//   21 条记忆逐条点 = 21 次请求、21 次写盘、21 次提示词重注册；中途出错还会留下
//   「一半有条目有一半没有」的状态，而用户只看到一句失败提示，不知道改到哪儿了。
//   脚本先算差异、再一次性批量提交、最后逐条回执。
//
// 为什么必须打活着的宿主（--url）而不是直接改 anima.json：
//   运行中的宿主把记忆缓存在内存里，直接改文件会被下一次写盘整个覆盖回去。
//   改介质只有一条路：走宿主自己的接口。
//
// 用法：
//   node scripts/backfill-types.mjs --dry-run            # 只看要改什么，不写
//   node scripts/backfill-types.mjs --apply              # 真写
//   node scripts/backfill-types.mjs --apply --url http://127.0.0.1:54537
//
// 退出码：0 = 无事可做或全部成功 / 1 = 有失败项 / 2 = 参数或连接错误

import { request as httpRequest } from 'node:http'

const DEFAULT_URL = 'http://127.0.0.1:54537'

// 分类依据（写在这里，是因为下一个人改这张表时得知道当初为什么这么分）：
//   fact       —— 客观可核对、会随时间失效（水平、环境、路径、平台规则）
//   preference —— 相处约定与雷区，半衰期很长，改了要用户自己说
//   stance     —— 用户对某件具体事的态度，改主意时归档成「曾如此」
//   event      —— 发生过的事，永不失效但会归档
//
// 这张表里刻意没有 stance 与 event：这 21 条全是「长期成立的东西」与「我的处境」，
// 没有一条是「他对某个具体争议的立场」，也没有一条是「某天发生了什么」。这不是
// 分类失败，而是这批数据的真实形状 —— 值得记下来，因为它说明 stance/event 两类
// 在真实使用里至今是空转的。
const PLAN = [
  { match: '重启 DSH', type: 'preference', why: '这是约定的操作方式，不是客观事实；哪天他说「你可以自己重启了」就是改主意' },
  { match: '学习方向', type: 'fact', verifyAt: '2027-04-30', why: '方向会变；到期不问就成了「一直在学安全」的过期推断' },
  { match: '数学基础', type: 'fact', verifyAt: '2027-04-30', why: '水平会变，补完就过期' },
  { match: '硬缺口', type: 'fact', verifyAt: '2027-01-31', why: '缺口补上就过期，这条最容易变成「他一直不会 PyTorch」的陈旧判断' },
  { match: '难度校准', type: 'fact', verifyAt: '2027-01-31', why: '对水平的判断，同样会过时' },
  { match: '补天', type: 'fact', verifyAt: '2027-04-30', why: '平台规则是客观的，但会改' },
  { match: '语气判据', type: 'preference', why: '怎么写东西的约定，长期有效' },
  { match: '评估/分析类问题', type: 'preference', why: '回答形式的约定' },
  { match: '需要拍板的事项', type: 'preference', why: '回答结构的约定' },
  { match: '明确不喜欢', type: 'preference', why: '雷区清单' },
  { match: '安装路径偏好', type: 'preference', why: '做事方式的偏好' },
  { match: 'C/C++ 工具链', type: 'fact', why: '机器事实，路径变了才失效' },
  { match: '本机 shell', type: 'fact', verifyAt: '2027-04-30', why: '残缺是当前状态，工具补齐就过期' },
  { match: 'Python 环境', type: 'fact', verifyAt: '2027-04-30', why: '同上' },
  { match: '不许谎报检查结果', type: 'preference', why: '最高优先级的相处规则' },
  { match: '动手类任务执行完', type: 'preference', why: '行为边界，长期有效' },
  { match: '王在法下', type: 'preference', why: '制度性约定' },
  { match: '数据外传边界', type: 'preference', why: '硬约束' },
  { match: '知识库「兰台」', type: 'fact', verifyAt: '2027-04-30', why: '库根路径与入场协议，库搬家或改《典章》就过期' },
  { match: '超星学习通', type: 'fact', why: '平台行为是客观的；平台改判题规则时由他告知' },
  { match: '安全测试红线', type: 'preference', why: '硬约束' }
]

function argOf(name, fallback) {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] ?? fallback : fallback
}

const url = argOf('--url', DEFAULT_URL).replace(/\/+$/, '')
const dryRun = !process.argv.includes('--apply')

let hostname
let port
{
  const parsed = new URL(url)
  hostname = parsed.hostname
  port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
}

async function getJson(path, init = {}) {
  // 刻意用 node:http 而不是全局 fetch：
  // fetch（undici）会把连接留在 keep-alive 池里，脚本用 process.exit 收尾时
  // 与仍然挂着的 handle 撞上，Windows 上会直接以 libuv 断言崩溃退出
  // （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)）。
  // 崩溃发生在「已经写完并打完回执」之后，所以数据是好的、退出码是骗人的 ——
  // 而任何一个用退出码判断成败的调用方都会把它读成失败。用无 keep-alive 的
  // 请求，让事件循环自己走空，退出码才可信。
  const body = init.body === undefined ? undefined : String(init.body)
  const payload = await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: hostname,
        port,
        path,
        method: init.method ?? 'GET',
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
        },
        agent: false
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }))
      }
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })

  let parsed
  try {
    parsed = JSON.parse(payload.text)
  } catch {
    throw new Error(`${path} 返回的不是 JSON（HTTP ${payload.status}）：${payload.text.slice(0, 200)}`)
  }
  if (payload.status < 200 || payload.status >= 300) {
    throw new Error(`${path} HTTP ${payload.status}：${parsed?.error ?? payload.text.slice(0, 200)}`)
  }
  return parsed
}

function sameValue(a, b) {
  // 缺席与空串在介质里是两种状态，在这里按「都没值」处理即可 —— 我们只关心要不要写。
  return (a ?? '') === (b ?? '')
}

const state = await getJson('/api/anima/state')
const adopted = state?.memories?.adopted ?? []
if (adopted.length === 0) {
  console.log('已采纳记忆为空，没有可回填的东西。')
  process.exit(0)
}

const unmatched = [...adopted]
const planned = []
const missing = []

for (const rule of PLAN) {
  const idx = unmatched.findIndex((m) => String(m.text ?? '').includes(rule.match))
  if (idx < 0) {
    missing.push(rule.match)
    continue
  }
  const record = unmatched.splice(idx, 1)[0]
  const changes = []
  if (!sameValue(record.type, rule.type)) changes.push(`type ${record.type ?? '(无)'} → ${rule.type}`)
  if (rule.verifyAt && !sameValue(record.verifyAt, rule.verifyAt)) changes.push(`verifyAt ${record.verifyAt ?? '(无)'} → ${rule.verifyAt}`)
  planned.push({ id: record.id, text: String(record.text ?? '').slice(0, 34), type: rule.type, verifyAt: rule.verifyAt, changes, why: rule.why })
}

// 没被任何规则命中的条目也必须打出来：静默跳过等于「这条我处理了」的假象。
const leftover = unmatched.map((m) => ({ id: m.id, text: String(m.text ?? '').slice(0, 34) }))

console.log(`宿主：${url}`)
console.log(`已采纳 ${adopted.length} 条；规则命中 ${planned.length} 条；未命中 ${leftover.length} 条\n`)

const todo = planned.filter((p) => p.changes.length > 0)
console.log(`需要改动的 ${todo.length} 条：`)
for (const p of todo) {
  console.log(`  ${p.id}`)
  console.log(`    ${p.text}`)
  console.log(`    ${p.changes.join('；')}`)
  console.log(`    理由：${p.why}`)
}
const settled = planned.filter((p) => p.changes.length === 0)
if (settled.length > 0) {
  console.log(`\n已经是对的 ${settled.length} 条（不重写）：`)
  for (const p of settled) console.log(`  ${p.id}  ${p.type}  ${p.text}`)
}
if (leftover.length > 0) {
  console.log(`\n没有被任何规则命中的 ${leftover.length} 条（需要人工判断，脚本不猜）：`)
  for (const p of leftover) console.log(`  ${p.id}  ${p.text}`)
}
if (missing.length > 0) {
  console.log(`\n规则里写了、但介质里找不到对应条目的 ${missing.length} 条：${missing.join('；')}`)
}

if (todo.length === 0) {
  console.log('\n没有需要写的东西。')
  process.exit(0)
}

if (dryRun) {
  console.log('\n（--dry-run：以上只是预览，一个字节都没写。加 --apply 才真写。）')
  process.exit(0)
}

const items = todo.map((p) => ({ id: p.id, type: p.type, ...(p.verifyAt ? { verifyAt: p.verifyAt } : {}) }))
const result = await getJson('/api/anima/memory/meta/batch', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ items })
})

const failed = (result.results ?? []).filter((r) => !r.ok)
console.log(`\n提交 ${result.total} 条，实际写盘 ${result.written} 条，失败 ${failed.length} 条。`)
for (const r of failed) console.log(`  失败 ${r.id}：${r.error}`)

// 写完必须回读核对 —— 只看「POST 返回 200」等于信自己。
const after = await getJson('/api/anima/state')
const byId = new Map((after?.memories?.adopted ?? []).map((m) => [m.id, m]))
let mismatch = 0
for (const p of todo) {
  const now = byId.get(p.id)
  if (!now) {
    console.log(`  回读丢失 ${p.id}`)
    mismatch += 1
    continue
  }
  if (!sameValue(now.type, p.type) || (p.verifyAt && !sameValue(now.verifyAt, p.verifyAt))) {
    console.log(`  回读不一致 ${p.id}：期望 ${p.type}/${p.verifyAt ?? '-'}，实得 ${now.type ?? '(无)'}/${now.verifyAt ?? '-'}`)
    mismatch += 1
  }
}
console.log(mismatch === 0 ? '回读核对：全部一致。' : `回读核对：${mismatch} 条不一致。`)

// 这份脚本能证明「字段写进去了」，不能证明「分类分对了」—— 后者只有用户能判。
console.log('（本脚本只核对字段是否落盘，不判断分类是否正确。）')
process.exit(failed.length === 0 && mismatch === 0 ? 0 : 1)
