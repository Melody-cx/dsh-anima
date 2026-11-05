// scripts/verify-core.mjs — 纯函数回归（不需要 DSH 宿主）
//
// 运行：node scripts/verify-core.mjs
// 退出码：0 全通过；1 有失败。

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
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
  compileOmissionNotice,
  compilePendingNotice,
  compilePersona,
  compileRememberGuide,
  compileRules,
  compileStyle,
  compileUserProfile,
  safeSection
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
  applyMemoryMeta,
  contentDigest,
  describeInjectionReason,
  findCredentials,
  formatMemoryLine,
  groupByStatus,
  makeCandidate,
  normalizeMemoryType,
  selectForInjection,
  summarizeOmission,
  triage,
  utf8Bytes
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
  checkResponse,
  compileLedgerRules,
  compileQualityRules,
  detectLedgerTriggers,
  UNCOVERABLE_RULES,
  hasLedgerBlock,
  parseLedgerBlock
} from '../lib/quality.mjs'
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
import { auditMemories, extractPaths, extractPathsWithStats } from '../lib/memory-audit.mjs'
import { DECAY_WINDOWS_DAYS, decayInfo, decayRank, decayTag, memoryAgeDays } from '../lib/decay.mjs'
import {
  MAX_FLAGGED_DETAIL_CHARS,
  MAX_FLAGGED_ITEMS,
  assessPatrol,
  compactFlagged,
  parsePatrolSignature,
  patrolSignature,
  planNightlyWake
} from '../lib/patrol.mjs'
import { createNoticeMessage, patrolNoticeText } from '../lib/injection.mjs'

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

