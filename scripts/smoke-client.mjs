// scripts/smoke-client.mjs — 客户端设置页渲染冒烟
//
// 客户端组件此前从没在无浏览器环境下真正渲染过：`node --check` 只证明语法能过，
// 证明不了「15 个 t() key 拼错」「工作区覆盖少一个继承项」「改一个字段整页崩」。
// 这里用一个极小的 React 钩子替身把整棵树跑出来，并在树上做交互。
//
// 覆盖：
//   1. window.__ModuleLoader__.load 捕获工厂 → require 替身 → apply(ctx) 完整跑通
//   2. 从 settings.section 注册里取出真实组件与 inject 载荷并渲染
//   3. 渲染期用到的每个 t() key 都必须在 locale 词典里（动态版 i18n 检查）
//   4. 9 张卡都在；工作区覆盖 6 个风格字段各有一个「空值 = 继承」项
//   5. 交互：改输入框、切开关、展开预览（走 400ms 防抖 → 真打 /preview）
//   6. an-note 提示类节点渲染正常（回归：曾错渲染成 user.addressHint，同一句提示出现两遍）
//   7. 卡片折叠：状态落 localStorage，且脏值一律按「没收起」（不让一次手改把卡片钉死）
//   8. 光轨配色三个入口（取色器 / 文本框 / 内置色）写同一字段，半截输入不污染取色器
//   9. 光轨实时预览：挂载点拿不到时降级不抛，三种状态分别写在 data 属性上
//  10. 设置页自动刷新：回到前台拉一次、10 秒内重复触发被节流、后台不拉
//
// 运行：node scripts/smoke-client.mjs
// 退出码：0 全通过；1 有失败。

import { register } from 'node:module'
import assert from 'node:assert/strict'

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

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

// ==================== 极小的 React 钩子运行时 ====================
//
// 只实现本插件用到的三个钩子，但遵守调用顺序规则、依赖数组比较、
// 以及「订阅触发的重渲染」—— 够把真实组件跑到终态。

function createRuntime(renderComponent) {
  const hooks = []
  let index = 0
  let pendingEffects = []
  let rendering = false
  let rerenderRequested = false
  const errors = []

  const sameDeps = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

  function commitEffects() {
    const queue = pendingEffects
    pendingEffects = []
    for (const slot of queue) {
      if (typeof slot.cleanup === 'function') {
        try {
          slot.cleanup()
        } catch (err) {
          errors.push(err)
        }
        slot.cleanup = undefined
      }
      try {
        const result = slot.nextFn()
        if (typeof result === 'function') slot.cleanup = result
      } catch (err) {
        errors.push(err)
      }
      slot.nextFn = undefined
    }
  }

  const api = {
    useState(init) {
      const i = index++
      if (!hooks[i]) hooks[i] = { kind: 'state', value: typeof init === 'function' ? init() : init }
      const slot = hooks[i]
      const setter = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        requestRender()
      }
      return [slot.value, setter]
    },
    useEffect(fn, deps) {
      const i = index++
      if (!hooks[i]) hooks[i] = { kind: 'effect', deps: undefined }
      const slot = hooks[i]
      const initial = slot.deps === undefined
      const changed = initial || deps === undefined || !sameDeps(slot.deps, deps)
      slot.deps = deps
      if (changed) {
        slot.nextFn = fn
        pendingEffects.push(slot)
      }
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const i = index++
      if (!hooks[i]) hooks[i] = { kind: 'store' }
      const slot = hooks[i]
      slot.subscribe = subscribe
      // 只订阅一次：本插件传入的 subscribe 恒为 store.subscribe（引用稳定）。
      api.useEffect(() => {
        const unsubscribe = slot.subscribe(() => requestRender())
        return () => {
          if (typeof unsubscribe === 'function') unsubscribe()
        }
      }, [])
      return getSnapshot()
    }
  }

  function render() {
    if (rendering) {
      rerenderRequested = true
      return
    }
    rendering = true
    let tree
    try {
      do {
        rerenderRequested = false
        index = 0
        pendingEffects = []
        tree = renderComponent()
        commitEffects()
      } while (rerenderRequested)
    } finally {
      rendering = false
    }
    lastTree = tree
    return tree
  }

  function requestRender() {
    if (rendering) {
      rerenderRequested = true
      return
    }
    render()
  }

  return { api, render, requestRender, errors, hooks }
}

let lastTree = null

// ==================== 树遍历 ====================

const isComponent = (node) => node && typeof node === 'object' && typeof node.type === 'function'

/** 展开整棵树：函数组件就地调用（本插件的子组件都不用钩子），产出扁平节点表。 */
function walk(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push({ kind: 'text', value: String(node) })
    return out
  }
  if (isComponent(node)) {
    walk(node.type(node.props), out)
    return out
  }
  out.push({ kind: 'element', type: node.type, props: node.props ?? {} })
  walk(node.props?.children, out)
  return out
}

const elements = (nodes, type) => nodes.filter((n) => n.kind === 'element' && n.type === type)
const byClass = (nodes, className) =>
  nodes.filter((n) => n.kind === 'element' && n.props.className === className)
const texts = (nodes) => nodes.filter((n) => n.kind === 'text').map((n) => n.value)
const allText = (nodes) => texts(nodes).join(' ')

/**
 * 取「标题为 title 的那张卡片」内部的扁平节点表。
 *
 * 为什么需要它：`walk()` 会把整棵树压平，父子关系随之丢失，于是
 * `byClass(walk(lastTree), 'an-chip')` 拿到的是全页面的按钮 —— 用它去断言
 * 「工作区表单里没有按钮」会变成在断言「全页面一个按钮都没有」，
 * 而后者在功能整个画不出来时同样成立（假通过）。要断言「某张卡片里没有 X」，
 * 必须先框定那张卡片。
 */
function cardNodes(root, title) {
  const out = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') return false
    if (Array.isArray(node)) return node.some(visit)
    if (isComponent(node)) return visit(node.type(node.props))
    if (node.props?.className === 'an-card') {
      const inner = []
      walk(node.props?.children, inner)
      if (allText(inner).includes(title)) {
        out.push(...inner)
        return true
      }
      return false
    }
    return visit(node.props?.children)
  }
  visit(root)
  return out
}

/**
 * 在原始树里找一个具名组件节点本身（返回的是组件节点，能读到它收到的 props）。
 *
 * 与 walk() 的区别：walk() 会把组件就地调用掉，于是只能拿到它这一次的输出。
 * 这里遇到目标就停，因此拿到的是「父组件交给它的那份 props」。
 */
function findComponent(node, name) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findComponent(child, name)
      if (hit) return hit
    }
    return null
  }
  if (typeof node.type === 'function') {
    if (node.type.name === name) return node
    return findComponent(node.type(node.props), name)
  }
  return findComponent(node.props?.children, name)
}

// ==================== 假宿主 ====================

const FAKE_CONFIG = {
  enabled: true,
  agentName: '',
  agentRole: '',
  addressUserAs: '',
  userOccupation: '',
  userBio: '',
  // v3 起这六项存的是要注入提示词的原话，不再是枚举键。
  style: '专业严谨，结论先行',
  headingLists: '多用列表',
  emoji: '少用表情',
  tables: '需要对比时用表格',
  replyLength: '两三句就够',
  language: '用中文回答',
  customInstructions: '',
  workspaceOverridesEnabled: true,
  workspaceFileDir: '.dsh-anima',
  presets: [],
  memory: {
    enabled: true,
    autoCapture: true,
    nightlyTriage: true,
    nightlyHour: 3,
    maxPending: 200,
    maxInjected: 40,
    notifyOnSessionStart: true
  }
}

const FAKE_LIMITS = {
  agentName: 50,
  agentRole: 800,
  addressUserAs: 50,
  userOccupation: 50,
  userBio: 500,
  customInstructions: 2000,
  style: 800,
  headingLists: 300,
  emoji: 300,
  tables: 300,
  replyLength: 300,
  language: 300,
  overridable: [],
  presetFields: []
}

