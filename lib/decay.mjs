// lib/decay.mjs — 记忆随时间的可见性衰减
//
// 为什么单独一个文件：`lib/memory.mjs` 已经 583 行，而衰减是**纯粹按日历算的算术**，
// 与「怎么存」「怎么裁决」无关。放在一起会让下一个人以为衰减也需要判断语义。
//
// ============================ 这一层到底做什么 ============================
//
// 只做两件事，都不写盘：
//   ① 算：一条记忆几岁了、有没有超过它这一类的时间窗；
//   ② 用：超窗的在注入行尾部加一个字面标签，并在注入排序里排到最后
//          （预算紧张时它先被挤出去 —— 但记录本身一个字节都不变）。
//
// 刻意**不做**的三件事，理由都是同一个「不许替用户下结论」：
//   - 不自动改 state。state 是用户的所有权，「这条还算不算数」只有他能判。
//   - 不自动删除。删除权只属于用户（见 store.mjs 的墓碑设计）。
//   - 不判断内容有没有变旧。代码只知道日期，不知道你的偏好还是不是那个偏好。
//
// ============================ 为什么按类型分窗 ============================
//
// 四类记忆的失效方式本来就不同（这是用户在 memory 里定的分类，不是我爱发明）：
//   事实 fact       —— 改了才覆盖，不随年龄失效。窗口 0 = 永不因时间衰减。
//                      它要防的是「环境变了」，那由 verifyAt 管，不由年龄管。
//   偏好 preference —— 半衰期很长。用户没改口之前，就该一直当真的用。
//   立场 stance     —— 「我改主意了」时归档成「曾如此」；年龄只是提醒我别把它
//                      当成今天的态度。
//   事件 event      —— 永不失效（它确实发生过），但越快越有用。
//
// ============================ 这些天数是我猜的 ============================
//
// 540 / 365 / 180 三个数**没有任何数据支撑**，是我按上面的道理随手定的量级。
// 它们写成常量而不是配置项，是因为在我还没见过你真实的记忆增长速度之前，
// 把它做成设置页里的三个输入框，只会让你以为「调对了」，而不是「有依据」。
// 等你实际用上一段时间，觉得某类太早或太晚，再决定要不要提升为配置。
//
// ============================ 保守方向：宁可当新 ============================
//
// 解析不出日期、日期在未来、记录为空 —— 一律按「新鲜」处理。
// 理由：把一条其实很新的记忆当成旧的，会实实在在地降低它被注入的机会；
// 反过来把旧的当新的，最坏结果只是它多占一行，用户看得见、删得掉。

/**
 * 每类记忆的时间窗（天）。0 = 永不因时间衰减。
 *
 * 只有**超过**窗口才降级，不是「一天一天地淡出」—— 因为「淡出」需要每轮重算权重，
 * 而权重一旦进入排序，用户就无法解释「为什么这条昨天还在、今天没了」。
 * 阈值制的好处是：跨过窗口那天有一条明确的评论可以说清。
 */
export const DECAY_WINDOWS_DAYS = Object.freeze({
  fact: 0,
  preference: 540,
  stance: 365,
  event: 180
})

/** 三档。顺序即严重程度，用于排序。 */
export const DECAY_LEVELS = Object.freeze(['fresh', 'aging', 'stale'])

const DAY_MS = 24 * 60 * 60 * 1000

/** 窗口的哪一部分算「aging」：过了一半就该开始提醒，不必等到过期。 */
const AGING_RATIO = 0.5

/**
 * 一条记忆从写入到现在过了多少天（向下取整）。
 *
 * 解析不出 / 为空 / 在未来 → 0（当新的处理，见文件头「保守方向」）。
 *
 * @param {object} record 记忆记录
 * @param {Date} now 当前时间
 * @returns {number} 非负整数天数
 */
export function memoryAgeDays(record, now = new Date()) {
  const captured = Date.parse(String(record?.capturedAt ?? ''))
  if (!Number.isFinite(captured)) return 0
  const current = now instanceof Date ? now.getTime() : Date.parse(String(now))
  if (!Number.isFinite(current)) return 0
  const diff = current - captured
  if (diff <= 0) return 0
  return Math.floor(diff / DAY_MS)
}

/**
 * 算一条记忆的衰减档位。
 *
 * @param {object} record 记忆记录
 * @param {Date} now 当前时间
 * @param {object} [windows] 覆盖默认窗口（测试与将来配置化用）
 * @returns {{type: string, ageDays: number, windowDays: number, level: string, decayed: boolean}}
 *   `decayed` 为 true 表示**已超窗**（= level === 'stale'），标签与排序都只看它，
 *   所以调用方不需要自己再判一次 level。窗口为 0 的类型永远是 false。
 */
export function decayInfo(record, now = new Date(), windows = DECAY_WINDOWS_DAYS) {
  const type = Object.prototype.hasOwnProperty.call(windows, record?.type) ? record.type : 'fact'
  const windowDays = Number(windows[type]) || 0
  const ageDays = memoryAgeDays(record, now)
  // 窗口为 0（事实类）= 不参与时间衰减，永远 fresh。
  if (!windowDays) return { type, ageDays, windowDays: 0, level: 'fresh', decayed: false }
  if (ageDays >= windowDays) return { type, ageDays, windowDays, level: 'stale', decayed: true }
  if (ageDays >= windowDays * AGING_RATIO) return { type, ageDays, windowDays, level: 'aging', decayed: false }
  return { type, ageDays, windowDays, level: 'fresh', decayed: false }
}

/**
 * 超窗时返回加在注入行尾部的标签，否则空串。
 *
 * 为什么事件类用另一句话：事件不会「更新」，它只是离得远了。
 * 同一个标签套在所有类型上，会让人读出一条不成立的事实。
 *
 * 为什么标签里不带天数：天数由紧挨着的写入日期本身就能算出，
 * 而且行内每多一个字都从 4000 字预算里扣（见 config.mjs 的 maxInjectedChars）。
 *
 * @param {object} record 记忆记录
 * @param {Date} now 当前时间
 * @param {object} [windows] 覆盖默认窗口
 * @returns {string} '' | '久未更新' | '较早的事'
 */
export function decayTag(record, now = new Date(), windows = DECAY_WINDOWS_DAYS) {
  const info = decayInfo(record, now, windows)
  if (!info.decayed) return ''
  return info.type === 'event' ? '较早的事' : '久未更新'
}

/**
 * 排序用的降级权重：没超窗 = 0，超窗 = 1。
 *
 * 只分两档、不做连续权重，是刻意的：连续权重排出来的顺序，用户无法用一句话解释；
 * 「超窗的挪到最后」可以。而「预算紧张时先挤掉谁」这个问题，本来就只需要一个二选一。
 */
export function decayRank(record, now = new Date(), windows = DECAY_WINDOWS_DAYS) {
  return decayInfo(record, now, windows).decayed ? 1 : 0
}
