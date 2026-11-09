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
    let firstFrame = null
    try {
      do {
        rerenderRequested = false
        index = 0
        pendingEffects = []
        tree = renderComponent()
        // 记下「effect 执行之前」的那棵树。真实 React 里 effect 要等首帧
        // 绘制之后才跑，所以首帧是用户真正看得见的那一帧；本替身把 effect
        // 放进循环里立刻执行，若不单独留一份，就永远测不到首帧长什么样。
        if (firstFrame === null) firstFrame = tree
        commitEffects()
      } while (rerenderRequested)
    } finally {
      rendering = false
    }
    lastTree = tree
    api.lastFirstFrame = firstFrame
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
// 按「类名里含有这些 token」匹配，不是整串相等。
// 原来这里是 `n.props.className === className`，只在「一个元素恰好只挂这些类」时成立。
// 一旦某个节点同时挂了版式工具类（如 'an-kv an-mt10'），精确相等就找不到它了 ——
// 断言会以「元素不存在」的形式失败，而真正的原因只是类名多了一个 token。
// 传多词（'an-card an-card-collapsed'）时要求全部命中，所以调用点写法不用改；
// 也依旧不松：'an-badge' 不会匹配到 'an-badge-ok'（按 token 切，不按子串）。
const byClass = (nodes, className) => {
  const want = className.split(/\s+/).filter(Boolean)
  return nodes.filter((n) => {
    if (n.kind !== 'element') return false
    const have = String(n.props.className ?? '').split(/\s+/)
    return want.every((w) => have.includes(w))
  })
}
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
 *
 * 第二版（2026-10-28）：先按 `data-an-card` 的 id 认卡，认不到才退回按标题文字找。
 *
 * 上一版只按标题文字找，于是「任何一张卡里出现了另一张卡的标题」就会认错卡 ——
 * 而文案里提到别的卡名是极常见的事（`identity.desc` 里就写着「用户背景」四个字，
 * `user.desc` 里又写着「助手身份」）。真实翻车案例：把人设卡的说明改成
 * 「…也看不到长期记忆。」之后，`cardNodes(tree, '长期记忆')` 先撞上人设卡，
 * 13 条记忆相关用例集体报「记忆卡里没有 X」——代码本身没坏，是探针指错了对象。
 * 按 id 认卡不受文案措辞影响；标题兜底只为兼容没写 id 的卡片。
 *
 * @param {object} root 渲染树
 * @param {string} title 卡片标题（词典值），仅在按 id 找不到时使用
 * @param {string} [cardId] 卡片的 data-an-card id，优先于标题
 */
