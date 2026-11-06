// lib/prompt.mjs — 提示词组装（纯函数，无外部依赖）
//
// 分段结构对照某产品「个性化」页的两处文本区（角色 / 沟通风格），并覆盖某同类人设插件
// 的四段式功能面（角色设定 / 用户背景 / 回复风格 / 执行规则）—— 文案与切分全部自写。
//
// 三条必须守住的语义边界：
//   ① 「助手身份」段描述的是**你自己**（AI），不是对话参与者；
//   ② 「用户背景」段反过来描述**用户本人**，必须带反向声明，防止模型把两者搞混；
//   ③ 「行动准则」段是**恒常施加**的（只要插件开着就注入），描述的是「这段配置该怎么被
//      执行」而不是「你是谁」，因此即使用户一个字段都没填也有意义 —— 那正是最需要
//      说明「没有额外设定，按你自己的默认方式工作」的情形。
// 这三条在某同类人设插件里只有第 ② 条，第 ①③ 条是本插件补上的缺口。

// ==================== 固定文案 ====================

/** 助手身份段抬头：声明这段说的是 AI 自己，防止与用户背景段混淆。 */
const IDENTITY_HEADER = [
  '以下设定描述的是**你自己**（助手）的身份，不是对话参与者的身份。',
  '不要把用户的职业、技术背景或自述当成你自己的设定；也不要把这里的名字当成对用户的称呼。'
].join('')

/** 用户背景段抬头：与 IDENTITY_HEADER 方向相反，逐字保留某同类人设插件的告诫语义。 */
const PROFILE_HEADER = [
  '以下信息描述的是与你对话的用户本人，不是你的身份；',
  '不要把用户的职业、技术背景或自述当成你自己的设定。'
].join('')

// 注意：本模块**刻意不 import lib/wording.mjs**。v3 起六个风格字段存的就是文案本身，
// 这里只负责渲染，不需要（也不该）再做一次「键 → 文案」的翻译。翻译只发生在配置层的
// 迁移与设置页的「一键填入」两处，都在 wording.mjs 的消费者名单里。

// ==================== 分段组装 ====================

const text = (v) => (typeof v === 'string' ? v.trim() : '')

/**
 * 追加一个条目，并把值里的换行渲染成**同一项的续行**。
 *
 * 为什么不能直接 `- 标签：${value}`：v3 起这些字段是自由文本，用户完全可能写两行
 * ——「专业严谨；讨论架构时例外」这种带条件的说明很常见。若原样拼进去，第二行会变成
 * 一个没有前缀的裸行，在 Markdown 里看起来像另一条规定，而它其实是上一句的延续。
 * 续行缩进两个空格，渲染层与模型都会把它读作同一个条目。
 */
function pushBullet(lines, label, value) {
  const parts = value.split('\n').map((line) => line.trim()).filter(Boolean)
  if (parts.length === 0) return
  lines.push(`- ${label}${parts[0]}`)
  for (const line of parts.slice(1)) lines.push(`  ${line}`)
}

/**
 * 助手自身身份段。
 * @returns {string} 无 agentName 且无 agentRole 时返回 ''（不产生空 section）
 */
export function compileIdentity(persona) {
  const name = text(persona?.agentName)
  const role = text(persona?.agentRole)
  if (!name && !role) return ''

  const lines = ['## 助手身份', IDENTITY_HEADER, '']
  if (name) lines.push(`- 你的名字：${name}（这是你自己的名字，不是用户的名字）`)
  if (role) lines.push(`- 你的角色设定：${role}`)
  return lines.join('\n').trim()
}

/**
 * 用户背景段：称呼、职业、介绍。
 * @returns {string} 三个字段全空时返回 ''
 */
export function compileUserProfile(persona) {
  const address = text(persona?.addressUserAs)
  const occupation = text(persona?.userOccupation)
  const bio = text(persona?.userBio)
  if (!address && !occupation && !bio) return ''

  const lines = ['## 用户背景', PROFILE_HEADER, '']
  if (address) lines.push(`- 你对用户的称呼：${address}`)
  if (occupation) lines.push(`- 用户的职业：${occupation}`)
  if (bio) lines.push(`- 关于用户：${bio}`)
  return lines.join('\n').trim()
}

