// scripts/check-live.mjs — 运行态验收（需要 DSH 正在跑，且插件已装进 profile）
//
// 运行：node scripts/check-live.mjs [origin]
// 退出码：0 全通过；1 有失败；2 连不上宿主。
//
// 为什么需要它：其余四套测试都在进程外跑纯函数或假宿主，
// 只能证明「代码是这么写的」，证明不了「宿主真的加载了这一版」——
// 曾经发生过装机副本是旧版、13 条路由只注册了 8 条、而所有单测全绿的情况。
// 本脚本断言的是**进程里那份**代码的实际行为。

const origin = process.argv[2] || 'http://127.0.0.1:19387'
const failures = []
let passed = 0

function check(name, fn) {
  try {
    const r = fn()
    if (r instanceof Error) throw r
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push([name, err])
    console.log(`  FAIL ${name}\n       ${err?.message || err}`)
  }
}

async function get(path) {
  const response = await fetch(origin + path)
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* 非 JSON 响应留给断言报错 */ }
  return { status: response.status, text, body }
}

async function post(path, body) {
  const response = await fetch(origin + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await response.text()
  let payload = null
  try { payload = JSON.parse(text) } catch { /* 非 JSON 响应留给断言报错 */ }
  return { status: response.status, text, body: payload }
}

let state = null
let preview = null
let presets = null
let audit = null

console.log(`[运行态] ${origin}`)

try {
  state = await get('/api/anima/state')
} catch (err) {
  console.log(`\n连不上宿主（${origin}）：${err?.message || err}`)
  console.log('确认 DSH 正在运行，且端口与 webserver 配置一致。')
  process.exit(2)
}
preview = await get('/api/anima/preview')
presets = await get('/api/anima/presets')
// 只读一次审计：这里刻意不碰 DELETE（本脚本跑在用户的真实数据上）。
audit = await get('/api/anima/audit')

console.log('\n[路由已注册]')

// 401 是宿主对**未注册路径**的兜底响应，不是鉴权门 —— 这正说明路由没进路由表。
check('/api/anima/state 返回 200', () => {
  if (state.status !== 200) throw new Error(`实际 ${state.status}`)
})

check('/api/anima/preview 返回 200（旧版只有 401）', () => {
  if (preview.status !== 200) throw new Error(`实际 ${preview.status}（未注册或未加载新版）`)
})

check('/api/anima/presets 返回 200（旧版只有 401）', () => {
  if (presets.status !== 200) throw new Error(`实际 ${presets.status}（未注册或未加载新版）`)
})

// 这条路由是「模型改人设」的确认出口（配合工具确认门槛），旧版没有。
// 没有待确认提议时它应当回 404 + 我们自己的文案 —— 不能靠状态码判定注册与否
// （未注册路径走宿主兜底 401），所以连 body 文案一起断言。
{
  const probe = await post('/api/anima/proposal', { action: 'reject' })
  check('/api/anima/proposal 已注册（无提议时 404 + 自家文案）', () => {
    if (probe.status === 401) throw new Error('401 = 宿主兜底，路由没注册（仍跑旧代码）')
    if (probe.status !== 404) {
      throw new Error(`实际 ${probe.status}：${probe.text.slice(0, 120)}`)
    }
    if (!String(probe.body?.error ?? '').includes('待确认')) {
      throw new Error(`404 的 body 不是本插件的文案：${probe.text.slice(0, 120)}`)
    }
  })
}

if (state.status === 200 && state.body) {
  const body = state.body

  console.log('\n[新代码已生效]')

  check('state.limits.overridable 是 12 项（旧版 3 项）', () => {
    const list = body.limits?.overridable
    if (!Array.isArray(list)) throw new Error('没有 overridable 数组')
    if (list.length !== 12) throw new Error(`实际 ${list.length} 项：${list.join(', ')}`)
  })

  check('state 顶层含 presets（旧版没有）', () => {
    if (!('presets' in body)) throw new Error('缺 presets 键')
  })

  // 融合 dsh-soul 后新增的两个契约：模型能改哪些字段（toolFields），
  // 以及「模型提了改动、等用户点头」的那条提议（无提议时必须是 null 而不是缺键）。
  check('state.limits.toolFields 是 12 项（模型可改的人设字段）', () => {
    const list = body.limits?.toolFields
    if (!Array.isArray(list)) throw new Error('没有 toolFields 数组')
    if (list.length !== 12) throw new Error(`实际 ${list.length} 项：${list.join(', ')}`)
  })

  check('state 顶层含 pendingProposal 键（无提议时为 null）', () => {
    if (!('pendingProposal' in body)) throw new Error('缺 pendingProposal 键（宿主仍跑旧代码）')
    if (body.pendingProposal !== null && typeof body.pendingProposal !== 'object') {
      throw new Error(`pendingProposal 形态异常：${JSON.stringify(body.pendingProposal)}`)
    }
  })

  check('光轨与工具确认四项已在 config 里落盘（融合 dsh-soul 的新字段）', () => {
    const config = body.config ?? {}
    const missing = ['requireToolConfirmation', 'trailEnabled', 'trailColor', 'trailSpeed', 'trailWidth']
      .filter((key) => !(key in config))
    if (missing.length > 0) throw new Error(`缺字段：${missing.join(', ')}`)
    if (typeof config.requireToolConfirmation !== 'boolean') {
      throw new Error(`requireToolConfirmation 不是布尔：${JSON.stringify(config.requireToolConfirmation)}`)
    }
    if (typeof config.trailEnabled !== 'boolean') {
      throw new Error(`trailEnabled 不是布尔：${JSON.stringify(config.trailEnabled)}`)
    }
    if (!/^#[0-9A-F]{6}$/.test(String(config.trailColor))) {
      throw new Error(`trailColor 不是规范化的 #RRGGBB：${JSON.stringify(config.trailColor)}`)
    }
  })

  check('state.source.kind 是 storage（全局配置跟人不跟项目）', () => {
    if (body.source?.kind !== 'storage') {
      // reason 由 lib/store.mjs 的 StateStore 写入（失败时的错误码）。
      // 2026-10-10 那次无声退化时配置里只有一个 kind:'file'，排查全靠猜，
      // 所以这里必须把它和 message 一起带出来。
      const why = body.source?.reason ?? '（旧版没有 reason 字段）'
      const detail = body.source?.message ? `：${body.source.message}` : ''
      throw new Error(`实际 ${body.source?.kind}，退化原因：${why}${detail}`)
    }
  })

  check('storage 后端下 source.reason 为 null（新诊断字段）', () => {
    if (!('reason' in (body.source ?? {}))) throw new Error('source 里没有 reason 字段（宿主仍跑旧代码）')
    if (body.source.reason !== null) throw new Error(`实际 ${JSON.stringify(body.source.reason)}`)
  })

  // 域打开时的格式戳。它同时是「插件真的把域打开了」的信号：null 表示域没打开。
  check('source.domainVersion 是正整数（说明插件真的打开了存储域）', () => {
    if (!('domainVersion' in (body.source ?? {}))) {
      throw new Error('source 里没有 domainVersion 字段（宿主仍跑旧代码）')
    }
    const v = body.source.domainVersion
    if (!Number.isInteger(v) || v < 1) throw new Error(`实际 ${JSON.stringify(v)}`)
  })

  // 下面两条合起来才能证明「跑的是本版代码」。
  //
  // 为什么不能只断言「格式戳是正整数」就完事：改名前的旧版会下发
  // `source.domainVersionCurrent`（那时域版本是 3，且存在兼容回退，界面要拿它
  // 判断「介质是不是旧的」），而本版已把该字段整个删除 —— 格式戳恒等于
  // DOMAIN_VERSION，没有第二个数可比较。所以「存在 domainVersionCurrent」
  // 恰恰是旧代码的指纹。
  //
  // 2026-10-14 实测到过这种情形：旧代码打开了被改成 v1 的介质，domainVersion=1
  // 通过了上面那条，看上去一切正常，实际跑的是改名前的代码。
  check('source 不含 domainVersionCurrent（本版删掉了兼容回退的比较基准）', () => {
    if ('domainVersionCurrent' in (body.source ?? {})) {
      throw new Error(
        `source 里仍有 domainVersionCurrent=${JSON.stringify(body.source.domainVersionCurrent)}`
        + ' —— 宿主仍跑改名前的旧代码（旧版有 v3 + 兼容回退）'
      )
    }
  })

  check('source.domainVersion 恒等于 1（本版统一的存储格式戳）', () => {
    if (body.source?.domainVersion !== 1) {
      throw new Error(
        `实际 ${JSON.stringify(body.source?.domainVersion)} —— 介质或代码不是本版`
        + '（介质戳要用 lib/store.mjs 的 DOMAIN_VERSION 对齐；已无兼容回退）'
      )
    }
  })

  check('state.loaded 为 true（三段 section 有内容可注入）', () => {
    if (body.loaded !== true) throw new Error(`实际 ${JSON.stringify(body.loaded)}`)
  })

  console.log('\n[用户数据没丢]')

  // 名字是**用户资产**，不该被脚本钉成某个具体值 —— 2026-10-11 用户把
  // 「小沃」改成「大肥鱼」后，这里曾误报 FAIL。断言改成「非空 + 相邻字段没被
  // 重置连坐」：真正要防的是「数据丢了」，不是「用户改了名」。
  check('agentName 非空（存储里有名字，不是被重置过）', () => {
    const name = body.config?.agentName
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error(`agentName 是空的 —— 可能被重置过`)
    }
  })

  check('addressUserAs 仍是「老大」', () => {
    if (body.config?.addressUserAs !== '老大') throw new Error(`实际 '${body.config?.addressUserAs}'`)
  })

  check('agentRole 非空', () => {
    if (!body.config?.agentRole) throw new Error('agentRole 是空的')
  })

  // 断言的是「必需字段一个不少」，不是「正好 N 项」——
  // 记忆段会随着功能长出新键（v2 加了 maxInjectedChars 与 defaultLayer），
  // 钉死项数会让每一次新增都变成一条假失败，而假失败会训练人忽略这个脚本。
  check('memory 设置段含全部 9 个必需键', () => {
    const required = [
      'enabled', 'autoCapture', 'nightlyTriage', 'nightlyHour',
      'maxPending', 'maxInjected', 'maxInjectedChars', 'notifyOnSessionStart', 'defaultLayer'
    ]
    const memory = body.config?.memory ?? {}
    const missing = required.filter((key) => !(key in memory))
    if (missing.length > 0) throw new Error(`缺 ${missing.join(', ')}（实际 ${Object.keys(memory).length} 项）`)
  })

  check('workspaceFileDir 仍是 .dsh-anima', () => {
    if (body.config?.workspaceFileDir !== '.dsh-anima') {
      throw new Error(`实际 '${body.config?.workspaceFileDir}'`)
    }
  })
}

