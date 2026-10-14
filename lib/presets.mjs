// lib/presets.mjs — 人设预设（纯数据 + 纯函数，无外部依赖）
//
// 预设 = 一组可整份套用的人设字段快照。用途：用户不必从十几个字段里逐个填，
// 选一个预设即可得到一套自洽的语气，再在这个基础上微调。
//
// 设计约束：
//   ① 预设**只覆盖它声明的字段**；套用时其余字段保持用户当前值不动。
//      这与工作区覆盖的 field-level merge 是同一套语义，保持一致的心智模型。
//   ② 内置预设不落盘、不可删、不可改名；用户自建预设存全局配置里。
//   ③ 内置预设不与自建预设重名 —— 同名时内置优先（见 resolvePreset）。
//
// v3 起的一个定位变化：人设字段全是自由文本了，于是**预设就是模板** ——
// 内置预设的字段值是一整段现成的话（来自 lib/wording.mjs），点一下把它填进表单，
// 用户随后可以随意改。它不再是一组「键」，因为键在自由文本模型里没有位置：
// 用户看不懂 'casual'，模型也读不懂。
//
// 这条路线的代价是内置预设的 fields 变得很长。这是刻意付的：若改成「存键 + 套用时翻译」，
// 设置页要显示「点一下会填什么」就必须先拿到翻译结果，于是宿主得多发一份翻译表、
// 客户端多一层同步；而用户想微调时又会发现表单里出现的和按钮上写的不是同一份东西。
//
// 本模块被 index.mjs（host）与 scripts/verify-core.mjs 共用。

import { LANGUAGE_WORDING, REPLY_LENGTH_WORDING, STYLE_WORDING, TRAIT_WORDING } from './wording.mjs'
import { FIELD_LIMITS, isPlainObject } from './config.mjs'

/** 预设可声明的字段（= 人设字段，不含记忆与工作区开关）。 */
export const PRESET_FIELDS = [
  'agentName', 'agentRole', 'addressUserAs', 'userOccupation', 'userBio',
  'style', 'headingLists', 'emoji', 'tables', 'replyLength', 'language',
  'customInstructions'
]

/** 预设名长度上限与条数上限。 */
export const PRESET_NAME_LIMIT = 40
export const PRESET_COUNT_LIMIT = 50

/**
 * 内置预设。id 固定，重装/升级后仍然稳定，故可安全地写进用户配置或文档。
 * 注意：内置预设刻意**不填** agentName（那是用户自己的助手名字）与用户背景
 * （userOccupation/userBio 描述的是用户本人，插件不该替用户假设）。
 *
 * 三个特质字段（headingLists / emoji / tables）里，取「默认」档的**直接不写这个字段**
 * —— default 档的文案就是空串，写进来也会被 applyPreset 当成「不覆盖」丢掉。
 * 少一个键比多一个空串诚实：读源码的人一眼能看出这个预设没对它提要求。
 */
