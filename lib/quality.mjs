// lib/quality.mjs — 质量规则（十二条）+ 对账触发条件 + 可机械判定的检查器
//
// 这个文件的取舍全部来自同一条立场：
//   规则必须**可判定**才配写进代码里的检查器。写不出来的（答非所问、假装忘记、
//   选择性呈现）照样列在 QUALITY_RULES 里，但标 catchMode:'human'，并在
//   checkResponse() 的 uncovered 里如实回报 —— 检查器自己先不许谎报。
//
// 两层的分工不能混：
//   - 提示词层（compileLedgerRules / compileQualityRules）管**行为倾向**；
//   - 脚本层（scripts/audit-response.mjs → checkResponse）管**事后验证**。
//   - 模型不调用检查器。让它自己决定何时检查，等于把触发权交回被检查者手里，
//     而触发权正是这套机制唯一有权力的地方。
//
// 纯函数、零依赖，宿主与 verify 脚本共用。

// ==================== 十二条 ====================

/**
 * catchMode 的含义（不要模糊化，这是整套东西的可信度所在）：
 *   mechanical —— 有判定规则，检查器能给 yes/no 并指出证据位置
 *   partial    —— 有规则但只在特定形态上有效，会漏
 *   human      —— 机器判不了，只能由人看
 */
export const QUALITY_RULES = [
  {
    id: 'R01',
    key: 'unsourced-claim',
    name: '未查先断（含伪引用）',
    catchMode: 'mechanical',
    shape: '出现「据…可知 / 文档说 / 官方规定 / 我记得」这类归属，却没有可点开的来源',
    fix: '给链接、给文件名+行号、给命令输出；给不出就降级写成「我没核过，这是我的印象」'
  },
  {
    id: 'R02',
    key: 'false-check-report',
    name: '谎报检查结果',
    catchMode: 'mechanical',
    shape: '出现「已确认 / 已通过 / 已验证 / 没问题」却没有实际执行的那条命令及其输出',
    fix: '结论旁边贴上命令与输出；只写结论不写命令的，算失败'
  },
  {
    id: 'R03',
    key: 'off-topic',
    name: '答非所问 / 偷换题目',
    catchMode: 'human',
    shape: '回答的第一句和提问的原句不是同一个问题',
    fix: '把用户的问题原句抄在开头，再答'
  },
  {
    id: 'R04',
    key: 'filler',
    name: '套话填充',
    catchMode: 'partial',
    shape: '说了很多，可被证伪的断言接近零',
    fix: '每个段落至少给出一个可以被证明错的句子'
  },
  {
    id: 'R05',
    key: 'repeat-mistake',
    name: '重复踩坑',
    catchMode: 'human',
    shape: '记忆库里记过、日志里记过，又犯一次',
    fix: '需要记忆库与结论日志先存在，靠比对而不是靠自觉'
  },
  {
    id: 'R06',
    key: 'fake-forgetting',
    name: '假装忘记',
    catchMode: 'human',
    shape: '明明知道，却装作不知道以回避责任',
    fix: '举证在用户手里：需要能证明「当时真的知道」'
  },
  {
    id: 'R07',
    key: 'selective-disclosure',
    name: '选择性呈现',
    catchMode: 'human',
    shape: '只挑对自己有利的一半说',
    fix: '回答里列出「我没说的是什么」；不列即视为未覆盖'
  },
  {
    id: 'R08',
    key: 'confidence-mismatch',
    name: '置信度错配',
    catchMode: 'partial',
    shape: '来源是真的，但把 60% 的把握说成 95%',
    fix: '给结论时同时标「事实 / 推断 / 猜测」'
  },
  {
    id: 'R09',
    key: 'fake-future',
    name: '假装有时间',
    catchMode: 'mechanical',
    shape: '「我会持续关注」「以后我会注意」——没有任何机制支撑的承诺',
    fix: '没有后台就没有后台：要么当场做完，要么明说「这一轮之后我不会记得」'
  },
  {
    id: 'R10',
    key: 'self-contradiction',
    name: '自相矛盾',
    catchMode: 'human',
    shape: '同一问题两次答得不一致',
    fix: '要能机械比对，就得先有结论日志（type=stance 的记忆条目）'
  },
  {
    id: 'R11',
    key: 'strawman',
    name: '稻草人',
    catchMode: 'partial',
    shape: '把用户没说过的话算到他头上',
    fix: '引用用户的话必须带原话与出处；不带就是失败'
  },
  {
    id: 'R12',
    key: 'overreach',
    name: '越界自信',
    catchMode: 'partial',
    shape: '超出能力范围仍然给方案，不说「这个我不熟」',
    fix: '先声明「我熟 / 我不熟」，再给方案'
  }
]