if (presets.status === 200 && presets.body) {
  console.log('\n[人设预设]')

  check('6 条内置预设且内置在前', () => {
    const list = presets.body.presets
    if (!Array.isArray(list)) throw new Error('没有 presets 数组')
    const builtin = list.filter((p) => String(p.id).startsWith('builtin:'))
    if (builtin.length !== 6) throw new Error(`内置 ${builtin.length} 条，应为 6 条`)
    if (!String(list[0]?.id).startsWith('builtin:')) throw new Error(`首条不是内置：${list[0]?.id}`)
  })
}

// ── 变更记录（第 ④ 项创新点）──
//
// 这条路由的价值不在「有内容」而在「内容可核对」：它记录的是**每一版之前**
// 谁改了什么，所以断言的重点是结构（字段名 / 取值域 / 来源词典），
// 而不是某条具体记录 —— 那取决于用户自己点过什么，脚本无权假定。
if (audit.status === 200 && audit.body) {
  console.log('\n[变更记录]')

  check('entries 是数组、total 与之一致', () => {
    const body = audit.body
    if (!Array.isArray(body.entries)) throw new Error('entries 不是数组')
    if (typeof body.total !== 'number') throw new Error(`total 不是数字：${JSON.stringify(body.total)}`)
    if (body.total < body.entries.length) {
      throw new Error(`total(${body.total}) 小于返回条数(${body.entries.length})`)
    }
  })

  check('每条记录的 actor 都在取值域内', () => {
    const allowed = new Set(['user', 'agent', 'system'])
    for (const entry of audit.body.entries) {
      if (!allowed.has(entry.actor)) throw new Error(`越界的 actor：${JSON.stringify(entry.actor)}`)
      if (!Array.isArray(entry.changes) || entry.changes.length === 0) {
        throw new Error(`空变更记录不该落盘：${JSON.stringify(entry)}`)
      }
      if (typeof entry.at !== 'string' || Number.isNaN(Date.parse(entry.at))) {
        throw new Error(`at 不是合法时间：${JSON.stringify(entry.at)}`)
      }
    }
  })

  // 摘要（presets 这类）会把原值截成 `[N 项]`，此时 from === to 是**正常**的，
  // 界面上只显示一次；这里只要求键存在，不去断言两者必不相同。
  check('源词典与改动者词典都下发了（界面靠它翻译，不给原始值）', () => {
    const body = audit.body
    if (!body.sourceText || typeof body.sourceText !== 'object') throw new Error('缺 sourceText')
    if (!body.sourceText.settings) throw new Error('sourceText 里没有 settings')
    if (!Array.isArray(body.actors) || body.actors.length !== 3) {
      throw new Error(`actors 应为 3 项：${JSON.stringify(body.actors)}`)
    }
  })

  check('state 里也带了审计尾部（少一次可能挂起的往返）', () => {
    const tail = state.body?.audit
    if (!tail || typeof tail !== 'object') throw new Error('state 里没有 audit 段')
    if (typeof tail.total !== 'number') throw new Error('state.audit.total 不是数字')
    if (!Array.isArray(tail.entries)) throw new Error('state.audit.entries 不是数组')
  })
} else if (audit.status === 401) {
  console.log('\n[变更记录]')
  check('/api/anima/audit 已注册（旧版只有 401 兜底）', () => {
    throw new Error('401 = 宿主兜底，路由没进路由表（仍跑旧代码）')
  })
}