/**
 * 回复风格段：风格 + 三项特质微调 + 长度 + 语言。
 *
 * v3 起这六个字段是**自由文本**（用户自己写的一句话），不再是档位键。
 * 于是本函数不再查表：写什么就注入什么。旧的档位键由 lib/config.mjs 的迁移路径
 * 翻译成同一句话，因此升级后的提示词逐字不变 —— 由 lib/wording.mjs 保证。
 *
 * 六个字段在配置层都有默认值（也是文案），故本段只要 enabled 就非空 —— 这是刻意的：
 * 风格是「怎么说」的默认约定，没有它模型就退回到通用语气。
 *
 * @returns {string}
 */
export function compileStyle(persona) {
  const lines = ['## 回复风格']

  const style = text(persona?.style)
  if (style) pushBullet(lines, '风格与语调：', style)

  for (const key of ['headingLists', 'emoji', 'tables']) {
    const trait = text(persona?.[key])
    if (trait) pushBullet(lines, '', trait)
  }

  const length = text(persona?.replyLength)
  if (length) pushBullet(lines, '回复长度：', length)

  const language = text(persona?.language)
  if (language) pushBullet(lines, '语言：', language)

  return lines.length > 1 ? lines.join('\n') : ''
}

/**
 * 补充指令段（自由文本）。
 * @returns {string} 为空时返回 ''
 */
export function compileInstructions(persona) {
  const body = text(persona?.customInstructions)
  if (!body) return ''
  return ['## 补充指令', body].join('\n')
}

/**
 * 行动准则段：**恒常施加**的收尾声明，说明上面那几段设定该怎么被执行。
 *
 * 为什么单独成段而不是把要求混进各段：设定是「是什么」（名字、背景、语气），准则
 * 是「怎么用」（持续生效、没覆盖到时怎么办、与当前指令冲突时谁优先）。后者对模型
 * 的价值与用户填了什么无关，所以只要插件是开着的就该出现 —— 一个什么都没配的人
 * 同样需要知道「没设定不等于不能正常干活」。
 *
 * 措辞刻意避开威慑式表述（例如「违反即视为失败」）：那类句子在长对话里会被稀释成
 * 噪声，真正起作用的是一句可判定的行为规则。下面四条都能对照具体行为检查。
 *
 * @returns {string} 永不返回 ''（调用边界由 index.mjs 的 enabled 判定负责）
 */
export function compileRules() {
  return [
    '## 行动准则',
    '上面的设定是你的长期配置而不是一次性任务说明：它对你的每条回复都生效，直到用户改掉它。',
    '具体怎么用，按这四条：',
    '- 相关才用：设定没覆盖到的地方按你原本的方式工作，不要为了「用上设定」而牵强附会。',
    '- 背景是背景：用户背景只用来决定内容的取舍与详略，不是你的经历；也不要把它复述给用户听。',
    '- 当前要求优先：某条设定与用户在这一轮对话里明说出的要求冲突时，以当前要求为准，并在必要时说清你改了什么。',
    '- 不必交代配置：没有额外设定时照常回答，不必说明「当前无设定」或复述本段内容。'
  ].join('\n')
}

/**
 * 人设总装：把五段按固定顺序拼成一段提示词。
 * 调用方（index.mjs）把它整段交给 `anima:identity` 一个 section —— 身份、用户背景、
 * 风格、自定义指令、行动准则之间的顺序因此在这里定死，它们是一份文本的五个部分，
 * 分开注册反而会让「以上」这类指代悬空。
 *
 * 行动准则排在最后：它是对前四段的元层声明（「以上怎么执行」），放在前面会让
 * 「以上」指向空处。
 *
 * @returns {string} 五段拼接结果，空段自动跳过
 */
export function compilePersona(persona) {
  const parts = [
    compileIdentity(persona),
    compileUserProfile(persona),
    compileStyle(persona),
    compileInstructions(persona),
    compileRules()
  ].filter(Boolean)
  return parts.join('\n\n')
}

// ==================== 记忆段 ====================

/**
 * 组装已采纳的长期记忆段。
 *
 * 分层渲染：只要出现**至少一条**工作区记忆，就分成「全局」与「本工作区」两组，
 * 并各自标注适用范围。理由是模型需要知道自己拿到的东西**管多宽** ——
 * 「这个项目用 pnpm」与「用户偏好中文」的可迁移性完全不同，混在一段里
 * 模型会把项目习惯当成用户习惯往外推。
 *
 * 全是全局记忆（含存量无 layer 的记录）时保持单段形态：多一个标题
 * 只是噪声，不增加信息。
 *
 * @param {Array<{id:string,text:string,capturedAt?:string,layer?:string,line?:string}>} memories
 *   已按重要性/时间排序、已截断到预算
 * @param {{count?:number,maxCount?:number,maxChars?:number}} [omission]
 *   因预算被挤掉的条数（见 summarizeOmission / compileOmissionNotice）。
 *   不传时行为与旧版完全一致 —— 设置页预览等只关心渲染的调用方不必关心它。
 * @returns {string} 空数组返回 ''
 */
