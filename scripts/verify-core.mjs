// scripts/verify-core.mjs — 纯函数回归（不需要 DSH 宿主）
//
// 运行：node scripts/verify-core.mjs
// 退出码：0 全通过；1 有失败。

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// lib/store.mjs 会动态 import 两个宿主内建包：@deepseek-ai/dsh-storage-domain 与 zod。
// 前者只存在于宿主 asar 里，源码目录解析不到；这一点由 smoke-host 与 check-live 各自覆盖。
// 这里用替身换掉它，让「惰性解析」那组用例能真正跑到 open() 分支。
// zod 已经在源码目录装好（package.json 的 dependencies），无需替身。
register('./tools-loader.mjs', import.meta.url)

import {
  DEFAULT_CONFIG,
  OVERRIDABLE_FIELDS,
  TRAIL_COLOR_PATTERN,
  TRAIL_SPEED_VALUES,
  TRAIL_WIDTH_VALUES,
  mergePersona,
  migrateConfig,
  sanitizeConfig,
  sanitizeOverrides
} from '../lib/config.mjs'
import {
  compileDisabledNotice,
  compileIdentity,
  compileInstructions,
  compileMemory,
  compilePendingNotice,
  compilePersona,
  compileRules,
  compileStyle,
  compileUserProfile
} from '../lib/prompt.mjs'
import {
  FIELD_EXAMPLES,
  WORDING_TABLES,
  translateWording
} from '../lib/wording.mjs'
import {
  BUILTIN_PRESETS,
  applyPreset,
  findActivePreset,
  listPresets,
  resolvePreset,
  sanitizeCustomPreset,
  sanitizeCustomPresets
} from '../lib/presets.mjs'
import {
  contentDigest,
  findCredentials,
  groupByStatus,
  makeCandidate,
  selectForInjection,
  triage
} from '../lib/memory.mjs'
import {
  readOverrides,
  resolveOverridesFromCwdSync,
  writeOverrides
} from '../lib/workspace.mjs'
import {
  IMPORT_MAX_ITEMS,
  IMPORT_MAX_SOURCE,
  IMPORT_MIN_ITEM,
  IMPORT_PROMPT_FULL,
  findImportOverlaps,
  parseImport,
  splitImportedText,
  suggestLayer
} from '../lib/import.mjs'
import { StateStore } from '../lib/store.mjs'
import {
  AUDIT_ACTORS,
  AUDIT_MAX_RECORDS,
  AUDIT_SOURCE_TEXT,
  AUDIT_VALUE_MAX,
  auditValue,
  buildAuditChanges,
  makeAuditEntry,
  normalizeActor,
  shortTime,
  summarizeAudit,
  trimAudit
} from '../lib/audit.mjs'

let passed = 0
const failures = []
// async 测试串行执行：它们会改 process.env（如 DSH_HOME）并操作临时目录，
// 若按旧写法「调用即发出」地并发跑，彼此的环境会互相覆盖，
// 而且结果落在汇总行之后 —— 表现为「已 PASSED 却又冒出 FAIL」。
const asyncQueue = []

function record(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => { passed += 1; console.log(`  ok   ${name}`) },
      (err) => { failures.push([name, err]); console.log(`  FAIL ${name}\n       ${err?.message || err}`) }
    )
}

function test(name, fn) {
  if (fn.constructor?.name === 'AsyncFunction') {
    asyncQueue.push(() => record(name, fn))
    return undefined
  }
  try {
    const r = fn()
    if (r && typeof r.then === 'function') {
      asyncQueue.push(() => record(name, () => r))
      return undefined
    }
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push([name, err])
    console.log(`  FAIL ${name}\n       ${err?.message || err}`)
  }
  return undefined
}

/**
 * 按顺序跑完并清空排队的 async 测试。
 * 必须清空：否则每次 drain 都会把同一批用例重跑一遍，passed 计数翻倍。
 */
async function drainAsyncTests() {
  while (asyncQueue.length > 0) {
    const run = asyncQueue.shift()
    await run()
  }
}

/**
 * 打印小节标题。必须先冲掉队列里已排的 async 测试再打印，
 * 否则它们的 ok/FAIL 行会落到后面某个小节标题下方，看起来像是别的用例在失败。
 */
async function section(name) {
  await drainAsyncTests()
  console.log(`\n[${name}]`)
}

// ==================== config ====================

await section('config')

test('migrateConfig 空输入回退默认', () => {
  const c = migrateConfig(null)
  assert.equal(c.enabled, true)
  assert.equal(c.agentName, '')
  assert.equal(c.memory.nightlyHour, DEFAULT_CONFIG.memory.nightlyHour)
})

test('migrateConfig 回退脏数据而不抛错', () => {
  const c = migrateConfig({
    enabled: 'yes',
    agentName: 42,
    memory: { nightlyHour: 99, maxPending: -5, enabled: false }
  })
  assert.equal(c.enabled, true, 'enabled 非布尔应回退')
  assert.equal(c.agentName, '', 'agentName 非字符串应回退')
  assert.equal(c.memory.nightlyHour, DEFAULT_CONFIG.memory.nightlyHour, '99 越界应钳回')
  assert.equal(c.memory.maxPending, DEFAULT_CONFIG.memory.maxPending, '-5 越界应钳回')
  assert.equal(c.memory.enabled, false, '合法布尔应保留')
})

// 迁移的核心承诺：升级插件不等于「偷偷把用户的风格改回默认」。
// v2 存的是档位键（'professional'），v3 存的是文案；升级后注入提示词的内容
// 必须一字不变，否则用户会发现自己没动过的设置变了。
test('migrateConfig 把旧枚举键翻译成文案，注入内容一字不变', () => {
  const legacy = migrateConfig({
    style: 'roast',
    headingLists: 'more',
    emoji: 'default',
    tables: 'less',
    replyLength: 'concise',
    language: 'en'
  })
  assert.match(legacy.style, /毒舌吐槽/)
  assert.match(legacy.headingLists, /多用标题与列表/)
  assert.equal(legacy.emoji, '', 'default 应翻译成空串（提示词里等于不提这件事）')
  assert.match(legacy.tables, /避免使用表格/)
  assert.match(legacy.replyLength, /直击要点/)
  assert.equal(legacy.language, 'Reply in English.')

  // 迁移后的配置再走一次 sanitize（写入路径）必须原样通过 ——
  // 翻译出的文案要是超过字段上限，用户一改任何别的字段就会被拒。
  const { errors, patch } = sanitizeConfig({
    style: legacy.style,
    headingLists: legacy.headingLists,
    emoji: legacy.emoji,
    tables: legacy.tables,
    replyLength: legacy.replyLength,
    language: legacy.language
  })
  assert.deepEqual(errors, {})
  assert.equal(patch.style, legacy.style)
})

test('migrateConfig 不碰用户自己写的风格句子', () => {
  // v3 之后的主要形态：字段里存的就是用户写的原话。
  // 它不能命中任何档位键，于是必须原样保留 —— 哪怕这句话碰巧很文艺。
  const mine = '先给结论，别绕弯子，也别用「首先其次」。'
  const migrated = migrateConfig({ style: mine, replyLength: '两三句就够' })
  assert.equal(migrated.style, mine)
  assert.equal(migrated.replyLength, '两三句就够')
})

// 回归：migrateConfig 曾漏搬 maxInjectedChars / defaultLayer —— 写入路径
// （sanitizeConfig）认得它们，读取路径却把它们丢回默认值。症状是「设置页上改了、
// 保存成功、重新打开又变回去」，且因为写入合法，全程没有任何报错可循。
test('migrateConfig 保留 memory 全部可写字段（读写白名单必须一致）', () => {
  const written = {
    memory: {
      enabled: false,
      autoCapture: false,
      nightlyTriage: false,
      nightlyHour: 7,
      maxPending: 300,
      maxInjected: 12,
      maxInjectedChars: 1234,
      notifyOnSessionStart: false,
      defaultLayer: 'workspace'
    }
  }
  const { patch, errors } = sanitizeConfig(written)
  assert.deepEqual(errors, {}, '这些值都该被写入路径接受')
  const readBack = migrateConfig(patch)
  for (const [key, expected] of Object.entries(written.memory)) {
    assert.equal(readBack.memory[key], expected, `memory.${key} 存进去后必须读得回来`)
  }
})

test('migrateConfig 对 memory 新字段同样宽容', () => {
  const c = migrateConfig({ memory: { maxInjectedChars: '很多', defaultLayer: 'galaxy' } })
  assert.equal(c.memory.maxInjectedChars, DEFAULT_CONFIG.memory.maxInjectedChars, '非数字应回退')
  assert.equal(c.memory.defaultLayer, DEFAULT_CONFIG.memory.defaultLayer, '非法层级应回退')
  assert.equal(migrateConfig({ memory: { maxInjectedChars: 0 } }).memory.maxInjectedChars, 0,
    '0 是合法的「不限」，不能被当成假值丢掉')
  assert.equal(migrateConfig({ memory: { maxInjectedChars: 999999 } }).memory.maxInjectedChars,
    DEFAULT_CONFIG.memory.maxInjectedChars, '越界应钳回')
})

test('sanitizeConfig 拒绝越界长度', () => {
  const { patch, errors } = sanitizeConfig({ agentName: 'x'.repeat(51) })
  assert.deepEqual(patch, {})
  assert.match(errors.agentName, /长度超过上限 50/)
})

