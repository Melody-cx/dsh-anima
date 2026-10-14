// lib/store.mjs — 持久化层
//
// 落盘策略（对应拍板 ⑦「全局存 storage，工作区覆盖存工作区文件」）：
//   - 全局人设 + 记忆：@deepseek-ai/dsh-storage-domain（跟人不跟项目）；
//   - 工作区覆盖：工作区目录内的 .dsh-anima/override.json（跟项目走、可 git、
//     可拷给别人），由 lib/workspace.mjs 负责。
//
// 为什么没有「文件后端」兜底（2026-10-10 决定，与 dsh-checkpoint-rewind 的取舍一致）：
//   dsh-storage-domain 的服务是在它自己的 `ctx.inject(backendServices, …)` 回调里
//   `provide("storageDomain", …)` 的（storage-domain\lib\index.js:441-450），**异步就绪**。
//   本插件 apply 末尾那次 `reload()` 会立刻触发首次打开；若跑在它前面，一次性
//   `ctx.get()` 只拿到 undefined —— 表现为「重启后存储后端无故退化」。
//
//   先前自己造过一版「等就绪 + 超时 + 退化到文件」，2026-10-10 冷启动实测**仍然退化**
//   （连判据用的 `storage` hub 本身也是异步 provide，一并失效）。生态里的成熟做法只有
//   一条：**惰性解析 + 记忆化** —— 不在 apply 阶段解析服务，改为首次真正使用（路由 /
//   命令 / 提示词装配）时再解析，那时组合必然已完成。故本文件不再有文件后端：拿不到域
//   就抛结构化错误（StorageUnavailableError），由调用方决定怎么呈现（路由 503 / 命令
//   给组合指引），绝不静默改写用户数据的位置。
//
//   不再「退化到文件」还有一个更硬的理由：两个后端并存时，同一个人会先后命中两种后端，
//   早期写进文件后端的配置在域就绪后会被空的新域旁置 —— 表现为「我填的名字/称呼全没了」。
//   这不是用户的操作问题，是后端可切换本身带来的分叉。
//
// 参考（逐字）dsh-checkpoint-rewind\index.mjs:419-431：
//   「storageDomain 是可选服务：宿主未组合存储栈时插件照常挂载，绝不把 profile 卡在
//     pending —— checkpoint/rewind 路径按消费方各自处理拒绝……失败大声、优雅降级。」
//   「惰性解析 + 记忆化：……apply 时一次性 ctx.get() 会抢先取到 undefined 且永不重查
//     —— 注册表从此永久不可用（一切捕获静默失败）。首次使用时再解析：届时组合必然
//     已完成；storage 栈真缺失时首次使用即 reject 并给出组合指引。」

import { migrateConfig } from './config.mjs'
import { AUDIT_MAX_RECORDS, buildAuditChanges, makeAuditEntry, trimAudit } from './audit.mjs'

// 真实宿主的 storageDomain 会校验域名必须匹配 /^[a-z][a-z0-9_]*$/（连字符非法），
// 违规时 open() 抛 "domain name 'x' must match /^[a-z][a-z0-9_]*$/"。
// 假 store 的冒烟测试没有这层校验，曾漏掉此缺陷 —— 故此处固定用下划线形态。
const DOMAIN_NAME = 'anima'
// 域版本：只增不减的身份标识。
//
// 为什么现在又从 1 起算：v1/v2/v3 这三段沿革全部发生在插件**发布之前**，从外部看
// 没有「旧版本的用户」这回事。于是这里把格式戳重新从 1 起算，与 `package.json` 的
// semver（1.0.0）同步起步，省掉后人面对「插件装的是 1.0.0，介质却写着 v3」时的困惑。
//
// 前一段沿革（留档，勿再当成需要兼容的历史）：
//   v1：首版（config / memories / meta 三张表）。
//   v2：memories 新增 layer 字段；config.memory 新增 maxInjectedChars / defaultLayer。
//   v3：新增 audit 表（人设变更审计日志）。
//
// 相应地被删掉的是**兼容回退**：旧版按「主 spec → 兼容 spec」串行试开，因为
// @deepseek-ai/dsh-storage-json 的 single 布局在 parse() 里硬比对版本戳
// （storage-json\lib\index.js:102），且 `compatibleVersions` 只在 per-record 布局被读。
// 那条路径现在的唯一价值是「读别人机器上更早的介质」，而未发布意味着不存在这种介质。
//
// 若将来真要升格式：只改这个数字，并且**先想清楚老用户的介质怎么办** —— 那个决定
// 不该在发布之后临时补，因为补的时候介质已经在用户机器上了。范式可参考同生态的
// dsh-checkpoint-rewind（双 spec 串行回退）。
/** 当前域版本（介质格式戳）。只在模块内使用：外部看到的是 `/state` 下发的 `source.domainVersion`。 */
const DOMAIN_VERSION = 1
const CONFIG_KEY = 'main'

