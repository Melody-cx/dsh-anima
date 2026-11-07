// index.mjs — dsh-anima（host 半边）
//
// 定位（用户 m03846 拍板「A 自建补齐」）：
//   本插件**自持全部人设字段**，不依赖任何其它插件。字段设计对照某产品
//   设置页（「个性化」+「记忆与进化」两页）与某同类人设插件 0.7.0 的字段集，但代码
//   全部自写 —— 字段名、界面布局、功能划分属思想，不受版权保护；MIT 只约束代码复制。
//
//   三类能力：
//     ① 助手自身身份（agentName/agentRole）+ 用户背景 + 风格/特质/长度/语言 + 补充指令
//     ② 按工作区两级覆盖（field-level merge，工作区只覆盖它明确声明的字段）
//     ③ 带待审缓冲区的长期记忆（15+ 记忆插件无一做过「自动整理 → 缓冲区 → 用户裁决」）
//
// 独立插件：字段集不依赖任何其它插件，装上即可用。
//
// 三条硬约束（取证所得，改动这里前先读）：
//   - section 名必须避开 它注册的那条 context / `deployment:persona-prefix` / `deployment:persona-suffix`
//   - `section.text` 可以是函数，但装配期是**同步**调用（dsh-system-prompt\lib\index.js:342），
//     所以工作区覆盖的读取必须走同步路径（lib/workspace.mjs 的 resolveOverridesFromCwdSync）
//   - 会话格式 v4 要求注入消息自持 producer kind（lib/injection.mjs）
//   - 存储层**没有文件后端兜底**（2026-10-10 决定，与某同生态插件的取舍一致）：
//     storageDomain 缺失或打开失败时抛 StorageUnavailableError（statusCode 503），
//     由路由与命令各自呈现给用户；首次装载失败时挂 ctx.inject 就绪信号重试一次，
//     绝不悄悄换一个落盘点。未装载成功前，五段 section 一律返回空串 —— 宁可没有人设，
//     也不要把一份「默认档」当成用户的人设注入进去。

import { existsSync } from 'node:fs'
import {
  DEFAULT_CONFIG,
  FIELD_LIMITS,
  OVERRIDABLE_FIELDS,
  formatFieldErrors,
  mergePersona,
  sanitizeConfig,
  sanitizeOverrides
} from './lib/config.mjs'
import { StateStore } from './lib/store.mjs'
import { FIELD_EXAMPLES, WORDING_TABLES } from './lib/wording.mjs'
import {
  compileDisabledNotice,
  compileIdentity,
  compileInstructions,
  compileMemory,
  compilePendingNotice,
  compilePersona,
  compileRememberGuide,
  compileRules,
  compileStyle,
  compileUserProfile,
  describeSources,
  safeSection
} from './lib/prompt.mjs'
import {
  BUILTIN_PRESETS,
  PRESET_COUNT_LIMIT,
  PRESET_FIELDS,
  applyPreset,
  findActivePreset,
  listPresets,
  resolvePreset,
  sanitizeCustomPreset
} from './lib/presets.mjs'
import {
  configChangedNoticeText,
  createInjectionSource,
  createNoticeMessage,
  patrolNoticeText,
  qualityReminderText,
  triageNoticeText
} from './lib/injection.mjs'
import {
  ensureIgnored,
  readOverrides,
  removeOverrides,
  resolveOverridesFromCwdSync,
  writeOverrides
} from './lib/workspace.mjs'
import {
  applyMemoryMeta,
  clusterPending,
  groupByStatus,
  makeCandidate,
  selectForInjection,
  summarizeOmission,
  triage
} from './lib/memory.mjs'
import {
  IMPORT_MAX_ITEMS,
  IMPORT_MAX_SOURCE,
  IMPORT_PROMPT_FULL,
  findImportOverlaps,
  parseImport
} from './lib/import.mjs'
import { auditMemories } from './lib/memory-audit.mjs'
import { assessPatrol, compactFlagged, planNightlyWake } from './lib/patrol.mjs'
import {
  assessRetrospect,
  compactLeads,
  extractLeads,
  retrospectNoticeText
} from './lib/retrospect.mjs'
import {
  hasZstdSupport,
  isSubagentSession,
  listSessionFiles,
  readSessionEvents,
  sessionsRoot,
  toLeadEvents
} from './lib/sessions.mjs'
import { AUDIT_ACTORS, AUDIT_MAX_RECORDS, AUDIT_SOURCE_TEXT, summarizeAudit } from './lib/audit.mjs'
import {
  checkResponse,
  compileLedgerRules,
  compileQualityRules,
  detectLedgerTriggers,
  hasLedgerBlock
} from './lib/quality.mjs'

export const name = 'anima'

const LOG = '[dsh-anima]'

// 排在 DEPLOYMENT_PERSONA_PREFIX(0) 之后、PLAN_POLICY(500) 之前。
//
// 这里**不要**再写「与某同类人设插件注册的那条 section（order 0）错开」——
// 那是 1.0.0 时期的注释，现在已经不成立：那款插件早就把它
// 从 section 改成了 context（本机调研副本 `lib/index.js:633`），
// 而 section 与 context 是两条互不相干的数轴（宿主
// `SECTION_ORDERS` / `CONTEXT_ORDERS` 各自独立排序，见
// docs/host-prompt-semantics.md 第 1 节）。拿别人的 section order
// 当参照物是无效的，拿别人的 context order 当参照物更是无效。
// 现在这句话留着只会让下一个人以为需要避让——注释里的错误比没有注释更贵。
const SECTION_IDENTITY = 'anima:identity'
const SECTION_MEMORY = 'anima:memory'
const SECTION_PENDING = 'anima:pending'
// 质检段排在待审提示之后、PLAN_POLICY(500) 之前：
// 它是「怎么回答」的约束，必须比「有哪些记忆」更靠近生成点，
// 否则模型会先读到一堆背景再看到规则，规则容易被当成背景的一部分。
const SECTION_QUALITY = 'anima:quality'
// remember 行为指引，order 22 = 紧跟在「有哪些记忆」(20) 与「有几条待审」(21) 之后：
// 先说清已经有了什么、还有什么没生效，再讲「以后要记什么」——顺序反过来，
// 模型会先看到一堆操作指引，却不知道自己现在手上有什么。
// 排在质检段(30)之前：它是「知识怎么积累」，质检是「话怎么说」，前者更靠前。
const SECTION_REMEMBER = 'anima:remember'
const ORDER_IDENTITY = 10
const ORDER_MEMORY = 20
const ORDER_PENDING = 21
const ORDER_REMEMBER = 22
const ORDER_QUALITY = 30

const MAX_BODY_BYTES = 256 * 1024

const warn = (ctx, message) => {
  try {
    ctx?.logger?.warn?.(`${LOG} ${message}`)
  } catch { /* 日志失败不影响主流程 */ }
}

/**
 * 把「跳过原因」渲染成一句人话，附在 /anima show 的质检运行行后面。
 *
 * 空计数返回空串（没跳过就不占版面）。用固定顺序而不是 Object.keys 的插入顺序：
 * 计数器的键顺序取决于代码里 return 的先后，重构一次就会变，而这一行是给人看的诊断。
 */
function describeSkips(skipped) {
  const order = [
    ['not-loaded', '未装载'],
    ['disabled', '质检关闭'],
    ['pre-step-check-off', '机制检查关闭'],
    ['no-session', '拿不到会话'],
    ['no-events', '读不到事件'],
    ['no-assistant-message', '还没有回答'],
    // empty-text 的实际含义是「最近一条 assistant 事件的正文是空的」，
    // 最典型的情形就是工具调用步 —— 那一步本来就没有话说。
    // 旧措辞「最近一条无正文」读起来像是出了问题，让人以为质检在漏查；
    // 但它是**正常且必然**发生的一类跳过，措辞不该带故障暗示。
    ['empty-text', '工具步无正文'],
    ['already-checked', '同一条已查过'],
    ['turn-budget', '本轮提醒额度用完'],
    ['reject', '链路已拒绝'],
    ['error', '钩子异常']
  ]
  const parts = order
    .filter(([key]) => (skipped?.[key] ?? 0) > 0)
    .map(([key, label]) => `${label} ${skipped[key]}`)
  return parts.length ? `；跳过：${parts.join('、')}` : ''
}

// ==================== 运行期状态 ====================

/**
 * 运行期缓存：section.text 在装配期同步执行，不能 await 存储，
 * 因此用一个「内存快照」承接已加载的数据，写入路径负责刷新它。
 */
const runtime = {
  config: DEFAULT_CONFIG,
  adopted: [],
  pendingCount: 0,
  store: null,
  ctx: null,
  refresh: null,
  /** 是否已成功把落盘状态读进内存。false 时提示词段一律空 —— 见文件头第四条约束。 */
  loaded: false,
  /**
   * 待确认的人设变更提议（confirm 模式用；进程内短生命周期，不做持久化）。
   * 与某同类人设插件的 `pendingPersonaProposal` 同款设计：它只是「模型提了个请求，
   * 等用户点头」的暂存区，重启即失效 —— 一份没被确认的提议本就不该跨会话活着。
   */
  pendingProposal: null,
  /**
   * 质检钩子的运行计数。
   *
   * 为什么必须有这个计数器：没有它，「一条提醒都没有」这一现象有两种完全相反的
   * 解读 —— (a) 钩子跑了、判了 N 条、确实没有该报的；(b) 钩子根本没跑，或者
   * 每轮都在读空文本就早早返回。两种情况下用户看到的东西一模一样：什么都没有。
   * 而 (b) 意味着整个质检层是死的，却表现得和「一切正常」完全相同。
   *
   * 这和「不许谎报检查结果」是同一条要求的另一面：**不许让「没查」长得像「查过没事」**。
   * 计数器是唯一能把这两者分开的东西，所以它不是调试残留，是交付物的一部分。
   *
   * 口径是**跨重启累计**：落盘在 meta.qualityStats，启动时读回接着累加。
   * （早期版本只放内存、重启清零 —— 那会让「0 次」这个数字同时代表
   * 「真的没查」和「查过但刚重启」，把计数器本身的意义抹掉。）
   * `startedAt` 是本次启动的时刻，与累计值分开表达。
   */
  qualityStats: {
    checks: 0,        // 真正进入判定的次数（读到非空文本并跑了 checkResponse）
    reminders: 0,     // 实际发出提醒的次数
    suppressed: 0,    // 判到了问题、但被「每轮上限」压住没发的次数
    skipped: {},      // 每个提前返回原因的累计计数
    last: null,       // 最近一次判定的摘要（不落盘：时间久了没有诊断价值）
    startedAt: null,  // 本次启动时刻（ISO）
    flushedAt: null   // 最后一次成功落盘的时刻（ISO）
  }
}

/**
 * 工具可写的人设字段。
 *
 * 与 OVERRIDABLE_FIELDS 同集合，但**刻意不共用**：那个常量决定「工作区能覆盖谁」，
 * 这个决定「模型能改谁」。两者今天重合，明天未必 —— 比如给工作区加一个
 * 只读的派生字段时，不该顺带把它变成模型可写的。
 */
const TOOL_FIELDS = [
  'agentName', 'agentRole', 'addressUserAs',
  'userOccupation', 'userBio',
  'style', 'headingLists', 'emoji', 'tables', 'replyLength', 'language',
  'customInstructions'
]

// ==================== 提示词装配 ====================

/**
 * 求当前会话的工作区覆盖。
 * context.agent 由 dsh-agent 的 assembleContextFor 填入（dsh-agent\lib\index.js:291），
 * `context.agent.session.header.cwd` 即会话工作目录。
 */
function overridesForContext(context) {
  if (!runtime.config.workspaceOverridesEnabled) return null
  const cwd = context?.agent?.session?.header?.cwd
  if (!cwd) return null
  try {
    return resolveOverridesFromCwdSync(cwd, runtime.config.workspaceFileDir)
  } catch (err) {
    warn(runtime.ctx, `读取工作区覆盖失败：${String(err?.message || err)}`)
    return null
  }
}

/**
 * 本地绑定：把 lib 层那个「绝不抛」的 `safeSection` 接到宿主 logger 上。
 *
 * 为什么实现放在 lib、只有接线放在这里：
 * 这个文件被宿主的插件加载器直接执行，`verify-core` 没法 import 它（依赖宿主包），
 * 于是任何写在这里的函数都只能靠「读源码字符串 + 正则匹配」来断言 ——
 * 那测的是拼写，不是行为。把它挪进 `lib/prompt.mjs` 之后，
 * 回归可以真的传一个会抛的渲染函数进去，断言它返回 ''、断言回调收到消息。
 */
const renderSection = (label, render) => safeSection(label, render, (message) => warn(runtime.ctx, message))

/** 身份段：每轮装配期实时求值，因此工作区覆盖能立刻生效，无需重启会话。 */
function identityText(context) {
  // 装载失败时返回空串：宁可没有人设，也不注入一份默认档冒充用户配置。
  if (!runtime.loaded) return ''
  // 关掉插件时改为注入一句「已关闭」的声明 —— 见 compileDisabledNotice 的注释：
  // 会话历史里的旧设定不会自己消失，只有明说作废才能让模型停止沿用。
  if (!runtime.config.enabled) return compileDisabledNotice()
  return renderSection('identity', () => {
    const local = overridesForContext(context)
    const { effective } = mergePersona(runtime.config, local?.overrides ?? null)
    return compilePersona(effective)
  })
}

/**
 * 长期记忆段：只含用户已采纳的条目，且只含**适用于当前会话工作区**的条目。
 *
 * 这里接 context 不是为了工作区覆盖（记忆不参与 override），而是为了拿到
 * 会话的 cwd —— `selectForInjection` 靠它判断一条 workspace 记忆是否属于
 * 当前项目。没有它，所有工作区记忆在注入期都无法匹配（等于全部丢失）。
 */
function memoryText(context) {
  if (!runtime.loaded) return ''
  if (!runtime.config.enabled) return ''
  if (!runtime.config.memory.enabled) return ''
  return renderSection('memory', () => {
    const selection = injectionSelection(context)
    return compileMemory(selection.selected, summarizeOmission(selection))
  })
}

/** 统一的注入筛选入口：段渲染与设置页预览必须走同一套参数，否则「预览里有的、实际没有」。 */
function injectionSelection(context) {
  return selectForInjection(runtime.adopted, runtime.config.memory.maxInjected, {
    maxInjectedChars: runtime.config.memory.maxInjectedChars,
    cwd: context?.agent?.session?.header?.cwd ?? ''
  })
}

/** 待审提示段：让模型知道有候选但没有生效。 */
function pendingText() {
  if (!runtime.loaded) return ''
  if (!runtime.config.enabled) return ''
  if (!runtime.config.memory.enabled) return ''
  return renderSection('pending', () => compilePendingNotice(runtime.pendingCount))
}

/**
 * remember 行为指引段。
 *
 * 注册条件刻意写在**函数内部**而不是注册点：section 的注册发生在配置可能还没读完的
 * 时候，而 `text` 每轮装配期都会重新求值。放外面的后果是「用户在设置里打开自动捕获，
 * 但这一段要等重启才出现」——那正好是最需要它出现的时刻。
 *
 * 但 `autoCapture` 关掉时必须返回空串：`remember` 工具在这种情况下会直接拒绝
 * （`index.mjs` 的 execute 里第一条判断），告诉模型去用一个必然失败的工具，
 * 比什么都不说更糟 —— 它会反复尝试，然后把失败解释成「系统坏了」。
 */
function rememberText() {
  if (!runtime.loaded) return ''
  if (!runtime.config.enabled) return ''
  if (!runtime.config.memory.enabled) return ''
  if (!runtime.config.memory.autoCapture) return ''
  return renderSection('remember', () => compileRememberGuide())
}

/**
 * 质检段：十二条判据 + 对账三档。
 *
 * 之所以放进提示词而不是只靠 pre-step 机制：pre-step 只能在**事后**指出
 * 「上一轮少写了什么」，它没法让这一轮就写对。两者是配套的 ——
 * 提示词负责让规则可被遵守，机制负责让违反可被看见。
 */
/**
 * 质检段的**唯一**拼装入口。
 *
 * 之前这段文本被抄了三处（提示词 section、getSystemPrompt、/api/anima/preview），
 * 结果第三处漏掉了末尾「关于上一段怎么被检查」那三个小节 —— 同一个概念有三份
 * 实现，迟早会漂成三份不一样的文本。现在三处都只调这一个函数：
 * 有任何一处想加内容，另外两处自动跟上；没有任何一处能悄悄单独改变。
 *
 * @param {object|undefined} quality 质检配置；缺失或 enabled=false 时返回空串。
 * @returns {string}
 */
function compileQualitySection(quality) {
  if (!quality || !quality.enabled) return ''
  const parts = [compileQualityRules(), compileLedgerRules(quality.ledgerLevel)].filter(Boolean)
  if (parts.length === 0) return ''
  // 末句把「谁在判」说清楚：这段话是判据，不是我已经通过了的证明。
  parts.push([
    '## 关于上一段怎么被检查',
    '每轮结束前会有代码（不是你自己）用上面这些形状检查你的回答，命中就在下一步开始时提醒你。',
    '那是机器判词，不是你的自我评价；被提醒时照它改，不要辩解称自己「已经注意了」。'
  ].join('\n'))
  return parts.join('\n\n')
}

function qualityText() {
  if (!runtime.loaded) return ''
  if (!runtime.config.enabled) return ''
  return renderSection('quality', () => compileQualitySection(runtime.config.quality))
}

// ==================== 质检层：pre-step 机制检查 ====================

/**
 * 每会话的检查痕迹：记录上一条被检查过的 assistant 事件序号，避免同一句话被反复提醒。
 * 用 WeakMap 挂 session 对象，会话销毁即回收，不需要手动清理。
 */
const checkedSeq = new WeakMap()

