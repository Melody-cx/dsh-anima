// index.mjs — dsh-anima（host 半边）
//
// 定位（用户 m03846 拍板「A 自建补齐」）：
//   本插件**自持全部人设字段**，不依赖任何其它插件。字段设计对照 WorkBuddy
//   设置页（「个性化」+「记忆与进化」两页）与 dsh-soul 0.7.0 的字段集，但代码
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
//   - section 名必须避开 `soul:persona` / `deployment:persona-prefix` / `deployment:persona-suffix`
//   - `section.text` 可以是函数，但装配期是**同步**调用（dsh-system-prompt\lib\index.js:342），
//     所以工作区覆盖的读取必须走同步路径（lib/workspace.mjs 的 resolveOverridesFromCwdSync）
//   - 会话格式 v4 要求注入消息自持 producer kind（lib/injection.mjs）
//   - 存储层**没有文件后端兜底**（2026-10-10 决定，与 dsh-checkpoint-rewind 的取舍一致）：
//     storageDomain 缺失或打开失败时抛 StorageUnavailableError（statusCode 503），
//     由路由与命令各自呈现给用户；首次装载失败时挂 ctx.inject 就绪信号重试一次，
//     绝不悄悄换一个落盘点。未装载成功前，三段 section 一律返回空串 —— 宁可没有人设，
//     也不要把一份「默认档」当成用户的人设注入进去。

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
  compileRules,
  compileStyle,
  compileUserProfile,
  describeSources
} from './lib/prompt.mjs'
import {
  BUILTIN_PRESETS,
  PRESET_COUNT_LIMIT,
  PRESET_FIELDS,
  applyPreset,
  findActivePreset,
  listPresets,
  resolvePreset,
  sanitizeCustomPreset,
  sanitizeCustomPresets
} from './lib/presets.mjs'
import { configChangedNoticeText, createInjectionSource, triageNoticeText } from './lib/injection.mjs'
import {
  ensureIgnored,
  readOverrides,
  removeOverrides,
  resolveOverridesFromCwdSync,
  writeOverrides
} from './lib/workspace.mjs'
import {
  clusterPending,
  groupByStatus,
  makeCandidate,
  selectForInjection,
  triage
} from './lib/memory.mjs'
import {
  IMPORT_MAX_ITEMS,
  IMPORT_MAX_SOURCE,
  IMPORT_PROMPT_FULL,
  findImportOverlaps,
  parseImport
} from './lib/import.mjs'
import { AUDIT_ACTORS, AUDIT_MAX_RECORDS, AUDIT_SOURCE_TEXT, summarizeAudit } from './lib/audit.mjs'

export const name = 'anima'

const LOG = '[dsh-anima]'

// 与 dsh-soul 的 `soul:persona`（order 0）错开，排在它之后、PLAN_POLICY(500) 之前。
const SECTION_IDENTITY = 'anima:identity'
const SECTION_MEMORY = 'anima:memory'
const SECTION_PENDING = 'anima:pending'
const ORDER_IDENTITY = 10
const ORDER_MEMORY = 20
const ORDER_PENDING = 21

const MAX_BODY_BYTES = 256 * 1024

