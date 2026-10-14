// lib/config.mjs — dsh-anima 配置层（纯函数，无外部依赖）
//
// 定位（用户 m03846 拍板「A 自建补齐」）：
//   本插件自持全部人设字段，不依赖任何其它插件。字段设计对照 WorkBuddy 设置页
//   截图（「个性化」页 + 「记忆与进化」页）与 dsh-soul 0.7.0 的字段集，
//   但代码为自写，不吸收上游源码（字段名/界面布局属思想，不受版权保护）。
//
//   三类能力：
//     ① 助手自身身份（agentName/agentRole）+ 用户背景（userOccupation/userBio）
//     ② 按工作区两级覆盖（field-level merge：工作区只覆盖它明确声明的字段）
//     ③ 带待审缓冲区的长期记忆
//
// 本模块被 index.mjs（host）与 scripts/verify-core.mjs 共用。

import { LANGUAGE_WORDING, REPLY_LENGTH_WORDING, STYLE_WORDING, TRAIT_WORDING, translateWording } from './wording.mjs'

// ==================== 全局配置 ====================

export const DEFAULT_CONFIG = {
  enabled: true,

  // ① 助手自身身份（dsh-soul 无此字段：其 nickname 语义是「用户的名字」）。
  agentName: '',   // AI 的名字
  agentRole: '',   // AI 是谁 / 角色设定

  // ② 用户背景。与 agentName 严格互斥：这一段描述的是用户，不是助手。
  addressUserAs: '',      // 回复时对用户的称呼
  userOccupation: '',     // 用户的职业 / 身份
  userBio: '',            // 关于用户的介绍

  // ③ 回复风格与特质微调。**全部是自由文本**（用户 m06593 拍板：不要预设档位，
  // 每个人的想法不一样）。默认值 = 原「专业严谨」档的文案，理由有两条：
  //   ① 行为不变 —— 改造前 enabled 时风格段必非空，模型不会退回到通用语气；
  //   ② 用户看到的不是一行空框，而是一句可以照着改的样板。
  // 原档位没有消失，降级成设置页上的「一键填入」按钮（见 lib/wording.mjs）。
  style: STYLE_WORDING.professional,
  headingLists: TRAIT_WORDING.headingLists.default,  // 空串 = 不约束（原 default 档）
  emoji: TRAIT_WORDING.emoji.default,
  tables: TRAIT_WORDING.tables.default,
  replyLength: REPLY_LENGTH_WORDING.normal,
  language: LANGUAGE_WORDING.zh,

  // ④ 自由文本的补充指令
  customInstructions: '',

  // ⑤ 工具改人设是否要先经用户确认（对照 dsh-soul 的 requireToolConfirmation）。
  // 置 true 时 set_persona 不落盘，只返回一条待确认提议，等用户在对话里裁决。
  //
  // 默认**关**：多数用户第一次装插件时并不预期「模型帮我改人设」要过一次确认，
  // 默认开着会在他们没要求的情况下多出一次往返。默认关的代价则由审计日志兜住 ——
  // 每一次改动都会留下「谁、何时、把哪个字段改成了什么」，用户事后能看见。
  // 两者是配套的：日志不能替代把关，把关也不该在用户没要求时强加。
  //
  // 与 trail* 一起**不参与工作区覆盖**：一个是安全开关，一组是界面偏好，
  // 都不该因为「换个工作区」而悄悄换掉。
  requireToolConfirmation: false,

  // ⑥ 输入框光轨（对照 dsh-soul 的 trail* 四项）
  trailEnabled: true,
  trailColor: '#679EFE',
  trailSpeed: 'slow',   // slow | normal | fast
  trailWidth: 'thin',   // thin | normal | thick

  // ⑦ 用户自建的人设预设（内置预设不落盘，见 lib/presets.mjs）。
  // 存进配置而非单独一张表：预设本就是配置的一部分，整表替换天然原子。
  presets: [],

  // ⑧ 工作区两级覆盖
  workspaceOverridesEnabled: true,
  workspaceFileDir: '.dsh-anima',

  // ⑨ 记忆层
  memory: {
    enabled: true,
    autoCapture: true,   // 允许 Agent 通过 remember 工具投递候选
    nightlyTriage: true, // 每晚自动整理到待审缓冲区
    nightlyHour: 3,      // 本地时区 0..23
    maxPending: 200,     // 缓冲区上限，超出按最早优先淘汰
    maxInjected: 40,     // 注入提示词的已采纳记忆条数上限
    maxInjectedChars: 4000, // 注入字符预算（与条数取先到者）—— 只有条数约束时，40 条长记忆一样能挤爆上下文
    notifyOnSessionStart: true,
    // 默认把新记忆记在哪一层：global 处处生效；workspace 只在当前工作区生效。
    // 默认 global 是刻意的：把「记忆动不动就少一条」作为默认体验，比跨工作区
    // 污染更难排查 —— 用户主动选 workspace 才算知情。
    defaultLayer: 'global'
  }
}