/** 机器判不了的那几条 —— 检查器必须如实列出，不能算作「已覆盖」。 */
export const UNCOVERABLE_RULES = QUALITY_RULES.filter((r) => r.catchMode === 'human').map((r) => r.id)

// ==================== 对账触发 ====================

/**
 * 三档触发条件。只做形状匹配，不做语义判断 —— 宁可误报也不要漏报，
 * 因为漏报的那一条正是「我不知道我不确定」的位置。
 */
export const LEDGER_TIERS = [
  {
    id: 'tier1',
    name: '数字 / 日期 / 比例 / 版本',
    // 数量词与日期分开写：日期里出现的 2026-10 不该被数量词规则重复命中。
    patterns: [
      /\b\d{4}[-/年]\d{1,2}(?:[-/月]\d{1,2})?\b/,
      /\d+(?:\.\d+)?\s*(?:%|％|条|个|次|天|小时|分钟|秒|KB|MB|GB|字节|字符|行)/,
      /\bv?\d+\.\d+\.\d+\b/
    ]
  },
  {
    id: 'tier2',
    name: '自查类断言',
    patterns: [
      /已(?:确认|通过|验证|检查|核对|复现)/,
      /(?:没有|无)问题/,
      /(?:全部|都)通过/,
      /测试通过|验证通过|检查通过/
    ]
  },
  {
    id: 'tier3',
    name: '归属类引用',
    patterns: [
      /据[^，。；\n]{1,14}(?:可知|显示|表明|记载|统计)/,
      /文档(?:里|中)?(?:说|写|提到|明确)/,
      /官方(?:说|规定|文档|说明)/,
      /研究(?:显示|表明|发现)/,
      /我记得你(?:之前|上次|以前)?(?:说过|提过|要求过)/,
      /按(?:照)?你说的/
    ]
  }
]

/** 对账块的固定标记。写成常量是为了检查器与提示词不会各说各话。 */
export const LEDGER_MARKER = '【对账】'

/**
 * 自指数字：指回对话自身的序号或条目（「第 9 条」「这 24 条」「那 10 个」）。
 *
 * 为什么要排除：对账的用途是让人能核对**关于世界的断言**（版本号、测量值、
 * 文件数、日期）。而「第 9 条」指的就是这场对话里的第 9 项，读者往上翻一眼
 * 就能核对，要求它再配一行【对账】是纯噪音。真实语料里这类占了 R02 命中的
 * 三分之一，噪音会让人把整个检查器关掉。
 * 注意只排除「序数 + 条目量词」这一种形态：「共 7 个源文件」「42 个工具」
 * 仍然是关于工程的断言，照样要求对账。
 */
const SELF_REF_BEFORE = /(?:第|这|那|上|下)\s{0,2}$/
const SELF_REF_UNIT = /(?:条|个|项|种|步|点|轮|层|档)\s*$/
const SELF_REF_INLINE = /(?:第\s*\d+\s*[条个项种步点轮层档]|[\d]+\s*[条个项])[、，和及]\s*\d+\s*[条个项种步点轮层档]/

function isSelfReference(body, m) {
  const before = body.slice(Math.max(0, m.index - 3), m.index)
  if (SELF_REF_BEFORE.test(before) && SELF_REF_UNIT.test(m[0])) return true
  // 「第 11 条、12 条」这种并列缩写，后半截没有序数词，靠前文判断。
  const head = body.slice(Math.max(0, m.index - 12), m.index + m[0].length)
  return SELF_REF_INLINE.test(head)
}

/**
 * 引号区间。用于判断某个命中是不是「被引用的说法」而不是「我的断言」。
 *
 * 真实语料教训：`能被抓到没查就报「已通过」` 里的「已通过」是在**描述**一种毛病，
 * 判它谎报是冤枉；而嵌套引号 `「……报「已通过」」` 让按引号配对的正则切错位置，
 * 于是只靠「引号前有转述动词」这一条拦不住。改成「命中点落在任何引号区间内就跳过」，
 * 对嵌套也成立。
 */