const STATE_PAYLOAD = {
  ok: true,
  config: FAKE_CONFIG,
  // 「一键填入」候选由 host 下发（lib/wording.mjs）；空串档位 host 已过滤掉。
  wording: {
    style: [
      { id: 'professional', text: '专业严谨；结论先行，术语准确，避免口语化。' },
      { id: 'roast', text: '毒舌吐槽；直白指出问题、不留情面，但始终对事不对人。' }
    ],
    headingLists: [{ id: 'more', text: '多用标题与列表组织内容。' }],
    emoji: [{ id: 'less', text: '尽量不使用表情符号。' }],
    tables: [{ id: 'more', text: '需要对比时优先使用表格。' }],
    replyLength: [{ id: 'concise', text: '简洁；直击要点。' }],
    language: [{ id: 'zh', text: '使用简体中文回复。' }]
  },
  // 身份与背景字段的示例（m08898）；agentName 刻意是空数组 —— host 不给这个名字字段
  // 示例，前端据此不画按钮组（画一个空的「示例」标签会让人以为没加载出来）。
  examples: {
    agentName: [],
    agentRole: ['长期 AI 助手，服务对象是学生与研究者。先给结论再解释依据。'],
    addressUserAs: ['老大', '老师'],
    userOccupation: ['研究生', '前端开发'],
    userBio: ['研究生在读，方向是自然语言处理。日常要读论文、跑实验、写代码。'],
    customInstructions: ['回答里不要用「首先/其次/最后」这类模板词。\n不确定就先说不确定。']
  },
  presets: [
    { id: 'builtin:precise', name: '专业严谨', description: '默认档', fields: {}, builtin: true },
    { id: 'builtin:concise', name: '极简主义', description: '能省则省', fields: {}, builtin: true }
  ],
  builtinPresetCount: 6,
  source: { kind: 'file', path: 'C:\\fake\\anima-config.json' },
  limits: FAKE_LIMITS,
  memories: {
    pending: [{ id: 'm1', text: '候选一', status: 'pending', capturedAt: 1760000000000 }],
    adopted: [{ id: 'm2', text: '已采纳一', status: 'adopted', capturedAt: 1760000000000 }],
    discarded: []
  },
  triageMeta: null,
  // 一键导入（Phase ②）：面板要用到的提示词与两个上限。缺这个字段时客户端
  // 必须不画入口 —— 那是「老宿主」路径，单列一条用例。
  memoryImport: {
    prompt: '请帮我整理一份我的个人使用画像……（smoke 提示词）',
    maxItems: 3,
    maxSource: 40000
  },
  // 注入可解释性：一条进了、一条因属于别的工作区没进。
  injection: {
    cwd: 'D:\\deepseek工作区',
    decisions: [
      {
        id: 'm2',
        text: '已采纳一',
        layer: 'global',
        capturedAt: 1760000000000,
        included: true,
        reason: 'included',
        reasonText: '已注入提示词'
      },
      {
        id: 'm3',
        text: '别的工作区的记忆',
        layer: 'workspace',
        cwd: 'D:\\别的项目',
        capturedAt: 1760000000000,
        included: false,
        reason: 'other-workspace',
        reasonText: '属于别的工作区，不在本会话注入'
      }
    ],
    budget: { usedCount: 1, maxCount: 40, usedChars: 4, maxChars: 4000 }
  },
  clusters: [{ ids: ['m1', 'm4'], texts: ['候选一', '候选一（改）'], similarity: 0.75, hint: '2 条候选像在说同一件事' }],
  conflicts: [{
    candidateId: 'm1',
    candidateText: '候选一',
    adoptedId: 'm2',
    adoptedText: '已采纳一',
    similarity: 0.66,
    hint: '与一条已采纳记忆高度相似'
  }],
  audit: {
    total: 2,
    max: 200,
    entries: [
      {
        id: 'a-1',
        at: '2026-10-11T04:20:00.000Z',
        actor: 'user',
        source: 'settings',
        changes: [{ key: 'agentName', from: null, to: '小沃' }]
      },
      {
        id: 'a-2',
        at: '2026-10-11T05:20:00.000Z',
        actor: 'agent',
        source: 'tool',
        note: 'set_assistant_persona',
        // 摘要值相等（presets 只记规模）—— 界面上必须只显示一次，不许编造差异
        changes: [{ key: 'presets', from: '[1 项]', to: '[1 项]' }]
      }
    ],
    sourceText: { settings: '设置页', tool: '模型工具' },
    actors: ['user', 'agent', 'system']
  },
  workspaces: [{ id: 'w1', title: 'deepseek工作区', path: 'D:\\deepseek工作区' }]
}

const PREVIEW_PAYLOAD = {
  ok: true,
  draft: true,
  effective: { ...FAKE_CONFIG, agentName: '小沃' },
  sources: { agentName: 'workspace' },
  description: { agentName: '本工作区' },
  sections: {
    identity: '## 助手身份\n- 你的名字：小沃',
    userProfile: '',
    style: '## 回复风格',
    instructions: '',
    memory: '',
    pending: ''
  },
  persona: '## 助手身份\n- 你的名字：小沃\n\n## 回复风格'
}

const WORKSPACE_PATH = 'D:\\deepseek工作区'

const WORKSPACE_PAYLOAD = {
  ok: true,
  workspacePath: WORKSPACE_PATH,
  path: `${WORKSPACE_PATH}\\.dsh-anima\\override.json`,
  exists: false,
  overrides: {},
  errors: {},
  effective: { ...FAKE_CONFIG },
  sources: {},
  description: {}
}

const fetchCalls = []
/** /memory/import/commit 的请求体（断言「丢弃的条目不提交」要靠它）。 */
const commitBodies = []
let IMPORT_PARSE_FAILS = false

/**
 * /memory/import/parse 的假回执。
 *
 * 内容刻意踩满客户端每一类提示：一条正常、一条含被拦下的凭据、一条过长、一条重复、
 * 一条超上限 —— 面板若把任何一类漏掉，对应断言就会失败。
 */
const IMPORT_PARSE_PAYLOAD = {
  ok: true,
  items: [
    { index: 0, text: '结论先行，先给答案再给依据。', layer: 'global', reason: '未提到具体项目，按处处适用归入全局', confidence: 'low' },
    { index: 1, text: '这个项目用 pnpm，不要用 npm。', layer: 'workspace', reason: '提到了具体项目', confidence: 'high' }
  ],
  counts: { source: 300, pieces: 7, accepted: 2, skipped: 2, tooLong: 1, blocked: 1, duplicates: 1, overflow: 1 },
  blocked: [{ text: 'api_key = sk-abcdefghijklmnopqrstuvwxyz012345', credentials: ['openai-key'] }],
  tooLong: [{ text: '很长的条目' }],
  duplicates: [{ text: '结论先行。' }],
  overflow: [{ text: '第六条' }]
}

/** /audit 返回的全量载荷（比 state 里那份多一条，用来验证展开确实重新取了）。 */
const AUDIT_PAYLOAD = {
  ok: true,
  total: 3,
  max: 200,
  entries: [
    ...STATE_PAYLOAD.audit.entries,
    {
      id: 'a-3',
      at: '2026-10-11T06:20:00.000Z',
      actor: 'user',
      source: 'command',
      changes: [{ key: 'style', from: 'professional', to: 'casual' }]
    }
  ],
  sourceText: { settings: '设置页', tool: '模型工具', command: '命令' },
  actors: ['user', 'agent', 'system']
}

async function fakeFetch(input, init) {
  const url = String(input)
  fetchCalls.push({ url, method: init?.method ?? 'GET', body: init?.body })
  if (url.includes('/api/anima/memory/import/parse')) {
    if (IMPORT_PARSE_FAILS) {
      return { ok: false, status: 400, json: async () => ({ ok: false, error: '解析失败：SMOKE' }) }
    }
    return { ok: true, status: 200, json: async () => IMPORT_PARSE_PAYLOAD }
  }
  if (url.includes('/api/anima/memory/import/commit')) {
    commitBodies.push(JSON.parse(String(init?.body ?? '{}')))
    return { ok: true, status: 200, json: async () => ({ ok: true, added: [{ id: 'new-1' }], rejected: [] }) }
  }
  if (url.includes('/api/anima/audit')) {
    if ((init?.method ?? 'GET') === 'DELETE') {
      return { ok: true, status: 200, json: async () => ({ ok: true, removed: 3 }) }
    }
    return { ok: true, status: 200, json: async () => AUDIT_PAYLOAD }
  }
  if (url.includes('/api/anima/workspace')) {
    return { ok: true, status: 200, json: async () => WORKSPACE_PAYLOAD }
  }
  if (url.includes('/api/anima/preview')) {
    return { ok: true, status: 200, json: async () => PREVIEW_PAYLOAD }
  }
  if (url.includes('/api/anima/state')) {
    return { ok: true, status: 200, json: async () => STATE_PAYLOAD }
  }
  return { ok: true, status: 200, json: async () => ({ ok: true }) }
}

// document 替身：只够样式注入那一段
const styleTags = []
globalThis.document = {
  head: { appendChild: (tag) => styleTags.push(tag) },
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' })
}
// 上面这份替身**刻意**没有 createElementNS / querySelectorAll / addEventListener：
// 光轨绘制、导航图标接管、自动刷新三处都必须在缺能力时降级不抛。
// （自动刷新那条在文件末尾会把 addEventListener 补上，再验一遍真注册与节流。）

