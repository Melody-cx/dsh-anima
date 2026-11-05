// lib/patrol.mjs — 巡夜：什么时候醒、醒了要不要说话
//
// 用户定的规则（m05776）：**有需要汇报的就汇报，没有就不汇报。**
//
// 这条规则的作用不是省字，是让「说了」重新有分量。一个每天到点出现、每次都说
// 「今天没什么」的通知，两周后就会被当成背景噪音；等它真有事，用户已经不看了。
//
// 但它有一个必须当场堵住的洞：只报有事，等于「沉默」同时代表两件事 ——
//   (a) 巡过了，没事
//   (b) 巡夜那个东西根本没跑 / 坏了
// 这正是质检钩子上花了很多功夫解决的同一个问题（checks=0 有两种相反解读）。
// 堵法：**汇报可以不发，巡夜记录必须留。** 每次到点都写一条 meta.patrol，
// 于是「没汇报」永远能反查成「真的没事」。
//
// 判据只有机器数得出来的三样，不含任何「我觉得」：
//   ① 待审候选里出现了**新的**（不是「有没有候选」，是「有没有新的」）
//   ② 记忆体检的 flagged 里出现了**新的**
//   ③ 这次整理真的动了数据（去重或超限淘汰）
//
// 为什么用「有没有新的」而不是「数量 > 0」：如果三条候选挂了一周没人管，
// 每天报一遍是纯噪音 —— 你早就知道了。
//
// 为什么用「有没有新的」而不是「集合变没变」（m06352 用户拍板改成这样）：
// 集合变没变是**双向**的。你裁掉两条候选是好事，但集合变了 ⇒ 也会给你发一条
// 汇报。于是「我把事情处理完了」这个动作本身会换来一条通知，形状上跟
// 「又有人说你错了」一模一样。改判据：**增加才出声，减少只记账。**

/**
 * 计算这次巡夜的指纹。
 *
 * 只对**集合**做摘要，不对数量做摘要：两条旧的换成两条新的，数量没变但
 * 指纹会变 —— 那是真的有事。反过来，三条挂了七天，指纹一模一样。
 *
 * 指纹本身不再直接决定「要不要说话」（那是 assessPatrol 里比较新旧集合的事），
 * 它的用途是留痕与反查：用户拿它比对两次巡夜，就能看出中间有没有东西动过。
 *
 * @param {object} input
 * @param {string[]} [input.pendingIds] 待审候选 id
 * @param {string[]} [input.flaggedIds] 体检有问题的记忆 id
 * @param {number} [input.removed] 本次整理动过的条数
 * @returns {string}
 */
export function patrolSignature({ pendingIds = [], flaggedIds = [], removed = 0 } = {}) {
  const norm = (list) => [...new Set((Array.isArray(list) ? list : []).map(String))].sort()
  const pending = norm(pendingIds).join(',')
  const flagged = norm(flaggedIds).join(',')
  // 整理动过数据这件事本身就值得说一次；但它不是一个可以「恢复原状」的集合，
  // 所以折成一个 0/1 位，避免同一次结果被反复重报。
  const touched = removed > 0 ? 1 : 0
  return `p:${pending}|f:${flagged}|t:${touched}`
}

/**
 * 从指纹里解析出上一次的集合。
 *
 * 判据改成「有没有新的」之后，必须知道上次**报过什么**，而 meta 里只存了指纹。
 * 与其加两个字段（旧介质里没有，读出来是 undefined，还得再写一套迁移），
 * 不如从指纹本身解析回来 —— 格式是我们自己定的，解析失败有明确兜底。
 *
 * @param {string} signature
 * @returns {{pending: string[], flagged: string[], touched: number, parsed: boolean}}
 */
export function parsePatrolSignature(signature) {
  const empty = { pending: [], flagged: [], touched: 0, parsed: false }
  const text = String(signature ?? '')
  if (!text) return { ...empty, parsed: true }
  const m = /^p:([^|]*)\|f:([^|]*)\|t:([01])$/.exec(text)
  if (!m) return empty
  const split = (s) => (s ? s.split(',').filter(Boolean) : [])
  return { pending: split(m[1]), flagged: split(m[2]), touched: Number(m[3]), parsed: true }
}

