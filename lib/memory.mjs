// lib/memory.mjs — 待审缓冲区记忆层
//
// 形态（对应拍板 q13 用户原话「每晚整理到一个缓冲区然后给我说我去看哪些要哪些不要」）：
//   Agent 投递候选 → pending 缓冲区 → 每晚自动整理（去重/合并/限额）→ 通知用户审阅
//   → 用户逐条采纳或丢弃 → 只有 adopted 才进入提示词
//
// 关键约束：**绝不自动写入长期记忆**。pending 永远不进提示词的「已采纳」段，
// 只以「待审」形式提示存在，防止未裁决内容被模型当成事实。

import { createHash } from 'node:crypto'
import {
  MEMORY_NOTE_MAX, MEMORY_TEXT_MAX, MEMORY_LAYERS,
  MEMORY_TYPES, DEFAULT_MEMORY_TYPE, MEMORY_STATES, DEFAULT_MEMORY_STATE
} from './config.mjs'
import { decayInfo, decayRank, decayTag } from './decay.mjs'
export { MEMORY_LAYERS, MEMORY_TYPES, MEMORY_STATES }

/**
 * 凭据检测（拍板 q8：独立实现，只借鉴 .dsh-memory 的 forbidden 正则）。
 *
 * 只收高精度模式 —— 宁可漏报也不误伤正常记忆（长 hex 如 git SHA 刻意不收）。
 * 命中的候选**直接拒绝入库**，不进待审缓冲区：缓冲区一旦落盘就已经是
 * 「等待被写进提示词」的状态，凭据不该走这条路。
 */
export const CREDENTIAL_PATTERNS = [
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'generic-api-key', re: /\bapi[_-]?key\s*[:=]\s*[A-Za-z0-9_-]{16,}/i },
  { name: 'secret-assignment', re: /\b(app[_-]?secret|appsecret|client[_-]?secret|secret[_-]?key|access[_-]?key)\s*[:=]?\s*[A-Za-z0-9]{16,}/i },
  { name: 'password', re: /(?:\b(?:password|passwd|pwd)\b|密码|口令)\s*[:=：]\s*\S{6,}/i },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/i },
  { name: 'url-credentials', re: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/ },
  { name: 'lingxu-token', re: /\btk_[0-9a-f]{8,}\b/ },
  { name: 'mdcg-token', re: /mdcg1\.[A-Za-z0-9._-]{20,}/ }
]

/**
 * 扫描文本中的凭据形态。
 * @returns {string[]} 命中的模式名（空数组表示干净）
 */
export function findCredentials(text) {
  const body = String(text ?? '')
  const hits = []
  for (const { name, re } of CREDENTIAL_PATTERNS) {
    if (re.test(body)) hits.push(name)
  }
  return hits
}

/** 归一化文本：用于去重与合并比较。 */
export function normalizeMemoryText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 记忆 id：内容 + 时间戳的稳定摘要，避免同一内容重复生成不同 id 时无法识别。 */
export function memoryId(text, at = new Date()) {
  const h = createHash('sha256').update(normalizeMemoryText(text)).digest('hex').slice(0, 12)
  return `m-${h}-${at.getTime().toString(36)}`
}

/** 内容指纹（仅内容，不含时间）。 */
export function contentDigest(text) {
  return createHash('sha256').update(normalizeMemoryText(text).toLowerCase()).digest('hex').slice(0, 16)
}

/**
 * 渲染后文本的 UTF-8 字节数。
 *
 * 为什么除了字符还要报字节：配置项叫 `maxInjectedChars`，按字符算本身没错，
 * 但「4000 字符」在中文里能到 12000 字节 —— 用户看设置页只会以为「我还有富余」。
 * 两个数并排报，他才能自己换算成模型那边真实的上下文开销。
 *
 * 手写而不是用 Buffer / TextEncoder：本模块同时被宿主、CLI 脚本和预览路径
 * import，少依赖一个宿主才有的全局对象就少一处「在别处炸掉」的可能。
 *
 * @param {string} text
 * @returns {number} 字节数，非字符串按空串处理
 */