function quoteSpans(body) {
  const spans = []
  const stack = []
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch === '「' || ch === '“' || ch === '"') {
      stack.push(i)
    } else if (ch === '」' || ch === '”' || ch === '"') {
      const open = stack.pop()
      if (open !== undefined) spans.push([open, i + 1])
    }
  }
  return spans
}

function insideQuote(spans, index) {
  return spans.some(([a, b]) => index >= a && index < b)
}

/**
 * 找出文本命中的触发档。
 * @param {string} text
 * @param {'off'|'three'|'five'} level 档位；'five' 目前与 'three' 同命中集，
 *   区别在提示词里要求逐项列出而非合并（见 compileLedgerRules）。
 * @returns {{needed:boolean, hits:Array<{tier:string,name:string,excerpt:string}>}}
 */
export function detectLedgerTriggers(text, level = 'three') {
  const body = String(text ?? '')
  if (level === 'off' || body === '') return { needed: false, hits: [] }
  const spans = quoteSpans(body)
  const hits = []
  for (const tier of LEDGER_TIERS) {
    for (const re of tier.patterns) {
      const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
      let picked = null
      for (const m of body.matchAll(global)) {
        if (tier.id === 'tier1' && isSelfReference(body, m)) continue
        if (insideQuote(spans, m.index)) continue
        picked = m
        break // 同一档只需要一条有效命中
      }
      if (!picked) continue
      const start = Math.max(0, picked.index - 18)
      hits.push({
        tier: tier.id,
        name: tier.name,
        excerpt: body.slice(start, picked.index + picked[0].length + 18).replace(/\s+/g, ' ').trim()
      })
      break // 同一档命中一次就够：对账只需知道「这一档触发了」
    }
  }
  return { needed: hits.length > 0, hits }
}

/**
 * 对账块必须**独立成行**才算数。
 *
 * 早期版本用 `includes('【对账】')` 判断，结果被真实语料打脸：一句解释性文字
 * 「如果我下一条回答冒出 [dsh-anima 质检] 块…」或「我上一条没写【对账】块」
 * 里的三个字，就被当成了对账块存在，于是「明明没有块」被判成「有块但空」。
 * 判词方向对、理由错 —— 理由错了，用户就没法据此反驳。
 *
 * 第二版只认「行首到标记之间全是空格」，又被真实回答打脸：我自己把标记写成
 * `**【对账】**`（Markdown 加粗），于是每一次都判「没写对账块」——**模型被判
 * 谎报，而它明明写了**。这是最坏的一类误报：逼着人改写作习惯去迁就检查器。
 * 所以行首与行尾都允许 Markdown 装饰（`**` `__` `#` `>` `-`），但标记仍是
 * 该行唯一的实质内容 —— 句中提一句「【对账】」依旧不算。
 */
const LEDGER_DECOR = String.raw`(?:[*_#>]+[ \t]*){0,3}`
const LEDGER_BLOCK_START = new RegExp(
  String.raw`(?:^|\n)[ \t]*` + LEDGER_DECOR + String.raw`【对账】[ \t]*(?:[*_#]+[ \t]*)?(?=\r?\n|$)`
)
const LEDGER_BLOCK_START_G = new RegExp(LEDGER_BLOCK_START.source, 'g')

/**
 * 文本里是否真有一个独立成行的对账块。
 *
 * ⚠️ 必须用**不带 g 标志**的那份正则，不能图省事复用 LEDGER_BLOCK_START_G。
 *
 * 这里踩过一个线上真 bug：`/g` 正则的 `.test()` 会把 `lastIndex` 推进到匹配结束位置，
 * 下一次调用从那里继续找；而 LEDGER_BLOCK_START_G 是模块级共享对象，于是
 * **同一段文字连续判两次会得到相反答案** —— 第一次「有块」，第二次「没有」。
 *
 * 后果比普通误报严重：它让判词本身不确定。同一条回答，钩子这次说我谎报、下次
 * 说我没谎报，用户根本无法据此相信我或这个检查器。而这类 bug 极难被发现，
 * 因为单独测一次永远是绿的（lastIndex 初始为 0）。
 * 不带 g 的正则没有 lastIndex 状态，同一个输入永远给同一个答案。
 */
export function hasLedgerBlock(text) {
  return LEDGER_BLOCK_START.test(String(text ?? ''))
}

/**
 * 解析对账块里的「查了 / 未查」行。
 * 块头与行标签**都只认行首**，不认句中提及 —— 否则一句话里提到这几个字就能冒充整块。
 * 行首的列表符号与加粗同样剥掉，理由同上：格式不该决定判词。
 */
