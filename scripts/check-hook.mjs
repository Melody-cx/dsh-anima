// 判定「质检钩子到底有没有真的跑过」——而不是靠「没有提醒」推断「没有问题」。
//
// 为什么需要这个脚本：钩子出故障时，用户看到的东西和一切正常时**一模一样**：
// 什么都没有。没有报错、没有提醒、没有日志。这两种状态必须能被分开，
// 否则「没查」就长得像「查过没事」，而这正是这套东西最该避免的错误。
//
// 用法：
//   node scripts/check-hook.mjs                  # 自动找最新的会话文件
//   node scripts/check-hook.mjs <session.v4.jsonl.zstd>
//   node scripts/check-hook.mjs --since 2026-10-20T01:12:20+08:00
//   node scripts/check-hook.mjs --url http://127.0.0.1:51590
//       加上 --url 会拿插件自报的 qualityStats 与本脚本从日志重算的结果交叉核对：
//       长度一致、规则一致，才说明钩子真的读到真实正文并判过，而不是空转。
//
// 退出码：0 = 没有反证；1 = 找到反证（该报未报，或计数器与日志对不上）；
//         2 = 参数/读取失败。
//
// 结论只分这几种，且都不许含混：
//   ALIVE       找到 anima 注入过的提醒 → 钩子确实在工作
//   RAN         没有注入，但计数器与日志交叉核对通过 → 钩子跑过、判过，这一刻确实没有该报的
//   DEAD        有该报的回答、时间在其后、却没有注入 → 钩子没工作
//   INCONSISTENT 计数器与日志对不上 → 计数不可信
//   UNDETERMINED 上述都不成立 → 这是未测状态，不是通过状态
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const SESSIONS_ROOT = path.join(process.env.USERPROFILE ?? 'C:\\Users\\10933', '.dsh', 'sessions')
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
// anima 注入的质检提醒正文都以这个前缀开头（见 lib/injection.mjs 的 qualityReminderText）。
// 用它区分「质检提醒」和「每晚整理已完成」这类与质检无关的后台通知。
const QUALITY_MARK = '[dsh-anima 质检]'

function parseArgs(argv) {
  const out = { file: null, since: 0, url: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--since') { out.since = Date.parse(argv[++i]); continue }
    if (a.startsWith('--since=')) { out.since = Date.parse(a.slice(8)); continue }
    if (a === '--url') { out.url = argv[++i]; continue }
    if (a.startsWith('--url=')) { out.url = a.slice(6); continue }
    if (!a.startsWith('--')) out.file = a
  }
  if (Number.isNaN(out.since)) throw new Error('--since 无法解析成时间')
  return out
}

/**
 * 会话文件是「每行一个 zstd 帧」的追加格式。
 * 直接 zstdDecompressSync 整个文件只会解出第一帧，得到一份看起来正常但残缺的事件表 ——
 * 这是踩过的坑，所以这里必须按魔数切帧。
 */
function readEvents(file) {
  const raw = fs.readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= raw.length; i += 1) {
    if (raw[i] === ZSTD_MAGIC[0] && raw[i + 1] === ZSTD_MAGIC[1]
      && raw[i + 2] === ZSTD_MAGIC[2] && raw[i + 3] === ZSTD_MAGIC[3]) starts.push(i)
  }
  const events = []
  let failedFrames = 0
  for (let k = 0; k < starts.length; k += 1) {
    const begin = starts[k]
    const end = k + 1 < starts.length ? starts[k + 1] : raw.length
    let text
    try {
      text = zlib.zstdDecompressSync(raw.subarray(begin, end)).toString('utf8')
    } catch {
      failedFrames += 1
      continue
    }
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try { events.push(JSON.parse(t)) } catch { /* 半行，跳过 */ }
    }
  }
  return { events, frames: starts.length, failedFrames }
}

