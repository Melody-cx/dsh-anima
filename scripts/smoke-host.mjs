// scripts/smoke-host.mjs — 宿主侧冒烟测试
//
// 用一个假的 ctx 真正 import 本插件的 index.mjs，验证：
//   1. apply() 能跑完不抛错
//   2. 三段 systemPrompt section 注册成功、名字与 order 正确
//   3. HTTP 路由注册齐全
//   4. /api/anima/state 能返回合法负载
//   5. 配置写入 → 身份段文本随之变化（端到端最短闭环）
//   6. 记忆候选 → 采纳 → 出现在记忆段
//
// 运行：node scripts/smoke-host.mjs
// 退出码：0 全通过；1 有失败。

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register } from 'node:module'
import assert from 'node:assert/strict'

// 把 @deepseek-ai/dsh-tools 解析到本地替身（真实包依赖宿主内建模块，跑不起来）。
register('./tools-loader.mjs', import.meta.url)

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push([name, err])
    console.log(`  FAIL ${name}\n       ${err?.message || err}`)
  }
}

// ==================== 假 ctx ====================

// 假 storageDomain：真实包由宿主体内解析，这里用内存表复刻本插件用到的那部分语义
// （open → 四张表 → get/put/delete/entries/size + close + 版本戳校验）。
// 关键点：**它是同步就位的**，故意不复刻「dsh-storage-domain 异步 provide」那一段 ——
// 那一段由 index.mjs 的 ctx.inject 就绪重试覆盖，见 `存储栈未组合` 那组用例。
// 唯一额外复刻的失败路径是 version-mismatch：它决定了「旧介质升级后还能不能打开」，
// 而这条路径恰恰是真实后端**唯一**会抛的、本插件必须处理的错误码。
/** 域介质里可搬运的形态：{ 表名: [[key, value], …] }。用来模拟「进程重启后介质上的数据」。 */
function snapshotDomain(facility, domainName) {
  const handle = facility.get(domainName)
  if (!handle) throw new Error(`domain '${domainName}' is not open`)
  const seed = {}
  for (const table of handle.tableNames) seed[table] = [...handle.table(table).entries()]
  return seed
}

/** 某个已打开域的版本戳（假域把 spec.version 记在域句柄上，仿真机介质的 unit.version）。 */
function domainVersionOf(ctx, domainName = 'anima') {
  return ctx.get('storageDomain').get(domainName).version
}

/**
 * 假 storageDomain。
 * @param {object|null} seed 域里已有的表内容（模拟「进程重启后介质上的数据」）
 * @param {number|null} mediumVersion 介质上的版本戳；null = 全新介质（接受任何 spec 版本）。
 *   给一个具体数字就能复刻「旧版插件写的介质 + 新版插件」这条升级路径。
 */
function makeStorageDomain(seed = null, mediumVersion = null) {
  const domains = new Map()
  return {
    async open(spec) {
      if (domains.has(spec.name)) throw new Error(`domain '${spec.name}' is already open`)
      // 版本戳校验。真实后端（@deepseek-ai/dsh-storage-json 的 single 布局）在 parse() 里
      // 硬比对版本戳并抛 version-mismatch，且没有任何迁移钩子 —— 本假域必须复刻这条，
      // 否则「旧介质 + 新插件」这条最危险的升级路径在冒烟测试里完全没有覆盖。
      if (mediumVersion !== null && spec.version !== mediumVersion) {
        const err = new Error(`unit '${spec.name}': stored version ${mediumVersion} != expected ${spec.version}`)
        err.code = 'version-mismatch'
        throw err
      }
      const tables = new Map()
      const schemas = new Map()
      for (const name of Object.keys(spec.tables)) {
        tables.set(name, new Map(seed?.[name] ?? []))
        schemas.set(name, spec.tables[name]?.valueSchema)
      }
      domains.set(spec.name, { version: spec.version, tables })
      return {
        name: spec.name,
        version: spec.version,
        table(name) {
          const store = tables.get(name)
          const schema = schemas.get(name)
          if (!store) throw new Error(`domain '${spec.name}' has no table '${name}'`)
          return {
            // 读回时过一遍 schema —— 真实后端就是这么做的。不这么做的话，
            // 「schema 少声明一个键 ⇒ 数据读回被 zod 静默剥空」这类 bug 在这套
            // 冒烟测试里完全不可见：写入照落盘，读出来的却是 stripped 版本，
            // 而假域原样返回，测试全绿。2026-10-24 的 metaSchema bug 就是靠
            // verify-core 里那个单独的 makeValidatingDomain 才抓到的。
            get: (key) => {
              const raw = store.get(key)
              if (raw === undefined) return undefined
              return schema ? schema.parse(raw) : raw
            },
            put: async (key, value) => { store.set(key, value) },
            delete: async (key) => store.delete(key),
            entries: () => store.entries(),
            keys: () => store.keys(),
            get size() { return store.size }
          }
        },
        async close() { domains.delete(spec.name) }
      }
    },
    /** 复刻真实 facility 的 get(name)：已打开的域句柄（未打开为 undefined）。 */
    get(name) {
      const record = domains.get(name)
      if (!record) return undefined
      const tables = record.tables
      return {
        name,
        // 域实际打开的版本戳 —— StateStore.srcDomainVersion 读的是这个。
        version: record.version,
        tableNames: [...tables.keys()],
        table(tableName) {
          const store = tables.get(tableName)
          if (!store) throw new Error(`domain '${name}' has no table '${tableName}'`)
          return {
            get: (key) => store.get(key),
            entries: () => store.entries(),
            get size() { return store.size }
          }
        }
      }
    },
    /** 仅供断言：域是否处于打开态。 */
    isOpen: (name) => domains.has(name)
  }
}

function makeCtx(home, { withStorage = true } = {}) {
  const sections = new Map()
  const routes = new Map()
  const commands = []
  const tools = []
  const disposers = []
  const provided = new Map()
  const warnings = []
  const pendingInjects = []
  // 事件处理器登记表：`on(name, handler, opts)` 收进来，测试里手动派发。
  // 之前这里是 `on: () => () => {}`（什么都不记），后果是「注册了钩子」这件事
  // 永远测不到 —— 钩子写错名字、或压根没注册，冒烟照样全绿。
  const handlers = new Map()

  // 假 Agent 列表：`agents.list()` 返回它们，`.inject(message)` 把消息收进 inbox。
  // 「配置变更后向活动会话说明旧设定作废」这条链路要靠它才测得到。
  const agents = []
  const makeAgent = (label) => ({
    label,
    inbox: [],
    inject(message) { this.inbox.push(message) }
  })

  const services = {
    ...(withStorage ? { storageDomain: makeStorageDomain() } : {}),
    agents: {
      list: () => agents.slice()
    },
    systemPrompt: {
      getSectionOrder: () => 0,
      getContextOrder: () => 0,
      section(section) {
        if (sections.has(section.name)) {
          throw new Error(`prompt section "${section.name}" is already registered`)
        }
        sections.set(section.name, section)
        return () => sections.delete(section.name)
      },
      variable: () => () => {},
      context: () => () => {},
      suppressRuntimeContext: () => () => {},
      tools: () => () => {}
    },
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`route ${route.path} already registered`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      }
    },
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {}
      }
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      }
    }
  }

  /** 真实 cordis 会把注入的服务挂成 ctx 的属性（插件里写 spCtx.systemPrompt），
   *  这里用一个带属性的浅包装模拟这一行为。 */
  const scopeWith = (deps) => {
    const scoped = Object.create(ctx)
    for (const dep of deps) scoped[dep] = services[dep]
    return scoped
  }

  const ctx = {
    logger: {
      warn: (message) => warnings.push(String(message)),
      info: () => {},
      error: (message) => warnings.push(String(message))
    },
    get: (name) => services[name],
    provide: (name, value) => {
      provided.set(name, value)
      return () => provided.delete(name)
    },
    effect: (factory, label) => {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push({ label, dispose })
      return () => {}
    },
    inject: (deps, callback) => {
      // 忠实复刻真实 cordis 的 inject 语义（本仓用 cordis-dist 探针实证过两次）：
      //   - 依赖齐备 ⇒ 立刻触发回调；
      //   - 缺依赖   ⇒ 不抛错，挂成待触发，等 _provide 把服务补进来时再触发。
      // 这一条正是「storageDomain 异步 provide」的就绪信号里被测的那部分。
      const missing = deps.filter((dep) => !services[dep])
      if (missing.length === 0) {
        callback(scopeWith(deps))
        return { dispose: () => {} }
      }
      const pending = { deps, callback, disposed: false }
      pendingInjects.push(pending)
      return { dispose: () => { pending.disposed = true } }
    },
    /** 让某个服务「晚一点」出现：补进 services 并触发等在它上面的 inject 回调。 */
    _provide: (name, value) => {
      services[name] = value
      for (const pending of pendingInjects.splice(0)) {
        if (pending.disposed) continue
        if (pending.deps.every((dep) => services[dep])) pending.callback(scopeWith(pending.deps))
        else pendingInjects.push(pending)
      }
    },
    _services: services,
    _pendingInjects: pendingInjects,
    on: (eventName, handler) => {
      if (!handlers.has(eventName)) handlers.set(eventName, [])
      handlers.get(eventName).push(handler)
      return () => {
        const list = handlers.get(eventName) ?? []
        const at = list.indexOf(handler)
        if (at >= 0) list.splice(at, 1)
      }
    },
    /** 测试用：按事件名派发一次 waterfall，语义与 cordis 一致（回调收到 next）。 */
    _emitWaterfall: async (eventName, payload, terminal) => {
      const list = [...(handlers.get(eventName) ?? [])]
      let index = -1
      const run = async () => {
        index += 1
        if (index >= list.length) return terminal()
        return list[index](payload, run)
      }
      return run()
    },
    _handlerCount: (eventName) => (handlers.get(eventName) ?? []).length,
    _agents: agents,
    _makeAgent: makeAgent,
    _sections: sections,
    _routes: routes,
    _commands: commands,
    _tools: tools,
    _provided: provided,
    _warnings: warnings,
    _dispose: async () => {
      for (const { dispose } of disposers.reverse()) {
        try { await dispose() } catch { /* 忽略 */ }
      }
    }
  }
  return ctx
}

/** 造一个假的 req/res，驱动路由 handler。
 *  默认模拟「本机同源的设置页请求」——插件路由带同源+回环守卫，
 *  假请求也必须给出 socket.remoteAddress 与一致的 Origin/Host，否则会被 403 挡下。 */
async function callRoute(route, { method = 'GET', url, body, remoteAddress = '127.0.0.1', origin = 'http://127.0.0.1:19387', host = '127.0.0.1:19387' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const headers = {}
  if (origin !== undefined) headers.origin = origin
  if (host !== undefined) headers.host = host
  const req = {
    method,
    url: url ?? route.path,
    headers,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    }
  }
  let status = 0
  let payload = null
  const res = {
    writeHead(code) { status = code },
    end(text) { try { payload = JSON.parse(text) } catch { payload = text } }
  }
  await route.handler(req, res)
  return { status, payload }
}

// ==================== 主流程 ====================

const home = await mkdtemp(join(tmpdir(), 'anima-home-'))
process.env.DSH_HOME = home

console.log(`DSH_HOME=${home}`)

const plugin = await import('../index.mjs')
const ctx = makeCtx(home)

console.log('\n[装载]')

await test('apply() 跑完不抛错', async () => {
  await plugin.apply(ctx)
})

await test('三段 systemPrompt section 均注册，名字与 order 正确', () => {
  const identity = ctx._sections.get('anima:identity')
  const memory = ctx._sections.get('anima:memory')
  const pending = ctx._sections.get('anima:pending')
  assert.ok(identity, '身份段缺失')
  assert.ok(memory, '记忆段缺失')
  assert.ok(pending, '待审段缺失')
  assert.equal(identity.order, 10)
  assert.equal(memory.order, 20)
  assert.equal(pending.order, 21)
  assert.equal(typeof identity.text, 'function', 'section.text 应为函数（动态求值）')
})

// ---- 质检层：pre-step 机制检查 ----
//
// 这一组的价值在于「检查者不是模型」：假 ctx 手动派发 agent/pre-step，
// 插件必须自己从 session.snapshotEvents() 里找上一条 assistant 回答并判定。
// 如果只用提示词而不测这里，钩子写错事件名、或压根没注册，冒烟测试仍然全绿。

await test('agent/pre-step 钩子已注册（不是只写在提示词里）', () => {
  assert.equal(ctx._handlerCount('agent/pre-step'), 1, '未注册 pre-step 钩子，机制检查等于不存在')
})

await test('质检段排在待审段之后、PLAN_POLICY(500) 之前', () => {
  const quality = ctx._sections.get('anima:quality')
  assert.ok(quality, '质检段缺失')
  assert.equal(quality.order, 30)
  assert.ok(quality.order > ctx._sections.get('anima:pending').order)
  assert.ok(quality.order < 500)
  const text = quality.text({})
  assert.match(text, /十二条/, '质检段应列出十二条判据')
  assert.match(text, /对账/, '质检段应含对账规则')
  assert.match(text, /不是你自己/, '质检段必须说明检查由代码做，不是模型自评')
})

/** 造一个带 session 的假 agent：snapshotEvents() 返回给定事件列表。 */
function agentWith(events) {
  return { session: { snapshotEvents: () => events } }
}

const assistantEvent = (text, seq = 7) => ({
  type: 'assistant/message',
  seq,
  // 真实形状（实测自 <DSH_HOME>\sessions\<会话>\session.v4.jsonl.zstd）：
  // data = { turn, step, message:{role,content,source,id}, usage, stream }
  // 夹具必须照抄现实而不是照抄实现，否则实现读错了字段，测试跟着一起错还全绿。
  data: {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'assistant' }, id: `msg-${seq}` }
  }
})