/**
 * 每会话每轮的提醒次数上限。
 *
 * 为什么必须有这个闸门：提醒是一条 user 消息，它会让我再答一条；那条回答如果
 * 仍然命中（比如我确实补不出证据，只能重复说「没核过」），就会再触发一次提醒。
 * 宿主的一个 turn 内可以有多步，理论上能滚成一轮内无限重来 —— 用户看到的是
 * 回答一次，实际后台在空转，烧的是他的额度。这类「机制自己把自己拉起来」的
 * 循环比漏报危险得多：漏报只是没抓住我，自激是把我变成了不可控的刷子。
 * 上限不是调参问题，是安全阀：到顶就停，并明确说「这一轮不再提醒」。
 */
const MAX_REMINDERS_PER_TURN = 2
const remainingReminders = new WeakMap()  // session → { turn, left }

/**
 * 从 assistant/message 事件里取出纯文本（跳过工具调用块等非文本内容）。
 *
 * ⚠️ 事件形状是实测出来的，不要凭直觉改。DSH 落盘的 assistant/message 事件是：
 *   { type:'assistant/message', seq, time, data: { turn, step, message, usage, stream } }
 * 消息本体在 data.message（{ role, content, source, id }）里，
 * 所以文本在 **data.message.content**，不在 data.content。
 *
 * 这里踩过坑并且值得写下来：第一版读的是 data.content，永远取到空串，
 * 钩子每轮都在 `text === ''` 处静默返回 —— 日志里零报错，看起来像「没命中」。
 * 更糟的是单元测试的夹具照抄了这个错误形状，所以测试全绿也抓不到。
 * 夹具必须照抄现实，不能照抄实现。
 *
 * 现在两种形状都认：优先真实形状，再退回简写形状（兼容测试与未来版本）。
 */
function eventText(event) {
  const collected = []
  const pushFrom = (blocks) => {
    if (!Array.isArray(blocks)) return
    for (const b of blocks) {
      if (b?.type === 'text' && typeof b.text === 'string') collected.push(b.text)
    }
  }
  pushFrom(event?.data?.message?.content)
  if (collected.length === 0) pushFrom(event?.data?.content)
  return collected.join('\n').trim()
}

/**
 * 挂 agent/pre-step：读**上一轮**的 assistant 回答，用 lib/quality.mjs 的纯函数判定，
 * 命中就往下一条 user 消息批里追加一条 plugin 来源的提醒。
 *
 * 为什么这是整套设计里唯一「不靠我自检」的位置：
 * 检查发生在模型之外——代码先读已落盘的 assistant 消息，再决定要不要提醒。
 * 模型无法「觉得自己没问题」来绕过它，因为它根本不参与这个判定。
 *
 * 但它也有明确的天花板，写在这里防止被当成万能：
 *   - 它只能看**写出来的字**，看不到我没说的话（R07 选择性呈现它判不了）；
 *   - 它判的是形状（有没有来源、有没有对账块），不是内容对不对；
 *   - 提示发出去之后，我到底改没改，它管不了 —— 那是下一轮 shape 检查的事了。
 *
 * 失败一律静默降级：质检是增强能力，任何异常都不该让对话本身失败。
 */
function registerQualityHook(ctx) {
  /**
   * 记一次「进去了但没查成」。必须带原因，否则计数器只会告诉用户「跳过很多次」，
   * 却说不清是预算用完了还是根本没读到文本 —— 那和不计数没区别。
   */
  const skip = (reason) => {
    const s = runtime.qualityStats.skipped
    s[reason] = (s[reason] ?? 0) + 1
    // 每一项跳过原因是「没查」的证据，值得落盘 —— 尤其 empty-text / no-events
    // 这种高频项：它们比 checks 更能说明钩子在空转。
    scheduleQualityStatsFlush()
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision?.kind === 'reject') { skip('reject'); return decision }
      if (!runtime.loaded || !runtime.config?.enabled) { skip('not-loaded'); return decision }
      const q = runtime.config.quality
      if (!q || !q.enabled) { skip('disabled'); return decision }
      if (!q.preStepCheck) { skip('pre-step-check-off'); return decision }

      const agent = payload?.agent
      const session = agent?.session
      if (!session || typeof session.snapshotEvents !== 'function') { skip('no-session'); return decision }

      // 每轮独立计数：换轮就回满。用 payload.turn（宿主在 position 里给的，和 step 同级）。
      //
      // ⚠️ 额度只限制「发不发提醒」，**不限制「查不查」**。
      // 早期版本把额度判断放在这里（检查之前），后果是被挡掉的那些回答根本没被
      // 检查过 —— 于是「这一轮有几条该提醒而没提醒」这个问题永远没有答案，
      // 统计里只有一个笼统的「额度用完 N 次」。那正是「没查」长得像「查过没事」。
      // 现在改成：每一条都查，查完再决定发不发；被挡的单独记成 suppressed。
      const turn = typeof payload?.turn === 'number' ? payload.turn : -1
      const budget = remainingReminders.get(session)
      if (!budget || budget.turn !== turn) {
        remainingReminders.set(session, { turn, left: MAX_REMINDERS_PER_TURN })
      }
      const state = remainingReminders.get(session)

      // 找最后一条 assistant 回答。step === 1 时上一轮刚结束，正是要检查的对象；
      // 后续 step 是同一轮内的工具循环，最后一条往往是只带工具调用的空文本消息。
      const events = session.snapshotEvents()
      if (!Array.isArray(events)) { skip('no-events'); return decision }
      let idx = -1
      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i]?.type === 'assistant/message') { idx = i; break }
      }
      if (idx === -1) { skip('no-assistant-message'); return decision }

      const event = events[idx]
      const seq = typeof event.seq === 'number' ? event.seq : idx
      if (checkedSeq.get(session) === seq) { skip('already-checked'); return decision }

      // 只带工具调用的 assistant 消息（同一轮内的中间步）一定会走到这里。
      // 它们不是「回答」，没有可检查的文字，所以是 skip 而不是 check。
      const text = eventText(event)
      if (text === '') { skip('empty-text'); return decision }

      // 到这里才算一次真正的检查 —— 上面所有 return 都不算。
      // 注意：额度（state.left）在这之后才看。查一定要查，发不发才受额度约束。
      runtime.qualityStats.checks += 1
      checkedSeq.set(session, seq)
      scheduleQualityStatsFlush()

      // 先算判词，确定了要提醒才占配额、才记账 —— 否则「检查过但不发」也会吃掉次数。
      const result = checkResponse(text, { ledgerLevel: q.ledgerLevel, strict: q.strict === true })
      const notice = qualityReminderText(result, q.maxFindingsInReminder ?? 5)
      // 额度用完时这条回答仍然被检查了，只是提醒没发出去。
      // 它必须**单独计数**而不是混进 reminders：否则「发了几条」有了，
      // 「因为闸门压住了几条」永远查不到，用户看到的覆盖率就是一个无法解释的数。
      const suppressed = notice !== '' && state.left <= 0
      if (suppressed) {
        runtime.qualityStats.suppressed = (runtime.qualityStats.suppressed ?? 0) + 1
        skip('turn-budget')
      }
      runtime.qualityStats.last = {
        seq,
        at: new Date().toISOString(),
        chars: text.length,
        findings: (result.findings || []).map((f) => f.ruleId),
        uncovered: result.uncovered || [],
        injected: notice !== '' && !suppressed
      }
      if (notice === '' || suppressed) return decision

      state.left -= 1
      runtime.qualityStats.reminders += 1
      scheduleQualityStatsFlush()
      const message = createNoticeMessage(notice)
      return { ...decision, messages: [...decision.messages, message] }
    } catch (err) {
      skip('error')
      warn(ctx, `质检钩子异常（已跳过本轮检查）：${String(err?.message || err)}`)
      return decision
    }
  }, { prepend: true })
}

function registerSystemPrompt(ctx) {
  ctx.inject(['systemPrompt'], (spCtx) => {
    let dispose = []

    const register = () => {
      for (const d of dispose) {
        try { d() } catch { /* 已释放 */ }
      }
      // 先释放旧 section 再注册新的，触发 system-prompt/change，
      // 让 DSH 丢弃当前会话已缓存的 system prompt 快照（手法同某同类人设插件）。
      //
      // `interpolate: false` 是必需的安全阀，不是性能优化。
      // 宿主 renderPrompt 会对每个 section 跑 interpolate()，规则是：
      //   `{{` 后面必须紧跟 `标识符}}`，否则抛 malformed；
      //   标识符没注册在 assembly.variables 里就抛 unknown。
      // 抛出点在 systemPrompt.assemble() 内部 —— 也就是整轮装配失败，
      // 不是「这一段空着」，是整次请求起不来。
      // 而我们的五段里有**两段**含用户自由输入或模型写入的文本：
      //   identity 段 ← persona（userBio / customInstructions / style …）
      //   memory  段 ← 用户采纳的记忆正文
      // 其余三段（pending 只有数量、remember 与 quality 是静态文案）不含外部文本。
      // 用户只要在设定里写「我的笔记格式是 {{key: value}}」，
      // 或者存一条含 `{{x}}` 的记忆，装配就会抛。
      // 已实测：compilePersona 把 userBio 原样透传，`{{a.b}}` 一路活到宿主
      // 的 interpolate 并抛 malformed（细节见 docs/host-prompt-semantics.md 第 6 节）。
      // 我们从不注册宿主变量，关掉零代价。
      dispose = [
        spCtx.systemPrompt.section({ name: SECTION_IDENTITY, order: ORDER_IDENTITY, text: identityText, interpolate: false }),
        spCtx.systemPrompt.section({ name: SECTION_MEMORY, order: ORDER_MEMORY, text: memoryText, interpolate: false }),
        spCtx.systemPrompt.section({ name: SECTION_PENDING, order: ORDER_PENDING, text: pendingText, interpolate: false }),
        spCtx.systemPrompt.section({ name: SECTION_REMEMBER, order: ORDER_REMEMBER, text: rememberText, interpolate: false }),
        spCtx.systemPrompt.section({ name: SECTION_QUALITY, order: ORDER_QUALITY, text: qualityText, interpolate: false })
      ]
    }

    register()
    runtime.refresh = register

    ctx.effect(() => () => {
      for (const d of dispose) {
        try { d() } catch { /* 已释放 */ }
      }
      dispose = []
      runtime.refresh = null
    }, 'dsh-anima: system prompt sections')
  })
}

// ==================== 状态快照 ====================

/**
 * 真正会改变**注入文本**的配置键。
 *
 * 为什么需要这份名单：配置写入后要通知活动会话「旧设定作废」，但并非每次写入都值得
 * 打扰用户 —— 改一个光轨颜色、勾一下工具确认，注入的文字一个字都不会变。只有
 * 名单里的键变了才发通知，否则每点一下开关就在对话里插一条系统消息。
 */
const PROMPT_AFFECTING_FIELDS = new Set([
  'enabled',
  'agentName', 'agentRole', 'addressUserAs', 'userOccupation', 'userBio',
  'style', 'headingLists', 'emoji', 'tables', 'replyLength', 'language',
  'customInstructions',
  'workspaceOverridesEnabled', 'workspaceFileDir'
])

const affectsPrompt = (changed) => changed.some(
  (key) => PROMPT_AFFECTING_FIELDS.has(key)
    || String(key).startsWith('memory.')
    || String(key).startsWith('quality.')
)

/**
 * 比较两份工作区覆盖，返回发生变化的字段名。
 *
 * 不复用 store 的 `diffConfig`：那个函数是为「整份配置」写的（还带 presets 与
 * memory 段），而覆盖文件里只有 OVERRIDABLE_FIELDS 这十二个字段。用同一份名单
 * 比较，才不会出现「覆盖里冒出一个不该有的键，通知里也跟着念一遍」。
 */
function diffOverrides(before, after) {
  const a = before && typeof before === 'object' ? before : {}
  const b = after && typeof after === 'object' ? after : {}
  return { changed: OVERRIDABLE_FIELDS.filter((key) => a[key] !== b[key]) }
}

/**
 * 把落盘状态读进 runtime，并在必要时触发提示词重注册。
 *
 * @param {object} [options]
 * @param {boolean} [options.refreshPrompt] 是否重注册 section（默认 true）
 * @param {?{changed: string[], source?: string}} [options.configChange]
 *   本次配置变更的字段清单与来源。给了就代表「这是一次由用户发起的配置写入」，
 *   reload 会在重注册之后向活动会话注入一条「旧设定作废」的说明。
 *   只影响提示词的字段才会真的发通知，见 PROMPT_AFFECTING_FIELDS。
 */
async function reload(ctx, { refreshPrompt = true, configChange = null } = {}) {
  const store = runtime.store
  if (!store) return
  const config = await store.getConfig()
  runtime.config = config
  // 读到了才置 true：五段 section 靠它判断「内存快照是否有效」，
  // 首次加载失败时宁可没有人设，也不注入一份默认档冒充用户配置。
  runtime.loaded = true

  if (config.memory.enabled) {
    const all = await store.listMemories()
    const groups = groupByStatus(all)
    runtime.adopted = groups.adopted
    runtime.pendingCount = groups.pending.length
  } else {
    runtime.adopted = []
    runtime.pendingCount = 0
  }

  // 质检计数从介质读回：这几个数字是「质检层活着没有」的唯一证据，
  // 只放内存会让每次重启都重置成 0，而 0 同时也代表「真的没查过」——
  // 两种相反的事实长得一样，正是计数器本来要消灭的沉默。
  await restoreQualityStats(store)

  if (refreshPrompt && typeof runtime.refresh === 'function') {
    try { runtime.refresh() } catch (err) { warn(ctx, `提示词重注册失败：${String(err?.message || err)}`) }
  }

  // 重注册之后才发通知：先让下一轮的系统提示变成新内容，模型收到通知时看到的
  // 已经是新设定，不会出现「通知说改了、这一轮读到的还是旧的」。
  if (configChange) {
    const changed = Array.isArray(configChange.changed) ? configChange.changed : []
    if (changed.length > 0 && affectsPrompt(changed)) {
      await notifyConfigChange(ctx, changed, configChange.source)
    }
  }
}

// ==================== 质检计数的持久化 ====================

/** meta 表里存质检计数的键。与 triage / patrol 同级，靠键区分形状。 */
const QUALITY_STATS_KEY = 'qualityStats'

/** meta 表里存回扫记录的键。与 triage / patrol / qualityStats 同级，靠键区分形状。 */
const RETROSPECT_KEY = 'retrospect'

/**
 * 回扫是否「今天已经扫过」。
 *
 * 判据只看 meta.retrospect 自己的 scannedAt，不看 meta.triage 的 lastTriageDay ——
 * 两者是独立的动作，用巡夜的日期去挡回扫，会出现「巡夜今天跑过了，回扫就被跳过」。
 * 还没扫过（没有记录）时返回 false，即「该扫」。
 */
function retrospectScannedToday(meta) {
  const at = meta?.scannedAt
  if (typeof at !== 'string' || at === '') return false
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return false
  return dayKey(d) === dayKey()
}

/** 两次落盘之间的最小间隔（毫秒）。pre-step 每步都跑，不节流等于把磁盘当计数器用。 */
const QUALITY_STATS_FLUSH_MS = 10_000

/** 节流器：为 null 表示当前没有排队中的写盘。 */
let qualityStatsFlushTimer = null
let qualityStatsFlushAt = 0

/**
 * 从介质读回质检计数。
 *
 * 用**累加**而不是覆盖：一份计数是这台机器上这个插件总共跑了多少次，
 * 重启不该把它抹掉。代价是「本次启动查了多少」这个数字会丢 —— 所以另外
 * 用 `startedAt` 记住本次启动的时刻，两者一起给出去，用户自己能分开看。
 *
 * @param {object} store StateStore 实例
 */
async function restoreQualityStats(store) {
  try {
    const table = await store.table?.('meta')
    const saved = table?.get?.(QUALITY_STATS_KEY)
    if (!saved || typeof saved !== 'object') {
      // 头一回运行：记下启动时刻即可，计数保持 0。
      runtime.qualityStats.startedAt = new Date().toISOString()
      return
    }
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
    runtime.qualityStats.checks = num(saved.checks)
    runtime.qualityStats.reminders = num(saved.reminders)
    runtime.qualityStats.suppressed = num(saved.suppressed)
    // skipped 逐键累加：不同版本的键集合会变，整体覆盖会让新键凭空多出来。
    const skipped = saved.skipped && typeof saved.skipped === 'object' ? saved.skipped : {}
    for (const [key, value] of Object.entries(skipped)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        runtime.qualityStats.skipped[key] = value
      }
    }
    runtime.qualityStats.startedAt = new Date().toISOString()
    runtime.qualityStats.flushedAt = typeof saved.flushedAt === 'string' ? saved.flushedAt : null
  } catch (err) {
    // 读不回来不能让插件起不来：计数是诊断信息，不是主功能。
    // 但要留一行日志，否则「重启之后数字归零」会被当成正常行为。
    warn(runtime.ctx, `质检计数读回失败（本次从 0 开始累加）：${String(err?.message || err)}`)
    runtime.qualityStats.startedAt = new Date().toISOString()
  }
}

/**
 * 把质检计数写回介质。
 *
 * 失败只 warn，不重试、不抛：计数丢一次不影响任何判断，而它抛出去会连累
 * 正在跑的 pre-step 钩子 —— 那个钩子的失败会让整轮对话失败。
 */
async function flushQualityStats(store = runtime.store) {
  if (!store) return { ok: false, error: '存储未就绪' }
  try {
    const table = await store.table?.('meta')
    if (!table || typeof table.put !== 'function') return { ok: false, error: 'meta 表不可用' }
    const stats = runtime.qualityStats
    const payload = {
      checks: stats.checks,
      reminders: stats.reminders,
      suppressed: stats.suppressed,
      skipped: { ...stats.skipped },
      startedAt: stats.startedAt,
      flushedAt: new Date().toISOString()
    }
    await table.put(QUALITY_STATS_KEY, payload)
    stats.flushedAt = payload.flushedAt
    return { ok: true }
  } catch (err) {
    warn(runtime.ctx, `质检计数落盘失败（下次会重试）：${String(err?.message || err)}`)
    return { ok: false, error: String(err?.message || err) }
  }
}