export function utf8Bytes(text) {
  if (typeof text !== 'string' || text === '') return 0
  let bytes = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp < 0x80) bytes += 1
    else if (cp < 0x800) bytes += 2
    else if (cp < 0x10000) bytes += 3
    else bytes += 4
  }
  return bytes
}

/** 默认层级 —— 存量记录没有 layer 字段时按 global 处理（不损失可见性）。 */
export const DEFAULT_MEMORY_LAYER = 'global'

/**
 * 因**预算**而没进去的三种原因。
 *
 * 与 `tombstoned` / `layer-mismatch` 分开列，是因为它们对模型的含义完全不同：
 * 前者是「有这条，但这轮放不下」，后者是「这条根本不适用于当前项目」。
 * 只有前者必须写进提示词 —— 不写，模型就会把「没看到」当成「没记过」。
 */
export const BUDGET_DROP_REASONS = Object.freeze(['over-max', 'over-budget', 'dropped-by-budget'])

/**
 * 从一次选取结果里抽出「有几条是纯粹因为预算被挤掉的」。
 *
 * 单独成一个导出，是为了让段渲染（index.mjs）与设置页预览走**同一个**口径：
 * 两边各算一遍，迟早会出现「预览说 3 条没进、实际注入说 1 条」。
 *
 * @param {object} selection selectForInjection 的返回值
 * @returns {{count: number, maxCount: number, maxChars: number, usedBytes: number}}
 */
export function summarizeOmission(selection) {
  const list = (selection?.dropped ?? []).filter((d) => BUDGET_DROP_REASONS.includes(d?.reason))
  const budget = selection?.budget ?? {}
  return {
    count: list.length,
    maxCount: budget.maxCount ?? 0,
    maxChars: budget.maxChars ?? 0,
    usedBytes: budget.usedBytes ?? 0
  }
}

/**
 * 归一化工作区路径，用于比较。
 *
 * Windows 路径大小写不敏感、`\` 与 `/` 混写、还可能带尾部分隔符，
 * 直接字符串比较会把同一个目录判成两个 —— 于是「本工作区的记忆」在某些
 * 调用路径下悄悄漏掉。统一小写 + 正斜杠 + 去尾分隔符后再比。
 */