const warn = (ctx, message) => {
  try {
    ctx?.logger?.warn?.(`${LOG} ${message}`)
  } catch { /* 日志失败不影响主流程 */ }
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
   * 与 dsh-soul 的 `pendingPersonaProposal` 同款设计：它只是「模型提了个请求，
   * 等用户点头」的暂存区，重启即失效 —— 一份没被确认的提议本就不该跨会话活着。
   */
  pendingProposal: null
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

/** 身份段：每轮装配期实时求值，因此工作区覆盖能立刻生效，无需重启会话。 */
function identityText(context) {
  // 装载失败时返回空串：宁可没有人设，也不注入一份默认档冒充用户配置。
  if (!runtime.loaded) return ''
  // 关掉插件时改为注入一句「已关闭」的声明 —— 见 compileDisabledNotice 的注释：
  // 会话历史里的旧设定不会自己消失，只有明说作废才能让模型停止沿用。
  if (!runtime.config.enabled) return compileDisabledNotice()
  const local = overridesForContext(context)
  const { effective } = mergePersona(runtime.config, local?.overrides ?? null)
  return compilePersona(effective)
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
  return compileMemory(injectionSelection(context).selected)
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
  return compilePendingNotice(runtime.pendingCount)
}

function registerSystemPrompt(ctx) {
  ctx.inject(['systemPrompt'], (spCtx) => {
    let dispose = []

    const register = () => {
      for (const d of dispose) {
        try { d() } catch { /* 已释放 */ }
      }
      // 先释放旧 section 再注册新的，触发 system-prompt/change，
      // 让 DSH 丢弃当前会话已缓存的 system prompt 快照（手法同 dsh-soul）。
      dispose = [
        spCtx.systemPrompt.section({ name: SECTION_IDENTITY, order: ORDER_IDENTITY, text: identityText }),
        spCtx.systemPrompt.section({ name: SECTION_MEMORY, order: ORDER_MEMORY, text: memoryText }),
        spCtx.systemPrompt.section({ name: SECTION_PENDING, order: ORDER_PENDING, text: pendingText })
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
  (key) => PROMPT_AFFECTING_FIELDS.has(key) || String(key).startsWith('memory.')
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
  // 读到了才置 true：三段 section 靠它判断「内存快照是否有效」，
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
async function runTriage(ctx, { reason = 'nightly' } = {}) {
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

  if (config.memory.notifyOnSessionStart) {
    await notifyAgents(ctx, summary, kept)
  }
  warn(ctx, `整理完成（${reason}）：待审 ${summary.pendingBefore} → ${summary.pendingAfter}，自动清理 ${toDiscard.length} 条`)
  return { ok: true, summary }
}

/**
 * 把一条系统级说明注入所有活动会话（一次性提示，不唤醒 Agent）。
 *
 * @param {string} text 注入正文
 * @param {string} label 失败日志里的用途标注
 * @returns {Promise<number>} 成功注入的会话数
 */
async function injectToAgents(ctx, text, label) {
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
    const now = new Date()
    const next = new Date(now)
    next.setHours(hour, 0, 0, 0)
    if (next <= now) next.setDate(next.getDate() + 1)
    const delay = Math.min(next.getTime() - now.getTime(), 6 * 60 * 60 * 1000)
    state.timer = setTimeout(async () => {
      try {
        if (runtime.config.memory.enabled && runtime.config.memory.nightlyTriage) {
          const last = await state.lastTriageDay()
          if (last !== dayKey()) await runTriage(ctx, { reason: 'nightly' })
        }
      } catch (err) {
        warn(ctx, `每晚整理失败：${String(err?.message || err)}`)
      } finally {
        arm()
      }
    }, delay)
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
          memory: compileMemory(injection.selected),
          pending: compilePendingNotice(runtime.pendingCount)
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
    // 与 dsh-checkpoint-rewind 的失败关闭（fail closed）语义一致：
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

    route('/api/anima/memory/triage', async (req, res) => {
      const result = await runTriage(ctx, { reason: 'manual' })
      send(res, result.ok ? 200 : 400, result)
    })

    route('/api/anima/memory/add', async (req, res) => {
      const parsed = await readJsonBody(req)
      const created = makeCandidate({
        text: parsed?.text,
        note: parsed?.note,
        source: 'manual',
        scope: typeof parsed?.scope === 'string' ? parsed.scope : undefined
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
  'maxInjected', 'maxInjectedChars', 'notifyOnSessionStart', 'defaultLayer'
])

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
  'memory.enabled', 'memory.autoCapture', 'memory.nightlyTriage', 'memory.notifyOnSessionStart'
])

/** 按整数解析的键。**范围不在这里判** —— 越界要报「必须是 0..23」，交给 sanitizeConfig。 */
const SET_NUMBER_KEYS = new Set(['memory.nightlyHour', 'memory.maxPending', 'memory.maxInjected', 'memory.maxInjectedChars'])

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
  return null
}

/** 按点路径取值，用于把「改成了什么」念回给用户（`memory.maxInjected` 取不到就直接下标）。 */
const readPath = (obj, key) => key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), obj)

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
      input: { hint: '[show|pending|adopt <id>|discard <id>|triage|name <名字>|set k=v …|enable|disable|confirm|reject|reset]' },
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
            const lines = [
              `灵台：${config.enabled ? '已启用' : '已关闭'}`,
              `AI 名字：${config.agentName || '（未设置）'}`,
              `AI 角色：${config.agentRole ? `${config.agentRole.slice(0, 60)}${config.agentRole.length > 60 ? '…' : ''}` : '（未设置）'}`,
              `工作区覆盖：${config.workspaceOverridesEnabled ? `已启用（目录 ${config.workspaceFileDir}）` : '已关闭'}`,
              `记忆层：${config.memory.enabled ? '已启用' : '已关闭'}；待审 ${runtime.pendingCount} 条，已采纳 ${runtime.adopted.length} 条`,
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

          if (verb === 'triage') {
            const result = await runTriage(ctx, { reason: 'command' })
            if (!result.ok) return { kind: 'error', text: result.error }
            const s = result.summary
            return {
              kind: 'success',
              text: `整理完成：待审 ${s.pendingBefore} → ${s.pendingAfter}，自动清理 ${s.discardedTotal} 条。`
            }
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

          return { kind: 'error', text: `未知子命令 ${verb}。可用：show|pending|adopt|discard|triage|name|set|enable|disable|confirm|reject|reset` }
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
          '不要在此写入任何密钥、令牌、密码；凭据会被直接拒绝。'
        ].join(''),
        parameters: {
          text: { type: 'string', description: '要记住的完整陈述句（不超过 500 字）' },
          note: { type: 'string', description: '可选：为什么值得记住，便于用户裁决' },
          scope: { type: 'string', description: '可选：该记忆的适用范围标注（如 global / 项目名）' }
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

      // ── 工具：改人设（对照 dsh-soul 的 set_persona） ──────────────────────────
      //
      // **名字刻意不叫 `set_persona`**：dsh-tools 的命名表遇重名直接抛
      //   `tool "${name}" is already registered (for a per-agent variant, register
      //    through that agent's \`agent.ctx\` instead)`
      // （dsh-tools\lib\index.js:2634 的 NamedEntries 冲突工厂），且注册顺序决定谁死。
      // dsh-soul 也用这个名字，两边共存时必有一方的工具凭空消失；对本机是过渡期的
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

  // 公开服务：供其它插件或脚本读取有效人设（dsh-soul 的 soulConfig 是同类做法）
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
        ? compileMemory(selectForInjection(runtime.adopted, config.memory.maxInjected, {
          maxInjectedChars: config.memory.maxInjectedChars,
          cwd: workspacePath ?? ''
        }).selected)
        : ''
      const pending = config.memory.enabled ? compilePendingNotice(runtime.pendingCount) : ''
      return [compilePersona(effective), memory, pending].filter(Boolean).join('\n\n')
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
    }
  })

  registerSystemPrompt(ctx)
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
  // 现在的做法（与 dsh-checkpoint-rewind 的「惰性解析」一致 + 本仓实证的就绪信号）：
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
        if (!config.memory.enabled || !config.memory.nightlyTriage) return
        const last = await state.lastTriageDay()
        if (last !== dayKey()) {
          await runTriage(ctx, { reason: 'catch-up' })
        }
      } catch (err) {
        warn(ctx, `启动补跑整理失败：${String(err?.message || err)}`)
      }
    })()
    return () => {
      cancelled = true
      scheduler.clear()
    }
  }, 'dsh-anima: catch-up triage')

  ctx.effect(() => () => {
    runtime.ctx = null
    runtime.store = null
    runtime.refresh = null
  }, 'dsh-anima: teardown')

  warn(ctx, `已装载（存储后端：${store.srcKind ?? `未打开，原因 ${store.srcReason ?? 'unknown'}`}）`)
}

export { runtime }
