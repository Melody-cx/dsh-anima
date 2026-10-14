// lib/audit.mjs — 人设变更审计日志
//
// 为什么需要它：本插件有三个入口能改人设 —— 设置页、`/anima` 命令、
// 以及模型调用的 `set_assistant_persona` 工具。前两个是用户自己动手，
// 第三个是**模型主动改**。而「工具确认」默认是关的，也就是说模型可以直接
// 改写「你是谁、我叫你什么、用什么语气」。用户第二天发现语气变了、
// 名字换了，无从知道是谁、什么时候、把哪个字段从什么改成了什么。
//
// 这份日志就是回答那个问题的：**每一次人设变更都留痕**。
// 它只记「改了什么」，不做任何判断，也不参与提示词 —— 纯粹给人看。
//
// 设计约束：
//   ① 只记人设与记忆相关的配置键，不记凭据类内容（本插件的配置里本就没有）；
//   ② 值超长时截断 —— 审计日志是给人扫一眼的，不是备份；
//   ③ 有上限并环形淘汰，绝不无限增长（无界日志最终会拖垮存储）。

/** 谁能改人设。区分来源是这份日志的全部意义所在。 */
export const AUDIT_ACTORS = ['user', 'agent', 'system']

/** 每个值的记录上限：够认出「改了哪一段」，不够还原全文 —— 日志不是备份。 */
export const AUDIT_VALUE_MAX = 200

/** 环形上限：超出后丢弃最早的记录。 */
export const AUDIT_MAX_RECORDS = 200

/** 来源码 → 人话（设置页与命令共用，避免两处各写一份翻译）。 */
export const AUDIT_SOURCE_TEXT = {
  settings: '设置页',
  command: '命令',
  tool: '模型工具',
  proposal: '待确认提议',
  preset: '人设预设',
  reset: '重置',
  memory: '记忆裁决',
  other: '其他'
}

/** 归一化记录人（未知值一律按 system 处理，不扩大信任面）。 */
export function normalizeActor(actor) {
  return AUDIT_ACTORS.includes(actor) ? actor : 'system'
}

/** 截断单个值：非字符串走 JSON 摘要，超长加省略号标注。 */
export function auditValue(value) {
  if (value === undefined) return null
  if (value === null) return null
  if (typeof value === 'string') {
    return value.length > AUDIT_VALUE_MAX ? `${value.slice(0, AUDIT_VALUE_MAX)}…（共 ${value.length} 字）` : value
  }
  if (typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) return `[${value.length} 项]`
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    return `{${keys.length} 个字段}`
  }
  return String(value)
}

/**
 * 把 diffConfig 产出的字段名清单翻译成逐字段的「前 → 后」。
 *
 * `memory.x` 这种复合键要拆开取 `before.memory.x`，否则审计里会看到
 * `from: undefined` —— 那等于没记。
 */
export function buildAuditChanges(before, after, changedKeys) {
  const changes = []
  for (const key of changedKeys ?? []) {
    const read = (source) => {
      if (!key.startsWith('memory.')) return source?.[key]
      return source?.memory?.[key.startsWith('memory.') ? key.slice('memory.'.length) : key]
    }
    changes.push({
      key,
      from: auditValue(read(before)),
      to: auditValue(read(after))
    })
  }
  return changes
}

/**
 * 构造一条审计记录。
 *
 * @param {object} input {changes, actor, source, note, sessionId}
 * @param {Date} [at]
 * @returns {object|null} changes 为空时返回 null（没有变更就没有日志）
 */
export function makeAuditEntry({ changes, actor, source, note, sessionId }, at = new Date()) {
  const list = Array.isArray(changes) ? changes.filter((c) => c && c.key) : []
  if (list.length === 0) return null
  const entry = {
    id: `a-${at.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: at.toISOString(),
    actor: normalizeActor(actor),
    source: AUDIT_SOURCE_TEXT[source] ? source : 'other',
    changes: list
  }
  const trimmedNote = typeof note === 'string' ? note.trim() : ''
  if (trimmedNote) entry.note = trimmedNote.slice(0, AUDIT_VALUE_MAX)
  if (sessionId) entry.sessionId = sessionId
  return entry
}

/** 环形淘汰：保留最新的 max 条，返回 {kept, dropped} 的条数。 */
export function trimAudit(records, max = AUDIT_MAX_RECORDS) {
  const list = Array.isArray(records) ? records : []
  if (list.length <= max) return { kept: list, dropped: 0 }
  const sorted = [...list].sort((a, b) => String(a?.at ?? '').localeCompare(String(b?.at ?? '')))
  return { kept: sorted.slice(sorted.length - max), dropped: sorted.length - max }
}

/** 一行摘要，供命令与设置页列表使用。 */
export function summarizeAudit(entry) {
  if (!entry) return ''
  const who = AUDIT_SOURCE_TEXT[entry.source] ?? entry.source ?? '其他'
  const fields = (entry.changes ?? []).map((c) => c.key).join(', ')
  return `[${shortTime(entry.at)}] ${who}：${fields}`
}

/** 时间戳 → `MM-DD HH:mm`（列表里年份是噪声）。 */
export function shortTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso ?? '')
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