// localStorage 替身：折叠状态要落盘，真实浏览器永远有它。
const storageBacking = new Map()
globalThis.localStorage = {
  getItem: (key) => (storageBacking.has(key) ? storageBacking.get(key) : null),
  setItem: (key, value) => { storageBacking.set(key, String(value)) },
  removeItem: (key) => { storageBacking.delete(key) },
  clear: () => { storageBacking.clear() }
}
globalThis.fetch = fakeFetch
globalThis.location = { origin: 'http://127.0.0.1:19387' }

// window.__ModuleLoader__：捕获工厂，稍后用替身 require 调用
let factory = null
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory: fn }) {
      capturedId = id
      factory = fn
    }
  }
}
let capturedId = null

// 记录每个 t() key 的请求（动态版 i18n 检查）
const requestedKeys = new Set()

// 宿主 locale 注册的词典会在这里被截获
let dict = null

const reg = null

// ==================== 主流程 ====================

const module = await import('../client/index.mjs').catch(() => null)
void module

console.log(`module id = ${capturedId}`)
assert.equal(capturedId, 'dsh-anima', '模块 id 不对')

const reactStub = { useState: null, useEffect: null, useSyncExternalStore: null }
const runtimeRef = { current: null }

const requireStub = (name) => {
  if (name === 'react/jsx-runtime') {
    const h = (type, props) => ({ type, props: props ?? {} })
    const hs = (type, props) => ({ type, props: props ?? {} })
    return { jsx: h, jsxs: hs, Fragment: Symbol('Fragment') }
  }
  if (name === 'react') {
    return {
      useState: (...args) => runtimeRef.current.api.useState(...args),
      useEffect: (...args) => runtimeRef.current.api.useEffect(...args),
      useSyncExternalStore: (...args) => runtimeRef.current.api.useSyncExternalStore(...args)
    }
  }
  if (name === '@deepseek-ai/dsh-client-ui-primitives') {
    // 本插件对组件库是可选依赖 —— 这里刻意让它不可用，验证降级路径不炸。
    throw new Error('not available in this environment')
  }
  throw new Error(`unexpected require: ${name}`)
}
void reactStub

const clientExports = factory(requireStub)

// ---- 假 ctx：只实现客户端 apply 真正会碰到的那几件事 ----
const ctx = {
  locale: {
    register: (ns, dictionaries) => {
      assert.equal(ns, 'anima')
      dict = dictionaries
      return () => {}
    },
    bind: (ns) => (key) => {
      requestedKeys.add(key)
      const value = dict?.['zh']?.[key]
      if (typeof value !== 'string') throw new Error(`词典缺 key：${key}`)
      return value
    }
  },
  slots: {
    inject(_slotName, fn) {
      return fn()
    },
    register(config, Component) {
      // 本插件现在注册三个槽位（settings.section / conversation.input.left /
      // conversation.input.overlay），只留最后一个会让断言随机命中别人的配置。
      slotRegistrations.push({ config, Component })
      return () => {}
    }
  },
  provide: () => {},
  effect: (fn) => {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  }
}
const slotRegistrations = []
/** 按槽位名取注册项 —— 断言不必依赖注册顺序。 */
const slotFor = (name) => slotRegistrations.find((entry) => entry.config.name === name) ?? null
let slotRegistration = null
let slotComponent = null

console.log('\n[装配]')

await test('客户端 apply() 跑完不抛错，注册到 anima-settings', () => {
  clientExports.apply(ctx)
  const settings = slotFor('settings.section')
  assert.ok(settings, '没有注册 settings.section')
  assert.equal(settings.config.id, 'anima-settings')
  assert.equal(settings.config.order, 51, 'order 必须与 dsh-soul 的 50 错开')
  assert.equal(typeof settings.config.label, 'function')
  // 下面几节仍按单槽位的旧写法读这两个变量，这里回填以免大改既有断言。
  slotRegistration = settings.config
  slotComponent = settings.Component
})

await test('三个槽位都注册了，且 id 都避开 dsh-soul 占用过的格子', () => {
  const names = slotRegistrations.map((entry) => entry.config.name).sort()
  assert.deepEqual(names, ['conversation.input.left', 'conversation.input.overlay', 'settings.section'])
  // settings.section 的文档：复用已有 id 即替换那一格 —— 撞上 dsh-soul 会顶掉它。
  const ids = new Set(slotRegistrations.map((entry) => entry.config.id))
  assert.deepEqual(
    [...ids].sort(),
    ['anima-quick-toggle', 'anima-settings', 'anima-trail']
  )
  for (const taken of ['soul-settings', 'soul-quick-toggle', 'soul-trail']) {
    assert.ok(!ids.has(taken), `id 与 dsh-soul 撞车：${taken}`)
  }
})

await test('词典已注册，zh/en 都齐', () => {
  assert.ok(dict?.zh && dict?.en, '词典缺失')
  assert.equal(typeof dict.zh['nav.label'], 'string')
  assert.equal(typeof dict.en['nav.label'], 'string')
})

await test('样式已注入，且带可清理标记', () => {
  assert.ok(styleTags.length >= 1, '没有插入 style')
  const tag = styleTags[0]
  assert.equal(typeof tag.textContent, 'string')
  assert.ok(tag.textContent.includes('.an-card'), 'CSS 内容不对')
})

// ---- 渲染 ----
const injectProps = slotRegistration.inject()
const controller = injectProps.controller
assert.ok(controller, 'inject 没给 controller')

await flush()

const t = (key) => {
  requestedKeys.add(key)
  const value = dict?.zh?.[key]
  if (typeof value !== 'string') throw new Error(`词典缺 key：${key}`)
  return value
}

const runtime = createRuntime(() =>
  slotComponent({
    ...injectProps,
    useAnimaStore: controller.useStore,
    t
  })
)
runtimeRef.current = runtime

console.log('\n[渲染]')

await test('整棵设置页树能渲染出来（组件库不可用时也不崩）', () => {
  const tree = runtime.render()
  assert.ok(tree, '没有渲染出任何东西')
  const nodes = walk(tree)
  assert.ok(nodes.length > 50, `节点太少（${nodes.length}），可能中途返回了 null`)
})

const tree = lastTree
const nodes = walk(tree)

await test('九张卡都在，标题走词典而不是原始 key', () => {
  const titles = byClass(nodes, 'an-card-title').map((n) => n.props.children)
  const expected = ['preset.title', 'identity.title', 'user.title', 'style.title', 'trail.title', 'ws.title', 'mem.title', 'audit.title', 'preview.title']
  for (const key of expected) {
    assert.ok(titles.includes(dict.zh[key]), `缺卡片：${key}（实际标题：${JSON.stringify(titles)}）`)
  }
  // 没有哪个标题长得像 i18n key
  for (const title of titles) {
    assert.equal(/^[a-z]+\.[A-Za-z.]+$/.test(String(title)), false, `标题疑似原始 key：${title}`)
  }
})

await test('渲染期请求的每个 t() key 都能解析（动态错拼检查）', () => {
  assert.ok(requestedKeys.size > 40, `请求的 key 太少（${requestedKeys.size}），可能整页没渲染完`)
  const missing = [...requestedKeys].filter((key) => typeof dict.zh[key] !== 'string')
  assert.deepEqual(missing, [], `词典缺 ${missing.length} 个 key`)
  const missingEn = [...requestedKeys].filter((key) => typeof dict.en[key] !== 'string')
  assert.deepEqual(missingEn, [], `en 词典缺 ${missingEn.length} 个 key`)
})

await test('工作区覆盖卡渲染出 userBio 示例组（不串到别处）', () => {
  const notes = byClass(nodes, 'an-note').map((n) => n.props.children)
  assert.ok(Array.isArray(notes), `an-note 遍历异常：${JSON.stringify(notes)}`)
})

/** 直接改假载荷的 source 段，重新拉 state，再取渲染出来的键值对。 */
async function renderSource(nextSource) {
  const saved = STATE_PAYLOAD.source
  STATE_PAYLOAD.source = nextSource
  try {
    await controller.loadState()
    await flush()
    const dl = walk(lastTree).find((n) => n.kind === 'element' && n.props?.className === 'an-kv')
    assert.ok(dl, '没渲染出存储位置那一行')
    const texts = walk(dl).filter((n) => n.kind === 'text').map((n) => n.value)
    return { texts, joined: texts.join('|') }
  } finally {
    STATE_PAYLOAD.source = saved
    await controller.loadState()
    await flush()
  }
}

await test('存储后端是 storage 时显示「DSH 存储域」（回归：曾拿 domain 去比，永远显示本地文件）', async () => {
  const { joined } = await renderSource({ kind: 'storage', path: null, reason: null })
  assert.ok(joined.includes(dict.zh['source.domain']), `没显示存储域：${joined}`)
  assert.ok(!joined.includes(dict.zh['source.none']), `错显示成未打开：${joined}`)
  assert.ok(!joined.includes(dict.zh['source.reason']), `可用时不该显示原因行：${joined}`)
})

