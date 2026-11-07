// lib/retrospect.mjs — 回扫式复盘：从旧会话里捞出「当时该记却没记」的线索
//
// 为什么需要它（这是实测出来的，不是想出来的）：
//   anima 的记忆层长期只有 2 条，`pending` 恒为 0。翻 `C:\Users\zmy\.dsh\sessions`
//   下 53 个会话、剔除噪音后得到 925 条真实用户发言，用 mnemon 的「两级漏斗」实测：
//   第一段四条判据只命中 4 条（0.4%），第二段打分公式却让 44.6% 的轮次送审 ——
//   要么太严要么太宽，中间没有可用档位（记在 docs/peers/mnemon.md:287-308 与
//   本仓的探针结果里）。常驻闸门这条路在真实语料上站不住。
//
// 真正的证据是两条时间戳：
//   2026-11-04T10:13:24.360Z「我有没有说过不允许一直往c盘写东西…」
//   2026-11-04T10:14:59.214Z「非必要不往c盘写是不是我是不是说过…」
//   而这条规则被写进记忆是 2026-11-05T04:59:24.335Z，**晚了一天**。
//   写进去之后，语料里再没有同类抱怨 —— 说明写下来的记忆确实被用上了。
//   所以问题在「当时没写下来」，不在「写了没用上」。
//
// 由此定的方向：**不碰实时对话，只回扫历史**。实时对话里插闸门要付「每轮都判」
// 的代价，而真实信号出现率是 937 轮里 2 次；回扫是批量、可重跑、可 dry-run 的。
//
// 本模块只做「捞线索」，**不生成记忆、不写库、不调模型**。三条硬规矩：
//   ① 捞出来的原文是用户自己那句话，不是我改写的记忆条目 —— 改写就等于我替用户下结论。
//   ② 每条线索必须带出处（会话文件 + 事件序号 + 时间），给不出就不收。
//   ③ 没有线索就说没有；不许为了「有产出」而放宽判据。

/** 线索类型。词典顺序即优先级：一个问题只算一次，先命中的算。 */
export const LEAD_KINDS = ['complaint', 'explicit', 'correction', 'constraint']

/**
 * 判据表。每一条都是在这台机器的真实语料上量过的，阈值后面注明命中率
 * （分母 = 925 条真实用户发言，2026-11-08 实测）。
 *
 * 刻意**没有**收录的两种：
 *   · 单独的「不要」—— 42 条命中（4.5%），但大量是「不要重试」「不用了」这类
 *     一次性指令，不是长期约束。宽到这个程度，线索表会变成聊天记录复制品。
 *   · 情绪词（生气 / 无语）—— 情绪不等于信息，抱怨里真正有用的是「我说过」这层。
 */
const LEAD_PATTERNS = [
  {
    kind: 'complaint',
    // 「我说过」类：用户指出某条规则早就交代过 —— 这是最强的「该记没记」信号。
    // 实测 925 条语料里只有 2 条（0.2%）。宁少不滥。
    re: /(我说过|有没有说过|不是说过|我跟你说过|早说过|说过多少次|又说一遍|还要我说)/,
    why: '用户指出这条早已交代过'
  },
  {
    kind: 'explicit',
    // 用户直接要求记住。实测 1 条（0.1%）。
    // 英文只认祈使式 `remember this/that` / `save memory` —— 裸 `remember` 会命中
    // 「all AI remember the same you」这类产品介绍，实测踩过一次。
    re: /(记住|记下来|记一下|记着|别忘了|从今往后|长期记住)|(remember (this|that)|save (this to )?memory)/i,
    why: '用户明确要求记住'
  },
  {
    kind: 'correction',
    // 用户指出我搞错了。实测 6 条（0.6%）。
    // 刻意**不收**裸「错了」：「点错了」「改错了怎么办」是选错选项/提问，不是纠正。
    // 收粗口不是在做道德判断 —— 实测里纠正往往伴随粗口，它是强信号不是脏话。
    // 负向先行：出现「点错 / 改错 / 记错 / 按错」就整句不判纠正。
    re: /(不对|搞错|搞反|理解错|你说错|谁让你|你他妈|你tm|你踏马|我不是这个意思|我说的是)/,
    notBefore: /(点|改|按|记|写|选|填|输)错/,
    why: '用户纠正了一次错误'
  },
  {
    kind: 'constraint',
    // 带否定词**且**带持久性限定的长期约束。
    // 刻意不收「不能」：语料里它几乎全是能力陈述（「不能一直运行」「不能打开」），
    // 不是规则。实测这一条改动把 constraint 的假阳性从 8 条降到 3 条。
    // 刻意不收裸「再」：「不要再崩溃了」是当场的请求，不是长期规则。
    // 用 [^。！？\n]{0,24} 而不是 \S{0,20}：后者会跨中文标点连通两句话。
    re: /(不许|禁止|不准|严禁|不要|别)[^。！？\n]{0,24}(所有|任何|每次|一律|一直|总是|以后)/,
    why: '用户下了一条禁止性规则'
  }
]