// 这里**刻意没有** CONFIG_VERSION。
//
// 曾经有过一个 `CONFIG_VERSION = 3`，但它全仓零引用（定义即孤岛），而且数字 3 与
// lib\store.mjs 的 DOMAIN_VERSION 撞在一起 —— 两个不同的东西共用一个数字，正是
// 「v1 还是 v3」口径混乱的来源之一。真正需要版本沿革的地方是**介质**（域），
// 沿革注释与常量都在 lib\store.mjs（DOMAIN_VERSION）。
// 配置字段的增删只影响 migrateConfig 的容错，不构成需要对外报告的版本。

// ==================== 枚举 ====================
//
// 人设的六个字段（style / headingLists / emoji / tables / replyLength / language）
// 现在**都不是枚举**，是自由文本；原来那份「键 → 文案」的表留在
// lib/wording.mjs，只被两处使用：迁移期把旧键翻译成文案、设置页的「一键填入」。
// 于是这里只剩**界面偏好**类的枚举 —— 光轨速率与粗细：它们是给 CSS 用的键
// （设置页要把值写进 data 属性让样式表选中），必须是封闭集合，
// 而且没有「每个用户想法不同」的空间（细一点还是粗一点，选项足够表达）。

// 记忆层级在这里定义（而非 lib/memory.mjs）：memory.mjs 已从本模块导入，
// 反向依赖会成环。memory.mjs 从这里重新导出，对外仍是同一个常量。
export const MEMORY_LAYERS = ['global', 'workspace']
// 光轨两项（对照 dsh-soul 的 TRAIL_SPEED_VALUES / TRAIL_WIDTH_VALUES）
export const TRAIL_SPEED_VALUES = ['slow', 'normal', 'fast']
export const TRAIL_WIDTH_VALUES = ['thin', 'normal', 'thick']
/** 光轨颜色：只接受 #RRGGBB。dsh-soul 的前端用同一个正则做容错，这里作为落盘闸门。 */
export const TRAIL_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/
export const TRAIL_COLOR_FALLBACK = '#679EFE'

/** 枚举字段 → 允许值。sanitize/migrate 共用，避免两处写岔。 */
export const ENUM_FIELDS = {
  trailSpeed: TRAIL_SPEED_VALUES,
  trailWidth: TRAIL_WIDTH_VALUES
}

/**
 * 曾经是枚举、v3 起改为自由文本的字段。
 *
 * 单独列出来，是因为迁移路径要分两步走：先看旧值是不是档位键（翻译成文案），
 * 不是的话就当用户自己写的句子原样留下。若沿用 ENUM_FIELDS 的「命中白名单才收」，
 * 这些字段的旧值会被整条丢掉，用户升级后风格悄悄变回默认 ——
 * 而 ENUM_FIELDS 此刻已经不认识它们了（只含光轨两项）。
 */
export const FORMER_ENUM_FIELDS = ['style', 'headingLists', 'emoji', 'tables', 'replyLength', 'language']

// ==================== 字段边界 ====================

export const FIELD_LIMITS = {
  agentName: 50,
  agentRole: 800,
  addressUserAs: 50,
  userOccupation: 50,
  userBio: 500,
  // 六个「原枚举」字段自 v3 起是自由文本，上限按「写一段话」而不是「写一个键」来定。
  // 风格段是语气的主描述，给得宽一些；其余五项是单项约束，一句话就够，
  // 给 300 是因为确实有人会写「表格只用来说明对比，别用来摆放列表」这种带条件的说明。
  style: 800,
  headingLists: 300,
  emoji: 300,
  tables: 300,
  replyLength: 300,
  language: 300,
  customInstructions: 2000
}