const enterDecision = (messages = []) => () => Promise.resolve({ kind: 'enter', messages })

await test('上一轮回答里有未对账的断言 → 下一步追加一条提醒', async () => {
  const agent = agentWith([assistantEvent('据官方文档可知，这个接口限流是每分钟 60 次。')])
  const decision = await ctx._emitWaterfall(
    'agent/pre-step',
    { agent, step: 1, turn: 1 },
    enterDecision([{ role: 'user', content: [{ type: 'text', text: '你好' }] }])
  )
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2, '应在原有消息后追加一条提醒')
  const injected = decision.messages[1]
  assert.equal(injected.source.kind, 'plugin:dsh-anima', '注入消息必须自持 producer kind')
  assert.equal(injected.source.form, 'snapshot', '不能伪装成用户发言')
  assert.match(injected.content[0].text, /R02|R01/, '提醒里应点名机器判到的规则')
  assert.match(injected.content[0].text, /这次没查/, '提醒必须如实列出没查的规则')
})

await test('回答干净时不注入任何消息（不夸奖、不刷存在感）', async () => {
  const agent = agentWith([assistantEvent('这个函数在 lib/store.mjs:59 定义，只有一行赋值。')])
  const decision = await ctx._emitWaterfall(
    'agent/pre-step',
    { agent, step: 1, turn: 1 },
    enterDecision([{ role: 'user', content: [{ type: 'text', text: '在哪' }] }])
  )
  assert.equal(decision.messages.length, 1, '干净的回答不该被追加任何提醒')
})

await test('同一条回答不重复提醒两次（否则会把下一轮挤满）', async () => {
  const event = assistantEvent('我会持续关注这个问题的后续变化。', 99)
  const agent = agentWith([event])
  const first = await ctx._emitWaterfall('agent/pre-step', { agent, step: 1, turn: 1 }, enterDecision([]))
  assert.equal(first.messages.length, 1)
  const second = await ctx._emitWaterfall('agent/pre-step', { agent, step: 1, turn: 2 }, enterDecision([]))
  assert.equal(second.messages.length, 0, '同一条回答被检查过就不该再提醒')
})

await test('链路 reject 时原样透传，不再追加消息', async () => {
  const agent = agentWith([assistantEvent('据文档说，这个值等于 3。')])
  const decision = await ctx._emitWaterfall(
    'agent/pre-step',
    { agent, step: 1, turn: 1 },
    () => Promise.resolve({ kind: 'reject' })
  )
  assert.equal(decision.kind, 'reject')
  assert.equal(decision.messages, undefined)
})

await test('session 没有 snapshotEvents（旧宿主/非 agent 场景）时安静跳过', async () => {
  const decision = await ctx._emitWaterfall(
    'agent/pre-step',
    { agent: { session: {} }, step: 1, turn: 1 },
    enterDecision([])
  )
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 0)
})

await test('同一轮内提醒次数到顶就停（防止机制把自己拉成死循环）', async () => {
  // 每一句都命中，但每句的 seq 不同 —— 单看「同一条不重复」抓不住自激，
  // 因为自激正是「不断产生新的不合格回答」。这条用例守的是配额闸门。
  const sessionsTexts = [
    '据官方文档可知，这个接口限流是每分钟 60 次。',
    '据官方文档可知，这个值等于 3。',
    '据官方文档可知，这个值等于 4。',
    '据官方文档可知，这个值等于 5。'
  ]
  const sess = { snapshotEvents: () => [] }
  const agent = { session: sess }
  const injected = []
  for (let i = 0; i < sessionsTexts.length; i += 1) {
    sess.snapshotEvents = () => [assistantEvent(sessionsTexts[i], 100 + i)]
    const d = await ctx._emitWaterfall('agent/pre-step', { agent, step: 1, turn: 7 }, enterDecision([]))
    injected.push(d.messages.length)
  }
  assert.deepEqual(injected, [1, 1, 0, 0], `同一轮最多提醒 2 次，实际 ${JSON.stringify(injected)}`)

  // 关键区分：被闸门挡掉的第三、第四句**也必须被检查过**。
  // 早期版本把额度判断放在检查之前，那两句压根没进 checkResponse，
  // 于是「这轮有几条该提醒而没提醒」永远没有答案 —— 那正是「没查」长得像「查过没事」。
  const stats = (await callRoute(ctx._routes.get('/api/anima/state'))).payload.qualityStats
  assert.equal(typeof stats.suppressed, 'number', 'state 里必须下发 suppressed')
  assert.ok(stats.suppressed >= 2, `被闸门压住的次数要单独计数，实际 ${stats.suppressed}`)
  assert.ok((stats.skipped['turn-budget'] ?? 0) >= 2, '按原因分类里也要能看到「额度用完」')

  // 换轮要回满：否则第二条轮次就再也收不到提醒，等于静默失效
  sess.snapshotEvents = () => [assistantEvent('据官方文档可知，这个值等于 6。', 200)]
  const nextTurn = await ctx._emitWaterfall('agent/pre-step', { agent, step: 1, turn: 8 }, enterDecision([]))
  assert.equal(nextTurn.messages.length, 1, '换轮必须重新给配额')
})

await test('section 名未与同生态插件的 section 名冲突', () => {
  assert.equal(ctx._sections.has('soul:persona'), false)
})

await test('运行计数能把「查了没事」和「压根没跑」分开（这是不许谎报检查的落地）', async () => {
  const before = (await callRoute(ctx._routes.get('/api/anima/state'))).payload.qualityStats
  assert.equal(typeof before.checks, 'number', 'state 里必须下发 checks')

  const agent = agentWith([assistantEvent('据官方文档可知，这个值等于 9。', 301)])
  await ctx._emitWaterfall('agent/pre-step', { agent, step: 1, turn: 3 }, enterDecision([]))

  const after = (await callRoute(ctx._routes.get('/api/anima/state'))).payload
  assert.equal(after.qualityStats.checks, before.checks + 1, '真正跑过一次判定的次数必须 +1')
  assert.ok(after.qualityStats.last, '最近一次判定摘要必须留下痕迹')
  assert.equal(after.qualityStats.last.seq, 301, '痕迹必须指向被检查的那一条事件')
  assert.ok(Array.isArray(after.qualityStats.last.findings), '必须记录判到了哪些规则')

  // 关键：只带工具调用的空文本消息必须记成 skip，不能记成 check。
  // 否则「查了很多次」里会混进「其实没查」，用户就无法用它判断钩子是否真的在工作。
  const emptyAgent = agentWith([{ type: 'assistant/message', seq: 302, data: { content: [] } }])
  await ctx._emitWaterfall('agent/pre-step', { agent: emptyAgent, step: 1, turn: 4 }, enterDecision([]))
  const afterEmpty = (await callRoute(ctx._routes.get('/api/anima/state'))).payload.qualityStats
  assert.equal(afterEmpty.checks, after.qualityStats.checks, '空文本不该被算成一次检查')
  assert.ok((afterEmpty.skipped['empty-text'] ?? 0) > 0, '空文本必须落进 skip 并带原因')
})
await test('HTTP 路由注册齐全', () => {
  // 刻意不钉总数：每加一条路由都要回来改数字，而这条用例想证明的只是「路由都注册上了」。
  const expected = [
    '/api/anima/state',
    '/api/anima/preview',
    '/api/anima/presets',
    '/api/anima/presets/apply',
    '/api/anima/presets/save',
    '/api/anima/presets/delete',
    '/api/anima/config',
    '/api/anima/config/reset',
    '/api/anima/proposal',
    '/api/anima/audit',
    '/api/anima/workspace',
    '/api/anima/memory/decide',
    '/api/anima/memory/delete',
    '/api/anima/memory/triage',
    '/api/anima/memory/add',
    '/api/anima/memory/import/parse',
    '/api/anima/memory/import/commit'
  ]
  for (const path of expected) {
    assert.ok(ctx._routes.has(path), `路由缺失：${path}`)
  }
})

await test('命令 /anima 与工具 remember / set_assistant_persona 均注册', () => {
  assert.ok(ctx._commands.some((c) => c.name === 'anima'), '命令缺失')
  assert.ok(ctx._tools.some((t) => t.name === 'remember'), '工具缺失')
  assert.ok(ctx._tools.some((t) => t.name === 'set_assistant_persona'), '人设工具缺失')
})

// ---- 配置变更通知：让活动会话知道「旧设定作废」----
//
// 为什么必须有这条链路：system prompt 每轮重装配，改完下一轮就是新内容；
// 但**对话历史里**还躺着旧设定生效期间的系统提示。模型看得到两套规则，
// 而没有任何东西告诉它哪套算数 —— 它会倾向沿用先出现的那套。

await test('改人设后向每个活动会话注入一条「旧设定作废」说明', async () => {
  // 挂在「用户真的改了影响提示词的字段」这条路径上：agentName 属于 PROMPT_AFFECTING_FIELDS。
  const one = ctx._makeAgent('会话甲')
  const two = ctx._makeAgent('会话乙')
  ctx._agents.push(one, two)

  const { status } = await callRoute(ctx._routes.get('/api/anima/config'), {
    method: 'POST',
    body: { agentName: '小沃' }
  })
  assert.equal(status, 200)
  assert.equal(one.inbox.length, 1, '每个活动会话各收到一条')
  assert.equal(two.inbox.length, 1)

  const message = one.inbox[0]
  assert.equal(message.role, 'user')
  // 来源准入：会话格式 v4 拒绝共享的 kind:'plugin'，必须自持生产者 kind。
  assert.equal(message.source.kind, 'plugin:dsh-anima')
  assert.equal(message.source.form, 'snapshot')
  const text = message.content[0].text
  assert.match(text, /不再适用/, '必须明说旧设定作废')
  assert.match(text, /助手名字/, '要念出变更字段的中文名，而不是 agentName 这种内部键')
  // 只念字段名、不念新值：新值已经在下一轮提示词里了。
  assert.ok(!/小沃/.test(text), '通知里不该重复新值')
})

await test('来源如实标注：模型自己改的写「模型工具」，不冒充用户操作', async () => {
  // 工具确认默认关闭时，set_assistant_persona 直接落盘 —— 那次变更的作者是模型。
  const agent = ctx._makeAgent('会话丙')
  ctx._agents.push(agent)
  const tool = ctx._tools.find((t) => t.name === 'set_assistant_persona')
  const result = await tool.execute({ agentRole: '写作搭子' })
  assert.equal(result.ok, true, result.message)
  assert.equal(agent.inbox.length, 1)
  assert.match(agent.inbox[0].content[0].text, /模型工具/)
})

await test('只改不影响提示词的字段时一声不吭（否则每点一下开关就插一条消息）', async () => {
  const agent = ctx._makeAgent('会话丁')
  ctx._agents.push(agent)
  const { status } = await callRoute(ctx._routes.get('/api/anima/config'), {
    method: 'POST',
    body: { trailColor: '#22C55E' }
  })
  assert.equal(status, 200)
  assert.equal(agent.inbox.length, 0, '光轨颜色不影响注入文本，不该打扰会话')
})

// 这条对应一个真实观察：我在设置页把「对账档位」从 three 改成 five，宿主发来的通知
// 开头写的是「助手人格设定刚有更新」。改的是质检判据，不是我是谁 —— 标题就在说谎。
// 标题说真话不是措辞洁癖：这条通知的第一句话会被模型和用户同时读到，它一旦扭曲，
// 后面「变更字段：质检设置（ledgerLevel）」写得再准也救不回来。
await test('只改质检设置时，通知开头不能说成「人格设定更新了」', async () => {
  const agent = ctx._makeAgent('会话戊')
  ctx._agents.push(agent)
  const { status } = await callRoute(ctx._routes.get('/api/anima/config'), {
    method: 'POST',
    body: { quality: { enabled: true, ledgerLevel: 'five', strict: true, preStepCheck: true, maxFindingsInReminder: 5 } }
  })
  assert.equal(status, 200)
  assert.equal(agent.inbox.length, 1, '质检设置进了提示词，该通知')
  const text = agent.inbox[0].content[0].text
  assert.ok(!/人格/.test(text), `只改质检却说了「人格」：${text.split('\n')[0]}`)
  assert.match(text, /质检设置/, '要念出变更字段，证明它知道改的是什么')
  assert.match(text, /不再适用/, '仍然要说明旧值作废')
})

await test('同时改人设与质检时，标题两种都提到（不能漏掉人设那半边）', async () => {
  const agent = ctx._makeAgent('会话己')
  ctx._agents.push(agent)
  const { status } = await callRoute(ctx._routes.get('/api/anima/config'), {
    method: 'POST',
    body: {
      agentName: '小沃二号',
      quality: { enabled: true, ledgerLevel: 'three', strict: true, preStepCheck: true, maxFindingsInReminder: 5 }
    }
  })
  assert.equal(status, 200)
  const text = agent.inbox.at(-1).content[0].text
  assert.match(text, /人格/, '含人设字段时必须提人格')
  assert.match(text, /提示词/, '同时要说明还改了别的提示词设定')
})

await test('人设工具不叫 set_persona（避开同名工具的重名冲突）', () => {
  // dsh-tools 的 NamedEntries 遇重名直接抛错（dsh-tools\lib\index.js:2634），
  // 注册顺序决定谁死。名字撞车 = 两者的工具会静默少一个。
  assert.equal(ctx._tools.some((t) => t.name === 'set_persona'), false, '不得占用同类插件已用的工具名')
})