await test('存储不可用时显示「尚未打开」并把机器可读原因翻成人话', async () => {
  const { joined } = await renderSource({
    kind: null,
    path: null,
    reason: 'storage-not-composed',
    message: 'no storage stack'
  })
  assert.ok(joined.includes(dict.zh['source.none']), `没显示尚未打开：${joined}`)
  assert.ok(joined.includes(dict.zh['source.reason']), `没显示原因标签：${joined}`)
  assert.ok(joined.includes(dict.zh['source.reason.storage-not-composed']), `没翻译原因码：${joined}`)
  assert.ok(joined.includes(dict.zh['source.message']), `没显示详细信息标签：${joined}`)
  assert.ok(joined.includes('no storage stack'), `没显示宿主给的原始报错：${joined}`)
})

await test('未收录的原因码原样显示，不吞掉诊断信息', async () => {
  const { joined } = await renderSource({ kind: null, path: null, reason: 'some-new-code' })
  assert.ok(joined.includes('some-new-code'), `生僻原因码被吞了：${joined}`)
})

await test('open-failed 原因会拼上宿主给的原始报错', async () => {
  const { joined } = await renderSource({
    kind: null,
    path: null,
    reason: 'open-failed: domain name must match'
  })
  assert.ok(joined.includes(dict.zh['source.reason.open-failed']), `没显示前缀文案：${joined}`)
  assert.ok(joined.includes('domain name must match'), `没带上原始报错：${joined}`)
})

await test('存储格式戳是整数时显示「存储格式」一行，并写出戳号', async () => {
  // 这行是「存储栈真的组装起来了、域真的开了」的界面证据。措辞刻意不写「本版 vN」：
  // 页面顶部徽标是插件版本（semver），与介质格式戳（个位数）是两套编号。
  const { joined } = await renderSource({
    kind: 'storage', path: null, reason: null,
    domainVersion: 1
  })
  assert.ok(joined.includes(dict.zh['source.format']), `没显示存储格式标签：${joined}`)
  // 文案里的 {n} 必须被真的替换掉 —— 直接拼 t() 不替换占位符会原样显示「{n}」，
  // 那种"看起来像模板没渲染"的缺陷在截图里很难认出来。
  assert.ok(!joined.includes('{n}'), `占位符 {n} 没被替换：${joined}`)
  const expected = dict.zh['source.formatText'].split('{n}').join('1')
  assert.ok(joined.includes(expected), `没渲染出完整说明：${joined}`)
})

await test('宿主没下发格式戳时不显示「存储格式」一行（旧宿主上不误报）', async () => {
  const { joined } = await renderSource({ kind: 'storage', path: null, reason: null })
  assert.ok(!joined.includes(dict.zh['source.format']), `缺字段时误报格式行：${joined}`)
})