const TEXT_FIELDS = ['agentName', 'agentRole', 'addressUserAs', 'userOccupation', 'userBio', 'customInstructions', ...FORMER_ENUM_FIELDS]

// 工作区覆盖文件里允许出现的字段。
// 注意不含 memory：记忆是全局资产，不按工作区分叉；也不含 trail*/requireToolConfirmation：
// 前者是界面偏好、后者是安全开关，都不该因为「换个工作区」而悄悄换掉。
//
// 与 TEXT_FIELDS 同集合是 v3 的结果而非巧合：人设字段全部改自由文本之后，
// 「能写的」与「能被工作区覆盖的」正好是同一批。共用一个数组，
// 免得将来加字段时改了一处、漏了另一处，而漏掉的那处不会报错、只会静默失效。
export const OVERRIDABLE_FIELDS = [...TEXT_FIELDS]

// 记忆候选文本上限（单条）
export const MEMORY_TEXT_MAX = 500
export const MEMORY_NOTE_MAX = 200

// 自建预设的结构上限（语义校验在 lib/presets.mjs，两边数值须一致）
export const PRESET_ARRAY_LIMIT = 50
export const PRESET_NAME_MAX = 40

// 禁用名（防原型污染）
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// ==================== 校验 ====================

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

const clampInt = (v, min, max, fallback) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  const n = Math.trunc(v)
  if (n < min || n > max) return fallback
  return n
}

/**
 * 校验外部传入的配置补丁。
 * @returns {{patch: object, errors: Record<string,string>}}
 *   patch 仅含通过校验的字段；errors 非空时调用方应整单拒绝。
 */