/**
 * 标记计数已变脏，安排一次节流写盘。
 *
 * 为什么不每步直接 await 写盘：pre-step 位于每一次模型调用之前，写盘是异步 I/O，
 * 在高频场景（一次任务几十步）里会变成纯粹的浪费 —— 而这段时间里计数只增不减，
 * 中途丢掉一次的真实损失是「少记几步」，不是「数据不一致」。
 *
 * 反过来也不能完全不写：插件崩掉或用户强退时，内存里的数字直接消失，
 * 那正好是最需要它的时候。10 秒节流是这两者之间的折中，不是拍脑袋的常数 ——
 * 比一次典型对话的间隔短，比单步的间隔长。
 */
function scheduleQualityStatsFlush() {
  const now = Date.now()
  const elapsed = now - qualityStatsFlushAt
  if (qualityStatsFlushTimer) return
  if (elapsed >= QUALITY_STATS_FLUSH_MS) {
    // 距上次写入已经够久，直接进队列（不阻塞调用方）。
    qualityStatsFlushAt = now
    qualityStatsFlushTimer = Promise.resolve()
      .then(() => flushQualityStats())
      .catch(() => {})
      .finally(() => { qualityStatsFlushTimer = null })
    return
  }
  const wait = QUALITY_STATS_FLUSH_MS - elapsed
  const timer = setTimeout(() => {
    qualityStatsFlushAt = Date.now()
    qualityStatsFlushTimer = Promise.resolve()
      .then(() => flushQualityStats())
      .catch(() => {})
      .finally(() => { qualityStatsFlushTimer = null })
  }, wait)
  // Node 里 unref 让这个定时器不阻止进程退出 —— 否则一个 10 秒的防抖
  // 能把 DSH 的退出拖住。浏览器/宿主环境没有 unref，判一下再用。
  try { timer?.unref?.() } catch { /* 没有 unref 就算了 */ }
  qualityStatsFlushTimer = timer
}

// ==================== 每晚整理 ====================

const dayKey = (d = new Date()) => {
  const t = new Date(d)
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

/**
 * 执行一次缓冲区整理。
 *
 * 这一步**纯本地、不调用模型**：只做去重、与已采纳项比对、超限淘汰。
 * 语义归纳由 Agent 在对话中通过 remember 工具完成 —— 用户要的是
 * 「自动整理到缓冲区，然后我来裁决」，不是「模型悄悄替我决定什么值得记」。
 */
async function runTriage(ctx, { reason = 'nightly', notify = true } = {}) {
  const store = runtime.store
  if (!store) return { ok: false, error: '存储未就绪' }

  const config = await store.getConfig()
  if (!config.memory.enabled) return { ok: false, error: '记忆层已关闭' }

  const all = await store.listMemories()
  const { toDiscard, kept, summary } = triage(all, { maxPending: config.memory.maxPending })

  for (const item of toDiscard) {
    const record = all.find((r) => r.id === item.id)
    if (!record) continue
    await store.putMemory({
      ...record,
      status: record.status === 'pending' ? 'discarded' : record.status,
      note: item.note,
      decidedAt: new Date().toISOString()
    })
  }

  const metaTable = await store.table?.('meta')
  if (metaTable) {
    await metaTable.put('triage', {
      lastTriageDay: dayKey(),
      lastTriageAt: new Date().toISOString(),
      lastTriageSummary: summary
    })
  }

  await reload(ctx, { refreshPrompt: true })

  // notify=false 时不在这里发：由 runPatrol 把整理结果与体检结果合并成一条再发。
  // 两条通知同一晚各发一遍，等于把「说过的话」拆成两份噪音。
  if (notify && config.memory.notifyOnSessionStart) {
    await notifyAgents(ctx, summary, kept)
  }
  warn(ctx, `整理完成（${reason}）：待审 ${summary.pendingBefore} → ${summary.pendingAfter}，自动清理 ${toDiscard.length} 条`)
  return { ok: true, summary, kept }
}

/**
 * 巡夜：整理 + 体检 + 决定要不要说话。
 *
 * 用户定的规则（m05776）：「有需要汇报的就汇报没有就不汇报」。
 *
 * 这个函数是唯一同时知道三件事的地方：今晚整理动了什么、体检查出什么、
 * 上次汇报时的指纹是什么。分开写会让「要不要说」散落在三处，而三处各自判断
 * 就会各自说谎。
 *
 * **无论说不说，都写一条 meta.patrol。** 这是这条规则能成立的前提：
 * 只报有事，沉默就有两种意思（没事 / 没跑），必须留痕才能分开。
 *
 * @param {object} ctx 插件上下文
 * @param {{reason?: string}} [options] reason 只进日志与记录，不改变判据
 */
async function runPatrol(ctx, { reason = 'nightly' } = {}) {
  const store = runtime.store
  if (!store) return { ok: false, error: '存储未就绪' }

  const config = await store.getConfig()
  if (!config.memory.enabled) return { ok: false, error: '记忆层已关闭' }

  const triaged = await runTriage(ctx, { reason: `patrol:${reason}`, notify: false })
  if (!triaged.ok) return triaged

  const all = await store.listMemories()
  const groups = groupByStatus(all)
  const audit = auditMemories(all, { probe: (p) => existsSync(p) })

  const metaTable = await store.table?.('meta')
  const previous = metaTable ? metaTable.get('patrol') : null

  const verdict = assessPatrol({
    pendingIds: groups.pending.map((r) => r.id),
    flaggedIds: audit.flagged.map((r) => r.id),
    removed: triaged.summary.duplicatesRemoved + triaged.summary.overflowRemoved,
    previousSignature: previous?.signature ?? ''
  })

  const at = new Date().toISOString()
  // 体检明细压成可落盘的那一份。压缩在写入前做，不在读的时候做 ——
  // 这样落盘的内容本身就是「界面要显示的东西」，读回不必再猜。
  const compact = compactFlagged(audit.flagged)
  let delivered = 0

  if (verdict.shouldReport && config.memory.notifyOnSessionStart) {
    const text = patrolNoticeText({
      facts: verdict.facts,
      pendingTitles: groups.pending.map((r) => r.text),
      flaggedDetails: audit.flagged,
      triage: triaged.summary,
      checked: audit.checked
    })
    delivered = await injectToAgents(ctx, text, '巡夜汇报')
  }

  if (metaTable) {
    await metaTable.put('patrol', {
      at,
      day: dayKey(),
      reason,
      signature: verdict.signature,
      // 上次汇报时的指纹与这次一样 ⇒ 这次没说。用户查到这条就能分清
      // 「巡过了没事」和「巡夜没跑」—— 后者根本没有这一行。
      reported: delivered > 0,
      wouldReport: verdict.shouldReport,
      delivered,
      reasons: verdict.reasons,
      facts: verdict.facts,
      // 新增/减少分开记：判据只看「新增」，但「这一周清掉了 4 条」这种事实
      // 必须留在记录里，否则用户没法回答「我上周处理的那批东西哪儿去了」。
      added: verdict.added ?? null,
      cleared: verdict.cleared ?? null,
      checked: audit.checked,
      // 体检明细落盘（2026-10-25）：`facts.flagged` 只说「有几条」，说不出「哪几条」。
      // 汇报消息会点名，但消息进的是会话历史，翻不到就没了；界面上只有个数字，
      // 用户想问「是哪条」时无处可查。这里存一份压缩后的明细，供设置页直接展示。
      flaggedItems: compact.items.length > 0 ? compact.items : null,
      flaggedDropped: compact.dropped
    })
  }

  warn(ctx, `巡夜完成（${reason}）：待审 ${verdict.facts.pending}，体检 ${verdict.facts.flagged}，`
    + `整理动过 ${verdict.facts.removed} 条 → ${delivered > 0 ? `已汇报（${delivered} 个会话）` : '无事，未汇报'}`)
  return { ok: true, verdict, delivered, at, triage: triaged.summary, audit: { checked: audit.checked, flagged: audit.flagged.length } }
}

/**
 * 回扫式复盘：回读旧会话，捞出「用户当时说过、但没记下来」的话。
 *
 * 为什么是「回扫」而不是「实时闸门」：拿 925 条真实发言量过 mnemon 那套两级漏斗，
 * 第一段四条件只命中 4 条（0.4%），第二段打分公式却让 44.6% 的轮次都要送审 ——
 * 中间没有可用档位。而真正该记的东西信号极稀：937 轮里只有 2 次抱怨「我说过」。
 * 所以不值得为它每步跑一遍判据；定期回头扫一遍更划算。
 *
 * 决定性证据（这条功能存在的理由）：2026-11-04T10:13:24 用户抱怨「我有没有说过
 * 不允许一直往 c 盘写东西」，而那条规则 2026-11-05T04:59:24 才入库 —— 晚了一天。
 * 问题在「当时没写下来」，不在「写了没用上」。
 *
 * 与 runPatrol 同一条纪律：**无论说不说，都写一条 meta.retrospect。**
 *
 * @param {object} ctx 插件上下文
 * @param {{reason?: string}} [options] reason 只进日志与记录，不改变判据
 */
async function runRetrospect(ctx, { reason = 'manual' } = {}) {
  const store = runtime.store
  if (!store) return { ok: false, error: '存储未就绪' }

  const config = await store.getConfig()
  if (!config.memory.enabled) return { ok: false, error: '记忆层已关闭' }
  // 这个开关必须真的被读，否则它就只是个写着「关」却关不掉的配置项
  // （auto-memory 那个项目踩过：开关没有读取点，等于没有开关）。
  // 关着的时候**不写 meta** —— 「被用户关掉」和「跑了没成」是两种事实，
  // 混进同一条记录里，用户以后看到「上次回扫失败」会以为是坏了。
  if (!config.memory.retrospectEnabled) {
    return { ok: false, error: '回扫式复盘当前已关闭（设置 → 灵台 里可以打开）' }
  }

  const metaTable = await store.table?.('meta')
  const previous = metaTable ? metaTable.get(RETROSPECT_KEY) : null
  const days = config.memory.retrospectDays
  const sinceMs = Date.now() - days * 86400000
  const at = new Date().toISOString()

  // 记录「为什么这次没扫」也必须落盘 —— 否则「扫了没事」和「没扫」一样沉默。
  const recordFailure = async (error) => {
    if (metaTable) {
      await metaTable.put(RETROSPECT_KEY, {
        scannedAt: at,
        scannedDays: days,
        files: null,
        messages: null,
        found: null,
        leadKeys: previous?.leadKeys ?? [],
        leads: previous?.leads ?? null,
        leadsDropped: previous?.leadsDropped ?? null,
        delivered: 0,
        error
      })
    }
    warn(ctx, `复盘跳过（${reason}）：${error}`)
    return { ok: false, error }
  }

  // Node 版本太老时 zlib 没有 zstdDecompressSync。这时候干跑一遍只会得到
  // 「0 条线索」，而那看起来和「扫过没事」一模一样 —— 必须说清是没扫成。
  if (!hasZstdSupport()) {
    return recordFailure(`当前 Node（${process.version}）不支持 zstd 解压，无法读取会话日志`)
  }

  const root = sessionsRoot()
  const listing = listSessionFiles({ root, sinceMs })
  if (!listing.rootExists) return recordFailure(listing.error ?? `会话目录不存在：${root}`)

  let messages = 0
  let skippedSessions = 0
  let failedFrames = 0
  const leads = []
  for (const entry of listing.files) {
    let events
    try {
      const read = readSessionEvents(entry.file)
      events = read.events
      failedFrames += read.failedFrames ?? 0
    } catch {
      skippedSessions += 1
      continue
    }
    // subagent 会话里 source.kind 也是 'user'，但那些话是父 agent 写的任务书。
    if (isSubagentSession(events)) {
      skippedSessions += 1
      continue
    }
    const leadEvents = toLeadEvents(events)
    const sessionRef = entry.file.slice(root.length + 1).replace(/\\/g, '/').replace(/\/session\.v4\.jsonl\.zstd$/, '')
    const r = extractLeads({ events: leadEvents, sinceMs, maxLeads: 500, sessionRef })
    messages += r.scanned
    leads.push(...r.leads)
  }

  const verdict = assessRetrospect({ leads, previousKeys: previous?.leadKeys ?? [] })
  const compact = compactLeads(verdict.newLeads)

  // 已报过的键要累积着留，否则下一轮会把老线索当成新的再报一次。
  const mergedKeys = [...new Set([...(previous?.leadKeys ?? []), ...verdict.newLeads.map((l) => l.key)])].slice(-500)

  let delivered = 0
  if (verdict.shouldReport && config.memory.notifyOnSessionStart) {
    const text = retrospectNoticeText(verdict.newLeads)
    delivered = await injectToAgents(ctx, text, '复盘线索')
  }

  if (metaTable) {
    await metaTable.put(RETROSPECT_KEY, {
      scannedAt: at,
      scannedDays: days,
      files: listing.files.length - skippedSessions,
      messages,
      found: verdict.newLeads.length,
      leadKeys: mergedKeys,
      // 只保留最近这一批的明细：更早的已经报过，界面上再列一遍只是噪音。
      leads: compact.items.length > 0 ? compact.items : null,
      leadsDropped: compact.dropped,
      delivered,
      error: failedFrames > 0 ? `有 ${failedFrames} 帧解压失败，这部分内容不可见` : undefined
    })
  }

  warn(ctx, `复盘完成（${reason}）：扫 ${listing.files.length - skippedSessions} 个会话 / ${messages} 条发言，`
    + `新线索 ${verdict.newLeads.length} 条 → ${delivered > 0 ? `已提示（${delivered} 个会话）` : '无新线索，未提示'}`)
  return { ok: true, at, days, files: listing.files.length - skippedSessions, messages, verdict, delivered, failedFrames }
}

/**
 * 把一条系统级说明注入所有活动会话（一次性提示，不唤醒 Agent）。
 *
 * @param {string} text 注入正文
 * @param {string} label 失败日志里的用途标注
 * @returns {Promise<number>} 成功注入的会话数
 */
async function injectToAgents(ctx, text, label) {
  // 空文本不注入：调用方用空串表示「这次没有要说的」，那是**沉默**，
  // 不是一条空消息。真正的空消息会出现在对话历史里，模型读到会以为用户说了话。
  if (typeof text !== 'string' || text.trim() === '') return 0
  const agents = ctx.get?.('agents')
  if (!agents || typeof agents.list !== 'function') return 0
  let createUserMessage
  try {
    ({ createUserMessage } = await import('@deepseek-ai/dsh-llm'))
  } catch (err) {
    warn(ctx, `dsh-llm 不可用，跳过${label}：${String(err?.message || err)}`)
    return 0
  }
  let delivered = 0
  for (const agent of agents.list()) {
    try {
      agent.inject(createUserMessage({
        content: [{ type: 'text', text }],
        source: createInjectionSource(text)
      }))
      delivered += 1
    } catch (err) {
      warn(ctx, `向会话注入${label}失败：${String(err?.message || err)}`)
    }
  }
  return delivered
}

/** 把整理结果注入所有活动会话。 */
async function notifyAgents(ctx, summary, kept) {
  return injectToAgents(ctx, triageNoticeText(summary, kept.map((r) => r.text)), '整理通知')
}

/**
 * 变更来源的内部键 → 通知里的可读标注。
 *
 * 查不到就**原样使用传进来的字符串**：工作区覆盖那条会传「本工作区覆盖（<路径>）」，
 * 硬套一张固定表会把它悄悄改写成「设置页」，等于对模型说假话。
 */
const CONFIG_SOURCE_LABELS = {
  settings: '设置页',
  preset: '设置页（套用预设）',
  command: '命令',
  tool: '模型工具',
  proposal: '设置页（确认模型提议）'
}

/**
 * 告知活动会话「人设配置刚改过，旧设定作废」。
 *
 * 只发一次、且不带新值：新值已经在重注册后的系统提示里，这里要解决的是
 * 「对话历史里还留着旧规则」这件事（详见 lib/injection.mjs 的注释）。
 */
async function notifyConfigChange(ctx, changed, source) {
  const label = CONFIG_SOURCE_LABELS[source] ?? (typeof source === 'string' && source ? source : '设置页')
  return injectToAgents(ctx, configChangedNoticeText(changed, label), '配置变更通知')
}

/** 定时器：每天到点跑一次；DSH 没开机就下次启动补跑。 */
function scheduleNightly(ctx, state) {
  const clear = () => {
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
  }

  const arm = () => {
    clear()
    const hour = runtime.config.memory.nightlyHour
    const plan = planNightlyWake({ now: new Date(), hour })
    state.timer = setTimeout(async () => {
      try {
        const config = runtime.config.memory
        if (!config.enabled) return
        if (!plan.isTarget) {
          // 中途醒来只为重新定闹钟。这里**不能**跑巡夜：否则「几点跑巡夜」
          // 会由「开机补跑有没有成功」决定，而不是由 nightlyHour 决定
          // （m06351 实测到的就是这个）。
          return
        }
        // 再核一次小时。`isTarget` 是挂闹钟时算的，而 setTimeout 在机器休眠、
        // 系统改时间、长时间挂起之后可能拖到别的钟点才回调；这时候光信
        // isTarget 就会在上班时间跑一遍「夜间巡夜」。
        const nowHour = new Date().getHours()
        if (nowHour !== hour) {
          warn(ctx, `巡夜跳过：闹钟落在 ${nowHour} 点，不是设定的 ${hour} 点`)
          return
        }
        // 巡夜与回扫是**两个开关、两种动作**，各自判各自的日期，也各自判自己的开关。
        // 曾经把回扫写在 nightlyTriage 的分支里 —— 结果「关掉巡夜」会连带让回扫
        // 永远不跑，而用户在设置页明明单独打开了回扫。开关必须有它自己的读取点。
        if (config.nightlyTriage) {
          const last = await state.lastTriageDay()
          // 到点就跑巡夜，不再只跑整理：整理是巡夜的一部分，汇报与否由
          // runPatrol 依据「有没有新的事」机械判定（见 lib/patrol.mjs）。
          if (last !== dayKey()) await runPatrol(ctx, { reason: 'nightly' })
        }
        // 回扫排在巡夜之后：它的线索多半来自「今天用户的纠正」，晚一点扫才能
        // 把当天的话也吃进去。
        if (config.retrospectEnabled) {
          const retroMeta = (await runtime.store?.table?.('meta'))?.get(RETROSPECT_KEY)
          if (!retrospectScannedToday(retroMeta)) {
            await runRetrospect(ctx, { reason: 'nightly' })
          }
        }
      } catch (err) {
        warn(ctx, `每晚巡夜失败：${String(err?.message || err)}`)
      } finally {
        arm()
      }
    }, plan.delayMs)
    state.timer.unref?.()
  }

  arm()
  ctx.effect(() => clear, 'dsh-anima: nightly timer')
  return { arm, clear }
}

// ==================== HTTP 路由（供设置页调用） ====================

// 本插件的路由会读写人设配置与记忆正文，而宿主 webserver 默认可能绑在
// 0.0.0.0 且**自身不带任何鉴权**（dsh-host-webserver/README.md 原文：
// "the server carries no TLS, authentication, or origin policy of its own"）。
// 因此这里照生态通行做法（@michengai/dsh-skills-manager、@linxin666/dsh-remote-web-ui）
// 自加一道同源 + 回环守卫：非本机来源一律 403，浏览器跨站请求也拒掉。
function headerOf(req, name) {
  const value = req?.headers?.[name]
  return Array.isArray(value) ? value[0] : value
}

function isLoopbackAddress(value) {
  const address = String(value ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  return (
    address === 'localhost' ||
    address === 'localhost.' ||
    address === '::1' ||
    address.startsWith('127.') ||
    address.startsWith('::ffff:127.')
  )
}

/**
 * 判定请求是否可信。
 * @returns {true|string} true 表示放行；字符串是拒绝原因（供日志/响应体使用）。
 */
function trustRequest(req) {
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return '仅允许本机访问'
  const site = headerOf(req, 'sec-fetch-site')
  if (site !== undefined && site !== 'same-origin') return '拒绝跨站请求'
  const origin = headerOf(req, 'origin')
  // 同源导航型 GET 可能不带 Origin；带了就必须与本机 authoritative host 一致。
  if (origin === undefined) return true
  const host = headerOf(req, 'host')
  if (host === undefined) return '缺少 Host 头'
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Origin 协议不受支持'
    if (!isLoopbackAddress(url.hostname)) return 'Origin 不是本机'
    if (url.host !== host) return 'Origin 与 Host 不一致'
    return true
  } catch {
    return 'Origin 不是合法 URL'
  }
}

async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const err = new Error('请求体过大')
      err.statusCode = 413
      throw err
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const err = new Error('请求体不是合法 JSON')
    err.statusCode = 400
    throw err
  }
}