export function normalizeCwd(cwd) {
  const raw = String(cwd ?? '').trim()
  if (!raw) return ''
  return raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 归一化层级：未知值一律回落到默认层级。 */
export function normalizeLayer(layer) {
  return MEMORY_LAYERS.includes(layer) ? layer : DEFAULT_MEMORY_LAYER
}

/**
 * 构造一条候选记忆记录。
 *
 * `layer` 决定这条记忆的生效范围（global / workspace），`cwd` 是它属于哪个工作区。
 * **两者都是真字段，参与注入筛选** —— 这一点是 2026-10-11 修的设计空洞：
 * 此前 scope 与 cwd 投递时写入、注入时完全忽略，导致在 A 项目沉淀的记忆
 * 会在 B 项目作为「用户已采纳的背景」被注入，跨工作区污染且用户无从察觉。
 *
 * @returns {{ok:true, record:object} | {ok:false, error:string}}
 */
export function makeCandidate(
  { text, note, layer, scope, source, sessionId, cwd, type, sourceRef, verifyAt },
  at = new Date()
) {
  const body = normalizeMemoryText(text)
  if (!body) return { ok: false, error: '记忆内容不能为空' }
  if (body.length > MEMORY_TEXT_MAX) {
    return { ok: false, error: `记忆内容长度超过上限 ${MEMORY_TEXT_MAX} 字符（当前 ${body.length}）` }
  }

  // 凭据闸门：命中即拒收，绝不落盘到缓冲区（拍板 q8）
  const credentials = findCredentials(body)
  if (credentials.length > 0) {
    return {
      ok: false,
      error: `记忆内容疑似包含凭据（命中 ${credentials.join('、')}），已拒绝入库。凭据不应写入任何记忆文件。`
    }
  }

  const trimmedNote = normalizeMemoryText(note)
  const record = {
    id: memoryId(body, at),
    text: body,
    digest: contentDigest(body),
    status: 'pending',
    layer: normalizeLayer(layer),
    source: source || 'agent',
    capturedAt: at.toISOString(),
    // 新字段一律给出确定值，不留 undefined：
    //   type 决定注入行尾部会不会出现时间衰减标签（见 lib/decay.mjs），
    //   state 决定措辞（现行 / 曾如此 / 有争议 / 墓碑），
    //   缺失时下游要到处写 `?? 'fact'`，那种兜底散落在五个文件里迟早会漏。
    type: normalizeMemoryType(type),
    state: DEFAULT_MEMORY_STATE
  }
  if (trimmedNote) record.note = trimmedNote.slice(0, MEMORY_NOTE_MAX)
  // cwd **总是**记录（只要调用方给了），哪怕这条是全局记忆：
  //   ① 匹配只看 layer==='workspace' 的记录，全局记忆带着 cwd 不会被误判；
  //   ② 它是设置页「这条其实来自 X 项目」的依据 —— 用户在裁决时最需要的信息
  //      恰恰是「它从哪来」，而事后无法补录。
  if (cwd) record.cwd = normalizeCwd(cwd)
  if (scope) record.scope = scope
  if (sessionId) record.sessionId = sessionId
  // 来源引用与复核点都可选：没给就不写，避免伪造一个看起来像证据的空串。
  if (normalizeMemoryText(sourceRef)) record.sourceRef = normalizeMemoryText(sourceRef).slice(0, MEMORY_NOTE_MAX)
  if (normalizeMemoryText(verifyAt)) record.verifyAt = normalizeMemoryText(verifyAt).slice(0, 40)
  return { ok: true, record }
}

/** 归一化记忆类型：未知值回落到 fact（最保守：事实类衰减最慢，宁可多留）。 */
export function normalizeMemoryType(type) {
  return MEMORY_TYPES.includes(type) ? type : DEFAULT_MEMORY_TYPE
}

/** 归一化生命周期状态：未知值回落到 current。 */
export function normalizeMemoryState(state) {
  return MEMORY_STATES.includes(state) ? state : DEFAULT_MEMORY_STATE
}

/**
 * 改写一条已有记忆的元数据（类型 / 生命周期 / 复核点 / 来源引用）。
 *
 * 为什么需要这个函数：`makeCandidate` 只在**新建**时写这些字段，而真实介质里
 * 已有 21 条旧记忆全部没有类型（字段加进 schema 之前写入的）。要回填，就必须
 * 有一条**只改元数据、不动正文**的写入路径 —— 直接 `putMemory({...record, type})`
 * 散落在路由/命令/脚本里，迟早有人顺手把 status 或 text 一起改了。
 *
 * 刻意不允许改的：id、text、digest、status、capturedAt。
 *   - text 改了 id 就与内容不再对应，而 id 是引用与取代关系的锚；
 *   - status 是「用户的裁决」，只能走 adopt/discard 那条路（带 decidedAt）；
 *   - capturedAt 是「这条什么时候进来的」，改它等于伪造时间线。
 *
 * @param {object} record 现有记录
 * @param {object} changes {type?, state?, verifyAt?, sourceRef?}
 * @param {Date} [now]
 * @returns {{ok:true, record:object, changed:string[]} | {ok:false, error:string}}
 */
export function applyMemoryMeta(record, changes = {}, now = new Date()) {
  if (!record || typeof record !== 'object' || !record.id) {
    return { ok: false, error: '没有可改的记录' }
  }
  const next = { ...record }
  const changed = []

  if (changes.type !== undefined) {
    const type = normalizeMemoryType(changes.type)
    if (type !== record.type) {
      next.type = type
      changed.push('type')
    }
  }

  if (changes.state !== undefined) {
    const state = normalizeMemoryState(changes.state)
    if (state !== (record.state ?? DEFAULT_MEMORY_STATE)) {
      next.state = state
      changed.push('state')
      // 回到 current 时必须把取代指针清掉，否则注入行会同时带着「现行」与
      // 「被谁取代」两种互相矛盾的信息，读的人不知道该信哪个。
      if (state === 'current' && 'supersededBy' in next) delete next.supersededBy
    }
  }

  if (changes.verifyAt !== undefined) {
    const verifyAt = String(changes.verifyAt ?? '').trim()
    if (verifyAt === '') {
      if ('verifyAt' in next) {
        delete next.verifyAt
        changed.push('verifyAt')
      }
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(verifyAt)) {
        return { ok: false, error: `复核点必须是 YYYY-MM-DD，收到「${verifyAt}」` }
      }
      // 复核点设成过去没有意义：它一进去就立刻显示「可能已过时」，
      // 等于用户以为自己在设一个提醒，实际只是给这条记忆盖了个过期章。
      if (verifyAt < now.toISOString().slice(0, 10)) {
        return { ok: false, error: `复核点 ${verifyAt} 已经过去了；要标过期请直接改 state` }
      }
      if (verifyAt !== record.verifyAt) {
        next.verifyAt = verifyAt
        changed.push('verifyAt')
      }
    }
  }

  if (changes.sourceRef !== undefined) {
    const sourceRef = normalizeMemoryText(changes.sourceRef).slice(0, MEMORY_NOTE_MAX)
    if (sourceRef === '') {
      if ('sourceRef' in next) {
        delete next.sourceRef
        changed.push('sourceRef')
      }
    } else if (sourceRef !== record.sourceRef) {
      next.sourceRef = sourceRef
      changed.push('sourceRef')
    }
  }

  // 取代指针：只在「这条被那条取代」时才有意义。
  //
  // 为什么必须显式给而不是自动推断：判断「这两条讲的是不是同一件事、新的有没有
  // 推翻旧的」是语义判断，而记忆库一旦自动做语义判断，就会生成用户没说过的话。
  // 所以这里只记录事实（谁取代谁），不做推断。
  if (changes.supersededBy !== undefined) {
    const by = normalizeMemoryText(changes.supersededBy).slice(0, 120)
    if (by === '') {
      if ('supersededBy' in next) {
        delete next.supersededBy
        changed.push('supersededBy')
      }
    } else if (by !== record.supersededBy) {
      // 指向自己等于自环：它既是被取代的，又取代了自己，读的人无从判断哪条算数。
      if (by === record.id) {
        return { ok: false, error: '不能指向自己' }
      }
      next.supersededBy = by
      // 有取代者却没标状态，等于记了一笔没人看的账：
      // 注入行会照旧按 current 渲染，用户以为标了，模型照旧当真。
      if ((next.state ?? DEFAULT_MEMORY_STATE) !== 'superseded') {
        next.state = 'superseded'
        if (!changed.includes('state')) changed.push('state')
      }
      changed.push('supersededBy')
    }
  }

  return { ok: true, record: next, changed }
}

