// 量一件事：质检钩子发出的提醒，到底有没有改变我下一句话的写法。
//
// 为什么这个脚本必须存在：README 里写着「提醒实测没有效果」并举了
// 「有提醒 8/13 = 62%、无提醒 14/24 = 58%」这两个数。一个被写进文档的数字，
// 如果没有任何可复跑的东西能重新算出来，它就只是我的说法，不是证据。
//
// 正确口径（这是第三版，前两版都错了）：
//   分母只能包含「本来就该写对账块的回答」——即剥离代码块与被引用的说法后，
//   仍然命中对账触发档的回答。其余回答本就不该写块，把它们算进分母，
//   得到的是分母差，不是提醒的效果。
//
// 前两版错在哪（留着，免得下次又犯）：
//   ① 拿「提醒后的回答」比「其余全部回答」——其余多数本来就不该写块，
//      比值必然偏高。这是分母造的假象。
//   ② 用 checkResponse 判出的 R02 当「本该有块」的条件——循环论证。
//      R02 的定义就是「该有块却没有块」，这个集合里永远算不出「有块」，
//      结果必然是 0%。
//
// 局限（必须写出来，否则读数会被过度解读）：
//   - 时间邻近不等于因果。这个脚本只能否掉「完全没用」，证不了「有用」。
//   - 「写了对账块」不等于「写对了」。它只证明形状变了，不证明内容有用。
//   - 样本很小，会话每长一点比例就会抖。别拿小数点后一位当真。
//
// 用法：node scripts/remind-effect.mjs [会话文件路径]
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const SESSIONS_ROOT = path.join(process.env.USERPROFILE ?? 'C:\\Users\\10933', '.dsh', 'sessions')
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const QUALITY_MARK = '[dsh-anima 质检]'

/** 会话日志是「每行一个 zstd 帧」，必须按魔数切帧逐帧解压。 */
function readEvents(file) {
  const raw = fs.readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= raw.length; i += 1) {
    if (raw[i] === ZSTD_MAGIC[0] && raw[i + 1] === ZSTD_MAGIC[1]
      && raw[i + 2] === ZSTD_MAGIC[2] && raw[i + 3] === ZSTD_MAGIC[3]) starts.push(i)
  }
  const events = []
  for (let k = 0; k < starts.length; k += 1) {
    const begin = starts[k]
    const end = k + 1 < starts.length ? starts[k + 1] : raw.length
    let text
    try { text = zlib.zstdDecompressSync(raw.subarray(begin, end)).toString('utf8') } catch { continue }
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try { events.push(JSON.parse(t)) } catch { /* 半行 */ }
    }
  }
  return events
}

function findLatestSession() {
  const candidates = []
  for (const bucket of fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    const bucketPath = path.join(SESSIONS_ROOT, bucket.name)
    for (const dir of fs.readdirSync(bucketPath, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const f = path.join(bucketPath, dir.name, 'session.v4.jsonl.zstd')
      if (fs.existsSync(f)) candidates.push({ file: f, mtime: fs.statSync(f).mtimeMs })
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0]?.file ?? null
}

/** 正文在 data.message.content；早期事件可能放在 data.content。 */
function textOf(ev) {
  const out = []
  const grab = (blocks) => {
    if (!Array.isArray(blocks)) return
    for (const b of blocks) if (b?.type === 'text' && typeof b.text === 'string') out.push(b.text)
  }
  grab(ev?.data?.message?.content)
  if (out.length === 0) grab(ev?.data?.content)
  return out.join('\n').trim()
}

function kindOf(ev) {
  return String(ev?.data?.message?.source?.kind ?? ev?.data?.source?.kind ?? '')
}

const qualityPath = path.join(import.meta.dirname, '..', 'lib', 'quality.mjs')
const q = await import(new URL(`file://${qualityPath.replace(/\\/g, '/')}`).href)

const file = process.argv[2] ?? findLatestSession()
if (!file) { console.error('找不到会话文件'); process.exit(2) }
const events = readEvents(file)
const norm = events.map((e, i) => ({ e, i }))

const reminderIdx = norm
  .filter(({ e }) => e?.type === 'user/message' && kindOf(e).includes('anima') && textOf(e).includes(QUALITY_MARK))
  .map(({ i }) => i)

const answers = norm.filter(({ e }) => e?.type === 'assistant/message' && textOf(e).length >= 200)

/**
 * 与钩子一致的「该不该写块」：触发只看 claimed。
 * 必须同时走 stripCodeBlocks 和 stripMentions，否则反引号里的数字
 * 会被当成断言 —— 这是第一版探针的错。
 */
function needsBlock(text) {
  const prose = q.stripCodeBlocks(text)
  const claimed = q.stripMentions(prose)
  return q.detectLedgerTriggers(claimed, 'three').needed
}

const withNotice = { total: 0, ok: 0 }
const withoutNotice = { total: 0, ok: 0 }
let prevIdx = -1
const rows = []
for (const { e, i } of answers) {
  const text = textOf(e)
  const hadReminder = reminderIdx.some((ri) => ri > prevIdx && ri < i)
  prevIdx = i
  if (!needsBlock(text)) continue
  const withBlock = q.hasLedgerBlock(text)
  const bucket = hadReminder ? withNotice : withoutNotice
  bucket.total += 1
  if (withBlock) bucket.ok += 1
  rows.push({ seq: e.seq, chars: text.length, hadReminder, withBlock })
}

const pct = (b) => (b.total === 0 ? 'n/a（0 条）' : `${b.ok} / ${b.total} = ${(b.ok / b.total * 100).toFixed(0)}%`)
console.log(`会话：${path.basename(path.dirname(file))}`)
console.log('分母：只含「触发了对账档」的回答（剥掉代码块与引用后仍命中）')
console.log('')
console.log(`有质检提醒在前：写了块 ${pct(withNotice)}`)
console.log(`无质检提醒在前：写了块 ${pct(withoutNotice)}`)
console.log('')
if (withNotice.total && withoutNotice.total) {
  const d = (withNotice.ok / withNotice.total) - (withoutNotice.ok / withoutNotice.total)
  console.log(`差值：${(d * 100).toFixed(0)} 个百分点（正 = 提醒后更容易写块）`)
}
console.log('')
console.log('明细：')
for (const r of rows) {
  console.log(`  seq=${r.seq}（${r.chars} 字）｜提醒：${r.hadReminder ? '有' : '无'}｜块：${r.withBlock ? '有' : '无'}`)
}
console.log('')
console.log('记住：时间邻近不等于因果；「写了块」不等于「写对了」；样本小，比例会抖。')