function workspaceList(ctx) {
  const registry = ctx.get?.('workspaceRegistry')
  if (!registry || typeof registry.list !== 'function') return []
  let items = []
  try {
    items = registry.list() ?? []
  } catch (err) {
    warn(ctx, `读取工作区列表失败：${String(err?.message || err)}`)
    return []
  }
  return items.map((w) => {
    const path = String(w?.path ?? w?.directory ?? w?.cwd ?? '')
    return {
      id: String(w?.id ?? path),
      path,
      title: String(w?.title ?? ''),
      ...(path ? { overridePath: overridePathFor(path) } : {})
    }
  }).filter((w) => w.path)
}

function overridePathFor(workspacePath) {
  return `${workspacePath.replace(/[\\/]+$/, '')}\\${runtime.config.workspaceFileDir}\\override.json`
}

async function workspaceState(ctx, workspacePath) {
  const { overrides, path, exists, errors } = await readOverrides(workspacePath, runtime.config.workspaceFileDir)
  const globalConfig = await runtime.store.getConfig()
  const { effective, sources } = mergePersona(globalConfig, overrides)
  return { workspacePath, path, exists, overrides, errors, effective, sources, description: describeSources(sources) }
}

function registerRoutes(ctx) {
  ctx.inject(['webServer'], (wsCtx) => {
    const send = (res, status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }

    // register() 返回 disposer，必须留住并在卸载时调用：宿主里 webServer 的
    // 路由表是全局的，丢掉 disposer 会让插件停用后旧闭包继续应答
    // （闭包内 runtime 已置空，表现为 500 而不是 404，容易误判成插件还在跑）。
    const disposers = []
    const route = (path, handler) => {
      disposers.push(wsCtx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          // 同源 + 回环守卫：宿主 webserver 自身不做鉴权，而本插件的路由
          // 读写人设与记忆正文，必须自己把住这道门。
          const trust = trustRequest(req)
          if (trust !== true) {
            send(res, 403, { ok: false, error: trust })
            return
          }
          try {
            await handler(req, res)
          } catch (err) {
            send(res, err?.statusCode ?? 500, { ok: false, error: String(err?.message || err) })
          }
        }
      }))
    }

    wsCtx.effect(() => () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // 单个路由摘除失败不应阻断其余路由的清理
        }
      }
    }, 'dsh-anima: web routes')

    // 状态快照。存储层不可用时这里**必须**返回结构化失败而不是 500 空壳：
    // 设置页要靠它区分「插件没跑」与「跑了但存储栈没组合」，前者该重装、后者该补三行。
    route('/api/anima/state', async (req, res) => {
      let config
      try {
        config = await runtime.store.getConfig()
      } catch (err) {
        send(res, err?.statusCode ?? 503, {
          ok: false,
          error: String(err?.message || err),
          code: err?.code ?? 'storage-unavailable',
          source: {
            kind: runtime.store.srcKind,
            path: runtime.store.srcPath,
            reason: runtime.store.srcReason,
            message: runtime.store.srcMessage,
            domainVersion: runtime.store.srcDomainVersion
          },
          loaded: runtime.loaded
        })
        return
      }
      const all = await runtime.store.listMemories()
      const groups = groupByStatus(all)
      const metaTable = await runtime.store.table?.('meta')
      const meta = metaTable?.get('triage')
      const patrolMeta = metaTable?.get('patrol')
      const retrospectMeta = metaTable?.get(RETROSPECT_KEY)
      // 「每条记忆为什么进 / 为什么不进」随 state 下发。设置页只能通过 HTTP 拿到
      // 状态，没有会话 context，因此 cwd 走查询参数 —— 不传时按「无工作区上下文」
      // 计算，此时工作区记忆一律显示为「当前会话没有工作区信息」，这本身也是
      // 有用的诊断：用户会立刻明白为什么项目记忆在预览里消失了。
      const stateUrl = new URL(req.url, 'http://localhost')
      const stateCwd = String(stateUrl.searchParams.get('cwd') ?? '').trim()
      const injection = selectForInjection(all, config.memory.maxInjected, {
        maxInjectedChars: config.memory.maxInjectedChars,
        cwd: stateCwd
      })
      const { clusters, conflicts } = clusterPending(groups.pending)
      // 审计日志尾部随 state 一起下发：设置页要能直接画出「最近谁改了人设」，
      // 不必再发一次请求（客户端首次 RPC 通道未就绪时可能长时间挂起，
      // 少一次往返就少一个失败面）。完整列表与清空走 /api/anima/audit。
      const auditAll = await runtime.store.listAudit()
      // 「当前生效的是哪条预设」随 state 一起下发：设置页那颗下拉框要在打开时就选中它，
      // 而不是等用户点一次「套用」才显示。预设是一次性的，配置里不留痕迹，
      // 所以每轮都由 findActivePreset 按字段比对算出来。
      const presets = listPresets(config.presets)
      const activePreset = findActivePreset(config, presets)
      send(res, 200, {
        ok: true,
        config,
        loaded: runtime.loaded,
        presets,
        activeId: activePreset?.id ?? null,
        builtinPresetCount: BUILTIN_PRESETS.length,
        source: {
          kind: runtime.store.srcKind,
          path: runtime.store.srcPath,
          reason: runtime.store.srcReason,
          message: runtime.store.srcMessage,
          // 域打开时的版本戳。它同时是一个「插件真的把域打开了」的信号：
          // null 表示域没打开，正整数表示打开了哪种格式的介质。
          domainVersion: runtime.store.srcDomainVersion
        },
        limits: { ...FIELD_LIMITS, overridable: OVERRIDABLE_FIELDS, presetFields: PRESET_FIELDS, toolFields: TOOL_FIELDS },
        // 档位文案表下发给设置页的「一键填入」按钮。
        //
        // 为什么由 host 下发而不是客户端自己抄一份：这份文案**同时**是迁移期翻译旧配置的
        // 依据（lib/config.mjs 的 migrateConfig）。两边各存一份的话，改了一处漏了另一处，
        // 结果是「点按钮填进去的」与「旧配置升级后得到的」不是同一句话 —— 用户会以为
        // 插件在偷偷改他的风格。表在 lib/wording.mjs，这里是它的唯一出口。
        //
        // 过滤掉空串档位（三项特质的 default）：空串在自由文本模型里等于「不提这件事」，
        // 做成按钮会让人以为点一下能得到什么，其实只是把输入框清空。
        wording: Object.fromEntries(
          Object.entries(WORDING_TABLES).map(([key, table]) => [
            key,
            Object.entries(table).filter(([, value]) => value !== '').map(([id, value]) => ({ id, text: value }))
          ])
        ),
        // 身份与背景字段的示例（用户 m08898：「每个文本都要有例子或者是一些预设」）。
        //
        // 与上面的 wording 分开下发，因为两者在界面上的行为不同：wording 是「点一下
        // 就定稿的档位」，示例是「点一下填进去、还要改成你自己的」。合成一张表会让
        // 前端分不清该不该提示「记得改成你自己的情况」。
        //
        // 结构是 `{ 字段名: [文本, …] }`；空数组（agentName）表示这个字段不给示例，
        // 前端据此不画按钮组，而不是画一个空组。
        examples: Object.fromEntries(
          Object.entries(FIELD_EXAMPLES).map(([key, list]) => [key, list.slice()])
        ),
        // 待确认提议随 state 一起下发：设置页要能画出「模型提了个改动，等你点头」那一条，
        // 用户不必去敲命令才发现有东西挂着。
        pendingProposal: runtime.pendingProposal,
        memories: {
          pending: groups.pending,
          adopted: groups.adopted,
          discarded: groups.discarded.slice(-50)
        },
        // 注入可解释性 + 预算用量 + 本地聚类，三样都是纯计算结果，不落盘。
        injection: {
          cwd: stateCwd,
          decisions: injection.decisions,
          budget: injection.budget
        },
        clusters,
        conflicts,
        audit: {
          total: auditAll.length,
          max: AUDIT_MAX_RECORDS,
          entries: auditAll.slice(-20),
          sourceText: AUDIT_SOURCE_TEXT,
          actors: AUDIT_ACTORS
        },
        triageMeta: meta ?? null,
        // 巡夜记录：**这是「没汇报」可反查的唯一出口**。
        //
        // 只报有事之后，沉默有两种意思 —— 「巡过了，没事」和「巡夜没跑」。前者会
        // 写这一行，后者根本没有这一行，于是用户随时能分清。reported=false 且
        // facts 全 0 就是「真的没事」，不是「它死了」。
        patrolMeta: patrolMeta ?? null,
        // 回扫记录：与 patrolMeta 同理。「没线索」和「没扫」必须能分开 ——
        // 前者写着 scannedAt，后者根本没有这一行。
        retrospectMeta: retrospectMeta ?? null,
        // 质检钩子的运行计数。
        //
        // 口径是**累计**（跨重启），不是「本次运行」。曾经的注释写的是「仅内存，
        // 重启清零」，那让这个数字在重启后既可能是「真的没查过」也可能是
        // 「查了几百次但刚重启」—— 两种相反的事实长得一样，正是这个计数器
        // 存在的意义所在，清零等于把它废掉。现在落盘到 meta.qualityStats，
        // 读回时累加；`startedAt` 单独标出本次启动时刻，两种口径都看得到。
        //
        // 为什么把它放进 /state 而不是只在日志里：这个计数器的唯一用途就是让用户
        // 区分「查了、没事」和「根本没查」。放在需要翻日志才看得到的地方，等于
        // 在需要它的时候用不上它。设置页/诊断口一拉就能看到 checks=0 → 钩子是死的。
        qualityStats: {
          ...runtime.qualityStats,
          skipped: { ...runtime.qualityStats.skipped },
          note: 'checks 是真正跑过判定的次数；skipped 里的原因说明为什么没跑。checks=0 就说明这一整套没在工作，别把「没有提醒」当成「没有问题」。'
        },
        // 一键导入（Phase ②）：那段「复制给别的 AI」的提示词随 state 下发。
        //
        // 放 state 而不是单独开一条路由，理由是它**永远不变**（是常量，不随配置走）：
        // 单独一条路由等于让设置页多一次往返、多一个失败面，而它本来就是打开页面就要用的。
        // 上限两个数字也一并下发，前端据此做字数提示与「分批」提示，不必各抄一份常量。
        memoryImport: {
          prompt: IMPORT_PROMPT_FULL,
          maxItems: IMPORT_MAX_ITEMS,
          maxSource: IMPORT_MAX_SOURCE
        },
        workspaces: workspaceList(ctx)
      })
    })

    // 预览：按当前全局配置 + 指定工作区覆盖，渲染最终送进模型的人设文本。
    // 设置页用它做「实时预览」——用户改一个字段就能看到提示词变成什么样。
    //
    // 两种调用形态：
    //   ① 只给 workspacePath ⇒ 按**已保存**的全局配置渲染；
    //   ② 同时带上人设字段（agentName=…&style=…）⇒ 用这些值临时覆盖全局配置再渲染，
    //      于是用户**不必先保存**就能看到预览。字段值走 sanitizeOverrides 白名单，
    //      非法值直接忽略（预览是只读展示，不该因为打到一半的字而报错）。
    route('/api/anima/preview', async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const workspacePath = String(url.searchParams.get('workspacePath') ?? '').trim()
      const globalConfig = await runtime.store.getConfig()

      const draft = {}
      for (const key of OVERRIDABLE_FIELDS) {
        const value = url.searchParams.get(key)
        if (typeof value === 'string' && value !== '') draft[key] = value
      }
      const { overrides: draftClean, errors: draftErrors } = sanitizeOverrides(draft)
      const draftConfig = Object.keys(draftClean).length > 0
        ? { ...globalConfig, ...draftClean }
        : globalConfig
      // 被拒字段清单。预览刻意**不**因为半截输入而报错（用户还在打字，报错会打断输入），
      // 但静默忽略更糟：用户会以为「预览里就是这样」而实际上预览用的是上一次的合法值。
      // 把「你这次传的这几个字段没被采纳」明说出来，界面上就有地方可以标黄。
      const invalid = Object.entries(draftErrors).map(([key, reason]) => ({ key, reason }))

      let overrides = null
      if (workspacePath && globalConfig.workspaceOverridesEnabled) {
        const local = await readOverrides(workspacePath, globalConfig.workspaceFileDir)
        overrides = local?.overrides ?? null
      }
      const { effective, sources } = mergePersona(draftConfig, overrides)
      // 预览里的记忆段必须与真实注入用**同一套**筛选参数（含该工作区的 cwd），
      // 否则用户会看到「预览里有这条、实际对话里没有」——那比没有预览更糟。
      const injection = selectForInjection(runtime.adopted, globalConfig.memory.maxInjected, {
        maxInjectedChars: globalConfig.memory.maxInjectedChars,
        cwd: workspacePath
      })
      send(res, 200, {
        ok: true,
        effective,
        draft: Object.keys(draftClean).length > 0,
        sources,
        description: describeSources(sources),
        sections: {
          identity: compileIdentity(effective),
          userProfile: compileUserProfile(effective),
          style: compileStyle(effective),
          instructions: compileInstructions(effective),
          rules: compileRules(),
          memory: compileMemory(injection.selected, summarizeOmission(injection)),
          pending: compilePendingNotice(runtime.pendingCount),
          // remember 指引段同样必须在预览里出现，理由与下面质检段完全一致：
          // 预览是「模型这一轮到底看到什么」的唯一对外答案。漏一段就等于
          // 对外保证了一份与实际注入不符的文本。
          remember: globalConfig.memory.enabled && globalConfig.memory.autoCapture
            ? compileRememberGuide()
            : '',
          // 质检段也必须在预览里出现。
          //
          // 漏掉它的后果不是「少显示一段」——预览是唯一一个「模型这一轮到底看到什么」
          // 的对外答案，少了这一段就等于对外保证了一份与实际注入不符的文本。
          // 同一个疏漏此前在 getSystemPrompt 上犯过一次，这里不再犯第二次。
          quality: compileQualitySection(globalConfig.quality)
        },
        // 预览的是「配置生效时」的文本。插件被关掉时实际注入的是关闭声明，
        // 那属于状态而不是人设，用 enabled 单独表达，不塞进 sections 里冒充一段设定。
        enabled: runtime.config.enabled,
        persona: runtime.config.enabled ? compilePersona(effective) : compileDisabledNotice(),
        // 本次请求里被校验挡下的草稿字段。空数组 = 全部采纳。
        invalid,
        injection: { decisions: injection.decisions, budget: injection.budget }
      })
    })

    // ---- 人设预设 ----
    route('/api/anima/presets', async (req, res) => {
      const config = await runtime.store.getConfig()
      const presets = listPresets(config.presets)
      // active 是**算出来的**，不是存下来的：预设套用后就散成字段值了，配置里没有
      // 「我来自哪条预设」这种痕迹。按字段逐条比对才能反映「用户现在这套到底还是不是它」。
      const active = findActivePreset(config, presets)
      send(res, 200, { ok: true, presets, activeId: active?.id ?? null })
    })

    route('/api/anima/presets/apply', async (req, res) => {
      const parsed = await readJsonBody(req)
      const config = await runtime.store.getConfig()
      const preset = resolvePreset(config.presets, parsed?.id ?? parsed?.name)
      if (!preset) {
        send(res, 404, { ok: false, error: `找不到预设 ${String(parsed?.id ?? parsed?.name ?? '')}` })
        return
      }
      // 只覆盖预设声明的字段，其余保持用户当前值 —— 与工作区覆盖同一套语义。
      const patch = applyPreset(preset)
      const { patch: clean, errors } = sanitizeConfig(patch)
      if (Object.keys(errors).length > 0) {
        send(res, 400, { ok: false, error: `预设字段校验失败：${formatFieldErrors(errors)}`, errors })
        return
      }
      const { config: next, changed } = await runtime.store.updateConfig(clean, { actor: 'user', source: 'preset', note: `应用预设 ${preset.name}` })
      await reload(ctx, { refreshPrompt: changed.length > 0, configChange: { changed, source: 'preset' } })
      send(res, 200, { ok: true, preset: preset.name, changed, config: next })
    })

    route('/api/anima/presets/save', async (req, res) => {
      const parsed = await readJsonBody(req)
      const config = await runtime.store.getConfig()
      const { preset, errors } = sanitizeCustomPreset(parsed?.preset ?? parsed)
      if (!preset) {
        send(res, 400, { ok: false, error: `预设校验失败：${formatFieldErrors(errors)}`, errors })
        return
      }
      const existing = config.presets ?? []
      if (!existing.some((p) => p.id === preset.id) && existing.length >= PRESET_COUNT_LIMIT) {
        send(res, 400, { ok: false, error: `自建预设最多 ${PRESET_COUNT_LIMIT} 条` })
        return
      }
      const next = existing.some((p) => p.id === preset.id)
        ? existing.map((p) => (p.id === preset.id ? preset : p))
        : [...existing, preset]
      const { patch, errors: patchErrors } = sanitizeConfig({ presets: next })
      if (Object.keys(patchErrors).length > 0) {
        send(res, 400, { ok: false, error: formatFieldErrors(patchErrors), errors: patchErrors })
        return
      }
      const { config: saved } = await runtime.store.updateConfig(patch, { actor: 'user', source: 'preset', note: `保存预设 ${preset.name}` })
      send(res, 200, { ok: true, preset, presets: listPresets(saved.presets) })
    })

    route('/api/anima/presets/delete', async (req, res) => {
      const parsed = await readJsonBody(req)
      const id = String(parsed?.id ?? '')
      if (!id) {
        send(res, 400, { ok: false, error: '缺少 id' })
        return
      }
      if (id.startsWith('builtin:')) {
        send(res, 400, { ok: false, error: '内置预设不可删除' })
        return
      }
      const config = await runtime.store.getConfig()
      const existing = config.presets ?? []
      const next = existing.filter((p) => p.id !== id)
      if (next.length === existing.length) {
        send(res, 404, { ok: false, error: `找不到自建预设 ${id}` })
        return
      }
      const { config: saved } = await runtime.store.updateConfig({ presets: next }, { actor: 'user', source: 'preset', note: `删除预设 ${id}` })
      send(res, 200, { ok: true, presets: listPresets(saved.presets) })
    })

    route('/api/anima/config', async (req, res) => {
      if (req.method === 'GET') {
        send(res, 200, { ok: true, config: await runtime.store.getConfig() })
        return
      }
      const parsed = await readJsonBody(req)
      const { patch, errors } = sanitizeConfig(parsed)
      if (Object.keys(errors).length > 0) {
        send(res, 400, { ok: false, error: `配置校验失败：${formatFieldErrors(errors)}`, errors })
        return
      }
      const { config, changed } = await runtime.store.updateConfig(patch, { actor: 'user', source: 'settings' })
      await reload(ctx, { refreshPrompt: changed.length > 0, configChange: { changed, source: 'settings' } })
      send(res, 200, { ok: true, config, changed })
    })

    // 破坏性动作：必须显式带确认字段。
    //
    // 2026-10-10 的事故：我为确认路由是否注册，对写路由逐一 POST 空体 `{}`，
    // 这条当场 200 并把人设重置成默认值 —— 三个字段被清空。设置页的按钮是
    // 人类点的，但「空 body 就等于确认」这个默认值本身就是缺陷。
    // 与某同生态插件的失败关闭（fail closed）语义一致：
    // 拿不到明确确认就什么都不做，并说明怎么做才有效。
    route('/api/anima/config/reset', async (req, res) => {
      const parsed = await readJsonBody(req)
      if (parsed?.confirm !== true) {
        send(res, 400, {
          ok: false,
          code: 'confirmation-required',
          error: '重置会清空已保存的人设字段。请在请求体里带 {"confirm": true} 再试。'
        })
        return
      }
      const { config, changed } = await runtime.store.resetConfig({ actor: 'user' })
      await reload(ctx, { refreshPrompt: true, configChange: { changed, source: 'settings' } })
      send(res, 200, { ok: true, config, changed })
    })

    // 待确认提议的裁决（设置页的确认条与 /anima confirm|reject 走同一条逻辑）。
    // 提议是「模型提了个改动、等用户点头」的暂存区：确认即写盘，拒绝即丢弃。
    route('/api/anima/proposal', async (req, res) => {
      const parsed = await readJsonBody(req)
      const action = String(parsed?.action ?? '').trim()
      const proposal = runtime.pendingProposal
      if (!proposal) {
        send(res, 404, { ok: false, error: '当前没有待确认的人设变更提议。' })
        return
      }
      if (action !== 'confirm' && action !== 'reject') {
        send(res, 400, { ok: false, error: 'action 必须是 confirm 或 reject' })
        return
      }
      runtime.pendingProposal = null
      if (action === 'reject') {
        send(res, 200, { ok: true, rejected: true, config: runtime.config, changed: [] })
        return
      }
      const { patch, errors } = sanitizeConfig(proposal.patch)
      if (Object.keys(errors).length > 0) {
        send(res, 400, { ok: false, error: `提议已失效：${formatFieldErrors(errors)}` })
        return
      }
      const { config, changed } = await runtime.store.updateConfig(patch, { actor: 'user', source: 'proposal', note: '用户在设置页确认了模型提议' })
      await reload(ctx, { refreshPrompt: changed.length > 0, configChange: { changed, source: 'settings' } })
      send(res, 200, { ok: true, rejected: false, config, changed })
    })

    // ---- 人设变更审计日志 ----
    //
    // 存在的理由：本插件有三个入口能改人设（设置页 / 命令 / 模型工具），
    // 而「工具确认」默认关闭 —— 也就是说模型可以直接改写「你是谁、我叫你什么、
    // 用什么语气」。用户第二天发现语气变了，无从知道是谁、何时、把哪个字段改成了什么。
    // 这条路由就是把那份记录原样交出去，不做任何判断。
    route('/api/anima/audit', async (req, res) => {
      if (req.method === 'DELETE') {
        const removed = await runtime.store.clearAudit()
        send(res, 200, { ok: true, removed })
        return
      }
      const entries = await runtime.store.listAudit()
      const limit = Number(new URL(req.url, 'http://localhost').searchParams.get('limit') ?? 0)
      const list = Number.isFinite(limit) && limit > 0 ? entries.slice(-limit) : entries
      send(res, 200, {
        ok: true,
        entries: list,
        total: entries.length,
        max: AUDIT_MAX_RECORDS,
        actors: AUDIT_ACTORS,
        sourceText: AUDIT_SOURCE_TEXT
      })
    })

    route('/api/anima/workspace', async (req, res) => {
      const parsed = req.method === 'GET'
        ? { workspacePath: new URL(req.url, 'http://localhost').searchParams.get('workspacePath') }
        : await readJsonBody(req)
      const workspacePath = String(parsed?.workspacePath ?? '').trim()
      if (!workspacePath) {
        send(res, 400, { ok: false, error: '缺少 workspacePath' })
        return
      }
      if (req.method === 'GET') {
        send(res, 200, { ok: true, ...(await workspaceState(ctx, workspacePath)) })
        return
      }
      const { overrides, errors } = sanitizeOverrides(parsed?.overrides ?? {})
      if (Object.keys(errors).length > 0) {
        send(res, 400, { ok: false, error: `覆盖校验失败：${formatFieldErrors(errors)}`, errors })
        return
      }
      const before = await readOverrides(workspacePath, runtime.config.workspaceFileDir)
      if (Object.keys(overrides).length === 0) {
        await removeOverrides(workspacePath, runtime.config.workspaceFileDir)
      } else {
        await writeOverrides(workspacePath, runtime.config.workspaceFileDir, overrides)
        await ensureIgnored(workspacePath, runtime.config.workspaceFileDir)
      }
      // 覆盖文件是配置的另一个写入面：改完也要向活动会话声明旧设定作废，
      // 否则用户在本工作区换了一套说法，模型还在按全局那套回答。
      const { changed } = diffOverrides(before.overrides, overrides)
      await reload(ctx, {
        refreshPrompt: true,
        configChange: changed.length > 0
          ? { changed, source: `本工作区覆盖（${workspacePath}）` }
          : null
      })
      send(res, 200, { ok: true, ...(await workspaceState(ctx, workspacePath)) })
    })

    route('/api/anima/memory/decide', async (req, res) => {
      const parsed = await readJsonBody(req)
      const id = String(parsed?.id ?? '')
      const decision = String(parsed?.decision ?? '')
      if (!id) {
        send(res, 400, { ok: false, error: '缺少 id' })
        return
      }
      if (decision !== 'adopt' && decision !== 'discard') {
        send(res, 400, { ok: false, error: 'decision 只能是 adopt 或 discard' })
        return
      }
      const record = await runtime.store.getMemory(id)
      if (!record) {
        send(res, 404, { ok: false, error: `找不到记忆 ${id}` })
        return
      }
      await runtime.store.putMemory({
        ...record,
        status: decision === 'adopt' ? 'adopted' : 'discarded',
        decidedAt: new Date().toISOString()
      })
      await reload(ctx, { refreshPrompt: true })
      send(res, 200, { ok: true, id, status: decision === 'adopt' ? 'adopted' : 'discarded' })
    })

    route('/api/anima/memory/delete', async (req, res) => {
      const parsed = await readJsonBody(req)
      const id = String(parsed?.id ?? '')
      if (!id) {
        send(res, 400, { ok: false, error: '缺少 id' })
        return
      }
      const removed = await runtime.store.deleteMemory(id)
      await reload(ctx, { refreshPrompt: true })
      send(res, 200, { ok: true, removed })
    })

    // 改写一条已有记忆的元数据（类型 / 生命周期 / 复核点 / 来源引用）。
    //
    // 为什么单独开一条路由而不是塞进 memory/decide：decide 的语义是「用户裁决这条
    // 要不要留下」，它只能改 status；而分类是在「已经留下的」条目上做的二次整理。
    // 两者混在一个接口里，将来任何一次误传 decision 值都会同时改动裁决状态。
    route('/api/anima/memory/meta', async (req, res) => {
      const parsed = await readJsonBody(req)
      const id = String(parsed?.id ?? '')
      if (!id) {
        send(res, 400, { ok: false, error: '缺少 id' })
        return
      }
      const record = await runtime.store.getMemory(id)
      if (!record) {
        send(res, 404, { ok: false, error: `找不到记忆 ${id}` })
        return
      }
      // 取代指针必须指向一条真的存在的记忆。活着的时候不查，将来读的人
      // 会以为有一条点得开的「后来那条」，实际上什么也没有。
      if (typeof parsed?.supersededBy === 'string' && parsed.supersededBy.trim() !== '') {
        const other = await runtime.store.getMemory(parsed.supersededBy.trim())
        if (!other) {
          send(res, 400, { ok: false, error: `supersededBy 指向的记忆不存在：${parsed.supersededBy.trim()}` })
          return
        }
      }
      const applied = applyMemoryMeta(record, {
        type: parsed?.type,
        state: parsed?.state,
        verifyAt: parsed?.verifyAt,
        sourceRef: parsed?.sourceRef,
        supersededBy: parsed?.supersededBy
      })
      if (!applied.ok) {
        send(res, 400, { ok: false, error: applied.error })
        return
      }
      // 一条都没变就别写盘，更别回「已更新」——那是谎报。
      if (applied.changed.length === 0) {
        send(res, 200, { ok: true, id, changed: [], record })
        return
      }
      await runtime.store.putMemory(applied.record)
      await reload(ctx, { refreshPrompt: true })
      send(res, 200, { ok: true, id, changed: applied.changed, record: applied.record })
    })

    // 批量回填：一次提交多条 [{id, type, ...}]，逐条应用并汇总。
    //
    // 为什么必须有批量口：21 条旧记忆要补类型，逐条发 21 次请求意味着 21 次写盘
    // 与 21 次提示词重注册；中途失败还会留下「一半有条目有一半没有」的状态，
    // 而用户看到的只是一个失败提示，不知道已经改到哪儿了。
    route('/api/anima/memory/meta/batch', async (req, res) => {
      const parsed = await readJsonBody(req)
      const items = Array.isArray(parsed?.items) ? parsed.items : []
      if (items.length === 0) {
        send(res, 400, { ok: false, error: 'items 不能为空' })
        return
      }
      if (items.length > 500) {
        send(res, 400, { ok: false, error: '一次最多 500 条' })
        return
      }
      const results = []
      let written = 0
      for (const item of items) {
        const id = String(item?.id ?? '')
        if (!id) {
          results.push({ id, ok: false, error: '缺少 id' })
          continue
        }
        const record = await runtime.store.getMemory(id)
        if (!record) {
          results.push({ id, ok: false, error: `找不到记忆 ${id}` })
          continue
        }
        if (typeof item?.supersededBy === 'string' && item.supersededBy.trim() !== '') {
          const other = await runtime.store.getMemory(item.supersededBy.trim())
          if (!other) {
            results.push({ id, ok: false, error: `supersededBy 指向的记忆不存在：${item.supersededBy.trim()}` })
            continue
          }
        }
        const applied = applyMemoryMeta(record, {
          type: item?.type,
          state: item?.state,
          verifyAt: item?.verifyAt,
          sourceRef: item?.sourceRef,
          supersededBy: item?.supersededBy
        })
        if (!applied.ok) {
          results.push({ id, ok: false, error: applied.error })
          continue
        }
        if (applied.changed.length > 0) {
          await runtime.store.putMemory(applied.record)
          written += 1
        }
        results.push({ id, ok: true, changed: applied.changed })
      }
      if (written > 0) await reload(ctx, { refreshPrompt: true })
      // 逐条回执而不是只说「成功 N 条」：失败的那些必须带回原因，否则用户
      // 无法判断是「这条不需要改」还是「这条改不了」。
      send(res, 200, { ok: true, written, total: items.length, results })
    })

    route('/api/anima/memory/triage', async (req, res) => {
      const result = await runTriage(ctx, { reason: 'manual' })
      send(res, result.ok ? 200 : 400, result)
    })

    // 手动跑一次巡夜。与定时调度走同一条判据（见 lib/patrol.mjs），
    // 否则「手点一次」和「它自己跑一次」会给出不同答案，那这个机制就没法验。
    route('/api/anima/patrol', async (req, res) => {
      const result = await runPatrol(ctx, { reason: 'manual' })
      send(res, result.ok ? 200 : 400, result)
    })

    // 回扫式复盘：与巡夜走同一条判据纪律（无论说不说都留痕），但触发时机不同 ——
    // 它可以手动跑，也可以在启动补跑时顺带跑一次。
    route('/api/anima/retrospect', async (req, res) => {
      const result = await runRetrospect(ctx, { reason: 'manual' })
      send(res, result.ok ? 200 : 400, result)
    })

    // 记忆体检：只做机械能验的事（路径还在不在、复核点过没过），不改任何状态。
    //
    // 为什么不自动改：判断「这两条讲的是不是同一件事、新的有没有推翻旧的」是语义
    // 判断，而记忆库一旦自动做语义判断，就会生成用户没说过的话。所以这里产出的
    // 是**带证据的候选**，每条都附一条可以直接复制的 /anima mark 命令 ——
    // 扫描可以自动，裁决必须由用户点。
    route('/api/anima/memory/audit', async (req, res) => {
      const records = await runtime.store.listMemories()
      const result = auditMemories(records, { probe: (p) => existsSync(p) })
      send(res, 200, { ok: true, ...result })
    })

    route('/api/anima/memory/add', async (req, res) => {
      const parsed = await readJsonBody(req)
      const created = makeCandidate({
        text: parsed?.text,
        note: parsed?.note,
        source: 'manual',
        scope: typeof parsed?.scope === 'string' ? parsed.scope : undefined,
        // 这三样以前没透传，于是「手动加一条」永远只能得到默认的 fact 分类：
        // stance 与 event 在真实存储里因此恒为 0，「我改主意了→曾如此」那条
        // 链路一次都没跑过（m06419 之后实测发现）。
        type: typeof parsed?.type === 'string' ? parsed.type : undefined,
        sourceRef: typeof parsed?.sourceRef === 'string' ? parsed.sourceRef : undefined,
        verifyAt: typeof parsed?.verifyAt === 'string' ? parsed.verifyAt : undefined
      })
      if (!created.ok) {
        send(res, 400, { ok: false, error: created.error })
        return
      }
      await runtime.store.putMemory(created.record)
      await reload(ctx, { refreshPrompt: true })
      send(res, 200, { ok: true, record: created.record })
    })

    // ---- 一键导入外部 AI 记忆（Phase ②，用户 m13808）----
    //
    // 做成「先解析、再提交」两步，而不是一个接口吃掉粘贴文本：
    //   ① 解析结果里有一批**不能入库**的东西（命中凭据闸门的、超长的、与已有记忆重复的），
    //      用户必须在写盘之前看见它们 —— 事后才发现凭据被拒，他会怀疑是不是真的没落盘；
    //   ② 自动归类是**建议**，用户要能逐条改；改完再提交，才谈得上「这些是我认可的」。
    // 两步都走同一条凭据闸门（lib/import.mjs 里的 parseImport），不存在「预览过了就能绕过」。
    route('/api/anima/memory/import/parse', async (req, res) => {
      const parsed = await readJsonBody(req)
      const text = String(parsed?.text ?? '')
      // cwd 与 /state 同一口径：走查询参数。设置页没有会话 context，
      // 归类建议里的「本工作区」需要这个坐标才能落到对的路径上。
      const importCwd = String(new URL(req.url, 'http://localhost').searchParams.get('cwd') ?? '').trim()
      // 已有记忆与待审候选一起参与查重：粘贴回来的往往就是本插件导出过的内容。
      const existing = await runtime.store.listMemories()
      const result = parseImport(text, existing, { cwd: importCwd })
      if (!result.ok) {
        send(res, 400, { ok: false, error: result.error })
        return
      }
      // 「这一批里有一条跟我缓冲区里某条几乎一样」——只在预览里提示，不自动合并、
      // 不自动丢弃。用户看一眼就知道该留哪条，而自动合并会生成一段他没说过的话，
      // 那违背「写进来容易、生效要人点头」这条立场（与 clusterPending 同一口径）。
      const overlaps = findImportOverlaps(
        result.items.map((item) => ({ text: item.text })),
        existing.filter((record) => record?.status === 'pending')
      )
      // 预览只回可入库的那批（附归类建议），其余按类别计数回给前端做说明。
      send(res, 200, {
        ok: true,
        items: result.items.map((item, index) => ({
          index,
          text: item.text,
          layer: item.suggested.layer,
          reason: item.suggested.reason,
          confidence: item.suggested.confidence,
          // 同义提示挂在条目上而不是单独一组：用户是在逐条扫的，
          // 提示要出现在他正看着的那一条旁边，翻到别处对照就不是提示了。
          overlap: overlaps.find((entry) => entry.itemIndex === index) ?? null
        })),
        counts: result.counts,
        // 拦下来的内容回**原文**而不是计数：用户得能看见「哪一条被拒了、为什么」。
        // 凭据那类只回命中类型，不回凭据本身（回显一次就多一份副本）。
        blocked: result.blocked.map((entry) => ({
          text: entry.text,
          credentials: entry.credentials
        })),
        tooLong: result.tooLong,
        duplicates: result.duplicates,
        overflow: result.overflow
      })
    })

    route('/api/anima/memory/import/commit', async (req, res) => {
      const parsed = await readJsonBody(req)
      const items = Array.isArray(parsed?.items) ? parsed.items : null
      if (!items || items.length === 0) {
        send(res, 400, { ok: false, error: '没有要导入的条目' })
        return
      }
      if (items.length > IMPORT_MAX_ITEMS) {
        send(res, 400, { ok: false, error: `一次最多导入 ${IMPORT_MAX_ITEMS} 条（收到 ${items.length}）` })
        return
      }

      const added = []
      const rejected = []
      for (const item of items) {
        // 重新走一遍 makeCandidate：提交阶段的输入来自网络请求，不能假定它还是
        // 解析阶段那批东西（用户可以在预览里改 layer，也可以在控制台里直接发请求）。
        const created = makeCandidate({
          text: item?.text,
          layer: item?.layer,
          source: 'import',
          note: item?.note
        })
        if (!created.ok) {
          rejected.push({ text: String(item?.text ?? ''), error: created.error })
          continue
        }
        await runtime.store.putMemory(created.record)
        added.push(created.record)
      }

      if (added.length > 0) {
        // 导入进来的是 pending 候选，不进提示词 ⇒ 不刷新提示词；
        // 但「待审数量」变了，会话开始时的提醒条要对得上。
        await reload(ctx, { refreshPrompt: false })
      }
      // `added` 回**完整记录数组**，不是计数：它与 `rejected` 对称，调用方既能
      // 报「导入了 N 条」，也能自己挑 id 做后续动作。曾经这里回的是
      // `added.length`（数字），而设置页按数组读 `.length` ⇒ 成功提示恒显示
      // 0 条 —— 冒烟夹具当时手写成数组，正好把这个不一致掩盖过去。
      send(res, 200, { ok: true, added, rejected })
    })
  })
}