/**
 * 把一条记忆渲染成注入用的那一行。
 *
 * 三条信息必须出现在行里，否则模型会把它当成「此刻仍然成立」：
 *   - 状态：superseded → 「曾如此」，contradicted → 「有争议」；
 *   - 日期：写入日期让人知道这条有多旧；
 *   - 复核点：过期后标「可能已过时」，把「要不要更新」交回给用户。
 *
 * 刻意不加任何形容词（如「重要」「关键」）：那是我在替用户排序。
 *
 * @param {object} record
 * @param {Date} [now]
 * @returns {string}
 */
export function formatMemoryLine(record, now = new Date()) {
  const body = String(record?.text ?? '')
  if (!body) return ''
  const state = normalizeMemoryState(record.state)
  const tags = []
  if (state === 'superseded') tags.push('曾如此')
  else if (state === 'contradicted') tags.push('有争议')
  else if (state === 'dropped') tags.push('已删除（墓碑）')
  const day = String(record?.capturedAt ?? '').slice(0, 10)
  if (day) tags.push(day)
  // 时间衰减：只按类型 + 日历算，绝不按「我觉不觉得它过时了」算。
  // 墓碑不加这个标签 —— 「已删除」和「很久没更新」同时出现，读者会以为这是两条信息，
  // 其实第二句对一个已经不再注入的条目毫无意义。
  if (state !== 'dropped') {
    const decay = decayTag(record, now)
    if (decay) tags.push(decay)
  }
  // 复核点只在**过期之后**才提示：没到期就天天提一遍，等于制造噪音，
  // 用户很快会学会无视这一行，那整条机制就废了。
  const verify = String(record?.verifyAt ?? '').slice(0, 10)
  if (verify && /^\d{4}-\d{2}-\d{2}$/.test(verify) && verify < now.toISOString().slice(0, 10)) {
    tags.push('可能已过时')
  }
  return tags.length > 0 ? `${body}｜${tags.join('｜')}` : body
}