export function sanitizeConfig(raw) {
  const patch = {}
  const errors = {}

  if (!isPlainObject(raw)) return { patch, errors: { _: '配置必须是一个 JSON 对象' } }

  if ('enabled' in raw) {
    if (typeof raw.enabled === 'boolean') patch.enabled = raw.enabled
    else errors.enabled = '必须为布尔值（true / false）'
  }

  if ('workspaceOverridesEnabled' in raw) {
    if (typeof raw.workspaceOverridesEnabled === 'boolean') patch.workspaceOverridesEnabled = raw.workspaceOverridesEnabled
    else errors.workspaceOverridesEnabled = '必须为布尔值（true / false）'
  }

  if ('workspaceFileDir' in raw) {
    const text = typeof raw.workspaceFileDir === 'string' ? raw.workspaceFileDir.trim() : ''
    if (!text) errors.workspaceFileDir = '不能为空'
    // 只允许单段相对目录名，避免写到工作区之外
    else if (/[\\/]/.test(text) || text === '..' || text === '.') errors.workspaceFileDir = '必须是单段目录名（不含路径分隔符）'
    else if (text.length > 64) errors.workspaceFileDir = '长度超过上限 64 字符'
    else patch.workspaceFileDir = text
  }

  for (const key of TEXT_FIELDS) {
    if (!(key in raw)) continue
    const value = raw[key]
    if (typeof value !== 'string') {
      errors[key] = '必须为字符串'
      continue
    }
    const text = value.trim()
    if (text.length > FIELD_LIMITS[key]) {
      errors[key] = `长度超过上限 ${FIELD_LIMITS[key]} 字符（当前 ${text.length}）`
      continue
    }
    patch[key] = text
  }

  // 枚举字段：只接受白名单内的值，写错必报错而不是静默回退。
  // v3 起这里只剩光轨两项 —— 人设六字段已是自由文本，走上方的 TEXT_FIELDS 循环。
  for (const [key, allowed] of Object.entries(ENUM_FIELDS)) {
    if (!(key in raw)) continue
    const value = raw[key]
    if (typeof value !== 'string' || !allowed.includes(value)) {
      errors[key] = `必须是 ${allowed.join(' / ')} 之一`
      continue
    }
    patch[key] = value
  }

  // 工具改人设的确认门槛 + 光轨总开关：布尔
  for (const key of ['requireToolConfirmation', 'trailEnabled']) {
    if (!(key in raw)) continue
    if (typeof raw[key] === 'boolean') patch[key] = raw[key]
    else errors[key] = '必须为布尔值（true / false）'
  }

  // 光轨颜色：只收 #RRGGBB。前端 safeTrailColor() 会在渲染前再兜一次底，
  // 但落盘闸门在这里 —— 脏值不该进配置，否则每次读出来都要重新判一遍。
  if ('trailColor' in raw) {
    const text = typeof raw.trailColor === 'string' ? raw.trailColor.trim() : ''
    if (TRAIL_COLOR_PATTERN.test(text)) patch.trailColor = text.toUpperCase()
    else errors.trailColor = '必须是 #RRGGBB 形式的十六进制颜色'
  }

  if ('memory' in raw) {
    if (!isPlainObject(raw.memory)) {
      errors.memory = '必须是一个对象'
    } else {
      const m = {}
      const boolKeys = ['enabled', 'autoCapture', 'nightlyTriage', 'notifyOnSessionStart']
      for (const key of boolKeys) {
        if (!(key in raw.memory)) continue
        if (typeof raw.memory[key] === 'boolean') m[key] = raw.memory[key]
        else errors[`memory.${key}`] = '必须为布尔值（true / false）'
      }
      if ('nightlyHour' in raw.memory) {
        const v = raw.memory.nightlyHour
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 23) m.nightlyHour = Math.trunc(v)
        else errors['memory.nightlyHour'] = '必须是 0..23 的整数'
      }
      if ('maxPending' in raw.memory) {
        const v = raw.memory.maxPending
        if (typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 5000) m.maxPending = Math.trunc(v)
        else errors['memory.maxPending'] = '必须是 1..5000 的整数'
      }
      if ('maxInjected' in raw.memory) {
        const v = raw.memory.maxInjected
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 500) m.maxInjected = Math.trunc(v)
        else errors['memory.maxInjected'] = '必须是 0..500 的整数'
      }
      if ('maxInjectedChars' in raw.memory) {
        const v = raw.memory.maxInjectedChars
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100000) {
          m.maxInjectedChars = Math.trunc(v)
        } else errors['memory.maxInjectedChars'] = '必须是 0..100000 的整数'
      }
      if ('defaultLayer' in raw.memory) {
        const v = raw.memory.defaultLayer
        if (MEMORY_LAYERS.includes(v)) m.defaultLayer = v
        else errors['memory.defaultLayer'] = `必须是 ${MEMORY_LAYERS.join(' / ')} 之一`
      }
      if (Object.keys(m).length > 0) patch.memory = m
    }
  }

  if ('presets' in raw) {
    const { value, error } = validatePresetsStructurally(raw.presets)
    if (error) errors.presets = error
    else patch.presets = value
  }

  return { patch, errors }
}

/** 把错误表渲染成一行人类可读文案。 */
export function formatFieldErrors(errors) {
  return Object.entries(errors).map(([k, v]) => `${k}：${v}`).join('；')
}

/**
 * 自建预设的**结构**校验（字段语义校验在 lib/presets.mjs，避免循环引用）。
 * 这里只保证写进配置的东西结构可读：每条有非空 name 与纯字符串的 fields。
 */
function validatePresetsStructurally(raw) {
  if (!Array.isArray(raw)) return { error: '必须是数组' }
  if (raw.length > PRESET_ARRAY_LIMIT) return { error: `最多 ${PRESET_ARRAY_LIMIT} 条` }
  const value = []
  for (const [index, item] of raw.entries()) {
    if (!isPlainObject(item)) return { error: `第 ${index + 1} 条不是对象` }
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (!name) return { error: `第 ${index + 1} 条缺少 name` }
    if (name.length > PRESET_NAME_MAX) return { error: `第 ${index + 1} 条 name 超过 ${PRESET_NAME_MAX} 字符` }
    const fields = {}
    if (item.fields !== undefined) {
      if (!isPlainObject(item.fields)) return { error: `第 ${index + 1} 条的 fields 不是对象` }
      for (const [key, val] of Object.entries(item.fields)) {
        if (FORBIDDEN_KEYS.has(key)) return { error: `第 ${index + 1} 条含禁用字段名 ${key}` }
        if (typeof val !== 'string') return { error: `第 ${index + 1} 条的 ${key} 必须是字符串` }
      }
      Object.assign(fields, item.fields)
    }
    value.push({
      id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `custom:${name}`,
      name,
      description: typeof item.description === 'string' ? item.description.trim() : '',
      fields,
      custom: true,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString()
    })
  }
  return { value }
}