// ==================== 命令 ====================

/**
 * `/anima set` 能写的键。
 *
 * 顶层是人设与界面字段，`memory.*` 是记忆段的子键 —— 两者都是标量，能用 `key=value`
 * 表达。刻意**不含** `presets`：预设是一组结构化数据（每条含 name / fields /
 * description），等号拼不出来；硬做只会做出一个能写坏配置的入口，而设置页那条路
 * 已经够用。
 */
const SET_TOP_KEYS = new Set([
  'enabled', 'agentName', 'agentRole', 'addressUserAs', 'userOccupation', 'userBio',
  'style', 'headingLists', 'emoji', 'tables', 'replyLength', 'language',
  'customInstructions', 'requireToolConfirmation', 'trailEnabled', 'trailColor',
  'trailSpeed', 'trailWidth', 'workspaceOverridesEnabled', 'workspaceFileDir'
])

const SET_MEMORY_KEYS = new Set([
  'enabled', 'autoCapture', 'nightlyTriage', 'nightlyHour', 'maxPending',
  'maxInjected', 'maxInjectedChars', 'notifyOnSessionStart', 'defaultLayer',
  'retrospectEnabled', 'retrospectDays'
])

/**
 * 质检段可在命令行里改的键。
 *
 * 为什么这几个必须能从命令行关：质检层是唯一会**主动往对话里插消息**的部件，
 * 一旦它误判（strict 模式的误报率本来就不低），用户得有一个不用改 JSON、
 * 不用重启的方式立刻让它闭嘴。`quality.enabled=false` 就是那个刹车。
 */