/** 按状态分组。 */
export function groupByStatus(records) {
  const out = { pending: [], adopted: [], discarded: [] }
  for (const r of records ?? []) {
    if (out[r.status]) out[r.status].push(r)
  }
  const byTime = (a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt))
  out.pending.sort(byTime)
  out.adopted.sort(byTime)
  out.discarded.sort(byTime)
  return out
}

/**
 * 每晚整理：在待审缓冲区内做去重、合并与限额淘汰。
 *
 * 纯本地、无模型调用 —— 目的只是让用户面对一份干净的清单，而不是做语义抽取。
 * （语义归纳由 Agent 的 remember 工具在对话中完成。）
 *
 * @param {object[]} records 全量记忆
 * @param {object} options {maxPending, now}
 * @returns {{adopted: string[], discarded: string[], kept: object[], summary: object}}
 *   adopted/discarded 为需要改状态的 id 列表，由调用方落盘（保持本函数纯函数）
 */
export function triage(records, { maxPending = 200, now = new Date() } = {}) {
  const groups = groupByStatus(records)
  const toDiscard = []
  const kept = []

  // 1) 已被采纳的内容，其 pending 副本直接丢弃
  const adoptedDigests = new Set(groups.adopted.map((r) => r.digest || contentDigest(r.text)))
  const seen = new Set()
  let duplicates = 0

  for (const record of groups.pending) {
    const digest = record.digest || contentDigest(record.text)
    if (adoptedDigests.has(digest)) {
      toDiscard.push({ id: record.id, note: '与已采纳记忆重复，自动丢弃' })
      duplicates += 1
      continue
    }
    if (seen.has(digest)) {
      toDiscard.push({ id: record.id, note: '与本次缓冲区中的其他候选重复，自动合并' })
      duplicates += 1
      continue
    }
    seen.add(digest)
    kept.push(record)
  }

  // 2) 限额淘汰：超出上限的按最早优先丢弃
  const overflow = kept.length > maxPending ? kept.slice(0, kept.length - maxPending) : []
  const survivors = overflow.length > 0 ? kept.slice(kept.length - maxPending) : kept
  for (const record of overflow) {
    toDiscard.push({ id: record.id, note: `缓冲区超过 ${maxPending} 条上限，按最早优先淘汰` })
  }

  const summary = {
    ranAt: now.toISOString(),
    pendingBefore: groups.pending.length,
    pendingAfter: survivors.length,
    duplicatesRemoved: duplicates,
    overflowRemoved: overflow.length,
    discardedTotal: toDiscard.length,
    adoptedTotal: groups.adopted.length
  }

  return { toDiscard, kept: survivors, summary }
}