test('sanitizeConfig 拒绝含路径分隔符的工作区目录名', () => {
  const { errors } = sanitizeConfig({ workspaceFileDir: 'a/b' })
  assert.match(errors.workspaceFileDir, /单段目录名/)
  const { errors: e2 } = sanitizeConfig({ workspaceFileDir: '..' })
  assert.ok(e2.workspaceFileDir)
})

test('migrateConfig 存放工作区覆盖目录名，且不做任何旧值归一', () => {
  // 用户填什么就用什么 —— 插件未发布，没有「旧默认值」这种东西需要兼容。
  assert.equal(migrateConfig({ workspaceFileDir: '.dsh-my-own' }).workspaceFileDir, '.dsh-my-own',
    '用户自己填的目录名必须原样保留')
  assert.equal(migrateConfig({ workspaceFileDir: '  .dsh-my-own  ' }).workspaceFileDir, '.dsh-my-own',
    '读入时应 trim')
  assert.equal(migrateConfig({}).workspaceFileDir, DEFAULT_CONFIG.workspaceFileDir,
    '没填时用默认值')
})

test('sanitizeConfig 接受合法补丁并 trim', () => {
  const { patch, errors } = sanitizeConfig({ agentName: '  小沃  ', memory: { nightlyHour: 4 } })
  assert.deepEqual(errors, {})
  assert.equal(patch.agentName, '小沃')
  assert.equal(patch.memory.nightlyHour, 4)
})

test('sanitizeOverrides 只保留非空可覆盖字段', () => {
  const { overrides, errors } = sanitizeOverrides({
    agentName: '项目专用名',
    agentRole: '',
    addressUserAs: '   ',
    enabled: false
  })
  assert.deepEqual(errors, {})
  assert.deepEqual(overrides, { agentName: '项目专用名' })
  assert.equal('enabled' in overrides, false, 'enabled 不是可覆盖字段')
})

test('sanitizeOverrides 兼容 { overrides: {...} } 包装', () => {
  const { overrides } = sanitizeOverrides({ overrides: { agentRole: '角色A' } })
  assert.deepEqual(overrides, { agentRole: '角色A' })
})

test('mergePersona 工作区只覆盖它声明的字段', () => {
  const globalConfig = migrateConfig({ agentName: '全局名', agentRole: '全局角色', addressUserAs: '老大' })
  const { effective, sources } = mergePersona(globalConfig, { agentRole: '工作区角色' })
  assert.equal(effective.agentName, '全局名')
  assert.equal(effective.agentRole, '工作区角色')
  assert.equal(effective.addressUserAs, '老大')
  // 逐字段断言而非整体 deepEqual：合并结果覆盖全部 OVERRIDABLE_FIELDS，
  // 整体比对会在每次新增字段时无意义地失败一次。
  assert.equal(sources.agentName, 'global')
  assert.equal(sources.agentRole, 'workspace')
  assert.equal(sources.addressUserAs, 'global')
  for (const key of OVERRIDABLE_FIELDS) {
    assert.equal(sources[key], key === 'agentRole' ? 'workspace' : 'global', `${key} 来源判定错误`)
  }
})

test('mergePersona 无覆盖时全走全局', () => {
  const globalConfig = migrateConfig({ agentName: '全局名' })
  const { effective, sources } = mergePersona(globalConfig, null)
  assert.equal(effective.agentName, '全局名')
  assert.equal(sources.agentName, 'global')
})

// ==================== memory ====================

await section('memory')

test('makeCandidate 拒绝空内容与超长内容', () => {
  assert.equal(makeCandidate({ text: '   ' }).ok, false)
  assert.equal(makeCandidate({ text: 'x'.repeat(501) }).ok, false)
})

test('makeCandidate 归一化空白', () => {
  const r = makeCandidate({ text: '  多个   空格\n换行  ' })
  assert.equal(r.ok, true)
  assert.equal(r.record.text, '多个 空格 换行')
})

test('凭据闸门拒绝各类凭据形态', () => {
  const cases = [
    'sk-abcdefghijklmnopqrstuvwx',
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_abcdefghijklmnopqrstuvwxyz01',
    'api_key = abcdefghijklmnop1234',
    'client_secret: abcdefghijklmnop',
    '密码：hunter2',
    'Authorization: Bearer abcdefghijklmnopqrstuvwx',
    'postgres://user:pass@host:5432/db',
    'tk_abcdef12',
    'mdcg1.admin.abcdefghijklmnop.qrstuvwx'
  ]
  for (const text of cases) {
    assert.equal(findCredentials(text).length > 0, true, `应命中：${text}`)
    const r = makeCandidate({ text })
    assert.equal(r.ok, false, `应拒收：${text}`)
    assert.match(r.error, /凭据/)
  }
})

test('凭据闸门不误伤正常记忆', () => {
  const clean = [
    '用户偏好中文回复，术语保留英文原词。',
    '用户的 git 提交习惯是每次改完先跑测试。',
    '项目用 Node 22，禁止引入新依赖。',
    '用户名叫老大，AI 叫小沃。'
  ]
  for (const text of clean) {
    assert.deepEqual(findCredentials(text), [], `不应命中：${text}`)
    assert.equal(makeCandidate({ text }).ok, true, `不应拒收：${text}`)
  }
})

test('contentDigest 对大小写与空白不敏感', () => {
  assert.equal(contentDigest('Hello  World'), contentDigest('hello world'))
})

test('triage 丢弃与已采纳项重复的候选', () => {
  const adopted = { ...makeCandidate({ text: '用户偏好中文' }).record, status: 'adopted' }
  const dup = makeCandidate({ text: '用户偏好中文' }).record
  const fresh = makeCandidate({ text: '用户用 Windows' }).record
  const { toDiscard, kept, summary } = triage([adopted, dup, fresh], { maxPending: 10 })
  assert.equal(toDiscard.length, 1)
  assert.equal(toDiscard[0].id, dup.id)
  assert.deepEqual(kept.map((r) => r.text), ['用户用 Windows'])
  assert.equal(summary.duplicatesRemoved, 1)
})

test('triage 在缓冲区内去重', () => {
  const a = makeCandidate({ text: '同样的内容' }).record
  const b = { ...makeCandidate({ text: '同样的内容' }).record, id: 'm-other-1' }
  const { toDiscard, kept } = triage([a, b], { maxPending: 10 })
  assert.equal(toDiscard.length, 1)
  assert.equal(kept.length, 1)
})

test('triage 超限时按最早优先淘汰', () => {
  const records = []
  for (let i = 0; i < 5; i += 1) {
    records.push({
      ...makeCandidate({ text: `第 ${i} 条` }).record,
      id: `m-${i}`,
      capturedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString()
    })
  }
  const { toDiscard, kept, summary } = triage(records, { maxPending: 2 })
  assert.equal(kept.length, 2)
  assert.deepEqual(kept.map((r) => r.text), ['第 3 条', '第 4 条'])
  assert.equal(summary.overflowRemoved, 3)
})

test('triage 不动已采纳与已丢弃项', () => {
  const adopted = { ...makeCandidate({ text: 'A' }).record, status: 'adopted' }
  const discarded = { ...makeCandidate({ text: 'B' }).record, status: 'discarded' }
  const { kept, toDiscard } = triage([adopted, discarded], { maxPending: 1 })
  assert.deepEqual(kept, [])
  assert.deepEqual(toDiscard, [])
})

test('selectForInjection 只取已采纳且受上限约束', () => {
  const mk = (text, status, day) => ({
    ...makeCandidate({ text }).record,
    status,
    capturedAt: new Date(Date.UTC(2026, 0, day)).toISOString()
  })
  const records = [mk('旧', 'adopted', 1), mk('新', 'adopted', 3), mk('中', 'adopted', 2), mk('候选', 'pending', 4)]
  // 返回 {selected, decisions, dropped, budget}：selected 是要注入的记录，
  // decisions 覆盖每一条已采纳记忆（含未选中的），这是「注入可解释」的载体。
  assert.deepEqual(selectForInjection(records, 2).selected.map((r) => r.text), ['新', '中'])
  assert.deepEqual(selectForInjection(records, 0).selected, [])
  assert.equal(selectForInjection(records, 10).selected.length, 3)
})

test('groupByStatus 三态分组互不污染', () => {
  const mk = (text, status) => ({ ...makeCandidate({ text }).record, status })
  const g = groupByStatus([mk('a', 'pending'), mk('b', 'adopted'), mk('c', 'discarded'), mk('d', 'pending')])
  assert.equal(g.pending.length, 2)
  assert.equal(g.adopted.length, 1)
  assert.equal(g.discarded.length, 1)
})

// ==================== prompt ====================

await section('prompt')

test('compileIdentity 无配置时返回空串（不产生空 section）', () => {
  assert.equal(compileIdentity({}), '')
  assert.equal(compileIdentity({ agentName: '   ', agentRole: '' }), '')
})

test('compileIdentity 明确声明是助手自身而非用户', () => {
  // 称呼已移入「用户背景」段（compileUserProfile），身份段不再承载它 ——
  // 这两段的语义方向相反，混在一起正是最容易被模型读反的地方。
  const text = compileIdentity({ agentName: '小沃', agentRole: '研究助手', addressUserAs: '老大' })
  assert.match(text, /你自己/)
  assert.match(text, /不是用户的名字/)
  assert.match(text, /小沃/)
  assert.ok(!/老大/.test(text), '身份段不应出现对用户的称呼')
})