/**
 * 存储域不可用。区别于普通异常：带机器可读的 `code` 与 `statusCode = 503`，
 * 让路由层能直接把它翻成 HTTP 状态与 `source.reason`。
 *
 * 三种 code：
 *   - `storage-not-composed`  这份 profile 没组合存储栈（配置问题，不是故障）；
 *   - `vocabulary-unavailable` 域词汇表（dsh-storage-domain / zod）解析不了（安装问题）；
 *   - `open-failed`           域词汇表在，但 open() 被拒（介质损坏 / 版本不匹配 / 域名非法）。
 */
export class StorageUnavailableError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'StorageUnavailableError'
    this.code = code
    this.statusCode = 503
    if (options.cause !== undefined) this.cause = options.cause
  }
}

// ==================== storageDomain 后端 ====================

/**
 * 惰性打开存储域。返回 {kind:'storage', table(name), close()}，或抛
 * StorageUnavailableError。
 *
 * **只在真正要读写时才调用**（StateStore._open 的职责）。apply 阶段调用它，
 * 就是在赌 storage-domain 已经 provide —— 2026-10-10 那次退化赌输了。
 *
 * @param {any} ctx 插件 ctx
 * @param {{warn?: Function, info?: Function}} [logger]
 * @returns {Promise<{kind:string, table:(name:string)=>any, close:()=>Promise<void>}>}
 */