export const BUILTIN_PRESETS = [
  {
    id: 'builtin:precise',
    name: '专业严谨',
    description: '结论先行、逻辑清晰、用词准确，不口语化。日常技术工作与文档写作的默认档。',
    fields: {
      style: STYLE_WORDING.professional,
      replyLength: REPLY_LENGTH_WORDING.normal,
      emoji: TRAIT_WORDING.emoji.less
    }
  },
  {
    id: 'builtin:concise',
    name: '极简主义',
    description: '只说结论与关键理由，能省的字都省，不重复你已经知道的东西。',
    fields: {
      style: STYLE_WORDING.efficient,
      replyLength: REPLY_LENGTH_WORDING.concise,
      headingLists: TRAIT_WORDING.headingLists.less,
      emoji: TRAIT_WORDING.emoji.less,
      tables: TRAIT_WORDING.tables.less
    }
  },
  {
    id: 'builtin:teacher',
    name: '教学型讲解',
    description: '从背景讲起、层层递进、多举例，适合学新东西时用。',
    fields: {
      style: STYLE_WORDING.professional,
      replyLength: REPLY_LENGTH_WORDING.detailed,
      headingLists: TRAIT_WORDING.headingLists.more,
      tables: TRAIT_WORDING.tables.more
    }
  },
  {
    id: 'builtin:architect',
    name: '资深架构师',
    description: '关注边界、失败模式与取舍，先问清约束再动手，主动指出设计里的坑。',
    fields: {
      style: STYLE_WORDING.professional,
      replyLength: REPLY_LENGTH_WORDING.detailed,
      headingLists: TRAIT_WORDING.headingLists.more,
      emoji: TRAIT_WORDING.emoji.less,
      tables: TRAIT_WORDING.tables.more,
      customInstructions: [
        '回答设计问题前先确认约束（规模、并发、可维护性要求）；',
        '给出方案时同时说明它的失败模式与不适用条件；',
        '发现提议里的隐藏风险要直接指出，不要为了配合而附和。'
      ].join('\n')
    }
  },
  {
    id: 'builtin:reviewer',
    name: '严格代码审查',
    description: '按行审查、只讲问题不讲客套、每条都给出可执行的修法。',
    fields: {
      style: STYLE_WORDING.professional,
      replyLength: REPLY_LENGTH_WORDING.detailed,
      headingLists: TRAIT_WORDING.headingLists.more,
      emoji: TRAIT_WORDING.emoji.less,
      customInstructions: [
        '审查代码时逐条列出问题，注明文件与行号；',
        '每条问题都要给出具体的修改建议，不要只说「这里不好」；',
        '没有问题就明确说没有问题，不要为凑数而挑刺。'
      ].join('\n')
    }
  },
  {
    id: 'builtin:brainstorm',
    name: '头脑风暴伙伴',
    description: '先发散再多给几条路子，允许不成熟的点子，等你选定后再收敛。',
    fields: {
      style: STYLE_WORDING.casual,
      replyLength: REPLY_LENGTH_WORDING.normal,
      tables: TRAIT_WORDING.tables.less,
      customInstructions: [
        '发散阶段尽量多给几个方向，哪怕其中一些还不成熟；',
        '每个方向写一句它的代价，方便我快速筛；',
        '等我明确选定方向后再收敛，不要在发散阶段就替我下结论。'
      ].join('\n')
    }
  }
]

const text = (v) => (typeof v === 'string' ? v.trim() : '')

/**
 * 校验一组预设字段值。
 *
 * v3 起全部字段都是自由文本，所以这里只剩两件事：类型、长度。
 * 长度按 lib/config.mjs 的 FIELD_LIMITS 判 —— 预设最终要写进配置，
 * 若这里放行一段超长文本，套用时会被 sanitizeConfig 整条拒掉，
 * 用户看到的是「点了一下预设，报错说字段超长」，却不知道是哪个预设的锅。
 *
 * @returns {{fields: object, errors: Record<string,string>}}
 */
export function sanitizePresetFields(raw) {
  const fields = {}
  const errors = {}
  if (!isPlainObject(raw)) {
    return { fields, errors: { _: '预设字段必须是一个 JSON 对象' } }
  }

  for (const key of PRESET_FIELDS) {
    if (!(key in raw)) continue
    const value = raw[key]
    if (typeof value !== 'string') {
      errors[key] = '必须为字符串'
      continue
    }
    const body = value.trim()
    if (!body) continue // 空 = 该预设不声明这个字段
    const limit = FIELD_LIMITS[key]
    if (limit && body.length > limit) {
      errors[key] = `长度超过上限 ${limit} 字符（当前 ${body.length}）`
      continue
    }
    fields[key] = body
  }

  return { fields, errors }
}

/**
 * 校验一个自建预设。
 * @returns {{preset: object|null, errors: Record<string,string>}}
 */
export function sanitizeCustomPreset(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { preset: null, errors: { _: '预设必须是一个 JSON 对象' } }
  }
  const errors = {}
  const name = text(raw.name)
  if (!name) errors.name = '预设名不能为空'
  else if (name.length > PRESET_NAME_LIMIT) errors.name = `预设名超过上限 ${PRESET_NAME_LIMIT} 字符`
  else if (BUILTIN_PRESETS.some((p) => p.name === name)) errors.name = '与内置预设重名，请换一个名字'

  const { fields, errors: fieldErrors } = sanitizePresetFields(raw.fields ?? {})
  Object.assign(errors, fieldErrors)

  if (Object.keys(errors).length > 0) return { preset: null, errors }

  const id = text(raw.id) || `custom:${name}`
  return {
    preset: {
      id,
      name,
      description: text(raw.description),
      fields,
      custom: true,
      createdAt: text(raw.createdAt) || new Date().toISOString()
    },
    errors: {}
  }
}