test('compileUserProfile 承载称呼与用户背景并带反向声明', () => {
  const text = compileUserProfile({ addressUserAs: '老大', userOccupation: '研究生', userBio: '做自然语言处理' })
  assert.match(text, /用户本人/)
  assert.match(text, /不要把用户的职业/)
  assert.match(text, /老大/)
  assert.match(text, /研究生/)
  assert.match(text, /自然语言处理/)
})

test('compileUserProfile 三字段全空时返回空串', () => {
  assert.equal(compileUserProfile({}), '')
  assert.equal(compileUserProfile({ addressUserAs: '  ', userOccupation: '', userBio: '' }), '')
})

test('compileStyle 把六个字段的原话逐条渲染出来', () => {
  // v3 起这六个字段存的就是注入用的文案本身，渲染层不做任何翻译。
  const text = compileStyle({
    style: '专业严谨，结论先行', headingLists: '多用列表', emoji: '少用表情',
    tables: '需要对比时用表格', replyLength: '两三句就够', language: '用中文回答'
  })
  assert.match(text, /风格与语调：专业严谨，结论先行/)
  assert.match(text, /- 多用列表/)
  assert.match(text, /- 少用表情/)
  assert.match(text, /- 需要对比时用表格/)
  assert.match(text, /回复长度：两三句就够/)
  assert.match(text, /语言：用中文回答/)
})

test('compileStyle 多行文案的续行缩进两格而不是变成裸行', () => {
  // 自由文本允许换行；不缩进的话第二行看起来像另一条独立的规定。
  const text = compileStyle({ style: '第一行\n第二行' })
  assert.match(text, /风格与语调：第一行\n {2}第二行/)
})

test('compileStyle 全空时返回空串而不是只有标题', () => {
  assert.equal(compileStyle({}), '')
  assert.equal(compileStyle({ style: '   ', headingLists: '' }), '')
})

test('compileInstructions 为空时返回空串', () => {
  assert.equal(compileInstructions({}), '')
  assert.equal(compileInstructions({ customInstructions: '   ' }), '')
  assert.match(compileInstructions({ customInstructions: '始终先给结论' }), /始终先给结论/)
})

test('compilePersona 按固定顺序拼接五段', () => {
  const text = compilePersona({
    agentName: '小沃', agentRole: '研究助手', addressUserAs: '老大',
    style: 'professional', replyLength: 'normal', language: 'zh',
    customInstructions: '先给结论'
  })
  const order = ['## 助手身份', '## 用户背景', '## 回复风格', '## 补充指令', '## 行动准则']
  let cursor = -1
  for (const marker of order) {
    const at = text.indexOf(marker)
    assert.ok(at > cursor, `段落顺序错误：${marker} 出现在 ${at}，应在 ${cursor} 之后`)
    cursor = at
  }
})