async function openStorageBackend(ctx, logger) {
  let storageDomain
  try {
    storageDomain = ctx.get?.('storageDomain')
  } catch {
    storageDomain = undefined
  }
  if (!storageDomain || typeof storageDomain.open !== 'function') {
    throw new StorageUnavailableError(
      'storage-not-composed',
      '这份 profile 没有组合存储栈，anima 无法读写人设与记忆。请加入三行：'
        + '@deepseek-ai/dsh-storage、@deepseek-ai/dsh-storage-json（config.root）、'
        + '@deepseek-ai/dsh-storage-domain（config.backend: json）。'
    )
  }

  let defineDomain, domainTable, z
  try {
    ({ defineDomain, domainTable } = await import('@deepseek-ai/dsh-storage-domain'))
    ;({ z } = await import('zod'))
  } catch (err) {
    throw new StorageUnavailableError(
      'vocabulary-unavailable',
      `存储域词汇表不可用（@deepseek-ai/dsh-storage-domain / zod 解析失败）：${String(err?.message || err)}`,
      { cause: err }
    )
  }

  // 注意：storageDomain 会逐条校验存量记录，schema 少一个字段就会让整条 config 记录
  // 被判 invalid-record 而拒绝打开整个域。故新增配置字段时必须同步这里。
  const configSchema = z.object({
    enabled: z.boolean().optional(),
    agentName: z.string().optional(),
    agentRole: z.string().optional(),
    addressUserAs: z.string().optional(),
    userOccupation: z.string().optional(),
    userBio: z.string().optional(),
    style: z.string().optional(),
    headingLists: z.string().optional(),
    emoji: z.string().optional(),
    tables: z.string().optional(),
    replyLength: z.string().optional(),
    language: z.string().optional(),
    customInstructions: z.string().optional(),
    // 工具确认门槛 + 光轨四项（对照 dsh-soul）。schema 必须与 DEFAULT_CONFIG 同步，
    // 少一个字段 = 存量记录被判 invalid-record = 整个域打不开（见上方注释）。
    requireToolConfirmation: z.boolean().optional(),
    trailEnabled: z.boolean().optional(),
    trailColor: z.string().optional(),
    trailSpeed: z.string().optional(),
    trailWidth: z.string().optional(),
    presets: z.array(z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      custom: z.boolean().optional(),
      createdAt: z.string().optional(),
      fields: z.record(z.string(), z.string())
    })).optional(),
    workspaceOverridesEnabled: z.boolean().optional(),
    workspaceFileDir: z.string().optional(),
    memory: z.object({
      enabled: z.boolean().optional(),
      autoCapture: z.boolean().optional(),
      nightlyTriage: z.boolean().optional(),
      nightlyHour: z.number().optional(),
      maxPending: z.number().optional(),
      maxInjected: z.number().optional(),
      maxInjectedChars: z.number().optional(),
      notifyOnSessionStart: z.boolean().optional(),
      defaultLayer: z.enum(['global', 'workspace']).optional()
    }).optional()
  })

  const memorySchema = z.object({
    id: z.string(),
    text: z.string(),
    digest: z.string().optional(),
    status: z.enum(['pending', 'adopted', 'discarded']),
    // 层级：global 处处生效，workspace 只在 cwd 匹配时注入。
    layer: z.enum(['global', 'workspace']).optional(),
    scope: z.string().optional(),
    source: z.string().optional(),
    note: z.string().optional(),
    capturedAt: z.string(),
    decidedAt: z.string().optional(),
    sessionId: z.string().optional(),
    cwd: z.string().optional()
  })

  const metaSchema = z.object({
    lastTriageDay: z.string().optional(),
    lastTriageAt: z.string().optional(),
    lastTriageSummary: z.object({
      ranAt: z.string().optional(),
      pendingBefore: z.number().optional(),
      pendingAfter: z.number().optional(),
      duplicatesRemoved: z.number().optional(),
      overflowRemoved: z.number().optional(),
      discardedTotal: z.number().optional(),
      adoptedTotal: z.number().optional()
    }).optional()
  })

  // 人设变更审计日志。独立成表而不是塞进 config：
  // config 是每次启动都要整条读入内存的记录，审计日志会随时间增长到几百条，
  // 混在一起等于让启动开销随使用时长上升。
  const auditSchema = z.object({
    id: z.string(),
    at: z.string(),
    actor: z.enum(['user', 'agent', 'system']),
    source: z.string(),
    note: z.string().optional(),
    sessionId: z.string().optional(),
    changes: z.array(z.object({
      key: z.string(),
      from: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
      to: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional()
    }))
  })

  try {
    // spec 的构造也要放进 try：defineDomain 自身会做域名/表名校验，
    // 放在 try 外会让一次词汇表拒绝直接冒泡成 500 而不是带 code 的 503。
    const tableSpecs = {
      config: domainTable(configSchema),
      memories: domainTable(memorySchema),
      meta: domainTable(metaSchema),
      audit: domainTable(auditSchema)
    }

    // 单一 spec 打开。曾经这里有一段「主 spec → 兼容 spec」的串行回退，用来读旧版
    // 介质；未发布 ⇒ 不存在那种介质，回退已删（理由见 DOMAIN_VERSION 处注释）。
    const domain = await storageDomain.open(defineDomain({
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      tables: tableSpecs
    }))

    ctx.effect(() => () => { void domain.close() }, 'dsh-anima.domain.close')
    const backend = {
      kind: 'storage',
      // 域打开时的版本戳。它恒等于 DOMAIN_VERSION（已无兼容回退），保留这个字段是
      // 为了让 /state 下发给设置页与 check-live —— 没有它，界面上就只剩一个「存储位置」，
      // 用户无法判断插件到底往哪份介质里读写。
      domainVersion: DOMAIN_VERSION,
      table: (name) => domain.table(name),
      close: () => domain.close()
    }
    // 到这里域已打开、四张表就绪。曾经这里接着跑三条一次性迁移（改名前的旧域搬迁、
    // 更早的文件后端导入、从另一个插件继承「工具改人设需确认」）；插件未发布 ⇒
    // 不存在需要兼容的旧介质或旧文件，三条连同它们的常量一并删除。
    // 若将来真要迁移：只在新域 config 记录不存在时动手，且自己的任何失败都只能记
    // warn —— 这段代码在下面的 try 块里，外抛会被包成新域的 open-failed，
    // 让一个本该正常的插件停摆。
    return backend
  } catch (err) {
    if (err instanceof StorageUnavailableError) throw err
    throw new StorageUnavailableError(
      'open-failed',
      `opening the ${DOMAIN_NAME} storage domain failed: ${String(err?.message || err)}`,
      { cause: err }
    )
  }
}