/**
 * 校验自建预设列表（整表替换语义）。
 * @returns {{presets: Array<object>, errors: Array<object>}}
 */
export function sanitizeCustomPresets(raw) {
  if (!Array.isArray(raw)) return { presets: [], errors: [{ _: '预设列表必须是数组' }] }
  if (raw.length > PRESET_COUNT_LIMIT) {
    return { presets: [], errors: [{ _: `自建预设最多 ${PRESET_COUNT_LIMIT} 条` }] }
  }
  const presets = []
  const errors = []
  const seen = new Set()
  for (const [index, item] of raw.entries()) {
    const { preset, errors: itemErrors } = sanitizeCustomPreset(item)
    if (!preset) {
      errors.push({ index, ...itemErrors })
      continue
    }
    if (seen.has(preset.name)) {
      errors.push({ index, name: '预设名重复' })
      continue
    }
    seen.add(preset.name)
    presets.push(preset)
  }
  return { presets, errors }
}

/** 内置 + 自建，内置在前。 */
export function listPresets(customPresets) {
  const custom = Array.isArray(customPresets) ? customPresets : []
  return [...BUILTIN_PRESETS, ...custom]
}

/** 按 id 找，找不到按 name 找；内置优先。 */
export function resolvePreset(customPresets, key) {
  const target = text(key)
  if (!target) return null
  const all = listPresets(customPresets)
  return all.find((p) => p.id === target) ?? all.find((p) => p.name === target) ?? null
}

/**
 * 套用预设：只覆盖预设声明的字段（空串视为「不覆盖」，与工作区覆盖同语义）。
 * @returns {object} 可直接交给 sanitizeConfig 的补丁
 */
export function applyPreset(preset) {
  if (!preset || !preset.fields) return {}
  const patch = {}
  for (const [key, value] of Object.entries(preset.fields)) {
    if (!PRESET_FIELDS.includes(key)) continue
    if (typeof value !== 'string' || !value.trim()) continue
    patch[key] = value.trim()
  }
  return patch
}

/**
 * 判断一份配置现在「正在用」哪条预设。
 *
 * 为什么需要：预设是**一次性套用**的 —— 点完就散成一堆字段值，配置里不再留任何
 * 「我来自哪条预设」的痕迹。于是用户下次打开设置页，看到的是哪个名字都对不上的
 * 一堆文字，既不知道自己刚才套过什么，也就无法判断「现在这套还算不算预设」。
 *
 * 判定规则（**按字段逐条比对，而不是记住一个 id**）：
 *   - 预设声明的每个非空字段，都必须与当前值完全相等；
 *   - 预设没声明的字段不参与比对（它本来就没动过那些字段）；
 *   - 一条都不声明字段的预设视为「不是预设」，不参与匹配；
 *   - 多条同时命中时取声明字段最多的那条（更具体的那条才是用户想要的），
 *     数量相同则内置优先（列表顺序）。
 *
 * 这样做的代价是：用户手改一个字段后，匹配自然失效、徽标消失 —— 这是**正确的**。
 * 记 id 的方案做不到这一点，它会一直举着一个「现在用的是 XX 预设」的牌子，
 * 哪怕用户早就把里面的字全改光了。
 *
 * @param {object} config 全局配置（不是合并后的 effective —— 预设只作用于全局层）
 * @param {Array<object>} [presets] 候选预设列表，默认内置 + 配置里的自建
 * @returns {?object} 命中的预设，没命中返回 null
 */
export function findActivePreset(config, presets) {
  const current = config && typeof config === 'object' ? config : {}
  const candidates = Array.isArray(presets) ? presets : listPresets(current.presets)
  let best = null
  let bestScore = 0
  for (const preset of candidates) {
    const fields = applyPreset(preset)
    const keys = Object.keys(fields)
    if (keys.length === 0) continue
    const matched = keys.every((key) => current[key] === fields[key])
    if (!matched) continue
    if (keys.length > bestScore) {
      best = preset
      bestScore = keys.length
    }
  }
  return best
}