const SET_QUALITY_KEYS = new Set(['enabled', 'ledgerLevel', 'strict', 'preStepCheck', 'maxFindingsInReminder'])

/**
 * 命令行里按布尔解析的键。
 *
 * 为什么需要这份名单：`set trailEnabled=off` 里的 `off` 是**字符串**，
 * 直接交给 sanitizeConfig 会被判「必须为布尔值」而拒绝。命令层必须先把人话
 * （on/off/yes/no）翻成 true/false —— 但只在名单内的键上翻，`set agentName=off`
 * 还得是那个名字叫「off」的助手。
 */
const SET_BOOLEAN_KEYS = new Set([
  'enabled', 'requireToolConfirmation', 'trailEnabled', 'workspaceOverridesEnabled',
  'memory.enabled', 'memory.autoCapture', 'memory.nightlyTriage', 'memory.notifyOnSessionStart',
  'memory.retrospectEnabled',
  'quality.enabled', 'quality.strict', 'quality.preStepCheck'
])

/** 按整数解析的键。**范围不在这里判** —— 越界要报「必须是 0..23」，交给 sanitizeConfig。 */
const SET_NUMBER_KEYS = new Set([
  'memory.nightlyHour', 'memory.maxPending', 'memory.maxInjected', 'memory.maxInjectedChars',
  'memory.retrospectDays',
  'quality.maxFindingsInReminder'
])

const SET_BOOLEAN_WORDS = new Map([
  ['true', true], ['1', true], ['on', true], ['yes', true],
  ['false', false], ['0', false], ['off', false], ['no', false]
])

/**
 * 解析 `key=value` 参数。
 *
 * 规则：不含 `=` 的 token 追加到**上一个**值上。于是
 * `/anima set customInstructions=先给结论 再给理由` 的后半句不会被当成键名丢掉，
 * 而 `set =x` 会因「没有键」直接报用法错误 —— 笔误在这里就该失败。
 */
function parseSetArgs(rest) {
  const pairs = []
  for (const token of String(rest ?? '').split(/\s+/)) {
    if (!token) continue
    const at = token.indexOf('=')
    if (at > 0) pairs.push([token.slice(0, at), token.slice(at + 1)])
    else if (pairs.length > 0) pairs[pairs.length - 1][1] += ` ${token}`
    else return null
  }
  return pairs.length > 0 ? pairs : null
}

/** 把点路径键转成真实写入路径；不认识的键返回 null（由调用方报「不认识的字段」）。 */
function setKeyPath(key) {
  if (SET_TOP_KEYS.has(key)) return [key]
  const parts = String(key).split('.')
  if (parts.length === 2 && parts[0] === 'memory' && SET_MEMORY_KEYS.has(parts[1])) {
    return ['memory', parts[1]]
  }
  if (parts.length === 2 && parts[0] === 'quality' && SET_QUALITY_KEYS.has(parts[1])) {
    return ['quality', parts[1]]
  }
  return null
}

/** 按点路径取值，用于把「改成了什么」念回给用户（`memory.maxInjected` 取不到就直接下标）。 */
// 这里刻意同时挡 null 与 undefined（原写法 `acc == null` 是两者的并集）：
// 只用 `acc === null` 会在中间键缺失（undefined）时抛 TypeError。
const isNullish = (value) => value === null || value === undefined
const readPath = (obj, key) => key.split('.').reduce((acc, part) => (isNullish(acc) ? acc : acc[part]), obj)

/** 补丁展平成点路径集合，只用于比对「哪些键真的被 sanitizeConfig 吃下了」。 */
function flattenPatch(patch) {
  const flat = new Set()
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const sub of Object.keys(value)) flat.add(`${key}.${sub}`)
    } else flat.add(key)
  }
  return flat
}

/**
 * 把解析结果转成配置补丁。
 * @returns {{patch: object, flat: string[]} | {error: string}}
 */
function buildSetPatch(pairs) {
  const patch = {}
  const flat = []
  for (const [key, raw] of pairs) {
    const path = setKeyPath(key)
    // 未知键**也照样写进补丁**再靠比对发现「被丢弃」：那样报错文案能同时覆盖
    // 「键名不认识」与「值被校验拒了」两种情形，而不必在这里维护第二份字段表。
    const target = path ?? [key]
    let value = raw
    if (path && SET_BOOLEAN_KEYS.has(key)) {
      value = SET_BOOLEAN_WORDS.get(String(raw).toLowerCase())
      if (value === undefined) return { error: `${key} 只能是 true / false（也可以写 on / off、yes / no）` }
    } else if (path && SET_NUMBER_KEYS.has(key)) {
      const n = Number(String(raw).trim())
      if (!Number.isFinite(n)) return { error: `${key} 必须是数字，收到「${raw}」` }
      value = n
    }
    if (target.length === 1) patch[target[0]] = value
    else {
      if (!patch[target[0]] || typeof patch[target[0]] !== 'object') patch[target[0]] = {}
      patch[target[0]][target[1]] = value
    }
    flat.push(key)
  }
  return { patch, flat }
}