export function compileMemory(memories, omission = null) {
  const notice = compileOmissionNotice(omission)
  // 空数组通常意味着「一条都没记住」，此时整段不注入是对的（不产生空 section）。
  //
  // 但有一个例外：**有记忆、只是全被预算挤掉了**。那种情况下返回 '' 恰恰制造了
  // 本改动要消除的那种沉默 —— 模型看到的是「没有任何记忆」，而真相是
  // 「有 N 条，但这轮放不下」。所以此处只保留那句说明，不带标题。
  if (!Array.isArray(memories) || memories.length === 0) return notice
  const rows = []
  // 单条渲染失败不能让整段记忆消失，也不能让缺的那条看起来像不存在。
  //
  // 注意失败的真实形态：`text()` 是类型闸（非字符串一律返回 ''），所以脏数据
  // 不会抛异常 —— 它会**安静地变成空串**然后被过滤掉。这条路径比抛异常更危险，
  // 因为没有栈、没有日志，模型读到的只是一段少了几行的记忆。
  // 所以这里判定的是「字段类型不对」，不是「抛没抛错」。
  // 原写法 `item.line != null` 是「非 null 且非 undefined」的并集；
  // 改成严格相等时要把两种都写出来，否则 undefined 会被当成「字段存在」而误判 malformed。
  const isPresent = (value) => value !== null && value !== undefined
  let skipped = 0
  for (const item of memories) {
    if (!item || typeof item !== 'object') { skipped += 1; continue }
    const malformed = (isPresent(item.line) && typeof item.line !== 'string')
      || (isPresent(item.text) && typeof item.text !== 'string')
    // 优先用 selectForInjection 渲染好的 `line`（带状态与日期标签），
    // 没有时才退回原文 —— 设置页预览走的就是没有 line 的那条路径，
    // 若这里强制要求 line，预览会整段变成空白。
    const body = text(item.line) || text(item.text)
    if (body) rows.push({ body, layer: item.layer === 'workspace' ? 'workspace' : 'global' })
    else if (malformed) skipped += 1
  }
  if (rows.length === 0 && skipped === 0) return ''
  if (rows.length === 0 && skipped > 0) {
    // 全部渲染失败：这种情况比「没有记忆」更糟，必须说出来。
    return [`## 长期记忆（渲染失败）`,
      `有 ${skipped} 条已采纳记忆，但它们的内容字段不是文本（类型不对），所以这一轮**一条都没能读到**。`,
      `这不是「没有记忆」，是存储里有形状不对的数据 —— 别把它当成「用户没告诉过你」。`].join('\n')
  }

  const header = [
    '## 长期记忆（已由用户采纳）',
    '以下内容来自过去对话的沉淀，并已由用户本人确认采纳。作为背景参考，不要逐条复述。',
    // 这一句是记忆层与质检层的接缝：模型很容易把「记忆里有」当成「现在仍成立」。
    // 标签只在需要时出现（曾如此 / 有争议 / 可能已过时），所以不占用无标签条目的篇幅。
    '行尾标签说明：「曾如此」= 用户后来改过主意，是历史不是现状；「有争议」= 与后来的事实冲突且尚未裁决；日期 = 写入日期；「可能已过时」= 过了复核点，用前先问一句。'
  ]
  // 部分失败：正文照常给，末尾加一行说明少了几条。不给这一行的话，模型会拿
  // 「只读到 7 条」当「只有 7 条」，而漏掉的那几条它永远不知道自己漏了。
  const partialNote = skipped > 0
    ? `※ 另有 ${skipped} 条已采纳记忆渲染失败，这一轮没读到 —— 是数据的形状不对，不是它们被删了。`
    : ''
  const scoped = rows.some((r) => r.layer === 'workspace')
  if (!scoped) {
    const flat = [...header, ...rows.map((r) => `- ${r.body}`)]
    if (partialNote) flat.push('', partialNote)
    if (notice) flat.push('', notice)
    return flat.join('\n')
  }

  const lines = [...header]
  const globalRows = rows.filter((r) => r.layer === 'global')
  const localRows = rows.filter((r) => r.layer === 'workspace')
  if (globalRows.length > 0) {
    lines.push('', '### 全局（处处适用）')
    for (const r of globalRows) lines.push(`- ${r.body}`)
  }
  if (localRows.length > 0) {
    lines.push('', '### 本工作区（只在当前项目适用，不要外推到其他项目）')
    for (const r of localRows) lines.push(`- ${r.body}`)
  }
  if (partialNote) lines.push('', partialNote)
  if (notice) lines.push('', notice)
  return lines.join('\n')
}