/**
 * 判断这次巡夜该不该出声。
 *
 * @param {object} input
 * @param {string[]} [input.pendingIds] 待审候选 id（整理后的存活者）
 * @param {string[]} [input.flaggedIds] 体检 flagged 的记忆 id
 * @param {number} [input.removed] 本次整理动过的条数
 * @param {string} [input.previousSignature] 上次巡夜留下的指纹；没跑过就传空
 * @param {string[]} [input.previousPendingIds] 上次的待审集合（给了就不解析指纹）
 * @param {string[]} [input.previousFlaggedIds] 上次的体检集合
 * @returns {{shouldReport: boolean, signature: string, reasons: string[], facts: object,
 *            added: {pending: number, flagged: number}, cleared: {pending: number, flagged: number}}}
 */
export function assessPatrol({
  pendingIds = [],
  flaggedIds = [],
  removed = 0,
  previousSignature = '',
  previousPendingIds,
  previousFlaggedIds
} = {}) {
  const uniq = (list) => [...new Set((Array.isArray(list) ? list : []).map(String))]
  const pending = uniq(pendingIds)
  const flagged = uniq(flaggedIds)
  const signature = patrolSignature({ pendingIds, flaggedIds, removed })

  let prevPending
  let prevFlagged
  let prevTouched = 0
  let parseFailed = false
  if (Array.isArray(previousPendingIds) || Array.isArray(previousFlaggedIds)) {
    prevPending = uniq(previousPendingIds ?? [])
    prevFlagged = uniq(previousFlaggedIds ?? [])
  } else {
    const parsed = parsePatrolSignature(previousSignature)
    // 解析失败时当成「没有上次」处理：宁可多报一次，也不能因为读不懂旧记录就
    // 把真事吞掉。吞掉的错误没人看得见，多报一次的代价只是多一句。
    parseFailed = !parsed.parsed
    prevPending = parsed.pending
    prevFlagged = parsed.flagged
    prevTouched = parsed.touched
  }

  const prevPendingSet = new Set(prevPending)
  const prevFlaggedSet = new Set(prevFlagged)
  const addedPending = pending.filter((id) => !prevPendingSet.has(id))
  const addedFlagged = flagged.filter((id) => !prevFlaggedSet.has(id))
  const clearedPending = prevPending.filter((id) => !pending.includes(id))
  const clearedFlagged = prevFlagged.filter((id) => !flagged.includes(id))

  const facts = {
    pending: pending.length,
    flagged: flagged.length,
    removed: Number(removed) || 0
  }
  const added = { pending: addedPending.length, flagged: addedFlagged.length }
  const cleared = { pending: clearedPending.length, flagged: clearedFlagged.length }

  // 只看「增加」和「整理真的动了数据」。减少（你裁决掉了、路径修好了）不算有事：
  // 那是你把问题解决掉的结果，不该再拿它来打扰你一次。它仍然记进 meta，
  // 于是「上周有三条，这周没了」依然可反查 —— 只是不再发一条消息。
  const reasons = []
  if (addedPending.length > 0) reasons.push(`pending:${addedPending.length}`)
  if (addedFlagged.length > 0) reasons.push(`flagged:${addedFlagged.length}`)
  // 整理动过数据只在「上次没动过」时才说一次。否则同一个结果会每晚重报 ——
  // 这正是 m05776「没有就不汇报」要消灭的形状。旧指纹里的 t 位就为这个存在。
  if (facts.removed > 0 && prevTouched === 0) reasons.push(`removed:${facts.removed}`)

  return {
    shouldReport: reasons.length > 0,
    signature,
    reasons,
    facts,
    added,
    cleared,
    ...(parseFailed ? { parseFailed: true } : {})
  }
}

/** 一次巡夜最多落盘几条体检明细。 */
export const MAX_FLAGGED_ITEMS = 20
/** 单条明细里 detail 文本的字符上限（落盘用，不是给人读的全文）。 */
export const MAX_FLAGGED_DETAIL_CHARS = 200