function registerCommands(ctx) {
  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.commands.register({
      name: 'anima',
      description: '管理灵台：AI 名字、工作区覆盖与待审记忆缓冲区',
      input: { hint: '[show|pending|adopt <id>|discard <id>|mark <id> type=… state=…|triage|patrol|复盘|checkup|audit|name <名字>|set k=v …|enable|disable|confirm|reject|reset]' },
      async handler(invocation) {
        const raw = String(invocation?.rawInput || '').trim()
        const spaceAt = raw.search(/\s/)
        const verb = (spaceAt === -1 ? raw : raw.slice(0, spaceAt)).toLowerCase()
        const rest = spaceAt === -1 ? '' : raw.slice(spaceAt + 1).trim()

        // show 是只读诊断命令：存储栈没组合时它恰恰最该跑得通 —— 用户正是靠它
        // 才知道「插件在，是存储没接上」，所以这里容忍装载失败并把原因留给 show 分支渲染。
        // 其余子命令都要读写存储，失败就照旧报错（错误文案里已带组合指引）。
        let loadError = null
        try {
          await reload(ctx, { refreshPrompt: false })
        } catch (err) {
          if (!verb || verb === 'show') loadError = err
          else throw err
        }

        try {
          if (!verb || verb === 'show') {
            const config = runtime.config
            // 只在存储真能读到时去取审计：装载失败时 srcKind 为 null，此时 listAudit 会再抛一次，
            // 那正好把 show 变成「存储坏了就什么都不显示」——它偏要在这时也能跑通。
            const recentAudit = loadError
              ? null
              : (await runtime.store.listAudit().catch(() => [])).at(-1) ?? null
            // 角色可能很长，展示时截到 60 字并补省略号；未设置时给占位文案。
            // 拆出来是为了不写嵌套三元（规则禁止）。
            const rolePreview = (() => {
              if (!config.agentRole) return '（未设置）'
              const head = config.agentRole.slice(0, 60)
              return config.agentRole.length > 60 ? `${head}…` : head
            })()
            const lines = [
              `灵台：${config.enabled ? '已启用' : '已关闭'}`,
              `AI 名字：${config.agentName || '（未设置）'}`,
              `AI 角色：${rolePreview}`,
              `工作区覆盖：${config.workspaceOverridesEnabled ? `已启用（目录 ${config.workspaceFileDir}）` : '已关闭'}`,
              `记忆层：${config.memory.enabled ? '已启用' : '已关闭'}；待审 ${runtime.pendingCount} 条，已采纳 ${runtime.adopted.length} 条`,
              // 质检层的状态必须能被一眼看到：它是唯一会主动往对话里插消息的部件，
              // 「我怎么突然被顶了」的答案应该在这里，而不是要用户去翻配置 JSON。
              `质检层：${config.quality.enabled ? '已启用' : '已关闭'}（对账 ${config.quality.ledgerLevel}，严格 ${config.quality.strict ? '开' : '关'}，机制检查 ${config.quality.preStepCheck ? '开' : '关'}）`,
              // 运行计数放在配置状态之后：配置说「应该是开的」，计数说「实际跑过几次」。
              // 两者必须并排出现 —— 只有前者时，一个从未被调用过的钩子看起来完全正常。
              `质检运行：已查 ${runtime.qualityStats.checks} 次，已提醒 ${runtime.qualityStats.reminders} 次`
                + (runtime.qualityStats.suppressed > 0 ? `，被每轮上限压住 ${runtime.qualityStats.suppressed} 次` : '')
                + describeSkips(runtime.qualityStats.skipped),
              // 这几个数是**累计**的（跨重启），所以必须说清从什么时候开始算、
              // 最后一次落盘是什么时候。只报「已查 N 次」而不报基准点，读者没法
              // 判断这个 N 是本次启动的还是历史累计的 —— 那又变成了一句无法核对的话。
              `质检计数：${runtime.qualityStats.startedAt ? `本次启动于 ${runtime.qualityStats.startedAt.slice(0, 19).replace('T', ' ')}，累计口径` : '仅本次运行（尚未落盘）'}`
                + (runtime.qualityStats.flushedAt ? `；最后一次落盘 ${String(runtime.qualityStats.flushedAt).slice(0, 19).replace('T', ' ')}` : '；尚未落盘，重启会丢'),
              `存储：${runtime.store.srcKind ?? '未打开'}${runtime.store.srcPath ? ` (${runtime.store.srcPath})` : ''}${runtime.store.srcReason ? `　不可用原因：${runtime.store.srcReason} —— ${runtime.store.srcMessage ?? ''}` : ''}${runtime.store.srcDomainVersion !== null ? `　存储格式 v${runtime.store.srcDomainVersion}` : ''}`,
              // 最近一次人设变更是「谁在什么时候动了什么」——三个入口（设置页 / 本命令 / 模型工具）
              // 都可能改写人设，show 是唯一能一眼看到这件事的地方。只显示一条：它是诊断行，不是列表。
              ...(recentAudit ? [`最近变更：${summarizeAudit(recentAudit)}`] : []),
              ...(runtime.pendingProposal
                ? [`有一份待确认的人设变更提议（${Object.keys(runtime.pendingProposal.patch).join(', ')}）—— /anima confirm 确认，/anima reject 拒绝。`]
                : []),
              ...(loadError ? ['（以上是内置默认值；存储不可用时读不到你保存的人设）'] : [])
            ]
            return { kind: loadError ? 'error' : 'success', text: lines.join('\n') }
          }

          if (verb === 'pending') {
            const all = await runtime.store.listMemories()
            const { pending } = groupByStatus(all)
            if (pending.length === 0) return { kind: 'success', text: '待审缓冲区为空。' }
            return {
              kind: 'success',
              text: pending.slice(0, 20).map((r) => `${r.id}\n  ${r.text}`).join('\n')
            }
          }

          if (verb === 'adopt' || verb === 'discard') {
            if (!rest) return { kind: 'error', text: `用法：/anima ${verb} <id>` }
            const record = await runtime.store.getMemory(rest)
            if (!record) return { kind: 'error', text: `找不到记忆 ${rest}` }
            await runtime.store.putMemory({
              ...record,
              status: verb === 'adopt' ? 'adopted' : 'discarded',
              decidedAt: new Date().toISOString()
            })
            await reload(ctx, { refreshPrompt: true })
            return { kind: 'success', text: `已${verb === 'adopt' ? '采纳' : '丢弃'}：${record.text}` }
          }

          if (verb === 'mark') {
            // 用法：/anima mark <id> type=fact state=superseded supersededBy=<另一条 id>
            //
            // 为什么要有命令行：回填时用户可能正在会话里，逐条开设置页太慢；
            // 而「改已有记忆的分类」又不能靠模型工具（那等于让被检查者自己填考卷）。
            const parts = rest.split(/\s+/).filter(Boolean)
            const id = parts.shift() ?? ''
            if (!id) return { kind: 'error', text: '用法：/anima mark <id> [type=…] [state=…] [supersededBy=<id>] [verifyAt=YYYY-MM-DD] [sourceRef=…]' }
            const changes = {}
            for (const token of parts) {
              const at = token.indexOf('=')
              if (at <= 0) return { kind: 'error', text: `看不懂这一项：${token}（应为 key=value）` }
              const key = token.slice(0, at)
              if (!['type', 'state', 'supersededBy', 'verifyAt', 'sourceRef'].includes(key)) {
                return { kind: 'error', text: `不支持的键：${key}（只有 type / state / supersededBy / verifyAt / sourceRef）` }
              }
              changes[key] = token.slice(at + 1)
            }
            if (Object.keys(changes).length === 0) {
              return { kind: 'error', text: '没有要改的项：至少给一个 type= / state= / supersededBy= / verifyAt= / sourceRef=' }
            }
            const record = await runtime.store.getMemory(id)
            if (!record) return { kind: 'error', text: `找不到记忆 ${id}` }
            // 指向的另一条必须真的存在，否则记下一个指向空气的指针，
            // 读的人和将来的人都会以为有一条能点开的「后来那条」。
            if (typeof changes.supersededBy === 'string' && changes.supersededBy !== '') {
              const other = await runtime.store.getMemory(changes.supersededBy)
              if (!other) return { kind: 'error', text: `supersededBy 指向的记忆不存在：${changes.supersededBy}` }
            }
            const applied = applyMemoryMeta(record, changes)
            if (!applied.ok) return { kind: 'error', text: applied.error }
            if (applied.changed.length === 0) {
              return { kind: 'success', text: `没有变化（${Object.keys(changes).join('、')} 与现状相同）。` }
            }
            await runtime.store.putMemory(applied.record)
            await reload(ctx, { refreshPrompt: true })
            return {
              kind: 'success',
              text: `已更新 ${id}：${applied.changed.join('、')}\n  ${applied.record.text}`
            }
          }

          if (verb === 'triage') {
            const result = await runTriage(ctx, { reason: 'command' })
            if (!result.ok) return { kind: 'error', text: result.error }
            const s = result.summary
            return {
              kind: 'success',
              text: `整理完成：待审 ${s.pendingBefore} → ${s.pendingAfter}，自动清理 ${s.discardedTotal} 条。`
            }
          }

          if (verb === 'patrol' || verb === '巡夜') {
            const result = await runPatrol(ctx, { reason: 'command' })
            if (!result.ok) return { kind: 'error', text: result.error }
            const { verdict, delivered } = result
            const lines = [
              `巡夜完成：待审 ${verdict.facts.pending} 条，体检 ${verdict.facts.flagged} 条，整理动过 ${verdict.facts.removed} 条。`
            ]
            // 说清「为什么没说」—— 只报有事之后，「没报」必须自己解释自己，
            // 否则用户会以为它坏了。这一行就是那句解释。
            lines.push(delivered > 0
              ? `已汇报（${delivered} 个会话）。`
              : '判定为无事，没有汇报。这条记录留在 meta.patrol 里，可反查。')
            return { kind: 'success', text: lines.join('\n') }
          }

          if (verb === 'retrospect' || verb === '复盘') {
            const result = await runRetrospect(ctx, { reason: 'command' })
            if (!result.ok) return { kind: 'error', text: result.error }
            const lines = [
              `复盘完成：回扫最近 ${result.days} 天的 ${result.files} 个会话、${result.messages} 条发言，新线索 ${result.verdict.newLeads.length} 条。`
            ]
            if (result.verdict.newLeads.length > 0) {
              for (const lead of result.verdict.newLeads.slice(0, 8)) {
                lines.push(`· [${lead.kind}] ${lead.text}${lead.sessionRef ? `（${lead.sessionRef}）` : ''}`)
              }
              if (result.verdict.newLeads.length > 8) {
                lines.push(`· 另有 ${result.verdict.newLeads.length - 8} 条，见 meta.retrospect。`)
              }
            } else {
              lines.push('没有新线索。这条记录留在 meta.retrospect 里，可反查。')
            }
            lines.push(result.delivered > 0
              ? `已提示（${result.delivered} 个会话）。`
              : '没有提示。')
            return { kind: 'success', text: lines.join('\n') }
          }

          if (verb === 'name') {
            if (!rest) return { kind: 'error', text: '用法：/anima name <名字>' }
            const { patch, errors } = sanitizeConfig({ agentName: rest })
            if (Object.keys(errors).length > 0) return { kind: 'error', text: formatFieldErrors(errors) }
            const { config, changed } = await runtime.store.updateConfig(patch, { actor: 'user', source: 'command', note: '/anima name' })
            await reload(ctx, { refreshPrompt: true, configChange: { changed, source: 'command' } })
            return { kind: 'success', text: `AI 名字已设为：${config.agentName}` }
          }

          // enable / disable 单独给两个子命令，而不是让用户敲 `set enabled=false`：
          // 开关人设是最高频的一次操作，值得一个能背下来的短词。
          if (verb === 'enable' || verb === 'disable') {
            const wanted = verb === 'enable'
            if (runtime.config.enabled === wanted) {
              return { kind: 'success', text: wanted ? '助手人格已是启用状态。' : '助手人格已是关闭状态。' }
            }
            const { changed } = await runtime.store.updateConfig(
              { enabled: wanted },
              { actor: 'user', source: 'command', note: `/anima ${verb}` }
            )
            await reload(ctx, { refreshPrompt: true, configChange: { changed, source: 'command' } })
            return {
              kind: 'success',
              text: wanted
                ? '助手人格已启用。'
                : '助手人格已关闭 —— 已告诉当前会话里的人设设定作废；随时用 /anima enable 打开。'
            }
          }

          if (verb === 'set') {
            const pairs = parseSetArgs(rest)
            if (!pairs) {
              return { kind: 'error', text: '用法：/anima set key=value [key=value …]（值含空格时直接写在后面即可）' }
            }
            const built = buildSetPatch(pairs)
            if (built.error) return { kind: 'error', text: built.error }
            const { patch, errors } = sanitizeConfig(built.patch)
            const errorKeys = Object.keys(errors)
            if (errorKeys.length > 0) {
              // 只念第一条：用户一次写错多个键时，先把第一个修好再看下一个，
              // 一次全倒出来反而看不清从哪改起。
              return { kind: 'error', text: `${errorKeys[0]}：${errors[errorKeys[0]]}` }
            }
            // sanitizeConfig 会**静默丢弃**它不认识的键（这是它作为落盘闸门的正确行为），
            // 因此命令层必须自己比对一次：否则 `set agnetName=x` 会回一句「已更新」而实际没改。
            const accepted = flattenPatch(patch)
            const unknown = built.flat.filter((key) => !accepted.has(key))
            if (unknown.length > 0 && Object.keys(patch).length === 0) {
              return { kind: 'error', text: `不认识的字段：${unknown.join('、')}。用 /anima show 看当前有哪些字段。` }
            }
            if (unknown.length > 0) {
              return { kind: 'error', text: `不认识的字段：${unknown.join('、')}（本次未做任何改动，请去掉它后重试）` }
            }
            const { config, changed } = await runtime.store.updateConfig(patch, {
              actor: 'user', source: 'command', note: `/anima set ${built.flat.join(' ')}`
            })
            await reload(ctx, {
              refreshPrompt: changed.length > 0,
              configChange: changed.length > 0 ? { changed, source: 'command' } : null
            })
            if (changed.length === 0) return { kind: 'success', text: '这些字段本来就等于你要设的值，未做改动。' }
            const shown = changed.map((key) => `${key}=${JSON.stringify(readPath(config, key))}`).join('、')
            return { kind: 'success', text: `已更新：${shown}` }
          }

          // 自检命令：把我上一条回答交给**同一套**机器判据重算一遍，并把判据本身摊开。
          //
          // 为什么必须有这个入口：pre-step 的提醒只在命中时出现，没命中时用户看到的
          // 是「什么都没发生」—— 那和「检查根本没跑」长得一模一样。用户没法区分，
          // 就只能靠信我。这个命令把「检查跑了没有、查了什么、没查什么」变成可主动索取的东西。
          //
          // 它刻意不做的事：不给分数，不说「通过」。没有 findings 只说明「机器在它
          // 能查的那些形状上没抓到东西」，不等于内容正确 —— 这句话必须每次都印出来，
          // 否则这个命令自己就成了新的表演面。
          if (verb === 'checkup' || verb === '体检') {
            // 记忆体检：和 /anima audit（检查我上一条回答）是两回事，别混。
            // 那条查「我说的话」，这条查「记下来的东西还成不成立」。
            const records = await runtime.store.listMemories()
            const result = auditMemories(records, { probe: (p) => existsSync(p) })
            const lines = []
            // 截断必须写在第一行。放在末尾就等于：读者先看到「0 条要你看一眼」，
            // 形成一个「全查过了」的印象，再看到「其实有 12 个没查」—— 先入为主的是前一句。
            const truncHead = result.truncated?.records
              ? `（另有 ${result.truncated.paths} 个路径超出单条上限没查）`
              : ''
            lines.push(`记忆体检：查了 ${result.checked} 条已采纳记忆，${result.clean} 条没问题，${result.flagged.length} 条要你看一眼${truncHead}。`)
            lines.push('')
            if (result.flagged.length === 0) {
              // 这里以前无条件说「都没发现问题」。有截断时这句就是假话：
              // 那 12 个路径确实没被探过，它们里面可能就有一个已经没了。
              if (result.truncated?.records) {
                lines.push(`机器验到的部分没发现问题，但**没有查全**：${result.truncated.note}`)
              } else {
                lines.push('机器能验的两项（路径还在不在、复核点过没过）都没发现问题。')
              }
              lines.push('　注意：这只说明「写下来的路径和日期还对得上」，不说明这些话现在仍然成立。')
            } else {
              for (const item of result.flagged) {
                lines.push(`- ${item.id}`)
                lines.push(`　${String(item.text).slice(0, 60)}${String(item.text).length > 60 ? '…' : ''}`)
                for (const f of item.findings) {
                  lines.push(`　· ${f.detail}`)
                  lines.push(`　　证据：${f.evidence}`)
                }
                if (item.suggestion.state) {
                  lines.push(`　建议：${item.suggestion.why}`)
                } else {
                  lines.push(`　建议：${item.suggestion.why}`)
                }
                lines.push(`　执行：${item.suggestion.command}`)
              }
            }
            lines.push('')
            if (result.truncated?.records) lines.push(result.truncated.note)
            lines.push(result.note)
            lines.push('这条命令不会改任何状态；上面每条都是候选，要你自己敲一次才会生效。')
            return { kind: 'success', text: lines.join('\n') }
          }

          if (verb === 'audit' || verb === '检查') {
            const agent = invocation?.agent
            const session = agent?.session
            if (!session || typeof session.snapshotEvents !== 'function') {
              return { kind: 'error', text: '当前会话读不到消息记录，无法检查。' }
            }
            const events = session.snapshotEvents()
            let last = null
            for (let i = events.length - 1; i >= 0; i -= 1) {
              if (events[i]?.type === 'assistant/message') { last = events[i]; break }
            }
            if (!last) return { kind: 'success', text: '这个会话里还没有助手回答可供检查。' }
            const body = eventText(last)
            if (body === '') return { kind: 'success', text: '上一条助手消息里没有文本内容（可能只有工具调用），没有可检查的文字。' }

            const q = runtime.config.quality
            const result = checkResponse(body, { ledgerLevel: q.ledgerLevel, strict: q.strict === true })
            const triggers = detectLedgerTriggers(body, q.ledgerLevel)
            const lines = []
            lines.push(`检查对象：本会话最后一条助手回答（${body.length} 字，事件 seq=${last.seq ?? '未知'}）`)
            lines.push(`判据版本：对账档位 ${q.ledgerLevel}，严格模式 ${q.strict ? '开' : '关'}`)
            lines.push('')
            if (triggers.hits.length === 0) {
              lines.push('对账触发：没有命中任何一档（不含数字/日期、没有「已确认」类断言、没有归属引用）。')
            } else {
              lines.push(`对账触发：命中 ${triggers.hits.length} 条 —— ${triggers.hits.map((h) => `${h.tier}「${h.excerpt}」`).join('；')}`)
            }
            lines.push(`对账块：${hasLedgerBlock(body) ? '有' : '没有'}`)
            lines.push('')
            if (result.findings.length === 0) {
              lines.push('机器判词：在它能查的形状上没抓到问题。')
              lines.push('　注意：这不等于内容正确，也不等于十二条全过（见下面的未查清单）。')
            } else {
              lines.push(`机器判词：${result.findings.length} 处`)
              for (const f of result.findings) {
                lines.push(`　- ${f.ruleId} ${f.name}（${f.severity}）：${f.detail}`)
                if (f.excerpt) lines.push(`　　原文：「${f.excerpt}」`)
              }
            }
            lines.push('')
            lines.push(`本次检查了：${result.checked.length > 0 ? result.checked.join('、') : '（无）'}`)
            lines.push(`本次未查：${result.uncovered.map((r) => r.id).join('、') || '（无）'} —— 这些机器判不了，只能由你自己看。`)
            lines.push('')
            lines.push('说明：这条结论由代码按固定正则算出，不经过模型。它能证明「某个形状在不在」，不能证明「内容对不对」。')
            return { kind: 'success', text: lines.join('\n') }
          }

          if (verb === 'confirm' || verb === 'reject') {
            const proposal = runtime.pendingProposal
            if (!proposal) {
              return { kind: 'error', text: `当前没有待确认的人设变更提议。` }
            }
            runtime.pendingProposal = null
            if (verb === 'reject') {
              return { kind: 'success', text: `已拒绝该提议，配置未改动。` }
            }
            const { patch, errors } = sanitizeConfig(proposal.patch)
            if (Object.keys(errors).length > 0) {
              return { kind: 'error', text: `提议已失效（${formatFieldErrors(errors)}），请让模型重新提交。` }
            }
            const { changed } = await runtime.store.updateConfig(patch, { actor: 'user', source: 'proposal', note: '命令确认了模型提议' })
            await reload(ctx, { refreshPrompt: changed.length > 0, configChange: { changed, source: 'command' } })
            return {
              kind: 'success',
              text: `已确认并生效：${changed.map((k) => `${k}=${JSON.stringify(runtime.config[k])}`).join(', ') || '（无实际变化）'}`
            }
          }

          if (verb === 'reset') {
            const { changed } = await runtime.store.resetConfig({ actor: 'user', source: 'command' })
            await reload(ctx, { refreshPrompt: true, configChange: { changed, source: 'command' } })
            return { kind: 'success', text: '全局配置已重置为默认值（记忆与工作区覆盖未动）。' }
          }

          return { kind: 'error', text: `未知子命令 ${verb}。可用：show|pending|adopt|discard|mark|triage|checkup|audit|name|set|enable|disable|confirm|reject|reset` }
        } catch (err) {
          return { kind: 'error', text: `执行失败：${String(err?.message || err)}` }
        }
      }
    })
  })
}

// ==================== Agent 工具 ====================