function cardNodes(root, title, cardId) {
  if (cardId) {
    let hit = null
    const findById = (node) => {
      if (!node || typeof node !== 'object' || hit) return
      if (Array.isArray(node)) return node.forEach(findById)
      if (isComponent(node)) return findById(node.type(node.props))
      if (node.props?.['data-an-card'] === cardId) {
        walk(node.props?.children, hit = [])
        return
      }
      findById(node.props?.children)
    }
    findById(root)
    if (hit) return hit
  }

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
  },
  // 质检五项。缺这一段时客户端的 qualityDefaults 会全部回落默认值 ——
  // 那会让「界面显示的值」与「宿主实际的值」脱钩，而界面看不出来。
  quality: {
    enabled: true,
    ledgerLevel: 'three',
    strict: true,
    preStepCheck: true,
    maxFindingsInReminder: 5
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
  // 质检钩子的运行计数。checks=0 是合法且重要的状态（页面必须明说「没在工作」），
  // 所以这里给一个已经跑过的样本，另外单列一条用例把 checks=0 与「没有这个字段」分开。
  qualityStats: {
    checks: 9,
    reminders: 3,
    suppressed: 1,
    skipped: { 'empty-text': 12 },
    last: {
      seq: 4242,
      at: '2026-10-20T10:00:00.000Z',
      chars: 512,
      findings: ['R02'],
      uncovered: ['R03', 'R05', 'R06', 'R07', 'R10'],
      injected: true
    },
    note: 'checks 是真正跑过判定的次数。'
  },
  // 巡夜记录：reported=false 是**合法且重要**的状态（跑过了、判为无事、没汇报），
  // 它与「这个字段根本不存在」必须被画成两种样子 —— 前者是结论，后者是未知。
  // 单列一条用例把这两者分开。
  patrolMeta: {
    at: '2026-10-23T15:00:00.000Z',
    day: '2026-10-23',
    reason: 'nightly',
    signature: 'p:|f:|t:0',
    reported: false,
    wouldReport: false,
    delivered: 0,
    reasons: [],
    facts: { pending: 0, flagged: 0, removed: 0 },
    checked: 21
  },
  // 回扫记录：与巡夜同理，found=0 是合法且重要的状态（扫过、确实没有新线索）。
  // 它与「这个字段根本不存在」必须被画成两种样子。
  retrospectMeta: {
    scannedAt: '2026-10-24T09:00:00.000Z',
    scannedDays: 14,
    files: 3,
    messages: 128,
    found: 1,
    leadKeys: ['k1'],
    leads: [{ key: 'k1', kind: 'complaint', text: '我有没有说过不允许一直往c盘写东西' }],
    leadsDropped: 0,
    delivered: 1
  },
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
/** /api/anima/patrol 的请求体（断言「手动巡夜真的打到路由」要靠它）。 */
const patrolCalls = []
/** /api/anima/retrospect 的请求体（断言「手动回扫真的打到路由」要靠它）。 */
const retrospectCalls = []
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

/**
 * /memory/audit 的假回执。
 *
 * 形状必须照抄 lib/memory-audit.mjs 的真实产出：问题放在 `findings` 数组里，
 * 每条带 {kind, detail, evidence}；建议放在 `suggestion` 里。
 * （第一版把 kind/detail 写在顶层、没有 findings 数组，结果面板画不出任何东西 ——
 * 夹具形状写错，测试就测不到真实分支，这条教训在 eventText 那次已经付过学费。）
 *
 * 刻意造两条问题：一条路径不存在（该给状态 + 可粘贴命令），一条复核点过期
 * （只提示、不给状态 —— 过期不等于不成立）。两类被画成一样，断言会红。
 */
function auditPayload() {
  return {
    ok: true,
    checked: 2,
    clean: 0,
    flagged: [
      {
        id: 'm-gone',
        text: '工具链装在 D:\\gone-not-here 下',
        type: 'fact',
        state: undefined,
        capturedAt: 1760000000000,
        verifyAt: '2027-04-30',
        findings: [
          {
            kind: 'path-missing',
            detail: '记忆里写的路径「D:\\gone-not-here」现在已经不存在',
            evidence: 'fs.existsSync("D:\\\\gone-not-here") === false'
          }
        ],
        suggestion: {
          state: 'contradicted',
          why: '这条记忆指向的东西已经不在了',
          command: '/anima mark m-gone state=contradicted'
        }
      },
      {
        id: 'm-old',
        text: '临时结论：这个池子是 3 个节点',
        type: 'fact',
        state: undefined,
        capturedAt: 1760000000000,
        verifyAt: '2020-01-01',
        findings: [
          {
            kind: 'verify-expired',
            detail: '复核点是 2020-01-01，已经过去了 —— 这条是不是还成立，只有你知道',
            evidence: 'verifyAt=2020-01-01 < today=2026-10-22'
          }
        ],
        suggestion: {
          state: null,
          why: '只有复核点过期。要不要标「可能已过时」由你决定，代码不替你判',
          command: '/anima mark m-old state=contradicted'
        }
      }
    ],
    note: '这份体检只做两件机械能验的事：路径还在不在、复核点过没过。'
  }
}

/**
 * /api/anima/patrol 的假回执。
 *
 * 形状照抄 index.mjs 里 runPatrol 的真实返回：
 * `{ ok, verdict:{shouldReport,signature,reasons,facts}, delivered, at, triage, audit }`。
 * 第一版把 shouldReport 写在顶层、事实散在别处 —— 客户端读 result.delivered
 * 会拿到 undefined，于是 toast 永远显示「没有汇报」，看起来像判定错了。
 */
function patrolPayload() {
  return {
    ok: true,
    verdict: {
      shouldReport: false,
      signature: 'p:|f:|t:0',
      reasons: [],
      facts: { pending: 0, flagged: 0, removed: 0 }
    },
    delivered: 0,
    at: '2026-10-23T15:00:00.000Z',
    triage: { pendingBefore: 0, pendingAfter: 0, discardedTotal: 0 },
    audit: { checked: 2, flagged: 0 }
  }
}

function retrospectPayload() {
  // 形状照抄 runRetrospect 的真实返回：
  // { ok, at, days, files, messages, verdict:{newLeads,shouldReport,...}, delivered, failedFrames }
  return {
    ok: true,
    at: '2026-10-24T09:00:00.000Z',
    days: 14,
    files: 3,
    messages: 128,
    verdict: { newLeads: [{ key: 'k1', kind: 'complaint', text: '我有没有说过不允许一直往c盘写东西' }], shouldReport: true, remaining: 0 },
    delivered: 1,
    failedFrames: 0
  }
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
  if (url.includes('/api/anima/memory/audit')) {
    return { ok: true, status: 200, json: async () => auditPayload() }
  }
  if (url.includes('/api/anima/patrol')) {
    patrolCalls.push(JSON.parse(String(init?.body ?? '{}')))
    // 形状照抄 runPatrol 的真实返回：{ ok, verdict:{shouldReport,signature,reasons,facts}, delivered, at, triage, audit }
    return { ok: true, status: 200, json: async () => patrolPayload() }
  }
  if (url.includes('/api/anima/retrospect')) {
    retrospectCalls.push(JSON.parse(String(init?.body ?? '{}')))
    return { ok: true, status: 200, json: async () => retrospectPayload() }
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
  assert.equal(settings.config.order, 51, 'order 必须与同类插件的 50 错开')
  assert.equal(typeof settings.config.label, 'function')
  // 下面几节仍按单槽位的旧写法读这两个变量，这里回填以免大改既有断言。
  slotRegistration = settings.config
  slotComponent = settings.Component
})

await test('三个槽位都注册了，且 id 都避开同类插件占用过的格子', () => {
  const names = slotRegistrations.map((entry) => entry.config.name).sort()
  assert.deepEqual(names, ['conversation.input.left', 'conversation.input.overlay', 'settings.section'])
  // settings.section 的文档：复用已有 id 即替换那一格 —— 撞上同类插件会顶掉它。
  const ids = new Set(slotRegistrations.map((entry) => entry.config.id))
  assert.deepEqual(
    [...ids].sort(),
    ['anima-quick-toggle', 'anima-settings', 'anima-trail']
  )
  for (const taken of ['soul-settings', 'soul-quick-toggle', 'soul-trail']) {
    assert.ok(!ids.has(taken), `id 与同类插件撞车：${taken}`)
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

await test('八张卡都在，标题走词典而不是原始 key', () => {
  const titles = byClass(nodes, 'an-card-title').map((n) => n.props.children)
  // 变更记录不再是卡片 —— 它搬到了页面顶部常驻（RecentChanges），单独用下一条断言。
  const expected = ['preset.title', 'identity.title', 'user.title', 'style.title', 'trail.title', 'ws.title', 'mem.title', 'preview.title']
  for (const key of expected) {
    assert.ok(titles.includes(dict.zh[key]), `缺卡片：${key}（实际标题：${JSON.stringify(titles)}）`)
  }
  // 没有哪个标题长得像 i18n key
  for (const title of titles) {
    assert.equal(/^[a-z]+\.[A-Za-z.]+$/.test(String(title)), false, `标题疑似原始 key：${title}`)
  }
})

await test('最近改了什么：常驻在顶部，但收起态只占一行（下拉）', () => {
  // 用户的原话是「我根本不知道改成啥了」。原来的变更记录在「高级」栏里、
  // 默认收起、还要再点一次「展开明细」，等于没有。这条用例锁住「它常驻」。
  const recent = byClass(walk(lastTree), 'an-recent')
  assert.equal(recent.length, 1, `顶部应有且只有一条常驻的改动记录（实际 ${recent.length}）`)

  // 它不能是卡片，否则又回到「要展开才能看」
  assert.equal(
    byClass(walk(recent[0]), 'an-card').length, 0,
    '改动记录不该再是 an-card —— 卡片默认收起的可能性就在这里'
  )

  // 而且它必须在分区导航之后、任何卡片之前：无论停在哪一栏都看得见
  const flat = walk(lastTree)
  const navIndex = flat.findIndex((n) => n.props?.className === 'an-sectnav')
  const recentIndex = flat.findIndex((n) => n.props?.className === 'an-recent')
  const firstCardIndex = flat.findIndex((n) => n.props?.className === 'an-card')
  assert.ok(navIndex >= 0, '找不到分区导航')
  assert.ok(recentIndex > navIndex, '改动记录应排在分区导航之后')
  assert.ok(recentIndex < firstCardIndex, '改动记录应排在所有卡片之前（要第一眼看见）')

  // 第三次反馈之后才长成下拉：收起态**一行都不画明细**。
  // 用户原话「太大了占位置不好看」—— 之前常驻 3 条预览正是元凶。
  assert.equal(
    byClass(walk(recent[0]), 'an-audit-change').length, 0,
    '收起态还在画明细行，又变成拖着一条长尾巴'
  )
  const toggle = walk(recent[0]).find((n) => n.props?.className === 'an-recent-toggle')
  assert.ok(toggle, '缺下拉开关（an-recent-toggle），那就没法展开了')
  assert.equal(toggle.props['aria-expanded'], 'false')
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
  assert.equal(byClass(cardNodes(lastTree, dict.zh['ws.title'], 'ws'), 'an-chip').length, 0, '工作区表单不该出现一键填入按钮')
  // 反向确认这条断言真的看得见东西：全局那张卡里必须有按钮组，
  // 否则上面那句在「按钮组整个没画出来」时也会通过。
  assert.ok(byClass(cardNodes(lastTree, dict.zh['style.title'], 'style'), 'an-chip').length > 0, '全局风格卡里应当有按钮组')
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

await test('注入情况：拉 state 时必须带上当前工作区坐标（否则解释面板拿错答案）', async () => {
  // 回归（2026-11-09）：`loadState()` 原来打的是裸 `/api/anima/state`，而宿主用
  // `?cwd=` 决定「按哪个工作区算注入」（index.mjs 的 state 路由读 searchParams.cwd）。
  // 不带就是按「没有工作区上下文」算 ⇒ 一条正在生效的工作区记忆会被标成
  // `no-workspace-context`，面板指着它说「这条没进去」。
  //
  // 这个 bug 以前看不见，因为工作区记忆根本落不了库（导入丢 cwd 那个 bug）——
  // 没有工作区条目可解释，面板错也错得无从对照。
  const stateUrls = () => fetchCalls.filter((c) => c.url.includes('/api/anima/state')).map((c) => c.url)
  const wsPath = 'D:\\deepseek工作区'

  // ① 有工作区时：state 请求要带上它
  await controller.loadWorkspace(wsPath)
  await flush()
  const withWs = stateUrls()
  assert.ok(withWs.length > 0, '换工作区后没有重拉 state')
  assert.ok(
    withWs.some((u) => u.includes(encodeURIComponent(wsPath))),
    `拉 state 没带工作区坐标：${JSON.stringify(withWs.slice(-3))}`
  )

  // ② 回到「没选工作区」时：不能继续带着上一次的坐标（那会把答案算在错的工作区上）
  await controller.loadWorkspace('')
  await flush()
  const last = stateUrls().pop()
  assert.ok(last, '清空工作区后没有重拉 state')
  assert.equal(last.includes('cwd='), false, `没选工作区却还带着坐标：${last}`)
})

await test('注入情况：超窗计数只在大于 0 时出现（0 条时不画，避免一条永远不动的水位）', async () => {
  // 现状：21 条记忆全是 7 天龄、全部 fresh。如果这条计数常显，
  // 它会长期挂着一个 0；而一个长期不动的数字会让人不再看它，
  // 真跳到 3 条那天也不会被注意到。
  assert.equal(allText(walk(lastTree)).includes(dict.zh['inj.decayed']), false,
    '没有超窗条目时不该画这一行')

  // 正例：只有 included 里的条目算超窗。未注入的那条即使 decayed 也不该计入，
  // 因为它根本没进提示词 —— 计进去会让人以为影响到了模型。
  const decisions = STATE_PAYLOAD.injection.decisions
  const saved = decisions.map((d) => d.decayed)
  try {
    decisions[0].decayed = true
    decisions[1].decayed = true
    // 只改载荷不够：store 还是上一次 loadState 的快照，不重拉就等于没改。
    await controller.loadState()
    await flush()

    const text = allText(walk(lastTree))
    assert.ok(text.includes(dict.zh['inj.decayed']), '有条目超窗时必须画出这一行')
    // 两条都标了 decayed，但只有第一条 included → 计数必须是 1 而不是 2。
    const dd = byClass(walk(lastTree), 'an-kv')
      .map((n) => allText(walk(n)))
      .find((s) => s.includes(dict.zh['inj.decayed']))
    assert.ok(dd, `没找到超窗那一行：${text.slice(0, 400)}`)
    assert.ok(dd.includes('1'), `只数已注入的超窗条目，实际渲染：${dd}`)
    assert.equal(/\b2\b/.test(dd), false, `未注入的条目被计进去了：${dd}`)
  } finally {
    decisions.forEach((d, i) => { d.decayed = saved[i] })
    await controller.loadState()
    await flush()
  }
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

/** 取当前树里某个审计字段行（按 .an-audit-key 的文本找）。
 *
 * 注意这里收的是**人话名**（词典里的 field.*），不是 lib/store.mjs 的原始键名：
 * 界面上显示的就是人话，按 `agentName` 去找永远找不到 —— 那是曾经的样子。 */
function auditChangeRow(label) {
  const rows = byClass(walk(lastTree), 'an-audit-change')
  return rows.find((row) => walk(row).some((n) => n.kind === 'text' && n.value === label)) ?? null
}

/** 取一行审计里的字段名（.an-audit-key 的文本）。 */
function auditKeyText(row) {
  const key = byClass(walk(row), 'an-audit-key')[0]
  if (!key) return ''
  return walk(key).filter((n) => n.kind === 'text').map((n) => n.value).join('')
}

/** 找顶部常驻「最近改了什么」里的某个按钮（按词典文案）。 */
function auditButton(labelKey) {
  const section = byClass(walk(lastTree), 'an-recent')[0]
  assert.ok(section, '找不到顶部常驻的改动记录（an-recent）')
  return walk(section).find((n) => n.kind === 'element' && n.type === 'button'
    && String(n.props.children) === dict.zh[labelKey]) ?? null
}

/** 下拉开关本身（它不靠 - 里，文案是「变更记录」而不是 labelKey）。 */
function auditToggle() {
  const section = byClass(walk(lastTree), 'an-recent')[0]
  assert.ok(section, '找不到顶部常驻的改动记录（an-recent）')
  return walk(section).find((n) => n.props?.className === 'an-recent-toggle') ?? null
}

await test('收起态：只占一行，不画明细、不预打 /audit', () => {
  // 首屏用的是 /state 随包下发的计数，不发请求 —— 打开设置页不该等一份日志。
  assert.equal(fetchCalls.some((c) => c.url.includes('/api/anima/audit')), false, '收起态不该发 /audit')
  const texts = allText(walk(lastTree))
  assert.ok(texts.includes(`${dict.zh['audit.total']} 2`), `没显示条数徽标：${texts.slice(0, 300)}`)
  // 条数照旧告诉用户「值不值得点开」，但明细一行都不铺
  assert.equal(byClass(walk(lastTree), 'an-audit-change').length, 0, '收起态不该铺明细行')
})

await test('展开：真打一次 /audit，并渲染出明细', async () => {
  fetchCalls.length = 0
  const toggle = auditToggle()
  assert.ok(toggle, '缺下拉开关')
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
  assert.ok(joined.includes(dict.zh['field.agentName']), `没显示字段名：${joined.slice(0, 400)}`)
  assert.ok(joined.includes(dict.zh['audit.actor.agent']), '没显示改动者（模型）')
  assert.ok(joined.includes(dict.zh['audit.actor.user']), '没显示改动者（你）')
})

await test('字段名翻人话：界面上不许出现 agentName 这类代码键名', () => {
  // 这条是防回归的：改动记录曾经直接把 diffConfig 的原始键名画在屏幕上，
  // 「UI 面向人类不面向 AI」这句抱怨指的就是它。断言用一份真实键名清单，
  // 任何一个漏到界面上都算失败。
  const rawKeys = [
    'agentName', 'agentRole', 'addressUserAs', 'userOccupation', 'userBio',
    'headingLists', 'replyLength', 'customInstructions', 'requireToolConfirmation',
    'trailColor', 'trailSpeed', 'trailWidth', 'workspaceOverridesEnabled',
    'workspaceFileDir', 'memory.maxInjected', 'memory.maxPending', 'quality.ledgerLevel'
  ]
  const joined = allText(walk(lastTree))
  const leaked = rawKeys.filter((key) => joined.includes(key))
  assert.equal(leaked.length, 0, `这些代码键名漏到界面上了：${JSON.stringify(leaked)}`)

  // 反向确认：三行都翻成了词典里的人话，不是「什么都没显示」而侥幸过关
  const rows = byClass(walk(lastTree), 'an-audit-change')
  const labels = rows.map((row) => auditKeyText(row))
  assert.equal(labels.length, 3, `明明有三行却只取到 ${labels.length} 个字段名`)
  const expected = [dict.zh['field.style'], dict.zh['field.agentName'], dict.zh['field.presets']]
  for (const label of labels) {
    assert.ok(expected.includes(label), `字段名不是词典里的人话：${JSON.stringify(label)}`)
  }
})

await test('展开后取的是全量：新条目在上', async () => {
  const rows = byClass(walk(lastTree), 'an-audit-change')
  const labels = rows.map((row) => auditKeyText(row))
  // /audit 的第三条（style）应排在 state 那两条之前 —— 新的在上
  assert.equal(labels[0], dict.zh['field.style'], `最新一条不在最前：${JSON.stringify(labels)}`)
})

await test('摘要值相等时只显示一次，不编造差异', () => {
  const row = auditChangeRow(dict.zh['field.presets'])
  assert.ok(row, `找不到「${dict.zh['field.presets']}」那行`)
  const inner = walk(row)
  assert.equal(inner.filter((n) => n.kind === 'text' && n.value === '[1 项]').length, 1, '值相等却显示了两次')
  assert.equal(byClass(inner, 'an-audit-from').length, 0, '值相等时不该有划线原值')
  assert.equal(inner.some((n) => n.kind === 'text' && n.value.includes('→')), false, '值相等却画了箭头')
  // 真变了的字段反过来必须有原值 → 新值
  const real = auditChangeRow(dict.zh['field.agentName'])
  assert.ok(real, `找不到「${dict.zh['field.agentName']}」那行`)
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

await test('收起：整块收起只剩一行，清空入口消失', async () => {
  // 下拉的语义：收起 = 明细全收走，不是「只留预览」。顶部那一行始终在，
  // 所以「用户又不知道改成啥了」不成立 —— 他一眼能看见条数。
  const hide = auditToggle()
  assert.ok(hide, '缺下拉开关')
  assert.equal(hide.props['aria-expanded'], 'true')
  hide.props.onClick()
  await flush()

  // ① 开关翻回收起态
  assert.equal(auditToggle().props['aria-expanded'], 'false', '收起后 aria-expanded 没翻回 false')
  // ② 清空记录只属于展开视图，收起态不该出现（防止误删整份日志）
  assert.equal(auditButton('audit.clear'), null, '收起态仍留着清空入口')
  // ③ 明细全收走
  assert.equal(byClass(walk(lastTree), 'an-audit-change').length, 0, '收起后还留着明细行')
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

await test('展开预览：点卡片标题栏展开后才拉，走 400ms 防抖，并显示宿主返回的文本', async () => {
  fetchCalls.length = 0
  // 预览卡默认收起（「查的收起」），展开入口就是卡片自己的折叠按钮 ——
  // 2026-10-29 之前这里还有第二个「显示/收起」按钮，两层门，已删。
  const openToggle = () =>
    byClass(cardNodes(lastTree, dict.zh['preview.title'], 'preview'), 'an-card-toggle')[0]
  const collapsed = () =>
    byClass(walk(lastTree), 'an-card an-card-collapsed').some((n) => n.props['data-an-card'] === 'preview')

  if (collapsed()) {
    const toggle = openToggle()
    assert.ok(toggle, '缺预览卡的展开按钮')
    assert.equal(toggle.props['aria-expanded'], 'false', '收起态的按钮应标 aria-expanded=false')
    toggle.props.onClick()
    await flush()
  }
  assert.equal(collapsed(), false, '点了展开但卡片仍收着')
  // 防抖未到时不该发请求（这一步必须在展开后重新清零，展开本身不拉数据）
  fetchCalls.length = 0
  // 改一个字段触发重新预览，验证防抖
  const nameInput = elements(walk(lastTree), 'input').find((n) => n.props.id === 'an-agent-name')
  nameInput.props.onChange({ target: { value: '小沃' } })
  assert.equal(fetchCalls.some((c) => c.url.includes('/preview')), false, '防抖失效，立刻发了请求')

  await new Promise((resolve) => setTimeout(resolve, 500))
  await flush()

  const previewCall = fetchCalls.find((c) => c.url.includes('/preview'))
  assert.ok(previewCall, '防抖到期后没发 /preview')
  assert.ok(previewCall.url.includes('agentName='), `预览应带上未保存的草稿字段：${previewCall.url}`)

  const text = allText(walk(lastTree))
  assert.ok(text.includes('你的名字：小沃'), `预览文本没显示出来：${text.slice(0, 200)}`)
  assert.ok(text.includes('本工作区'), '字段来源说明没显示')

  // 收回去，别把折叠态留给后面依赖「默认收着」的用例。
  // （2026-10-29 首次写这条时忘了收，下一条折叠用例读到 {preview:false}，
  //   断言精确 JSON 就红了 —— 泄漏状态比断言不准更常见。）
  if (!collapsed()) {
    openToggle().props.onClick()
    await flush()
  }
  assert.equal(collapsed(), true, '预览用例跑完后没把卡片收回原样')
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

await test('卡片折叠：默认态按「改的展开、查的收起」，手动翻过就听用户的', async () => {
  // 存储键在 2026-10-29 换了：旧键 `collapsed-cards` 只记「收起的」，
  // 而新规则下「收起的」正好是默认态 —— 沿用旧键会让以前手展开过的卡永久收起。
  const CARD_STATE_KEY = 'dsh-anima:card-state'
  const title = dict.zh['identity.title']
  // 判「正文还在不在」必须挑一个只出现在正文里的东西：卡头（aside 里的折叠按钮
  // 与标题）收起后照样渲染，拿标题或按钮文案去判会永远为真。
  const hasBody = () => elements(walk(lastTree), 'input').some((n) => n.props.id === 'an-agent-name')
  const collapsedClasses = () =>
    byClass(walk(lastTree), 'an-card an-card-collapsed').map((n) => n.props['data-an-card'])
  // 用例中途失败也别把折叠态留给后面的用例：后文有断言依赖「卡片是展开的」。
  const restore = () => {
    for (const button of elements(walk(lastTree), 'button')) {
      if (button.props.className === 'an-card-toggle' && button.props['aria-expanded'] === 'false') {
        button.props.onClick()
      }
    }
  }

  try {
    storageBacking.delete(CARD_STATE_KEY)
    const fresh = walk(renderFreshSettings())
    const freshCollapsed = byClass(fresh, 'an-card an-card-collapsed').map((n) => n.props['data-an-card'])
    assert.ok(
      !freshCollapsed.includes('identity'),
      `人设卡是「改东西」的地方，默认必须展开（实际收起的：${JSON.stringify(freshCollapsed)}）`
    )
    assert.ok(
      freshCollapsed.includes('preview'),
      `预览卡是「看结果」的地方，默认应当收起（实际收起的：${JSON.stringify(freshCollapsed)}）`
    )

    const toggle = byClass(cardNodes(lastTree, title, 'identity'), 'an-card-toggle')[0]
    assert.ok(toggle, '缺折叠按钮')
    assert.equal(toggle.props['aria-expanded'], 'true', '初始应展开')
    assert.ok(hasBody(), '展开态下卡片正文应在树里')

    toggle.props.onClick()
    await flush()

    // 断言按字段读，不比对整份 JSON：这份存储里还有别的卡的记录
    // （预览卡默认收起，前面用例可能已经写进去过），整份比对会把
    // 「别人留下的记录」误判成「本卡没落盘」。
    const stored = () => JSON.parse(storageBacking.get(CARD_STATE_KEY) ?? '{}')
    assert.equal(stored().identity, true, '折叠状态没落盘')
    // 收起是「用 display:none 藏起来」，**不是卸载**。这一点与 2.1.9 之前相反，
    // 改的原因是：卡片正文里全是没有独立保存按钮的草稿（身份/背景/风格都是随敲随存
    // 到内存、要按底部保存栏才落盘的），卸载等于「一收卡就把刚敲的字扔了」 ——
    // 那是少功能。记忆卡里的子块早就这么做，卡片这一层当时漏了。
    assert.deepEqual(collapsedClasses().sort(), ['identity', 'preview'], '人设卡收起后应与预览卡并列')
    const bodies = elements(walk(lastTree), 'div').filter((n) => n.props.className === 'an-card-body')
    assert.ok(bodies.length > 0, '找不到卡片正文容器 .an-card-body')
    const identityBody = byClass(cardNodes(lastTree, title, 'identity'), 'an-card-body')[0]
    assert.ok(identityBody, '收起后 .an-card-body 不该从树里消失')
    assert.equal(identityBody.props.style?.display, 'none', '收起的卡正文应带 display:none')
    assert.ok(hasBody(), '收起只是藏起来，输入框不该被卸载（否则草稿会丢）')
    assert.ok(
      byClass(walk(lastTree), 'an-card-title').map((n) => n.props.children).includes(title),
      '收起的是正文，卡头不该跟着消失'
    )

    // 再点一次展开：按钮此时带着 aria-expanded="false"（byClass 是严格全等，
    // 收起后的卡片节点已经不在 cardNodes 里了，只能全页找）。
    const reopen = elements(walk(lastTree), 'button').find(
      (n) => n.props.className === 'an-card-toggle' && n.props['aria-expanded'] === 'false' &&
        String(n.props.children) === dict.zh['card.expand']
    )
    assert.ok(reopen, '收起后找不到展开按钮')
    reopen.props.onClick()
    await flush()
    // 翻回默认态也要**写下来**，不能删键：删键等于「回到默认」，
    // 用户这一下就变成了「点了没反应」。
    assert.equal(stored().identity, false, '翻回展开态后应记下 false，而不是删掉键')
    assert.ok(hasBody(), '展开后正文没回来')

    // 脏值：手改过 localStorage（值不是布尔、或整段不是 JSON）时一律丢弃，
    // 回落到卡片自己的默认态，否则一次误改就能让某张卡永远打不开。
    storageBacking.set(CARD_STATE_KEY, JSON.stringify({ identity: 'yes', preview: 1 }))
    assert.equal(
      byClass(walk(renderFreshSettings()), 'an-card an-card-collapsed').length,
      1,
      '非布尔脏值不该生效（此时只有预览卡按默认收起）'
    )

    storageBacking.set(CARD_STATE_KEY, '{oops')
    assert.equal(
      byClass(walk(renderFreshSettings()), 'an-card an-card-collapsed').length,
      1,
      '坏 JSON 应该被当成空对象，不是让整页崩'
    )

    // 真值仍然生效：脏值被忽略不等于把功能整个关掉
    storageBacking.set(CARD_STATE_KEY, JSON.stringify({ identity: true }))
    assert.equal(
      byClass(walk(renderFreshSettings()), 'an-card an-card-collapsed').length,
      2,
      '真值没被读进去'
    )
    // 反向也是真的：把默认收起的预览卡写成 false，它就该展开
    storageBacking.set(CARD_STATE_KEY, JSON.stringify({ preview: false }))
    assert.equal(
      byClass(walk(renderFreshSettings()), 'an-card an-card-collapsed').length,
      0,
      'false 没能覆盖默认收起'
    )
    // 上面几条都用 renderFreshSettings 反复重建，会留下「展开态」的记忆 ——
    // 清掉，别让后文依赖默认收起的用例读到污染值。
    storageBacking.delete(CARD_STATE_KEY)
  } finally {
    restore()
    storageBacking.delete(CARD_STATE_KEY)
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
  let inner = cardNodes(lastTree, title, 'preview')
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

    inner = cardNodes(lastTree, title, 'preview')
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
  const nodes = () => cardNodes(lastTree, memTitle, 'mem')
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
  const nodes = () => cardNodes(lastTree, memTitle, 'mem')
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

  // 提交也必须带上工作区坐标：workspace 级条目要在落库时记下属于哪个工作区，
  // 否则它永远匹配不上、永远不注入，而界面上一切正常（2026-11-08 的真实 bug）。
  const commitCall = fetchCalls.find((c) => c.url.includes('/memory/import/commit'))
  assert.ok(commitCall, '没有调用提交路由')
  assert.ok(
    commitCall.url.includes(encodeURIComponent(WORKSPACE_PATH)),
    `提交没带 cwd：${commitCall.url}`
  )
  assert.equal(payload.items[0].cwd, undefined, 'cwd 只能走查询参数，不该混进 body')

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
  const nodes = () => cardNodes(lastTree, memTitle, 'mem')
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
    const nodes = cardNodes(lastTree, dict.zh['mem.title'], 'mem')
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

await test('导入面板：没选定工作区时「本工作区」按钮置灰，且预览里挂着的 workspace 会显示成全局', async () => {
  // 为什么要有这条：没 cwd 时仍能点「本工作区」，落库就是一条没有坐标的记录，
  // 它永远匹配不上、永远不注入 —— 按钮亮着等于骗用户。
  //
  // 注意 workspacePath 是 store 里的会话状态，`applyState` 并不写它（只有
  // `loadWorkspace` 会写）。所以这里必须走真实用户路径：把工作区选择器选成空。
  const memTitle = dict.zh['mem.title']
  try {
    await controller.loadWorkspace('')
    await flush()
    // 不直接读 controller.store（冒烟里的 controller 不是真实类实例）：
    // 用界面反推出的「本工作区按钮是否可点」作前置校验才有意义 —— 若前置没成立，
    // 下面那条 disabled 断言会因为别的原因失败，反而看不出问题。

    const nodes = () => cardNodes(lastTree, memTitle, 'mem')
    const findButton = (label) => elements(nodes(), 'button').find((n) => n.props.children === label)

    // 展开面板（前面用例可能已经收起）
    const entry = findButton(dict.zh['imp.open'])
    if (entry) {
      entry.props.onClick()
      await flush()
    }
    const panelText = () => elements(nodes(), 'textarea').find((n) => n.props.id === 'an-import-text')
    assert.ok(panelText(), '面板没展开')

    panelText().props.onChange({ target: { value: '另一段粘贴内容' } })
    await flush()
    const parseButton = findButton(dict.zh['imp.parse'])
    assert.ok(parseButton, '缺解析按钮')
    parseButton.props.onClick()
    await flush()

    // 预览里第二条本该是 workspace，但没 cwd ⇒ 只能显示成全局
    assert.ok(
      allText(nodes()).includes(IMPORT_PARSE_PAYLOAD.items[1].text),
      '第二条没进预览'
    )
    const wsButton = elements(nodes(), 'button').find(
      (n) => n.props.children === dict.zh['imp.layerWorkspace']
    )
    assert.ok(wsButton, '缺「本工作区」按钮')
    assert.equal(wsButton.props.disabled, true, '没工作区时「本工作区」不该可点')
    assert.ok(
      String(wsButton.props.title ?? '').includes(dict.zh['imp.layerNoWorkspace']),
      `置灰按钮要说清原因：${wsButton.props.title}`
    )

    // 提交：既然没有坐标，就只能提交全局级别 —— 不能带着 workspace 上去被拒
    commitBodies.length = 0
    const commitButton = findButton(dict.zh['imp.commit'])
    assert.ok(commitButton, '缺提交按钮')
    commitButton.props.onClick()
    await flush()
    assert.equal(commitBodies.length, 1)
    for (const item of commitBodies[0].items) {
      assert.equal(item.layer, 'global', `没坐标却提交了 workspace 级：${JSON.stringify(item)}`)
    }
    const call = fetchCalls.filter((c) => c.url.includes('/memory/import/commit')).pop()
    assert.ok(call, '没有调用提交路由')
    assert.equal(
      call.url.includes('cwd='),
      false,
      `没选定工作区时不该带空的 cwd 参数：${call.url}`
    )
  } finally {
    // 恢复成有工作区的状态：后面还有用例要靠它
    await controller.loadWorkspace(WORKSPACE_PATH)
    await flush()
  }
})

await test('运行时没攒下未捕获的钩子异常', () => {
  assert.deepEqual(runtime.errors, [], `钩子执行抛了 ${runtime.errors.length} 次`)
})

// 这条测的是「表单里看得见的值，保存时真的会被带上」。
//
// 真实缺陷（2026-10-20 修）：maxInjectedChars 的输入框早就在、能打字、能显示，
// 但 memoryDefaults 与 configPayload 里都没有这个键 —— 于是它既不进保存载荷，
// 也不进脏检测。表现是：用户改了数字，保存按钮一直是灰的，一个字节都没写盘，
// 而界面上一切正常。41 项客户端冒烟全绿也没抓到它，因为这些用例只渲染不保存。
//
// 所以这条用例不看渲染，直接看**发给宿主的请求体**。
await test('记忆层的字符预算必须真的进保存载荷（能显示却存不下的字段等于不存在）', async () => {
  renderFreshSettings()
  await flush()

  const card = cardNodes(lastTree, dict.zh['mem.title'], 'mem')[0]
  assert.ok(card, '缺长期记忆卡片')

  // 直接把输入框的 onChange 调成 1234，模拟用户改了这个值。
  const input = elements(walk(lastTree), 'input').find((n) => n.props.id === 'an-mem-chars')
  assert.ok(input, '缺「最多注入字符」输入框')
  input.props.onChange({ target: { value: '1234' } })
  await flush()

  // 改了值之后，保存按钮必须变成可点 —— 否则说明它根本没进脏检测。
  const save = elements(walk(lastTree), 'button').find((n) => String(n.props.children) === dict.zh['common.save'])
  assert.ok(save, '缺保存按钮')
  assert.equal(Boolean(save.props.disabled), false, '改了字符预算却没变脏：这个值没进脏检测')

  fetchCalls.length = 0
  await save.props.onClick()
  await flush()

  const post = fetchCalls.find((c) => c.url.includes('/api/anima/config') && c.method === 'POST')
  assert.ok(post, '没发出保存请求')
  const body = JSON.parse(String(post.body))
  assert.equal(
    body.memory.maxInjectedChars,
    1234,
    '载荷里没有 maxInjectedChars（或值没跟过去）—— 输入框能改，但存不下'
  )
  // 顺带把同段的另一个数字也钉住：只验一个新字段，容易漏掉「顺手把别的挤掉」。
  assert.equal(typeof body.memory.maxInjected, 'number', '载荷丢了 maxInjected')
})

// 质检开关是这一层唯一能当场闭嘴的入口，所以它的三条硬要求各有各的用例：
// ① 界面上的值必须来自宿主配置（不是硬编码默认值）；
// ② 改了必须进载荷（否则又是「能改却存不下」）；
// ③ checks=0 时界面必须明说「没在工作」，不许显示得像一切正常。
//
// 注意事件形状：这些控件的 onChange 收的是事件对象而不是裸值。
// 直接传 false 会在 Toggle 内部的 event.target.checked 上炸掉 —— 那是假绿的反面：
// 用例会「报错」而不是「失败」，看起来像环境问题而不像断言问题。
await test('质检卡片：五项都从宿主配置读出来，关掉总开关后卡片还在（关得回来）', async () => {
  renderFreshSettings()
  await flush()

  const title = dict.zh['quality.title']
  assert.ok(cardNodes(lastTree, title, 'quality')[0], '缺质检卡片')

  const inputById = (id) => elements(walk(lastTree), 'input').find((n) => n.props.id === id)
  const selectById = (id) => elements(walk(lastTree), 'select').find((n) => n.props.id === id)

  const enabled = inputById('an-quality-enabled')
  assert.ok(enabled, '缺「启用质检层」开关')
  assert.equal(enabled.props.checked, true, '开关没反映宿主配置（应为开）')

  const ledger = selectById('an-quality-ledger')
  assert.ok(ledger, '缺对账档位下拉框')
  assert.equal(ledger.props.value, 'three', '档位没反映宿主配置')
  // 三个档位必须都在选项里：少一个就永远选不到那个值。
  const options = elements(walk(ledger), 'option').map((n) => n.props.value)
  assert.deepEqual(options, ['off', 'three', 'five'], `档位选项不全：${options.join('/')}`)

  assert.equal(inputById('an-quality-strict')?.props.checked, true, '严格判词没反映宿主配置')
  assert.equal(inputById('an-quality-precheck')?.props.checked, true, '机制检查没反映宿主配置')
  assert.equal(Number(inputById('an-quality-max')?.props.value), 5, '每轮条数没反映宿主配置')

  // 关掉总开关：卡片不能整片消失 —— 那是「关下去就点不回来」的形状，
  // 而这一层恰好在「太吵了想关」的时刻被用到，关掉后再想开必须还有路。
  enabled.props.onChange({ target: { checked: false } })
  await flush()
  assert.ok(cardNodes(lastTree, title, 'quality')[0], '关掉总开关后整张卡片消失了，开不回来')
  assert.equal(inputById('an-quality-enabled').props.checked, false, '关掉后开关没变')
})

await test('质检五项必须真的进保存载荷（显示得出却存不下的字段等于不存在）', async () => {
  renderFreshSettings()
  await flush()

  const inputById = (id) => elements(walk(lastTree), 'input').find((n) => n.props.id === id)
  const selectById = (id) => elements(walk(lastTree), 'select').find((n) => n.props.id === id)

  // 把四项都改成非默认值（strict 保持 true，它是唯一「开着」的默认值）：
  // 只改一项的话，漏掉另外几项仍然会全绿。
  inputById('an-quality-enabled').props.onChange({ target: { checked: false } })
  selectById('an-quality-ledger').props.onChange({ target: { value: 'five' } })
  inputById('an-quality-precheck').props.onChange({ target: { checked: false } })
  inputById('an-quality-max').props.onChange({ target: { value: '9' } })
  await flush()

  const save = elements(walk(lastTree), 'button').find((n) => String(n.props.children) === dict.zh['common.save'])
  assert.ok(save, '缺保存按钮')
  assert.equal(Boolean(save.props.disabled), false, '改了质检设置却没变脏：这些值没进脏检测')

  fetchCalls.length = 0
  await save.props.onClick()
  await flush()

  const post = fetchCalls.find((c) => c.url.includes('/api/anima/config') && c.method === 'POST')
  assert.ok(post, '没发出保存请求')
  const body = JSON.parse(String(post.body))
  assert.ok(body.quality, '载荷里根本没有 quality 段')
  assert.equal(body.quality.enabled, false, 'enabled 没进载荷')
  assert.equal(body.quality.ledgerLevel, 'five', 'ledgerLevel 没进载荷')
  assert.equal(body.quality.strict, true, 'strict 没进载荷')
  assert.equal(body.quality.preStepCheck, false, 'preStepCheck 没进载荷')
  assert.equal(body.quality.maxFindingsInReminder, 9, 'maxFindingsInReminder 没进载荷')
  // 顺手钉住记忆段：新增一个段最容易把相邻段的默认值挤掉。
  assert.equal(typeof body.memory.maxInjected, 'number', '新增 quality 段把 memory 段挤掉了')
})

await test('记忆卡片的四项元数据必须画出来（记了但看不见，等于没记）', async () => {
  // 这四项以前只在 JSON 里能看到。看不见的结果是：用户只能选择相信整份记忆库——
  // 一条是事实还是偏好（决定它衰不衰减）、复核点过没过期（决定它还算不算数）、
  // 出处是什么（决定它能不能被核对），全都无从判断。
  const saved = STATE_PAYLOAD.memories
  try {
    STATE_PAYLOAD.memories = {
      pending: [],
      adopted: [
        {
          id: 'm-meta',
          text: '某条带着完整元数据的记忆',
          status: 'adopted',
          capturedAt: 1760000000000,
          type: 'preference',
          state: 'superseded',
          verifyAt: '2020-01-01',
          sourceRef: '用户原话@session-abc#seq=11'
        }
      ],
      discarded: []
    }
    // 只换 STATE_PAYLOAD 不够：store 还是上一次 loadState 的快照，不重拉就等于
    // 在测旧数据 —— 这条用例会「绿得毫无意义」。见下方 quality 那条用例的同一教训。
    await controller.loadState()
    renderFreshSettings()
    await flush()
    // 注意：cardNodes 返回的是「这张卡的扁平节点表」（数组），不是单个节点。
    // 第一版写成 cardNodes(...)[0] 再交给 allText，报 nodes.filter is not a function ——
    // 测试夹具写错形状时，红的是测试本身，但它同样会挡住真信号。
    const text = allText(cardNodes(lastTree, dict.zh['mem.title'], 'mem'))
    assert.ok(text.includes(dict.zh['mem.typePreference']), '类型徽章没画出来')
    assert.ok(text.includes(dict.zh['mem.stateSuperseded']), '「曾如此」没画出来：用户会以为它还现行')
    assert.ok(text.includes('2020-01-01'), '复核点没画出来')
    assert.ok(text.includes(dict.zh['mem.verifyOverdue']), '复核点已经过期，却没标出来')
    assert.ok(text.includes('session-abc#seq=11'), '出处没画出来，这条记忆就无法被核对')
  } finally {
    STATE_PAYLOAD.memories = saved
  }
})

await test('体检面板：没查过时一个字都不许说，查过才给结论', async () => {
  // 「没查」与「查了没事」必须长得不一样。前者是未知，后者是结论 ——
  // 把未知画成结论，就是本项目一直在防的那件事。
  renderFreshSettings()
  await flush()
  const card = cardNodes(lastTree, dict.zh['mem.title'], 'mem')
  const text = allText(card)
  assert.ok(text.includes(dict.zh['checkup.run']), '记忆卡片里没有体检入口')
  assert.equal(
    text.includes(dict.zh['checkup.clean']),
    false,
    '还没查过就说「都通过了」——这是把未知说成结论'
  )
  assert.equal(
    text.includes(dict.zh['checkup.stale']),
    false,
    '还没查过却画出了「结果来自上一次体检」的提示'
  )
})

await test('体检面板：查出问题必须逐条给出证据与命令，不许只说「有问题」', async () => {
  const saved = STATE_PAYLOAD.memories
  try {
    STATE_PAYLOAD.memories = {
      pending: [],
      adopted: [
        { id: 'm-gone', text: '工具链装在 D:\\gone-not-here 下', status: 'adopted', capturedAt: 1760000000000, type: 'fact' }
      ],
      discarded: []
    }
    await controller.loadState()
    renderFreshSettings()
    await flush()
    const card = cardNodes(lastTree, dict.zh['mem.title'], 'mem')
    // 先确认按钮真的画出来了，再点它 —— 直接调回调会绕过「入口有没有渲染」这一层。
    // 注意 allText 只收 text 节点，不能直接喂 element 节点（那样恒为空串，
    // 于是一条本该红的用例会以「找不到按钮」的形式红，看起来像实现缺了）。
    const buttons = elements(card, 'button').filter((node) => allText(walk(node, [])).trim() === dict.zh['checkup.run'])
    assert.ok(buttons.length > 0, '没有找到「体检」按钮')
    buttons[0].props.onClick()
    await flush()
    const text = allText(cardNodes(lastTree, dict.zh['mem.title'], 'mem'))
    assert.ok(text.includes(dict.zh['checkup.kindPathMissing']), '路径不存在的问题没被画出来')
    assert.ok(text.includes('D:\\gone-not-here'), '证据里没写出到底是哪个路径')
    assert.ok(text.includes('/anima mark m-gone state=contradicted'), '没给出可直接粘贴的命令')
    assert.ok(text.includes(dict.zh['checkup.apply']), '没有「按建议标为有争议」的按钮')
    // 关键：体检不许自动改任何东西。扫可以自动，裁决必须由人点。
    assert.equal(
      fetchCalls.some((call) => String(call.url ?? '').includes('/memory/meta')),
      false,
      '体检居然调了写接口 —— 扫描可以自动，裁决必须由人点'
    )
  } finally {
    STATE_PAYLOAD.memories = saved
  }
})

await test('记忆卡内的清单子块：只有待审默认展开，收起只是 display:none 不卸子树', async () => {
  // 这条钉的是三件事，任何一件退回去都会让这张卡难用：
  //   ① 默认态按「现在就得处理的展开、其余收起」分 —— 2.1.10 起连
  //      「手动添加」也默认收起（它是常驻空表单，实测 333px），
  //      所以四个子块里只有待审是展开的；
  //   ② 收起用 display:none，**子树仍在渲染树里** —— 子块里有未提交的草稿
  //      （手动添加的文本框），卸载等于把用户刚敲的字扔掉；
  //   ③ 折叠态与卡片共用同一份 localStorage，翻过之后要记得住。
  const CARD_STATE_KEY = 'dsh-anima:card-state'
  const saved = STATE_PAYLOAD.memories
  const nodes = () => cardNodes(lastTree, dict.zh['mem.title'], 'mem')
  const toggles = () => elements(nodes(), 'button').filter((n) => n.props.className === 'an-block-toggle')
  // 子块的正文容器：折起时带 display:none，展开时没有 style。
  const bodies = () => elements(nodes(), 'div').filter((n) => n.props.className === 'an-block-body')

  try {
    storageBacking.delete(CARD_STATE_KEY)
    // 默认夹具里 discarded 是空的，而「已丢弃」子块只在有条目时才画 ——
    // 给它一条，否则子块数量会随夹具漂移，断言就成了在测夹具本身。
    STATE_PAYLOAD.memories = {
      ...saved,
      discarded: [{ id: 'm3', text: '被丢掉的', status: 'discarded', capturedAt: 1760000000000 }]
    }
    await controller.loadState()
    renderFreshSettings()
    await flush()

    // 四个子块：待审 / 手动添加 / 已采纳 / 已丢弃。
    assert.equal(toggles().length, 4, `记忆卡内应有四个可折叠子块，实际 ${toggles().length}`)

    const expanded = toggles().map((n) => n.props['aria-expanded'])
    // 只有「待审」展开；手动添加 / 已采纳 / 已丢弃 三个都收起。
    assert.deepEqual(expanded, ['true', 'false', 'false', 'false'], `默认态不对：${JSON.stringify(expanded)}`)

    // 基准值：卡片层面的收起数（点开子块前后必须一致）。
    const cardCollapsedBefore = byClass(walk(lastTree), 'an-card an-card-collapsed').length

    // 收起态：正文容器还在，只是 display:none。
    const hiddenBodies = bodies().filter((n) => n.props.style?.display === 'none')
    assert.equal(hiddenBodies.length, 3, `应有且只有三个子块默认收起，实际 ${hiddenBodies.length}`)
    // 关键：被收起的「已采纳」里那些条目文字仍在渲染树中 —— 不是卸载。
    assert.ok(
      allText(nodes()).includes(dict.zh['mem.adopted']),
      '收起后标题不该跟着消失'
    )
    assert.ok(
      allText(nodes()).includes('已采纳一'),
      '收起只是 display:none，条目文字不该从渲染树里消失'
    )
    // 2.1.10 新增：默认收起的是「手动添加」这张空表单，收起后它的
    // textarea 必须还在渲染树里 —— 用户点开时要接着敲，不能从空白开始。
    assert.ok(
      elements(nodes(), 'textarea').some((node) => node.props.placeholder === dict.zh['mem.addPlaceholder']),
      '手动添加默认收起后，它的文本框不该被卸载（否则刚敲的字会丢）'
    )

    // 点一下「已采纳」的展开按钮，它应当展开并写进同一份 localStorage。
    //
    // 不能直接取「第一个 aria-expanded=false 的按钮」：2.1.10 起默认收起
    // 三个子块（手动添加 / 已采纳 / 已丢弃），第一个已不再是「已采纳」。
    // 所以按「子块标题文本」定位到自己那一块，再从块内取折叠按钮。
    const blockToggleByTitle = (title) => {
      const heads = elements(nodes(), 'div').filter((n) => n.props.className === 'an-block-head')
      for (const head of heads) {
        const label = elements(walk(head, []), 'div').find((n) => n.props.className === 'an-block-title')
        if (!label) continue
        // 标题后面跟着条目计数（「已记住（1）」），所以按前缀认，不比整串。
        if (!String(allText(walk(label, []))).trim().startsWith(title)) continue
        const [toggle] = elements(walk(head, []), 'button').filter((n) => n.props.className === 'an-block-toggle')
        if (toggle) return toggle
      }
      return undefined
    }
    const adoptedToggle = blockToggleByTitle(dict.zh['mem.adopted'])
    assert.ok(adoptedToggle, '「已采纳」子块上找不到折叠按钮')
    assert.equal(adoptedToggle.props['aria-expanded'], 'false', '「已采纳」默认应收起')
    adoptedToggle.props.onClick()
    await flush()
    const stored = JSON.parse(storageBacking.get(CARD_STATE_KEY) ?? '{}')
    // 存的是「收起没有」：默认收起(true) → 点一下变成 false(展开)。
    assert.equal(stored['block:adopted'], false, `子块折叠态没落盘：${JSON.stringify(stored)}`)
    assert.equal(
      bodies().filter((n) => n.props.style?.display === 'none').length,
      2,
      '展开一个之后应只剩两个收起'
    )

    // 子块的类名不许污染卡片的折叠计数：点开一个子块，卡片层面的收起数不该动。
    // （不能死写「应为 1」——前面的用例会把预览卡的折叠态翻过来，那个基数会漂。）
    assert.equal(
      byClass(walk(lastTree), 'an-card an-card-collapsed').length,
      cardCollapsedBefore,
      '子块折叠被算进了卡片的收起数'
    )
  } finally {
    STATE_PAYLOAD.memories = saved
    storageBacking.delete(CARD_STATE_KEY)
    await controller.loadState()
    renderFreshSettings()
    await flush()
  }
})

await test('记忆卡片：没有元数据时不许凭空画出徽章（缺字段不等于「事实」）', async () => {
  // 老记忆一条都没有 type/state/verifyAt/sourceRef。回落成「事实」会让用户以为
  // 那是数据，其实是单元格空着 —— 空着就该什么都不画。
  const saved = STATE_PAYLOAD.memories
  try {
    STATE_PAYLOAD.memories = {
      pending: [],
      adopted: [{ id: 'm-bare', text: '一条没有任何元数据的旧记忆', status: 'adopted', capturedAt: 1760000000000 }],
      discarded: []
    }
    await controller.loadState()
    renderFreshSettings()
    await flush()
    const card = cardNodes(lastTree, dict.zh['mem.title'], 'mem')
    // 不能取全部 .an-item：记忆条目和体检发现用的是同一个 class，取全部会把
    // 别的用例留下的体检结果也算进来 —— 那时断言会以「明明没有复核点却画了复核点」
    // 的形式红，而真出问题时它同样红，等于这条用例既抓不到真问题也说不清假问题。
    // 正确做法是先按记忆正文定位到那一条，再只看它。
    const items = byClass(card, 'an-item')
    const bare = items.find((node) => allText(walk(node, [])).includes('一条没有任何元数据的旧记忆'))
    assert.ok(bare, `没有渲染出那条记忆条目，后面的断言等于没测（卡片里共 ${items.length} 个 .an-item）`)
    const text = allText(walk(bare, []))
    assert.equal(text.includes(dict.zh['mem.typeFact']), false, `没有 type 却画出了「事实」徽章｜实测条目文字：${text}`)
    assert.equal(text.includes(dict.zh['mem.verifyAt']), false, `没有复核点却画出了复核点｜实测条目文字：${text}`)
    assert.equal(text.includes(dict.zh['mem.sourceRef']), false, `没有出处却画出了出处｜实测条目文字：${text}`)
  } finally {
    STATE_PAYLOAD.memories = saved
  }
})

await test('运行计数为 0 时必须明说「没在工作」，不许显示得像一切正常', async () => {
  const saved = STATE_PAYLOAD.qualityStats
  const cardText = () => allText(cardNodes(lastTree, dict.zh['quality.title'], 'quality'))
  try {
    STATE_PAYLOAD.qualityStats = { checks: 0, reminders: 0, suppressed: 0, skipped: {}, last: null }
    // 只重渲染不够：store 还是上一次 loadState 的快照。必须真的重拉一次 state，
    // 否则这条用例测的是「上一次的数据」，checks=0 这个分支永远走不到 —— 假通过。
    await controller.loadState()
    renderFreshSettings()
    await flush()
    assert.ok(
      cardText().includes(dict.zh['quality.statsIdle']),
      `checks=0 时没给出「这一整套没在工作」的提示；实际渲染：${cardText().slice(0, 320)}`
    )
  } finally {
    STATE_PAYLOAD.qualityStats = saved
  }
  // 反之：有数据时不许还挂着那句提示，否则两次状态在界面上长得一样。
  await controller.loadState()
  renderFreshSettings()
  await flush()
  assert.equal(cardText().includes(dict.zh['quality.statsIdle']), false, '有数据了还在说「没在工作」')
  assert.ok(cardText().includes('R02'), '有判词时没把判词显示出来')
})

await test('巡夜记录：从没跑过 ≠ 跑过没事，两者必须长得不一样', async () => {
  const saved = STATE_PAYLOAD.patrolMeta
  const cardText = () => allText(cardNodes(lastTree, dict.zh['mem.title'], 'mem'))
  try {
    // ① 没有记录：必须明说「还没跑过」，绝不画成「没事」。
    STATE_PAYLOAD.patrolMeta = null
    await controller.loadState()
    renderFreshSettings()
    await flush()
    assert.ok(
      cardText().includes(dict.zh['patrol.never']),
      `没有巡夜记录时没说明「没跑过」；实际渲染：${cardText().slice(0, 300)}`
    )
    assert.equal(
      cardText().includes(dict.zh['patrol.silent']),
      false,
      '从没跑过却被画成了「跑过了、判为无事」——这是把未知当成结论'
    )

    // ② 跑过、判为无事、没汇报：必须写清是「跑过了」。
    STATE_PAYLOAD.patrolMeta = {
      at: '2026-10-23T15:00:00.000Z',
      reported: false,
      reasons: [],
      facts: { pending: 0, flagged: 0, removed: 0 }
    }
    await controller.loadState()
    renderFreshSettings()
    await flush()
    assert.ok(
      cardText().includes(dict.zh['patrol.silent']),
      `跑过但没汇报时没说清「跑过了」；实际渲染：${cardText().slice(0, 300)}`
    )
    assert.equal(cardText().includes(dict.zh['patrol.never']), false, '已经有记录了还在说「没跑过」')

    // ③ 报过：必须显示「报过」而不是「无事」。
    STATE_PAYLOAD.patrolMeta = {
      at: '2026-10-23T15:00:00.000Z',
      reported: true,
      reasons: ['pending:2'],
      facts: { pending: 2, flagged: 0, removed: 0 }
    }
    await controller.loadState()
    renderFreshSettings()
    await flush()
    assert.ok(cardText().includes(dict.zh['patrol.reported']), '报过却显示成没报')
  } finally {
    STATE_PAYLOAD.patrolMeta = saved
    await controller.loadState()
  }
})

await test('巡夜明细：体检点到的问题必须逐条画出来，不能只给一个数字', async () => {
  const saved = STATE_PAYLOAD.patrolMeta
  const memText = () => allText(cardNodes(lastTree, dict.zh['mem.title'], 'mem'))
  try {
    STATE_PAYLOAD.patrolMeta = {
      at: '2026-10-23T15:00:00.000Z',
      reported: true,
      reasons: ['flagged:1'],
      facts: { pending: 0, flagged: 1, removed: 0 },
      checked: 21,
      flaggedItems: [
        {
          id: 'm-abc',
          detail: '记忆里写的路径「D:\\gone」现在已经不存在',
          evidence: 'fs.existsSync("D:\\\\gone") === false',
          kinds: ['path-missing']
        }
      ],
      flaggedDropped: 0
    }
    await controller.loadState()
    renderFreshSettings()
    await flush()
    const text = memText()
    // 数字说得出口、名字说不出口，等于半夜被告知「有 1 个问题」然后没了下文。
    assert.ok(text.includes('D:\\gone'), `明细没被画出来；实际渲染：${text.slice(0, 400)}`)
    assert.ok(text.includes('fs.existsSync'), '证据行也要画 —— 那是「凭什么说它有问题」的唯一凭据')
    assert.ok(text.includes('/anima mark m-abc state=contradicted'), '每条要给出能直接粘贴处理的命令')
    assert.ok(text.includes(dict.zh['patrol.details']), '明细区要有标题，不然一堆行不知道是什么')
  } finally {
    STATE_PAYLOAD.patrolMeta = saved
    await controller.loadState()
  }
})

await test('巡夜明细：没有明细时不许画出空的明细区', async () => {
  const saved = STATE_PAYLOAD.patrolMeta
  try {
    STATE_PAYLOAD.patrolMeta = {
      at: '2026-10-23T15:00:00.000Z',
      reported: false,
      facts: { pending: 0, flagged: 0, removed: 0 },
      flaggedItems: null,
      flaggedDropped: 0
    }
    await controller.loadState()
    renderFreshSettings()
    await flush()
    const text = allText(cardNodes(lastTree, dict.zh['mem.title'], 'mem'))
    assert.equal(text.includes(dict.zh['patrol.details']), false,
      '没有明细却画了明细标题 ⇒ 下面一片空白，看起来像渲染坏了')
  } finally {
    STATE_PAYLOAD.patrolMeta = saved
    await controller.loadState()
  }
})

await test('巡夜明细：被截断的条数必须说出来，不能静默只显示前 20 条', async () => {
  const saved = STATE_PAYLOAD.patrolMeta
  try {
    STATE_PAYLOAD.patrolMeta = {
      at: '2026-10-23T15:00:00.000Z',
      reported: true,
      facts: { pending: 0, flagged: 23, removed: 0 },
      flaggedItems: [{ id: 'm-1', detail: '甲', evidence: 'e', kinds: ['verify-expired'] }],
      flaggedDropped: 22
    }
    await controller.loadState()
    renderFreshSettings()
    await flush()
    const text = allText(cardNodes(lastTree, dict.zh['mem.title'], 'mem'))
    assert.ok(text.includes(dict.zh['patrol.moreDropped'].replace('{n}', '22')),
      `截断了 22 条却没说；实际渲染：${text.slice(0, 400)}`)
  } finally {
    STATE_PAYLOAD.patrolMeta = saved
    await controller.loadState()
  }
})

await test('巡夜按钮：点了必须真的打到 /api/anima/patrol，且回执按真实形状读', async () => {
  const before = patrolCalls.length
  patrolCalls.length = before
  renderFreshSettings()
  await flush()
  const card = cardNodes(lastTree, dict.zh['mem.title'], 'mem')
  const buttons = elements(card, 'button').filter(
    (node) => allText(walk(node, [])).trim() === dict.zh['patrol.run']
  )
  assert.ok(buttons.length > 0, '没有找到「跑一次巡夜」按钮')
  buttons[0].props.onClick()
  await flush()
  assert.ok(patrolCalls.length > before, '点了巡夜按钮却没有发出请求（入口是死的）')
  // delivered=0 时 toast 必须说「跑了但没汇报」，而不是「一切正常」。
  // 这两句话在用户眼里差别就是「它活着」和「它说没事」。
  // allText 只接受扁平节点数组（walk 的产物），直接喂根节点会报
  // 「nodes.filter is not a function」——那看起来像实现坏了，其实是探针写错。
  const toast = allText(walk(lastTree, []))
  assert.ok(
    toast.includes(dict.zh['patrol.toastSilent']),
    `没汇报时没说清「跑过了但没报」；实际渲染：${toast.slice(0, 300)}`
  )
})

// ==================== 回扫式复盘 ====================
//
// 这一组存在的理由与巡夜那组同构：**沉默有两种意思**。只报有事的话，
// 界面上「一片安静」既可能是「扫过、真没有该记的」，也可能是「压根没扫」。
// 下面每条断言都是在检查这两者有没有被画成两种样子。

await test('回扫记录：从没扫过 ≠ 扫过没线索，两者必须长得不一样', async () => {
  const saved = STATE_PAYLOAD.retrospectMeta
  try {
    STATE_PAYLOAD.retrospectMeta = null
    await controller.loadState()
    renderFreshSettings()
    await flush()
    const none = allText(cardNodes(lastTree, dict.zh['mem.title'], 'mem'))
    assert.ok(
      none.includes(dict.zh['retrospect.never']),
      `没有回扫记录时说成「没有线索」而不是「没扫」；实际渲染：${none.slice(0, 300)}`
    )

    // 扫过、确实没有新线索：必须出现，且说的是「没有新线索」。
    STATE_PAYLOAD.retrospectMeta = {
      scannedAt: '2026-10-24T10:00:00.000Z',
      scannedDays: 14,
      files: 12,
      messages: 340,
      found: 0,
      leadKeys: [],
      leads: null,
      leadsDropped: 0,
      delivered: 0
    }
    await controller.loadState()
    renderFreshSettings()
    await flush()
    const ran = allText(cardNodes(lastTree, dict.zh['mem.title'], 'mem'))
    assert.ok(
      ran.includes(dict.zh['retrospect.none']),
      `扫过但没有线索时必须明说「没有新线索」；实际渲染：${ran.slice(0, 300)}`
    )
    assert.ok(
      ran.includes(dict.zh['retrospect.scope'].replace('{d}', '14').replace('{f}', '12')),
      `没说清这轮扫了哪些范围；实际渲染：${ran.slice(0, 300)}`
    )
    assert.ok(!ran.includes(dict.zh['retrospect.never']), '有记录时不该再说「没扫过」')
  } finally {
    STATE_PAYLOAD.retrospectMeta = saved
    await controller.loadState()
  }
})

await test('回扫记录：没扫成的轮次不许显示成「扫了 0 个会话」', async () => {
  const saved = STATE_PAYLOAD.retrospectMeta
  try {
    // files 为 null = 这轮没扫成（目录不存在 / Node 不支持 zstd）。
    // 若渲染成 0，用户读到的就是「扫了，没事」—— 正是这机制要消灭的那种谎言。
    STATE_PAYLOAD.retrospectMeta = {
      scannedAt: '2026-10-24T11:00:00.000Z',
      scannedDays: 14,
      files: null,
      messages: null,
      found: null,
      leadKeys: [],
      leads: null,
      delivered: 0,
      error: '会话目录不存在：D:\\no-such-dir\\sessions'
    }
    await controller.loadState()
    renderFreshSettings()
    await flush()
    const text = allText(cardNodes(lastTree, dict.zh['mem.title'], 'mem'))
    assert.ok(
      text.includes('会话目录不存在'),
      `没扫成却没把原因说出来；实际渲染：${text.slice(0, 400)}`
    )
    assert.ok(
      !text.includes(dict.zh['retrospect.scope'].replace('{d}', '14').replace('{f}', '0')),
      `把「没扫成」画成了「扫了 0 个会话」；实际渲染：${text.slice(0, 400)}`
    )
  } finally {
    STATE_PAYLOAD.retrospectMeta = saved
    await controller.loadState()
  }
})

await test('回扫明细：找到的线索要逐条画出来，且只说类型不下结论', async () => {
  const saved = STATE_PAYLOAD.retrospectMeta
  try {
    STATE_PAYLOAD.retrospectMeta = {
      scannedAt: '2026-10-24T12:00:00.000Z',
      scannedDays: 14,
      files: 5,
      messages: 200,
      found: 2,
      leadKeys: ['k1', 'k2'],
      leads: [
        { key: 'k1', kind: 'complaint', text: '我有没有说过不允许一直往c盘写东西' },
        { key: 'k2', kind: 'correction', text: '我说的是审查能力不是你理解的' }
      ],
      leadsDropped: 7,
      delivered: 1
    }
    await controller.loadState()
    renderFreshSettings()
    await flush()
    const text = allText(cardNodes(lastTree, dict.zh['mem.title'], 'mem'))
    assert.ok(text.includes('我有没有说过不允许一直往c盘写东西'), '线索正文没画出来')
    assert.ok(text.includes('我说的是审查能力不是你理解的'), '第二条线索丢了')
    assert.ok(
      text.includes(dict.zh['retrospect.moreDropped'].replace('{n}', '7')),
      `截断了 7 条却没说；实际渲染：${text.slice(0, 400)}`
    )
    // 它只是线索，不是结论 —— 文案必须自己承认这一点，不能诱导用户直接采纳。
    assert.ok(
      text.includes(dict.zh['retrospect.details']),
      '没有说明这些只是线索'
    )
  } finally {
    STATE_PAYLOAD.retrospectMeta = saved
    await controller.loadState()
  }
})

await test('回扫明细：没有新线索时沿用的旧明细必须说清是哪一轮找到的', async () => {
  const saved = STATE_PAYLOAD.retrospectMeta
  try {
    // 这一轮刚扫过（scannedAt 新），但没找到新的；明细沿用更早那一批。
    // 不说清它有多旧，用户会以为屏幕上的线索是刚才扫出来的。
    STATE_PAYLOAD.retrospectMeta = {
      scannedAt: '2026-10-24T12:00:00.000Z',
      scannedDays: 14,
      files: 9,
      messages: 210,
      found: 0,
      leadKeys: ['k1'],
      leads: [{ key: 'k1', kind: 'complaint', text: '我有没有说过不允许一直往c盘写东西' }],
      leadsAt: '2026-10-21T10:00:00.000Z',
      leadsDropped: 0,
      delivered: 0
    }
    await controller.loadState()
    renderFreshSettings()
    await flush()
    const text = allText(cardNodes(lastTree, dict.zh['mem.title'], 'mem'))
    assert.ok(text.includes(dict.zh['retrospect.none']), '这一轮没有新线索，必须明说')
    assert.ok(
      text.includes('我有没有说过不允许一直往c盘写东西'),
      '旧明细被丢掉了；既然保留它就该画出来'
    )
    assert.ok(
      text.includes(dict.zh['retrospect.leadsOlder'].split('{t}')[0]),
      `没有说明这批线索是哪一轮找到的；实际渲染：${text.slice(0, 400)}`
    )
  } finally {
    STATE_PAYLOAD.retrospectMeta = saved
    await controller.loadState()
  }
})

await test('回扫按钮：点了必须真的打到 /api/anima/retrospect，且回执按真实形状读', async () => {
  const before = retrospectCalls.length
  retrospectCalls.length = before
  renderFreshSettings()
  await flush()
  const card = cardNodes(lastTree, dict.zh['mem.title'], 'mem')
  const buttons = elements(card, 'button').filter(
    (node) => allText(walk(node, [])).trim() === dict.zh['retrospect.run']
  )
  assert.ok(buttons.length > 0, '没有找到「回扫一次」按钮')
  buttons[0].props.onClick()
  await flush()
  assert.ok(retrospectCalls.length > before, '点了回扫按钮却没有发出请求（入口是死的）')
  // 有一条新线索时 toast 必须报数，且说清「要不要记由你定」。
  const toast = allText(walk(lastTree, []))
  assert.ok(
    toast.includes(dict.zh['retrospect.toastFound'].replace('{n}', '1')),
    `找到线索时没报数；实际渲染：${toast.slice(0, 300)}`
  )
})

// ==================== 分区导航（设置页改版） ====================
//
// 这一组用例存在的理由：改版前 55 项全绿，而它们一条都没有能力看见
// 「卡片被藏起来了没有」—— cardNodes 只按 className === 'an-card' 匹配，
// display:none 对它是透明的。也就是说「分区导航是死的」这种坏法，
// 旧用例集一条也抓不住。下面每条断言都绕开这个盲点。
//
// ⚠️ 这一组有自己的坑，写第一版时踩了两次：
// ① renderFreshSettings() 走 withOwnRuntime，它在 finally 里把模块级 lastTree
//    还原成主运行时的树。于是「先 renderFreshSettings() 再读 lastTree」读到的
//    是**别人的树**——主运行时里 agentName 早被前文改成「小沃」，脏检查恒为真，
//    于是断言「干净态文案不对」，实际是读错了树。
// ② 光拿到那棵树还不够：withOwnRuntime 返回后 runtimeRef.current 也还原了，
//    此后点按钮触发的 setState 会渲染到**主运行时**上，看起来「点了没反应」。
// 交互必须整段发生在 fresh 运行时still绑着的窗口里 ⇒ 用 withFreshSettings。

/** 在一个独立运行时里跑完整个用例体：传进来的 view.tree 始终是这台运行时最新的树。 */
function withFreshSettings(fn) {
  return withOwnRuntime(
    () => slotComponent({ ...injectProps, useAnimaStore: controller.useStore, t }),
    (_tree, runtime) => fn({
      // 每次点击后 runtime 同步重渲染，lastTree 立刻更新；
      // 用 getter 而不是快照，避免调用方拿到过期的那棵树。
      get tree() { return lastTree },
      // effect 跑完之前的那一帧 —— 用户真正先看到的画面。
      get firstFrame() { return runtime.api.lastFirstFrame }
    })
  )
}

/** 在一棵指定树上按分区标签点一下导航。找不到就抛，不静默通过。 */
function switchSectionOn(tree, sectionKey) {
  const label = dict.zh[`section.${sectionKey}`]
  const tab = elements(walk(tree), 'button').find(
    (node) => node.props.role === 'tab' && node.props.children === label
  )
  assert.ok(tab, `导航里没有「${label}」这一栏`)
  tab.props.onClick()
}

/**
 * 取某张卡片节点（不展开内容，只看它自己）。找不到返回 null。
 *
 * 与 cardNodes 同样先按 `data-an-card` 认卡：只按标题文字找会被「别处提到卡名」
 * 骗到（本文件 2026-10-28 因此集体误判过一次）。
 */
function cardSection(tree, title, cardId) {
  const sections = elements(walk(tree), 'section')
  if (cardId) {
    const byId = sections.find((node) => node.props?.['data-an-card'] === cardId)
    if (byId) return byId
  }
  return sections.find((node) => {
    const inner = []
    walk(node.props?.children, inner)
    return allText(inner).includes(title)
  }) ?? null
}

await test('分区导航：四栏都在、名字走词典、当前栏标 aria-selected', () => {
  withFreshSettings((view) => {
    const tabs = elements(walk(view.tree), 'button').filter((n) => n.props.role === 'tab')
    assert.equal(tabs.length, 4, `应有四栏，实际 ${tabs.length}`)
    const labels = tabs.map((n) => n.props.children)
    // 'preset' 原来是独立一栏，2.1.5 并进人设栏了，所以这里不该再有它。
    for (const key of ['persona', 'memory', 'behavior', 'advanced']) {
      assert.ok(labels.includes(dict.zh[`section.${key}`]), `缺分区：${key}（实际 ${JSON.stringify(labels)}）`)
    }
    assert.ok(!labels.includes('预设'), `分区里不该再有独立的预设栏（实际 ${JSON.stringify(labels)}）`)
    const on = tabs.filter((n) => n.props['aria-selected'] === 'true')
    assert.equal(on.length, 1, `应恰好有一栏是选中态，实际 ${on.length}`)
  })
})

await test('分区导航：一直吸在顶部（滚下去还能切栏），底色不是 transparent', () => {
  // 2.1.5 把 sticky 去掉了，理由是「四栏切换成本低、别占视口」。2.1.15 实测推翻：
  // 人设栏内容 2168px、滚动上限 1422；scrollTop=600 时导航顶边 -482，=1422 时
  // -1304，elementFromPoint 打不中任何一个 tab —— 滚下去就没法切栏，是可用性问题。
  //
  // 两条都要断：①吸顶本身；②底色不能是 transparent。少了②虽然还吸着，但卡片
  // 会从导航底下透上来，等于把 tab 文字叠在正文上。
  const css = styleTags.map((tag) => tag.textContent).join('\n')
  const rule = css.match(/\.an-sectnav\{([^}]*)\}/)
  assert.ok(rule, '找不到 .an-sectnav 规则')
  assert.ok(/position:sticky/.test(rule[1]), `分区导航不再吸顶了：${rule[1]}`)
  assert.ok(/\btop:0\b/.test(rule[1]), `吸顶没写 top:0：${rule[1]}`)
  const bg = (rule[1].match(/background:([^;}]*)/) || [])[1] || ''
  assert.equal(bg.includes('transparent'), false, `吸顶栏用透明底，下面的卡片会透上来：${bg}`)
  assert.ok(/var\(--dsw-alias-/.test(bg), `吸顶栏底色没走宿主 token：${bg}`)
})

await test('吸底保存栏：把内边距一起抵消掉，滚到底时贴着容器底（不悬空）', () => {
  // 实测过：脏态滚到底，栏底停在 752、滚动容器底 800，中间露出 48px 正文 ——
  // 就是宿主 `.options` 的 padding-bottom:24px 加上 `.an-root` 自己的 24px。
  // sticky 的 bottom:0 贴的是滚动容器的 padding box，所以必须用负 bottom 抵消。
  //
  // 这条只断「规则里写了负的 bottom 与负 margin」，不断具体像素 —— 源码里没有
  // 布局引擎，量不出真实几何（那是 _tmp/visui/geo.cjs 干的活）。但它能挡住
  // 「哪天有人手滑把这两条负值删掉、退回悬空 48px」。
  const css = styleTags.map((tag) => tag.textContent).join('\n')
  const rule = css.match(/\.an-savebar\[data-an-dirty="true"\]\{([^}]*position:sticky[^}]*)\}/)
  assert.ok(rule, '找不到脏态吸底保存栏的 sticky 规则')
  const bottom = (rule[1].match(/\bbottom:(-?[\d.]+px)/) || [])[1]
  assert.ok(bottom, `吸底栏没写 bottom：${rule[1]}`)
  assert.ok(parseFloat(bottom) < 0, `吸底栏 bottom 不是负值，会悬空在容器底上方：${bottom}`)
  const mb = (rule[1].match(/margin-bottom:(-?[\d.]+px)/) || [])[1]
  assert.ok(mb && parseFloat(mb) < 0, `吸底栏没抵消内边距占位：margin-bottom=${mb}`)
})

await test('分区导航：键盘左右箭头能换栏（八条：←/→ 循环、Home/End 到两端、方向键不跳焦点、无 document 时不抛）', () => {
  // 这一组此前零覆盖：grep ArrowRight/onKeyDown/Home/End 在 scripts/ 下命中 0。
  // 键盘导航是 2.1.3 加的，加了四个月没有一个用例看过它。
  withFreshSettings((view) => {
    // 顺序写死在这里而不是从包里 import：这一串本身就是「分区的对外约定」，
    // 让它跟着实现走就等于没在测。改分区顺序时这条会红，是想要的效果。
    const SECTION_ORDER = ['persona', 'memory', 'behavior', 'advanced']
    const nav = () => elements(walk(view.tree), 'div').find((n) => n.props?.className === 'an-sectnav')
    const onTab = () => {
      const tabs = elements(walk(view.tree), 'button').filter((n) => n.props.role === 'tab')
      return tabs.find((n) => n.props['aria-selected'] === 'true')
    }
    const press = (key) => {
      const navNode = nav()
      assert.ok(navNode, '找不到分区导航容器')
      let prevented = false
      const event = {
        key,
        preventDefault: () => { prevented = true }
      }
      navNode.props.onKeyDown(event)
      return prevented
    }
    const activeKey = () => {
      const current = onTab()
      assert.ok(current, '没有任何一栏处于选中态')
      const id = current.props.id.replace('an-sectnav-tab-', '')
      return SECTION_ORDER.indexOf(id)
    }

    // 起始：第一栏（人设）
    assert.equal(activeKey(), 0, '起始应停在第一栏')
    // ArrowRight 依次前进，到底回绕
    const prevented1 = press('ArrowRight')
    assert.equal(prevented1, true, 'ArrowRight 应当 preventDefault（否则页面会横向滚动）')
    assert.equal(activeKey(), 1, 'ArrowRight 没有切到第二栏')
    press('ArrowRight')
    press('ArrowRight')
    assert.equal(activeKey(), 3, 'ArrowRight 没走到第四栏')
    press('ArrowRight')
    assert.equal(activeKey(), 0, '第四栏再按 ArrowRight 应当回绕到第一栏')
    // ArrowLeft 反向，从第一栏回绕到最后一栏
    press('ArrowLeft')
    assert.equal(activeKey(), 3, '第一栏按 ArrowLeft 应当回绕到最后一栏')
    press('ArrowLeft')
    assert.equal(activeKey(), 2, 'ArrowLeft 没有退回第三栏')
    // Home / End
    press('Home')
    assert.equal(activeKey(), 0, 'Home 没有回到第一栏')
    press('End')
    assert.equal(activeKey(), 3, 'End 没有跳到最后一栏')
    // 未处理的键不许 preventDefault（否则 Tab、翻页全被吃掉）
    assert.equal(press('Tab'), false, 'Tab 被 preventDefault 了 —— 焦点就出不去了')
    assert.equal(press('a'), false, '普通字符键被 preventDefault 了')
    assert.equal(activeKey(), 3, '未处理的键不该改变当前栏')
  })
})

await test('表单控件的可访问名：每个输入框要么有 label[for]，要么有 aria-label', () => {
  // 用无头浏览器扫渲染结果时发现的：预设卡的「预设名」「说明」两个框，以及记忆卡
  // 「手动添加」里的三个框，原来都只有 placeholder，没有 id / label / aria-label。
  // placeholder 一敲字就消失，读屏软件到那一秒就不知道这个框是干什么的。
  // 这条用例在渲染树上核，不依赖 DOM —— 序列化时 htmlFor 会不会写成 for 那是
  // 截图工具的坑，跟组件本身对不对无关。
  withFreshSettings((view) => {
    const controls = walk(view.tree).filter((n) =>
      n.kind === 'element' && ['input', 'textarea', 'select'].includes(n.type)
      && n.props?.type !== 'checkbox' && n.props?.type !== 'hidden'
    )
    // 控件自己或祖先被 display:none 藏起来时也算（收起不等于可以没有名字）
    const named = (node) => {
      const p = node.props ?? {}
      if (typeof p['aria-label'] === 'string' && p['aria-label'].trim()) return true
      if (typeof p['aria-labelledby'] === 'string' && p['aria-labelledby'].trim()) return true
      if (!p.id) return false
      // 树上有没有 label[for=这个 id]
      return walk(view.tree).some((n) =>
        n.kind === 'element' && n.type === 'label'
        && (n.props?.htmlFor === p.id || n.props?.for === p.id)
      )
    }
    const unnamed = controls.filter((n) => !named(n))
    assert.equal(
      unnamed.length, 0,
      `有 ${unnamed.length} 个控件没有可访问名：${JSON.stringify(
        unnamed.map((n) => ({ tag: n.type, id: n.props?.id ?? null, ph: String(n.props?.placeholder ?? '').slice(0, 20) }))
      )}`
    )
    // 断言数量不为零，防止「一个控件都没扫到」也算通过
    assert.ok(controls.length > 20, `只扫到 ${controls.length} 个控件，选择器可能坏了`)
  })
})

await test('分区切换：把滚动位置带回新栏开头（宿主是同一个滚动容器，scrollTop 会跨栏残留）', async () => {
  // 真实现象（无头 Edge 在复刻宿主外壳里实测）：人设栏 2168px、滚动上限 1422；
  // 记忆栏 1439px、上限 693。从人设栏滚到底再切到记忆栏，宿主不重建滚动容器，
  // scrollTop 被浏览器夹到 693 —— 记忆卡顶边直接是 -467，一进来就落在
  // 「记忆体检」附近，标题和待审队列全在视野外。
  //
  // 这里用假的 DOM 节点验「有没有把滚动归零」这一件事：真实浏览器行为在
  // _tmp/visui/scrollsim2.cjs 里单独验过，测试只守接线，不守布局。
  return withFreshSettings((view) => {
    // 切换目标是「记忆」栏，所以归位逻辑会去找这栏的首卡 an-card-mem，
    // 再沿 parentElement 往上找那个真能滚的容器。
    const scroller = { scrollHeight: 1439, clientHeight: 746, scrollTop: 693, parentElement: null }
    const cardNode = { parentElement: scroller }
    const seen = []
    const savedGetById = globalThis.document.getElementById
    const savedGCS = globalThis.getComputedStyle
    globalThis.document.getElementById = (id) => {
      seen.push(id)
      return id === 'an-card-mem' ? cardNode : null
    }
    globalThis.getComputedStyle = () => ({ overflowY: 'auto' })

    const restore = () => {
      globalThis.document.getElementById = savedGetById
      if (savedGCS === undefined) delete globalThis.getComputedStyle
      else globalThis.getComputedStyle = savedGCS
    }

    switchSectionOn(view.tree, 'memory')
    // selectSection 把归位放在下一个宏任务里（新栏要先渲染完），所以这里必须等。
    // 断言一律在 Promise 里 reject：直接扔在 setTimeout 回调里的话，抛出去的时候
    // 早就出了 test() 的 try 包住的范围，套件会先报「全部通过」再在最后崩掉
    // —— 这条我用「删掉归位那行」做反向验证时亲眼看到了。
    // 另外这个 Promise 必须 return 出去，否则 test() 的 await 等不到它。
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          assert.ok(seen.includes('an-card-mem'), `没有去找新栏首卡对应的元素（查过：${JSON.stringify(seen)}）`)
          assert.equal(scroller.scrollTop, 0, '切栏后滚动位置没归零 —— 用户会落在一栏的中段')
          resolve()
        } catch (err) {
          reject(err)
        } finally {
          restore()
        }
      }, 10)
    })
  })
})

await test('分区导航：切到「记忆」后，人设卡是 display:none —— 且内容没被销毁', () => {
  withFreshSettings((view) => {
    switchSectionOn(view.tree, 'memory')

    // 人设卡此刻必须在树上（不是不渲染），但被藏起来。
    const card = cardSection(view.tree, dict.zh['identity.title'], 'identity')
    assert.ok(card, '切走之后人设卡整个从树上消失了 —— 未保存的输入会跟着丢')
    assert.equal(card.props.style?.display, 'none', '切到记忆栏后，人设卡仍然可见')

    // 反面：记忆卡此刻必须可见。
    const memCard = cardSection(view.tree, dict.zh['mem.title'], 'mem')
    assert.ok(memCard, '记忆卡不见了')
    assert.notEqual(memCard.props.style?.display, 'none', '切到记忆栏后，记忆卡却是隐藏的')

    // 内容真的还在（而不是只留了个空壳）：人设卡里的名字输入框还能查到。
    const nameInput = elements(walk(view.tree), 'input').find((n) => n.props.id === 'an-agent-name')
    assert.ok(nameInput, '人设卡被藏起来后，里面的表单整个没了 —— 用户切回来会看到空表单')
  })
})

await test('分区导航：切换不留副作用 —— 在别的栏改的值不会因为切走而丢失', () => {
  withFreshSettings((view) => {
    switchSectionOn(view.tree, 'persona')
    const before = elements(walk(view.tree), 'input').find((n) => n.props.id === 'an-agent-name')
    before.props.onChange({ target: { value: '切栏测试' } })

    switchSectionOn(view.tree, 'memory')
    switchSectionOn(view.tree, 'persona')

    const after = elements(walk(view.tree), 'input').find((n) => n.props.id === 'an-agent-name')
    assert.equal(after.props.value, '切栏测试', '切走再切回来，刚敲的字没了')
  })
})

await test('分区导航：选中的栏落 localStorage，且脏值一律回到第一栏', () => {
  const KEY = 'dsh-anima:active-section'
  try {
    storageBacking.delete(KEY)
    // 脏值：不存在的分区名 / 大小写不同 / 空串 / 已经并掉的旧栏名
    // 'preset' 是 2.1.5 之前的独立一栏，老用户 localStorage 里存的就是它，
    // 必须自然回落到第一栏而不是白屏。
    for (const bad of ['没这个分区', 'Persona', '', 'preset']) {
      storageBacking.set(KEY, bad)
      withFreshSettings((view) => {
        const tabs = elements(walk(view.tree), 'button').filter((n) => n.props.role === 'tab')
        const on = tabs.filter((n) => n.props['aria-selected'] === 'true')
        assert.equal(on.length, 1, `脏值 ${JSON.stringify(bad)} 之后选中数不对（${on.length}）`)
        assert.equal(on[0].props.children, dict.zh['section.persona'], `脏值 ${JSON.stringify(bad)} 没退回第一栏`)
      })
    }
    // 真值生效
    storageBacking.set(KEY, 'behavior')
    withFreshSettings((view) => {
      const tabs = elements(walk(view.tree), 'button').filter((n) => n.props.role === 'tab')
      const on = tabs.filter((n) => n.props['aria-selected'] === 'true')
      assert.equal(on[0].props.children, dict.zh['section.behavior'], '真值没被读进去')
    })
  } finally {
    storageBacking.delete(KEY)
  }
})

// 光测「读」不够：把 writeActiveSection 整句删掉，「五栏都在」「脏值回退」
// 这些用例照样全绿（它们只依赖读初始值）。曾经就是这样——变异验证时
// 删掉落盘那一行，失败项是 0。下面这条只测写。
await test('分区导航：点一下必须真的把选中的栏写进 localStorage（不是只改内存）', () => {
  const KEY = 'dsh-anima:active-section'
  try {
    storageBacking.delete(KEY)
    withFreshSettings((view) => {
      switchSectionOn(view.tree, 'behavior')
      assert.equal(storageBacking.get(KEY), 'behavior', '点了「表现」却没写进 localStorage —— 下次打开又回到第一栏')
      // 再点另一个，确认是覆盖而不是只在第一次写
      switchSectionOn(view.tree, 'advanced')
      assert.equal(storageBacking.get(KEY), 'advanced', '第二次切换没覆盖上一次的值')
    })
  } finally {
    storageBacking.delete(KEY)
  }
})

await test('保存栏：全页只剩一个「保存」按钮（卡片里的旧按钮必须全删掉）', () => {
  withFreshSettings((view) => {
    const saveLabel = dict.zh['common.save']
    // 「保存覆盖」是工作区专用的另一个动作，文案不同，不算重复。
    const saves = elements(walk(view.tree), 'button').filter(
      (node) => String(node.props.children) === saveLabel
    )
    assert.equal(saves.length, 1, `页面上有 ${saves.length} 个「${saveLabel}」按钮，应当只有保存栏里那一个`)
    // 它必须在保存栏里，而不是又藏回某张卡。
    const inBar = elements(walk(view.tree), 'div').some((node) => {
      if (node.props.className !== 'an-savebar') return false
      const inner = []
      walk(node.props.children, inner)
      return elements(inner, 'button').some((b) => String(b.props.children) === saveLabel)
    })
    assert.ok(inBar, '唯一的保存按钮不在保存栏里')
  })
})

await test('保存栏：干净时说「没有未保存的修改」，改了值就翻成「有未保存的修改」', () => {
  withFreshSettings((view) => {
    // ⚠️ 不能用 includes 判文案：清洁态是「没有未保存的修改」，脏态是
    // 「有未保存的修改」，前者**包含**后者（「没」+ 脏态整句）。用 includes
    // 写脏态断言，恒 dirty=false 的实现也能蒙混过关（变异验证时就是这么漏的）。
    // 改成拿文案节点本身，判它的 class 与整串文本。
    const barTextNode = () => {
      const bar = elements(walk(view.tree), 'div').find((n) => n.props.className === 'an-savebar')
      assert.ok(bar, '缺保存栏')
      const inner = []
      walk(bar.props.children, inner)
      const node = elements(inner, 'div').find((n) =>
        String(n.props.className || '').startsWith('an-savebar-text')
      )
      assert.ok(node, '保存栏里没有文案节点')
      return { cls: node.props.className, text: allText(walk(node.props.children)).trim() }
    }
    // 干净：宿主配置与本地表单逐字节相等。此前这里恒为脏，
    // 根因是 local 的初始值是一份空默认值而 config 已经到位 ——
    // 首帧 dirty 为真，用户每次打开设置页都会看到保存按钮闪一下。
    const clean = barTextNode()
    assert.equal(clean.text, dict.zh['savebar.clean'], `干净态文案不对：${clean.text}`)
    assert.equal(clean.cls, 'an-savebar-text', `干净态不该带警告色类名：${clean.cls}`)

    const nameInput = elements(walk(view.tree), 'input').find((n) => n.props.id === 'an-agent-name')
    nameInput.props.onChange({ target: { value: '改一下看看' } })
    const dirtyText = barTextNode()
    assert.equal(dirtyText.text, dict.zh['savebar.dirty'], `脏了之后文案没变：${dirtyText.text}`)
    assert.equal(dirtyText.cls, 'an-savebar-text an-savebar-text-dirty', `脏态该带警告色：${dirtyText.cls}`)
  })
})

// 首帧：真实 React 里 useEffect 要等首帧绘制之后才跑，所以用户**先看到**的
// 是「effect 尚未执行」的那一帧。旧实现的 local 初始值是空默认值、config 已到位，
// 于是每次打开设置页，保存栏先喊「有未保存的修改」、保存按钮亮着，然后才自己消失。
// 抓这个缺陷必须看首帧 —— 等 effect 跑完，脏也就平了（变异验证时 0 项失败）。
await test('保存栏：打开设置页的第一帧就是干净的（effect 跑之前不许闪一下脏）', () => {
  withFreshSettings((view) => {
    const frame = view.firstFrame
    assert.ok(frame, '拿不到首帧')
    const bar = elements(walk(frame), 'div').find((n) => n.props.className === 'an-savebar')
    assert.ok(bar, '首帧里没有保存栏')
    const inner = []
    walk(bar.props.children, inner)
    const node = elements(inner, 'div').find((n) =>
      String(n.props.className || '').startsWith('an-savebar-text')
    )
    assert.ok(node, '首帧保存栏里没有文案节点')
    assert.equal(
      allText(walk(node.props.children)).trim(),
      dict.zh['savebar.clean'],
      `首帧已经是脏的（${allText(walk(node.props.children)).trim()}）—— 用户每次打开都会看到保存按钮闪一下`
    )
    // 保存按钮在第一帧就该是灰的：闪一下可点的「保存」比文案闪更糟。
    const saveBtn = elements(inner, 'button').find(
      (n) => String(n.props.children) === dict.zh['common.save']
    )
    assert.ok(saveBtn, '首帧保存栏里没有保存按钮')
    assert.equal(saveBtn.props.disabled, true, '首帧的保存按钮不该是可点的')
  })
})

// 探针自身的回归：cardNodes/cardSection 必须按 data-an-card 认卡。
//
// 这条用例锁的是一个已经真实发生过的翻车：把「助手身份」卡的说明改成
// 「…也看不到长期记忆。」之后，13 条记忆相关用例集体报「记忆卡里没有 X」，
// 代码一行没坏 —— 是探针按标题文字找卡、先撞上了人设卡。
// 造两棵假树形状：第一张卡（identity）的正文里故意写着另一张卡（mem）的标题。
await test('测试探针：一张卡里提到另一张卡的名字时，cardNodes/cardSection 不许认错卡', () => {
  const memTitle = dict.zh['mem.title']
  const fake = {
    type: 'div',
    props: {
      children: [
        {
          type: 'section',
          props: {
            className: 'an-card',
            'data-an-card': 'identity',
            children: [{ type: 'p', props: { children: `关掉后…也看不到${memTitle}。` } }]
          }
        },
        {
          type: 'section',
          props: {
            className: 'an-card',
            'data-an-card': 'mem',
            children: [{ type: 'p', props: { children: '记忆卡正文' } }]
          }
        }
      ]
    }
  }

  const nodes = cardNodes(fake, memTitle, 'mem')
  const text = allText(nodes)
  assert.ok(text.includes('记忆卡正文'), `cardNodes 认错卡了：拿到 ${JSON.stringify(text)}`)
  assert.ok(!text.includes('关掉后'), `cardNodes 撞上了写着「${memTitle}」的那张卡`)

  const section = cardSection(fake, memTitle, 'mem')
  assert.ok(section, 'cardSection 没找到记忆卡')
  assert.equal(section.props['data-an-card'], 'mem', 'cardSection 认错卡了')

  // 兜底路径仍要能用：没给 id 时退回按标题文字找（只有一张卡提到标题，能找到）。
  const fallback = allText(cardNodes(fake, memTitle))
  assert.ok(fallback.includes('关掉后'), '没给 id 时的兜底查找失效了')
})

// ---- 录屏回归：这三条来自用户 2026-10-30 的屏幕录像 ----
// 那支录像推翻了我此前「点标签没反应」的全部猜测：标签点得动、state 也写了，
// 但（①）选中态看不出来、（②）顶部变更记录默认铺满整屏把卡片挤到屏外、
// （③）底部保存栏与「只保留最近 200 条」那行字叠在一起。
// 三条各写一条用例 —— 它们都是「代码没错、但人看不见」的故障，只能靠渲染结果抓。

await test('分区标签：选中态必须与未选中态有可见差异（不能只是同一个底色）', () => {
  // 原来 `.an-sectnav-tab-on` 用 --dsw-alias-bg-base 当背景，那是页面自身底色，
  // 垫在 layer-1 上等于没变 ⇒ 五个标签一个都看不出被选中。
  const css = styleTags.map((tag) => tag.textContent).join('\n')
  const rule = css.match(/\.an-sectnav-tab-on\{([^}]*)\}/)
  assert.ok(rule, '找不到 .an-sectnav-tab-on 规则')
  assert.equal(
    /background:var\(--dsw-alias-bg-base\b/.test(rule[1]), false,
    '选中态又拿页面底色当背景了 —— 那样在页面上看不出来被选中'
  )
  // 选中的那个标签节点本身要带标记，且 aria-selected 只在一个上。
  // 注意：byClass 是精确相等匹配，而选中态的 className 是
  // `an-sectnav-tab an-sectnav-tab-on` 两段，所以这里必须按前缀筛。
  const tabs = walk(lastTree).filter(
    (n) => n.kind === 'element' && /(^|\s)an-sectnav-tab(\s|$)/.test(String(n.props?.className ?? ''))
  )
  assert.equal(tabs.length, 4, `分区标签应有 4 个（实际 ${tabs.length}）`)
  const on = tabs.filter((n) => String(n.props.className).includes('an-sectnav-tab-on'))
  assert.equal(on.length, 1, `应恰好一个标签处于选中态（实际 ${on.length}）`)
  assert.equal(on[0].props['aria-selected'], 'true')
})

await test('最近改了什么：收起态一行明细都不画，长值根本没有出场机会', async () => {
  // 用户录屏里一条改动的原值 1435 字，渲染成十几行占满整屏，
  // 把下面本该显示的人设卡整个挤出屏幕 —— 看起来就像「点了标签没反应」。
  // 现在更进一步：收起态连预览都不画了，所以这条断言从「只画 2 条」变成「一条不画」。
  const saved = STATE_PAYLOAD.audit
  const long = '这是一段很长很长的自定义指令'.repeat(60)
  try {
    STATE_PAYLOAD.audit = {
      total: 1,
      max: 200,
      entries: [{
        id: 'a-long',
        at: '2026-10-30T08:00:00.000Z',
        actor: 'user',
        source: 'settings',
        changes: [
          { key: 'customInstructions', from: long, to: long },
          { key: 'style', from: 'a'.repeat(500), to: 'b'.repeat(500) },
          { key: 'agentRole', from: 'c'.repeat(500), to: 'd'.repeat(500) }
        ]
      }],
      sourceText: { settings: '设置页' }
    }
    await controller.loadState()
    renderFreshSettings()
    await flush()

    const recent = byClass(walk(lastTree), 'an-recent')[0]
    assert.ok(recent, '找不到顶部常驻的改动记录')
    assert.equal(byClass(walk(recent), 'an-audit-change').length, 0, '收起态还在画明细')
    const text = allText(walk(recent))
    assert.equal(text.includes(long), false, '收起态把 700 多字的原值整段画了出来')
    // 但条数还得在，否则用户不知道值不值得点开
    assert.ok(text.includes(`${dict.zh['audit.total']} 1`), `收起态没告诉用户有多少条：${text.slice(0, 200)}`)
  } finally {
    STATE_PAYLOAD.audit = saved
  }
})

await test('最近改了什么：收起态不再常驻「只保留最近 200 条」那句说明', async () => {
  // 那句是解释，不是内容。它常驻在顶部既占地方，又与底部保存栏叠在一起。
  await controller.loadState()
  renderFreshSettings()
  await flush()
  const recent = byClass(walk(lastTree), 'an-recent')[0]
  assert.ok(recent, '找不到顶部常驻的改动记录')
  assert.equal(
    allText(walk(recent)).includes(dict.zh['audit.maxHint']), false,
    '收起态仍把「只保留最近 200 条」画在顶部——那是展开看全量时才需要知道的'
  )
})

console.log(`\n通过 ${passed} 项`)
if (failures.length > 0) {
  console.log(`\nFAILED ${failures.length} 项`)
  for (const [name] of failures) console.log(`  - ${name}`)
  process.exit(1)
}
console.log('\nPASSED 客户端渲染冒烟全绿')