// ==================== 迁移与归一 ====================

/**
 * 自建预设的浅归一（迁移期用）：只保证结构可读，不判枚举合法性。
 * 字段值全部收成字符串——非字符串直接丢弃，避免下游 prompt 拼装拿到对象。
 */
function normalizePresetsShallow(raw) {
  const out = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (!name || name.length > 40) continue
    const fields = {}
    if (isPlainObject(item.fields)) {
      for (const [key, value] of Object.entries(item.fields)) {
        if (FORBIDDEN_KEYS.has(key)) continue
        if (typeof value !== 'string') continue
        const text = value.trim()
        if (text) fields[key] = text
      }
    }
    out.push({
      id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `custom:${name}`,
      name,
      description: typeof item.description === 'string' ? item.description.trim() : '',
      fields,
      custom: true,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString()
    })
    if (out.length >= 50) break
  }
  return out
}

/** 深合并 memory 子对象并回退脏数据。 */
export function migrateConfig(raw) {
  const base = { ...DEFAULT_CONFIG }
  const input = isPlainObject(raw) ? raw : {}
  const out = { ...base }

  for (const key of ['enabled', 'workspaceOverridesEnabled']) {
    if (typeof input[key] === 'boolean') out[key] = input[key]
  }

  // 只接受单段目录名（不含路径分隔符）：它是拼在工作区路径后面的。
  // 不做任何「旧默认值 → 新默认值」的归一 —— 插件未发布，没有需要兼容的存量配置。
  if (typeof input.workspaceFileDir === 'string' && input.workspaceFileDir.trim()
      && !/[\\/]/.test(input.workspaceFileDir)) {
    out.workspaceFileDir = input.workspaceFileDir.trim()
  }

  for (const key of TEXT_FIELDS) {
    if (typeof input[key] === 'string') {
      const text = input[key].trim()
      out[key] = text.length > FIELD_LIMITS[key] ? text.slice(0, FIELD_LIMITS[key]) : text
    }
  }

  // 原枚举字段（v2 及更早）的键 → 文案。必须放在上面的 TEXT_FIELDS 循环**之后**：
  // 那个循环已把旧键原样搬进 out，这里负责把 'professional' 换成对应的一句话。
  // 两步分开写而不是让循环里分叉，是因为「搬运」与「翻译」是两件独立的事 ——
  // 循环只回答「这个值该不该留」，翻译只回答「留哪个值」。
  //
  // 不命中的情况（用户自己写的句子）原样保留：这正是 v3 之后的主要形态。
  for (const key of FORMER_ENUM_FIELDS) {
    const translated = translateWording(key, out[key])
    if (translated !== null) out[key] = translated
  }
  // 枚举字段：脏值静默回退到默认（迁移路径要宽容，与 sanitize 的严格形成对照）。
  // v3 起这里只剩光轨两项。
  for (const [key, allowed] of Object.entries(ENUM_FIELDS)) {
    if (typeof input[key] === 'string' && allowed.includes(input[key])) out[key] = input[key]
  }

  // 工具确认门槛 + 光轨：脏值静默回退（同上，迁移期宽容）
  for (const key of ['requireToolConfirmation', 'trailEnabled']) {
    if (typeof input[key] === 'boolean') out[key] = input[key]
  }
  if (typeof input.trailColor === 'string' && TRAIL_COLOR_PATTERN.test(input.trailColor.trim())) {
    out.trailColor = input.trailColor.trim().toUpperCase()
  }

  // 自建预设：只做**结构化**归一，不做全量校验。
  // 刻意不 import lib/presets.mjs —— 那个模块反过来 import 本模块的枚举常量，
  // 会造成循环引用；且迁移期本就该宽容（坏条目丢弃，不因一条脏数据让整份配置读不出来）。
  // 全量校验由写入路径（POST /api/anima/presets）负责，那里报错才有意义。
  if (Array.isArray(input.presets)) out.presets = normalizePresetsShallow(input.presets)

  out.memory = { ...base.memory }
  if (isPlainObject(input.memory)) {
    for (const key of ['enabled', 'autoCapture', 'nightlyTriage', 'notifyOnSessionStart']) {
      if (typeof input.memory[key] === 'boolean') out.memory[key] = input.memory[key]
    }
    out.memory.nightlyHour = clampInt(input.memory.nightlyHour, 0, 23, base.memory.nightlyHour)
    out.memory.maxPending = clampInt(input.memory.maxPending, 1, 5000, base.memory.maxPending)
    out.memory.maxInjected = clampInt(input.memory.maxInjected, 0, 500, base.memory.maxInjected)
    // 下面两项与上面三项同在 sanitizeConfig 的写入白名单里，读取路径必须一并搬。
    // 漏搬的后果不是「读不出来」而是「静默改回默认值」—— 用户设的字符预算会在
    // 下一次读配置时消失，且因为写入路径认得它，设置页连报错都没有。
    out.memory.maxInjectedChars = clampInt(input.memory.maxInjectedChars, 0, 100000, base.memory.maxInjectedChars)
    if (MEMORY_LAYERS.includes(input.memory.defaultLayer)) {
      out.memory.defaultLayer = input.memory.defaultLayer
    }
  }

  return out
}