if (preview.status === 200 && preview.body) {
  console.log('\n[提示词装配]')

  // 同理不钉具体名字：断言「存储里的名字真的出现在 persona 里」——
  // 这才是要验的链路（配置 → 提示词装配），而非某个特定值。
  check('persona 返回全文，且包含存储里的人设名字', () => {
    const persona = preview.body.persona
    if (typeof persona !== 'string' || !persona) throw new Error('persona 为空')
    const name = state.body?.config?.agentName
    if (!name) throw new Error('存储里没有 agentName，无法比对')
    if (!persona.includes(name)) {
      throw new Error(`persona 里没有「${name}」：${persona.slice(0, 80)}`)
    }
  })

  check('preview 未带草稿字段时 draft=false', () => {
    if (preview.body.draft !== false) throw new Error(`实际 draft=${preview.body.draft}`)
  })

  check('preview 的 sections 含身份段', () => {
    const sections = preview.body.sections
    if (!sections || typeof sections.identity !== 'string') throw new Error('缺 sections.identity')
    if (!sections.identity) throw new Error('身份段是空的')
  })
}

console.log('\n[导入外部记忆的入口]')

// 两条导入路由是本版新增的功能面，其余四套测试都只能证明「代码是这么写的」。
// 这里全程走**零副作用探针**：parse 不写存储；commit 只提交一条必然被凭据闸门
// 拦下的文本 ⇒ `added` 为空、`rejected` 一条，存储一个字节都不写。
{
  const parsed = await post('/api/anima/memory/import/parse', {
    text: '- 结论先行，先给答案再给依据。\n\n- 这个项目用 pnpm，不要用 npm。'
  })

  check('/api/anima/memory/import/parse 返回 200 且切出条目', () => {
    if (parsed.status === 401) throw new Error('401 = 宿主兜底，路由没注册（仍跑旧代码）')
    if (parsed.status !== 200) throw new Error(`实际 ${parsed.status}：${parsed.text.slice(0, 120)}`)
    if (!Array.isArray(parsed.body?.items)) throw new Error('缺 items 数组')
    if (parsed.body.items.length !== 2) throw new Error(`应切出 2 条，实际 ${parsed.body.items.length}`)
    if (typeof parsed.body?.counts?.accepted !== 'number') throw new Error('缺 counts.accepted')
  })

  check('parse 的每条都带层级建议与理由', () => {
    for (const item of parsed.body?.items ?? []) {
      if (item.layer !== 'global' && item.layer !== 'workspace') throw new Error(`layer 非法：${item.layer}`)
      if (typeof item.reason !== 'string' || !item.reason) throw new Error('缺归类理由')
      if (item.confidence !== 'high' && item.confidence !== 'low') {
        throw new Error(`confidence 非法：${item.confidence}`)
      }
    }
  })

  // 必然被凭据闸门拦下：断言「拦得住」，同时把返回形态钉死。
  const committed = await post('/api/anima/memory/import/commit', {
    items: [{ text: 'api_key = sk-abcdefghijklmnopqrstuvwxyz012345', layer: 'global' }]
  })

  check('commit 回 added 是数组、与 rejected 同形（不是计数）', () => {
    if (committed.status !== 200) throw new Error(`实际 ${committed.status}：${committed.text.slice(0, 120)}`)
    if (!Array.isArray(committed.body?.added)) {
      // 这一条同时是「你重启了吗」的探测器：宿主进程启动时间早于本次重装时，
      // 它加载的还是上一版模块，契约自然会退回旧的数字形态。
      throw new Error(
        `added 应是数组，实际 ${typeof committed.body?.added}（值 ${JSON.stringify(committed.body?.added)}）`
        + ' —— 设置页按 .length 读，会恒显示「已导入 0 条」。'
        + '若源码与装机副本都已是数组，说明宿主仍在跑重装前加载的模块，重启即可。'
      )
    }
    if (!Array.isArray(committed.body?.rejected)) throw new Error('缺 rejected 数组')
  })

  check('凭据闸门在提交阶段也拦得住（存储未被写入）', () => {
    // 只看 rejected 与「有没有真写进去」，不假设 added 的形态：
    // 旧契约回数字时 added=0 恰恰表示「一条都没写」，它不该在失败信息里
    // 被说成「凭据被写进存储了」。
    const added = committed.body?.added
    const written = Array.isArray(added) ? added.length : added
    if (written !== 0) {
      throw new Error(`凭据文本被写进存储了：${JSON.stringify(added)}`)
    }
    if (committed.body?.rejected?.length !== 1) {
      throw new Error(`应拦下 1 条，实际 ${committed.body?.rejected?.length}`)
    }
  })

  const empty = await post('/api/anima/memory/import/commit', { items: [] })

  check('空 items 的提交被拒（400 + 自家文案）', () => {
    if (empty.status === 401) throw new Error('401 = 宿主兜底，路由没注册')
    if (empty.status !== 400) throw new Error(`实际 ${empty.status}：${empty.text.slice(0, 120)}`)
    if (!String(empty.body?.error ?? '').includes('没有要导入的条目')) {
      throw new Error(`400 的 body 不是本插件的文案：${empty.text.slice(0, 120)}`)
    }
  })
}