/**
 * 判断一条记忆是否适用于某个工作区。
 *
 * 规则只有两条，刻意做得可预测：
 *   - global 记忆处处适用；
 *   - workspace 记忆只在 cwd 归一化后完全相等时适用。
 *
 * 不做「子目录继承」：工作区的 override 是精确匹配语义（见 lib/overrides.mjs），
 * 记忆若采用继承语义，用户在子目录里会看到父目录的记忆，排查起来极难。
 *
 * @returns {{applicable: boolean, reason: string}} reason 是机器可读的原因码
 */
export function matchLayer(record, cwd) {
  const layer = normalizeLayer(record?.layer)
  if (layer === 'global') return { applicable: true, reason: 'global' }
  if (!record?.cwd) return { applicable: false, reason: 'workspace-scope-unknown' }
  const here = normalizeCwd(cwd)
  if (!here) return { applicable: false, reason: 'no-workspace-context' }
  if (normalizeCwd(record.cwd) !== here) return { applicable: false, reason: 'other-workspace' }
  return { applicable: true, reason: 'workspace-match' }
}

/** 原因码 → 人话（设置页与 /state 都用它，避免两处各写一份翻译）。 */
export const INJECTION_REASON_TEXT = {
  'global': '全局记忆，处处生效',
  'workspace-match': '本工作区的记忆',
  'no-injection': '记忆层已关闭或上限为 0',
  'other-workspace': '属于别的工作区，不在本会话注入',
  'workspace-scope-unknown': '标记为工作区记忆但没记录属于哪个工作区',
  'no-workspace-context': '当前会话没有工作区信息，无法匹配工作区记忆',
  'not-adopted': '尚未被采纳',
  'over-max': '已采纳条数超过注入上限，按时间取最新的',
  'over-budget': '已采纳内容超出注入字符预算，取不下',
  'dropped-by-budget': '前面几条已占满字符预算',
  'render-failed': '这条记忆渲染失败（字段形状不对），本轮没注入，其余照常',
  'tombstoned': '用户已删除（保留墓碑，不参与注入）',
  'included': '已注入提示词'
}

/** 原因码翻译；未收录的码原样返回，不吞掉诊断信息。 */
export function describeInjectionReason(code) {
  return INJECTION_REASON_TEXT[code] ?? code
}

/**
 * 本地相似度：字符二元组（bigram）的 Jaccard 系数。
 *
 * 为什么不用编辑距离：记忆多为中文短句，编辑距离对同义改写完全无感，
 * 而 bigram 集合比较「同义改写」很灵 —— 且纯本地、零依赖、零模型调用。
 *
 * 为什么只给建议不自动合并：合并意味着**合成一段用户没说过的话**。
 * 本插件的立场是「判断什么值得记交给模型，什么真的生效交给用户」，
 * 自动合并恰好违背它 —— 所以聚类只用来把「这几条像在说同一件事」摆到
 * 用户面前，让裁决更快，而不是替他裁决。
 */
export function similarity(a, b) {
  const grams = (text) => {
    const body = normalizeMemoryText(text).toLowerCase().replace(/\s+/g, '')
    const set = new Set()
    for (let i = 0; i + 1 < body.length; i += 1) set.add(body.slice(i, i + 2))
    // 单字内容退化成一个整体，避免空集合恒等于 1。
    if (set.size === 0 && body.length > 0) set.add(body)
    return set
  }
  const left = grams(a)
  const right = grams(b)
  if (left.size === 0 || right.size === 0) return 0
  let inter = 0
  for (const g of left) if (right.has(g)) inter += 1
  return inter / (left.size + right.size - inter)
}

/** 默认的相似度阈值：低于它不算「像在说同一件事」。 */
export const CLUSTER_THRESHOLD = 0.6