function findLatestSession() {
  if (!fs.existsSync(SESSIONS_ROOT)) return null
  const candidates = []
  for (const bucket of fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    const bucketPath = path.join(SESSIONS_ROOT, bucket.name)
    for (const dir of fs.readdirSync(bucketPath, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const f = path.join(bucketPath, dir.name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      candidates.push({ file: f, mtime: fs.statSync(f).mtimeMs })
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0]?.file ?? null
}

function messageText(ev) {
  const collected = []
  const pushFrom = (blocks) => {
    if (!Array.isArray(blocks)) return
    for (const b of blocks) if (b?.type === 'text' && typeof b.text === 'string') collected.push(b.text)
  }
  // 真实形状是 data.message.content；简写形状 data.content 只在测试夹具里出现。
  pushFrom(ev?.data?.message?.content)
  if (collected.length === 0) pushFrom(ev?.data?.content)
  return collected.join('\n').trim()
}

function sourceKind(ev) {
  return String(ev?.data?.message?.source?.kind ?? ev?.data?.source?.kind ?? '')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const file = args.file ?? findLatestSession()
  if (!file) {
    console.error('找不到会话文件。DSH 的会话落在 ~/.dsh/sessions 下；如果从没用过，就还没有可检查的东西。')
    return 2
  }
  if (!fs.existsSync(file)) {
    console.error(`会话文件不存在：${file}`)
    return 2
  }

  const qualityPath = path.join(import.meta.dirname, '..', 'lib', 'quality.mjs')
  const quality = await import(new URL(`file://${qualityPath.replace(/\\/g, '/')}`).href)

  const { events, frames, failedFrames } = readEvents(file)

  // anima 会往会话里注入好几类消息，只有带质检标记的才说明钩子跑过。
  // 踩过的坑：第一版把所有 source.kind 含 'anima' 的消息都算成「提醒」，
  // 于是「每晚整理已完成」这类整理通知也让判定变 ALIVE ——
  // 一个跟质检毫无关系的后台通知，被当成了钩子存活的证据。
  const allInjected = events.filter((e) => e?.type === 'user/message' && sourceKind(e).includes('anima'))
  const injected = allInjected.filter((e) => messageText(e).includes(QUALITY_MARK))
  const otherInjected = allInjected.length - injected.length

  const answers = []
  for (const ev of events) {
    if (ev?.type !== 'assistant/message') continue
    const text = messageText(ev)
    if (!text) continue
    answers.push({ seq: ev.seq, time: ev.time, turn: ev?.data?.turn, text })
  }
  const scoped = args.since > 0
    ? answers.filter((a) => typeof a.time === 'number' && a.time >= args.since)
    : answers

  const violations = []
  for (const a of scoped) {
    const r = quality.checkResponse(a.text, { ledgerLevel: 'three', strict: true })
    if (r.findings.length) violations.push({ ...a, ruleIds: r.findings.map((f) => f.ruleId) })
  }

  const lines = []
  lines.push(`会话文件：${file}`)
  lines.push(`帧 ${frames}（解压失败 ${failedFrames}），事件 ${events.length}`)
  if (args.since > 0) lines.push(`只看 ${new Date(args.since).toISOString()} 之后的回答`)
  lines.push(`有正文的回答 ${scoped.length} 条，其中按判据该提醒的 ${violations.length} 条`)
  lines.push(`anima 实际注入过的质检提醒 ${injected.length} 条`)
  if (otherInjected > 0) {
    lines.push(`（另有 ${otherInjected} 条 anima 注入消息不是质检提醒——整理通知之类，不算证据）`)
  }

  const injectedAfter = args.since > 0
    ? injected.filter((e) => typeof e.time === 'number' && e.time >= args.since)
    : injected

  // 前面那行「anima 实际注入过的提醒 N 条」必须用**同一个口径**再报一次范围外数量。
  // 踩过的坑：那一行原本打的是全量 injected.length，而下面判定与交叉核对用的是
  // injectedAfter —— 于是同一个数量出现两个值（6 vs 4），读者第一反应是「计数器漏记了」，
  // 实际是脚本自己混了两个口径。数字不一致时，先怀疑统计口径，再怀疑被测对象。
  if (args.since > 0) {
    const outside = injected.length - injectedAfter.length
    lines.push(`（其中分界线之后 ${injectedAfter.length} 条${outside ? `，更早的 ${outside} 条不计` : ''}）`)
  }

  // 判据的"生效时刻"分界线。
  //
  // 这里必须说清一件事：按 --since 之外的历史回答算 `violations`，判 DEAD 是错的。
  // 那些回答写在钩子装好之前、甚至写在判据收紧之前 —— 它们本来就不该有提醒，
  // 因为当时这段代码还不存在于运行中的进程里。「过去有一条坏回答没有提醒」
  // 不能推出「钩子现在坏了」，就像不能用去年的体检报告证明今天在发烧。
  //
  // 所以 DEAD 只在**新增的坏回答**上成立：它们必须晚于分界线，
  // 而分界线是 `args.since`（用户给的重启时刻）或插件自报的启用时刻。
  // 两者都没有时，DEAD 不能下，只能落回 UNDETERMINED —— 未知不等于坏。
  const boundary = args.since > 0 ? args.since : null
  const freshViolations = boundary === null
    ? []
    : violations.filter((v) => typeof v.time === 'number' && v.time >= boundary)

  let verdict
  if (injectedAfter.length > 0) {
    verdict = 'ALIVE'
    lines.push('')
    lines.push('判定：ALIVE —— 钩子确实工作过，下面是它注入过的提醒：')
    for (const e of injectedAfter.slice(-3)) {
      lines.push(`  seq=${e.seq} turn=${e?.data?.turn}`)
      lines.push(`  ${messageText(e).slice(0, 240).replace(/\n/g, ' / ')}`)
    }
  } else if (freshViolations.length > 0) {
    verdict = 'DEAD'
    lines.push('')
    lines.push(`判定：DEAD —— 有 ${freshViolations.length} 条该报的回答写在分界线之后，却没有注入任何提醒。`)
    lines.push(`分界线：${new Date(boundary).toISOString()}（--since 给的时刻）`)
    for (const v of freshViolations.slice(-5)) {
      lines.push(`  seq=${v.seq} ${v.ruleIds.join(',')} ${v.text.slice(0, 120).replace(/\n/g, ' / ')}`)
    }
  } else if (violations.length > 0) {
    verdict = 'UNDETERMINED'
    lines.push('')
    lines.push(`判定：UNDETERMINED —— 有 ${violations.length} 条该报的回答，但它们都早于分界线，`)
    lines.push('不能拿来判钩子死活（它们写在代码生效之前，本来就不该有提醒）。')
    if (boundary === null) {
      lines.push('而且这次没给 --since，也就没有分界线可用 —— 请用 --since 传宿主重启时刻，')
      lines.push('或直接 --url 让脚本跟插件自报的计数器交叉核对。')
    }
    for (const v of violations.slice(-3)) {
      lines.push(`  （早于分界线，仅供参考）seq=${v.seq} ${v.ruleIds.join(',')} ${new Date(v.time).toISOString()}`)
    }
  } else {
    verdict = 'UNDETERMINED'
    lines.push('')
    lines.push('判定：UNDETERMINED —— 既没抓到注入，也没有该报未报。')
    lines.push('这不是「通过」。它只说明这段时间里没有可判的东西，')
    lines.push('所以此刻「一条提醒都没有」既不能证明钩子在跑，也不能证明它坏了。')
  }

  lines.push('')
  lines.push(`（本条结论由代码按固定正则算出，不经过模型。它判形状，不判内容对错。${quality.UNCOVERABLE_RULES.length} 条规则机器永远判不了：${quality.UNCOVERABLE_RULES.join('、')}。）`)

  // ==================== 与插件自报的计数交叉核对 ====================
  //
  // 只看日志有一种盲区：钩子「跑过但判了干净」和「压根没跑」在日志里都表现为
  // 「没有注入」。插件自己的 qualityStats 正好补上这块 —— 但它是被检查方自报的，
  // 不能单独采信。所以这里做的是**交叉核对**：
  //   计数器说「我检查了 seq=X，长度 L，判到 R01,R02」
  //   日志说     「seq=X 的正文长度是 L'，重算得到 R01,R02」
  // 两边对得上 → 它确实读到了真实数据并真的判了；对不上 → 计数器在编。
  if (args.url) {
    lines.push('')
    lines.push('=== 与插件自报计数交叉核对 ===')
    let stats = null
    try {
      const res = await fetch(`${args.url.replace(/\/$/, '')}/api/anima/state`)
      const body = await res.json()
      stats = body?.qualityStats ?? null
    } catch (err) {
      lines.push(`拿不到 ${args.url}/api/anima/state：${String(err?.message || err)}`)
    }
    if (!stats) {
      lines.push('运行中的宿主没有下发 qualityStats —— 说明跑的还是没有计数器的旧代码。')
    } else {
      lines.push(`插件自报：checks=${stats.checks}，reminders=${stats.reminders}，skipped=${JSON.stringify(stats.skipped ?? {})}`)
      const last = stats.last
      if (!last) {
        lines.push('计数器 checks>0 却没有 last 记录 —— 这本身就是个 bug。')
      } else {
        const ev = events.find((e) => e.seq === last.seq)
        if (!ev) {
          lines.push(`计数器说检查了 seq=${last.seq}，但日志里找不到这条事件 —— 对不上。`)
        } else {
          const realText = messageText(ev)
          const recomputed = quality.checkResponse(realText, { ledgerLevel: 'three', strict: true })
          const realIds = recomputed.findings.map((f) => f.ruleId).sort()
          const claimedIds = [...(last.findings ?? [])].sort()
          const lenOk = realText.length === last.chars
          const idsOk = JSON.stringify(realIds) === JSON.stringify(claimedIds)
          lines.push(`  seq=${last.seq}：日志正文 ${realText.length} 字 / 计数器报 ${last.chars} 字 → ${lenOk ? '长度一致' : '长度不一致'}`)
          lines.push(`  规则：重算 [${realIds.join(',') || '无'}] / 计数器报 [${claimedIds.join(',') || '无'}] → ${idsOk ? '一致' : '不一致'}`)
          if (lenOk && idsOk) {
            lines.push('  ⇒ 交叉核对通过：钩子确实读到了真实正文并按判据判过，不是空转。')
            if (verdict === 'UNDETERMINED') verdict = 'RAN'
          } else {
            // 真发生过一次：长度完全一致、只有判词不同。根因是宿主进程还加载着改动前的
            // lib/quality.mjs（插件改了文件不会热加载），本脚本却用磁盘上新版重算。
            // 若把这种情况一口咬定成「计数器在编」，就会在每次改判据后误报一次，
            // 而误报会让人开始无视这个脚本 —— 那时真故障也一起失效。
            // 所以这里只陈述事实 + 两条假设 + 一个能区分它们的动作，不替人下结论。
            if (lenOk && !idsOk) {
              lines.push('  ⇒ 长度一致但判词不同：两边读的是同一段正文，判的却不是同一版代码。')
              lines.push('    可能原因（无法从外部区分，只能靠下面这个动作）：')
              lines.push('      (a) 宿主进程加载的还是改动前的 lib/quality.mjs —— 插件文件不会热加载；')
              lines.push('      (b) 计数器里存的是旧值，钩子本身有问题。')
              lines.push('    区分方法：重启宿主后再跑一次本脚本。(a) 会消失，(b) 不会。')
            } else {
              lines.push('  ⇒ 交叉核对失败：连正文长度都对不上，计数器读到的不是这条事件的文本。')
            }
            if (verdict !== 'DEAD') verdict = 'INCONSISTENT'
          }
        }
      }
    }
  }

  lines.push('')
  lines.push(`最终判定：${verdict}`)
  if (verdict === 'RAN') {
    lines.push('钩子跑过、判过、判的是真实正文，但还没有一条回答坏到需要提醒 ——')
    lines.push('所以「没有提醒」此刻是正确结果，不是故障。这比 UNDETERMINED 强的地方在于：')
    lines.push('UNDETERMINED 是「不知道为什么没有」，RAN 是「知道为什么没有」。')
  }
  console.log(lines.join('\n'))
  return verdict === 'DEAD' || verdict === 'INCONSISTENT' ? 1 : 0
}

process.exitCode = await main()