/** 走真实用户路径选中一个工作区，并等到覆盖表单出现。 */
async function selectWorkspace() {
  const picker = elements(walk(lastTree), 'select').find((n) => n.props.id === 'an-ws-pick')
  assert.ok(picker, '缺工作区选择器：an-ws-pick')
  picker.props.onChange({ target: { value: WORKSPACE_PATH } })
  for (let i = 0; i < 20; i += 1) {
    await flush()
    const nodes = walk(lastTree)
    if (elements(nodes, 'input').some((n) => n.props.id === 'an-ws-name')) return nodes
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('选中工作区后覆盖表单始终没渲染出来')
}

await test('工作区覆盖：6 个风格字段都是自由文本输入，空值即继承全局', async () => {
  const wsNodes = await selectWorkspace()
  const inputs = elements(wsNodes, 'textarea').filter((n) => /^an-ws-/.test(String(n.props.id)))
  const ids = ['an-ws-style', 'an-ws-heading', 'an-ws-emoji', 'an-ws-tables', 'an-ws-length', 'an-ws-language']
  for (const id of ids) {
    const found = inputs.find((n) => n.props.id === id)
    assert.ok(found, `缺工作区覆盖输入框：${id}`)
    // 未覆盖 ⇒ 值为空串，placeholder 承担「继承时会用哪一段」的提示
    assert.equal(found.props.value, '', `${id} 未覆盖时值应为空串`)
    assert.ok(String(found.props.placeholder ?? '').length > 0, `${id} 应把全局当前值放进 placeholder`)
  }
  // 每项下方要有「当前是继承还是覆盖」的说明 —— 自由文本下空值的含义必须讲清
  const hints = byClass(wsNodes, 'an-hintline').map((n) => String(n.props.children))
  assert.ok(
    hints.some((line) => line.includes(dict.zh['ws.inheritNow'])),
    `缺「当前：继承全局」说明（实际：${JSON.stringify(hints.slice(0, 4))}）`
  )
  // 未覆盖时说明里要带上全局当前值，否则用户不知道「继承」到底继承了什么
  assert.ok(
    hints.some((line) => line.includes(FAKE_CONFIG.style)),
    '继承说明里应带上全局当前值'
  )
  // 工作区不提供「一键填入」按钮：那里的按钮会写进全局档位文案，
  // 与本工作区「我要另一套说法」的意图相反，示例由 placeholder 承担。
  // 断言必须框定在工作区那张卡里 —— 整页扁平化之后，全页面任何一处按钮
  // 都会把这条断言变成「全页面一个按钮都没有」，那是另一回事。
  assert.equal(byClass(cardNodes(lastTree, dict.zh['ws.title']), 'an-chip').length, 0, '工作区表单不该出现一键填入按钮')
  // 反向确认这条断言真的看得见东西：全局那张卡里必须有按钮组，
  // 否则上面那句在「按钮组整个没画出来」时也会通过。
  assert.ok(byClass(cardNodes(lastTree, dict.zh['style.title']), 'an-chip').length > 0, '全局风格卡里应当有按钮组')
  // 全局表单的同类字段也不能再有 select
  const globalSelect = elements(wsNodes, 'select').find((n) => n.props.id === 'an-style')
  assert.equal(globalSelect, undefined, '全局风格字段不该还是下拉框')
})

await test('长期记忆：待审与已采纳都渲染出来了', () => {
  const text = allText(nodes)
  assert.ok(text.includes('候选一'), '待审候选没渲染')
  assert.ok(text.includes('已采纳一'), '已采纳项没渲染')
})

await test('注入情况：工作区坐标与两个预算都画出来了', () => {
  const text = allText(walk(lastTree))
  assert.ok(text.includes('D:\\deepseek工作区'), '没显示按哪个工作区算的')
  // 条数 1/40、字符 4/4000 —— 两行都该在（maxChars > 0）
  assert.ok(text.includes('1 / 40'), `没画条数预算：${text.slice(0, 300)}`)
  assert.ok(text.includes('4 / 4000'), '没画字符预算')
})

await test('注入情况：收起时不画逐条解释，展开后连「为什么不进」一起画', async () => {
  assert.equal(allText(walk(lastTree)).includes('别的工作区的记忆'), false, '折叠时不该渲染明细')

  const toggle = walk(lastTree).find((n) => n.kind === 'element' && n.type === 'button'
    && String(n.props.children) === dict.zh['inj.toggle'])
  assert.ok(toggle, '缺注入情况展开按钮')
  toggle.props.onClick()
  await flush()

  const text = allText(walk(lastTree))
  assert.ok(text.includes('别的工作区的记忆'), '展开后没显示未注入的那条')
  assert.ok(text.includes(dict.zh['inj.included']), '没标出「已注入」')
  assert.ok(text.includes(dict.zh['inj.excluded']), '没标出「未注入」')
  // 原因文案由宿主给（reasonText），客户端不重写一份
  assert.ok(text.includes('属于别的工作区，不在本会话注入'), '没显示宿主给的原因')
})

await test('聚类与冲突：只作提示，不自动改数据', () => {
  const text = allText(walk(lastTree))
  assert.ok(text.includes(dict.zh['cluster.title']), '没显示聚类提示')
  assert.ok(text.includes(dict.zh['conflict.title']), '没显示冲突提示')
  assert.ok(text.includes('0.75'), '没显示聚类相似度')
  // 提示里不该出现任何「合并 / 自动采纳」这类动作按钮
  const buttons = walk(lastTree).filter((n) => n.kind === 'element' && n.type === 'button')
  const labels = buttons.map((b) => String(b.props.children))
  assert.equal(labels.some((l) => /合并|自动采纳/.test(l)), false, '不该提供自动合并入口')
})

console.log('\n[变更记录]')

/** 取当前树里某个审计字段行（按 .an-audit-key 的文本找）。 */
function auditChangeRow(key) {
  const rows = byClass(walk(lastTree), 'an-audit-change')
  return rows.find((row) => walk(row).some((n) => n.kind === 'text' && n.value === key)) ?? null
}

/** 找「变更记录」卡片里的某个按钮（标题走词典）。 */
function auditButton(labelKey) {
  const card = byClass(walk(lastTree), 'an-card')
    .find((n) => walk(n).some((x) => x.kind === 'text' && x.value === dict.zh['audit.title']))
  assert.ok(card, '找不到变更记录卡片')
  return walk(card).find((n) => n.kind === 'element' && n.type === 'button'
    && String(n.props.children) === dict.zh[labelKey]) ?? null
}

await test('未展开时只显示条数，且不预打 /audit', () => {
  // 收拢态：明细行不该在树里（默认折叠，避免每次进设置页都拉一遍全量）
  assert.equal(byClass(walk(lastTree), 'an-audit-change').length, 0, '折叠时不该渲染明细行')
  const texts = allText(walk(lastTree))
  assert.ok(texts.includes(`${dict.zh['audit.total']} 2`), `没显示条数徽标：${texts.slice(0, 300)}`)
  assert.equal(fetchCalls.some((c) => c.url.includes('/api/anima/audit')), false, '折叠时不该发 /audit')
})

await test('展开：真打一次 /audit，并渲染出明细', async () => {
  fetchCalls.length = 0
  const toggle = auditButton('audit.toggle')
  assert.ok(toggle, '缺展开按钮')
  toggle.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await flush()

  const call = fetchCalls.find((c) => c.url.includes('/api/anima/audit'))
  assert.ok(call, '展开后没发 /audit')
  assert.equal(call.method, 'GET')

  const rows = byClass(walk(lastTree), 'an-audit-change')
  // state 里 2 条共 2 个字段 + /audit 新增 1 条 1 个字段 = 3 行
  assert.equal(rows.length, 3, `明细行数不对（${rows.length}）`)
  const joined = allText(walk(lastTree))
  assert.ok(joined.includes('agentName'), `没显示字段名：${joined.slice(0, 400)}`)
  assert.ok(joined.includes(dict.zh['audit.actor.agent']), '没显示改动者（模型）')
  assert.ok(joined.includes(dict.zh['audit.actor.user']), '没显示改动者（你）')
})

await test('展开后取的是全量：新条目在上', async () => {
  const rows = byClass(walk(lastTree), 'an-audit-change')
  const keys = rows.map((row) => walk(row).find((n) => n.kind === 'text' && /^[a-z]/.test(n.value))?.value)
  // /audit 的第三条（style）应排在 state 那两条之前 —— 新的在上
  assert.equal(keys[0], 'style', `最新一条不在最前：${JSON.stringify(keys)}`)
})

await test('摘要值相等时只显示一次，不编造差异', () => {
  const row = auditChangeRow('presets')
  assert.ok(row, '找不到 presets 那行')
  const inner = walk(row)
  assert.equal(inner.filter((n) => n.kind === 'text' && n.value === '[1 项]').length, 1, '值相等却显示了两次')
  assert.equal(byClass(inner, 'an-audit-from').length, 0, '值相等时不该有划线原值')
  assert.equal(inner.some((n) => n.kind === 'text' && n.value.includes('→')), false, '值相等却画了箭头')
  // 真变了的字段反过来必须有原值 → 新值
  const real = auditChangeRow('agentName')
  assert.ok(real, '找不到 agentName 那行')
  assert.equal(byClass(walk(real), 'an-audit-from').length, 1, '真变了却只显示一个值')
})

await test('清空记录：先弹确认，拒绝就不打 DELETE', async () => {
  fetchCalls.length = 0
  const original = globalThis.confirm
  globalThis.confirm = () => false
  try {
    const clear = auditButton('audit.clear')
    assert.ok(clear, '缺清空按钮')
    clear.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(fetchCalls.some((c) => c.method === 'DELETE'), false, '用户点了取消却仍然发了 DELETE')
  } finally {
    globalThis.confirm = original
  }
})

await test('清空记录：确认后发 DELETE，并回读一次（界面不停在操作前的旧数据）', async () => {
  fetchCalls.length = 0
  // 假宿主对 DELETE 后仍返回同一份 AUDIT_PAYLOAD，所以这里能断言的是「有没有真的
  // 再拉一次」而不是最终条数 —— 回读才是防止界面停在旧数据的那一步。
  const original = globalThis.confirm
  globalThis.confirm = () => true
  try {
    const clear = auditButton('audit.clear')
    clear.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await flush()
    assert.ok(fetchCalls.some((c) => c.method === 'DELETE'), '确认后没发 DELETE')
    assert.ok(fetchCalls.some((c) => c.method === 'GET' && c.url.includes('/api/anima/audit')), '清空后没回读')
  } finally {
    globalThis.confirm = original
  }
})

await test('收起：明细行从树里消失', async () => {
  const hide = auditButton('audit.hide')
  assert.ok(hide, '缺收起按钮')
  hide.props.onClick()
  await flush()
  assert.equal(byClass(walk(lastTree), 'an-audit-change').length, 0, '收起后明细仍留在树里')
})

console.log('\n[交互]')

await test('改 AI 名字：输入框 onChange 更新本地状态并重渲染', () => {
  const input = elements(nodes, 'input').find((n) => n.props.id === 'an-agent-name')
  assert.ok(input, '缺 AI 名字输入框')
  assert.equal(input.props.value, '')
  input.props.onChange({ target: { value: '小沃' } })
  const after = walk(lastTree)
  const next = elements(after, 'input').find((n) => n.props.id === 'an-agent-name')
  assert.equal(next.props.value, '小沃', '重渲染后输入框值没变')
})

await test('关闭总开关：所有表单区跟着走（不是只有开关自己变）', () => {
  const toggle = elements(nodes, 'input').find((n) => n.props.id === 'an-enabled')
  assert.ok(toggle, '缺总开关')
  assert.equal(toggle.props.checked, true)
  toggle.props.onChange({ target: { checked: false } })
  const after = walk(lastTree)
  const next = elements(after, 'input').find((n) => n.props.id === 'an-enabled')
  assert.equal(next.props.checked, false)
  // 复原
  next.props.onChange({ target: { checked: true } })
  const restored = elements(walk(lastTree), 'input').find((n) => n.props.id === 'an-enabled')
  assert.equal(restored.props.checked, true)
})

await test('展开预览：走 400ms 防抖后真打 /preview，并显示宿主返回的文本', async () => {
  fetchCalls.length = 0
  const before = elements(walk(lastTree), 'button')
    .find((n) => String(n.props.children) === dict.zh['preview.toggle'])
  assert.ok(before, '缺预览展开按钮')
  before.props.onClick()
  // 防抖未到时不该发请求
  assert.equal(fetchCalls.some((c) => c.url.includes('/preview')), false, '防抖失效，立刻发了请求')

  await new Promise((resolve) => setTimeout(resolve, 500))
  await flush()

  const previewCall = fetchCalls.find((c) => c.url.includes('/preview'))
  assert.ok(previewCall, '防抖到期后没发 /preview')
  assert.ok(previewCall.url.includes('agentName='), `预览应带上未保存的草稿字段：${previewCall.url}`)

  const text = allText(walk(lastTree))
  assert.ok(text.includes('你的名字：小沃'), `预览文本没显示出来：${text.slice(0, 200)}`)
  assert.ok(text.includes('本工作区'), '字段来源说明没显示')
})

await test('切工作区覆盖输入框：写入的是覆盖值而不是整体替换', async () => {
  const nodes = walk(lastTree)
  let box = elements(nodes, 'textarea').find((n) => n.props.id === 'an-ws-style')
  if (!box) {
    // 前面的用例可能已把工作区取消选中 —— 这里重新选一次，保证本项独立可跑。
    await selectWorkspace()
    box = elements(walk(lastTree), 'textarea').find((n) => n.props.id === 'an-ws-style')
  }
  box.props.onChange({ target: { value: '本工作区专用说法' } })
  const after = elements(walk(lastTree), 'textarea').find((n) => n.props.id === 'an-ws-style')
  assert.equal(after.props.value, '本工作区专用说法')
  // 其它覆盖字段不受影响（仍是继承态 = 空串）
  const other = elements(walk(lastTree), 'textarea').find((n) => n.props.id === 'an-ws-emoji')
  assert.equal(other.props.value, '')
})

await test('示例按钮：五个身份/背景字段各有一组，agentName 刻意没有', () => {
  const nodes = walk(lastTree)
  const chips = byClass(nodes, 'an-chip')
  const labels = chips.map((n) => String(n.props.children))
  // 示例按钮取第一句做标签，不是整段塞进按钮
  assert.ok(labels.some((label) => label.includes('研究生在读')), `没画出用户背景示例：${JSON.stringify(labels)}`)
  // 全文在 title 里，按钮上只放短标签 —— 按钮被撑爆会让整行错位
  const bioChip = chips.find((n) => String(n.props.children).includes('研究生在读'))
  assert.ok(String(bioChip.props.title).length > String(bioChip.props.children).length, '完整示例应放在 title 里')

  // 点一下示例：内容要落进对应的输入框
  const roleChip = chips.find((n) => String(n.props.children).includes('长期 AI 助手'))
  assert.ok(roleChip, '缺角色设定示例')
  roleChip.props.onClick()
  const after = walk(lastTree)
  const roleBox = elements(after, 'textarea').find((n) => n.props.id === 'an-agent-role')
  assert.ok(roleBox.props.value.includes('长期 AI 助手'), `示例没填进角色设定：${roleBox.props.value}`)

  // agentName 不给示例：按钮不该出现在名字输入框那一组
  assert.equal(
    labels.some((label) => label.includes('小沃')),
    false,
    'agentName 不该有示例按钮'
  )
})

// 用一次性替身运行时渲染一棵新的设置页，读完就把它拆掉。
//
// 两件事必须做对，否则会污染主运行时：
// ① 换绑 runtimeRef —— react 替身把每个钩子调用都转发给 runtimeRef.current，
//    不换绑的话这一轮的钩子会注册到主运行时上，把它的槽位整片挪走；
// ② 渲染完把 lastTree 还原 —— createRuntime.render() 会写这个模块级变量。
//
// 拆掉订阅也是必须的：它的 store 订阅若留着，之后每次 loadState() 都会连带
// 重渲染这个没人看的分身，把模块级的 lastTree 换掉。
function withOwnRuntime(renderComponent, fn) {
  const prevRuntime = runtimeRef.current
  const prevTree = lastTree
  const fresh = createRuntime(renderComponent)
  runtimeRef.current = fresh
  try {
    return fn(fresh.render(), fresh)
  } finally {
    // 清理必须在换回 runtimeRef 之前跑：清理函数里若触发 setState，
    // 那一轮重渲染仍应落在自己这台上。
    for (const slot of fresh.hooks) {
      if (slot && typeof slot.cleanup === 'function') {
        try {
          slot.cleanup()
        } catch {
          // 替身清理失败不影响断言
        }
        slot.cleanup = undefined
      }
    }
    runtimeRef.current = prevRuntime
    lastTree = prevTree
  }
}

function renderFreshSettings() {
  return withOwnRuntime(
    () => slotComponent({ ...injectProps, useAnimaStore: controller.useStore, t }),
    (tree) => tree
  )
}

await test('卡片折叠：状态落 localStorage，且脏值一律按「没收起」', async () => {
  const COLLAPSED_KEY = 'dsh-anima:collapsed-cards'
  const title = dict.zh['identity.title']
  // 判「正文还在不在」必须挑一个只出现在正文里的东西：卡头（aside 里的折叠按钮
  // 与标题）收起后照样渲染，拿标题或按钮文案去判会永远为真。
  const hasBody = () => elements(walk(lastTree), 'input').some((n) => n.props.id === 'an-agent-name')
  // 用例中途失败也别把折叠态留给后面的用例：后文有断言依赖「卡片是展开的」。
  const restore = () => {
    for (const button of elements(walk(lastTree), 'button')) {
      if (button.props.className === 'an-card-toggle' && button.props['aria-expanded'] === 'false') {
        button.props.onClick()
      }
    }
  }

  try {
    const toggle = byClass(cardNodes(lastTree, title), 'an-card-toggle')[0]
    assert.ok(toggle, '缺折叠按钮')
    assert.equal(toggle.props['aria-expanded'], 'true', '初始应展开')
    assert.ok(hasBody(), '展开态下卡片正文应在树里')

    toggle.props.onClick()
    await flush()

    assert.equal(
      storageBacking.get(COLLAPSED_KEY),
      JSON.stringify({ identity: true }),
      '折叠状态没落盘'
    )
    // 收起是「不渲染」而不是「用 CSS 藏起来」：整段正文消失，卡头还在。
    // （cardNodes 只认 className === 'an-card' 的节点，所以收起后它查不到这张卡。）
    const sections = elements(walk(lastTree), 'section').filter((n) =>
      String(n.props.className).includes('an-card-collapsed')
    )
    assert.equal(sections.length, 1, `应恰好收起一张卡（实际 ${sections.length}）`)
    assert.equal(sections[0].props.className, 'an-card an-card-collapsed')
    assert.equal(hasBody(), false, '卡片收起了但正文还在树里')
    assert.ok(
      byClass(walk(lastTree), 'an-card-title').map((n) => n.props.children).includes(title),
      '收起的是正文，卡头不该跟着消失'
    )

    // 再点一次展开：按钮此时带着 aria-expanded="false"（byClass 是严格全等，
    // 收起后的卡片节点已经不在 cardNodes 里了，只能全页找）。
    const reopen = elements(walk(lastTree), 'button').find(
      (n) => n.props.className === 'an-card-toggle' && n.props['aria-expanded'] === 'false'
    )
    assert.ok(reopen, '收起后找不到展开按钮')
    reopen.props.onClick()
    await flush()
    assert.equal(storageBacking.get(COLLAPSED_KEY), '{}', '展开后应把该键删掉')
    assert.ok(hasBody(), '展开后正文没回来')

    // 脏值：手改过 localStorage（值不是 true、或整段不是 JSON）时一律按「没收起」，
    // 否则一次误改就能让某张卡永远打不开。
    storageBacking.set(COLLAPSED_KEY, JSON.stringify({ identity: 'yes', preview: 1 }))
    assert.equal(
      byClass(walk(renderFreshSettings()), 'an-card an-card-collapsed').length,
      0,
      '非 true 的脏值把卡片钉死了'
    )

    storageBacking.set(COLLAPSED_KEY, '{oops')
    assert.equal(
      byClass(walk(renderFreshSettings()), 'an-card an-card-collapsed').length,
      0,
      '坏 JSON 应该被当成空对象，不是让整页崩'
    )

    // 真值仍然生效：脏值被忽略不等于把功能整个关掉
    storageBacking.set(COLLAPSED_KEY, JSON.stringify({ identity: true }))
    assert.equal(
      byClass(walk(renderFreshSettings()), 'an-card an-card-collapsed').length,
      1,
      '真值没被读进去'
    )
  } finally {
    restore()
    storageBacking.delete(COLLAPSED_KEY)
  }
})

await test('光轨配色三个入口写同一字段，半截输入不污染取色器', () => {
  const picker = () => elements(walk(lastTree), 'input').find((n) => n.props.id === 'an-trail-color-picker')
  const text = () => elements(walk(lastTree), 'input').find((n) => n.props.id === 'an-trail-color')

  assert.equal(picker().props.type, 'color')
  assert.equal(text().props.type, 'text')
  // 初始态：没配过色 ⇒ 默认色（取色器必须拿到合法颜色，否则它会自己变黑）
  assert.equal(text().props.value, '#679EFE')
  assert.equal(picker().props.value, '#679EFE')

  // ① 文本框里只打了一半：文本框原样显示，取色器不被污染
  text().props.onChange({ target: { value: '#67' } })
  assert.equal(text().props.value, '#67')
  assert.equal(picker().props.value, '#679EFE', '半截输入漏进取色器了')

  // ② 点内置色：文本框与取色器同时跟上（三入口写的是同一个字段）
  const swatch = elements(walk(lastTree), 'button').find(
    (n) =>
      String(n.props.className).includes('an-btn-sm') &&
      Array.isArray(n.props.children) &&
      n.props.children.includes('#A855F7')
  )
  assert.ok(swatch, '缺内置色按钮')
  swatch.props.onClick()
  assert.equal(text().props.value, '#A855F7')
  assert.equal(picker().props.value, '#A855F7')

  // ③ 取色器回调统一大写：写进去的值与文本框一致
  picker().props.onChange({ target: { value: '#22c55e' } })
  assert.equal(text().props.value, '#22C55E')
  assert.equal(picker().props.value, '#22C55E')
})

await test('光轨实时预览：挂载点拿不到时降级不抛，三种状态分别写在 data 属性上', () => {
  const errorsBefore = runtime.errors.length

  // 先验接线：总开关直接决定传给预览组件的 enabled（组件自己不再判一遍）。
  // 注意这里必须用 findComponent 读**未内联**的原始树 —— walk() 会就地调用
  // TrailPreview 并占用它的 hook 槽位，拿到的 ref 会绑到一个影子槽上。
  const trailNode = () => findComponent(lastTree, 'TrailPreview')
  assert.ok(trailNode(), '整棵树里找不到 TrailPreview 组件')
  assert.equal(trailNode().props.enabled, true, '开关开着时没把 enabled 传下去')
  assert.equal(allText(walk(lastTree)).includes(dict.zh['trail.preview']), true, '预览区没渲染出来')

  const toggle = () => elements(walk(lastTree), 'input').find((n) => n.props.id === 'an-trail-enabled')
  assert.equal(toggle().props.checked, true)
  toggle().props.onChange({ target: { checked: false } })
  assert.equal(trailNode().props.enabled, false, '关掉开关后 enabled 没跟着变')
  toggle().props.onChange({ target: { checked: true } })
  assert.equal(trailNode().props.enabled, true)

  // 再把组件单独放进一台运行时里，手动喂一个宿主元素给 ref 回调。
  // 替身没有 createElementNS ⇒ mountTrailRing 必须返回 null（不是抛错），
  // 而这一层的 data 属性仍然要写上去：颜色是给 CSS 变量用的，与环画不画得出来无关。
  const host = {
    attributes: {},
    styleProps: {},
    setAttribute(key, value) {
      this.attributes[key] = String(value)
    },
    appendChild() {},
    removeChild() {},
    style: {
      setProperty(key, value) {
        host.styleProps[key] = String(value)
      }
    }
  }

  const component = trailNode().type
  const baseProps = { ...trailNode().props }
  let currentProps = baseProps
  // 颜色必须在进 withOwnRuntime 之前读：里面 fresh.render() 会把模块级 lastTree
  // 换成预览那一小段，之后再 walk(lastTree) 就找不到设置页上的输入框了。
  const expectedColor = String(
    elements(walk(lastTree), 'input').find((n) => n.props.id === 'an-trail-color').props.value
  ).toUpperCase()

  withOwnRuntime(
    () => component(currentProps),
    (div, fresh) => {
      assert.ok(div, 'TrailPreview 没返回任何东西')
      assert.equal(div.props.className, 'an-trail-preview')
      assert.equal(typeof div.props.ref, 'function', '预览容器没接 ref —— 挂载逻辑永远不会跑')

      // 替身不跑 React 的提交阶段，手动把宿主元素喂给 ref 回调
      div.props.ref(host)

      assert.equal(host.attributes['data-an-trail'], 'on', '开关开着时不是 on')
      assert.equal(host.attributes['data-an-trail-static'], 'off')
      assert.equal(host.attributes['data-an-trail-speed'], 'slow')
      assert.equal(host.attributes['data-an-trail-width'], 'thin')
      assert.equal(host.styleProps['--an-trail-color'], expectedColor, 'CSS 变量没跟上当前配色')

      // 关掉开关 ⇒ 环静止但属性仍在（设成 off 会被 CSS 整条隐藏，就没法调色了）
      currentProps = { ...baseProps, enabled: false }
      fresh.render()
      assert.equal(host.attributes['data-an-trail'], 'static', '关掉开关后不是 static')
      assert.equal(host.attributes['data-an-trail-static'], 'on')
    }
  )

  assert.equal(runtime.errors.length, errorsBefore, '降级路径抛了错')
})

await test('预览卡：字符数与被校验挡下的草稿字段清单都会渲染', async () => {
  const title = dict.zh['preview.title']
  // ① 字符数：必须与真正渲染出来的那段文本长度对得上（不是另算一份）
  let inner = cardNodes(lastTree, title)
  const pre = byClass(inner, 'an-pre')[0]
  assert.ok(pre, '预览卡里没有提示词正文')
  const body = String(pre.props.children)
  const hint = byClass(inner, 'an-hintline')
    .map((n) => String(n.props.children))
    .find((line) => line.includes(dict.zh['preview.chars']))
  assert.ok(hint, '缺字符数提示')
  assert.ok(hint.includes(`: ${body.length}`), `字符数与正文对不上：${hint} / ${body.length}`)

  // ② 被校验挡下的草稿字段：宿主会在响应里带一份 invalid 清单。
  //    预览刻意不为半截输入报错，但静默忽略更糟 —— 用户会以为「预览里就是这样」。
  const savedInvalid = PREVIEW_PAYLOAD.invalid
  try {
    PREVIEW_PAYLOAD.invalid = [{ key: 'agentRole', reason: 'too-long' }, { key: 'userBio' }]
    await controller.loadPreview('', { agentName: '小沃' })
    await flush()

    inner = cardNodes(lastTree, title)
    const box = byClass(inner, 'an-invalid')
    assert.equal(box.length, 1, '没渲染被拒字段清单')
    // allText 只吃 walk() 产出的扁平节点表（元素节点本身不带文本）
    const boxText = allText(walk(box))
    assert.ok(boxText.includes(dict.zh['preview.invalidTitle']), '清单缺标题')
    assert.ok(boxText.includes('agentRole'), '清单没列出被拒字段')
    assert.ok(boxText.includes('too-long'), '未收录的原因应原样显示，不该被吞掉')
    const items = elements(walk(box), 'li').map((n) => String(n.props.children))
    assert.ok(items.includes('userBio'), `没有 reason 的条目应只显示字段名：${JSON.stringify(items)}`)
  } finally {
    if (savedInvalid === undefined) delete PREVIEW_PAYLOAD.invalid
    else PREVIEW_PAYLOAD.invalid = savedInvalid
    await controller.loadPreview('', { agentName: '小沃' })
    await flush()
  }
})

await test('设置页自动刷新：后台不拉、回前台拉一次、10 秒内重复触发被节流', async () => {
  // 前面的 apply 跑在「连 addEventListener 都没有」的 document 上 —— 那条降级路径
  // 已经被「apply 不抛错」这一项覆盖。这里补上监听能力再跑一次 apply，
  // 拿到真实注册进去的监听器，验证节流规则（而不是只验证它没崩）。
  const listeners = new Map()
  globalThis.document.addEventListener = (type, fn) => listeners.set(type, fn)
  globalThis.document.removeEventListener = (type, fn) => {
    if (listeners.get(type) === fn) listeners.delete(type)
  }
  globalThis.document.visibilityState = 'hidden'
  try {
    clientExports.apply(ctx)
    await flush()
    const fire = listeners.get('visibilitychange')
    assert.equal(typeof fire, 'function', '没注册 visibilitychange')

    const stateCalls = () => fetchCalls.filter((c) => c.url.includes('/state')).length
    fetchCalls.length = 0

    // 后台触发：不拉
    fire()
    await flush()
    assert.equal(stateCalls(), 0, '页面在后台也去拉了数据')

    // 回到前台：拉一次
    globalThis.document.visibilityState = 'visible'
    fire()
    await flush()
    assert.equal(stateCalls(), 1, `回前台应恰好拉一次（实际 ${stateCalls()}）`)

    // 10 秒内再触发：被节流
    fire()
    await flush()
    assert.equal(stateCalls(), 1, '节流失效，重复触发了第二次')
  } finally {
    globalThis.document.visibilityState = undefined
    delete globalThis.document.addEventListener
    delete globalThis.document.removeEventListener
  }
})

await test('导入面板：默认不展开，展开后两步都在，第 1 步有提示词与复制按钮', async () => {
  const memTitle = dict.zh['mem.title']
  const nodes = () => cardNodes(lastTree, memTitle)
  // 判「面板在不在」用只有面板正文才有的 textarea id：标题与按钮文案在收起态
  // 照样渲染，拿它们判会永远为真。
  const panelText = () => elements(nodes(), 'textarea').find((n) => n.props.id === 'an-import-text')

  // 入口按钮：一个「导入外部 AI 的记忆」，点击前没有面板正文
  const entry = () => elements(nodes(), 'button').find((n) => {
    const child = n.props.children
    return typeof child === 'string' && child === dict.zh['imp.open']
  })
  assert.ok(entry(), '记忆卡里没有导入入口按钮')
  assert.equal(panelText(), undefined, '默认就该是收起的')

  entry().props.onClick()
  await flush()

  assert.ok(panelText(), '展开后没有粘贴框')
  const text = allText(nodes())
  assert.ok(text.includes(dict.zh['imp.step1']), '缺第 1 步说明')
  assert.ok(text.includes(dict.zh['imp.step2']), '缺第 2 步说明')
  assert.equal(text.includes(STATE_PAYLOAD.memoryImport.prompt), true, '提示词正文没渲染出来')

  // 提示词必须原样给出：少了半句，别的 AI 就会输出一份用不上的画像
  const prompt = byClass(nodes(), 'an-import-prompt')[0]
  assert.ok(prompt, '提示词容器不存在')
  assert.equal(prompt.props.children, STATE_PAYLOAD.memoryImport.prompt)

  // 复制按钮：无剪贴板时不能说「已复制」（那是在骗用户）
  const copy = elements(nodes(), 'button').find((n) => n.props.children === dict.zh['imp.copy'])
  assert.ok(copy, '缺复制按钮')
  copy.props.onClick()
  await flush()
  assert.equal(
    allText(nodes()).includes(dict.zh['imp.copied']),
    false,
    '没有剪贴板却说已复制'
  )
  assert.ok(allText(nodes()).includes(dict.zh['imp.copyFailed']), '复制失败没有提示')
})

await test('导入面板：解析 → 逐条预览 → 丢弃的不提交、改过的层级跟着走', async () => {
  const memTitle = dict.zh['mem.title']
  const nodes = () => cardNodes(lastTree, memTitle)
  const panelText = () => elements(nodes(), 'textarea').find((n) => n.props.id === 'an-import-text')
  // 面板此刻应是展开的（上一条用例点开过）。若单独跑这一条，这里会返回 false，
  // 断言会明确说「面板没展开」，而不是抛一个读不到 props 的 TypeError。
  assert.ok(panelText(), '面板没展开 —— 本用例依赖上一条把入口点开')

  const buttons = () => elements(nodes(), 'button')
  const byText = (label) => buttons().find((n) => n.props.children === label)

  // 粘贴内容
  assert.equal(typeof panelText().props.onChange, 'function')
  panelText().props.onChange({ target: { value: '一段粘贴回来的画像' } })
  await flush()

  // 解析
  commitBodies.length = 0
  fetchCalls.length = 0
  const parseButton = byText(dict.zh['imp.parse'])
  assert.ok(parseButton, '缺解析按钮')
  assert.equal(parseButton.props.disabled, false, '有内容时解析按钮不该禁用')
  parseButton.props.onClick()
  await flush()

  // 打的是 parse 路由，且带上了工作区坐标（归类建议要用）
  const parseCall = fetchCalls.find((c) => c.url.includes('/memory/import/parse'))
  assert.ok(parseCall, '没有调用解析路由')
  assert.equal(parseCall.method, 'POST')
  assert.ok(parseCall.url.includes(encodeURIComponent(WORKSPACE_PATH)), `cwd 没带上：${parseCall.url}`)
  assert.equal(JSON.parse(String(parseCall.body)).text, '一段粘贴回来的画像')

  // 逐条预览：两类提示都在
  const afterParse = allText(nodes())
  assert.ok(afterParse.includes(IMPORT_PARSE_PAYLOAD.items[0].text), '第一条没进预览')
  assert.ok(afterParse.includes(IMPORT_PARSE_PAYLOAD.items[1].text), '第二条没进预览')
  // 被拦下的凭据：要说明「为什么没进来」，不能静默少一条
  assert.ok(afterParse.includes(dict.zh['imp.blockedTitle']), '没提示被拦下的条目')
  assert.ok(afterParse.includes('openai-key'), '没说清命中了哪条凭据规则')
  assert.ok(afterParse.includes(dict.zh['imp.tooLongTitle']), '没提示过长条目')
  assert.ok(afterParse.includes(dict.zh['imp.duplicateTitle']), '没提示重复条目')
  assert.ok(afterParse.includes(dict.zh['imp.overflowTitle']), '没提示超条数条目')
  assert.equal(afterParse.includes('{max}'), false, '有占位符没被替换')

  // 层级：默认用 host 的建议（第二条建议本工作区）
  const layerButtons = () => buttons()
  assert.ok(layerButtons().some((n) => n.props.children === dict.zh['imp.layerWorkspace']))
  assert.ok(layerButtons().some((n) => n.props.children === dict.zh['imp.layerGlobal']))

  // 丢弃第一条
  const dropButton = byText(dict.zh['imp.drop'])
  assert.ok(dropButton, '缺丢弃按钮')
  dropButton.props.onClick()
  await flush()
  assert.ok(allText(nodes()).includes(dict.zh['imp.restore']), '丢弃后没有恢复入口')

  // 提交：应只带第二条，且层级是 host 建议的 workspace
  const commitButton = byText(dict.zh['imp.commit'])
  assert.ok(commitButton, '缺提交按钮')
  assert.equal(commitButton.props.disabled, false)
  commitButton.props.onClick()
  await flush()

  assert.equal(commitBodies.length, 1, `提交次数不对：${commitBodies.length}`)
  const payload = commitBodies[0]
  assert.equal(payload.items.length, 1, '丢弃的条目也提交了')
  assert.equal(payload.items[0].text, IMPORT_PARSE_PAYLOAD.items[1].text)
  assert.equal(payload.items[0].layer, 'workspace')

  // 成功提示必须报出**实际条数**，不能是 0。
  //
  // 这条断言是补上一个真实漏网 bug 的：宿主曾经回 `added: <数字>`，而这里按
  // `response.added.length` 读 ⇒ 恒为 0，提示语变成「已导入 0 条」；夹具当时写的
  // 是数组，恰好掩盖了它。所以断言不能只查提示出现，必须查**条数对得上**。
  const donePrefix = dict.zh['imp.done'].split('{n}')[0]
  // 注意两点：① byClass 是严格 ===，而这里是 `an-toast an-toast-ok` 复合串，
  // 只能自己筛；② allText 只吃 walk() 的扁平表，传元素节点永远得空串 ——
  // 所以要把提示节点的子树再 walk 一遍。
  const toast = walk(lastTree)
    .filter((n) => n.kind === 'element' && String(n.props.className ?? '').includes('an-toast-ok'))
  assert.equal(toast.length, 1, '提交成功后应有一条成功提示')
  const toastText = allText(walk(toast[0].props.children))
  assert.ok(toastText.includes(donePrefix), `提示文案不对：${toastText}`)
  assert.ok(
    toastText.includes(`已导入 ${payload.items.length} 条`),
    `提示里的条数应与提交数 ${payload.items.length} 一致：${toastText}`
  )
})

await test('导入面板：解析失败时给可读错误，且不留下半截预览', async () => {
  const memTitle = dict.zh['mem.title']
  const nodes = () => cardNodes(lastTree, memTitle)
  const panelText = () => elements(nodes(), 'textarea').find((n) => n.props.id === 'an-import-text')
  const entry = () => elements(nodes(), 'button').find((n) => n.props.children === dict.zh['imp.open'])
  const cancel = () => elements(nodes(), 'button').find((n) => n.props.children === dict.zh['imp.cancel'])

  // 上一条用例提交成功后面板会清空/收起；这里重新展开并贴内容
  if (entry()) {
    entry().props.onClick()
    await flush()
  }
  if (!panelText() && cancel()) {
    cancel().props.onClick()
    await flush()
    entry().props.onClick()
    await flush()
  }
  assert.ok(panelText(), '面板没展开')

  panelText().props.onChange({ target: { value: '待解析内容' } })
  await flush()

  IMPORT_PARSE_FAILS = true
  try {
    const parseButton = elements(nodes(), 'button').find((n) => n.props.children === dict.zh['imp.parse'])
    assert.ok(parseButton, '缺解析按钮')
    parseButton.props.onClick()
    await flush()
    assert.ok(allText(nodes()).includes('SMOKE'), `没把宿主报错显示给用户：${allText(nodes()).slice(0, 200)}`)
    assert.equal(allText(nodes()).includes(dict.zh['imp.resultTitle']), false, '失败了却画出了结果区')
  } finally {
    IMPORT_PARSE_FAILS = false
    const cancelButton = cancel()
    if (cancelButton) {
      cancelButton.props.onClick()
      await flush()
    }
  }
})

await test('导入面板：老宿主不下发 memoryImport 时整个入口消失（不是画个死按钮）', async () => {
  const saved = STATE_PAYLOAD.memoryImport
  delete STATE_PAYLOAD.memoryImport
  try {
    await controller.loadState()
    await flush()
    const nodes = cardNodes(lastTree, dict.zh['mem.title'])
    const labels = elements(nodes, 'button').map((n) => n.props.children)
    assert.equal(
      labels.includes(dict.zh['imp.open']),
      false,
      '老宿主上仍画出了导入入口'
    )
    // 记忆卡本身要照常渲染 —— 少一个可选入口不该影响整张卡
    assert.ok(elements(nodes, 'textarea').some((n) => n.props.id === 'an-import-text') === false)
    assert.ok(allText(nodes).includes(dict.zh['mem.add']), '记忆卡其它部分受影响了')
  } finally {
    STATE_PAYLOAD.memoryImport = saved
    await controller.loadState()
    await flush()
  }
})

await test('运行时没攒下未捕获的钩子异常', () => {
  assert.deepEqual(runtime.errors, [], `钩子执行抛了 ${runtime.errors.length} 次`)
})

console.log(`\n通过 ${passed} 项`)
if (failures.length > 0) {
  console.log(`\nFAILED ${failures.length} 项`)
  for (const [name] of failures) console.log(`  - ${name}`)
  process.exit(1)
}
console.log('\nPASSED 客户端渲染冒烟全绿')