/**
 * 校验工作区覆盖文件的内容。
 * @returns {{overrides: object, errors: Record<string,string>}}
 *   只保留 OVERRIDABLE_FIELDS 中「非空字符串」的字段；
 *   空串表示「本工作区不覆盖该字段」，不写入 overrides。
 */
export function sanitizeOverrides(raw) {
  const overrides = {}
  const errors = {}
  if (!isPlainObject(raw)) return { overrides, errors: { _: '覆盖文件必须是一个 JSON 对象' } }

  // 兼容两种写法：{ overrides: {...} } 或直接 {...}
  const body = isPlainObject(raw.overrides) ? raw.overrides : raw

  for (const key of OVERRIDABLE_FIELDS) {
    if (FORBIDDEN_KEYS.has(key)) continue
    if (!(key in body)) continue
    const value = body[key]

    if (typeof value !== 'string') {
      errors[key] = '必须为字符串'
      continue
    }
    const text = value.trim()
    if (!text) continue // 空串 = 不覆盖（继承全局）

    // 旧版覆盖文件里存的是档位键（'casual' / 'more'），翻译成文案再落。
    // 不做这一步的话，覆盖文件里的 'casual' 会被当成用户手写的一句英文语气说明
    // 原样注入提示词 —— 用户升级后会看到行为变了但界面显示的是自己没写过的字样。
    //
    // 一个刻意的语义取舍：老文件里写 `headingLists: 'default'`（显式选「默认」档）
    // 翻译后是空串，于是被当成「本工作区不覆盖」而改为继承全局值。这是 v3 的必然结果
    // —— 自由文本模型里没有「显式的不约束」这个状态，空就是继承，与其余文本字段一致。
    const translated = translateWording(key, text)
    const final = translated === null ? text : translated
    if (!final) continue

    if (final.length > FIELD_LIMITS[key]) {
      errors[key] = `长度超过上限 ${FIELD_LIMITS[key]} 字符（当前 ${final.length}）`
      continue
    }
    overrides[key] = final
  }

  return { overrides, errors }
}

// ==================== 两级合并 ====================

/**
 * field-level merge：全局值打底，工作区只覆盖它明确声明的字段。
 * @param {object} globalConfig 已 migrate 的全局配置
 * @param {object|null} overrides 已 sanitize 的工作区覆盖（可为 null）
 * @returns {{effective: object, sources: Record<string,'global'|'workspace'>}}
 */
export function mergePersona(globalConfig, overrides) {
  const effective = {}
  const sources = {}
  for (const key of OVERRIDABLE_FIELDS) {
    const local = overrides && typeof overrides[key] === 'string' ? overrides[key] : ''
    if (local) {
      effective[key] = local
      sources[key] = 'workspace'
    } else {
      effective[key] = globalConfig[key] ?? ''
      sources[key] = 'global'
    }
  }
  return { effective, sources }
}

export { FORBIDDEN_KEYS, isPlainObject }