await test('人设工具的输出 schema 走 DSL 允许的形态（无根级 required）', () => {
  const tool = ctx._tools.find((t) => t.name === 'set_assistant_persona')
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(tool.output.schema.additionalProperties, false)
  assert.equal('required' in tool.output.schema, false)
  assert.equal(typeof tool.output.render, 'function')
  // changes 子对象同样必须显式声明 additionalProperties，且逐属性给类型
  assert.equal(tool.output.schema.properties.changes.additionalProperties, false)
  assert.equal(tool.output.schema.properties.changes.properties.agentName.type, 'string')
})

await test('人设工具的参数不含 enum 约束（用户已定「全字段自由文本」）', () => {
  const tool = ctx._tools.find((t) => t.name === 'set_assistant_persona')
  // 注意 parameters 已被 defineTool 编译成 JSON Schema：属性表在 .properties 下
  const descriptors = tool.parameters.properties
  assert.ok(Object.keys(descriptors).length >= 12, '应覆盖全部可写字段')
  for (const [key, spec] of Object.entries(descriptors)) {
    assert.equal('enum' in spec, false, `${key} 不应带 enum`)
    assert.equal(spec.type, 'string', `${key} 应为自由文本`)
  }
})

await test('remember 工具定义合规（参数/输出 schema 齐全）', () => {
  const tool = ctx._tools.find((t) => t.name === 'remember')
  assert.equal(tool.parameters.type, 'object')
  assert.ok(tool.parameters.properties.text, '缺 text 参数')
  assert.equal(tool.parameters.properties.text.type, 'string')
  assert.equal(tool.parameters.properties.text.description.includes('500'), true)
  assert.equal(tool.output.schema.type, 'object')
  // output.schema 全程不得出现 required：宿主 DSL 只在参数属性层放行它，
  // 写进 output.schema 会让 defineTool() 定义期抛错（工具永不注册）。
  assert.equal('required' in tool.output.schema, false, 'output.schema 不得声明 required')
  assert.equal(typeof tool.output.schema.properties.ok.type, 'string')
  // output.render 也必须是函数：defineTool 无条件包装并调用它（定义期不校验），
  // 缺了会注册成功却让每次调用报 `output.render failed: userRender is not a function`。
  assert.equal(typeof tool.output.render, 'function', 'output.render 必须是函数')
  assert.equal(typeof tool.execute, 'function')
})

await test('remember 的 output.render 可被调用且返回文本块', () => {
  const tool = ctx._tools.find((t) => t.name === 'remember')
  const blocks = tool.output.render({}, { ok: true, message: '已投递到待审缓冲区，等待用户裁决后才会生效。', id: 'm-test', pending: 3 })
  assert.ok(Array.isArray(blocks), 'render 应返回块数组')
  assert.equal(blocks[0].type, 'text')
  assert.ok(blocks[0].text.includes('已投递到待审缓冲区'), '应包含 message')
  assert.ok(blocks[0].text.includes('m-test'), '应包含 id')
  assert.ok(blocks[0].text.includes('3'), '应包含待审条数')
})

await test('remember 工具端到端：投递候选 → 进缓冲区 → 采纳后进提示词', async () => {
  const tool = ctx._tools.find((t) => t.name === 'remember')
  // 先清空缓冲区，避免与前面的用例互相干扰
  const state0 = await callRoute(ctx._routes.get('/api/anima/state'))
  for (const item of state0.payload.memories.pending) {
    await callRoute(ctx._routes.get('/api/anima/memory/delete'), {
      method: 'POST',
      body: { id: item.id }
    })
  }

  const injected = await tool.execute({ text: '用户希望所有交付都放在对话里，不额外生成汇报文件' })
  assert.equal(injected.ok, true, injected.message)
  assert.equal(injected.pending, 1)
  assert.equal(ctx._sections.get('anima:memory').text({}), '', '未采纳不进记忆段')

  const state = await callRoute(ctx._routes.get('/api/anima/state'))
  const id = state.payload.memories.pending[0].id
  await callRoute(ctx._routes.get('/api/anima/memory/decide'), {
    method: 'POST',
    body: { id, decision: 'adopt' }
  })
  assert.match(ctx._sections.get('anima:memory').text({}), /不额外生成汇报文件/)
})

await test('remember 工具重复投递同一内容不再提名', async () => {
  const tool = ctx._tools.find((t) => t.name === 'remember')
  const again = await tool.execute({ text: '用户希望所有交付都放在对话里，不额外生成汇报文件' })
  assert.equal(again.ok, true)
  assert.match(again.message, /已经在长期记忆里/)
})

await test('remember 工具拒绝凭据且不落盘', async () => {
  const tool = ctx._tools.find((t) => t.name === 'remember')
  const before = (await callRoute(ctx._routes.get('/api/anima/state'))).payload.memories.pending.length
  const rejected = await tool.execute({ text: 'token: ghp_abcdefghijklmnopqrstuvwx01' })
  assert.equal(rejected.ok, false)
  assert.match(rejected.message, /凭据/)
  const after = (await callRoute(ctx._routes.get('/api/anima/state'))).payload.memories.pending.length
  assert.equal(after, before, '被拒的内容不应留下痕迹')
})

await test('对外服务 animaConfig 已提供', () => {
  assert.ok(ctx._provided.has('animaConfig'))
})

// 质检段曾经被抄了三处：提示词 section、getSystemPrompt、/api/anima/preview。
// 抄成三份的直接后果已经发生过一次 —— preview 那份漏掉了末尾「关于上一段怎么被检查」
// 的三小节，于是同一个问题对外的三个答案里有一个是残缺的。
// 这条测试锁住「三处必须是同一段文本」，谁再手抄一份就会红。
await test('质检段的三个出口必须逐字相同（提示词 section / getSystemPrompt / preview）', async () => {
  const sectionText = ctx._sections.get('anima:quality').text({})
  assert.ok(sectionText.length > 0, '提示词质检段不该为空')

  const service = ctx._provided.get('animaConfig')
  const systemPrompt = await service.getSystemPrompt(undefined)
  assert.ok(
    systemPrompt.includes(sectionText),
    'getSystemPrompt 里的质检段必须与提示词 section 逐字相同（不得各自拼一份）'
  )

  const { payload } = await callRoute(ctx._routes.get('/api/anima/preview'))
  assert.equal(
    payload.sections.quality,
    sectionText,
    'preview 的质检段必须与提示词 section 逐字相同（漏内容就等于对外保证了一份没注入的文本）'
  )
})

await test('/state 下发档位文案与示例两组表，且不含空档位', async () => {
  const { payload } = await callRoute(ctx._routes.get('/api/anima/state'))
  // 客户端不自己抄一份文案表：按钮上写什么一律取自这里，否则改了 host 忘了
  // 客户端就会出现两套说法，而实际注入的是 host 那份。
  assert.ok(payload.wording && typeof payload.wording === 'object', '缺 wording 表')
  assert.ok(Array.isArray(payload.wording.style) && payload.wording.style.length >= 5, '风格档位应有 5 条')
  // 三项特质只下发 more / less：default 的文案是空串，做成按钮会让人以为
  // 点一下能得到什么，其实只是清空输入框。
  for (const field of ['headingLists', 'emoji', 'tables']) {
    const list = payload.wording[field]
    assert.ok(Array.isArray(list), `${field} 档位表缺失`)
    assert.equal(list.some((item) => item.text === ''), false, `${field} 不该下发空文案档位`)
    assert.ok(list.length >= 2, `${field} 应至少有 more / less 两条`)
  }
  assert.ok(payload.examples && typeof payload.examples === 'object', '缺示例表')
  // agentName 刻意是空数组：按钮填个名字进去用户很可能忘改，改由 placeholder 提示格式。
  assert.equal(payload.examples.agentName.length, 0, 'agentName 不该有示例')
  assert.ok(payload.examples.agentRole.length >= 2, '角色设定应有示例')
  assert.ok(payload.examples.customInstructions.some((text) => text.includes('\n')), '补充指令的示例应含换行（教会用户怎么分行）')

  // 两份表都是新数组：客户端会就地改它们，共用一个数组会串到下一个请求。
  payload.examples.agentRole.push('污染探针')
  const again = await callRoute(ctx._routes.get('/api/anima/state'))
  assert.equal(again.payload.examples.agentRole.includes('污染探针'), false, '示例表被上一次请求改坏了')
})

await test('remember 工具从执行上下文取 cwd（不是从 args.__cwd）', async () => {
  const tool = ctx._tools.find((t) => t.name === 'remember')
  // 先清空缓冲区
  const s0 = await callRoute(ctx._routes.get('/api/anima/state'))
  for (const item of s0.payload.memories.pending) {
    await callRoute(ctx._routes.get('/api/anima/memory/delete'), { method: 'POST', body: { id: item.id } })
  }
  const FAKE_CWD = 'D:\\deepseek工作区\\cwd-probe-ws'
  const mine = `cwd 记录探针-${Date.now()}`
  await tool.execute({ text: mine }, { agent: { session: { header: { cwd: FAKE_CWD } } } })
  const s1 = await callRoute(ctx._routes.get('/api/anima/state'))
  const found = s1.payload.memories.pending.find((m) => m.text === mine)
  assert.ok(found, '候选未进缓冲区')
  // cwd 落盘前会归一化（小写 + 正斜杠 + 去尾分隔符）：Windows 路径大小写不敏感、
  // `\` 与 `/` 混写，不归一化会把同一个目录判成两个，工作区记忆匹配就会随机失败。
  assert.equal(found.cwd, 'd:/deepseek工作区/cwd-probe-ws', 'cwd 未从 exec.agent.session.header.cwd 归一化落盘')
  // 自清理：本用例只验证 cwd 归属，不留残留候选污染后续断言。
  await callRoute(ctx._routes.get('/api/anima/memory/delete'), { method: 'POST', body: { id: found.id } })
  const s2 = await callRoute(ctx._routes.get('/api/anima/state'))
  assert.equal(s2.payload.memories.pending.some((m) => m.text === mine), false, '清理失败')
})

console.log('\n[人设工具与确认流]')

await test('人设工具：直接改人设并落盘（确认模式关闭时）', async () => {
  const tool = ctx._tools.find((t) => t.name === 'set_assistant_persona')
  const result = await tool.execute({ agentName: '小沃', agentRole: '长期 AI 助手' })
  assert.equal(result.ok, true)
  assert.equal(result.pending, undefined, '未开确认模式时不应转成提议')
  assert.match(result.message, /已更新/)
  const { payload } = await callRoute(ctx._routes.get('/api/anima/state'))
  assert.equal(payload.config.agentName, '小沃')
  assert.equal(payload.config.agentRole, '长期 AI 助手')
})

await test('人设工具：未提供的字段保持不变', async () => {
  const tool = ctx._tools.find((t) => t.name === 'set_assistant_persona')
  await callRoute(ctx._routes.get('/api/anima/config'), { method: 'POST', body: { addressUserAs: '老大' } })
  await tool.execute({ agentRole: '学生/研究者为主' })
  const { payload } = await callRoute(ctx._routes.get('/api/anima/state'))
  assert.equal(payload.config.addressUserAs, '老大', '未传入的字段被清掉了')
  assert.equal(payload.config.agentRole, '学生/研究者为主')
})

await test('人设工具：值没变时如实说「没有要更改的设置」', async () => {
  const tool = ctx._tools.find((t) => t.name === 'set_assistant_persona')
  const result = await tool.execute({ agentName: '小沃' })
  assert.equal(result.ok, true)
  assert.match(result.message, /没有要更改的设置/)
})

await test('人设工具：超长的风格文本被拒而不是静默截断', async () => {
  const tool = ctx._tools.find((t) => t.name === 'set_assistant_persona')
  const result = await tool.execute({ style: 'x'.repeat(801) })
  assert.equal(result.ok, false)
  assert.match(result.message, /长度超过上限 800/)
})

await test('人设工具：自由文本风格值可以正常写入', async () => {
  // v3 起风格字段是自由文本，模型写一段中文要求即可 —— 不会再出现「非法枚举值」。
  const tool = ctx._tools.find((t) => t.name === 'set_assistant_persona')
  const result = await tool.execute({ style: '结论先行，不展开背景' })
  assert.equal(result.ok, true)
  const config = (await callRoute(ctx._routes.get('/api/anima/state'))).payload.config
  assert.equal(config.style, '结论先行，不展开背景')
})

await test('人设工具：超长字段被拒（上限来自 FIELD_LIMITS）', async () => {
  const tool = ctx._tools.find((t) => t.name === 'set_assistant_persona')
  const result = await tool.execute({ agentName: 'x'.repeat(51) })
  assert.equal(result.ok, false)
  assert.match(result.message, /长度超过上限 50/)
})

await test('人设工具：不能透过它改到工具之外的字段（enabled / memory）', async () => {
  const tool = ctx._tools.find((t) => t.name === 'set_assistant_persona')
  await callRoute(ctx._routes.get('/api/anima/config'), { method: 'POST', body: { enabled: true } })
  const result = await tool.execute({ agentName: '小沃·越权探针', enabled: false })
  assert.equal(result.ok, true)
  // enabled 被 sanitizeConfig 收下、又被 TOOL_FIELDS 过滤掉 ⇒ 只报 name 这一项，且配置未变
  assert.deepEqual(Object.keys(result.changes), ['agentName'], 'changelist 混入了工具字段之外的东西')
  const { payload } = await callRoute(ctx._routes.get('/api/anima/state'))
  assert.equal(payload.config.enabled, true, '模型透过人设工具关掉了插件')
  // 复位：后续用例要断言 agentName 是「小沃」
  await callRoute(ctx._routes.get('/api/anima/config'), { method: 'POST', body: { agentName: '小沃' } })
})