// ==================== 统一门面 ====================

/**
 * StateStore：全局配置与记忆的唯一入口。
 *
 * 后端在**首次真正调用**时才打开（惰性），失败**不记忆化** —— storageDomain
 * 可能在本插件之后才 provide，一次失败就永久固守等于让插件再无恢复机会
 * （这正是 2026-10-10 冷启动退化的固化机制，必须去掉）。
 */
export class StateStore {
  constructor(ctx, logger) {
    this.ctx = ctx
    this.logger = logger
    this._backendPromise = null
    this._backend = null
    this._error = null
    this._listeners = new Set()
  }

  get srcKind() {
    return this._backend?.kind ?? null
  }

  get srcPath() {
    return this._backend?.path ?? null
  }

  /**
   * 域打开时使用的版本戳（可用时为 null）。
   *
   * 已无兼容模式：它现在恒等于 DOMAIN_VERSION。保留这个字段是因为设置页与
   * check-live 都靠它确认「插件真的把域打开了」——介质版本高于当前版本时
   * （用户装回旧插件、介质是新插件写的）open 会失败，此时这里是 null。
   */
  get srcDomainVersion() {
    return this._backend?.domainVersion ?? null
  }

  /**
   * 当前不可用的机器可读原因（可用时为 null）。
   * 暴露给 /state 与 check-live —— 2026-10-10 那次无声退化，就是因为配置里
   * 只有一个 kind:'file' 可看，没有任何线索指向「哪一步没就绪」。
   */
  get srcReason() {
    return this._error?.code ?? null
  }

  /** 不可用时的完整说明（给人看；可用时为 null）。 */
  get srcMessage() {
    return this._error?.message ?? null
  }

  async _open() {
    if (this._backend) return this._backend
    let promise = this._backendPromise
    if (!promise) {
      promise = (async () => {
        const backend = await openStorageBackend(this.ctx, this.logger)
        this._backend = backend
        this._error = null
        return backend
      })()
      this._backendPromise = promise
      // 失败不固化：清掉缓存，下一次调用重新尝试解析 storageDomain。
      // 这个 catch 同时消费掉 rejection，避免 Node 报 unhandled rejection。
      promise.catch(() => {
        if (this._backendPromise === promise) this._backendPromise = null
      })
    }
    try {
      return await promise
    } catch (err) {
      const wrapped = err instanceof StorageUnavailableError
        ? err
        : new StorageUnavailableError('open-failed', String(err?.message || err), { cause: err })
      this._error = wrapped
      throw wrapped
    }
  }

  /** 存储是否已就绪（供 index.mjs 决定提示词注入与否）。 */
  get ready() {
    return this._backend !== null
  }

  /** 订阅变更（写成功后被调用，用于触发提示词刷新）。 */
  onChanged(listener) {
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }

  /**
   * 取得裸表（meta 等边角数据用）。
   * 注意：这是异步的 —— 首次调用会真正打开后端，可能抛 StorageUnavailableError。
   */
  async table(name) {
    const backend = await this._open()
    return backend.table(name)
  }