function registerTools(ctx) {
  ctx.inject(['tools'], (toolsCtx) => {
    import('@deepseek-ai/dsh-tools').then(({ defineTool, TOOL_RUNTIME_SCHEDULER }) => {
      if (typeof TOOL_RUNTIME_SCHEDULER !== 'symbol') {
        throw new Error('dsh-anima: resolved @deepseek-ai/dsh-tools lacks TOOL_RUNTIME_SCHEDULER — requires ^0.1.0-rc.6')
      }

      toolsCtx.tools.register(defineTool({
        name: 'remember',
        description: [
          '把一条值得长期记住的信息投递到待审缓冲区。',
          '注意：投递只是「提名」，不会立即生效 —— 内容要等用户在设置页里采纳后才会进入长期记忆。',
          '适用于用户明确表达的稳定偏好、长期约束、重要背景；不要记录临时任务状态、寒暄或可从代码/文件直接读出的信息。',
          '请尽量给出 type（这条是什么）与 sourceRef（凭什么记这条）：没有来源的记忆，日后无法核对真假。',
          '不要在此写入任何密钥、令牌、密码；凭据会被直接拒绝。'
        ].join(''),
        parameters: {
          text: { type: 'string', description: '要记住的完整陈述句（不超过 500 字）' },
          note: { type: 'string', description: '可选：为什么值得记住，便于用户裁决' },
          scope: { type: 'string', description: '可选：该记忆的适用范围标注（如 global / 项目名）' },
          type: {
            type: 'string',
            // 不做 enum：宿主参数 DSL 允许 enum，但这里刻意不用 —— 模型面对封闭枚举时
            // 会倾向硬套一个「最像的」，而「这条既像偏好又像立场」正是需要它说清楚的时刻。
            // 写错的值由 lib/memory.mjs 归一成默认类型，不会污染介质。
            description: '可选：这条记忆是什么 —— fact〔事实〕/ preference〔偏好〕/ stance〔立场〕/ event〔事件〕。'
              + '四者的失效方式不同：事实改了才覆盖，偏好半衰期很长，立场在「我改主意了」时要归档成「曾如此」，事件永不失效但会归档。'
          },
          sourceRef: {
            type: 'string',
            description: '可选：凭什么记这条 —— 可反查的出处（如 m00123 这类消息编号、文件:行号、URL）。'
              + '不接受「对话里说过」这种无法核对的表述；没有出处就留空，不要编。'
          },
          verifyAt: {
            type: 'string',
            description: '可选：复核点（YYYY-MM-DD）。到这天之后注入时会标注「可能已过时」，由用户决定要不要更新。'
              + '只给状态类记忆设复核点（「最近在焦虑什么」），事实类（职业、技术栈）不要设。'
          }
        },
        output: {
          schema: {
            // ⚠️ 此处**不得**写 `required`（根与嵌套都不行）。宿主 value schema DSL 只在
            //   参数属性层放行 `required`（parameterSchemaSpecToJsonSchema → allowRequired:true），
            //   而 output.schema 走 compileValueSchema（allowRequired:false）⇒ 写错会让
            //   defineTool() 在定义期抛 JsonSchemaError，工具永不注册，再被入口的 .catch 吞成一行提示。
            //   实测报错原文：`unsupported JSON schema: schema.required is not supported by the value schema DSL`。
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              id: { type: 'string' },
              pending: { type: 'number' }
            }
          },
          // ⚠️ `render` 是**必需**的，不是可选装饰：defineTool 会无条件执行
          //   `const userRender = options.output.render` 并在包出的 render 里直接调用它
          //   （dsh-tools/lib/types/schema.js:283 与 :304-306），所以只给 schema 不给 render
          //   能在定义期注册成功、却让**每次调用**在展示层炸掉，报
          //   `tool "remember" returned invalid output: output.render failed: userRender is not a function`。
          //   注意工具本体其实已经执行完毕（记忆确实进了缓冲区）——炸的只是结果渲染。
          render: (_args, value) => [{
            type: 'text',
            text: String(value?.message ?? '') +
              (value?.id ? `（id: ${value.id}）` : '') +
              (typeof value?.pending === 'number' ? `｜当前待审 ${value.pending} 条` : '')
          }]
        },
        async execute(args, exec) {
          const config = await runtime.store.getConfig()
          if (!config.memory.enabled) {
            return { ok: false, message: '记忆层当前已关闭，未记录。用户可在「设置 → 灵台」里重新开启。' }
          }
          if (!config.memory.autoCapture) {
            return { ok: false, message: '自动捕获当前已关闭；请让用户手动在设置页添加。' }
          }
          // cwd 不在 args 里，而在执行上下文的 agent 上（宿主约定，见 @deepseek-ai/dsh-tools
          // 的 exec.agent?.session.header.cwd）；读 args.__cwd 永远拿不到值。
          const cwd = exec?.agent?.session?.header?.cwd
          const created = makeCandidate({
            text: args?.text,
            note: args?.note,
            scope: args?.scope,
            type: args?.type,
            sourceRef: args?.sourceRef,
            verifyAt: args?.verifyAt,
            source: 'agent',
            cwd: typeof cwd === 'string' ? cwd : undefined
          })
          if (!created.ok) return { ok: false, message: created.error }

          // 内容已存在（无论状态）则不再重复提名
          const all = await runtime.store.listMemories()
          const dup = all.find((r) => r.digest === created.record.digest || r.text === created.record.text)
          if (dup) {
            return {
              ok: true,
              message: dup.status === 'adopted'
                ? '这条已经在长期记忆里了，未重复记录。'
                : `这条已在缓冲区中（状态：${dup.status}），未重复记录。`,
              id: dup.id,
              pending: runtime.pendingCount
            }
          }

          await runtime.store.putMemory(created.record)
          await reload(ctx, { refreshPrompt: true })
          return {
            ok: true,
            message: '已投递到待审缓冲区，等待用户裁决后才会生效。',
            id: created.record.id,
            pending: runtime.pendingCount
          }
        }
      }))

      // ── 工具：改人设（同生态的插件普遍把这个工具叫同一个名字） ────────────────
      //
      // **名字刻意与它们错开**：dsh-tools 的命名表遇重名直接抛
      //   `tool "${name}" is already registered (for a per-agent variant, register
      //    through that agent's \`agent.ctx\` instead)`
      // （dsh-tools\lib\index.js:2634 的 NamedEntries 冲突工厂），且注册顺序决定谁死。
      // 同生态的几款插件也用这个名字，共存时必有一方的工具凭空消失；对本机是过渡期的
      // 静默故障，对将来的用户（可能同时装着两者）是发布级缺陷。功能对齐不要求撞名。
      //
      // 参数里的六个风格字段是**自由文本**，不是枚举（用户 m06593 ① 已定「全字段自由文本」）。
      // 因此这里刻意不写 `enum`、也不写「建议值：professional / casual / …」这类键名提示 ——
      // 那会让模型把一段自然语言要求硬塞进一个英文键里，用户看到的风格就成了 'roast'
      // 这种自己没写过的字样。描述里明确要求「写一句中文」，把模型引到正确的形态上。
      // 档位文案（专业严谨 / 毒舌吐槽 …）只作为设置页的「一键填入」按钮存在，是给用户的。
      toolsCtx.tools.register(defineTool({
        name: 'set_assistant_persona',
        description: [
          '调整助手自身的人设（AI 的名字、角色设定、对用户的称呼、用户背景、回复风格与自定义指令）。',
          '当用户明确要求改变称呼、语气、风格或角色时使用。只需要传入要修改的字段，未提供的字段保持不变。',
          '风格类字段请直接写中文的自然语言要求（例如「结论先行，不展开背景」），不要写英文档位键。',
          '若用户的配置开启了「工具确认」，本工具只提交提议、不立即生效，需要用户在命令里确认。'
        ].join(''),
        parameters: {
          agentName: { type: 'string', description: '助手自己的名字（注意：不是用户的称呼）' },
          agentRole: { type: 'string', description: '助手的角色设定，例如「长期 AI 助手，学生/研究者为主」' },
          addressUserAs: { type: 'string', description: '助手对用户的称呼' },
          userOccupation: { type: 'string', description: '用户的职业' },
          userBio: { type: 'string', description: '关于用户的介绍与背景' },
          style: { type: 'string', description: '回复风格与语调，一段中文描述，例如「专业严谨，结论先行，不用口语」' },
          headingLists: { type: 'string', description: '标题与列表的使用倾向，一段中文描述，例如「多用标题与列表组织内容」' },
          emoji: { type: 'string', description: '表情符号的使用倾向，一段中文描述，例如「尽量不使用表情符号」' },
          tables: { type: 'string', description: '表格的使用倾向，一段中文描述，例如「适合对比时优先用表格」' },
          replyLength: { type: 'string', description: '回复长度偏好，一段中文描述，例如「简洁，直击要点」' },
          language: { type: 'string', description: '回复语言，一段中文描述，例如「使用简体中文回复」' },
          customInstructions: { type: 'string', description: '额外的自定义指令，用于覆盖或补充当前人设' }
        },
        output: {
          schema: {
            // 与 remember 同一套 DSL 约束：不得写 `required`，object 节点必须显式声明
            // additionalProperties。详见上方 remember 的注释。
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              pending: { type: 'boolean' },
              changes: {
                type: 'object',
                additionalProperties: false,
                description: '实际发生变化的字段（字段名 → 新值）',
                properties: Object.fromEntries(TOOL_FIELDS.map((key) => [key, { type: 'string' }]))
              }
            }
          },
          render: (_args, value) => {
            const lines = []
            if (value && typeof value.message === 'string' && value.message !== '') lines.push(value.message)
            const changes = value && value.changes
            if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
              const detail = Object.entries(changes)
                .map(([key, val]) => `${key}=${JSON.stringify(val)}`)
                .join(', ')
              if (detail !== '') lines.push(`变更：${detail}`)
            }
            if (lines.length === 0) lines.push(value && value.ok ? 'ok' : '失败')
            return [{ type: 'text', text: lines.join('\n') }]
          }
        },
        async execute(args) {
          try {
            const { patch, errors } = sanitizeConfig(args)
            if (Object.keys(errors).length > 0) {
              return { ok: false, message: `配置校验失败：${formatFieldErrors(errors)}` }
            }
            // 只接受工具字段：sanitizeConfig 认得的键比这里多（enabled / memory / presets…），
            // 不能让模型透过本工具改到那些字段。
            const writable = {}
            for (const key of TOOL_FIELDS) {
              if (key in patch) writable[key] = patch[key]
            }
            if (Object.keys(writable).length === 0) {
              return { ok: true, message: '没有要更改的设置' }
            }

            const config = await runtime.store.getConfig()
            const changedKeys = Object.keys(writable).filter((key) => config[key] !== writable[key])
            if (changedKeys.length === 0) {
              return { ok: true, message: '没有要更改的设置' }
            }
            const effective = Object.fromEntries(changedKeys.map((key) => [key, writable[key]]))

            if (config.requireToolConfirmation) {
              runtime.pendingProposal = { patch: effective, proposedAt: new Date().toISOString() }
              const detail = Object.entries(effective).map(([key, val]) => `${key}=${JSON.stringify(val)}`).join(', ')
              return {
                ok: true,
                pending: true,
                changes: effective,
                message: [
                  '已收到人设变更请求（确认模式已开启，尚未生效）：',
                  detail,
                  '在用户确认前不会生效；用户可用 /anima confirm 确认，或 /anima reject 拒绝。'
                ].join('\n')
              }
            }

            const { changed } = await runtime.store.updateConfig(effective, {
              actor: 'agent',
              source: config.requireToolConfirmation ? 'proposal' : 'tool',
              note: 'set_assistant_persona'
            })
            await reload(ctx, { refreshPrompt: changed.length > 0, configChange: { changed, source: 'tool' } })
            return {
              ok: true,
              message: '已更新人设设置',
              changes: Object.fromEntries(changed.map((key) => [key, runtime.config[key]]))
            }
          } catch (err) {
            // 存储不可用时给结构化失败，而不是把 StorageUnavailableError 抛给模型
            return { ok: false, message: `执行失败：${String(err?.message || err)}` }
          }
        }
      }))
    }).catch((err) => {
      warn(ctx, `工具未注册：${String(err?.message || err)}`)
    })
  })
}

// ==================== 入口 ====================

export async function apply(ctx) {
  runtime.ctx = ctx

  const store = new StateStore(ctx, ctx.logger)
  runtime.store = store

  const state = {
    timer: null,
    lastTriageDay: async () => {
      const table = await store.table?.('meta')
      const meta = table?.get('triage')
      return meta?.lastTriageDay
    }
  }

  // 公开服务：供其它插件或脚本读取有效人设（同生态里的人设插件也各有同类服务）
  ctx.provide('animaConfig', {
    /** 有效人设（全局 + 指定工作区合并后的结果） */
    async getEffective(workspacePath) {
      const config = await store.getConfig()
      if (!workspacePath || !config.workspaceOverridesEnabled) {
        return { effective: mergePersona(config, null).effective, sources: {}, workspacePath: null }
      }
      const { overrides } = await readOverrides(workspacePath, config.workspaceFileDir)
      const { effective, sources } = mergePersona(config, overrides)
      return { effective, sources, workspacePath }
    },
    async getConfig() {
      return store.getConfig()
    },
    /**
     * 本插件这一轮会注入的全部文本（人设 + 记忆 + 待审提示）。
     *
     * 门控与三个 section 函数**逐条对齐**（未装载 ⇒ 空串；关闭 ⇒ 关闭声明；
     * 记忆层单独有开关），否则这个服务会答出一份模型实际看不到的文本 ——
     * 那比不提供这个服务更坏。
     *
     * 不复用 /api/anima/preview：那是**设置页的展示口径**，接受草稿覆盖、
     * 返回逐段 sections 与注入决策。服务调用方问的是「现在真正注入什么」，
     * 两者混用会让人误以为还没保存的草稿也算数。
     */
    async getSystemPrompt(workspacePath) {
      if (!runtime.loaded) return ''
      const config = await store.getConfig()
      if (!config.enabled) return compileDisabledNotice()
      const overrides = workspacePath && config.workspaceOverridesEnabled
        ? (await readOverrides(workspacePath, config.workspaceFileDir)).overrides
        : null
      const { effective } = mergePersona(config, overrides)
      const memory = config.memory.enabled
        ? (() => {
          const selection = selectForInjection(runtime.adopted, config.memory.maxInjected, {
            maxInjectedChars: config.memory.maxInjectedChars,
            cwd: workspacePath ?? ''
          })
          return compileMemory(selection.selected, summarizeOmission(selection))
        })()
        : ''
      const pending = config.memory.enabled ? compilePendingNotice(runtime.pendingCount) : ''
      // remember 指引段的门控必须与 rememberText 逐条一致（含 autoCapture）：
      // 这个方法是「模型这一轮到底看到什么」的权威答案，多一段少一段都是错的。
      const remember = config.memory.enabled && config.memory.autoCapture ? compileRememberGuide() : ''
      // 质检段必须在这里也出现：这个方法的名字是 getSystemPrompt，调用方拿它当
      // 「模型这一轮到底看到什么」的权威答案。漏掉质检段就等于对外保证了一个
      // 与实际注入不符的文本 —— 正是本方法注释里说要避免的那种坏。
      const quality = compileQualitySection(config.quality)
      return [compilePersona(effective), memory, pending, remember, quality].filter(Boolean).join('\n\n')
    },
    /**
     * 重置全局人设（保留记忆、预设与工作区覆盖）。
     *
     * 与 HTTP 的 /reset 走同一个 store.resetConfig，因此同样留审计、同样发变更通知；
     * 单独给服务开一条「静默重置」的路等于给审计留个后门。
     */
    async resetConfig() {
      const { config, changed } = await store.resetConfig({ actor: 'system', source: 'other' })
      await reload(ctx, {
        refreshPrompt: changed.length > 0,
        configChange: changed.length > 0 ? { changed, source: '外部调用（其它插件或脚本）' } : null
      })
      return config
    },
    async updateConfig(patch) {
      const { patch: clean, errors } = sanitizeConfig(patch)
      if (Object.keys(errors).length > 0) {
        throw new Error(`配置校验失败：${formatFieldErrors(errors)}`)
      }
      const { config, changed } = await store.updateConfig(clean, { actor: 'system', source: 'other', note: '外部调用 animaConfig.updateConfig' })
      // 走这个入口的是别的插件或脚本：来源无法归到「设置页/命令/模型工具」里的任何一个，
      // 因此标注写「外部调用」而不是冒充用户操作 —— 模型需要知道自己手上的设定来自哪里。
      await reload(ctx, {
        refreshPrompt: changed.length > 0,
        configChange: changed.length > 0 ? { changed, source: '外部调用（其它插件或脚本）' } : null
      })
      return config
    },
    async listPending() {
      const all = await store.listMemories()
      return groupByStatus(all).pending
    },
    async runTriage() {
      return runTriage(ctx, { reason: 'api' })
    },
    /**
     * 手动跑一次巡夜（整理 + 体检 + 决定说不说）。
     *
     * 手动触发与定时触发走**同一条**判据：如果手动那次无视「指纹没变就不说」，
     * 用户就永远测不到定时触发的真实行为 —— 手点一次和它自己跑一次会给出
     * 不同答案的机制，等于没法验证。
     */
    async runPatrol() {
      return runPatrol(ctx, { reason: 'api' })
    }
  })

  registerSystemPrompt(ctx)
  registerQualityHook(ctx)
  registerRoutes(ctx)
  registerCommands(ctx)
  registerTools(ctx)

  // 首次装载：把落盘状态读进内存快照（此时才真正打开存储后端）。
  //
  // 这里**不能**假设 storageDomain 已就绪：dsh-storage-domain 是在它自己的
  // ctx.inject(backendServices, …) 回调里 provide 的（异步）。早期版本在 apply 阶段
  // 一次性 ctx.get() 判空后「退化到文件」，结果是冷启动时静默换了一个落盘点，
  // 用户先前填的人设读不出来（2026-10-10 实测）。
  //
  // 现在的做法（与某同生态插件的「惰性解析」一致 + 本仓实证的就绪信号）：
  //   - 服务缺失 ⇒ 挂 ctx.inject 等它就绪，届时重试一次（探针实证：服务晚提供时
  //     回调会被触发；已就绪则立即触发）；
  //   - 其它失败（词汇表缺失 / open 被拒）⇒ 服务是就绪的，重试没有意义，告警即可。
  // 三处不写 storageDomain 进 inject 的原因见文件头第四条约束与 lib/store.mjs 头注释。
  try {
    await reload(ctx, { refreshPrompt: false })
  } catch (err) {
    if (err?.code === 'storage-not-composed') {
      warn(ctx, `存储栈未就绪，等待 storageDomain 提供后重试：${String(err?.message || err)}`)
      ctx.inject(['storageDomain'], () => {
        reload(ctx, { refreshPrompt: true }).catch((retryErr) => {
          warn(ctx, `storageDomain 就绪后重试仍失败：${String(retryErr?.message || retryErr)}`)
        })
      })
    } else {
      warn(ctx, `初始加载失败（${err?.code ?? 'unknown'}）：${String(err?.message || err)}`)
    }
  }

  const scheduler = scheduleNightly(ctx, state)

  // 启动补跑：DSH 没在整点时开机的话，开机后补一次
  ctx.effect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await store.table?.('meta').then((t) => t)
        await new Promise((r) => setTimeout(r, 5000))
        if (cancelled) return
        // 首次装载没成功（存储栈未组合 / 还没就绪）时不硬试：这条补跑只是便利，
        // 存储不可用时它必然读不到 lastTriageDay，报一条「补跑失败」纯属噪音。
        // 真正就绪后会由 ctx.inject 的 retry 走一次 reload，后续整点仍按 nightlyHour 触发。
        if (!runtime.loaded) return
        const config = await store.getConfig()
        if (!config.memory.enabled) return
        // 巡夜与回扫各自判各自的开关与日期。曾经这里是一个 `||` 直接 return ——
        // 那个写法让「关掉巡夜」连带停掉回扫的补跑，而回扫在设置里是单开的。
        if (config.memory.nightlyTriage) {
          const last = await state.lastTriageDay()
          if (last !== dayKey()) {
            await runPatrol(ctx, { reason: 'catch-up' })
          }
        }
        // 回扫的补跑单独判日期。缺了这一段，只有巡夜会补跑、回扫会一直等到
        // 下一个整点 —— 而这类用户往往开机就没有整点（休眠/关机是常态）。
        if (config.memory.retrospectEnabled) {
          const retroMeta = (await store.table?.('meta'))?.get(RETROSPECT_KEY)
          if (!retrospectScannedToday(retroMeta)) {
            await runRetrospect(ctx, { reason: 'catch-up' })
          }
        }
      } catch (err) {
        warn(ctx, `启动补跑巡夜失败：${String(err?.message || err)}`)
      }
    })()
    return () => {
      cancelled = true
      scheduler.clear()
    }
  }, 'dsh-anima: catch-up patrol')

  ctx.effect(() => () => {
    // 卸载前把计数落一次盘：节流窗口里攒下的那些数字，如果不在这里写，
    // 就随着进程消失 —— 而那恰好是「刚跑了几十步就退出」的场景，最需要它。
    // 注意顺序：先取到 store，再清空 runtime，否则 flushQualityStats 拿不到后端。
    const store = runtime.store
    if (store) {
      try { void flushQualityStats(store) } catch { /* 卸载失败不阻塞退出 */ }
    }
    runtime.ctx = null
    runtime.store = null
    runtime.refresh = null
  }, 'dsh-anima: teardown')

  warn(ctx, `已装载（存储后端：${store.srcKind ?? `未打开，原因 ${store.srcReason ?? 'unknown'}`}）`)
}

export { runtime }