await test('确认模式：工具只提交提议，不落盘', async () => {
  await callRoute(ctx._routes.get('/api/anima/config'), { method: 'POST', body: { requireToolConfirmation: true } })
  const tool = ctx._tools.find((t) => t.name === 'set_assistant_persona')
  const result = await tool.execute({ agentName: '待确认的名字' })
  assert.equal(result.ok, true)
  assert.equal(result.pending, true)
  assert.match(result.message, /尚未生效/)
  assert.match(result.message, /\/anima confirm/)
  const { payload } = await callRoute(ctx._routes.get('/api/anima/state'))
  assert.equal(payload.config.agentName, '小沃', '确认模式下不应写盘')
  assert.ok(payload.pendingProposal, 'state 未透出待确认提议')
  assert.equal(payload.pendingProposal.patch.agentName, '待确认的名字')
})

await test('确认模式：提议经 /proposal 确认后才生效', async () => {
  const { status, payload } = await callRoute(ctx._routes.get('/api/anima/proposal'), {
    method: 'POST',
    body: { action: 'confirm' }
  })
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.config.agentName, '待确认的名字')
  const after = await callRoute(ctx._routes.get('/api/anima/state'))
  assert.equal(after.payload.pendingProposal, null, '确认后提议应被清空')
  assert.equal(after.payload.config.agentName, '待确认的名字')
})

await test('确认模式：/proposal 拒绝后配置一字未动', async () => {
  const tool = ctx._tools.find((t) => t.name === 'set_assistant_persona')
  await tool.execute({ agentRole: '不该生效的角色' })
  const { payload } = await callRoute(ctx._routes.get('/api/anima/proposal'), {
    method: 'POST',
    body: { action: 'reject' }
  })
  assert.equal(payload.rejected, true)
  assert.equal(payload.changed.length, 0)
  assert.equal(payload.config.agentRole, '学生/研究者为主', '拒绝后配置被改了')
  const after = await callRoute(ctx._routes.get('/api/anima/state'))
  assert.equal(after.payload.pendingProposal, null)
})

await test('没有提议时 confirm 返回 404（不假装成功）', async () => {
  const { status, payload } = await callRoute(ctx._routes.get('/api/anima/proposal'), {
    method: 'POST',
    body: { action: 'confirm' }
  })
  assert.equal(status, 404)
  assert.equal(payload.ok, false)
  assert.match(payload.error, /没有待确认/)
})

await test('/anima audit 当场重算机器判词，并如实列出没查什么', async () => {
  const command = ctx._commands.find((c) => c.name === 'anima')

  // 会话里没有回答时不能假装检查过
  const emptyAgent = { session: { snapshotEvents: () => [] } }
  const empty = await command.handler({ rawInput: 'audit', agent: emptyAgent })
  assert.equal(empty.kind, 'success')
  assert.match(empty.text, /还没有助手回答/)

  // 读不到消息记录时必须报错，而不是回一句「没问题」
  const blind = await command.handler({ rawInput: 'audit', agent: { session: {} } })
  assert.equal(blind.kind, 'error')
  assert.match(blind.text, /无法检查/)

  // 有问题的回答：必须报出规则、原文摘录、并列出未查清单
  const dirty = {
    session: {
      snapshotEvents: () => [{
        type: 'assistant/message',
        seq: 42,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '据官方文档可知，这个接口限流是每分钟 60 次。我会持续关注。' }],
            source: { kind: 'assistant' },
            id: 'msg-42'
          }
        }
      }]
    }
  }
  const bad = await command.handler({ rawInput: 'audit', agent: dirty })
  assert.equal(bad.kind, 'success')
  assert.match(bad.text, /事件 seq=42/, '必须指出查的是哪一条，否则无法复核')
  assert.match(bad.text, /R0[19]|R02/, '要报出命中的规则号')
  assert.match(bad.text, /原文：/, '要带可核对的原文摘录')
  assert.match(bad.text, /本次未查：/, '必须列出机器判不了的项')
  assert.match(bad.text, /不经过模型/, '必须说明结论来自代码，不是自评')

  // 干净的回答：允许说「没抓到问题」，但**必须**同时说不等于内容正确、不等于十二条全过
  const clean = {
    session: {
      snapshotEvents: () => [{
        type: 'assistant/message',
        seq: 43,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '这个常量定义在 lib/store.mjs:59，只有一行赋值。' }],
            source: { kind: 'assistant' },
            id: 'msg-43'
          }
        }
      }]
    }
  }
  const good = await command.handler({ rawInput: 'audit', agent: clean })
  assert.equal(good.kind, 'success')
  assert.match(good.text, /没抓到问题/)
  assert.match(good.text, /不等于内容正确/, '干净时必须声明这不等于正确 —— 否则该命令自己就成了表演面')
  assert.match(good.text, /本次未查：/)
})

await test('命令 /anima confirm 与 reject 与 HTTP 路由同语义', async () => {
  const command = ctx._commands.find((c) => c.name === 'anima')
  const tool = ctx._tools.find((t) => t.name === 'set_assistant_persona')

  // 无提议时 confirm 应报错
  const none = await command.handler({ rawInput: 'confirm' })
  assert.equal(none.kind, 'error')
  assert.match(none.text, /没有待确认/)

  // 有提议时 confirm 生效
  await tool.execute({ addressUserAs: '老大（命令确认）' })
  const confirmed = await command.handler({ rawInput: 'confirm' })
  assert.equal(confirmed.kind, 'success')
  assert.match(confirmed.text, /已确认并生效/)
  const after = await callRoute(ctx._routes.get('/api/anima/state'))
  assert.equal(after.payload.config.addressUserAs, '老大（命令确认）')

  // show 会提示有一条提议挂着
  await tool.execute({ userOccupation: '学生' })
  const shown = await command.handler({ rawInput: 'show' })
  assert.match(shown.text, /待确认的人设变更提议/)
  // show 还带一行「最近变更」：上面那次 /anima confirm 刚改过人设，这条记录要能一眼看到。
  // 只显示一条（它是诊断行不是列表），带来源与字段名，且**不含具体值**——值可能很私人。
  assert.match(shown.text, /最近变更：\[\d\d-\d\d \d\d:\d\d\] .+：addressUserAs/)
  assert.equal(shown.text.split('最近变更：').length - 1, 1, '最近变更只应出现一行')
  const auditLine = shown.text.split('\n').find((line) => line.startsWith('最近变更：'))
  assert.ok(!auditLine.includes('老大（命令确认）'), '最近变更行不应带具体值')
  const rejected = await command.handler({ rawInput: 'reject' })
  assert.equal(rejected.kind, 'success')
  assert.match(rejected.text, /已拒绝/)
})

await test('确认模式复位：改回关闭后工具恢复直接写入', async () => {
  await callRoute(ctx._routes.get('/api/anima/config'), { method: 'POST', body: { requireToolConfirmation: false } })
  const tool = ctx._tools.find((t) => t.name === 'set_assistant_persona')
  const result = await tool.execute({ agentName: '小沃' })
  assert.equal(result.ok, true)
  assert.equal(result.pending, undefined)
})

console.log('\n[端到端]')

await test('GET /state 返回合法负载', async () => {
  const { status, payload } = await callRoute(ctx._routes.get('/api/anima/state'))
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.ok(payload.config, '缺 config')
  assert.ok(payload.limits, '缺 limits')
  assert.ok(payload.memories, '缺 memories')
  assert.ok(Array.isArray(payload.memories.pending))
})

await test('存储可用时 /state 的 source 是 storage 且 reason 为 null', async () => {
  // 2026-10-10 那次真机无声退化（配置里只有一个 kind:'file'）之后，source 增加了
  // reason / message 两个诊断字段。这里是**可用态**的对照：kind=storage、reason=null。
  // 不可用态的降级表现由下面「存储栈未组合」那组用例覆盖。
  const { payload } = await callRoute(ctx._routes.get('/api/anima/state'))
  assert.equal(payload.source.kind, 'storage')
  assert.equal(payload.source.reason, null)
  assert.equal(payload.source.path, null)
  assert.equal(payload.source.message, null)
  // 域打开时的格式戳。它同时是「插件真的把域打开了」的信号：null 表示没打开。
  assert.equal(typeof payload.source.domainVersion, 'number')
  // loaded 是 agent 侧三段 section 的闸门：false 时它们返回空串。
  // 成功分支当初漏了这个字段，check-live 才在重启后抓到 —— 这里补上回归。
  assert.equal(payload.loaded, true)
})