  _emit() {
    for (const listener of this._listeners) {
      try { listener() } catch { /* 监听者异常不影响写入方 */ }
    }
  }

  // ---- 配置 ----

  /** 读取全局配置（已迁移归一）。存储不可用时抛 StorageUnavailableError。 */
  async getConfig() {
    const backend = await this._open()
    const table = backend.table('config')
    const raw = await table.get(CONFIG_KEY)
    return migrateConfig(raw)
  }

  /**
   * 合并写入全局配置。
   *
   * @param {object} patch 已通过 sanitizeConfig 的补丁
   * @param {object} [attribution] {actor, source, note, sessionId} —— 谁改的、从哪改的。
   *   审计日志挂在**这一个**收口上，是因为所有写入路径（设置页 / 命令 / 模型工具 /
   *   预设 / 提议确认）最终都走这里；在各自的调用点写日志，迟早会漏掉一条路径，
   *   而漏掉的那条恰恰可能是模型的静默改写。
   * @returns {{config: object, changed: string[]}}
   */
  async updateConfig(patch, attribution = {}) {
    const backend = await this._open()
    const table = backend.table('config')
    const current = migrateConfig(await table.get(CONFIG_KEY))
    const next = migrateConfig({ ...current, ...patch, memory: { ...current.memory, ...(patch.memory ?? {}) } })
    const changed = diffConfig(current, next)
    if (changed.length === 0) return { config: current, changed }
    await table.put(CONFIG_KEY, next)
    await this._appendAudit(current, next, changed, attribution)
    this._emit()
    return { config: next, changed }
  }

  /**
   * 写一条审计记录（内部用）。
   * 审计失败**不得**影响配置写入本身：配置已经落盘了，此时抛错会让调用方
   * 以为「没改成」而重试，反而制造混乱。失败只记一条 warn。
   */
  async _appendAudit(before, after, changedKeys, attribution = {}) {
    try {
      const entry = makeAuditEntry({
        changes: buildAuditChanges(before, after, changedKeys),
        actor: attribution.actor,
        source: attribution.source,
        note: attribution.note,
        sessionId: attribution.sessionId
      })
      if (!entry) return null
      await this.appendAudit(entry)
      return entry
    } catch (err) {
      this.logger?.warn?.(`[anima] 审计日志写入失败（配置已保存）：${String(err?.message || err)}`)
      return null
    }
  }

  // ---- 审计日志 ----

  /** 读取全部审计记录，按时间升序。 */
  async listAudit() {
    const backend = await this._open()
    const table = backend.table('audit')
    const out = []
    for (const [, value] of table.entries()) out.push(value)
    return out.sort((a, b) => String(a?.at ?? '').localeCompare(String(b?.at ?? '')))
  }

  /** 追加一条审计记录，并在超限时环形淘汰最早的记录。 */
  async appendAudit(entry) {
    const backend = await this._open()
    const table = backend.table('audit')
    await table.put(entry.id, entry)
    // 环形淘汰：审计日志无界增长最终会拖垮存储与 /state 响应。
    // 淘汰放在写入之后而不是每次先查总数 —— 多一次遍历换一个简单的不变量。
    const all = []
    for (const [key] of table.entries()) all.push(key)
    if (all.length > AUDIT_MAX_RECORDS) {
      const records = await this.listAudit()
      const { kept, dropped } = trimAudit(records, AUDIT_MAX_RECORDS)
      if (dropped > 0) {
        const keepIds = new Set(kept.map((r) => r.id))
        for (const key of all) {
          if (!keepIds.has(key)) await table.delete(key)
        }
      }
    }
    return entry
  }

  /** 清空审计日志；返回删除条数。 */
  async clearAudit() {
    const backend = await this._open()
    const table = backend.table('audit')
    const keys = []
    for (const [key] of table.entries()) keys.push(key)
    let removed = 0
    for (const key of keys) {
      if (await table.delete(key)) removed += 1
    }
    return removed
  }