test('compileRules 恒定返回行动准则段（永不返回空串）', () => {
  // 这一段与用户填了什么无关：它规定的是「设定该怎么被执行」，
  // 而不是「你是谁」。一个字段没填也照样有意义。
  const text = compileRules()
  assert.match(text, /^## 行动准则/)
  assert.match(text, /长期配置/)
  assert.equal(compileRules(), text, '无参数，输出必须稳定')
})

test('compilePersona 全空时只剩行动准则段', () => {
  // style/language 等在 migrate 后有默认值，故用显式空对象验证「无任何可渲染内容」分支。
  // 关键断言是「那一段仍然在」：见 compileRules 的说明，它不依赖用户配置。
  const text = compilePersona({ style: undefined, language: undefined })
  assert.equal(text, compileRules(), '除行动准则外不应产生任何 section')
})

test('compileDisabledNotice 明确声明旧设定作废，且不带任何用户配置', () => {
  // 关闭插件时注入空串是错的：对话历史里还留着旧设定，
  // 什么都不说等于让模型继续按那套回答。必须显式撤销。
  const text = compileDisabledNotice()
  assert.match(text, /^## 助手人格设定已关闭/)
  assert.match(text, /不再适用/)
  // 关掉之后不许再出现用户填过的角色/称呼 —— 否则等于没关。
  const withConfig = compilePersona({ agentName: '小沃', addressUserAs: '老大' })
  assert.ok(!/小沃|老大/.test(text))
  assert.ok(withConfig.length > text.length)
})

test('compilePersona 中「助手身份」始终排在「用户背景」之前', () => {
  // 这条顺序是语义安全的一部分：先说清「这段说的是我」，再说「那段说的是用户」，
  // 反过来会让模型把紧随其后的用户背景当成自己的设定。
  const text = compilePersona({ agentName: '小沃', userBio: '用户是研究生' })
  assert.ok(text.indexOf('## 助手身份') < text.indexOf('## 用户背景'))
})

test('compileMemory 空数组返回空串', () => {
  assert.equal(compileMemory([]), '')
  assert.equal(compileMemory(null), '')
  const text = compileMemory([{ text: '用户偏好中文' }])
  assert.match(text, /已由用户采纳/)
  assert.match(text, /用户偏好中文/)
})

test('compilePendingNotice 无候选时返回空串', () => {
  assert.equal(compilePendingNotice(0), '')
  assert.match(compilePendingNotice(3), /3 条/)
})

// ==================== workspace ====================

await section('workspace')

await test('覆盖文件读写与同步解析（含子目录向上查找）', async () => {
  const base = await mkdtemp(join(tmpdir(), 'anima-'))
  try {
    const ws = join(base, 'proj')
    const sub = join(ws, 'src', 'deep')
    await mkdir(sub, { recursive: true })

    // 未写之前找不到
    assert.equal(resolveOverridesFromCwdSync(sub, '.dsh-anima'), null)

    await writeOverrides(ws, '.dsh-anima', { agentName: '项目名' })

    // 从子目录也能向上命中
    const hit = resolveOverridesFromCwdSync(sub, '.dsh-anima')
    assert.ok(hit, '子目录应向上命中')
    assert.equal(hit.workspacePath, ws)
    assert.equal(hit.overrides.agentName, '项目名')

    // 异步读一致
    const asyncRead = await readOverrides(ws, '.dsh-anima')
    assert.equal(asyncRead.exists, true)
    assert.equal(asyncRead.overrides.agentName, '项目名')

    // 覆盖非可覆盖字段被过滤
    const filtered = sanitizeOverrides({ agentName: 'A', nope: 'x' })
    assert.deepEqual(filtered.overrides, { agentName: 'A' })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

await test('损坏的覆盖文件不会让装配崩溃', async () => {
  const base = await mkdtemp(join(tmpdir(), 'anima-'))
  try {
    const ws = join(base, 'bad')
    const dir = join(ws, '.dsh-anima')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'override.json'), '{ 这不是 JSON', 'utf8')

    const hit = resolveOverridesFromCwdSync(ws, '.dsh-anima')
    assert.ok(hit, '损坏文件也应返回结构而不是抛错')
    assert.deepEqual(hit.overrides, {})
    assert.ok(hit.errors._, '应记录错误')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

// ==================== presets ====================

await section('presets')

test('内置预设 id 唯一且都有名字与描述', () => {
  const ids = new Set()
  for (const preset of BUILTIN_PRESETS) {
    assert.ok(preset.id.startsWith('builtin:'), `内置预设 id 应以 builtin: 开头：${preset.id}`)
    assert.ok(!ids.has(preset.id), `内置预设 id 重复：${preset.id}`)
    ids.add(preset.id)
    assert.ok(preset.name.trim(), `内置预设缺 name：${preset.id}`)
    assert.ok(preset.description.trim(), `内置预设缺 description：${preset.id}`)
  }
})

test('内置预设不替用户假设「助手名字」与「用户背景」', () => {
  // agentName 是用户自己的助手名字；userOccupation/userBio 描述用户本人。
  // 预设替用户预设这两类内容，会在用户没注意时把假设写进提示词。
  for (const preset of BUILTIN_PRESETS) {
    for (const forbidden of ['agentName', 'userOccupation', 'userBio', 'addressUserAs']) {
      assert.ok(!(forbidden in preset.fields), `内置预设 ${preset.id} 不应声明 ${forbidden}`)
    }
  }
})

test('内置预设的枚举字段值都合法', () => {
  for (const preset of BUILTIN_PRESETS) {
    const { errors } = sanitizeCustomPreset({ name: `测试-${preset.id}`, fields: preset.fields })
    assert.deepEqual(errors, {}, `内置预设 ${preset.id} 字段非法：${JSON.stringify(errors)}`)
  }
})

test('listPresets 内置在前、自建在后', () => {
  const all = listPresets([{ id: 'custom:甲', name: '甲', fields: {} }])
  assert.equal(all.length, BUILTIN_PRESETS.length + 1)
  assert.equal(all[0].id, BUILTIN_PRESETS[0].id)
  assert.equal(all[all.length - 1].id, 'custom:甲')
})

test('resolvePreset 支持按 id 与按名字，内置优先于同名自建', () => {
  const custom = [{ id: 'custom:x', name: '专业严谨', fields: { style: 'casual' } }]
  assert.equal(resolvePreset(custom, 'builtin:precise').id, 'builtin:precise')
  // 「专业严谨」既是内置名也有一条同名字自建 —— 内置优先
  assert.equal(resolvePreset(custom, '专业严谨').id, 'builtin:precise')
  assert.equal(resolvePreset(custom, 'custom:x').id, 'custom:x')
  assert.equal(resolvePreset(custom, '不存在'), null)
  assert.equal(resolvePreset(custom, ''), null)
})

test('applyPreset 只输出预设声明的非空字段', () => {
  const patch = applyPreset({ fields: { style: 'casual', agentName: '', agentRole: '   ', unknown: '忽略我' } })
  assert.deepEqual(patch, { style: 'casual' })
})

test('applyPreset 对空预设返回空补丁', () => {
  assert.deepEqual(applyPreset(null), {})
  assert.deepEqual(applyPreset({}), {})
  assert.deepEqual(applyPreset({ fields: {} }), {})
})

// ---- findActivePreset：把「现在用的是哪条预设」算出来 ----
// 预设是一次性套用的，配置里不留痕迹；只有按字段逐条比对才知道它还成不成立。

test('findActivePreset 在字段全部相符时命中，改掉任一个即失效', () => {
  const preset = { id: 'custom:甲', name: '甲', fields: { style: '专业严谨。', replyLength: '简洁。' } }
  const config = { style: '专业严谨。', replyLength: '简洁。', agentName: '小沃' }
  assert.equal(findActivePreset(config, [preset])?.id, 'custom:甲')
  // 手改一个被预设声明的字段 —— 徽标必须消失，否则它会一直举着「现在用的是甲」的牌子。
  assert.equal(findActivePreset({ ...config, style: '随你写' }, [preset]), null)
  // 改预设**没声明**的字段不算偏离：那条预设本来就没管过 agentName。
  assert.equal(findActivePreset({ ...config, agentName: '别的名字' }, [preset])?.id, 'custom:甲')
})

test('findActivePreset 多条命中时取更具体的那条', () => {
  // 「声明了两个字段的」比「只声明一个字段的」更能说明用户想用哪条。
  const narrow = { id: 'custom:窄', name: '窄', fields: { style: 'A' } }
  const wide = { id: 'custom:宽', name: '宽', fields: { style: 'A', replyLength: 'B' } }
  const config = { style: 'A', replyLength: 'B' }
  assert.equal(findActivePreset(config, [narrow, wide])?.id, 'custom:宽')
  // 顺序无关（不依赖「谁先被遍历到」）
  assert.equal(findActivePreset(config, [wide, narrow])?.id, 'custom:宽')
})

test('findActivePreset 不把「不声明字段的预设」算成命中', () => {
  // 空预设套用后一个字段都不改，等于什么都没做 —— 命中它会让设置页指着一条空壳说「在用」。
  assert.equal(findActivePreset({ style: 'A' }, [{ id: 'custom:空', name: '空', fields: {} }]), null)
  assert.equal(findActivePreset({ style: 'A' }, [{ id: 'custom:空', name: '空' }]), null)
})

test('findActivePreset 忽略预设里的非法键与空串值', () => {
  // sanitizePresetFields 已经滤过一遍，但介质里读回来的历史数据未必干净：
  // 用 applyPreset 归一化后再比，才不会因为一个多余的空串字段就判「没命中」。
  const preset = { id: 'custom:脏', name: '脏', fields: { style: 'A', agentName: '', unknown: 'x' } }
  assert.equal(findActivePreset({ style: 'A', agentName: '小沃' }, [preset])?.id, 'custom:脏')
})

test('findActivePreset 未命中或输入异常时返回 null 而不是抛错', () => {
  assert.equal(findActivePreset({ style: 'B' }, [{ id: 'custom:甲', name: '甲', fields: { style: 'A' } }]), null)
  assert.equal(findActivePreset(null, []), null)
  assert.equal(findActivePreset({}, null), null)
  assert.equal(findActivePreset({ style: 'A' }, [{ id: 'custom:甲', name: '甲', fields: { style: 'A' } }])?.id, 'custom:甲')
})

test('findActivePreset 默认候选来自内置 + 配置里的自建', () => {
  // 不传 presets 时自己去 listPresets 取：路由那边只拿到 config，不想再抄一份合并逻辑。
  const precise = BUILTIN_PRESETS.find((p) => p.id === 'builtin:precise')
  const config = { ...applyPreset(precise), presets: [] }
  assert.equal(findActivePreset(config)?.id, 'builtin:precise')
})

test('sanitizeCustomPreset 拒绝空名与重名内置', () => {
  assert.ok(sanitizeCustomPreset({ name: '  ' }).errors.name)
  assert.ok(sanitizeCustomPreset({ name: '专业严谨' }).errors.name, '与内置重名应被拒')
  const ok = sanitizeCustomPreset({ name: '我的档', fields: { style: 'casual' } })
  assert.equal(ok.errors.name, undefined)
  assert.equal(ok.preset.name, '我的档')
  assert.equal(ok.preset.custom, true)
})

test('sanitizeCustomPreset 只按长度与类型校验字段值', () => {
  // v3 起字段值是自由文本，「不存在的风格」就是一段合法文案。
  assert.equal(sanitizeCustomPreset({ name: '甲', fields: { style: '不存在的风格' } }).errors.style, undefined)
  assert.ok(sanitizeCustomPreset({ name: '甲', fields: { style: 'x'.repeat(801) } }).errors.style, '超过风格字段上限应报错')
  assert.ok(sanitizeCustomPreset({ name: '甲', fields: { style: 42 } }).errors.style, '非字符串应报错')
  assert.ok(sanitizeCustomPreset({ name: 'x'.repeat(41) }).errors.name)
})

test('sanitizeCustomPresets 丢弃坏条目但保留好条目', () => {
  const { presets, errors } = sanitizeCustomPresets([
    { name: '好档', fields: { style: '想怎么说就怎么说' } },
    { name: '' },
    { name: '坏档', fields: { style: 42 } }
  ])
  assert.equal(presets.length, 1)
  assert.equal(presets[0].name, '好档')
  assert.equal(errors.length, 2)
})

test('sanitizeCustomPresets 拒绝重复名与非数组', () => {
  const dup = sanitizeCustomPresets([
    { name: '重名档', fields: {} },
    { name: '重名档', fields: {} }
  ])
  assert.equal(dup.presets.length, 1)
  assert.equal(dup.errors.length, 1)
  assert.ok(sanitizeCustomPresets('不是数组').errors.length > 0)
})

test('预设写进配置后能原样读回（迁移路径不丢字段）', () => {
  const saved = sanitizeCustomPresets([{ name: '我的档', fields: { style: 'casual', replyLength: 'concise' } }]).presets
  const migrated = migrateConfig({ presets: saved })
  assert.equal(migrated.presets.length, 1)
  assert.equal(migrated.presets[0].name, '我的档')
  assert.equal(migrated.presets[0].fields.style, 'casual')
  assert.equal(migrated.presets[0].fields.replyLength, 'concise')
})

test('迁移路径丢弃结构损坏的预设而不让整份配置读不出来', () => {
  // 迁移期的语义是「最大化打捞」：能让配置读出来的部分一律保留。
  //   - 非对象条目、「无名字」条目 → 整条丢弃（缺名字的预设无法被用户选中）
  //   - 合法预设里某个字段值不是字符串 → 只丢那个字段，预设本身保留
  // 严格校验在写入路径（sanitizeConfig），那里才该整单拒绝。
  const migrated = migrateConfig({
    agentName: '小沃',
    presets: [
      { name: '好档', fields: { style: 'casual' } },
      { name: '' },
      'not-an-object',
      { name: '半坏档', fields: { style: 'casual', k: 123 } }
    ]
  })
  assert.equal(migrated.agentName, '小沃', '其余字段不应受预设脏数据影响')
  assert.equal(migrated.presets.length, 2, '好档与半坏档都应保留')
  assert.equal(migrated.presets[0].name, '好档')
  assert.equal(migrated.presets[1].name, '半坏档')
  assert.deepEqual(migrated.presets[1].fields, { style: 'casual' }, '非字符串字段值应被丢掉')
})

test('迁移路径对预设里的原型污染字段名免疫', () => {
  const migrated = migrateConfig({
    presets: [{ name: '坏档', fields: { __proto__: 'x', constructor: 'y', style: 'casual' } }]
  })
  const fields = migrated.presets[0].fields
  assert.deepEqual(Object.keys(fields), ['style'])
  assert.equal({}.polluted, undefined)
})

test('sanitizeConfig 接受合法预设并给出结构化补丁', () => {
  const { patch, errors } = sanitizeConfig({ presets: [{ name: '甲档', fields: { style: 'casual' } }] })
  assert.deepEqual(errors, {})
  assert.equal(patch.presets.length, 1)
  assert.equal(patch.presets[0].custom, true)
})

test('sanitizeConfig 拒绝结构性非法的预设', () => {
  assert.ok(sanitizeConfig({ presets: '不是数组' }).errors.presets)
  assert.ok(sanitizeConfig({ presets: [{ fields: {} }] }).errors.presets, '缺 name 应被拒')
  assert.ok(sanitizeConfig({ presets: [{ name: '甲', fields: { k: 1 } }] }).errors.presets, '非字符串字段值应被拒')
})

// ==================== 新增字段 ====================

await section('wording:档位文案与示例表')

test('档位文案表覆盖六个风格字段，键序即按钮排列序', () => {
  assert.deepEqual(
    Object.keys(WORDING_TABLES),
    ['style', 'headingLists', 'emoji', 'tables', 'replyLength', 'language']
  )
})

test('translateWording 命中档位键返回文案，键值反过来是空串也算命中', () => {
  assert.match(translateWording('style', 'roast'), /毒舌吐槽/)
  // 空串是合法翻译结果（三项特质的 default），不能用真值判断命中与否 ——
  // 用 `if (result)` 判会把 default 误判成「用户自己写的句子」，于是
  // 迁移旧配置时把档位键原样留在配置里，注入提示词的就是 'default' 这个词。
  assert.equal(translateWording('headingLists', 'default'), '')
  assert.notEqual(translateWording('headingLists', 'default'), null)
})

test('translateWording 对非档位值返回 null 而不是回退默认', () => {
  // 这句话是用户自己写的，不能被翻译成任何档位 —— 否则升级插件会等于
  // 「偷偷把用户的风格改回默认」。
  assert.equal(translateWording('style', '先给结论，别绕弯子'), null)
  assert.equal(translateWording('style', 42), null)
  // 真实字段名但没有档位表的字段
  assert.equal(translateWording('agentName', 'professional'), null)
})

test('示例表覆盖所有需要示例的字段，且一个示例都不为空串', () => {
  for (const [field, list] of Object.entries(FIELD_EXAMPLES)) {
    assert.ok(Array.isArray(list), `${field} 应是数组`)
    for (const item of list) {
      assert.equal(typeof item, 'string', `${field} 的示例应是字符串`)
      assert.ok(item.trim().length > 0, `${field} 里有空示例`)
    }
  }
  // agentName 刻意为空：按钮填一个名字进去用户很可能忘改，改用 placeholder。
  assert.deepEqual(FIELD_EXAMPLES.agentName, [])
  assert.ok(FIELD_EXAMPLES.agentRole.length >= 2)
  assert.ok(FIELD_EXAMPLES.userBio.length >= 2)
})

test('示例文案写成「明显属于别人的第一人称」而不是通用套话', () => {
  // 通用套话会被直接保存，然后长期误导模型；一看就知道要改的示例才会被改。
  // 判据：用户背景的示例里必须出现具体身份名词，而不是「我是一个 AI 用户」。
  assert.ok(FIELD_EXAMPLES.userBio.some((text) => /研究生|前端|技术岗/.test(text)), '用户背景示例缺少具体身份')
  // 补充指令的示例要教用户怎么分行 —— 这一段是多行文本，单行示例教不会分行。
  assert.ok(FIELD_EXAMPLES.customInstructions.some((text) => text.includes('\n')))
})

await section('config:新字段')

test('默认配置含全部人设字段且枚举默认值合法', () => {
  const { errors } = sanitizeConfig({
    style: DEFAULT_CONFIG.style,
    headingLists: DEFAULT_CONFIG.headingLists,
    emoji: DEFAULT_CONFIG.emoji,
    tables: DEFAULT_CONFIG.tables,
    replyLength: DEFAULT_CONFIG.replyLength,
    language: DEFAULT_CONFIG.language
  })
  assert.deepEqual(errors, {})
})

test('sanitizeConfig 对超长的风格字段报错而不是截断', () => {
  // v3 起 style 走 FIELD_LIMITS（800），不再有枚举白名单。
  assert.ok(sanitizeConfig({ style: 'x'.repeat(801) }).errors.style)
  assert.deepEqual(sanitizeConfig({ style: 'x'.repeat(800) }).errors, {})
})

test('sanitizeConfig 仍对光轨两项枚举做白名单校验', () => {
  // 光轨速率与粗细是给 CSS 用的键，必须是封闭集合。
  assert.ok(sanitizeConfig({ trailSpeed: '瞎写的速度' }).errors.trailSpeed)
  assert.ok(sanitizeConfig({ trailWidth: '瞎写的粗细' }).errors.trailWidth)
})

test('sanitizeConfig 校验新增文本字段的长度上限', () => {
  assert.ok(sanitizeConfig({ userBio: 'x'.repeat(501) }).errors.userBio)
  assert.deepEqual(sanitizeConfig({ userBio: 'x'.repeat(500) }).errors, {})
  assert.ok(sanitizeConfig({ customInstructions: 'x'.repeat(2001) }).errors.customInstructions)
})

test('新增字段可被工作区覆盖，且空串表示不覆盖', () => {
  const { overrides, errors } = sanitizeOverrides({ overrides: { style: '随你写', userBio: '', emoji: '少用表情' } })
  assert.deepEqual(errors, {})
  assert.deepEqual(overrides, { style: '随你写', emoji: '少用表情' })
})

test('工作区覆盖对风格字段只按长度把关', () => {
  const { overrides, errors } = sanitizeOverrides({ overrides: { style: '瞎写' } })
  assert.deepEqual(errors, {}, '自由文本下「瞎写」是合法内容')
  assert.equal(overrides.style, '瞎写')
  assert.ok(sanitizeOverrides({ overrides: { style: 'x'.repeat(801) } }).errors.style)
})

test('mergePersona 让工作区覆盖全局', () => {
  const globalConfig = migrateConfig({ style: '全局的说法' })
  const { effective, sources } = mergePersona(globalConfig, { style: '本工作区的说法' })
  assert.equal(effective.style, '本工作区的说法')
  assert.equal(sources.style, 'workspace')
  // 未覆盖的字段仍走全局
  assert.equal(effective.language, globalConfig.language)
  assert.equal(sources.language, 'global')
})

// ==================== 工具确认门槛与光轨（对照 dsh-soul） ====================

await section('config:确认门槛与光轨')

test('默认值：确认门槛关闭、光轨开启且颜色合法', () => {
  assert.equal(DEFAULT_CONFIG.requireToolConfirmation, false)
  assert.equal(DEFAULT_CONFIG.trailEnabled, true)
  assert.match(DEFAULT_CONFIG.trailColor, TRAIL_COLOR_PATTERN)
  assert.ok(TRAIL_SPEED_VALUES.includes(DEFAULT_CONFIG.trailSpeed))
  assert.ok(TRAIL_WIDTH_VALUES.includes(DEFAULT_CONFIG.trailWidth))
})

test('sanitizeConfig 接受布尔门槛，拒绝非布尔', () => {
  assert.equal(sanitizeConfig({ requireToolConfirmation: true }).patch.requireToolConfirmation, true)
  assert.equal(sanitizeConfig({ trailEnabled: false }).patch.trailEnabled, false)
  assert.ok(sanitizeConfig({ requireToolConfirmation: 'yes' }).errors.requireToolConfirmation)
  assert.ok(sanitizeConfig({ trailEnabled: 1 }).errors.trailEnabled)
})

test('sanitizeConfig 只收 #RRGGBB，且统一成大写落盘', () => {
  assert.equal(sanitizeConfig({ trailColor: '#aabbcc' }).patch.trailColor, '#AABBCC')
  assert.ok(sanitizeConfig({ trailColor: 'red' }).errors.trailColor)
  assert.ok(sanitizeConfig({ trailColor: '#abc' }).errors.trailColor, '三位简写不接受')
  assert.ok(sanitizeConfig({ trailColor: '#aabbccdd' }).errors.trailColor, '八位带 alpha 不接受')
})

test('光轨速度/粗细走枚举白名单', () => {
  assert.equal(sanitizeConfig({ trailSpeed: 'fast' }).patch.trailSpeed, 'fast')
  assert.equal(sanitizeConfig({ trailWidth: 'thick' }).patch.trailWidth, 'thick')
  assert.ok(sanitizeConfig({ trailSpeed: 'instant' }).errors.trailSpeed)
  assert.ok(sanitizeConfig({ trailWidth: 'fat' }).errors.trailWidth)
})

test('迁移路径：脏布尔与脏颜色静默回退到默认，不影响整份配置可读', () => {
  const migrated = migrateConfig({
    agentName: '小沃',
    requireToolConfirmation: 'yes',
    trailEnabled: 0,
    trailColor: 'not-a-color'
  })
  assert.equal(migrated.agentName, '小沃', '一个脏字段不该拖垮整份配置')
  assert.equal(migrated.requireToolConfirmation, DEFAULT_CONFIG.requireToolConfirmation)
  assert.equal(migrated.trailEnabled, DEFAULT_CONFIG.trailEnabled)
  assert.equal(migrated.trailColor, DEFAULT_CONFIG.trailColor)
})

test('迁移路径：合法颜色统一成大写', () => {
  assert.equal(migrateConfig({ trailColor: '#ff8800' }).trailColor, '#FF8800')
})

test('光轨与确认门槛不参与工作区覆盖', () => {
  // 一个是安全开关、一组是界面偏好，都不该因为换个工作区而悄悄换掉。
  const { overrides, errors } = sanitizeOverrides({
    overrides: { requireToolConfirmation: true, trailColor: '#FFFFFF', trailEnabled: false, agentName: '合法' }
  })
  assert.deepEqual(errors, {})
  assert.deepEqual(Object.keys(overrides), ['agentName'], '光轨/门槛不该出现在覆盖里')
})


/** 用临时 DSH_HOME 跑一组用例：DSH_HOME 决定插件的默认落盘位置。 */
async function withTempHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'anima-mig-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    return await fn(dir)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(dir, { recursive: true, force: true })
  }
}

// ==================== store:惰性解析 ====================
//
// dsh-storage-domain 的服务是在它自己的 `ctx.inject(backendServices, …)` 回调里
// **异步** provide 的，而本插件 apply 末尾那次 reload() 会立刻触发首次 _open()。
// 若在 apply 阶段一次性 ctx.get() 拿到 undefined 就固化下来，表现会是
// 「重启后存储后端无故退化」，而用户的配置读不出来。
//
// 现在的契约（与 dsh-checkpoint-rewind 的惰性解析一致 + 记忆化）：
//   - 不在 apply 阶段解析服务，首次真正使用时才 ctx.get()；
//   - 服务缺失 ⇒ 抛 StorageUnavailableError('storage-not-composed')，绝不换落盘点；
//   - 失败**不**记忆化 ⇒ 服务后来就绪时下一次调用能成；
//   - 成功才缓存 ⇒ 之后一律复用同一个域句柄。

await section('store:惰性解析')

/** 假 ctx：只为 openStorageBackend 提供 get / effect 两个原语。 */
function makeWaitCtx({ services = {}, effect } = {}) {
  return {
    get: (name) => services[name],
    effect: effect ?? (() => () => {})
  }
}

/** 一个能真正 open 成功的假域设施：按 spec.tables 建空表。 */
function makeOpenableDomain() {
  const opened = []
  return {
    opened,
    async open(spec) {
      opened.push(spec.name)
      const tables = new Map(Object.keys(spec.tables).map((name) => [name, new Map()]))
      return {
        name: spec.name,
        table: (name) => {
          const store = tables.get(name)
          return {
            get: (key) => store.get(key),
            put: async (key, value) => { store.set(key, value) },
            entries: () => store.entries(),
            get size() { return store.size }
          }
        },
        close: async () => {}
      }
    }
  }
}

test('服务缺失时抛出结构化错误，而不是静默退化到文件', async () => {
  await withTempHome(async () => {
    const store = new StateStore(makeWaitCtx(), { warn: () => {} })
    await assert.rejects(
      () => store.getConfig(),
      (err) => {
        assert.equal(err.code, 'storage-not-composed')
        assert.equal(err.statusCode, 503, '路由要能把它当 503 透出去')
        assert.match(err.message, /storage/, '文案里要带组合指引')
        return true
      }
    )
    assert.equal(store.srcKind, null, '不可用时不该自称任何后端')
    assert.equal(store.srcReason, 'storage-not-composed', '原因要能被 /state 读出来')
    assert.equal(store.ready, false)
  })
})

test('缺 open 方法的 storageDomain 同样判为未组合', async () => {
  await withTempHome(async () => {
    const store = new StateStore(makeWaitCtx({ services: { storageDomain: { 没有open: true } } }), { warn: () => {} })
    await assert.rejects(() => store.getConfig(), (err) => err.code === 'storage-not-composed')
  })
})

test('服务就绪时打开域并把 config/memories/meta 三张表都建起来', async () => {
  await withTempHome(async () => {
    const domain = makeOpenableDomain()
    const store = new StateStore(makeWaitCtx({ services: { storageDomain: domain } }), { warn: () => {} })

    const config = await store.getConfig()
    assert.equal(config.agentName, DEFAULT_CONFIG.agentName, '空域应回落到默认档')
    assert.equal(domain.opened[0], 'anima', '域名必须是下划线形式（宿主只收 ^[a-z][a-z0-9_]*$）')
    assert.equal(domain.opened.length, 1, `只应开这一个域，实际开了 ${domain.opened.length} 次`)
    assert.equal(store.srcKind, 'storage')
    assert.equal(store.srcReason, null)
    assert.equal(store.srcMessage, null)
    assert.equal(store.ready, true)
  })
})

test('首次失败不记忆化：服务后来就绪时下一次调用能成功', async () => {
  await withTempHome(async () => {
    const services = {}
    const store = new StateStore(makeWaitCtx({ services }), { warn: () => {} })

    await assert.rejects(() => store.getConfig(), (err) => err.code === 'storage-not-composed')
    assert.equal(store.srcReason, 'storage-not-composed')

    // 服务晚一会出现（真机里就是 dsh-storage-domain 的那个异步 provide）
    services.storageDomain = makeOpenableDomain()
    const config = await store.getConfig()

    assert.equal(store.ready, true, '就绪后应能打开')
    assert.equal(store.srcReason, null, '成功后要清掉上一次的原因')
    assert.equal(config.agentName, DEFAULT_CONFIG.agentName)
  })
})

test('成功路径记忆化：同一个 store 只 open 一次域', async () => {
  await withTempHome(async () => {
    const domain = makeOpenableDomain()
    const store = new StateStore(makeWaitCtx({ services: { storageDomain: domain } }), { warn: () => {} })

    await store.getConfig()
    await store.getConfig()
    await store.listMemories()
    assert.equal(domain.opened.length, 1, `域应只打开一次，实际 ${domain.opened.length} 次`)
  })
})

test('域打开失败时包成 open-failed 并保留原始 cause', async () => {
  await withTempHome(async () => {
    const boom = new Error("domain 'anima' was opened by another facility")
    const store = new StateStore(
      makeWaitCtx({ services: { storageDomain: { open: async () => { throw boom } } } }),
      { warn: () => {} }
    )

    await assert.rejects(
      () => store.getConfig(),
      (err) => {
        assert.equal(err.code, 'open-failed')
        assert.equal(err.cause, boom, '原始错误要留在 cause 里，否则排查时看不到真因')
        return true
      }
    )
    assert.equal(store.srcReason, 'open-failed')
  })
})

test('域句柄注册了 close disposer（卸载时不泄漏介质连接）', async () => {
  await withTempHome(async () => {
    let dispose
    const domain = makeOpenableDomain()
    const store = new StateStore(
      makeWaitCtx({ services: { storageDomain: domain }, effect: (factory) => { dispose = factory(); return () => {} } }),
      { warn: () => {} }
    )

    await store.getConfig()
    assert.equal(typeof dispose, 'function', '应通过 ctx.effect 注册 close')
    await dispose()
  })
})

test('未打开后端时 srcKind / srcReason / srcMessage 均为 null，不谎报原因', () => {
  const store = new StateStore(makeWaitCtx(), { warn: () => {} })
  assert.equal(store.srcKind, null)
  assert.equal(store.srcPath, null)
  assert.equal(store.srcReason, null)
  assert.equal(store.srcMessage, null)
  assert.equal(store.ready, false)
})

// 2026-10-10 的事故回归：resetConfig 当初把 presets 一并清空。
// 行为与 dsh-soul 的 defaultConfigPreservingPersonas 对齐 —— 预设是用户资产。
test('resetConfig 重置人设字段但保留用户自建预设', async () => {
  await withTempHome(async () => {
    const domain = makeOpenableDomain()
    const store = new StateStore(makeWaitCtx({ services: { storageDomain: domain } }), { warn: () => {} })
    await store.getConfig()

    const custom = [{ id: 'c1', name: '我的档', fields: { style: 'casual' } }]
    await store.updateConfig({ agentName: '小沃', addressUserAs: '老大', presets: custom })

    const { config: next, changed } = await store.resetConfig()
    assert.equal(next.agentName, DEFAULT_CONFIG.agentName, '人设字段应回到默认')
    assert.equal(next.agentRole, DEFAULT_CONFIG.agentRole)
    // 不比对整对象：migrateConfig 会给预设补 createdAt/custom/description 三个
    // 归一化字段。这里断言的是「那条资产还在」，不是它的内部形状。
    assert.equal(next.presets.length, 1, '用户自建预设必须留下')
    assert.equal(next.presets[0].id, 'c1')
    assert.equal(next.presets[0].name, '我的档')
    assert.deepEqual(next.presets[0].fields, { style: 'casual' })
    // 变更清单要一并交出来：调用方靠它决定是否向活动会话声明「旧设定作废」。
    assert.ok(changed.includes('agentName'), '被清掉的人设字段必须出现在变更清单里')
    assert.ok(changed.includes('addressUserAs'))
    assert.ok(!changed.includes('presets'), '预设原样保留，不该被算成变更')
  })
})

test('resetConfig 在用户没有自建预设时给出空数组而不是 undefined', async () => {
  await withTempHome(async () => {
    const domain = makeOpenableDomain()
    const store = new StateStore(makeWaitCtx({ services: { storageDomain: domain } }), { warn: () => {} })
    await store.getConfig()

    const { config: next } = await store.resetConfig()
    assert.ok(Array.isArray(next.presets), 'presets 必须始终是数组，客户端直接 .length 取用')
    assert.equal(next.presets.length, 0)
  })
})

// ==================== 人设变更审计日志（纯函数） ====================
// 这组测的是「记录本身是否可信」：同一个字段被改成不同值必须看得出差别，
// 取值取不到时必须落成 null 而不是 undefined（undefined 会被 JSON 丢掉）。
await section('audit')

test('normalizeActor 对未知取值一律降级为 system（不扩大信任面）', () => {
  assert.equal(normalizeActor('user'), 'user')
  assert.equal(normalizeActor('agent'), 'agent')
  assert.equal(normalizeActor('system'), 'system')
  // 下面这些都不该被当成合法来源
  for (const bad of ['admin', '', 'USER', null, undefined, 42, {}, []]) {
    assert.equal(normalizeActor(bad), 'system', `未知 actor ${String(bad)} 应降级`)
  }
})

test('auditValue 对超长字符串截断并标注原长', () => {
  const short = '短'
  assert.equal(auditValue(short), '短')
  const long = '长'.repeat(AUDIT_VALUE_MAX + 50)
  const out = auditValue(long)
  assert.ok(out.length < long.length, '应被截断')
  assert.match(out, /…（共 250 字）$/)
  assert.ok(out.startsWith('长'.repeat(AUDIT_VALUE_MAX)), '前缀应保留')
})

test('auditValue 对数组与对象只记规模（否则一条日志能塞满整张表）', () => {
  assert.equal(auditValue([1, 2, 3]), '[3 项]')
  assert.equal(auditValue({ a: 1, b: 2 }), '{2 个字段}')
  assert.equal(auditValue(null), null)
  assert.equal(auditValue(undefined), null)
  // 数字与布尔照原样保留：审计里最常见的「开关被关掉了」必须看得见
  assert.equal(auditValue(false), false)
  assert.equal(auditValue(0), 0)
})

test('buildAuditChanges 记录前后值（逐字段渲染，过滤职责在 diffConfig）', () => {
  const before = { agentName: '旧名', style: 'casual' }
  const after = { agentName: '新名', style: 'casual' }
  // 真正"哪些字段变了"由 diffConfig 判定；这里只负责把给定键渲染成前后值。
  // 刻意不在这里按值相等再过滤一次 —— 见下一条 presets 的用例。
  const changes = buildAuditChanges(before, after, ['agentName'])
  assert.equal(changes.length, 1)
  assert.equal(changes[0].key, 'agentName')
  assert.equal(changes[0].from, '旧名')
  assert.equal(changes[0].to, '新名')
})

test('buildAuditChanges 不按值相等过滤（presets 这类摘要值会相等但确实变了）', () => {
  // 预设是数组，auditValue 只记规模 ⇒ 换掉一个同长度的预设时 from === to === '[1 项]'。
  // 若当初在此按相等过滤，这一条真实变更就会被静默吞掉。
  const before = { presets: [{ name: '旧预设' }] }
  const after = { presets: [{ name: '新预设' }] }
  const changes = buildAuditChanges(before, after, ['presets'])
  assert.equal(changes.length, 1, '规模未变也必须记下来')
  assert.equal(changes[0].from, '[1 项]')
  assert.equal(changes[0].to, '[1 项]')
})

test('buildAuditChanges：新字段的 from 是 null 而不是 undefined', () => {
  // 这一条是真出过的 bug：直接取 source[key] 而没先判断，
  // 结果 undefined 在序列化时被整个丢掉，日志里只剩一个 to，看不出是新增还是清空。
  const changes = buildAuditChanges({}, { agentRole: '新角色' }, ['agentRole'])
  assert.equal(changes[0].from, null)
  assert.equal(changes[0].to, '新角色')
  assert.ok('from' in changes[0], 'from 必须显式存在（哪怕值为 null）')
  assert.equal(JSON.parse(JSON.stringify(changes[0])).from, null, '序列化后不能消失')
})

test('buildAuditChanges 拆开 memory.x 这类复合键', () => {
  const before = { memory: { enabled: true, maxInjectedChars: 800 } }
  const after = { memory: { enabled: false, maxInjectedChars: 800 } }
  const changes = buildAuditChanges(before, after, ['memory.enabled'])
  const change = changes.find((c) => c.key === 'memory.enabled')
  assert.ok(change, '应记下 memory.enabled')
  // 不拆键就会拿去查 before['memory.enabled'] ⇒ 永远是 undefined
  assert.equal(change.from, true)
  assert.equal(change.to, false)
  // 没被判定为变更的兄弟字段不该冒出来
  assert.ok(!changes.some((c) => c.key === 'memory.maxInjectedChars'))
})

test('buildAuditChanges 对不存在的键也给出 null 而不是抛错', () => {
  const changes = buildAuditChanges({ a: 1 }, { a: 2 }, ['a', 'b.c'])
  assert.equal(changes.length, 2)
  assert.equal(changes.find((c) => c.key === 'b.c').from, null)
  assert.equal(changes.find((c) => c.key === 'b.c').to, null)
})

test('makeAuditEntry：无变化不产生记录', () => {
  assert.equal(makeAuditEntry({ changes: [], actor: 'user', source: 'settings' }), null)
})

test('makeAuditEntry：id 唯一、时间可解析、actor 归一', () => {
  const changes = [{ key: 'agentName', from: 'a', to: 'b' }]
  const first = makeAuditEntry({ changes, actor: 'agent', source: 'tool' })
  const second = makeAuditEntry({ changes, actor: 'agent', source: 'tool' })
  assert.notEqual(first.id, second.id, '同一毫秒内两条记录的 id 也不能撞')
  assert.equal(first.actor, 'agent')
  assert.equal(first.source, 'tool')
  assert.ok(!Number.isNaN(Date.parse(first.at)))
  assert.match(first.id, /^a-[0-9a-z]+-[0-9a-z]+$/)
})

test('makeAuditEntry：未知 actor 落盘为 system（伪造来源不会写进日志）', () => {
  const entry = makeAuditEntry({ changes: [{ key: 'x', to: 'y' }], actor: 'root', source: 'tool' })
  assert.equal(entry.actor, 'system')
})

test('makeAuditEntry：空 note 不落字段，避免日志里一堆 note: 空串', () => {
  const withNote = makeAuditEntry({ changes: [{ key: 'x', to: 'y' }], source: 'settings', note: '  ' })
  assert.ok(!('note' in withNote), '纯空白 note 视同没有')
  const real = makeAuditEntry({ changes: [{ key: 'x', to: 'y' }], source: 'settings', note: '应用预设 严谨' })
  assert.equal(real.note, '应用预设 严谨')
})

test('trimAudit 超出上限时保留最新的（旧记录先走）', () => {
  const records = Array.from({ length: AUDIT_MAX_RECORDS + 30 }, (_, i) => ({
    id: `a-${i}`,
    at: new Date(2026, 0, 1, 0, 0, i).toISOString()
  }))
  // dropped 是**条数**而不是被丢弃的记录数组 —— store.appendAudit 按 `dropped > 0` 判断是否要删。
  const { kept, dropped } = trimAudit(records, AUDIT_MAX_RECORDS)
  assert.equal(kept.length, AUDIT_MAX_RECORDS)
  assert.equal(dropped, 30)
  assert.equal(typeof dropped, 'number')
  assert.equal(kept[kept.length - 1].id, `a-${records.length - 1}`, '最后一条（最新）必须留下')
  // 保留下来的必须是时间上最新的那一段，而不是随机 200 条
  assert.equal(kept[0].id, `a-${30}`, '最早那 30 条被淘汰')
})

test('trimAudit 未超上限时原样返回', () => {
  const records = [{ id: 'a-1', at: '2026-01-01T00:00:00.000Z' }]
  const { kept, dropped } = trimAudit(records, AUDIT_MAX_RECORDS)
  assert.equal(kept.length, 1)
  assert.equal(dropped, 0)
})

test('trimAudit 按时间排序而非插入顺序（介质读回来未必有序）', () => {
  const records = [
    { id: 'late', at: '2026-01-03T00:00:00.000Z' },
    { id: 'early', at: '2026-01-01T00:00:00.000Z' },
    { id: 'mid', at: '2026-01-02T00:00:00.000Z' }
  ]
  const { kept } = trimAudit(records, 2)
  assert.deepEqual(kept.map((r) => r.id), ['mid', 'late'])
})

test('trimAudit 容忍非数组输入', () => {
  assert.deepEqual(trimAudit(null, 10), { kept: [], dropped: 0 })
  assert.deepEqual(trimAudit(undefined, 10), { kept: [], dropped: 0 })
})

test('summarizeAudit 给出「时间 + 来源 + 字段名」，不含具体值', () => {
  const entry = makeAuditEntry({
    changes: [{ key: 'agentName', from: '旧名', to: '新名' }],
    actor: 'agent',
    source: 'tool'
  }, new Date('2026-10-11T06:05:00.000Z'))
  const line = summarizeAudit(entry)
  assert.match(line, /^\[\d\d-\d\d \d\d:\d\d\] 模型工具：/)
  assert.ok(line.includes('agentName'), '应列出被改的字段名')
  // 值可能很长，摘要行里只给字段名 —— 要看值去展开明细
  assert.ok(!line.includes('新名'), '摘要不应塞入具体值')
})

test('makeAuditEntry 把未知 source 归一成 other（不许伪造新入口）', () => {
  const entry = makeAuditEntry({ changes: [{ key: 'x', to: 'y' }], source: 'something-else' })
  assert.equal(entry.source, 'other')
  assert.ok(summarizeAudit(entry).includes('其他'))
})

test('summarizeAudit 对介质里读回的野生 source 原样显示而不是 undefined', () => {
  // 旧版本或手改过的记录可能带着表里没有的 source：显示原值便于发现新入口，
  // 唯一不能出现的是 undefined（那会让整行日志读起来像坏了）。
  const line = summarizeAudit({
    at: '2026-10-11T06:05:00.000Z',
    source: 'legacy-source',
    changes: [{ key: 'style' }]
  })
  assert.ok(line.includes('legacy-source'))
  assert.ok(!line.includes('undefined'))
})

test('summarizeAudit 对空 changes 与空 entry 都不抛错', () => {
  assert.equal(summarizeAudit(null), '')
  assert.equal(summarizeAudit(undefined), '')
  const line = summarizeAudit({ at: '2026-10-11T06:05:00.000Z', source: 'settings', changes: [] })
  assert.ok(line.includes('设置页'))
})

test('AUDIT_SOURCE_TEXT 覆盖全部已知写入入口', () => {
  // 这三个正是插件里真实存在的写入路径，漏一个日志就会显示成英文 key
  for (const source of ['settings', 'command', 'tool', 'proposal', 'preset', 'reset', 'memory']) {
    assert.ok(AUDIT_SOURCE_TEXT[source], `${source} 应有中文说明`)
  }
  assert.ok(AUDIT_SOURCE_TEXT.other, '归一化落点必须有中文，否则未知来源会显示成 other')
  assert.deepEqual(AUDIT_ACTORS, ['user', 'agent', 'system'])
})

test('审计上限是个有限正整数（无界日志最终会拖垮存储）', () => {
  assert.ok(Number.isInteger(AUDIT_MAX_RECORDS) && AUDIT_MAX_RECORDS > 0)
  assert.ok(Number.isInteger(AUDIT_VALUE_MAX) && AUDIT_VALUE_MAX > 0)
  assert.ok(AUDIT_VALUE_MAX <= 500, '单值上限过大就失去「不是备份」的意义')
})

test('shortTime 输出 MM-DD HH:mm', () => {
  assert.match(shortTime('2026-10-11T06:05:00.000Z'), /^\d\d-\d\d \d\d:\d\d$/)
})

// ==================== memory:导入外部 AI 记忆 ====================
//
// Phase ② 的核心风险不在「能不能切」，而在**切错了没人发现**：
// 一条被静默丢掉，用户只会觉得那边 AI 没写好，不会想到是我们吃掉了。
// 所以这一节的断言重点全在「什么东西被归到哪一类」。

await section('memory:导入')

test('splitImportedText 每个列表项成一条', () => {
  const out = splitImportedText('- 第一条偏好内容\n- 第二条偏好内容\n1. 第三条偏好内容')
  assert.deepEqual(out, ['第一条偏好内容', '第二条偏好内容', '第三条偏好内容'])
})

test('splitImportedText 小节标签不进候选，标题下的段落照常成条', () => {
  // 回归：曾把「## 沟通偏好」这类标签当条目收进来，缓冲区里会多出一批
  // 用户根本不会采纳的碎片，看起来像导入很脏。
  const out = splitImportedText('## 沟通偏好\n\n结论先行，不要绕。')
  assert.deepEqual(out, ['结论先行，不要绕。'])
  assert.ok(!out.some((s) => s === '沟通偏好'), '纯标签不该成条')
})

test('splitImportedText 带句读或足够长的标题本身算一条结论', () => {
  const out = splitImportedText('## 跨项目通用的沟通偏好，一律结论先行')
  assert.equal(out.length, 1, `带逗号的长标题应保留：${JSON.stringify(out)}`)
  assert.ok(out[0].includes('结论先行'))
})

test('splitImportedText 同段落内的多行合成一条（不按句号切）', () => {
  const out = splitImportedText('偏好：结论先行。\n不要绕弯子。')
  assert.equal(out.length, 1, `整段应是一条：${JSON.stringify(out)}`)
})

test('splitImportedText 空行分段、容忍 CRLF 与多余空白', () => {
  const out = splitImportedText('第一段内容\r\n\r\n\r\n第二段内容')
  assert.deepEqual(out, ['第一段内容', '第二段内容'])
})

test('suggestLayer：出现具体路径 ⇒ 建议仅本工作区', () => {
  assert.equal(suggestLayer('这个项目里 D:\\work\\a 用 pnpm').layer, 'workspace')
  assert.equal(suggestLayer('~/projects/x 下不要建子目录').layer, 'workspace')
})

test('suggestLayer：出现全局措辞 ⇒ 建议全局', () => {
  const r = suggestLayer('所有项目一律都要先给结论')
  assert.equal(r.layer, 'global')
  assert.equal(r.confidence, 'high')
})

test('suggestLayer：两者都有或都没有都落全局（默认层不能是「不生效」）', () => {
  // 默认 workspace 会让用户以为功能坏了（记忆都在、就是看不见）；
  // 先全局收下、由用户改成项目级，是唯一说得通的默认。
  const both = suggestLayer('所有项目都适用，比如 D:\\work\\a')
  assert.equal(both.layer, 'global')
  assert.equal(both.confidence, 'low', '冲突时不该给出高置信')
  const none = suggestLayer('喜欢简洁一点')
  assert.equal(none.layer, 'global')
  assert.ok(none.reason, '必须给理由，否则用户不知道它凭什么这么判')
})

test('parseImport：一条凭据命中即整条拦下，且不进 items', () => {
  const r = parseImport('- 我的 key 是 sk-abcdefghijklmnopqrstuvwxyz012345', [])
  assert.equal(r.counts.blocked, 1)
  assert.equal(r.counts.accepted, 0)
  assert.equal(r.items.length, 0, '凭据条绝不能出现在可入库清单里')
  assert.ok(r.blocked[0].credentials.length > 0, '要告诉用户命中了哪类凭据')
})

test('parseImport：与已有记忆重复的单独归类，不算错误', () => {
  const existing = [{ text: '结论先行，不要绕弯子。' }]
  const r = parseImport('- 结论先行，不要绕弯子。\n- 另一条全新的偏好内容', existing)
  assert.equal(r.counts.duplicates, 1)
  assert.equal(r.counts.accepted, 1)
  assert.equal(r.duplicates[0], '结论先行，不要绕弯子。')
})

test('parseImport：超长单条进 tooLong，不截断也不落盘', () => {
  // 截断会造出一条「前半句是用户的偏好、后半句断在半个词上」的记忆，
  // 比直接告诉他这条太长更糟。
  const r = parseImport(`- ${'啊'.repeat(600)}`, [])
  assert.equal(r.counts.tooLong, 1)
  assert.equal(r.items.length, 0)
  assert.equal(r.tooLong[0].length, 600, '原文要原样回给用户看')
})

test('parseImport：超出条数上限的进 overflow，不当成丢弃', () => {
  const body = Array.from({ length: 5 }, (_, i) => `- 第 ${i} 条足够长的记忆内容`).join('\n')
  const r = parseImport(body, [], { maxItems: 2 })
  assert.equal(r.counts.accepted, 2)
  assert.equal(r.counts.overflow, 3)
  assert.equal(r.overflow.length, 3, '溢出条目要回给用户，让他知道还有多少没进来')
})

test('parseImport：空输入与超长原文都给出可读错误', () => {
  assert.equal(parseImport('').ok, false)
  assert.equal(parseImport('   \n  ').ok, false)
  const huge = parseImport('x'.repeat(IMPORT_MAX_SOURCE + 1))
  assert.equal(huge.ok, false)
  assert.ok(huge.error.includes(String(IMPORT_MAX_SOURCE)), '错误里要写清上限是多少')
})

test('parseImport：入库的候选一律是 pending（导入不等于采纳）', () => {
  // 这是整个记忆层的根基：任何入口都不得直接写入已采纳状态。
  const r = parseImport('- 结论先行，不要绕弯子。', [])
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].record.status, 'pending')
  assert.equal(r.items[0].record.source, 'import', '来源要如实记成导入，便于事后追溯')
})

test('parseImport：归类建议带上 layer 与理由，两条都要给', () => {
  const r = parseImport('- 这个项目里 D:\\work\\a 用 pnpm 管理依赖', [], { cwd: 'd:/work/a' })
  assert.equal(r.items[0].suggested.layer, 'workspace')
  assert.ok(r.items[0].suggested.reason.length > 0)
  assert.equal(r.items[0].record.cwd, 'd:/work/a', '工作区级建议要把 cwd 一起写进记录')
})

test('parseImport：全局建议不写 cwd（免得被当成项目记忆筛掉）', () => {
  const r = parseImport('- 所有项目一律先给结论', [], { cwd: 'd:/work/a' })
  assert.equal(r.items[0].suggested.layer, 'global')
  assert.equal('cwd' in r.items[0].record, false)
})

test('parseImport：过短的碎片进 skipped，不计入候选也不报错', () => {
  // 切分本身不做长度过滤（那是 parseImport 的职责），两者分开才好各自断言。
  assert.deepEqual(splitImportedText('- a\n- 这是一条正常长度的记忆'),
    ['a', '这是一条正常长度的记忆'])
  const r = parseImport('- a\n- 这是一条正常长度的记忆', [])
  assert.equal(r.counts.skipped, 1)
  assert.equal(r.counts.accepted, 1)
  assert.ok(IMPORT_MIN_ITEM > 1 && IMPORT_MIN_ITEM < 20)
})

test('findImportOverlaps：在待审缓冲区里认出「其实说的是同一件事」', () => {
  const imported = [{ text: '结论先行，不要绕弯子，也不需要客套话' }]
  const pending = [{ id: 'p1', text: '结论先行，不要绕弯子，也别客套' }, { id: 'p2', text: '完全无关的另一件事' }]
  const out = findImportOverlaps(imported, pending, { threshold: 0.5 })
  assert.equal(out.length, 1)
  assert.equal(out[0].pendingId, 'p1')
  assert.ok(out[0].similarity >= 0.5)
})

test('IMPORT_PROMPT_FULL 要求保留用户原话（改写过的偏好没有价值）', () => {
  // 别的模型把「别跟我绕」改写成「偏好简洁的沟通风格」，
  // 人设层最需要的口吻就没了 —— 这一句是整个提示词里最关键的约束。
  assert.ok(IMPORT_PROMPT_FULL.includes('不要过度改写'))
  assert.ok(IMPORT_PROMPT_FULL.includes('个人使用画像'))
  assert.ok(IMPORT_PROMPT_FULL.includes('- '), '要给出可被切分识别的输出格式')
})

test('导入的常量彼此自洽（限额为正、且条数上限不是「无限」）', () => {
  assert.ok(Number.isInteger(IMPORT_MAX_ITEMS) && IMPORT_MAX_ITEMS > 0 && IMPORT_MAX_ITEMS <= 500)
  assert.ok(Number.isInteger(IMPORT_MAX_SOURCE) && IMPORT_MAX_SOURCE >= 1000)
})

// ==================== 汇总 ====================

await drainAsyncTests()

console.log('')
if (failures.length > 0) {
  console.log(`FAILED ${failures.length} / ${passed + failures.length}`)
  process.exitCode = 1
} else {
  console.log(`PASSED all ${passed}`)
}
