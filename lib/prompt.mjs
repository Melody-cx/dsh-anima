// lib/prompt.mjs — 提示词组装（纯函数，无外部依赖）
//
// 分段结构对照 WorkBuddy「个性化」页的两处文本区（角色 / 沟通风格），并覆盖 dsh-soul
// 的四段式功能面（角色设定 / 用户背景 / 回复风格 / 执行规则）—— 文案与切分全部自写。
//
// 三条必须守住的语义边界：
//   ① 「助手身份」段描述的是**你自己**（AI），不是对话参与者；
//   ② 「用户背景」段反过来描述**用户本人**，必须带反向声明，防止模型把两者搞混；
//   ③ 「行动准则」段是**恒常施加**的（只要插件开着就注入），描述的是「这段配置该怎么被
//      执行」而不是「你是谁」，因此即使用户一个字段都没填也有意义 —— 那正是最需要
//      说明「没有额外设定，按你自己的默认方式工作」的情形。
// 这三条在 dsh-soul 里只有第 ② 条，第 ①③ 条是本插件补上的缺口。

// ==================== 固定文案 ====================

/** 助手身份段抬头：声明这段说的是 AI 自己，防止与用户背景段混淆。 */
const IDENTITY_HEADER = [
  '以下设定描述的是**你自己**（助手）的身份，不是对话参与者的身份。',
  '不要把用户的职业、技术背景或自述当成你自己的设定；也不要把这里的名字当成对用户的称呼。'
].join('')

/** 用户背景段抬头：与 IDENTITY_HEADER 方向相反，逐字保留 dsh-soul 的告诫语义。 */
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
 * @param {Array<{id:string,text:string,capturedAt?:string,layer?:string}>} memories
 *   已按重要性/时间排序、已截断到预算
 * @returns {string} 空数组返回 ''
 */
export function compileMemory(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return ''
  const rows = []
  for (const item of memories) {
    const body = text(item?.text)
    if (body) rows.push({ body, layer: item?.layer === 'workspace' ? 'workspace' : 'global' })
  }
  if (rows.length === 0) return ''

  const header = [
    '## 长期记忆（已由用户采纳）',
    '以下内容来自过去对话的沉淀，并已由用户本人确认采纳。作为背景参考，不要逐条复述。'
  ]
  const scoped = rows.some((r) => r.layer === 'workspace')
  if (!scoped) {
    return [...header, ...rows.map((r) => `- ${r.body}`)].join('\n')
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
  return lines.join('\n')
}

/** 组装待审提示（只在有候选时出现，提示模型不要擅自当作事实）。 */
export function compilePendingNotice(count) {
  if (!count || count <= 0) return ''
  return [
    '## 待审记忆',
    `当前有 ${count} 条候选记忆等待用户裁决，尚未生效。`,
    '不要把它们当作已确认的事实使用；用户会在设置页里决定采纳或丢弃。'
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

/** 两级来源的可读标注，用于预览与调试。 */
export function describeSources(sources) {
  const label = { global: '全局', workspace: '本工作区' }
  return Object.entries(sources ?? {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${label[v] ?? v}`)
    .join('，')
}