  /**
   * 重置为默认配置，但保留用户自建的人设预设。
   *
   * 行为与 dsh-soul 的 `defaultConfigPreservingPersonas(current)` 对齐：
   * 预设是用户一条条攒出来的资产，重置语气设置不该连它一起清掉。
   * （本插件最初漏了这一步，2026-10-10 的事故才暴露出来。）
   */
  async resetConfig(attribution = {}) {
    const backend = await this._open()
    const table = backend.table('config')
    const current = migrateConfig(await table.get(CONFIG_KEY))
    const next = migrateConfig({ presets: current.presets ?? [] })
    await table.put(CONFIG_KEY, next)
    // 重置也要留痕：否则「昨天还好好的，今天全空了」在日志里查无此事，
    // 而这恰恰是最需要回头确认的一次变更。
    const changed = diffConfig(current, next)
    await this._appendAudit(current, next, changed, { source: 'reset', ...attribution })
    this._emit()
    // 把变更清单一起交出去：调用方要靠它决定「要不要向活动会话声明旧设定作废」，
    // 重置又是最该声明的一次（三个字段一起没了，对话历史里却还留着）。
    return { config: next, changed }
  }

  // ---- 人设预设 ----

  /**
   * 读取用户自建预设（内置预设不落盘，由 lib/presets.mjs 提供）。
   * @returns {Promise<Array<object>>}
   */
  async listCustomPresets() {
    const config = await this.getConfig()
    return Array.isArray(config.presets) ? config.presets : []
  }

  /**
   * 整表替换自建预设。
   * 用「整表替换」而非逐条增删：预设之间只有几十字节，整表写入天然原子，
   * 不必为并发删除/改名维护一套索引一致性。
   */
  async putCustomPresets(presets) {
    return this.updateConfig({ presets: Array.isArray(presets) ? presets : [] })
  }

  // ---- 记忆 ----

  /** 读取全部记忆记录（含 pending/adopted/discarded）。 */
  async listMemories() {
    const backend = await this._open()
    const table = backend.table('memories')
    const out = []
    for (const [, value] of table.entries()) out.push(value)
    return out
  }

  async getMemory(id) {
    const backend = await this._open()
    return backend.table('memories').get(id)
  }

  async putMemory(record) {
    const backend = await this._open()
    await backend.table('memories').put(record.id, record)
    this._emit()
    return record
  }

  async deleteMemory(id) {
    const backend = await this._open()
    const ok = await backend.table('memories').delete(id)
    if (ok) this._emit()
    return ok
  }

  /** 批量删除（用于缓冲区淘汰）。 */
  async deleteMemories(ids) {
    let removed = 0
    for (const id of ids) {
      if (await this.deleteMemory(id)) removed += 1
    }
    return removed
  }
}

/** 逐字段比较，返回发生变化的字段名（memory 记为 memory.<key>）。 */
export function diffConfig(a, b) {
  const changed = []
  for (const key of [
    'enabled', 'agentName', 'agentRole', 'addressUserAs',
    'userOccupation', 'userBio',
    'style', 'headingLists', 'emoji', 'tables', 'replyLength', 'language',
    'customInstructions',
    // 工具确认门槛与光轨四项：不参与提示词，但必须计入 diff ——
    // 否则设置页改了光轨颜色、宿主这边判「无变化」不落盘，用户会以为开关失灵。
    'requireToolConfirmation', 'trailEnabled', 'trailColor', 'trailSpeed', 'trailWidth',
    'workspaceOverridesEnabled', 'workspaceFileDir'
  ]) {
    if (a?.[key] !== b?.[key]) changed.push(key)
  }
  // 预设是数组，逐条比较代价高且无必要：只要首尾/长度变了就当变更，
  // 提示词重注册是幂等的，多刷一次没有副作用。
  if (JSON.stringify(a?.presets ?? []) !== JSON.stringify(b?.presets ?? [])) changed.push('presets')
  for (const key of Object.keys(b?.memory ?? {})) {
    if (a?.memory?.[key] !== b?.memory?.[key]) changed.push(`memory.${key}`)
  }
  return changed
}