/**
 * 在待审缓冲区里找出「疑似同一件事」的簇，以及可能与已采纳记忆冲突的新候选。
 *
 * @param {object[]} records 全量记忆
 * @param {object} options {threshold}
 * @returns {{clusters: Array, conflicts: Array}}
 *   clusters 每簇含 ids/texts/similarity 范围，供设置页提示「这 3 条像在说同一件事」；
 *   conflicts 是「候选与某条已采纳记忆高度相似」——采纳它就等于制造重复。
 */
export function clusterPending(records, { threshold = CLUSTER_THRESHOLD } = {}) {
  const { pending, adopted } = groupByStatus(records)
  const clusters = []
  const assigned = new Set()

  for (let i = 0; i < pending.length; i += 1) {
    const seed = pending[i]
    if (assigned.has(seed.id)) continue
    const members = [seed]
    let weakest = 1
    for (let j = i + 1; j < pending.length; j += 1) {
      const other = pending[j]
      if (assigned.has(other.id)) continue
      const score = similarity(seed.text, other.text)
      if (score >= threshold) {
        members.push(other)
        weakest = Math.min(weakest, score)
      }
    }
    if (members.length > 1) {
      for (const m of members) assigned.add(m.id)
      clusters.push({
        ids: members.map((m) => m.id),
        texts: members.map((m) => m.text),
        // 汇报最弱的一对：簇的可信度取决于最弱的一环，不是最强的那对。
        similarity: Number(weakest.toFixed(3)),
        hint: `${members.length} 条候选像在说同一件事，建议只采纳其一或先自行合并`
      })
    }
  }

  const conflicts = []
  for (const candidate of pending) {
    for (const keep of adopted) {
      const score = similarity(candidate.text, keep.text)
      if (score >= threshold) {
        conflicts.push({
          candidateId: candidate.id,
          candidateText: candidate.text,
          adoptedId: keep.id,
          adoptedText: keep.text,
          similarity: Number(score.toFixed(3)),
          hint: '与一条已采纳记忆高度相似，采纳它等于制造重复'
        })
      }
    }
  }

  return { clusters, conflicts }
}

/**
 * 选取注入提示词的已采纳记忆，并给出**每一条为什么进 / 为什么不进**。
 *
 * 这是本插件相对「有记忆功能」的多数实现的差异点之一：注入不是黑箱。
 * 用户看得见「这条没进去，因为它属于别的工作区」或「因为字符预算不够」，
 * 而不是面对一个静默截断的列表。
 *
 * 双约束：条数（maxInjected）与字符数（maxInjectedChars）同时生效，取先到者。
 * 只有条数约束时，40 条长记忆一样能挤爆上下文。
 *
 * @param {object[]} records 全量记忆
 * @param {object} options {maxInjectedChars, cwd}
 * @returns {{selected: object[], decisions: object[], dropped: object[]}}
 *   decisions 覆盖**每一条已采纳记忆**（含未选中的），dropped 是其子集。
 */