await test('关闭插件时身份段改为注入「已关闭」声明，而不是空串', async () => {
  // 语义变更（A 自建补齐后）：本插件现在是**自足**的 —— 全部人设字段都有默认值，
  // 因此 enabled 时即使一个字段都没填，也会渲染出「回复风格」段（专业严谨 + 语言）。
  // 这是刻意的：用户若只装本插件，默认档就是他能拿到的语气。
  const identity = ctx._sections.get('anima:identity')
  assert.match(identity.text({}), /## 回复风格/, '默认档应渲染出风格段')

  // enabled=false 时**不能**返回空串：对话历史里还留着旧设定生效期间的那条系统提示，
  // 什么都不说等于让模型继续按那套回答。必须显式声明撤销。
  await callRoute(ctx._routes.get('/api/anima/config'), { method: 'POST', body: { enabled: false } })
  const off = identity.text({})
  assert.match(off, /## 助手人格设定已关闭/)
  assert.match(off, /不再适用/)
  assert.ok(!/## 回复风格/.test(off), '关闭后不许再带任何用户配置段')

  const { status } = await callRoute(ctx._routes.get('/api/anima/config'), { method: 'POST', body: { enabled: true } })
  assert.equal(status, 200)
})

await test('写入 AI 名字后身份段立即生效（无需重启会话）', async () => {
  const { status } = await callRoute(ctx._routes.get('/api/anima/config'), {
    method: 'POST',
    body: { agentName: '小沃', agentRole: '研究助手', addressUserAs: '老大' }
  })
  assert.equal(status, 200)
  const identity = ctx._sections.get('anima:identity')
  const text = identity.text({})
  assert.match(text, /小沃/)
  assert.match(text, /研究助手/)
  assert.match(text, /老大/)
})

await test('配置校验失败返回 400 且不落盘', async () => {
  const { status, payload } = await callRoute(ctx._routes.get('/api/anima/config'), {
    method: 'POST',
    body: { agentName: 'x'.repeat(200) }
  })
  assert.equal(status, 400)
  assert.match(payload.error, /配置校验失败/)
  // 原值未被破坏
  const state = await callRoute(ctx._routes.get('/api/anima/state'))
  assert.equal(state.payload.config.agentName, '小沃')
})

// 2026-10-10 的事故回归：写路由被空 body POST 探活时，破坏性动作必须失败关闭。
await test('重置必须显式确认：空 body 一律 400 且不动配置', async () => {
  const before = (await callRoute(ctx._routes.get('/api/anima/state'))).payload.config
  const { status, payload } = await callRoute(ctx._routes.get('/api/anima/config/reset'), {
    method: 'POST',
    body: {}
  })
  assert.equal(status, 400, '空 body 不该执行重置')
  assert.equal(payload.code, 'confirmation-required')
  assert.equal(payload.ok, false)
  const after = (await callRoute(ctx._routes.get('/api/anima/state'))).payload.config
  assert.equal(after.agentName, before.agentName, '被拒的重置不得改动任何字段')
  assert.equal(after.addressUserAs, before.addressUserAs)
})

await test('重置带 confirm:true 才生效，且保留用户自建预设', async () => {
  // 先造一个自建预设 —— 它是用户资产，重置不该连它一起清掉
  const saved = await callRoute(ctx._routes.get('/api/anima/presets/save'), {
    method: 'POST',
    body: { name: '重置前存档', fields: { style: 'casual' } }
  })
  assert.equal(saved.status, 200)
  const customId = saved.payload.presets.find((p) => p.name === '重置前存档')?.id
  assert.ok(customId, '自建预设应已保存')

  const { status } = await callRoute(ctx._routes.get('/api/anima/config/reset'), {
    method: 'POST',
    body: { confirm: true }
  })
  assert.equal(status, 200)
  const after = (await callRoute(ctx._routes.get('/api/anima/state'))).payload.config
  assert.equal(after.agentName, '', '确认后的重置应清空人设字段')
  assert.ok(
    (after.presets ?? []).some((p) => p.id === customId),
    '重置必须保留用户自建预设（与同类插件的保留语义对齐）'
  )
  // 清理：删掉这条预设、并把人设字段恢复原值 —— 本套件后面的用例
  // （持久化、提示词装配）都假设 agentName 仍是「小沃」。
  await callRoute(ctx._routes.get('/api/anima/presets/delete'), { method: 'POST', body: { id: customId } })
  const restore = await callRoute(ctx._routes.get('/api/anima/config'), {
    method: 'POST',
    body: { agentName: '小沃', agentRole: '长期 AI 助手，学生/研究者为主', addressUserAs: '老大' }
  })
  assert.equal(restore.status, 200)
})

await test('手动添加记忆 → 进缓冲区但不进提示词', async () => {
  const add = await callRoute(ctx._routes.get('/api/anima/memory/add'), {
    method: 'POST',
    body: { text: '用户偏好结论先行', note: '来自测试' }
  })
  assert.equal(add.status, 200)
  const memory = ctx._sections.get('anima:memory')
  // 只断言「这一条」没进提示词 —— 此前用例可能已采纳过别的记忆。
  assert.equal(memory.text({}).includes('用户偏好结论先行'), false, '未采纳的候选不应进入记忆段')
  const pending = ctx._sections.get('anima:pending')
  // 待审段刻意只报条数、不列内容 —— 未采纳的候选不该进入提示词。
  assert.match(pending.text({}), /等待用户裁决/)
  assert.equal(pending.text({}).includes('用户偏好结论先行'), false, '未采纳的候选内容不应出现在提示词里')
})

await test('采纳后进入记忆段、待审段归零', async () => {
  const state = await callRoute(ctx._routes.get('/api/anima/state'))
  // 按内容挑，**不能用 pending[0]**：缓冲区里可能还留着前面用例投递的候选，
  // 取第一个等于把断言绑在队列顺序上 —— 顺序一变，用例就报一个与它无关的失败。
  const target = state.payload.memories.pending.find((m) => m.text === '用户偏好结论先行')
  assert.ok(target, '待裁决的候选已不在缓冲区里')
  const decide = await callRoute(ctx._routes.get('/api/anima/memory/decide'), {
    method: 'POST',
    body: { id: target.id, decision: 'adopt' }
  })
  assert.equal(decide.status, 200)
  const memory = ctx._sections.get('anima:memory')
  assert.match(memory.text({}), /用户偏好结论先行/)
  assert.equal(ctx._sections.get('anima:pending').text({}), '')
})

await test('含凭据的记忆被拒收', async () => {
  const add = await callRoute(ctx._routes.get('/api/anima/memory/add'), {
    method: 'POST',
    body: { text: '我的 key 是 sk-abcdefghijklmnopqrstuvwx' }
  })
  assert.equal(add.status, 400)
  assert.match(add.payload.error, /凭据/)
})

await test('回填元数据：改一条已采纳记忆的 type，正文与裁决状态一个字不动', async () => {
  const state = await callRoute(ctx._routes.get('/api/anima/state'))
  const target = state.payload.memories.adopted.find((m) => m.text === '用户偏好结论先行')
  assert.ok(target, '前置条件：上一条用例已把这条采纳')
  const before = { text: target.text, status: target.status, capturedAt: target.capturedAt }

  const meta = await callRoute(ctx._routes.get('/api/anima/memory/meta'), {
    method: 'POST',
    body: { id: target.id, type: 'preference', sourceRef: 'm00123' }
  })
  assert.equal(meta.status, 200)
  assert.deepEqual(meta.payload.changed.sort(), ['sourceRef', 'type'])

  const after = await callRoute(ctx._routes.get('/api/anima/state'))
  const reloaded = after.payload.memories.adopted.find((m) => m.id === target.id)
  assert.ok(reloaded, '改元数据不许把条目弄丢')
  assert.equal(reloaded.type, 'preference')
  assert.equal(reloaded.sourceRef, 'm00123')
  // 三个不许动的字段逐个钉：正文改了就等于伪造用户说过的话，
  // status 改了等于替用户重新裁决，capturedAt 改了等于伪造时间线。
  assert.equal(reloaded.text, before.text)
  assert.equal(reloaded.status, before.status)
  assert.equal(reloaded.capturedAt, before.capturedAt)
})

await test('回填元数据：写同样的值回 changed 为空，不谎报「已更新」', async () => {
  const state = await callRoute(ctx._routes.get('/api/anima/state'))
  const target = state.payload.memories.adopted.find((m) => m.type === 'preference')
  assert.ok(target, '前置条件：上一条用例已写入 type')
  const same = await callRoute(ctx._routes.get('/api/anima/memory/meta'), {
    method: 'POST',
    body: { id: target.id, type: 'preference' }
  })
  assert.equal(same.status, 200)
  assert.deepEqual(same.payload.changed, [], '没变化就必须回空数组，界面据此不显示「已保存」')
})

await test('回填元数据：找不到的 id 必须 404，不能静默成功', async () => {
  const missing = await callRoute(ctx._routes.get('/api/anima/memory/meta'), {
    method: 'POST',
    body: { id: 'm-does-not-exist', type: 'fact' }
  })
  assert.equal(missing.status, 404)
  assert.match(missing.payload.error, /找不到/)
})

await test('批量回填：逐条回执里能看出哪条成功、哪条为什么失败', async () => {
  const state = await callRoute(ctx._routes.get('/api/anima/state'))
  const one = state.payload.memories.adopted[0]
  assert.ok(one, '前置条件：缓冲区里至少有一条已采纳记忆')
  const batch = await callRoute(ctx._routes.get('/api/anima/memory/meta/batch'), {
    method: 'POST',
    body: {
      items: [
        { id: one.id, type: 'fact' },
        { id: 'm-missing', type: 'fact' },
        { id: one.id, verifyAt: '2020-01-01' }
      ]
    }
  })
  assert.equal(batch.status, 200)
  assert.equal(batch.payload.total, 3)
  // 关键：失败项必须带原因。只回「成功 1 条」的话，用户无法区分
  // 「这条本来就不用改」和「这条根本改不了」。
  assert.equal(batch.payload.results[1].ok, false)
  assert.match(batch.payload.results[1].error, /找不到/)
  assert.equal(batch.payload.results[2].ok, false)
  assert.match(batch.payload.results[2].error, /已经过去/)
})

await test('状态机：supersededBy 走路由时自动落 superseded，指向不存在的 id 必须报错', async () => {
  const state = await callRoute(ctx._routes.get('/api/anima/state'))
  const target = state.payload.memories.adopted.find((m) => m.type === 'preference')
  assert.ok(target, '前置条件：前面的用例已写入 type')

  const bogus = await callRoute(ctx._routes.get('/api/anima/memory/meta'), {
    method: 'POST',
    body: { id: target.id, supersededBy: 'm-nope' }
  })
  // 存在性由路由查（只有它拿得到 store）。这条必须有 400：
  // 记下一个指向空气的指针，比不记更坏 —— 将来无法顺着它找到「后来那条」。
  assert.equal(bogus.status, 400)
  assert.match(bogus.payload.error, /不存在/)

  // 用命令行做真正合法的那一次：指向一条真实存在的记录。
  const command = ctx._commands.find((c) => c.name === 'anima')
  const missing = await command.handler({ rawInput: `mark ${target.id} supersededBy=m-ghost` })
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /不存在/, '指向空气的指针必须挡下来，否则将来无法顺着它找到「后来那条」')

  const other = state.payload.memories.pending[0] ?? state.payload.memories.adopted.find((m) => m.id !== target.id)
  assert.ok(other, '前置条件：需要另一条记忆当取代者')
  const marked = await command.handler({ rawInput: `mark ${target.id} supersededBy=${other.id}` })
  assert.equal(marked.kind, 'success')
  assert.match(marked.text, /state/, '标取代关系必须同时把状态改成 superseded')

  const after = await callRoute(ctx._routes.get('/api/anima/state'))
  const reloaded = after.payload.memories.adopted.find((m) => m.id === target.id)
  assert.equal(reloaded.supersededBy, other.id)
  assert.equal(reloaded.state, 'superseded')
  // 渲染层必须把「曾如此」写进注入行，否则状态标了但读的人看不出来。
  const memoryText = ctx._sections.get('anima:memory').text({})
  assert.match(memoryText, /曾如此/, 'superseded 的条目注入时必须带「曾如此」，否则会被当成此刻仍成立')

  // 清回 current 时指针要一起清，不留两种结论并存的一行
  const back = await command.handler({ rawInput: `mark ${target.id} state=current` })
  assert.equal(back.kind, 'success')
  const final = await callRoute(ctx._routes.get('/api/anima/state'))
  const cleared = final.payload.memories.adopted.find((m) => m.id === target.id)
  assert.equal(cleared.state, 'current')
  assert.equal('supersededBy' in cleared, false)
})

await test('记忆体检：只报机械能验的，报告里不许出现「自动改正」这类动作', async () => {
  const { status, payload } = await callRoute(ctx._routes.get('/api/anima/memory/audit'))
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(typeof payload.checked, 'number')
  assert.equal(Array.isArray(payload.flagged), true)
  // 自我约束：这个接口只能读，不能改。拿改前改后的 state 比对来证明，
  // 而不是靠「我没写 putMemory」这句话。
  const before = await callRoute(ctx._routes.get('/api/anima/state'))
  await callRoute(ctx._routes.get('/api/anima/memory/audit'))
  const after = await callRoute(ctx._routes.get('/api/anima/state'))
  const strip = (s) => JSON.stringify(s.payload.memories.adopted.map((m) => [m.id, m.state ?? null, m.type ?? null]))
  assert.equal(strip(after), strip(before), '体检不许顺手改状态：扫描可以自动，裁决必须由用户点')
  assert.match(payload.note, /不判/, '报告必须自己说清哪一半它判不了')
})

await test('/anima checkup：体检只读、逐条给证据与可直接执行的命令', async () => {
  const command = ctx._commands.find((c) => c.name === 'anima')
  const before = await callRoute(ctx._routes.get('/api/anima/state'))
  const result = await command.handler({ rawInput: 'checkup' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /记忆体检/)
  assert.match(result.text, /条要你看一眼/)
  // 只说数字不够：必须把「哪一半它判不了」写在同一段里，
  // 否则用户会把体检结果当成「这些话仍然成立」。
  assert.match(result.text, /不判|不说明这些话现在仍然成立/)
  assert.match(result.text, /不会改任何状态/)
  const after = await callRoute(ctx._routes.get('/api/anima/state'))
  const strip = (s) => JSON.stringify(s.payload.memories.adopted.map((m) => [m.id, m.state ?? null]))
  assert.equal(strip(after), strip(before), '体检不许顺手改状态')
})

await test('整理接口可调用并返回 summary', async () => {
  const { status, payload } = await callRoute(ctx._routes.get('/api/anima/memory/triage'), {
    method: 'POST',
    body: {}
  })
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.ok(payload.summary, '缺 summary')
  assert.ok(typeof payload.summary.pendingAfter === 'number')
})

await test('巡夜：真的没事时不出声，但必须写一条 meta.patrol 留痕', async () => {
  const { status, payload } = await callRoute(ctx._routes.get('/api/anima/patrol'), { method: 'POST', body: {} })
  assert.equal(status, 200, `巡夜接口失败：${payload?.error ?? ''}`)
  assert.equal(payload.ok, true)
  assert.ok(payload.verdict, '缺 verdict')
  // 「有没有说」与「跑没跑」是两件事：留痕必须每次都有，
  // 否则「没汇报」同时代表「没事」和「没跑」，分不开。
  assert.ok(payload.at, '没写时间就等于没留痕')
  const state = await callRoute(ctx._routes.get('/api/anima/state'))
  assert.ok(state.payload.patrolMeta, 'state 必须下发 patrolMeta，否则用户无从反查')
  assert.equal(state.payload.patrolMeta.at, payload.at, '下发的记录必须就是这次写的那条')
  assert.equal(state.payload.patrolMeta.reason, 'manual')
  assert.ok(typeof state.payload.patrolMeta.reported === 'boolean')
  // 这三样是判据的全部输入，必须如实落盘，否则用户无法自己复算。
  assert.equal(typeof state.payload.patrolMeta.facts.pending, 'number')
  assert.equal(typeof state.payload.patrolMeta.facts.flagged, 'number')
  assert.ok(Array.isArray(state.payload.patrolMeta.reasons))
})

await test('巡夜：同一局面连跑两次，第二次不该再汇报', async () => {
  const first = await callRoute(ctx._routes.get('/api/anima/patrol'), { method: 'POST', body: {} })
  const second = await callRoute(ctx._routes.get('/api/anima/patrol'), { method: 'POST', body: {} })
  assert.equal(first.payload.ok, true)
  assert.equal(second.payload.ok, true)
  // 指纹相同 ⇒ 第二次 shouldReport 必须为 false。
  // 这条锁住「只报有事」的真正含义：不是「有数字就报」，是「有新事才报」。
  if (first.payload.verdict.signature === second.payload.verdict.signature) {
    assert.equal(second.payload.verdict.shouldReport, false,
      '局面没变却又要汇报，两周后这条通知就会被无视')
  }
})

await test('/anima patrol：没汇报时必须当场说明「为什么没报」，不能只说跑了', async () => {
  const command = ctx._commands.find((c) => c.name === 'anima')
  const result = await command.handler({ rawInput: 'patrol' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /巡夜完成/)
  // 只报有事之后，沉默需要自己解释自己；命令输出里必须出现这句解释。
  assert.match(result.text, /没有汇报|已汇报/)
  assert.match(result.text, /meta\.patrol/, '要告诉用户这条记录在哪，否则「可反查」是空话')
})

await test('巡夜：真有新候选时必须出声（只测「没事不出声」等于只测了一半）', async () => {
  // 这条用例存在的理由：上面几条全是「没事 ⇒ 不出声」。
  // 一条永远沉默的巡夜与一条坏掉的巡夜，从外部看完全一样。
  // 所以必须再证明「有事 ⇒ 一定出声」，否则「只报有事」只验了一半。
  const add = await callRoute(ctx._routes.get('/api/anima/memory/add'), {
    method: 'POST',
    body: { text: '巡夜出声用例：新候选应当触发汇报', note: '来自测试' }
  })
  assert.equal(add.status, 200, `投递候选失败：${add.payload?.error ?? ''}`)

  const agent = ctx._makeAgent('patrol-witness')
  ctx._agents.push(agent)
  const patrol = await callRoute(ctx._routes.get('/api/anima/patrol'), { method: 'POST', body: {} })
  assert.equal(patrol.payload.ok, true, `巡夜失败：${patrol.payload?.error ?? ''}`)

  // 判据层：新 id 进了集合 ⇒ 指纹变了 ⇒ 必须判「该说」。
  assert.equal(patrol.payload.verdict.shouldReport, true, '有新候选却判不该汇报，「有事必报」没落地')
  assert.ok(patrol.payload.verdict.facts.pending > 0, '待审计数应当大于 0')
  // 投递层：消息真的进了 agent 的 inbox，且带我们自己的来源标记。
  assert.equal(agent.inbox.length, 1, '判该说却没投递，等于判词与执行脱节')
  const text = agent.inbox[0].content[0].text
  assert.match(text, /巡夜/, '注入的正文里应能认出这是巡夜汇报')
  assert.equal(agent.inbox[0].source.kind, 'plugin:dsh-anima', '注入消息必须自持 producer kind')
  // 留痕层：同一条记录里 reported 必须为 true，与「说没说」一致。
  // delivered 不能断言等于 1 —— 前面的用例已经往 ctx._agents 里塞过别的假会话，
  // 值会随用例顺序漂。这里只要求「至少投到了我这一个」，顺序无关。
  const state = await callRoute(ctx._routes.get('/api/anima/state'))
  assert.equal(state.payload.patrolMeta.reported, true, '真汇报了却记为没汇报，留痕就骗人了')
  assert.ok(state.payload.patrolMeta.delivered >= 1, 'delivered 应当 ≥ 1')

  // 收尾：把这条候选裁决掉，避免污染后续用例的指纹判断。
  const target = state.payload.memories.pending.find((m) => m.text === '巡夜出声用例：新候选应当触发汇报')
  assert.ok(target, '刚投递的候选不在待审列表里')
  await callRoute(ctx._routes.get('/api/anima/memory/decide'), {
    method: 'POST',
    body: { id: target.id, decision: 'discard' }
  })
  ctx._agents.length = ctx._agents.indexOf(agent) >= 0 ? ctx._agents.indexOf(agent) : ctx._agents.length
})

await test('巡夜：体检点到的问题必须落盘成明细，不能只留一个数字', async () => {
  // 这条用例存在的理由：`facts.flagged = 1` 只说得出「有几条」，说不出「哪几条」。
  // 汇报消息里点过名，但那是会话历史，翻不到就没了；界面上若只有数字，
  // 用户想问「是哪条」时无处可查 —— 等于半夜被告知「有 1 个问题」，然后没了下文。
  //
  // 造一条**真的会体检失败**的记忆（路径不存在），否则 flagged 恒为 0，
  // 这条用例会以「没有明细」为荣地通过 —— 那是在测空气。
  const add = await callRoute(ctx._routes.get('/api/anima/memory/add'), {
    method: 'POST',
    body: { text: '巡夜明细用例：路径 D:\\这个目录一定不存在\\anima-probe.txt 已经不在了', note: '来自测试' }
  })
  assert.equal(add.status, 200)
  const st = await callRoute(ctx._routes.get('/api/anima/state'))
  const target = st.payload.memories.pending.find((m) => m.text.includes('anima-probe.txt'))
  assert.ok(target, '造出来的候选不在缓冲区里')
  await callRoute(ctx._routes.get('/api/anima/memory/decide'), {
    method: 'POST',
    body: { id: target.id, decision: 'adopt' }
  })

  const patrol = await callRoute(ctx._routes.get('/api/anima/patrol'), { method: 'POST', body: {} })
  assert.equal(patrol.payload.ok, true, `巡夜失败：${patrol.payload?.error ?? ''}`)
  assert.ok(patrol.payload.verdict.facts.flagged > 0, '造的路径不存在却没被体检点到，用例前提不成立')

  const state = await callRoute(ctx._routes.get('/api/anima/state'))
  const meta = state.payload.patrolMeta
  const items = meta.flaggedItems
  assert.ok(Array.isArray(items), '明细没落盘（或 schema 又把它剥掉了）⇒ 界面只剩数字')
  assert.ok(items.length > 0, 'facts.flagged > 0 却没有明细，两者自相矛盾')
  const mine = items.find((item) => item.id === target.id)
  assert.ok(mine, '刚被点到的那条记忆不在明细里')
  assert.ok(mine.detail && mine.detail.length > 0, '明细没有 detail ⇒ 界面上是一行空白')
  assert.ok(Array.isArray(mine.kinds) && mine.kinds.length > 0, '明细没写是哪类问题')
  assert.equal(typeof meta.flaggedDropped, 'number', '「丢了几条」必须落盘，否则截断是静默的')

  // 收尾：删掉这条记忆，避免影响后续用例的指纹与体检计数。
  await callRoute(ctx._routes.get('/api/anima/memory/delete'), { method: 'POST', body: { id: target.id } })
})

await test('巡夜明细：没问题时不写空数组，明细必须是 null（空清单 ≠ 有清单但都空）', async () => {
  const patrol = await callRoute(ctx._routes.get('/api/anima/patrol'), { method: 'POST', body: {} })
  assert.equal(patrol.payload.ok, true)
  const state = await callRoute(ctx._routes.get('/api/anima/state'))
  const meta = state.payload.patrolMeta
  if (meta.facts.flagged === 0) {
    // 上一条用例已把那条坏路径记忆删掉。这时必须没有明细 —— 写个 [] 会让界面
    // 画出「这次体检点到了：」然后下面一片空白，看起来像渲染坏了。
    assert.equal(meta.flaggedItems, null, `flagged=0 却写下了明细：${JSON.stringify(meta.flaggedItems)}`)
  } else {
    // 别的用例可能在缓冲区里留了有问题的记忆。那就如实要求明细与数字对得上，
    // 而不是让这条用例因为前提不成立而假通过。
    const items = Array.isArray(meta.flaggedItems) ? meta.flaggedItems : []
    assert.ok(items.length > 0, `flagged=${meta.facts.flagged} 却没有明细，两者自相矛盾`)
  }
})


await test('导入提交的 added 是记录数组，与 rejected 同形（不是计数）', async () => {
  // 这条用例存在的理由：曾经服务端回 `added: added.length`（数字），而设置页按
  // `response.added.length` 读 ⇒ 成功提示恒显示「已导入 0 条」。冒烟夹具当时手写成
  // 数组，正好把服务端与客户端的不一致掩盖过去。所以这里必须**真跑路由**、
  // 断言的是路由真返回的形状，而不是我们自己塞给客户端的夹具。
  const { status, payload } = await callRoute(ctx._routes.get('/api/anima/memory/import/commit'), {
    method: 'POST',
    body: {
      items: [
        { text: '导入用例的全局条目', layer: 'global' },
        { text: '导入用例的工作区条目', layer: 'workspace' }
      ]
    }
  })
  assert.equal(status, 200)
  assert.ok(Array.isArray(payload.added), `added 应是数组，实际 ${typeof payload.added}`)
  assert.equal(payload.added.length, 2)
  assert.ok(Array.isArray(payload.rejected), 'rejected 应是数组')
  // 每条都是完整记录：id / status / layer / source 齐备，调用方能直接拿来用。
  for (const record of payload.added) {
    assert.ok(record.id, '记录缺 id')
    assert.equal(record.status, 'pending', '导入的必须是待审候选，不能直接生效')
    assert.equal(record.source, 'import')
  }
  assert.equal(payload.added[1].layer, 'workspace', '用户改过的层级应原样落库')
  // 落库的确实是 pending：待审缓冲区里能找到它们，记忆段里找不到。
  const state = await callRoute(ctx._routes.get('/api/anima/state'))
  const found = state.payload.memories.pending.filter((m) => m.source === 'import')
  assert.ok(found.length >= 2, '导入的记录应进待审缓冲区')
  assert.equal(ctx._sections.get('anima:memory').text({}).includes('导入用例的全局条目'), false,
    '未裁决的导入候选不该进提示词')
})

await test('导入提交对无效条目逐条拒绝，不整批失败', async () => {
  const { status, payload } = await callRoute(ctx._routes.get('/api/anima/memory/import/commit'), {
    method: 'POST',
    body: {
      items: [
        { text: '正常条目', layer: 'global' },
        { text: '我的 key 是 sk-abcdefghijklmnopqrstuvwx', layer: 'global' }
      ]
    }
  })
  assert.equal(status, 200, '一条被拒不该让整批 400')
  assert.equal(payload.added.length, 1)
  assert.equal(payload.rejected.length, 1)
  assert.match(payload.rejected[0].error, /凭据/, '被拒原因要说清是命中了凭据闸门')
})

console.log('\n[预设与预览]')

await test('GET /presets 返回内置 6 条（内置在前）', async () => {
  const { status, payload } = await callRoute(ctx._routes.get('/api/anima/presets'))
  assert.equal(status, 200)
  assert.equal(payload.presets.length, 6)
  assert.equal(payload.presets[0].id.startsWith('builtin:'), true, '内置应排在前面')
  assert.ok(payload.presets[0].name)
})

await test('套用内置预设只覆盖它声明的字段，其余保持用户当前值', async () => {
  const before = (await callRoute(ctx._routes.get('/api/anima/state'))).payload.config
  // 内置预设刻意不填 agentName —— 套用它不该把 AI 名字清空。
  const { status, payload } = await callRoute(ctx._routes.get('/api/anima/presets/apply'), {
    method: 'POST',
    body: { id: 'builtin:concise' }
  })
  assert.equal(status, 200)
  // v3 起预设字段值是现成文案，不再是枚举键。
  assert.equal(payload.config.style, '高效干练；走最短路径给答案，能省的字都省，不重复用户已经说过的话。')
  assert.equal(payload.config.replyLength, '简洁；直击要点，不展开背景与推理过程。')
  assert.equal(payload.config.agentName, before.agentName, '预设未声明的字段不该被动到')
  // 复原，避免影响后续用例对风格段的断言。
  await callRoute(ctx._routes.get('/api/anima/config'), {
    method: 'POST',
    body: { style: before.style, replyLength: before.replyLength }
  })
})

await test('套用不存在的预设返回 404 且不改配置', async () => {
  const before = (await callRoute(ctx._routes.get('/api/anima/state'))).payload.config.style
  const { status } = await callRoute(ctx._routes.get('/api/anima/presets/apply'), {
    method: 'POST',
    body: { id: 'builtin:no-such-preset' }
  })
  assert.equal(status, 404)
  const after = (await callRoute(ctx._routes.get('/api/anima/state'))).payload.config.style
  assert.equal(after, before)
})

await test('保存自建预设 → 出现在列表 → 可删除', async () => {
  const saved = await callRoute(ctx._routes.get('/api/anima/presets/save'), {
    method: 'POST',
    body: { preset: { name: '测试档', description: '冒烟用', fields: { style: 'casual', emoji: 'more' } } }
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.payload.presets.length, 7)
  const mine = saved.payload.presets.find((p) => p.name === '测试档')
  assert.ok(mine, '自建预设未出现在列表里')
  assert.equal(mine.fields.style, 'casual')

  const removed = await callRoute(ctx._routes.get('/api/anima/presets/delete'), {
    method: 'POST',
    body: { id: mine.id }
  })
  assert.equal(removed.status, 200)
  assert.equal(removed.payload.presets.length, 6)
})

await test('内置预设不可删除（防止把 6 套内置删没了）', async () => {
  const { status, payload } = await callRoute(ctx._routes.get('/api/anima/presets/delete'), {
    method: 'POST',
    body: { id: 'builtin:precise' }
  })
  assert.equal(status, 400)
  assert.match(payload.error, /内置/)
})

await test('重名内置预设被拒（否则用户永远挑不到内置的那套）', async () => {
  const { status, payload } = await callRoute(ctx._routes.get('/api/anima/presets/save'), {
    method: 'POST',
    body: { preset: { name: '极简主义', fields: { style: 'efficient' } } }
  })
  assert.equal(status, 400)
  assert.match(payload.error, /预设校验失败/)
})

await test('预览：未带草稿字段时 draft=false，按已保存配置渲染', async () => {
  const { status, payload } = await callRoute(ctx._routes.get('/api/anima/preview'))
  assert.equal(status, 200)
  assert.equal(payload.draft, false)
  assert.ok(payload.persona.includes('## 回复风格'), '应渲染出风格段')
  assert.equal(typeof payload.sections.identity, 'string')
  assert.ok(payload.description, '缺字段来源说明')
})

await test('预览：带草稿字段时无需保存即可看到结果（draft=true）', async () => {
  const { status, payload } = await callRoute(ctx._routes.get('/api/anima/preview'), {
    url: '/api/anima/preview?agentName=%E9%A2%84%E8%A7%88%E5%90%8D'
  })
  assert.equal(status, 200)
  assert.equal(payload.draft, true)
  assert.match(payload.persona, /预览名/)
  // 关键：草稿只是预览，绝不能落到配置里。
  const config = (await callRoute(ctx._routes.get('/api/anima/state'))).payload.config
  assert.equal(config.agentName === '预览名', false, '预览不该写盘')
})

await test('预览：草稿值是自由文本，超长才被忽略而不是报错', async () => {
  // 预览是只读展示，不该因为用户打到一半的字或超长草稿而报错。
  const { status, payload } = await callRoute(ctx._routes.get('/api/anima/preview'), {
    url: '/api/anima/preview?style=一段还没定稿的说明&agentName=x'
  })
  assert.equal(status, 200)
  assert.equal(payload.draft, true)
  assert.equal(payload.effective.style, '一段还没定稿的说明')
  assert.equal(payload.effective.agentName, 'x')

  // 超过 style 上限（800）的草稿被忽略，落回全局已保存值。
  const config = (await callRoute(ctx._routes.get('/api/anima/state'))).payload.config
  const tooLong = await callRoute(ctx._routes.get('/api/anima/preview'), {
    url: `/api/anima/preview?style=${'x'.repeat(801)}`
  })
  assert.equal(tooLong.status, 200)
  assert.equal(tooLong.payload.effective.style, config.style)
})

await test('工作区覆盖：写覆盖后该工作区生效、全局不变', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'anima-ws-'))
  try {
    // 无覆盖时走全局
    const before = ctx._sections.get('anima:identity')
    const ctxFor = (cwd) => ({ agent: { session: { header: { cwd } } } })
    assert.match(before.text(ctxFor(ws)), /小沃/)

    const saved = await callRoute(ctx._routes.get('/api/anima/workspace'), {
      method: 'POST',
      body: { workspacePath: ws, overrides: { agentName: '工作区小沃' } }
    })
    assert.equal(saved.status, 200)

    // 该工作区拿到覆盖值
    assert.match(before.text(ctxFor(ws)), /工作区小沃/)
    // 其它目录仍是全局值
    const other = await mkdtemp(join(tmpdir(), 'anima-other-'))
    try {
      assert.match(before.text(ctxFor(other)), /小沃/)
      assert.equal(before.text(ctxFor(other)).includes('工作区小沃'), false)
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

await test('工作区覆盖可被清除（空 overrides 即删除文件）', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'anima-ws2-'))
  try {
    const ctxFor = { agent: { session: { header: { cwd: ws } } } }
    await callRoute(ctx._routes.get('/api/anima/workspace'), {
      method: 'POST',
      body: { workspacePath: ws, overrides: { agentName: '临时名' } }
    })
    const identity = ctx._sections.get('anima:identity')
    assert.match(identity.text(ctxFor), /临时名/)

    await callRoute(ctx._routes.get('/api/anima/workspace'), {
      method: 'POST',
      body: { workspacePath: ws, overrides: {} }
    })
    assert.equal(identity.text(ctxFor).includes('临时名'), false)
    assert.match(identity.text(ctxFor), /小沃/)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

await test('持久化：换一个进程（新域句柄）仍读到同一份数据', async () => {
  // 域后端下「落盘」由 storage 介质承担，插件自己不再写文件 —— 所以这条用例
  // 不能再像文件后端时代那样「另造一个 StateStore 读同一个文件」：真实 facility
  // 强制单开同名域，对已打开的域再 open 会抛 already open。
  // 现在的模拟方式是「进程重启」：把已打开域的内容快照成新介质的初始内容，
  // 再用一份新的 ctx（StateStore 只用到 get('storageDomain')/effect/logger 三项）
  // 造一个新的 StateStore，等价于重启后重新读介质。
  const seed = snapshotDomain(ctx.get('storageDomain'), 'anima')
  assert.ok(seed.config.length > 0, '前置条件：域里应已有 config 记录')

  const restarted = {
    logger: ctx.logger,
    // 介质戳取当前域实际打开的版本 —— 与真实介质一样，版本戳是介质自带的属性，
    // 不是插件每次启动重新盖章的东西。
    get: (name) => (name === 'storageDomain' ? makeStorageDomain(seed, domainVersionOf(ctx)) : undefined),
    effect: () => () => {}
  }
  const fresh = new (await import(`../lib/store.mjs?t=${Date.now()}`)).StateStore(restarted, ctx.logger)
  const config = await fresh.getConfig()
  assert.equal(config.agentName, '小沃')
  const all = await fresh.listMemories()
  assert.ok(all.some((r) => r.status === 'adopted'))
  assert.equal(fresh.srcReason, null, '介质读得到数据时不应报不可用原因')
  assert.equal(fresh.srcDomainVersion, domainVersionOf(ctx), '介质戳与应用写的版本一致时应原样打开')
})

// ==================== 人设变更审计日志 ====================
// 这组用例回答的是「谁把人设改了」——本插件有三个写入入口（设置页 / 命令 /
// 模型工具），而工具确认默认关闭，模型可以直接改。日志必须能分辨这三者。
//
// 放在这组的位置有讲究：它前面的用例已经把人设调成基准值，后面的 403 用例
// 又断言 agentName === '小沃'，所以本组结束时必须把人设恢复原样。
console.log('\n[审计日志]')

const auditRoute = () => ctx._routes.get('/api/anima/audit')

await test('设置页改人设 → 审计记下 actor=user/source=settings 与前后值', async () => {
  const before = (await callRoute(auditRoute())).payload
  // 不钉具体旧值：前面若干用例已经动过这个字段。取「改之前那一刻」的真实值来比。
  const beforeConfig = (await callRoute(ctx._routes.get('/api/anima/config'))).payload.config
  const saved = await callRoute(ctx._routes.get('/api/anima/config'), {
    method: 'POST',
    body: { agentRole: '审计探针角色' }
  })
  assert.equal(saved.status, 200)
  const after = (await callRoute(auditRoute())).payload
  assert.equal(after.total, before.total + 1, '应恰好新增一条')
  const entry = after.entries[after.entries.length - 1]
  assert.equal(entry.actor, 'user')
  assert.equal(entry.source, 'settings')
  const change = entry.changes.find((c) => c.key === 'agentRole')
  assert.ok(change, '应记下 agentRole 这一项')
  assert.equal(change.to, '审计探针角色')
  assert.equal(change.from, beforeConfig.agentRole ?? null, 'from 应是改动前的真实值')
  assert.notEqual(change.from, undefined, '取不到旧值时必须是 null，不能是 undefined')
})

await test('模型工具改人设 → actor=agent/source=tool（这正是这份日志存在的理由）', async () => {
  const tool = ctx._tools.find((t) => t.name === 'set_assistant_persona')
  assert.ok(tool, '前置条件：人设工具已注册')
  // 确认模式开着时工具只提提议，所以先关掉它，走「直接写入」那条路径
  await callRoute(ctx._routes.get('/api/anima/config'), {
    method: 'POST',
    body: { requireToolConfirmation: false }
  })
  await tool.execute({ customInstructions: '审计探针指令' })
  const payload = (await callRoute(auditRoute())).payload
  const entry = payload.entries[payload.entries.length - 1]
  assert.equal(entry.actor, 'agent')
  assert.equal(entry.source, 'tool')
  assert.ok(entry.changes.some((c) => c.key === 'customInstructions' && c.to === '审计探针指令'))
})

await test('提议确认路径记为 source=proposal（区分「模型提的」与「人改的」）', async () => {
  const tool = ctx._tools.find((t) => t.name === 'set_assistant_persona')
  await callRoute(ctx._routes.get('/api/anima/config'), {
    method: 'POST',
    body: { requireToolConfirmation: true }
  })
  const proposed = await tool.execute({ agentName: '提议中的名字' })
  assert.equal(proposed.pending, true, '确认模式下应只提提议')
  const confirmed = await callRoute(ctx._routes.get('/api/anima/proposal'), {
    method: 'POST',
    body: { action: 'confirm' }
  })
  assert.equal(confirmed.status, 200)
  const payload = (await callRoute(auditRoute())).payload
  const entry = payload.entries[payload.entries.length - 1]
  assert.equal(entry.source, 'proposal')
  assert.equal(entry.actor, 'user', '确认动作是用户做的，但来源是提议')
  assert.ok(entry.changes.some((c) => c.key === 'agentName' && c.to === '提议中的名字'))
})

await test('重置也留痕（否则「昨天的设置今天全空了」查无此事）', async () => {
  const before = (await callRoute(auditRoute())).payload.total
  await callRoute(ctx._routes.get('/api/anima/config/reset'), {
    method: 'POST',
    body: { confirm: true }
  })
  const payload = (await callRoute(auditRoute())).payload
  assert.equal(payload.total, before + 1)
  const entry = payload.entries[payload.entries.length - 1]
  assert.equal(entry.source, 'reset')
  assert.equal(entry.actor, 'user')
  assert.ok(entry.changes.length > 0, '重置应至少记下一项被清空的字段')
})

await test('审计随 state 下发尾部 20 条，并带来源中文化表', async () => {
  const payload = (await callRoute(ctx._routes.get('/api/anima/state'))).payload
  assert.ok(Array.isArray(payload.audit.entries))
  assert.ok(payload.audit.entries.length <= 20)
  assert.ok(payload.audit.total >= payload.audit.entries.length)
  assert.equal(payload.audit.max, 200)
  assert.equal(payload.audit.sourceText.settings, '设置页')
  assert.equal(payload.audit.sourceText.tool, '模型工具')
  assert.deepEqual(payload.audit.actors, ['user', 'agent', 'system'])
})

await test('超长值被截断（日志是给人扫一眼的，不是备份）', async () => {
  const long = '长'.repeat(300)
  await callRoute(ctx._routes.get('/api/anima/config'), {
    method: 'POST',
    body: { customInstructions: long }
  })
  const payload = (await callRoute(auditRoute())).payload
  const entry = payload.entries[payload.entries.length - 1]
  const change = entry.changes.find((c) => c.key === 'customInstructions')
  assert.ok(change.to.length < long.length, '超长值应被截断')
  assert.match(change.to, /…（共 300 字）$/)
})

await test('无实际变化时不写审计（否则日志会被空改动淹没）', async () => {
  const before = (await callRoute(auditRoute())).payload
  const tool = ctx._tools.find((t) => t.name === 'set_assistant_persona')
  // 与当前值相同 ⇒ 工具自身就判「没有要更改的设置」，不应产生记录
  const current = (await callRoute(ctx._routes.get('/api/anima/config'))).payload.config
  await tool.execute({ agentName: current.agentName ?? '' })
  const after = (await callRoute(auditRoute())).payload
  assert.equal(after.total, before.total)
})

await test('memory.x 复合键能取到值（不拆键就会记成 undefined，等于没记）', async () => {
  // 用快照 + 新域句柄在旁路上验，避免改动主流程的状态
  const seed = snapshotDomain(ctx.get('storageDomain'), 'anima')
  const side = {
    logger: ctx.logger,
    get: (name) => (name === 'storageDomain' ? makeStorageDomain(seed, domainVersionOf(ctx)) : undefined),
    effect: () => () => {}
  }
  const store = new (await import(`../lib/store.mjs?t=${Date.now()}`)).StateStore(side, ctx.logger)
  const { config } = await store.updateConfig({ memory: { enabled: false } }, { actor: 'user', source: 'settings' })
  assert.equal(config.memory.enabled, false)
  const entries = await store.listAudit()
  const entry = entries[entries.length - 1]
  const change = entry.changes.find((c) => c.key === 'memory.enabled')
  assert.ok(change, '应有一条 memory.enabled 记录')
  assert.equal(change.from, true, 'from 必须是拆键后取到的旧值')
  assert.equal(change.to, false)
})

await test('DELETE /audit 可清空；清空后 total 归零', async () => {
  const cleared = await callRoute(auditRoute(), { method: 'DELETE' })
  assert.equal(cleared.status, 200)
  assert.ok(cleared.payload.removed > 0, '应删掉了若干条')
  const after = (await callRoute(auditRoute())).payload
  assert.equal(after.total, 0)
  assert.deepEqual(after.entries, [])
})

await test('持久化：换一个进程（新域句柄）后审计仍读得到', async () => {
  await callRoute(ctx._routes.get('/api/anima/config'), {
    method: 'POST',
    body: { agentRole: '重启后应还在的审计' }
  })
  const seed = snapshotDomain(ctx.get('storageDomain'), 'anima')
  const restarted = {
    logger: ctx.logger,
    get: (name) => (name === 'storageDomain' ? makeStorageDomain(seed, domainVersionOf(ctx)) : undefined),
    effect: () => () => {}
  }
  const fresh = new (await import(`../lib/store.mjs?t=${Date.now()}`)).StateStore(restarted, ctx.logger)
  const entries = await fresh.listAudit()
  assert.ok(entries.length > 0, '重启后审计记录应仍在')
  assert.ok(entries[0].id, '每条都应有 id')
  assert.ok(Array.isArray(entries[0].changes))
})

// 恢复基准值：下面的 403 用例断言 agentName === '小沃'
await callRoute(ctx._routes.get('/api/anima/config'), {
  method: 'POST',
  body: { agentName: '小沃' }
})

// 回归：路由 disposer 必须被留住并在卸载时调用。
// 丢掉 disposer 时，宿主里插件停用后旧闭包仍挂在全局路由表上继续应答 ——
// 表现为 500 而不是 404，极易被误判成「插件还在运行」。这条断言跑在本套件最后，
// 因为它会真的触发一次卸载。
// 回归：路由必须自己守卫来源。宿主 webserver 不带鉴权（README 原文
// "no server-wide TLS, authentication, or origin policy"），而这些路由
// 读写人设配置与记忆正文，所以非同源/非回环请求必须被 403 挡下。
// 本组用例跑在卸载之前。
await test('非回环来源的请求被 403 拒绝', async () => {
  const { status, payload } = await callRoute(ctx._routes.get('/api/anima/state'), {
    remoteAddress: '192.168.1.50'
  })
  assert.equal(status, 403, '局域网来源不应拿到配置')
  assert.equal(payload.ok, false)
})

await test('跨站来源的请求被 403 拒绝', async () => {
  const { status } = await callRoute(ctx._routes.get('/api/anima/config'), {
    method: 'POST',
    body: { agentName: '攻击者' },
    origin: 'https://evil.example'
  })
  assert.equal(status, 403)
  // 且没有真的写进去
  const state = await callRoute(ctx._routes.get('/api/anima/state'))
  assert.equal(state.payload.config.agentName, '小沃')
})

await test('Origin 与 Host 不一致的请求被 403 拒绝', async () => {
  const { status } = await callRoute(ctx._routes.get('/api/anima/state'), {
    origin: 'http://127.0.0.1:9999',
    host: '127.0.0.1:19387'
  })
  assert.equal(status, 403)
})

await test('本机同源请求正常放行', async () => {
  const { status } = await callRoute(ctx._routes.get('/api/anima/state'))
  assert.equal(status, 200)
})

// ==================== 回扫式复盘 ====================
//
// 这一组必须自己造会话日志：临时目录里没有 sessions/，真去扫会得到
// 「会话目录不存在」—— 那样测的是失败路径，不是被测逻辑。
// 造一份真的 zstd 分帧日志（跟宿主写出来的形状一致），才走得到判据。

const { mkdir, writeFile } = await import('node:fs/promises')
const { zstdCompressSync } = await import('node:zlib')

/** 按宿主的帧格式写一个会话日志：每行一个事件，每帧一个 zstd 块。 */
async function writeSessionFixture(home, events) {
  const dir = join(home, 'sessions', '--fixture--', 'session-0000')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  const frame = zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n'))
  await writeFile(file, frame)
  return file
}

const fixtureHome = await mkdtemp(join(tmpdir(), 'anima-retro-'))
const prevFixtureHome = process.env.DSH_HOME
await writeSessionFixture(fixtureHome, [
  // 真用户发言，应当被捞出来
  {
    type: 'user/message',
    seq: 10,
    time: Date.parse('2026-11-04T10:13:24.360Z'),
    data: {
      content: [{ type: 'text', text: '我有没有说过不允许一直往c盘写东西' }],
      source: { kind: 'user', rpcId: 'rpc-1' }
    }
  },
  // 任务板下发的卡片：source.kind 也是 user，但不是人说的
  {
    type: 'user/message',
    seq: 11,
    time: Date.parse('2026-11-04T10:20:00.000Z'),
    data: {
      content: [{ type: 'text', text: '不要调用任何工具，不要读文件' }],
      source: { kind: 'user', rpcId: 'task-board-29385011' }
    }
  },
  // 与第一条同文但换个标点：去重键要能认出来
  {
    type: 'user/message',
    seq: 12,
    time: Date.parse('2026-11-04T11:00:00.000Z'),
    data: {
      content: [{ type: 'text', text: '我有没有说过不允许一直往c盘写东西。' }],
      source: { kind: 'user', rpcId: 'rpc-2' }
    }
  }
])
process.env.DSH_HOME = fixtureHome

// 回扫默认是关的（它要读磁盘上的会话日志，不该默认替用户开）。
// 这组用例要测的是**打开之后**的行为，所以先照用户的路径把它打开 ——
// 顺便验证了「设置里能打开」这件事本身，而不是绕过闸门直接调内部函数。
await test('复盘开关：默认关闭时必须明说「关着」，不能装作跑了', async () => {
  const { status, payload } = await callRoute(ctx._routes.get('/api/anima/retrospect'), { method: 'POST', body: {} })
  // 状态码跟着 ok 走（与 /api/anima/patrol 同一条约定）：关着就回 400，不回 200。
  assert.equal(status, 400, '关着却回 200，调用方会以为扫过了')
  assert.equal(payload.ok, false, '关着却报成功，用户会以为扫过了')
  assert.match(String(payload.error), /已关闭/, '错误里必须说清是「关了」而不是「坏了」')
})

await test('复盘开关：设置页能把它打开（否则这个开关就是个装饰）', async () => {
  const { status } = await callRoute(ctx._routes.get('/api/anima/config'), {
    method: 'POST',
    body: { memory: { retrospectEnabled: true, retrospectDays: 14 } }
  })
  assert.equal(status, 200, '打开回扫失败')
  const state = await callRoute(ctx._routes.get('/api/anima/state'))
  assert.equal(state.payload.config.memory.retrospectEnabled, true, '打开了却没存进去')
  assert.equal(state.payload.config.memory.retrospectDays, 14)
})

await test('复盘：真线索捞得出来，噪音与重复句不会混进来', async () => {
  const { status, payload } = await callRoute(ctx._routes.get('/api/anima/retrospect'), { method: 'POST', body: {} })
  assert.equal(status, 200, `复盘接口失败：${payload?.error ?? ''}`)
  assert.equal(payload.ok, true, `复盘失败：${payload?.error ?? ''}`)
  assert.ok(payload.at, '没写时间就等于没留痕')
  assert.equal(payload.files, 1, '应当只扫到那 1 个主会话')
  assert.equal(payload.verdict.newLeads.length, 1, `应当只剩 1 条线索，实际 ${payload.verdict.newLeads.length}`)
  assert.equal(payload.verdict.newLeads[0].kind, 'complaint')
  assert.equal(payload.verdict.newLeads[0].seq, 10, '线索必须带得出出处 seq')
  assert.match(payload.verdict.newLeads[0].sessionRef, /session-0000/, '线索必须带得出会话标识')
})

await test('复盘留痕：state 下发 retrospectMeta，且字段与这次一致', async () => {
  const payload = (await callRoute(ctx._routes.get('/api/anima/retrospect'), { method: 'POST', body: {} })).payload
  const state = await callRoute(ctx._routes.get('/api/anima/state'))
  const meta = state.payload.retrospectMeta
  assert.ok(meta, 'state 必须下发 retrospectMeta，否则用户无从反查')
  assert.equal(meta.scannedAt, payload.at, '下发的记录必须就是这次写的那条')
  assert.equal(meta.scannedDays, 14, '回扫窗口应当就是配置里的默认值')
  // 「扫了 0 个会话」与「扫了 1 个会话 0 条线索」是两件不同的事。
  assert.equal(typeof meta.files, 'number', 'files 必须是数字（0 也是数字），不能是 null')
  assert.equal(typeof meta.messages, 'number')
  assert.ok(Array.isArray(meta.leadKeys), '已报过的键必须累积，否则下一轮会重复报')
})

await test('复盘：第二轮不重复报同一条线索', async () => {
  // 不能靠换 DSH_HOME 造「头一回」：存储栈已经开在那个 home 上，
  // 换环境变量只影响扫哪个目录，不影响 meta 里已经记过的键。
  // 所以这里往同一个 home 里再放一条**没报过**的线索，用「只有它算新的」来验去重。
  const extraDir = join(fixtureHome, 'sessions', '--fixture2--', 'session-0001')
  await mkdir(extraDir, { recursive: true })
  await writeFile(
    join(extraDir, 'session.v4.jsonl.zstd'),
    zstdCompressSync(Buffer.from(JSON.stringify({
      type: 'user/message',
      seq: 20,
      time: Date.parse('2026-11-05T09:00:00.000Z'),
      data: {
        content: [{ type: 'text', text: '我说过多少次不要动我的浏览器' }],
        source: { kind: 'user', rpcId: 'rpc-3' }
      }
    }) + '\n'))
  )
  const first = (await callRoute(ctx._routes.get('/api/anima/retrospect'), { method: 'POST', body: {} })).payload
  const second = (await callRoute(ctx._routes.get('/api/anima/retrospect'), { method: 'POST', body: {} })).payload
  assert.equal(first.verdict.shouldReport, true, '前置条件：这条没人报过，第一轮应当算新')
  assert.equal(first.verdict.newLeads.length, 1, `第一轮应当只捞到这条新的，实际 ${first.verdict.newLeads.length}`)
  assert.equal(second.verdict.shouldReport, false, '同一批线索第二轮不该再报一遍')
  assert.equal(second.verdict.newLeads.length, 0)
  await rm(join(fixtureHome, 'sessions', '--fixture2--'), { recursive: true, force: true })
})

await test('复盘不写记忆库：它只产线索，裁决必须由用户点', async () => {
  const before = await callRoute(ctx._routes.get('/api/anima/state'))
  const strip = (s) => JSON.stringify([s.payload.memories.pending.length, s.payload.memories.adopted.length])
  const b = strip(before)
  await callRoute(ctx._routes.get('/api/anima/retrospect'), { method: 'POST', body: {} })
  const after = await callRoute(ctx._routes.get('/api/anima/state'))
  assert.equal(strip(after), b, '复盘自动写进了记忆库 —— 那是用户没说过的话')
})

await test('/anima 复盘：命令行能跑，且说清这轮到底有没有提示', async () => {
  const command = ctx._commands.find((c) => c.name === 'anima')
  const result = await command.handler({ rawInput: '复盘' })
  assert.equal(result.kind, 'success', `命令失败：${result.text}`)
  assert.match(result.text, /复盘完成/)
  assert.match(result.text, /meta\.retrospect/, '要告诉用户这条记录在哪，否则「可反查」是空话')
  // 与 /anima patrol 同一条纪律：没出声就要解释为什么没出声。
  assert.match(result.text, /没有新线索|已提示/, '必须说清这轮到底有没有提示')
})

await test('复盘：会话目录不存在时如实报错并留痕，不能伪装成「扫过没事」', async () => {
  const emptyHome = await mkdtemp(join(tmpdir(), 'anima-nosessions-'))
  process.env.DSH_HOME = emptyHome
  try {
    const { payload } = await callRoute(ctx._routes.get('/api/anima/retrospect'), { method: 'POST', body: {} })
    assert.equal(payload.ok, false, '目录都不存在却报成功，就是在撒谎')
    assert.match(String(payload.error), /会话目录不存在/, '错误里必须说清是「找不到目录」，而不是含糊的失败')
    const state = await callRoute(ctx._routes.get('/api/anima/state'))
    const meta = state.payload.retrospectMeta
    assert.ok(meta, '失败也必须留痕，否则「没记录」=「没跑」和「跑挂了」混在一起')
    assert.ok(meta.error, '失败原因必须落盘')
    assert.equal(meta.delivered, 0)
    assert.equal(meta.files, null, '没扫成时 files 必须是 null，不能写成 0（那就成了「扫了 0 个」）')
  } finally {
    process.env.DSH_HOME = prevFixtureHome
    await rm(emptyHome, { recursive: true, force: true })
  }
})

process.env.DSH_HOME = prevFixtureHome
await rm(fixtureHome, { recursive: true, force: true })



// ==================== 存储栈未组合时的降级 ====================
// 这组用例是 2026-10-10 那次无声退化的直接防线：当时 apply 阶段一次性 ctx.get()
// 取不到 storageDomain 就悄悄换到文件后端，用户填的人设从运行态读出来是空的，
// 而 /state 只给出一个 kind:'file'，排查全靠猜。
// 现在的契约是「失败大声」：不换落盘点，返回结构化失败 + 可读原因 + 组合指引。
console.log('\n[存储栈未组合]')

const bareHome = await mkdtemp(join(tmpdir(), 'anima-bare-'))
const barePlugin = await import(`../index.mjs?bare=${Date.now()}`)
const bareCtx = makeCtx(bareHome, { withStorage: false })
process.env.DSH_HOME = bareHome

await test('没有 storageDomain 时插件照常装载（不把 profile 卡在 pending）', async () => {
  await barePlugin.apply(bareCtx)
  assert.ok(bareCtx._sections.has('anima:identity'), '三段 section 仍应注册')
  // 刻意不钉死条数：每加一条路由都要回来改这个数字，而这条用例想证明的只是
  // 「存储栈缺席时路由照样注册齐全」。改为点名核对关键路由（含只读的 store 三张表入口）。
  for (const path of [
    '/api/anima/state',
    '/api/anima/config',
    '/api/anima/memory/decide',
    '/api/anima/memory/import/parse',
    '/api/anima/memory/import/commit'
  ]) {
    assert.ok(bareCtx._routes.has(path), `存储不可用时仍应注册 ${path}`)
  }
})

await test('未装载成功时三段 section 返回空串（宁可不注入，也不冒充默认档）', () => {
  const identity = bareCtx._sections.get('anima:identity')
  assert.equal(identity.text({}), '', '存储不可用时不得注入默认档人设')
  assert.equal(bareCtx._sections.get('anima:memory').text({}), '')
  assert.equal(bareCtx._sections.get('anima:pending').text({}), '')
  // 质检段同样不能凭空注入：规则存在不代表当前会话已被这套配置接管。
  assert.equal(bareCtx._sections.get('anima:quality').text({}), '')
})

await test('存储不可用时 /state 返回 503 + 机器可读原因 + 组合指引', async () => {
  const { status, payload } = await callRoute(bareCtx._routes.get('/api/anima/state'))
  assert.equal(status, 503, '应把 503 透出去（而不是 500 空壳）')
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'storage-not-composed')
  assert.equal(payload.source.kind, null)
  assert.equal(payload.source.reason, 'storage-not-composed')
  assert.match(payload.source.message, /storage/, '原因里应给出组合指引')
  assert.equal(payload.loaded, false)
})

await test('存储不可用时命令 show 明说「未打开」而不是假装有后端', async () => {
  const command = bareCtx._commands.find((c) => c.name === 'anima')
  const result = await command.handler({ argv: ['show'], raw: '/anima show' })
  const text = result?.text ?? String(result)
  assert.match(text, /存储：未打开/)
  assert.match(text, /storage-not-composed/)
})

await test('storageDomain 晚一会出现时自动重试并装载成功', async () => {
  // 真机冷启动就是这个形状：dsh-storage-domain 在自己的 ctx.inject 回调里 provide，
  // 插件 apply 跑完时它还没出现。这里用假 ctx 的 _provide 复刻那一刻。
  assert.equal(bareCtx._pendingInjects.length > 0, true, '前置条件：应挂着等待 storageDomain 的 inject')
  bareCtx._provide('storageDomain', makeStorageDomain())
  await new Promise((r) => setTimeout(r, 20))

  const { status, payload } = await callRoute(bareCtx._routes.get('/api/anima/state'))
  assert.equal(status, 200, '就绪后应能正常读到状态')
  assert.equal(payload.source.kind, 'storage')
  assert.equal(payload.source.reason, null)
  assert.ok(bareCtx._sections.get('anima:identity').text({}).length > 0, '就绪后应开始注入人设')
})

await rm(bareHome, { recursive: true, force: true })

await test('卸载时摘除全部路由（不把 disposer 丢掉）', async () => {
  assert.ok(ctx._routes.size > 0, '前置条件：装载后应有路由')
  await ctx._dispose()
  assert.equal(ctx._routes.size, 0, `卸载后仍有 ${ctx._routes.size} 条路由残留`)
})

console.log('\n[警告]')
if (ctx._warnings.length > 0) {
  for (const message of ctx._warnings) console.log(`  warn  ${message}`)
} else {
  console.log('  （无）')
}

console.log('')
if (failures.length > 0) {
  console.log(`FAILED ${failures.length} / ${passed + failures.length}`)
  process.exitCode = 1
} else {
  console.log(`PASSED all ${passed}`)
}

// [存储栈未组合] 那组用的是独立 ctx，主 ctx 的卸载断言已在上面跑过，这里只收尾不重复断言。
await bareCtx._dispose()