export function parseLedgerBlock(text) {
  const body = String(text ?? '')
  LEDGER_BLOCK_START_G.lastIndex = 0
  const matches = [...body.matchAll(LEDGER_BLOCK_START_G)]
  if (matches.length === 0) return null
  const last = matches[matches.length - 1]
  const at = last.index + (last[0].startsWith('\n') ? 1 : 0)
  const tail = body.slice(at)
  const checked = []
  const unchecked = []
  for (const raw of tail.split(/\r?\n/)) {
    // 与块头同一套理由：`- **查了**：…` 和 `查了：…` 是同一件事。
    const line = raw.replace(/^[\s*_#>+-]+/, '').replace(/[*_]+/g, '').trim()
    if (line.startsWith('查了') || line.startsWith('已查')) checked.push(line)
    else if (line.startsWith('未查') || line.startsWith('没查')) unchecked.push(line)
  }
  return { checked, unchecked, tail, empty: checked.length === 0 && unchecked.length === 0 }
}

// ==================== 检查器 ====================

/** 证据形态：链接、本地路径、反引号代码、文件行号引用、命令块。 */
const EVIDENCE_PATTERNS = [
  /https?:\/\//,
  /[A-Za-z]:\\[^\s]+/,
  /\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+/,
  /`[^`\n]{2,}`/,
  /:[0-9]{1,4}(?:-[0-9]{1,4})?/,
  /```/
]

const hasEvidence = (text) => EVIDENCE_PATTERNS.some((re) => re.test(text))

/**
 * 剥掉代码块与行内代码，只留正文。
 *
 * 为什么必须剥：真实语料里 40 条回答有 17 条被判「命中数字却没有对账块」，
 * 其中大量是因为 **dsh-ui 表格 / JSON / 命令输出里出现了日期和数字**
 * （`"2026-10-14"`、`86764 字节`、`PASSED all 144`）。那些是数据，不是断言，
 * 要求它们配对账是错的 —— 误报会让人把检查器整个关掉，比不查更糟。
 *
 * 代码块里的内容另有价值（往往是证据本身），所以 hasEvidence 用全文，
 * 只有「触发判定」和「自然语言断言判定」看剥过的正文。
 */
export function stripCodeBlocks(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
}

/**
 * 「提到」与「主张」的分界。
 *
 * 引号里、或紧跟「报/写/说/填/讲/称」这几种转述动词的短语，通常是在**谈论**
 * 某个说法，而不是在**做出**那个断言。真实语料里「能被抓到没查就报「已通过」」
 * 就是在描述这种毛病，判它谎报是冤枉。
 */
const MENTION_BEFORE = /(?:报|写|说|填|讲|称|标|打|看到|出现|写成|声称|给出|输出|返回|打印|显示|产生|拆成|变成|算作|归到)[^。\n]{0,6}$/

/** 引号前是顿号/举例词，引号后跟「这类/这种/等」—— 这是在**引用一个说法**，不是在用它。 */
const METALINGUISTIC_BEFORE = /(?:、|比如|例如|像|如|诸如)[^。\n]{0,6}$/
const METALINGUISTIC_AFTER = /^\s*(?:这类|这种|这一?类|等|之类|这种话|这类话|的说法|这句话|这[三四五]个字)/

/**
 * 这个引号片段是不是「元语言引用」——被当成一个说法/词条举出来，而非真的在用它。
 * 例：`带数字、日期、引用、「我记得你之前说过」这类话，就必须标来源`
 * 这里引号内容是一个**触发词的例子**，判它「引用用户却没出处」是冤枉。
 */
function isMetalinguistic(body, start, end) {
  const before = body.slice(Math.max(0, start - 12), start)
  const after = body.slice(end, end + 8)
  return METALINGUISTIC_BEFORE.test(before) || METALINGUISTIC_AFTER.test(after)
}

const QUOTED_SPAN = /[「“"'][^」”"']{1,40}[」”"']/g

/** 把「被提到」的片段从正文里挖掉，剩下的才算主张。 */
export function stripMentions(text) {
  const body = String(text ?? '')
  const out = []
  let cursor = 0
  for (const m of body.matchAll(QUOTED_SPAN)) {
    const gapStart = Math.max(cursor, m.index - 8)
    const before = body.slice(gapStart, m.index)
    // 引号前有转述动词，或属于元语言引用，都算「提到」而不是「主张」
    if (MENTION_BEFORE.test(before) || isMetalinguistic(body, m.index, m.index + m[0].length)) {
      out.push(body.slice(cursor, m.index))
      out.push(' ')
      cursor = m.index + m[0].length
    }
  }
  out.push(body.slice(cursor))
  return out.join('')
}

/** 套话词表：命中两个以上且可证伪断言不足时判为填充。 */
const FILLER_PATTERNS = [
  /希望(?:这些|以上|这个)/,
  /总的来说/,
  /综上所述/,
  /需要注意的是/,
  /值得一提的是/,
  /事实上[，,]/,
  /简单来说[，,]/,
  /换句话说[，,]/
]

/** 「假装有时间」的具体句式。 */
const FAKE_FUTURE_PATTERNS = [
  /我会(?:持续|一直)(?:关注|留意|跟进)/,
  /后续(?:我会)?(?:持续)?跟进/,
  /以后我会(?:注意|更小心|记住)/,
  /随时(?:提醒|告诉)(?:我|你)/,
  /我会一直记得/,
  /长期(?:关注|跟进)/
]

/** 越界自信的免责声明形态。 */
const FAMILIARITY_DECLARATIONS = [
  /我(?:熟|不熟|没做过|没用过|接触过|没实际用过|没验证过)/,
  /这个(?:我|领域)我?(?:不|没)?(?:熟|了解|接触)/,
  /超出我(?:的)?(?:能力|知识)范围/
]

/**
 * 把某个说法归到用户头上的说法。只有出现这一类词，R11 才有资格判——
 * 因为稻草人的定义是「把用户没说过的话算到他头上」，不是「用了引号」。
 * 真实语料里被误报的那个样本用的是「装好了但没通电」这种自造比喻，
 * 全文没有一个字在说这是用户讲的；判它就是冤枉。
 */
const USER_ATTRIBUTION = [
  /你(?:之前|上次|以前|刚才)?(?:说|讲|写|提|要求|定|拍板)(?:过)?/,
  /你(?:的)?原话/,
  /按(?:照)?你说的/,
  /你说的是/
]

/**
 * 紧贴引号前的归因：只有**动词直接贴着引号**（「你说「…」」「你的原话「…」」），
 * 才说明这个引号是被引用的那番话。
 *
 * 为什么必须收紧：真实语料里两条误报都是「你说的灵魂，拆开是两样：**一是…**」
 * 和「你要求的时候，我先把自己的结论拆成「哪些是事实…」」—— 句中确有「你说的」
 * 「你要求」，但那是在**谈论**用户，引号里的内容是**我自己的**展开，不是他的话。
 * 归因词出现在 40 字窗口内就算数，等于把「说」字当成了万能通行证。
 */
const ATTRIBUTION_ADJACENT = /(?:你(?:之前|上次|以前|刚才)?(?:说|讲|写|提)(?:过)?|你(?:的)?原话|按(?:照)?你说的|你说的是)[^。\n，,；;]{0,4}$/

/** 建议类动词 + 附近必须有具体的第三方工具名，才算「给工具建议」。 */
const TOOL_NAME_PATTERN = /[A-Za-z][A-Za-z0-9_.+-]{2,}/

/** 断言密度：能被证明错的句子占比。粗略但方向对。 */
function assertionDensity(text) {
  const sentences = String(text).split(/[。！？!?\n]+/).map((s) => s.trim()).filter((s) => s.length >= 6)
  if (sentences.length === 0) return { sentences: 0, assertions: 0, ratio: 0 }
  let assertions = 0
  for (const s of sentences) {
    // 含具体名词/数字/比较/因果的句子才算断言；纯感受句不算。
    if (/[0-9]|[A-Za-z]{3,}|因为|所以|导致|比|超过|必须|不能|会|是/.test(s)) assertions += 1
  }
  return { sentences: sentences.length, assertions, ratio: assertions / sentences.length }
}

/**
 * 对一个回答文本跑可机械判定的检查。
 *
 * 注意：返回的 findings 只覆盖能判的部分；`uncovered` 列出这次**没查**的规则 id。
 * 调用方必须把 uncovered 一起交出去，不许只报 findings 就说「通过」。
 *
 * @param {string} text 回答全文
 * @param {object} [options]
 * @param {'off'|'three'|'five'} [options.ledgerLevel] 对账档位，默认 'three'
 * @param {boolean} [options.strict] 严格模式：额外启用 R08 / R11 / R12（误报率高）
 * @returns {{findings:Array, uncovered:string[], checked:string[], meta:object}}
 */
/**
 * 质检入口。真正的判定在 `runChecks`，这一层只负责一件事：
 * **判据自己崩掉时不许冒充「没问题」**。
 *
 * 为什么值得单独一层：这个函数的返回值在下游被当成「检查结果」。如果某条正则
 * 因为正文里的异常字符抛错，栈会一路冒到 agent/pre-step 钩子，被外层 catch 掉，
 * 于是既没有提醒、计数器也没加 —— 表现和「查了、没事」一模一样。用户看到的是
 * 「一切正常」，真相是一次判定都没跑完。
 *
 * 现在崩掉会变成一条 R02（谎报检查结果）的 high finding，并带上原始错误文本。
 * 这样它至少会出现在报告里，而不是消失。
 *
 * @param {string} text
 * @param {{ledgerLevel?: 'off'|'three'|'five', strict?: boolean}} [options]
 */
export function checkResponse(text, options = {}) {
  try {
    return runChecks(text, options)
  } catch (err) {
    const message = err && err.message ? String(err.message) : String(err)
    // 取摘要必须**再包一层**：让 runChecks 崩掉的元凶，往往就是 `String(text)`
    // 本身（比如 text 是个 toString 会抛的对象）。第一版这里直接
    // `String(text ?? '').slice(0, 60)`，等于在异常处理里又踩了同一个坑 ——
    // 结果异常从 catch 里二次抛出，整个兜底形同虚设，是测试当场抓到的。
    let excerpt = ''
    try {
      excerpt = String(text ?? '').slice(0, 60)
    } catch {
      excerpt = `[无法转成文本的类型：${Object.prototype.toString.call(text)}]`
    }
    return {
      findings: [{
        ruleId: 'R02',
        name: QUALITY_RULES.find((r) => r.id === 'R02')?.name ?? 'R02',
        severity: 'high',
        detail: `质检器自己抛了异常，所以这次**一条判定都没完成**（不是「查了、没问题」）：${message}`,
        excerpt
      }],
      uncovered: UNCOVERABLE_RULES.slice(),
      checked: [],
      meta: { chars: 0, ledgerLevel: options.ledgerLevel ?? 'three', strict: options.strict === true, triggers: [], density: null },
      failed: true,
      error: message
    }
  }
}

function runChecks(text, options = {}) {
  const { ledgerLevel = 'three', strict = false } = options
  const body = String(text ?? '')
  const findings = []
  const checked = []

  // 三个视图，用途不同，混用就是误报的来源：
  //   body      —— 全文，用来找对账块、找证据形态（证据常在代码块里）
  //   prose     —— 剥掉代码块/行内代码后的正文，用来判断"有没有命中数字/自查断言"
  //   claimed   —— 再从 prose 里挖掉"被提到的说法"，剩下的才算我真的主张了它
  const prose = stripCodeBlocks(body)
  const claimed = stripMentions(prose)

  const push = (ruleId, detail, excerpt) => {
    const rule = QUALITY_RULES.find((r) => r.id === ruleId)
    findings.push({ ruleId, name: rule?.name ?? ruleId, severity: 'high', detail, excerpt })
  }

  // —— 对账：触发即要求块存在 ——
  // 触发只看 claimed：正文里列出数据（表格/清单）不算主张，不必配对账。
  const triggers = detectLedgerTriggers(claimed, ledgerLevel)
  checked.push('R01', 'R02')
  if (triggers.needed) {
    const block = parseLedgerBlock(body)
    if (!block) {
      const tiers = [...new Set(triggers.hits.map((h) => h.name))].join('、')
      push('R02', `命中对账触发档（${tiers}）却没有【对账】块`, triggers.hits[0].excerpt)
    } else if (block.empty) {
      push('R02', '有【对账】标记但既没写查了什么也没写未查什么', LEDGER_MARKER)
    } else {
      // 有块就继续看内容形态：只写「已检查，无异常」等于没查。
      //
      // 注意一个刻意的放行：只写「未查：…」而不写「查了：…」是**合法**的。
      // 用户定的规则是「允许未查占多数」——逼着每轮都查一点，结果只会是
      // 编出假动作来填这一行。宁可承认没查，也不要凑数。
      const all = [...block.checked, ...block.unchecked].join('\n')
      if (/已(?:检查|核对)[，,]?\s*(?:无异常|无问题|全部正常)/.test(all)) {
        push('R02', '对账块里出现「已检查，无异常」这类无证据结论', all.slice(0, 60))
      }
    }
  }

  // —— R01：归属类断言必须带证据形态 ——
  // 归属判定看 claimed（被别人提到、或写在代码里的不算我的主张），
  // 证据形态看 body（证据本身常常就长在代码块里）。
  const tier3 = LEDGER_TIERS.find((t) => t.id === 'tier3')
  let attributionHit = null
  for (const re of tier3.patterns) {
    const m = re.exec(claimed)
    if (m) { attributionHit = m; break }
  }
  if (attributionHit && !hasEvidence(body)) {
    push('R01', '出现归属类引用，但全文没有任何可核对的证据形态（链接 / 路径 / 行号 / 命令）',
      claimed.slice(Math.max(0, attributionHit.index - 15), attributionHit.index + 40))
  }

  // —— R09：无机制支撑的承诺 ——
  // 看 claimed：讨论「以后我会注意」这种句式时，那是在**举例子**，不是真在承诺。
  checked.push('R09')
  for (const re of FAKE_FUTURE_PATTERNS) {
    const m = re.exec(claimed)
    if (m) {
      push('R09', '承诺了本轮之后才生效的事，但没有任何机制会执行它', m[0])
    }
  }

  // —— R04：套话填充 ——
  checked.push('R04')
  const fillerHits = FILLER_PATTERNS.filter((re) => re.test(prose)).length
  const density = assertionDensity(prose)
  if (fillerHits >= 2 && density.ratio < 0.7) {
    push('R04', `套话句式 ${fillerHits} 处、可证伪断言占比 ${(density.ratio * 100).toFixed(0)}%（低于 70%）`,
      `共 ${density.sentences} 句，其中 ${density.assertions} 句可被证明错`)
  }

  if (strict) {
    checked.push('R08', 'R11', 'R12')
    // R08：含糊词紧跟精确数字，说明把握程度与精度不匹配。
    const mismatch = /(?:大概|可能|应该|估计|印象里)[^。\n]{0,12}\d+(?:\.\d+)?\s*(?:%|％)/.exec(prose)
    if (mismatch) push('R08', '用含糊词修饰一个精确数字：精度与把握程度不匹配', mismatch[0])

    // R11：引号里的话必须带**可核对**的出处。
    // 三个前提缺一不可：
    //   (a) 这句话被归到用户头上（USER_ATTRIBUTION）—— 否则只是我在打比方；
    //   (b) **不是假设句**（「如果哪天你说…」「比如你说…」都是在设想，不是在引用）；
    //   (c) 有可核对的出处（消息编号，或「原话/原句」+位置词）。
    // 真实语料教训：40 条里 10 条被 R11 判到，几乎全是「如果哪天你说「…」」这类假设句。
    //
    // 这里有一次真实的 bug 修复：早期版本用 `near = prose.slice(index - 40, index + 引文长度)`
    // 做判断，窗口**跨过了引文本身**，于是「如果哪天你说「现在它有灵魂了」」里
    // 「哪天你说」被引文自己顶出了窗口，假设句判不出来；而引文里含「你说过」
    // 三个字时又会反过来把 (a) 条件喂成 true（自己在给自己作证）。
    // 现在归因与假设句都只看引号**之前**的 40 字，引文本身不参与任何判断。
    const quoteRe = /[「“"]([^」”"]{6,40})[」”"]/g
    for (const quoted of prose.matchAll(quoteRe)) {
      const head = prose.slice(Math.max(0, quoted.index - 40), quoted.index)
      // 元语言引用（举例子说明一个说法）不是稻草人。
      if (isMetalinguistic(prose, quoted.index, quoted.index + quoted[0].length)) continue
      // 归因必须**紧贴引号**：句中远处出现过「你说的」不算。
      if (!ATTRIBUTION_ADJACENT.test(head)) continue
      const hypothetical = /(?:如果|假如|万一|要是|假设|比如|例如|好比|类似|哪天|那种|这种)[^。\n]{0,10}$/.test(head)
      if (hypothetical) continue
      const hasRef = /m\d{5}/.test(prose)
      const hasOriginalMark = /(?:原话|原句)/.test(prose)
        && /(?:第\s*\d+|上文|上一轮|前面|之前那[条轮]|刚才)/.test(prose)
      if (!hasRef && !hasOriginalMark) {
        push('R11', `引用了「${quoted[1].slice(0, 20)}…」算作你的话，但没有可核对的出处（消息编号 / 原话+位置）`, quoted[0])
        break
      }
    }

    // R12：给**第三方工具**建议却不声明熟悉程度。
    // 两个收紧：
    //   (a) 建议动词后面附近必须出现具体工具/产品名（这个语料里被误报的
    //       「第一种（推荐，完全不依赖我的诚实）」推荐的是我自己的做法，不是工具）；
    //   (b) 排除「推荐你重启 / 建议先备份」这类动作建议 —— 那不是能力边界的宣称。
    const suggestRe = /(?:推荐|建议(?:用|使用|上)|可以用|就用)/g
    for (const sm of prose.matchAll(suggestRe)) {
      const window = prose.slice(sm.index, sm.index + 60)
      if (!TOOL_NAME_PATTERN.test(window)) continue
      // 排除纯动作建议
      if (/(?:重启|备份|先跑|先看|先读|先查|先做|删掉|保留)/.test(window)) continue
      if (FAMILIARITY_DECLARATIONS.some((re) => re.test(prose))) break
      push('R12', `推荐了具体工具（「${window.slice(0, 24)}…」）但没说清自己对这些东西熟不熟`, window.slice(0, 40))
      break
    }
  }

  const uncovered = QUALITY_RULES
    .filter((r) => !checked.includes(r.id))
    .map((r) => r.id)

  return {
    findings,
    uncovered,
    checked,
    meta: {
      chars: body.length,
      ledgerLevel,
      strict,
      triggers: triggers.hits,
      density
    }
  }
}

// ==================== 提示词文本 ====================

/**
 * 对账规则段。
 *
 * 措辞上刻意允许「未查占多数」：如果规则只在查了的时候才要求写，模型就会
 * 倾向于把没查的说成查了 —— 那正好是要防的东西。
 *
 * @param {'off'|'three'|'five'} level
 * @returns {string} level='off' 时返回 ''
 */
export function compileLedgerRules(level = 'three') {
  if (level === 'off') return ''
  const tiers = LEDGER_TIERS.map((t, i) => `${i + 1}. ${t.name}`).join('\n')
  const verbose = level === 'five'
  return [
    '## 对账（本条优先于其它风格要求）',
    '只要回答里出现下面三类形状之一，就必须在回答末尾追加一个【对账】块，写清查了什么、没查什么：',
    tiers,
    '',
    '格式固定为三行以内：',
    '```text',
    '【对账】',
    '查了：<具体做了什么> → <命令 / 文件:行号 / 链接>',
    '未查：<这次没做但读者可能以为做了的>',
    '```',
    '',
    '四条硬约束：',
    '- 「未查」那行不能省。允许未查占多数 —— 没查就直说，比补一句结论安全。',
    '- 禁止写「已检查，无异常」「全部通过」这类只有结论没有痕迹的话。',
    '- 这不是免责声明，也不是甩锅：它是给下次的自己和你留下的可反查记录。',
    verbose
      ? '- 五档模式下不得把多类合成一行：每一类各写一行，哪怕内容重复。'
      : '- 同一件事不用重复写，合并成一行即可。'
  ].join('\n')
}

/** 十二条质检规则段：只在提示词里给行为约束，不给检查结论。 */
export function compileQualityRules() {
  const lines = ['## 十二条（用户定的判据，不是建议）']
  for (const rule of QUALITY_RULES) {
    lines.push(`- ${rule.id} ${rule.name}：${rule.shape}。${rule.fix}。`)
  }
  lines.push('')
  // 这里必须由 UNCOVERABLE_RULES 现算，不能抄一份字面量。
  // 踩过的坑：这句话曾经写死成「R03 / R05 / R06 / R07」四条，而 UNCOVERABLE_RULES
  // 按 catchMode==='human' 实际算出五条（多一个 R10）。于是模型读到的提示词说四条判不了，
  // 质检器却按五条扣它 —— 两边对同一条规则的身份意见不一致，而谁都没报错。
  // 写死的那一刻，这句话就不再描述代码，只描述某天的那次编辑。
  lines.push(`其中 ${UNCOVERABLE_RULES.join(' / ')} 机器判不了，只能由人看；`
    + '不要声称自己「通过了十二条」。')
  return lines.join('\n')
}
