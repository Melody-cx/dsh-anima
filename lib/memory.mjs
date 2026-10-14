// lib/memory.mjs — 待审缓冲区记忆层
//
// 形态（对应拍板 q13 用户原话「每晚整理到一个缓冲区然后给我说我去看哪些要哪些不要」）：
//   Agent 投递候选 → pending 缓冲区 → 每晚自动整理（去重/合并/限额）→ 通知用户审阅
//   → 用户逐条采纳或丢弃 → 只有 adopted 才进入提示词
//
// 关键约束：**绝不自动写入长期记忆**。pending 永远不进提示词的「已采纳」段，
// 只以「待审」形式提示存在，防止未裁决内容被模型当成事实。

import { createHash } from 'node:crypto'
import { MEMORY_NOTE_MAX, MEMORY_TEXT_MAX, MEMORY_LAYERS } from './config.mjs'
export { MEMORY_LAYERS }

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

/** 默认层级 —— 存量记录没有 layer 字段时按 global 处理（不损失可见性）。 */
export const DEFAULT_MEMORY_LAYER = 'global'

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
export function makeCandidate({ text, note, layer, scope, source, sessionId, cwd }, at = new Date()) {
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
    capturedAt: at.toISOString()
  }
  if (trimmedNote) record.note = trimmedNote.slice(0, MEMORY_NOTE_MAX)
  // cwd **总是**记录（只要调用方给了），哪怕这条是全局记忆：
  //   ① 匹配只看 layer==='workspace' 的记录，全局记忆带着 cwd 不会被误判；
  //   ② 它是设置页「这条其实来自 X 项目」的依据 —— 用户在裁决时最需要的信息
  //      恰恰是「它从哪来」，而事后无法补录。
  if (cwd) record.cwd = normalizeCwd(cwd)
  if (scope) record.scope = scope
  if (sessionId) record.sessionId = sessionId
  return { ok: true, record }
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
  const { maxInjectedChars = 0, cwd = '' } = options
  const { adopted } = groupByStatus(records)
  const selected = []
  const decisions = []
  let usedChars = 0

  // 新的优先：记忆的有效性随时间衰减，最新的最贴近当下。
  const ordered = [...adopted].sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)))

  const disabled = !maxInjected || maxInjected <= 0
  let rank = 0

  for (const record of ordered) {
    const { applicable, reason: matchReason } = matchLayer(record, cwd)
    const decide = (included, reason) => {
      decisions.push({
        id: record.id,
        text: record.text,
        layer: normalizeLayer(record.layer),
        capturedAt: record.capturedAt,
        included,
        reason,
        reasonText: describeInjectionReason(reason)
      })
    }

    if (disabled) { decide(false, 'no-injection'); continue }
    if (!applicable) { decide(false, matchReason); continue }
    if (rank >= maxInjected) { decide(false, 'over-max'); continue }
    const body = String(record.text ?? '')
    if (maxInjectedChars > 0 && usedChars + body.length > maxInjectedChars) {
      // 单条就超预算与「前面占了位置」是两种情况，分开报，用户才知道该删谁。
      decide(false, usedChars === 0 ? 'over-budget' : 'dropped-by-budget')
      continue
    }
    usedChars += body.length
    rank += 1
    selected.push(record)
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
      maxChars: maxInjectedChars
    }
  }
}