test('selectForInjection 只取已采纳且受上限约束', () => {  const mk = (text, status, day) => ({
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

test('utf8Bytes 按真实 UTF-8 长度算，不按 UTF-16 code unit', () => {
  // 这是「4000 字符其实等于 12000 字节」的账本基础。若这里用
  // `String.prototype.length`，中文会被算成 1/3。
  assert.equal(utf8Bytes(''), 0)
  assert.equal(utf8Bytes(null), 0)
  assert.equal(utf8Bytes(123), 0)
  assert.equal(utf8Bytes('abc'), 3)
  assert.equal(utf8Bytes('中文'), 6)
  assert.equal(utf8Bytes('🐟'), 4, '星平面字符不能按 2 个 code unit 算成 2 字节')
  assert.equal('🐟'.length, 2, '前提：JS 的 .length 在这里确实是 2')
})

test('预算挤掉条目时必须能说出「几条、卡在哪」——不能静默', () => {
  const mk = (text, day) => ({
    ...makeCandidate({ text }).record,
    status: 'adopted',
    capturedAt: new Date(Date.UTC(2026, 0, day)).toISOString()
  })
  const records = [mk('一二三四五六七八九十'.repeat(4), 1), mk('甲乙丙丁戊己庚辛壬癸'.repeat(4), 2)]

  // 字符预算只够放 0 条：这是最该被说清楚的情况，不能报成「没超」。
  const starved = selectForInjection(records, 10, { maxInjectedChars: 30 })
  assert.equal(starved.selected.length, 0)
  assert.equal(starved.budget.limitedBy, 'chars', '一条都没放下时，仍然要归因到字符预算')
  assert.equal(summarizeOmission(starved).count, 2)
  assert.ok(starved.budget.usedBytes === 0)

  // 条数上限：归因必须是 count，不是 chars。
  const capped = selectForInjection(records, 1, { maxInjectedChars: 0 })
  assert.equal(capped.budget.limitedBy, 'count')
  assert.equal(summarizeOmission(capped).count, 1)

  // 都够：既不报省略，也不编一个归因。
  const roomy = selectForInjection(records, 10, { maxInjectedChars: 4000 })
  assert.equal(roomy.budget.limitedBy, 'none')
  assert.equal(summarizeOmission(roomy).count, 0, '没省略就一个字都不许说')
  assert.ok(roomy.budget.usedBytes > roomy.budget.usedChars, '中文的字节数必然大于字符数')
})

test('因「不属于本工作区」而没进去的，不算预算省略（那是另一回事）', () => {
  const rec = { ...makeCandidate({ text: '别的项目的偏好' }).record, status: 'adopted', layer: 'workspace', scope: 'D:\\other' }
  const sel = selectForInjection([rec], 10, { maxInjectedChars: 4000, cwd: 'D:\\mine' })
  assert.equal(sel.selected.length, 0)
  // 说「因预算没进去」会误导模型以为「多给点预算就能看到」。
  assert.equal(summarizeOmission(sel).count, 0)
  assert.equal(sel.budget.limitedBy, 'none')
})

test('单条渲染失败不连累整段：其余照常注入，失败那条单独归因成 error 而不是预算', () => {
  // 造一条 text 的 String() 会抛错的记录 —— formatMemoryLine 的第一行就是
  // `String(record?.text ?? '')`，必然在这里炸。这模拟的是「别的插件写进来的脏数据」。
  // 用 text 而不是 capturedAt，是因为排序键那一步也会 String(capturedAt)，
  // 那样测到的是排序崩，不是渲染保护。
  const poison = {
    ...makeCandidate({ text: '占位' }).record,
    status: 'adopted',
    layer: 'global',
    text: { toString() { throw new Error('boom') } }
  }
  const good = { ...makeCandidate({ text: '这条是好的' }).record, status: 'adopted', layer: 'global' }
  const sel = selectForInjection([poison, good], 10, { maxInjectedChars: 4000 })
  assert.equal(sel.selected.length, 1, '坏的那条不能把好的那条一起带走')
  assert.equal(sel.budget.renderFailed, 1)
  // 归因不能是 chars：调大预算对这条一点用都没有，用户会改错地方。
  assert.equal(sel.budget.limitedBy, 'error')
  const bad = sel.decisions.find((d) => d.reason === 'render-failed')
  assert.ok(bad, '坏掉的那条必须留下一条 render-failed 决定，不能悄无声息')
  assert.ok(describeInjectionReason('render-failed').includes('渲染失败'))
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

// ==================== 宿主变量插值：我们四段必须关掉它 ====================
//
// 背景：宿主 renderPrompt / renderContextSections 会对每个 section 跑
// interpolate()，规则是「`{{` 后必须紧跟 标识符}}」，且标识符必须已注册在
// assembly.variables 里，否则抛错，抛出点在 systemPrompt.assemble() 内部。
// 我们四段里有两段装的是用户自由文本（persona、记忆正文），
// 用户写一句 `{{key: value}}` 就能让整轮装配抛出来。
//
// 这里的回归锁两件事：
//   1. 我们的编译函数**不做**任何插值转义（保持原样，不吞用户文本）；
//   2. 因此注册 section 时必须传 interpolate:false —— 见下一条对 index.mjs 的源码断言。

/** 复刻宿主 @deepseek-ai/dsh-system-prompt 的 interpolate()，只保留抛错相关分支。 */
function hostInterpolate(text, variables = {}) {
  const GROUP_AT = /^\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/
  let result = ''
  let last = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = GROUP_AT.exec(text.slice(open))
    if (group === null) {
      if (text.indexOf('}}', open + 2) >= 0) {
        throw new Error(`malformed prompt variable reference at "${text.slice(open, open + 16)}…"`)
      }
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    const name = group[0].slice(2, -2)
    if (!Object.hasOwn(variables, name)) throw new Error(`unknown prompt variable "{{${name}}}"`)
    result += text.slice(last, open) + variables[name]
    last = open + group[0].length
  }
  return result + text.slice(last)
}

test('宿主的 interpolate 确实会被用户文本触发（这条本身是前提，不是我们的功能）', () => {
  // 如果哪天宿主改成不再抛错，这条会失败 —— 那是好事，届时可以删掉 interpolate:false。
  assert.throws(() => hostInterpolate('我的笔记格式是 {{key: value}}'), /malformed/)
  assert.throws(() => hostInterpolate('我的名字是 {{name}}'), /unknown prompt variable/)
  // 单层大括号不受影响，说明这不是「禁用大括号」，只是「禁用双大括号形态」。
  assert.equal(hostInterpolate('用 {大括号} 没问题'), '用 {大括号} 没问题')
})

test('compilePersona 原样透传用户文本里的 {{ }}，不做转义（所以必须靠 interpolate:false 兜底）', () => {
  const text = compilePersona({
    agentName: '小沃',
    userBio: '我的笔记格式是 {{key: value}}',
    customInstructions: '用 {{风格}} 说话'
  })
  // 编译层必须保持用户原话：吞掉或改写用户填的内容是更糟的失败方式。
  assert.ok(text.includes('{{key: value}}'), '不应转义或删除用户写的双大括号')
  assert.ok(text.includes('{{风格}}'))
  // 而且这段文本真的会让宿主抛 —— 证明风险是实的，不是想象的。
  assert.throws(() => hostInterpolate(text), /malformed|unknown prompt variable/)
})

test('compileMemory 同样原样透传记忆正文里的 {{ }}', () => {
  const text = compileMemory([
    { id: 'm1', text: '记一下：模板写法是 {{a.b}}', type: 'fact', layer: 'global' }
  ])
  assert.ok(text.includes('{{a.b}}'))
  assert.throws(() => hostInterpolate(text), /malformed|unknown prompt variable/)
})

test('index.mjs 注册的五个 section 全部带 interpolate:false', () => {
  // 源码级断言：这是唯一能拦住「下一个人删掉那个字段」的机械检查。
  // 走字符串匹配而不是 import index.mjs，是因为 index.mjs 依赖宿主包。
  const source = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  const registrations = source.match(/systemPrompt\.section\(\{[^}]*\}\)/g) ?? []
  assert.equal(registrations.length, 5, `应注册 5 个 section，实际 ${registrations.length}`)
  for (const line of registrations) {
    assert.match(line, /interpolate:\s*false/, `section 缺少 interpolate:false：${line.slice(0, 80)}`)
  }
})

test('safeSection：渲染抛错时返回空串，不把异常带出去', () => {
  // 这条守的是一条会「带走整个回合」的边界：宿主 assemble()/renderPrompt()
  // 全程没有 try/catch，我们的 text 函数抛一次，那一轮请求就直接失败。
  const report = []
  const out = safeSection('identity', () => {
    throw new Error('脏数据')
  }, (m) => report.push(m))
  assert.equal(out, '')
  assert.equal(report.length, 1, '失败时必须留一行日志，否则「今天为什么失忆」查不到')
  assert.match(report[0], /identity/)
  assert.match(report[0], /脏数据/)
})

test('safeSection：非字符串返回一律降级为空串', () => {
  // 宿主拿到 undefined 会炸在 join 之后的 .length 上，那里已经没有 try 罩着了。
  for (const bad of [undefined, null, 42, {}, []]) {
    assert.equal(safeSection('memory', () => bad), '', `返回值 ${String(bad)} 应被降级`)
  }
  assert.equal(safeSection('memory', () => 'ok'), 'ok')
})

test('safeSection：日志回调自己抛错也不能把降级带走', () => {
  const out = safeSection('quality', () => {
    throw new Error('渲染炸了')
  }, () => {
    throw new Error('日志也炸了')
  })
  assert.equal(out, '')
})

test('safeSection 在 index.mjs 里包住了全部四个段', () => {
  // 源码级断言：新增一个段却忘了包护罩，是这类改动最容易漏的回归。
  const source = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  for (const label of ['identity', 'memory', 'pending', 'quality']) {
    assert.match(source, new RegExp(`renderSection\\('${label}'`), `段 ${label} 没有接护罩`)
  }
})

test('compilePersona 中「助手身份」始终排在「用户背景」之前', () => {
  // 这条顺序是语义安全的一部分：先说清「这段说的是我」，再说「那段说的是用户」，
  // 反过来会让模型把紧随其后的用户背景当成自己的设定。
  const text = compilePersona({ agentName: '小沃', userBio: '用户是研究生' })
  assert.ok(text.indexOf('## 助手身份') < text.indexOf('## 用户背景'))
})

test('compileMemory 单条渲染失败要说出来：少了一条不能长得像「本来就只有这些」', () => {
  // 一条坏数据 + 一条好的：正文照常给，末尾必须有一句话说明少了一条。
  // 不给的话，模型会把「只看到 1 条」当成「只有 1 条」——它不知道自己漏了。
  const poison = { text: { toString() { throw new Error('boom') } }, layer: 'global' }
  const text = compileMemory([poison, { text: '用户偏好中文' }])
  assert.match(text, /用户偏好中文/, '好的那条必须照常注入')
  assert.match(text, /另有 1 条/, `必须说清少了几条，实际：${text}`)
  assert.match(text, /渲染失败/)
})

test('compileMemory 全部渲染失败：不能返回空串冒充「没有记忆」', () => {
  const poison = { text: { toString() { throw new Error('boom') } }, layer: 'global' }
  const text = compileMemory([poison])
  assert.notEqual(text, '', '全部失败时返回空串，等于对模型说「没有任何记忆」')
  assert.match(text, /一条都没能读到/)
  assert.match(text, /不是「没有记忆」/)
})

test('compileMemory 空数组返回空串', () => {
  assert.equal(compileMemory([]), '')
  assert.equal(compileMemory(null), '')
  const text = compileMemory([{ text: '用户偏好中文' }])
  assert.match(text, /已由用户采纳/)
  assert.match(text, /用户偏好中文/)
})

test('compileMemory 全被预算挤掉时不能静默：要说清有几条没放下', () => {
  // 旧实现在这条路径上返回 ''，等于对模型说「一条记忆都没有」，
  // 而真相是「有 N 条，但这轮放不下」。两种沉默长得一模一样，模型无从分辨。
  const gone = compileMemory([], { count: 3, maxCount: 40, maxChars: 4000 })
  assert.notEqual(gone, '', '有省略时返回空串就是谎报「没有记忆」')
  assert.match(gone, /3 条/)
  assert.match(gone, /40 条/)
  // 不带省略参数时保持旧行为：真的没记忆就一个字不写。
  assert.equal(compileMemory([]), '')
  assert.equal(compileMemory([], { count: 0, maxCount: 40, maxChars: 4000 }), '')
})

test('compilePendingNotice 无候选时返回空串', () => {
  assert.equal(compilePendingNotice(0), '')
  assert.match(compilePendingNotice(3), /3 条/)
})

// ==================== remember 行为指引段 ====================
//
// 这一段存在的原因不是「补充说明」，是「工具没人用」。实测 anima.json 的
// memories 表长期 0 条，而 remember 工具本身是可用的 —— 模型不知道什么时候该调它。

test('compileRememberGuide：必须讲清「投递 ≠ 生效」，否则模型会对用户谎称已记住', () => {
  const text = compileRememberGuide()
  // 这一句是整段的存在理由。删掉它，模型会把「投递到缓冲区」说成「我记住了」，
  // 而用户看到的是一条永远不会出现在记忆里的记录。
  assert.match(text, /投递不等于生效|投递 ≠ 生效/, '必须明说投递不等于生效')
  assert.match(text, /记住/, '必须给出「不要说记住了」的措辞')
})

test('compileRememberGuide：必须同时给出「该记」与「不该记」，缺一半就会滥记', () => {
  const text = compileRememberGuide()
  assert.match(text, /该记的/, '缺少正面判据')
  assert.match(text, /不该记的/, '缺少负面判据 —— 只有正面判据时模型会能记就记')
})

test('compileRememberGuide：明确点名临时任务状态、密钥、可读代码三类不该记', () => {
  const text = compileRememberGuide()
  // 这三类是实测里最容易滥记的：临时状态最多，密钥最危险，可读代码最没用。
  assert.match(text, /临时任务状态/, '临时任务状态是滥记的头号来源')
  assert.match(text, /密钥|令牌|密码/, '凭据类必须有明确禁令')
  assert.match(text, /代码|文件/, '从代码里读得出的东西不该占记忆位')
})

test('compileRememberGuide：要求 sourceRef，且明写「写不出就留空不要编」', () => {
  const text = compileRememberGuide()
  assert.match(text, /sourceRef/)
  // 「写不出就留空」这条比「必须给出处」更重要：没有它，模型会为了填满字段而编一个来源，
  // 而编出来的来源比没有来源更难被发现。
  assert.match(text, /留空/, '必须允许留空，否则会逼出伪引用')
  assert.match(text, /不要编|别编/, '必须显式禁止编造来源')
})

test('compileRememberGuide：四种 type 全部列出，且说清失效方式不同', () => {
  const text = compileRememberGuide()
  for (const t of ['fact', 'preference', 'stance', 'event']) {
    assert.ok(text.includes(t), `缺少类型 ${t}`)
  }
  assert.match(text, /失效|过期|归档/, '必须说明类型决定它什么时候失效')
})

test('compileOmissionNotice：没省略就一个字不写，有省略必须说清几条与上限', () => {
  assert.equal(compileOmissionNotice(null), '')
  assert.equal(compileOmissionNotice({ count: 0, maxCount: 40, maxChars: 4000 }), '')
  assert.equal(compileOmissionNotice({ count: -3 }), '', '负数不该被当成成绩')

  const one = compileOmissionNotice({ count: 3, maxCount: 40, maxChars: 4000 })
  assert.match(one, /3 条/)
  assert.match(one, /40 条/)
  assert.match(one, /4000 字/)
  // 这句是本改动的全部目的：让模型知道「没看到 ≠ 没记过」。
  assert.match(one, /不代表没记过/)
})

test('compileMemory 带上省略提示后，正文照旧、提示在末尾', () => {
  const rows = [{ text: '用户偏好中文', layer: 'global' }]
  const plain = compileMemory(rows)
  assert.doesNotMatch(plain, /因预算未注入/)

  const withNotice = compileMemory(rows, { count: 2, maxCount: 40, maxChars: 4000 })
  assert.match(withNotice, /用户偏好中文/)
  assert.match(withNotice, /另有 2 条/)
  // 提示必须在全部条目之后：夹在中间会被机当成「下一条记忆」读。
  assert.ok(withNotice.lastIndexOf('用户偏好中文') < withNotice.lastIndexOf('另有 2 条'))
})

test('compileMemory 的分段形态同样要带省略提示', () => {
  const rows = [
    { text: '全局的偏好', layer: 'global' },
    { text: '本项目的约定', layer: 'workspace' }
  ]
  const text = compileMemory(rows, { count: 1, maxCount: 40, maxChars: 4000 })
  assert.match(text, /### 全局/)
  assert.match(text, /### 本工作区/)
  assert.ok(text.lastIndexOf('本项目的约定') < text.lastIndexOf('另有 1 条'))
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

// ==================== meta 表 schema 完整性 ====================
//
// 真实缺陷（2026-10-24 发现）：`metaSchema` 只声明了三个 triage 字段，没有 `patrol`。
// 写入是原样落盘（所以 anima.json 里 patrol 数据完整），**读回时被 zod 剥成 `{}`**。
// 两处后果：
//   ① /api/anima/state 的 patrolMeta 恒为空 → 验收项 live-patrol 报 FAIL；
//   ② 更要命的是 runPatrol 自己读 `previous.signature` 也是空的 ⇒ 每次巡夜都
//      当成「头一回」，判据退化成「每次都算新事」，每次重启后必报一次。
//
// 为什么原有测试抓不到：`makeOpenableDomain` 是**原样存取**的假域，不做任何校验，
// 于是「schema 少一个键」这类 bug 在纯函数测试里完全不可见。下面这个替身按 spec
// 里的 zod schema 逐条解析，复刻真实包「读回即校验」的行为。

/** 会像真实 storage-domain 那样逐条校验的假域：读回时按 spec 的 zod schema 解析。 */
function makeValidatingDomain() {
  return {
    async open(spec) {
      const tables = new Map(Object.keys(spec.tables).map((name) => [
        name,
        { raw: new Map(), schema: spec.tables[name]?.valueSchema }
      ]))
      return {
        name: spec.name,
        table: (name) => {
          const t = tables.get(name)
          return {
            // 关键：读回时过一遍 schema。真实包也是这么做的 —— 未声明的键会被
            // zod 的对象默认行为（strip）静默丢弃，这正是 bug 的隐蔽之处。
            get: (key) => {
              const raw = t.raw.get(key)
              if (raw === undefined) return undefined
              return t.schema ? t.schema.parse(raw) : raw
            },
            put: async (key, value) => { t.raw.set(key, value) },
            entries: () => t.raw.entries(),
            get size() { return t.raw.size }
          }
        },
        close: async () => {}
      }
    }
  }
}

test('meta 表能完整读回 patrol 记录（schema 少一个键 = 巡夜每次都当成头一回）', async () => {
  await withTempHome(async () => {
    const domain = makeValidatingDomain()
    const store = new StateStore(makeWaitCtx({ services: { storageDomain: domain } }), { warn: () => {} })
    await store.getConfig()
    const table = await store.table('meta')

    const written = {
      at: '2026-10-23T16:55:15.001Z',
      day: '2026-10-24',
      reason: 'catch-up',
      signature: 'p:|f:|t:0',
      reported: false,
      wouldReport: false,
      delivered: 0,
      reasons: [],
      facts: { pending: 0, flagged: 0, removed: 0 },
      added: null,
      cleared: null,
      checked: 21
    }
    await table.put('patrol', written)
    const back = table.get('patrol')

    assert.equal(back?.signature, 'p:|f:|t:0', 'signature 读不回来 ⇒ 判据退化成「每次都算新事」')
    assert.equal(back?.at, written.at, 'at 是「沉默可反查」的唯一依据，不能丢')
    assert.equal(back?.checked, 21)
    assert.equal(back?.reported, false, 'reported 必须是布尔，不是 undefined')
    // 反向保护：真没写过的键仍然是 undefined，不能因为 schema 加了默认值就凭空多出一条
    assert.equal(table.get('从来没写过'), undefined)
  })
})

test('meta 表能读回体检明细（这是同一个 bug 最容易重演的地方）', async () => {
  await withTempHome(async () => {
    const domain = makeValidatingDomain()
    const store = new StateStore(makeWaitCtx({ services: { storageDomain: domain } }), { warn: () => {} })
    await store.getConfig()
    const table = await store.table('meta')

    // 走真实链路：先用 compactFlagged 压出落盘形状，再写、再读回。
    // 手写一个「我以为的形状」会漏掉 compactFlagged 真产出的字段名。
    const compact = compactFlagged([
      { id: 'm-1', text: '甲', findings: [{ kind: 'path-missing', detail: '路径没了', evidence: 'fs says no' }] },
      { id: 'm-2', text: '乙', findings: [{ kind: 'verify-expired', detail: '复核点过期', evidence: 'verifyAt < today' }] }
    ])
    await table.put('patrol', {
      at: '2026-10-25T00:00:00.000Z',
      facts: { pending: 0, flagged: 2, removed: 0 },
      checked: 21,
      flaggedItems: compact.items,
      flaggedDropped: compact.dropped
    })
    const back = table.get('patrol')

    assert.equal(back?.flaggedItems?.length, 2, '明细读不回来 ⇒ 界面上只剩一个数字，用户问「是哪条」无处可查')
    assert.equal(back?.flaggedItems?.[0]?.id, 'm-1')
    assert.equal(back?.flaggedItems?.[0]?.detail, '路径没了')
    assert.deepEqual(back?.flaggedItems?.[1]?.kinds, ['verify-expired'])
    assert.equal(back?.flaggedDropped, 0, '「丢了几条」也不能被 schema 剥掉')
  })
})

test('meta 表的 triage 记录不因新增 patrol 键而改变形状（加键只放宽，不收紧）', async () => {
  await withTempHome(async () => {
    const domain = makeValidatingDomain()
    const store = new StateStore(makeWaitCtx({ services: { storageDomain: domain } }), { warn: () => {} })
    await store.getConfig()
    const table = await store.table('meta')

    await table.put('triage', { lastTriageDay: '2026-10-24', lastTriageAt: '2026-10-23T16:55:14.995Z' })
    const back = table.get('triage')
    assert.equal(back?.lastTriageDay, '2026-10-24')
    assert.equal(back?.lastTriageAt, '2026-10-23T16:55:14.995Z')
    assert.equal(back?.patrol, undefined, '没写过的 patrol 不得凭空出现')
  })
})

// ==================== 子对象深合并回归 ====================
// 真实缺陷（2026-10-19 修）：updateConfig 原先把 patch 直接展开进 migrateConfig，
// 只对 memory 做了嵌套合并。新增 quality 子对象后，用户改一个 quality.enabled，
// 同一个 patch 里没出现的 ledgerLevel / maxFindingsInReminder 就会被
// migrateConfig 用默认值填回 —— 表现是「改一个开关，另三个设置被悄悄重置」，
// 且不报错。这组测试锁住「只改一个子键，其余子键必须原样保留」。
test('updateConfig 只改 quality 的一个子键时，其余子键保持不变', async () => {
  await withTempHome(async () => {
    const domain = makeOpenableDomain()
    const store = new StateStore(makeWaitCtx({ services: { storageDomain: domain } }), { warn: () => {} })
    await store.getConfig()

    await store.updateConfig({
      quality: { enabled: true, strict: true, ledgerLevel: 'five', maxFindingsInReminder: 9 }
    })
    // 只覆盖 enabled，另外三项一个字都不提。
    const { config: next } = await store.updateConfig({ quality: { enabled: false } })

    assert.equal(next.quality.enabled, false, '被显式改的键要生效')
    assert.equal(next.quality.strict, true, '未出现的 strict 必须保留用户设过的值')
    assert.equal(next.quality.ledgerLevel, 'five', '未出现的 ledgerLevel 不得回退默认 three')
    assert.equal(next.quality.maxFindingsInReminder, 9, '未出现的 maxFindingsInReminder 不得回退默认 5')
  })
})

test('updateConfig 只改 memory 的一个子键时，其余子键保持不变（既有行为不得回退）', async () => {
  await withTempHome(async () => {
    const domain = makeOpenableDomain()
    const store = new StateStore(makeWaitCtx({ services: { storageDomain: domain } }), { warn: () => {} })
    await store.getConfig()

    await store.updateConfig({ memory: { maxInjected: 12, maxInjectedChars: 1500, defaultLayer: 'workspace' } })
    const { config: next } = await store.updateConfig({ memory: { enabled: false } })

    assert.equal(next.memory.enabled, false)
    assert.equal(next.memory.maxInjected, 12, '未出现的 maxInjected 必须保留')
    assert.equal(next.memory.maxInjectedChars, 1500, '未出现的 maxInjectedChars 必须保留')
    assert.equal(next.memory.defaultLayer, 'workspace', '未出现的 defaultLayer 必须保留')
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

// ==================== 记忆类型与状态标签（2026-10-19 新增字段） ====================
// 这组测的是「新字段不会把旧数据弄坏，也不会把新语义静默吃掉」。
// 真实介质上的验证已单独跑过（21 条存量记忆用新 schema 全部通过，新字段往返不丢），
// 这里锁的是那条结论的**代码侧**依据，防止以后有人给 schema 加 .strict() 或删字段。
await section('memory-type')

test('normalizeMemoryType 对未知取值回退默认，不拒绝也不伪造', () => {
  assert.equal(normalizeMemoryType('fact'), 'fact')
  assert.equal(normalizeMemoryType('stance'), 'stance')
  // 模型面对自由文本时最容易写出的三类别名：不回退就等于把整条记忆拒收，
  // 而「类型猜错了」远没有「这条记忆丢了」严重。
  assert.equal(normalizeMemoryType(undefined), 'fact')
  assert.equal(normalizeMemoryType(''), 'fact')
  assert.equal(normalizeMemoryType('事实'), 'fact')
})

test('makeCandidate 接受 type / sourceRef / verifyAt，并把它们写进记录', () => {
  const at = new Date('2026-10-19T10:00:00.000Z')
  const { ok, record } = makeCandidate({
    text: '用户要求评估类问题只给结论不挂执行入口',
    type: 'preference',
    sourceRef: 'm00123',
    verifyAt: '2027-04-01'
  }, at)
  assert.equal(ok, true)
  assert.equal(record.type, 'preference')
  assert.equal(record.sourceRef, 'm00123')
  assert.equal(record.verifyAt, '2027-04-01')
  assert.equal(record.status, 'pending', '新字段不改变待审语义')
})

test('makeCandidate 不传新字段时不会凭空造出它们', () => {
  const { ok, record } = makeCandidate({ text: '一条普通记忆' }, new Date('2026-10-19T10:00:00.000Z'))
  assert.equal(ok, true)
  assert.equal(record.type, 'fact', '缺省类型是 fact')
  assert.equal(record.sourceRef, undefined, '没有来源就留空，不许编一个')
  assert.equal(record.verifyAt, undefined, '没有复核点就留空')
})

test('formatMemoryLine：曾如此 / 有争议 / 写入日期 三种标签各按状态出现', () => {
  const now = new Date('2026-10-19T00:00:00.000Z')
  const base = { text: '用户在学习 AI×网络安全', capturedAt: '2026-09-01T00:00:00.000Z' }

  const current = formatMemoryLine({ ...base, state: 'current' }, now)
  assert.ok(current.includes('2026-09-01'), '写入日期必须出现，否则无法判断这条有多旧')
  assert.ok(!current.includes('曾如此'))
  assert.ok(!current.includes('有争议'))

  const superseded = formatMemoryLine({ ...base, state: 'superseded' }, now)
  assert.ok(superseded.includes('曾如此'), '改过主意的旧条目必须标「曾如此」，否则会被当成现状')

  const contradicted = formatMemoryLine({ ...base, state: 'contradicted' }, now)
  assert.ok(contradicted.includes('有争议'), '未裁决的冲突必须标出来，不许自己圆')
})

test('formatMemoryLine：复核点只在过期后才提示（没到期就天天提 = 噪音）', () => {
  const now = new Date('2026-10-19T00:00:00.000Z')
  const future = formatMemoryLine({ text: '最近在焦虑论文', capturedAt: '2026-10-01T00:00:00.000Z', verifyAt: '2027-01-01' }, now)
  assert.ok(!future.includes('可能已过时'), '未到期不得提示')

  const past = formatMemoryLine({ text: '最近在焦虑论文', capturedAt: '2026-10-01T00:00:00.000Z', verifyAt: '2026-10-02' }, now)
  assert.ok(past.includes('可能已过时'), '过期必须提示，把「要不要更新」交回用户')
})

test('formatMemoryLine：没有 text 时返回空串，不渲染出一个只有标签的空行', () => {
  assert.equal(formatMemoryLine({ state: 'current', capturedAt: '2026-10-01T00:00:00.000Z' }), '')
  assert.equal(formatMemoryLine(null), '')
})

// ---- 回填旧条目：applyMemoryMeta（2026-10-20 新增） ----
// 这一组存在的理由：真实介质里 21 条已采纳记忆全部没有 type，要回填就必须有
// 一条「只改元数据、不动正文」的路径。下面每一条都在守一个「不许顺手改坏」的边界。

test('applyMemoryMeta 只改元数据：正文、id、digest、裁决状态、写入时间一个字都不动', () => {
  const base = {
    id: 'm-abcdef123456-x1',
    text: '用户要求评估类问题只给结论，不挂执行入口',
    digest: 'deadbeefdeadbeef',
    status: 'adopted',
    layer: 'global',
    capturedAt: '2026-10-15T01:04:51.000Z',
    decidedAt: '2026-10-15T01:05:00.000Z',
    source: 'import'
  }
  const { ok, record, changed } = applyMemoryMeta(
    base,
    { type: 'preference', sourceRef: 'm00123' },
    new Date('2026-10-20T00:00:00.000Z')
  )
  assert.equal(ok, true)
  assert.deepEqual(changed.sort(), ['sourceRef', 'type'])
  assert.equal(record.type, 'preference')
  assert.equal(record.sourceRef, 'm00123')
  // 五个不许动的字段逐个钉住：将来有人让这个函数顺手「规范化」一次正文，
  // 会立刻在这里红掉，而不是等到 id 与内容对不上之后才发现。
  assert.equal(record.id, base.id)
  assert.equal(record.text, base.text)
  assert.equal(record.digest, base.digest)
  assert.equal(record.status, base.status)
  assert.equal(record.capturedAt, base.capturedAt)
  assert.equal(record.decidedAt, base.decidedAt)
  assert.equal(record.source, base.source)
})

test('applyMemoryMeta 值没变就报 changed 为空，不许假装写过', () => {
  const base = { id: 'm-1', text: 'x', status: 'adopted', capturedAt: '2026-10-01T00:00:00.000Z', type: 'fact' }
  const { ok, changed } = applyMemoryMeta(base, { type: 'fact' }, new Date('2026-10-20T00:00:00.000Z'))
  assert.equal(ok, true)
  assert.equal(changed.length, 0, '写同样的值不算变更；路由据此不写盘也不回「已更新」')
})

test('applyMemoryMeta 接受中文与故意写歪的类型，归一而不是拒收', () => {
  const base = { id: 'm-2', text: 'x', status: 'adopted', capturedAt: '2026-10-01T00:00:00.000Z' }
  const r = applyMemoryMeta(base, { type: '偏好' }, new Date('2026-10-20T00:00:00.000Z'))
  assert.equal(r.ok, true)
  assert.equal(r.record.type, 'fact', '认不出的类型回落到 fact，不因为一个标签就把整条记忆拒之门外')
})

test('applyMemoryMeta 的复核点：过去的日期必须拒绝（否则一写就盖上过期章）', () => {
  const base = { id: 'm-3', text: 'x', status: 'adopted', capturedAt: '2026-10-01T00:00:00.000Z' }
  const now = new Date('2026-10-20T00:00:00.000Z')

  const past = applyMemoryMeta(base, { verifyAt: '2026-01-01' }, now)
  assert.equal(past.ok, false, '复核点设在过去没有意义，必须报错让人重填')
  assert.ok(past.error.includes('已经过去'))

  const bad = applyMemoryMeta(base, { verifyAt: '2027/01/01' }, now)
  assert.equal(bad.ok, false, '格式错必须拒绝，不能静默存成一个永远不比对的字符串')

  const future = applyMemoryMeta(base, { verifyAt: '2027-01-01' }, now)
  assert.equal(future.ok, true)
  assert.equal(future.record.verifyAt, '2027-01-01')
})

test('applyMemoryMeta 清空：传空串等于删除该字段，而不是存一个字面上的空字符串', () => {
  const base = {
    id: 'm-4',
    text: 'x',
    status: 'adopted',
    capturedAt: '2026-10-01T00:00:00.000Z',
    verifyAt: '2027-01-01',
    sourceRef: 'm00123'
  }
  const now = new Date('2026-10-20T00:00:00.000Z')
  const r = applyMemoryMeta(base, { verifyAt: '', sourceRef: '' }, now)
  assert.equal(r.ok, true)
  assert.ok(!('verifyAt' in r.record), '存一个空串会让注入行渲染出「可能已过时」之类的假信号')
  assert.ok(!('sourceRef' in r.record))
  assert.deepEqual(r.changed.sort(), ['sourceRef', 'verifyAt'])
})

test('applyMemoryMeta 把状态改回 current 时必须清掉 supersededBy，不留自相矛盾的一行', () => {
  const base = {
    id: 'm-5',
    text: 'x',
    status: 'adopted',
    capturedAt: '2026-10-01T00:00:00.000Z',
    state: 'superseded',
    supersededBy: 'm-9'
  }
  const r = applyMemoryMeta(base, { state: 'current' }, new Date('2026-10-20T00:00:00.000Z'))
  assert.equal(r.ok, true)
  assert.equal(r.record.state, 'current')
  assert.ok(!('supersededBy' in r.record), '既说「现行」又留着「被谁取代」＝ 同一行两种结论')
})

test('applyMemoryMeta 对空记录给出错误而不是抛异常', () => {
  assert.equal(applyMemoryMeta(null, { type: 'fact' }).ok, false)
  assert.equal(applyMemoryMeta({ text: '没有 id' }, { type: 'fact' }).ok, false)
})

// ---- 取代关系（supersededBy）：状态机里唯一需要两条记录才能表达的字段 ----
test('supersededBy 会自动把状态改成 superseded（否则记了一笔没人看的账）', () => {
  const base = { id: 'm-old', text: '旧说法', status: 'adopted', capturedAt: '2026-10-01T00:00:00.000Z' }
  const r = applyMemoryMeta(base, { supersededBy: 'm-new' }, new Date('2026-10-20T00:00:00.000Z'))
  assert.equal(r.ok, true)
  assert.equal(r.record.supersededBy, 'm-new')
  assert.equal(r.record.state, 'superseded', '有取代者却不标状态，注入行会照旧按「现行」渲染')
  assert.ok(r.changed.includes('supersededBy'))
  assert.ok(r.changed.includes('state'))
})

test('supersededBy 不许指向自己', () => {
  const base = { id: 'm-self', text: 'x', status: 'adopted', capturedAt: '2026-10-01T00:00:00.000Z' }
  const r = applyMemoryMeta(base, { supersededBy: 'm-self' }, new Date('2026-10-20T00:00:00.000Z'))
  assert.equal(r.ok, false)
})

test('supersededBy 传空串等于清除，且不顺手改状态', () => {
  const base = {
    id: 'm-a',
    text: 'x',
    status: 'adopted',
    capturedAt: '2026-10-01T00:00:00.000Z',
    state: 'contradicted',
    supersededBy: 'm-b'
  }
  const r = applyMemoryMeta(base, { supersededBy: '' }, new Date('2026-10-20T00:00:00.000Z'))
  assert.equal(r.ok, true)
  assert.ok(!('supersededBy' in r.record))
  assert.equal(r.record.state, 'contradicted', '清指针不等于裁决状态，别替用户改')
})

// ==================== 质检层：误报回归（2026-10-20 新增） ====================
// 这组用例全部来自**真实语料**里被判错的样本。它们的价值不是「检查器能抓到错」，
// 而是「检查器不会冤枉对的」——误报率高到一定程度，用户会把整个质检层关掉，
// 那时漏报就从「一个洞」变成「全部洞」。
await section('quality:误报回归')

test('对账触发：自指序数（第 9 条 / 这 24 条）不算世界性断言，不触发', () => {
  const selfRef = detectLedgerTriggers('你说第 9 条还好，所以我保留它。', 'three')
  assert.equal(selfRef.needed, false, '指回对话自身的序号，读者往上翻就能核对，要求对账是噪音')

  const nested = detectLedgerTriggers('就补第 11 条、12 条，清单永远开放。', 'three')
  assert.equal(nested.needed, false, '「第 11 条、12 条」这种并列缩写也要认出来')

  const real = detectLedgerTriggers('改的都是 ，共 7 个源文件 + 1 个 CLI。', 'three')
  assert.equal(real.needed, true, '工程规模断言仍必须要求对账，别把排除做过头')
})

test('对账触发：被引号括起来的内容是在谈论一种说法，不触发', () => {
  const quoted = detectLedgerTriggers('能被抓到没查就报「已通过」，这比不检查更糟。', 'three')
  assert.equal(quoted.needed, false, '描述某种毛病时出现的「已通过」不是自我声明')

  const nested = detectLedgerTriggers('那句「能被抓到没查就报「已通过」」是在描述毛病。', 'three')
  assert.equal(nested.needed, false, '嵌套引号也要能配对，否则转述会被当成主张')

  const plain = detectLedgerTriggers('我查过了，测试通过。', 'three')
  assert.equal(plain.needed, true, '真在声称自己查过时仍要触发')
})

test('R11：归因词必须紧贴引号，句中远处出现「你说的」不算', () => {
  // 真实误报①：句中「你说的灵魂」是在谈论用户，引号里是助手自己的展开
  const away = checkResponse('你说的灵魂，拆开是两样：**一是连续的自我**：比如「上次聊到哪儿」这种连续性。', {
    ledgerLevel: 'off',
    strict: true
  })
  assert.equal(away.findings.some((f) => f.ruleId === 'R11'), false, '远处的归因词不能当通行证')

  // 真实误报②：引文内含「你说过」，早期实现会自己给自己作证
  const selfWitness = checkResponse('我会记得「你还说过什么呢」这类事。', { ledgerLevel: 'off', strict: true })
  assert.equal(selfWitness.findings.some((f) => f.ruleId === 'R11'), false, '引文本身不得参与归因判断')

  // 该抓的仍要抓：归因词紧贴引号且没有出处
  const real = checkResponse('你说过「这些插件全都不用试」，所以我就没装。', { ledgerLevel: 'off', strict: true })
  assert.equal(real.findings.some((f) => f.ruleId === 'R11'), true, '真在把话算到用户头上时必须抓')
})

test('R11：假设句（如果哪天你说「…」）不是引用，不判稻草人', () => {
  const r = checkResponse('如果哪天你说「现在它有灵魂了」，那我大概率是在演。', { ledgerLevel: 'off', strict: true })
  assert.equal(r.findings.some((f) => f.ruleId === 'R11'), false, '设想出来的话不算断言用户说过')
})

test('判据自己崩掉时不许冒充「没问题」：要报成 R02 并说明一次判定都没完成', () => {
  // 传一个 String() 必抛的对象：runChecks 第一行 `String(text ?? '')` 就会炸。
  // 旧实现下这个异常会一路冒到 pre-step 钩子，被外层 catch 成 `skip('error')` ——
  // 于是既没有提醒、也没有 findings，形状和「查了、没事」完全一样。
  const poison = { toString() { throw new Error('boom') } }
  const r = checkResponse(poison, { ledgerLevel: 'three', strict: true })
  assert.equal(r.failed, true, '必须显式标记这次没跑成')
  assert.deepEqual(r.checked, [], '一条判据都没跑完，不能谎称跑了')
  assert.equal(r.findings.length, 1)
  assert.equal(r.findings[0].ruleId, 'R02')
  assert.match(r.findings[0].detail, /一条判定都没完成/)
  assert.match(r.findings[0].detail, /boom/, '原始错误文本要带出来，否则无法修')
})

test('干净且带对账块的回答，在严格模式下也一条不报', () => {
  const clean = [
    '改完了，三个文件都同步过。',
    '',
    '【对账】',
    '查了：比对源码与安装副本 → 15 个文件 SHA256 全一致',
    '未查：宿主运行态是否已加载新代码（需要重启后验证）'
  ].join('\n')
  const r = checkResponse(clean, { ledgerLevel: 'three', strict: true })
  assert.deepEqual(r.findings.map((f) => f.ruleId), [], '不冤枉是对的底线')
  assert.ok(r.uncovered.includes('R07'), '未查项必须如实交出去')
})

test('对账块只认独立成行，句中提到【对账】三个字不算有块', () => {
  const inline = '如果我下一条回答冒出【对账】块，你可以要求我重写。'
  assert.equal(hasLedgerBlock(inline), false, '句中的标记不能冒充整块，否则「没写」会被判成「写了但空」')
  assert.equal(parseLedgerBlock(inline), null)

  const real = '正文。\n\n【对账】\n查了：跑了 verify-core → PASSED all 149\n未查：浏览器端渲染\n'
  assert.equal(hasLedgerBlock(real), true)
  const parsed = parseLedgerBlock(real)
  assert.equal(parsed.checked.length, 1, '行首「查了」才算数')
  assert.equal(parsed.unchecked.length, 1)
  assert.equal(parsed.empty, false)

  // 真发生过：我把标记写成 `**【对账】**`（Markdown 加粗），而只认裸标记的判据
  // 判我「没写对账块」—— 模型被判谎报，而它明明写了。最坏的一类误报：
  // 逼人改写作习惯去迁就检查器。
  const bold = '正文。\n\n**【对账】**\n查了：跑了 verify-core\n未查：浏览器端渲染\n'
  assert.equal(hasLedgerBlock(bold), true, '加粗的标记也是标记，格式不该决定判词')
  const boldParsed = parseLedgerBlock(bold)
  assert.equal(boldParsed.checked.length, 1, '加粗两种都在同一行时也要认')
  assert.equal(boldParsed.unchecked.length, 1)

  const heading = '## 【对账】\n查了：x\n未查：y\n'
  assert.equal(hasLedgerBlock(heading), true, '标题形式的标记同样是独立成行')
  const bullet = '- **查了**：x\n- **未查**：y\n'
  assert.equal(parseLedgerBlock(`正文\n\n【对账】\n${bullet}`).checked.length, 1, '列表符号与加粗剥掉后仍是行首标签')
})

test('同一条文本连续判两次必须给同一个答案（/g 正则的 lastIndex 残留曾让判词随机）', () => {
  // 真线上 bug：hasLedgerBlock 原先复用模块级的 LEDGER_BLOCK_START_G（带 /g），
  // 而 /g 正则的 .test() 会把 lastIndex 推进到匹配末尾，下一次调用从那里继续找。
  // 于是同一段文字连续判两次会得到相反答案 —— 第一次「有块」，第二次「没有」。
  //
  // 为什么这条必须单独锁：它极难被发现。单独测一次永远是绿的（lastIndex 初始为 0），
  // 现有用例每次换一段不同文本，恰好躲过了它。危害也不是普通误报 ——
  // 它让判词本身不确定：同一条回答，钩子这次说我谎报、下次说我没谎报，
  // 用户据此无法相信任何一次结论。
  const real = '正文。\n\n【对账】\n查了：x\n未查：y\n'
  for (let i = 0; i < 5; i += 1) {
    assert.equal(hasLedgerBlock(real), true, `第 ${i + 1} 次判定就变了：/g 正则的 lastIndex 没被隔离`)
  }
  // 反向也要稳：没有块的文本反复判必须始终是 false。
  const none = '正文里提了一句【对账】但没有独立成行。\n'
  for (let i = 0; i < 5; i += 1) {
    assert.equal(hasLedgerBlock(none), false, `第 ${i + 1} 次把句中提及判成了整块`)
  }
  // 交替调用也不能互相污染。
  for (let i = 0; i < 3; i += 1) {
    assert.equal(hasLedgerBlock(real), true, '块与无块交替时状态串了')
    assert.equal(hasLedgerBlock(none), false, '块与无块交替时状态串了')
  }
})

test('提示词层：质检段与对账段都带上「没查什么」与「不要宣称通过」', () => {
  const rules = compileQualityRules()
  assert.ok(rules.includes('R01'), '十二条必须编号出现，否则代码判词里的 Rxx 对不上人话')
  assert.ok(rules.includes('机器判不了'), '必须写明哪几条判不了，不能让模型以为十二条都被验过')
  // 名单必须与 UNCOVERABLE_RULES 逐字一致。
  // 曾经写死成四条（漏了 R10），而旧断言只查「有没有写判不了」四个字 —— 于是
  // 提示词告诉模型「四条判不了」，质检器却按五条扣分，双方谁也不报错。
  assert.ok(
    rules.includes(`其中 ${UNCOVERABLE_RULES.join(' / ')} 机器判不了`),
    `提示词里的判不了名单必须是现算的 ${UNCOVERABLE_RULES.join('/')}，不能写死`
  )

  const ledger = compileLedgerRules('three')
  assert.ok(ledger.includes('【对账】'))
  assert.ok(ledger.includes('未查'), '「未查」这行不能省，这是对账存在的理由')
  assert.equal(compileLedgerRules('off'), '', '档位关掉时不生成任何文本')
})

// ==================== memory-audit（记忆体检） ====================
//
// 这一组守的是「假警报比不检查更糟」：体检报告一旦误报，用户会学会无视整份报告，
// 那时真警报也一起失效。所以大半用例都在验「不该报的别报」。

test('extractPaths：中文标点紧贴路径时必须剥掉尾巴，否则探的是一条不存在的路径', () => {
  const got = extractPaths('工具链在 D:\\c，SDK 在 D:\\Windows Kits；别的地方不看。')
  assert.equal(got.length, 2)
  assert.equal(got[0].path, 'D:\\c', '中文逗号不能被吃进路径')
  assert.equal(got[1].path, 'D:\\Windows', '带空格的路径正则只能取到第一个空格前，延长由探测阶段处理')
})

test('extractPaths：占位样板只探占位符之前的前缀，并如实标成 templated', () => {
  const got = extractPaths('cl.exe 在 D:\\c\\VC\\Tools\\MSVC\\<版本号>\\bin\\Hostx64\\x64\\cl.exe')
  assert.equal(got.length, 1)
  assert.equal(got[0].templated, true, '样板必须标出来，否则探不到就被说成「路径没了」')
  assert.equal(got[0].path, 'D:\\c\\VC\\Tools\\MSVC', '只探真实前缀')
})

test('extractPaths：只有盘符的片段没有信息量，不进探测清单', () => {
  assert.deepEqual(extractPaths('装到 D:\\ 就行'), [])
})

test('auditMemories：路径带空格被截断时，靠文件系统证实延长，不报假警报', () => {
  // 真实发生过：记忆里写 `D:\\Windows Kits`，正则截成 `D:\\Windows`，
  // 那个目录不存在 → 报「路径已经不存在」。假警报。
  const existing = new Set(['D:\\', 'D:\\Windows Kits'])
  const out = auditMemories(
    [{ id: 'm-1', status: 'adopted', text: 'SDK 在 D:\\Windows Kits 下', capturedAt: '2026-10-15T00:00:00.000Z' }],
    { probe: (p) => existing.has(p), now: new Date('2026-10-20T00:00:00.000Z') }
  )
  assert.equal(out.flagged.length, 0, '延长后的路径存在就不能报不存在')
  assert.equal(out.clean, 1)
})

test('auditMemories：路径真的没了要报，并给出可直接复制的命令', () => {
  const out = auditMemories(
    [{ id: 'm-2', status: 'adopted', text: 'venv 在 C:\\已删除的目录\\env', capturedAt: '2026-10-15T00:00:00.000Z' }],
    { probe: () => false, now: new Date('2026-10-20T00:00:00.000Z') }
  )
  assert.equal(out.flagged.length, 1)
  assert.equal(out.flagged[0].findings[0].kind, 'path-missing')
  assert.ok(out.flagged[0].findings[0].evidence.includes('existsSync'), '每条结论都要带证据形状，不能只说结论')
  assert.equal(out.flagged[0].suggestion.state, 'contradicted')
  assert.ok(out.flagged[0].suggestion.command.startsWith('/anima mark m-2'), '建议必须是用户点一下就能执行的命令')
})

test('auditMemories：复核点过期只提示，不建议改状态（日历说的和语义说的分开）', () => {
  const out = auditMemories(
    [{ id: 'm-3', status: 'adopted', text: '最近在学多元微积分', verifyAt: '2026-01-31', capturedAt: '2026-10-15T00:00:00.000Z' }],
    { probe: () => true, now: new Date('2026-10-20T00:00:00.000Z') }
  )
  assert.equal(out.flagged.length, 1)
  assert.equal(out.flagged[0].findings[0].kind, 'verify-expired')
  assert.equal(out.flagged[0].suggestion.state, null, '过期不等于不成立，代码不能替用户定性')
})

test('auditMemories：探针抛错算「查不到」而不是「不存在」', () => {
  const out = auditMemories(
    [{ id: 'm-4', status: 'adopted', text: '在 D:\\a\\b 下面', capturedAt: '2026-10-15T00:00:00.000Z' }],
    {
      probe: () => {
        throw new Error('EPERM')
      },
      now: new Date('2026-10-20T00:00:00.000Z')
    }
  )
  assert.equal(out.flagged[0].findings[0].kind, 'path-unprobed')
  assert.equal(out.flagged[0].suggestion.state, null, '查不到就不能说它没了')
})

test('auditMemories：没到期的复核点不吵（过期的才提）', () => {
  const out = auditMemories(
    [{ id: 'm-5', status: 'adopted', text: '学习方向：AI×网络安全', verifyAt: '2027-04-30', capturedAt: '2026-10-15T00:00:00.000Z' }],
    { probe: () => true, now: new Date('2026-10-20T00:00:00.000Z') }
  )
  assert.equal(out.flagged.length, 0, '还没到期就报，等于制造噪音')
})

test('auditMemories：只查已采纳的，待审与已丢弃不参与', () => {
  const out = auditMemories(
    [
      { id: 'm-6', status: 'pending', text: '在 D:\\nope 下' },
      { id: 'm-7', status: 'discarded', text: '在 D:\\nope 下' }
    ],
    { probe: () => false, now: new Date('2026-10-20T00:00:00.000Z') }
  )
  assert.equal(out.checked, 0)
  assert.equal(out.flagged.length, 0)
})

test('auditMemories：路径超单条上限时必须报出「还有 N 个没查」，不能安静地少查', () => {
  // 造 12 个不同路径，单条上限是 8 → 应有 4 个没被探过。
  const paths = Array.from({ length: 12 }, (_, i) => `D:\\probe\\dir${i}`)
  const out = auditMemories(
    [{ id: 'm-8', status: 'adopted', text: `这些都在：${paths.join('、')}` }],
    { probe: () => true, now: new Date('2026-10-20T00:00:00.000Z') }
  )
  assert.equal(out.flagged.length, 1, '截断本身要成为一条 findings，而不是被吞掉')
  const trunc = out.flagged[0].findings.find((f) => f.kind === 'paths-truncated')
  assert.ok(trunc, '必须有 paths-truncated 这条 finding')
  assert.ok(trunc.detail.includes('4'), `要说出没查几个，实际：${trunc.detail}`)
  // 顶层也要有一份「关于这份报告本身」的告知 —— 汇总行读者不会点进每条看。
  assert.equal(out.truncated.records, 1)
  assert.equal(out.truncated.paths, 4)
  assert.ok(out.truncated.note.includes('没有检查'), `note 要说清没查，实际：${out.truncated.note}`)
})

test('auditMemories：没截断时 truncated.note 必须是空串，不能无中生有地吓人', () => {
  const out = auditMemories(
    [{ id: 'm-9', status: 'adopted', text: '只有 D:\\probe\\one 一个路径' }],
    { probe: () => true, now: new Date('2026-10-20T00:00:00.000Z') }
  )
  assert.equal(out.truncated.records, 0)
  assert.equal(out.truncated.paths, 0)
  assert.equal(out.truncated.note, '')
})

test('extractPathsWithStats：同一条路径重复出现不算「没查」，total 是去重后的数量', () => {
  // 同一条路径写三遍，不能被报成「还有 2 个没查」—— 那是假警报。
  const once = extractPathsWithStats('在 D:\\probe\\a 下')
  assert.equal(once.total, 1)
  const thrice = extractPathsWithStats('在 D:\\probe\\a 下，又不是 D:\\probe\\a 下，还是 D:\\probe\\a 下')
  assert.equal(thrice.total, 1)
  assert.equal(thrice.truncated, false)
})

// ==================== 时间衰减（lib/decay.mjs） ====================
// 这一组守的是一条很容易被顺手破坏的边界：衰减**只能**由「类型 + 日历」算出来。
// 一旦有人往这里加一句「模型觉得这条过时了」，整套「不被替下结论」就破了。

await section('decay')

test('事实类永不因年龄衰减：窗口 0 就是「不参与时间衰减」，不是「立刻过期」', () => {
  const now = new Date('2030-01-01T00:00:00.000Z')
  // 八年的事实仍然是 fresh。事实要防的是「环境变了」，那由 verifyAt 管。
  const old = { type: 'fact', text: 'VS2022 装在 D:\\c', capturedAt: '2022-01-01T00:00:00.000Z' }
  const info = decayInfo(old, now)
  assert.equal(info.level, 'fresh')
  assert.equal(info.decayed, false)
  assert.equal(decayTag(old, now), '', '已经不再衰减的类型不该冒出标签')
  assert.equal(decayRank(old, now), 0)
})

test('偏好类：窗口一半开始 aging，跨过窗口才 stale 并出标签', () => {
  const mk = (day) => ({ type: 'preference', text: '安装路径不装 C 盘', capturedAt: day })
  const now = new Date('2027-01-01T00:00:00.000Z')
  // 窗口 540 天 → 270 天前是 aging，541 天前是 stale。
  const aging = decayInfo(mk('2026-04-06T00:00:00.000Z'), now)
  assert.equal(aging.level, 'aging')
  assert.equal(aging.decayed, false, 'aging 只是提醒，不等于超窗')
  assert.equal(decayTag(mk('2026-04-06T00:00:00.000Z'), now), '', '没过窗就不加标签，否则是噪音')

  const stale = decayInfo(mk('2025-07-09T00:00:00.000Z'), now)
  assert.equal(stale.level, 'stale')
  assert.equal(stale.decayed, true)
  assert.ok(decayTag(mk('2025-07-09T00:00:00.000Z'), now).includes('久未更新'))
})

test('事件类用另一句标签：事件不会「更新」，它只是离得远了', () => {
  // 时间要同时超过两类窗口（事件 180 天 / 偏好 540 天），否则比的是「有没有超窗」
  // 而不是「超窗之后怎么措辞」—— 我第一次就把 now 写得太近，白红了一次。
  const now = new Date('2028-01-01T00:00:00.000Z')
  const event = { type: 'event', text: '2026 年 10 月定了质检层', capturedAt: '2026-01-01T00:00:00.000Z' }
  assert.equal(decayTag(event, now), '较早的事')
  // 同一时间、换成偏好，说的就不是一件事了。
  assert.equal(decayTag({ ...event, type: 'preference' }, now), '久未更新')
})

test('解析不出日期 / 日期在未来：一律当新的（宁可当新，也不误降一条其实很新的记忆）', () => {
  const now = new Date('2026-10-22T00:00:00.000Z')
  for (const bad of [undefined, '', 'not-a-date', '2026-13-45']) {
    assert.equal(memoryAgeDays({ capturedAt: bad }, now), 0, `${String(bad)} 应回落到 0 天`)
  }
  const future = { type: 'preference', capturedAt: '2027-01-01T00:00:00.000Z' }
  assert.equal(memoryAgeDays(future, now), 0, '未来日期不能算出负数天')
  assert.equal(decayInfo(future, now).level, 'fresh')
})

test('墓碑不叠加衰减标签：「已删除」和「很久没更新」同时出现会被读成两条信息', () => {
  const now = new Date('2030-01-01T00:00:00.000Z')
  const line = formatMemoryLine(
    { type: 'preference', state: 'dropped', text: '旧的偏好', capturedAt: '2022-01-01T00:00:00.000Z' },
    now
  )
  assert.ok(line.includes('已删除（墓碑）'))
  assert.ok(!line.includes('久未更新'), '墓碑不再注入，标它的年龄毫无意义')
})

test('超窗条目排到最后，但条数与字数都够时仍然注入 —— 衰减不改记录、不删除', () => {
  const now = new Date('2027-01-01T00:00:00.000Z')
  const mk = (text, day, type = 'preference') => ({
    ...makeCandidate({ text, type }).record,
    status: 'adopted',
    capturedAt: day
  })
  const records = [
    mk('很旧但仍在的偏好', '2024-01-01T00:00:00.000Z'),
    mk('昨天说的偏好', '2026-12-31T00:00:00.000Z')
  ]
  // 预算充足：两条都要在，只是旧的那条排到后面。
  const roomy = selectForInjection(records, 10, { now })
  assert.equal(roomy.selected.length, 2, '超窗不等于不注入')
  assert.equal(roomy.selected[1].text, '很旧但仍在的偏好', '超窗的排在最后')
  // 只剩一个名额：被挤掉的是旧的，且原因是上限而不是「过期」。
  const tight = selectForInjection(records, 1, { now })
  assert.equal(tight.selected.length, 1)
  assert.equal(tight.selected[0].text, '昨天说的偏好')
  // 决策里带上年龄与是否超窗，设置页才解释得清「为什么它排最后」。
  const oldDecision = tight.decisions.find((d) => d.text === '很旧但仍在的偏好')
  assert.equal(oldDecision.decayed, true)
  assert.ok(oldDecision.ageDays >= DECAY_WINDOWS_DAYS.preference)
})

test('真实年龄下零影响：21 条都是 7 天内的偏好/事实，全部 fresh（所以这次改动不改变任何注入结果）', () => {
  const now = new Date('2026-10-22T00:00:00.000Z')
  const captured = '2026-10-15T00:00:00.000Z'
  for (const type of ['fact', 'preference', 'stance', 'event']) {
    const info = decayInfo({ type, capturedAt: captured }, now)
    assert.equal(info.level, 'fresh', `${type} 类在 7 天龄时不该被判为老化`)
  }
})

await section('patrol:巡夜判据')

test('同样的局面只报一次：三条候选挂了一周，第二天不该再报', () => {
  const first = assessPatrol({ pendingIds: ['a', 'b', 'c'] })
  assert.equal(first.shouldReport, true, '第一次见到这组候选，必须说')
  assert.deepEqual(first.reasons, ['pending:3'])

  // 第二次：集合没变 ⇒ 没有新信息。数量 > 0 不等于「有事要说」，
  // 否则每天重复报同一件事，两周后它就成了背景噪音。
  const second = assessPatrol({ pendingIds: ['a', 'b', 'c'], previousSignature: first.signature })
  assert.equal(second.shouldReport, false, '同一条候选挂一周再报一遍是噪音，不是提醒')
  assert.deepEqual(second.reasons, [])
})

test('两条旧的换成两条新的：数量没变，但这是新事，必须说', () => {
  // 这条锁住「指纹向量对集合摘要，不向量对数量摘要」这个决定。
  const before = assessPatrol({ pendingIds: ['old1', 'old2'] })
  const after = assessPatrol({ pendingIds: ['new1', 'new2'], previousSignature: before.signature })
  assert.equal(after.shouldReport, true)
  assert.equal(after.facts.pending, 2, '数量确实没变')
  assert.notEqual(after.signature, before.signature)
})

test('顺序不同不算变化：集合摘要必须先排序去重', () => {
  const a = assessPatrol({ pendingIds: ['x', 'y', 'z'] })
  const b = assessPatrol({ pendingIds: ['z', 'x', 'y', 'x'], previousSignature: a.signature })
  assert.equal(b.shouldReport, false, '同一组 id 换个顺序或重复一次，不是新事')
})

test('体检 flagged 独立于待审：只有体检有问题时也要报', () => {
  const r = assessPatrol({ pendingIds: [], flaggedIds: ['m-1'] })
  assert.equal(r.shouldReport, true)
  assert.deepEqual(r.reasons, ['flagged:1'])
  assert.equal(r.facts.pending, 0)
})

test('整理动过数据要报一次，但同一个结果不会被重复报', () => {
  const r = assessPatrol({ pendingIds: [], flaggedIds: [], removed: 3 })
  assert.equal(r.shouldReport, true, '整理删了东西必须说一声，否则用户不知道记忆少了')
  assert.deepEqual(r.reasons, ['removed:3'])
  const again = assessPatrol({ pendingIds: [], flaggedIds: [], removed: 3, previousSignature: r.signature })
  assert.equal(again.shouldReport, false, '同一次整理结果不该每天重报')
})

test('连续三晚都在自动清理：只有第一晚出声（README「巡夜做不到的事」第 ⑥ 条锁在这里）', () => {
  // 这条用例存在的理由：README 里写了「连续几晚都在自动清理，只有第一晚会说」。
  // 那句是给人看的承诺，没有测试锁着就会腐化 —— 而腐化方向是「每晚都报」，
  // 也就是 m05776「没有就不汇报」要消灭的形状，但没人会立刻发现。
  //
  // **必须只传 previousSignature**，跟 index.mjs:661-666 的真实调用一致。
  // 一旦传了 previousPendingIds，代码会走进另一条分支、跳过指纹里的 t 位，
  // 于是三晚全报 —— 我第一版探针就是这么写错的，事后才定位到是测试的错。
  const night = (removed, previousSignature) =>
    assessPatrol({ pendingIds: [], flaggedIds: [], removed, previousSignature })

  const n1 = night(2, '')
  assert.equal(n1.shouldReport, true, '第 1 晚清理了新东西，必须说')
  assert.deepEqual(n1.reasons, ['removed:2'])

  const n2 = night(2, n1.signature)
  assert.equal(n2.shouldReport, false, '第 2 晚清理量相同，属于同一个结果在重报，必须沉默')

  const n3 = night(3, n2.signature)
  assert.equal(n3.shouldReport, false, '第 3 晚清理量变了也一样：只看「上次动过没」，不看动了几条')
  assert.equal(n3.facts.removed, 3, '沉默不等于不记账 —— 数字仍然要写进 facts')

  const n4 = night(1, 'p:|f:|t:0')
  assert.equal(n4.shouldReport, true, '隔了一晚没动过，再动就要重新说一次')
})

test('真的没事就不出声：三个数都是 0 时 shouldReport 必须是 false', () => {
  // 这是用户 m05776 的原话要求「没有就不汇报」的机械表述。
  const r = assessPatrol({ pendingIds: [], flaggedIds: [], removed: 0 })
  assert.equal(r.shouldReport, false)
  assert.deepEqual(r.reasons, [])
  assert.deepEqual(r.facts, { pending: 0, flagged: 0, removed: 0 })
})

test('有候选但没给 previousSignature（首次运行）：必须报，不能因为「看着像老问题」就沉默', () => {
  const r = assessPatrol({ pendingIds: ['a'] })
  assert.equal(r.shouldReport, true)
  assert.equal(r.facts.checked, undefined, 'facts 里不该凭空多出字段')
})

test('你处理掉候选不是「有事」：三条裁到一条，不该再打扰你一次（m06352 拍板改成这样）', () => {
  // 改判据之前：集合变了 ⇒ 报。于是「我把问题处理完了」这个动作本身
  // 会换来一条通知，形状跟「又有人说你错了」一模一样。
  const before = assessPatrol({ pendingIds: ['a', 'b', 'c'] })
  assert.equal(before.shouldReport, true)
  assert.deepEqual(before.added, { pending: 3, flagged: 0 })

  const after = assessPatrol({ pendingIds: ['b'], previousSignature: before.signature })
  assert.equal(after.shouldReport, false, '你把 a、c 裁决掉了，这是好事，不该拿来打扰你')
  assert.deepEqual(after.added, { pending: 0, flagged: 0 })
  // 但「清掉了两条」这个事实必须留在记录里，否则你以后没法回答
  // 「我上周处理的那批东西哪儿去了」。
  assert.deepEqual(after.cleared, { pending: 2, flagged: 0 })
  assert.deepEqual(after.facts, { pending: 1, flagged: 0, removed: 0 })
})

test('全部清空也不出声：裁到 0 条和裁到 1 条一样，都不是新事', () => {
  const before = assessPatrol({ pendingIds: ['a', 'b'] })
  const after = assessPatrol({ pendingIds: [], previousSignature: before.signature })
  assert.equal(after.shouldReport, false)
  assert.deepEqual(after.cleared, { pending: 2, flagged: 0 })
})

test('减少的同时又新增：新增要报，而且只报新增的数量', () => {
  const before = assessPatrol({ pendingIds: ['old1', 'old2'] })
  const after = assessPatrol({ pendingIds: ['old2', 'new1'], previousSignature: before.signature })
  assert.equal(after.shouldReport, true)
  assert.deepEqual(after.reasons, ['pending:1'], '只新增了一条，不能报成「有 2 条」')
  assert.deepEqual(after.added, { pending: 1, flagged: 0 })
  assert.deepEqual(after.cleared, { pending: 1, flagged: 0 })
})

test('指纹解析失败时宁可多报一次，不能把真事吞掉', () => {
  // 旧介质里可能存着格式不同的指纹。读不懂就当没有上次 —— 多报一次的代价
  // 是多一句话，吞掉的代价是用户永远不知道那条记忆坏了。
  const r = assessPatrol({ pendingIds: ['a'], previousSignature: 'garbage-old-format' })
  assert.equal(r.parseFailed, true, '解析失败必须标出来，否则无从反查')
  assert.equal(r.shouldReport, true, '读不懂旧记录时不能默认「没事」')
})

test('planNightlyWake：已经过了目标时刻就从明天算起，不超过单次上限', () => {
  const hour = 3
  // 01:30 → 目标今天 03:00，间隔 90 分钟，小于 6 小时上限 ⇒ 这次醒来就是目标
  const a = planNightlyWake({ now: new Date('2026-10-24T01:30:00'), hour })
  assert.equal(a.isTarget, true, '90 分钟后就是 3 点，这一次醒来就该跑')
  assert.equal(new Date(a.targetAt).getHours(), 3)
  assert.equal(Math.round(a.delayMs / 60000), 90)

  // 10:00 → 目标明天 03:00，间隔 17 小时 > 6 小时上限 ⇒ 只挂 6 小时，
  // isTarget 必须是 false，那次醒来不许跑巡夜（这是 m06351 那个 bug 的正解）。
  const b = planNightlyWake({ now: new Date('2026-10-24T10:00:00'), hour })
  assert.equal(b.isTarget, false, '中途醒来不该被当成到点')
  assert.equal(Math.round(b.delayMs / 3600000), 6)

  // 23:00 → 目标明天 03:00，4 小时 ⇒ 一次挂到
  const c = planNightlyWake({ now: new Date('2026-10-24T23:00:00'), hour })
  assert.equal(c.isTarget, true)
  assert.equal(Math.round(c.delayMs / 3600000), 4)

  // 正好 03:00 → 目标是明天（不是「此刻已经过期」）
  const d = planNightlyWake({ now: new Date('2026-10-24T03:00:00'), hour })
  assert.equal(d.isTarget, false, '3 点整挂闹钟，目标应是明天 3 点，而不是负延迟')
  assert.equal(Math.round(d.delayMs / 3600000), 6)
})

test('planNightlyWake：nightlyHour 被写成非法值时回落到 3 点，而不是永不触发', () => {
  const r = planNightlyWake({ now: new Date('2026-10-24T01:00:00'), hour: 99 })
  assert.equal(new Date(r.targetAt).getHours(), 3, '非法小时必须回落，否则定时器等于关掉了')
})

await section('patrol:体检明细落盘')

test('体检明细落盘：只留认得出、可反查的四样，不存会过期的建议命令', () => {
  const { items, dropped } = compactFlagged([
    {
      id: 'm-1',
      text: '某条记忆',
      findings: [{ kind: 'path-missing', detail: '路径没了', evidence: 'fs.existsSync(...) === false' }],
      suggestion: { state: 'contradicted', command: '/anima mark m-1 state=contradicted' }
    }
  ])
  assert.equal(dropped, 0)
  assert.equal(items.length, 1)
  assert.deepEqual(items[0].kinds, ['path-missing'])
  assert.equal(items[0].detail, '路径没了')
  assert.equal(items[0].evidence, 'fs.existsSync(...) === false')
  // 建议命令是按 id 现算的，存下来只会过期 —— 它必须不在这份数据里
  assert.equal(items[0].suggestion, undefined, '建议命令被存进了落盘数据（它会过期）')
})

test('体检明细落盘：detail 缺失时退回记忆正文，不留只有 id 的孤儿行', () => {
  const { items } = compactFlagged([{ id: 'm-2', text: '一条没有 findings 的记录' }])
  assert.equal(items.length, 1)
  assert.equal(items[0].detail, '一条没有 findings 的记录', '没 detail 又没退回正文 ⇒ 界面上只有个 id')
  assert.equal(items[0].evidence, '', '没有证据就留空，不能编一条')
})

test('体检明细落盘：超上限截断并如实报告丢了多少条', () => {
  const many = Array.from({ length: MAX_FLAGGED_ITEMS + 3 }, (_, i) => ({
    id: `m-${i}`,
    findings: [{ kind: 'verify-expired', detail: `${i} 过期了`, evidence: 'x' }]
  }))
  const { items, dropped } = compactFlagged(many)
  assert.equal(items.length, MAX_FLAGGED_ITEMS, '落盘条数必须受上限约束')
  assert.equal(dropped, 3, '丢了几条必须能说出来，否则「20 条」和「有 23 条但只显示了 20」长得一样')
})

test('体检明细落盘：长文本被截断，且截断处留标记', () => {
  const long = 'x'.repeat(MAX_FLAGGED_DETAIL_CHARS + 50)
  const { items } = compactFlagged([{ id: 'm-3', findings: [{ detail: long, evidence: long }] }])
  assert.equal(items[0].detail.length, MAX_FLAGGED_DETAIL_CHARS + 1)
  assert.ok(items[0].detail.endsWith('…'), '截断必须留标记，否则读的人以为原话就这么短')
})

test('体检明细落盘：一条问题都没有时是空数组 + 0，而不是 null', () => {
  const { items, dropped } = compactFlagged([])
  assert.deepEqual(items, [])
  assert.equal(dropped, 0)
  assert.deepEqual(compactFlagged(undefined), { items: [], dropped: 0 }, '入参缺失也必须给出同一形状')
})

await section('patrol:汇报文案')

test('巡夜汇报必须写清这次没报什么 —— 只列问题会让人以为剩下的都过了', () => {
  const text = patrolNoticeText({
    facts: { pending: 0, flagged: 1, removed: 0 },
    flaggedDetails: [{ id: 'm-1', text: '某条记忆', findings: [{ detail: '路径不存在：D:\\gone' }] }]
  })
  assert.ok(text.includes('没报的'), '缺「没报什么」这一节就等于暗示其余都通过了')
  assert.ok(text.includes('待审候选（0 条）'), '零的那一项要写出来，不能只写非零的')
  assert.ok(text.includes('/anima mark m-1 state=contradicted'), '每条问题都要给出可直接粘贴的命令')
  assert.ok(text.includes('不在巡夜范围内'), '要主动划清「语义判断不做」的边界，否则用户以为它判了')
})

test('巡夜汇报里的数字必须能自己复算 —— 要指出去哪儿复算', () => {
  const text = patrolNoticeText({ facts: { pending: 2, flagged: 0, removed: 0 }, pendingTitles: ['甲', '乙'] })
  assert.ok(text.includes('待审候选：2 条'))
  assert.ok(text.includes('- 甲') && text.includes('- 乙'), '候选要列出来，只给数字没法判断')
  assert.ok(text.includes('/api/anima/memory/audit'), '必须给出可以自己复算的出口')
})

test('候选超过 5 条时截断并说明还有多少，不能静默丢', () => {
  const titles = ['一', '二', '三', '四', '五', '六', '七']
  const text = patrolNoticeText({ facts: { pending: 7, flagged: 0, removed: 0 }, pendingTitles: titles })
  assert.ok(text.includes('- 五'), '前 5 条要列出来')
  assert.ok(!text.includes('- 六'), '第 6 条不该列')
  assert.ok(text.includes('还有 2 条'), '截断了就必须说还有多少')
})

// ==================== 注入消息的形状（会话 v4 的准入条件）====================

test('注入消息自带 id：缺 id 会让整个会话打不开，不是静默降级', () => {
  const message = createNoticeMessage('测试注入')
  // 宿主加载会话时 assertMessageEventShape 要求每条消息有 id；
  // 缺了它不是「这条消息丢了」，而是「会话事件 at seq N lacks an identified message」
  // → 整个会话打不开。所以这里必须钉住。
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length >= 8, `id 太短：${message.id}`)
})

test('两次注入的 id 不相同：写死 id 会让第二条被当成重复消息', () => {
  const a = createNoticeMessage('甲')
  const b = createNoticeMessage('乙')
  assert.notEqual(a.id, b.id)
})

test('注入消息的角色与来源仍合规：kind 自持、form 为 snapshot', () => {
  const message = createNoticeMessage('测试注入')
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'plugin:dsh-anima')
  assert.notEqual(message.source.kind, 'plugin', 'v4 明确拒绝共享的 plugin kind')
  assert.equal(message.source.form, 'snapshot')
  assert.ok(Array.isArray(message.source.sections) && message.source.sections.length > 0)
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