/**
 * 把体检结果压成「可以安全落盘的那一份」。
 *
 * 为什么要压而不是原样存：`audit.flagged` 里每条都带 findings（含 evidence 里的
 * 完整命令与路径）和建议命令，内容随记忆增长，且 store 的 metaSchema 已经把
 * 形状钉死 —— 原样塞进去，读回时会被 zod 剥掉不认识的部分，于是「写了但读不回来」。
 * 这正是 2026-10-24 那个 metaSchema bug 的形状，不能再犯一次。
 *
 * 只留三样：id（能去 `/anima mark` 那条命令）、明细首句（让人认得出是哪条）、
 * 证据首句（证明不是瞎报）。**不留建议命令全文**：它是按 id 现算的，存下来只会过期。
 *
 * @param {Array<{id:string, text?:string, findings?:Array<{detail?:string, evidence?:string}>}>} flagged
 * @returns {{items: Array<{id:string, detail:string, evidence:string, kinds:string[]}>, dropped: number}}
 */
export function compactFlagged(flagged) {
  const list = Array.isArray(flagged) ? flagged : []
  const items = []
  for (const item of list.slice(0, MAX_FLAGGED_ITEMS)) {
    const id = String(item?.id ?? '').trim()
    if (!id) continue
    const findings = Array.isArray(item?.findings) ? item.findings : []
    const first = findings[0] ?? {}
    const clip = (s) => {
      const text = String(s ?? '')
      return text.length > MAX_FLAGGED_DETAIL_CHARS
        ? `${text.slice(0, MAX_FLAGGED_DETAIL_CHARS)}…`
        : text
    }
    items.push({
      id,
      // detail 缺失时退回记忆正文：宁可少一句解释，也不能留一条只有 id 的孤儿明细
      // —— 那种行在界面上等于「有 1 条有问题，但我不告诉你是什么」。
      detail: clip(first.detail ?? item?.text ?? ''),
      evidence: clip(first.evidence ?? ''),
      kinds: findings.map((f) => String(f?.kind ?? '')).filter(Boolean)
    })
  }
  return { items, dropped: Math.max(0, list.length - items.length) }
}

/**
 * 算出下一次该在什么时候醒。
 *
 * 背景（m06351 实测）：原来的写法是「把 delay 压到 6 小时上限，然后每 6 小时
 * 醒一次都判断今天跑过没」。后果不是跑到错的时间点就完事 —— 是**真正决定巡夜
 * 在几点跑的，变成了「今天补跑过没有」，而不是 nightlyHour**。开机补跑一旦被
 * 跳过（存储没就绪），第二天早上第一次醒来就会当场把巡夜跑掉。
 *
 * 改法：**没到目标时刻的醒来，只重新定闹钟，不跑巡夜。** 于是巡夜只可能在两个
 * 时候跑：目标时刻本身，或者机器睡过了目标之后（那是补跑，会记 `nightly-late`）。
 *
 * 这个函数是纯的，所以「到底几点醒」可以被测试锁住，而不是靠读代码想象。
 *
 * @param {object} [input]
 * @param {Date} [input.now] 当前时刻
 * @param {number} [input.hour] 目标小时（0-23）
 * @param {number} [input.maxDelayMs] 单次定时最长挂多久
 * @returns {{delayMs: number, targetAt: number, isTarget: boolean}}
 *   `isTarget` 为 true 表示这次醒来就是目标时刻（醒来后该跑巡夜）；
 *   为 false 表示只是中途醒来重新定闹钟，不许跑。
 */
export function planNightlyWake({ now = new Date(), hour = 3, maxDelayMs = 6 * 60 * 60 * 1000 } = {}) {
  const h = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 3
  const limit = Number(maxDelayMs) > 0 ? Number(maxDelayMs) : 6 * 60 * 60 * 1000
  const base = now instanceof Date ? now : new Date(now)
  const target = new Date(base.getTime())
  target.setHours(h, 0, 0, 0)
  if (target.getTime() <= base.getTime()) target.setDate(target.getDate() + 1)
  const raw = target.getTime() - base.getTime()
  return {
    delayMs: Math.min(raw, limit),
    targetAt: target.getTime(),
    isTarget: raw <= limit
  }
}