/** 单条线索原文的字符上限。超了就截断并标注，不整条丢。 */
export const MAX_LEAD_CHARS = 240
/** 一次回扫最多产出多少条线索。 */
export const MAX_LEADS = 30
/** 单条发言拆句时的上限：再长的句子多半是粘贴的日志，不是一句话。 */
const MAX_SENTENCE_CHARS = 400

/**
 * 判断一条 user/message 是不是「真用户说的」。
 *
 * 这一步是必须的，不是洁癖：实测 53 个会话里 user 角色的消息有一大半是伪装 ——
 * system-reminder 快照、subagent 任务书、任务板卡片、团队消息、另一个插件
 * （论衡）的产物。不过滤的话，线索表里会混进「你的任务：…」「不要调用任何工具」
 * 这种我写给自己的话。实测：过滤前 18 条线索，过滤后 11 条，去掉的 7 条全是假的。
 *
 * @param {string} text
 * @param {string} [sourceKind] 事件里的 `source.kind`；以 `plugin:` 开头的是插件注入
 * @param {string} [rpcId] 事件里的 `source.rpcId`；`task-board-` 开头的是任务板卡片
 * @returns {boolean}
 */
export function isRealUserText(text, sourceKind = '', rpcId = '') {
  const t = String(text ?? '').trim()
  if (t.length === 0) return false
  if (String(sourceKind ?? '').startsWith('plugin:')) return false
  if (String(rpcId ?? '').startsWith('task-board-')) return false
  const NOISE = [
    /^<system-reminder>/,
    /^Background subagent /,
    /^Team message from /,
    /^Agent \S+ sent a message/,
    /^你的任务：/,
    /^任务：/,
    /^你在 [A-Z]:\\/,
    /^请实现/,
    /^〔论衡/,
    /^\[dsh-anima /,
    /^Provider finish_reason/,
    /^Time sampled while preparing turn/,
    // `只回一行：OK。不要调用任何工具，不要读文件。` —— 探针/子任务下发的指令。
    // 它的 rpcId 是普通 uuid（不是 task-board- 前缀），所以只能靠首句特征认。
    // 人不会用「只回一行：OK」这种句子跟别人说话。
    /^只回一行/
  ]
  return !NOISE.some((re) => re.test(t))
}

/**
 * 把一段发言拆成句子。中文句读 + 换行。
 *
 * 为什么要拆：一整条 300 字的抱怨里，有用的往往只有一句。「说了很多但可被证伪的
 * 断言接近零」正是要避免的形状 —— 线索要短、要能对上原话。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  return String(text ?? '')
    .split(/[。！？；\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= MAX_SENTENCE_CHARS)
}

/**
 * 给一句话判类。命中不到就返回 null（**不收**，不是收进「其它」桶）。
 *
 * @param {string} sentence
 * @returns {{kind: string, why: string}|null}
 */
export function classifySentence(sentence) {
  const s = String(sentence ?? '')
  if (s === '') return null
  for (const rule of LEAD_PATTERNS) {
    if (rule.notBefore && rule.notBefore.test(s)) continue
    if (rule.re.test(s)) return { kind: rule.kind, why: rule.why }
  }
  return null
}

/**
 * 从事件表里捞线索。
 *
 * 入参刻意做成「已经解好的事件数组」，不在这里读文件：这样它能被单元测试喂夹具，
 * 也能被脚本喂 `readSessionEvents()` 的结果，还能被宿主喂别的来源。
 *
 * @param {object} input
 * @param {Array<{seq?:number, at?:string, type?:string, text?:string, sourceKind?:string}>} input.events
 * @param {number} [input.sinceMs] 只看这个时刻之后的事件（毫秒时间戳）；不给则全看
 * @param {number} [input.maxLeads]
 * @param {string} [input.sessionRef] 会话标识，写进线索的出处
 * @returns {{leads: Array<{kind:string, why:string, text:string, sessionRef:string, seq:number|null, at:string}>, scanned: number, matched: number, skipped: number}}
 */
export function extractLeads({ events = [], sinceMs = 0, maxLeads = MAX_LEADS, sessionRef = '' } = {}) {
  const leads = []
  let scanned = 0
  let matched = 0
  let skipped = 0
  const floor = Number(sinceMs) > 0 ? Number(sinceMs) : 0

  for (const ev of Array.isArray(events) ? events : []) {
    if (ev?.type !== 'user/message') continue
    const at = typeof ev.at === 'string' ? ev.at : ''
    const atMs = at ? Date.parse(at) : NaN
    if (floor > 0 && Number.isFinite(atMs) && atMs < floor) continue
    const text = ev.text ?? ''
    if (!isRealUserText(text, ev.sourceKind, ev.rpcId)) {
      skipped += 1
      continue
    }
    scanned += 1
    for (const sentence of splitSentences(text)) {
      const hit = classifySentence(sentence)
      if (!hit) continue
      matched += 1
      if (leads.length >= maxLeads) break
      const clipped = sentence.length > MAX_LEAD_CHARS
        ? `${sentence.slice(0, MAX_LEAD_CHARS)}…`
        : sentence
      leads.push({
        kind: hit.kind,
        why: hit.why,
        text: clipped,
        sessionRef: String(sessionRef ?? ''),
        seq: Number.isInteger(ev.seq) ? ev.seq : null,
        at
      })
    }
    if (leads.length >= maxLeads) break
  }
  return { leads, scanned, matched, skipped }
}

/** 线索的去重键：去掉空白与标点后的正文。同一句话在不同会话里出现两次只报一次。 */
export function leadKey(lead) {
  return String(lead?.text ?? '').replace(/[\s，。！？；：、,.!?;:"'「」『』()（）]/g, '').slice(0, 120)
}

/**
 * 判断这次回扫该不该出声。
 *
 * 与 `assessPatrol` 同一条纪律：**只看「有没有新的」**。上周捞到的线索这周还在，
 * 不重复报 —— 用户早就知道了，再报一遍就是噪音。减少（用户已经处理掉）也不报，
 * 那是把事情办完的结果，不该换来一条通知。
 *
 * @param {object} input
 * @param {Array} [input.leads] 本次捞到的线索
 * @param {string[]} [input.previousKeys] 上次已报过的去重键
 * @returns {{shouldReport: boolean, newLeads: Array, added: number, reasons: string[]}}
 */
export function assessRetrospect({ leads = [], previousKeys = [] } = {}) {
  const list = Array.isArray(leads) ? leads : []
  const prev = new Set((Array.isArray(previousKeys) ? previousKeys : []).map(String))
  const seen = new Set()
  const newLeads = []
  for (const lead of list) {
    const key = leadKey(lead)
    if (key === '' || prev.has(key) || seen.has(key)) continue
    seen.add(key)
    newLeads.push({ ...lead, key })
  }
  const reasons = []
  if (newLeads.length > 0) reasons.push(`leads:${newLeads.length}`)
  return { shouldReport: newLeads.length > 0, newLeads, added: newLeads.length, reasons }
}

/**
 * 把线索压成可以安全落盘的那一份。
 *
 * 为什么压：`store` 的 metaSchema 会把不认识的字段剥掉（2026-10-24 那个 bug 的形状），
 * 原样塞 `leads` 全量对象，读回来就只剩一个空数组 —— 「写了但读不回来」。
 * 只留三样：去重键（判断新旧用）、类型、正文首段。
 *
 * @param {Array} leads
 * @param {number} [max] 最多落盘几条
 * @returns {{items: Array<{key:string, kind:string, text:string}>, dropped: number}}
 */
export function compactLeads(leads, max = MAX_LEADS) {
  const list = Array.isArray(leads) ? leads : []
  const cap = Number.isInteger(max) && max > 0 ? max : MAX_LEADS
  const items = []
  const seen = new Set()
  for (const lead of list) {
    const key = typeof lead?.key === 'string' && lead.key ? lead.key : leadKey(lead)
    if (!key || seen.has(key)) continue
    seen.add(key)
    if (items.length >= cap) continue
    items.push({
      key,
      kind: String(lead?.kind ?? ''),
      text: String(lead?.text ?? '').slice(0, MAX_LEAD_CHARS)
    })
  }
  return { items, dropped: Math.max(0, list.length - items.length) }
}

/**
 * 渲染给人看的那段话。
 *
 * 空数组返回空串（**不是**空指针，也不是一句「没找到」）—— 与注入层的约定一致：
 * 空串 = 沉默，由调用方决定要不要因此发消息。
 *
 * @param {Array} leads 本次新增的线索
 * @param {object} [opts]
 * @param {number} [opts.maxShown] 最多展示几条
 * @returns {string}
 */
export function retrospectNoticeText(leads, { maxShown = 8 } = {}) {
  const list = Array.isArray(leads) ? leads.filter((l) => l && l.text) : []
  if (list.length === 0) return ''
  const shown = list.slice(0, Math.max(1, Number(maxShown) || 8))
  const lines = [
    '[dsh-anima 复盘] 回扫旧会话时，找到几处你当时说过、但没被记下来的话：'
  ]
  for (const lead of shown) {
    const where = lead.sessionRef ? `（${lead.sessionRef}）` : ''
    lines.push(`· [${lead.kind}] ${lead.text}${where}`)
  }
  if (list.length > shown.length) {
    lines.push(`· 另有 ${list.length - shown.length} 条未列出。`)
  }
  lines.push('这些只是线索，不是结论。要不要记、记成什么，由你决定。')
  return lines.join('\n')
}