/**
 * 预算没放下的条目，要在注入文本里留一句话。
 *
 * 为什么必须写进提示词，而不是只留在设置页：模型看不到设置页。它唯一能观察到的
 * 「事实」就是这段文字 —— 少了这句，它会把自己**没看到**的记忆当成**不存在**的，
 * 于是拿残缺的背景去推理，而错的这一部分永远不会出现在任何日志里。
 *
 * 为什么只报条数不报内容：报内容等于用隐蔽的方式绕过用户设的预算，那预算就不算数了。
 *
 * @param {{count?:number,maxCount?:number,maxChars?:number}} omission
 * @returns {string} 没有省略时返回 ''
 */
export function compileOmissionNotice(omission) {
  const count = Number(omission?.count) || 0
  if (count <= 0) return ''
  const limits = []
  if (Number(omission?.maxCount) > 0) limits.push(`${omission.maxCount} 条`)
  if (Number(omission?.maxChars) > 0) limits.push(`${omission.maxChars} 字`)
  const where = limits.length > 0 ? `（上限：${limits.join(' / ')}）` : ''
  return `另有 ${count} 条已采纳记忆因预算未注入${where}；它们没出现在这里不代表没记过，需要时请直接问用户，不要凭印象推断。`
}

/** 组装待审提示（只在有候选时出现，提示模型不要擅自当作事实）。 */export function compilePendingNotice(count) {
  if (!count || count <= 0) return ''
  return [
    '## 待审记忆',
    `当前有 ${count} 条候选记忆等待用户裁决，尚未生效。`,
    '不要把它们当作已确认的事实使用；用户会在设置页里决定采纳或丢弃。'
  ].join('\n')
}

/**
 * remember 工具的行为指引段。
 *
 * 为什么这段必须存在：`remember` 是一个**没有提示词引导就基本不会被调用**的工具。
 * 模型只看得见工具的名字和描述，而描述里只能写「干什么」，写不下「什么时候该干、
 * 什么时候不该干」。结果是记忆层建好了、缓冲区和裁决界面都在，却长期是 0 条 ——
 * 实测 `anima.json` 的 `memories` 表就是 0 条。工具没坏，是没有人告诉模型该用它。
 *
 * 三件必须讲清楚的事，缺一件就会退化成「记了一堆废话」：
 *   ① 什么值得记 —— 给**判据**而不是形容词。「重要」这个词对模型没有约束力，
 *      「下次没有它会导致我答错」有。
 *   ② 什么不值得记 —— 这一半比上一半更重要。模型的默认倾向是能记就记，
 *      而记错的代价是不可逆的：用户得逐条去删。宁可漏记，不可滥记。
 *   ③ 投递 ≠ 生效 —— 不说这句，模型会以为记完就生效，于是对用户宣称
 *      「我记住了」。那是谎报，而且是用户最难察觉的一种。
 *
 * 还有一个只能在提示词里说的前提：**模型唯一可靠的记忆来源是用户说过的话**。
 * 它可以顺手把「从代码里读出来的事实」记下来，但要标注成推断，否则三个月后
 * 那条记忆会被当成用户的需求。
 *
 * @returns {string} 永不返回 ''（由调用方决定要不要注册这一段）
 */