export function selectForInjection(records, maxInjected, options = {}) {
  const { maxInjectedChars = 0, cwd = '', now = new Date() } = options
  const { adopted } = groupByStatus(records)
  const selected = []
  const decisions = []
  let usedChars = 0

  // 新的优先：记忆的有效性随时间衰减，最新的最贴近当下。
  //
  // 排序键是两段：**先看有没有超窗**（超窗的整段挪到最后），再按写入时间倒序。
  // 为什么不按连续权重排：连续权重算出来的顺序，用户没法用一句话解释「为什么这条
  // 排在前面」；「超窗的排最后」可以解释。而这个问题本来就只需要一个二选一。
  //
  // 这是本函数对衰减的**全部**用法：只影响顺序，不改记录。
  // 超窗条目在条数够、字数够的时候照样注入，只是行尾多一个标签。
  const ordered = [...adopted].sort((a, b) => {
    const rankDiff = decayRank(a, now) - decayRank(b, now)
    if (rankDiff !== 0) return rankDiff
    return String(b.capturedAt).localeCompare(String(a.capturedAt))
  })

  const disabled = !maxInjected || maxInjected <= 0
  let rank = 0

  for (const record of ordered) {
    const { applicable, reason: matchReason } = matchLayer(record, cwd)
    const state = normalizeMemoryState(record.state)
    const decay = decayInfo(record, now)
    const decide = (included, reason) => {
      decisions.push({
        id: record.id,
        text: record.text,
        layer: normalizeLayer(record.layer),
        type: normalizeMemoryType(record.type),
        state,
        capturedAt: record.capturedAt,
        verifyAt: record.verifyAt,
        // 衰减只报事实（几岁、超没超窗），不报判断。设置页靠它回答
        // 「这条为什么排到最后」，否则用户只看到结果看不到原因。
        ageDays: decay.ageDays,
        decayed: decay.decayed,
        included,
        reason,
        reasonText: describeInjectionReason(reason)
      })
    }

    if (disabled) { decide(false, 'no-injection'); continue }
    if (state === 'dropped') { decide(false, 'tombstoned'); continue }
    if (!applicable) { decide(false, matchReason); continue }
    if (rank >= maxInjected) { decide(false, 'over-max'); continue }
    // 预算按**渲染后**的行长算，不按原文长度：注入进提示词的是带日期/状态标签的
    // 那一行，若按原文算，标签带来的额外字符会让实际注入超出 maxInjectedChars。
    //
    // 渲染失败不能把整条记忆链弄崩：`formatMemoryLine` 会读 capturedAt / verifyAt /
    // type 去算标签与衰减，这些字段来自别的插件或用户手写，形状没有保证。
    // 一条坏数据抛出去，代价是 `/api/anima/state` 整个 500、设置页全白 ——
    // 而真正该发生的是「这一条渲染不出来，其余照常，并且明确记下那一条没进去」。
    let body = ''
    try {
      body = formatMemoryLine(record, now)
    } catch {
      decide(false, 'render-failed')
      continue
    }
    if (maxInjectedChars > 0 && usedChars + body.length > maxInjectedChars) {
      // 单条就超预算与「前面占了位置」是两种情况，分开报，用户才知道该删谁。
      decide(false, usedChars === 0 ? 'over-budget' : 'dropped-by-budget')
      continue
    }
    usedChars += body.length
    rank += 1
    selected.push({ ...record, line: body })
    decide(true, 'included')
  }

  return {
    selected,
    decisions,
    dropped: decisions.filter((d) => !d.included),
    // 预算用量一并回报：设置页要能画「43/40 条、1180/4000 字」这种进度，
    // 否则用户只知道「有东西没进去」，不知道离上限还有多远。
    budget: {
      usedCount: selected.length,
      maxCount: disabled ? 0 : maxInjected,
      usedChars,
      maxChars: maxInjectedChars,
      // 字节账本：不参与判定（判定仍按字符，与配置项名字一致），
      // 只是把「这些字符在中文里到底是多少字节」如实报出来。
      usedBytes: utf8Bytes(selected.map((r) => `- ${r.line}`).join('\n')),
      // 卡在哪个闸上。三档分开，是因为用户能做的事完全不同：
      // count → 删条目；chars → 调预算或删长条目；none → 没卡。
      //
      // ⚠️ 不能只看 usedChars >= maxChars 来判断 chars：一条都没放下时
      // usedChars 仍然是 0，那样会报成 none —— 而「0 条注入、全部因预算」
      // 恰恰是最需要说清楚的那种情况。
      limitedBy: disabled
        ? 'disabled'
        : (decisions.some((d) => d.reason === 'over-max') ? 'count'
          : (decisions.some((d) => d.reason === 'over-budget' || d.reason === 'dropped-by-budget') ? 'chars'
            : (decisions.some((d) => d.reason === 'render-failed') ? 'error' : 'none'))),
      // 渲染失败单独记数。它不是预算问题：调大预算也没用，得去修那条数据。
      // 混进 over-budget 会误导用户去改配置，而配置根本不是原因。
      renderFailed: decisions.filter((d) => d.reason === 'render-failed').length
    }
  }
}