console.log('\n[破坏性路由的护栏]')

// 2026-10-10 的事故回归：我为确认路由是否注册，对写路由逐一 POST 空体 `{}`，
// `POST /config/reset` 当场 200 并把三个人设字段清空了。
//
// ⚠️ 这条断言本身就是一次**破坏性调用**：旧版代码收到空 body 就会真的重置。
// 所以它按「先存快照 → 探一次 → 若真被清空则立刻用快照恢复」的方式跑：
// 护栏有效 ⇒ 400，什么都不发生；护栏缺失 ⇒ 我们把损失收回来，然后判失败。
// 换句话说，这条断言在任何版本上都不会留下破坏。
{
  const before = (await get('/api/anima/state')).body
  const snapshot = before?.config ?? null

  const probe = await post('/api/anima/config/reset', {})

  check('空 body 的重置请求返回 400（不能凭默认值就执行）', () => {
    if (probe.status !== 400) throw new Error(`实际 ${probe.status}，body=${probe.text.slice(0, 120)}`)
    if (probe.body?.code !== 'confirmation-required') {
      throw new Error(`expected code=confirmation-required，实际 ${JSON.stringify(probe.body?.code)}`)
    }
  })

  const after = (await get('/api/anima/state')).body
  const keys = ['agentName', 'agentRole', 'addressUserAs', 'workspaceFileDir', 'workspaceOverridesEnabled']
  const drifted = keys.filter((k) => JSON.stringify(before?.config?.[k]) !== JSON.stringify(after?.config?.[k]))

  check('被拒的重置没有动过任何字段', () => {
    if (drifted.length > 0) throw new Error(`这些字段被改动了：${drifted.join(', ')}`)
  })

  // 真被清空就地把损失收回来 —— 慢一步的挽救，但不留下破坏。
  if (drifted.length > 0 && snapshot) {
    console.log(`  …  护栏缺失导致字段被清空，正在用探针前的快照恢复：${drifted.join(', ')}`)
    const restored = await post('/api/anima/config', snapshot)
    if (restored.status === 200) {
      console.log(`  …  已恢复：changed=${JSON.stringify(restored.body?.changed)}`)
    } else {
      console.log(`  …  ⚠️ 恢复失败（${restored.status}）：${restored.text.slice(0, 160)}`)
      console.log('  …  请手动到「设置 → 灵台」重填这三个字段。')
    }
  }
}

console.log('')
if (failures.length > 0) {
  console.log(`FAILED ${failures.length} / ${passed + failures.length}`)
  process.exitCode = 1
} else {
  console.log(`PASSED all ${passed}`)
}