export function compileRememberGuide() {
  return [
    '## 记忆：什么时候该用 remember 工具',
    '',
    '你有一个 `remember` 工具，用来把值得长期保留的信息投递到待审缓冲区。',
    '**投递不等于生效**：内容要等用户在设置页里采纳之后才进入长期记忆。所以永远不要说「我记住了」，',
    '只能说「我记下了，等你确认」。',
    '',
    '### 该记的（满足任意一条即可提名）',
    '- 用户明确说出的稳定偏好或禁忌：「以后别用表格」「不要叫我老师」「回答先给结论」。',
    '- 长期约束：技术栈、必须支持的版本、不能引入的依赖、所在时区。',
    '- 会影响后续判断的背景：职业、研究方向、正在做的项目及其目标。',
    '- 用户明确要求你记住的事 —— 这类**必须**记，哪怕你觉得琐碎。',
    '',
    '### 不该记的（这一半更重要）',
    '- 临时任务状态：「这轮先改 A 文件」「等会儿再跑测试」。任务会结束，记忆不会。',
    '- 寒暄、情绪、玩笑话。',
    '- 能从代码或文件里直接读出来的东西：函数名、行号、目录结构。它们在原地，比记忆里更新。',
    '- 你自己推断出的结论。推断进了记忆，三个月后就会被当成用户的需求。',
    '- 任何密钥、令牌、密码。',
    '',
    '### 记的时候要带的字段',
    '- `type`：fact〔事实，改了才覆盖〕/ preference〔偏好，半衰期很长〕/ stance〔立场，改主意时归档成「曾如此」〕/ event〔事件，永不失效但会归档〕。四者的失效方式不同，选错会让它在该过期的时候不过期。',
    '- `sourceRef`：凭什么记这条 —— 消息编号、文件:行号、URL。**没有来源的记忆日后无法核对真假**，写不出就留空，不要编。',
    '- `verifyAt`：只给**状态类**记忆设复核点（「最近在焦虑什么」）。事实类（职业、技术栈）不要设 —— 它们不会因为时间过去就变假。',
    '',
    '宁可漏记，不可滥记：漏记只是这次没帮上，滥记要用户逐条去删。'
  ].join('\n')
}

/**
 * 关闭态声明：用户把本插件关掉时注入的唯一一句话。
 *
 * 为什么「关掉」也要说一句，而不是安静地什么都不注入：会话是有历史的。
 * 用户中途关掉配置后，之前那些设定仍留在**对话记录**里，模型会继续照着做 ——
 * 它没有别的办法知道那些设定已经作废。空注入表达不出「已撤销」，只有一句
 * 明说才能让模型停止沿用旧设定。
 *
 * 措辞避免指定「默认语气是什么」（那是部署层的决定，不归本插件管），
 * 只说清「不再适用」这件事。
 *
 * @returns {string} 永不返回 ''
 */
export function compileDisabledNotice() {
  return [
    '## 助手人格设定已关闭',
    '用户已关闭助手人格配置，之前若给过你名字、称呼、语气或补充指令，那些**一律不再适用**。',
    '按你本来的方式回答，不必提示本插件的存在。'
  ].join('\n')
}

/**
 * 把一段渲染包成「绝不会抛」的。
 *
 * 为什么这是必需的，而不是防御性编程的洁癖：
 * 宿主 `assemble()` 里 `sections.map(...)` 没有 try/catch，`renderPrompt()` 也没有。
 * **我们的 text 函数抛一次，整轮请求就起不来** —— 不是「这段没注入」，
 * 是这个回合直接失败，用户看到的是「发不出去」。
 *
 * 同生态的某个记忆插件在它自己的注释里把这一点讲得最直白：渲染必须同步、绝不抛，
 * 因为装配失败会把整个回合一起带走。我们 `lib/prompt.mjs` 与 `lib/memory.mjs`
 * 在此之前是**零个 try**。
 *
 * 降级策略是「不注入」，不是「注入半份」：半份人设比没有人设更糟，
 * 模型会拿残缺的设定当真。所以失败一律返回 ''，把问题留给日志。
 *
 * 放在 lib 层而不是 index.mjs，是为了能被 verify-core 直接 import 测到 ——
 * 写在 index.mjs 里的函数只能靠读源码字符串断言，那测的是拼写不是行为。
 *
 * @param {string} label 出问题时日志里显示是哪一段
 * @param {() => string} render 真正的渲染逻辑
 * @param {(message: string) => void} [onError] 失败时的回调（宿主 logger 等）
 * @returns {string} 成功时是渲染结果，失败或类型不对时是 ''
 */
export function safeSection(label, render, onError) {
  try {
    const text = render()
    // 宿主 renderPrompt 会 .join('\n\n') 再 .length，返回 undefined 会炸在更远的地方，
    // 那里没有我们的 try 罩着。所以在出口把类型也收一下。
    return typeof text === 'string' ? text : ''
  } catch (err) {
    try {
      onError?.(`渲染 ${label} 段失败，本段降级为不注入：${String(err?.message || err)}`)
    } catch {
      // 连日志都写失败就算了：绝不让「报错的代码」把「降级」也带走。
    }
    return ''
  }
}

/** 两级来源的可读标注，用于预览与调试。 */
export function describeSources(sources) {
  const label = { global: '全局', workspace: '本工作区' }
  return Object.entries(sources ?? {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${label[v] ?? v}`)
    .join('，')
}
