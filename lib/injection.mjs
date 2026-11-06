// lib/injection.mjs — 会话注入消息的 source 构造（纯函数，仅依赖 node 内建）
//
// 为什么必须自持 kind（与某同类人设插件的行为对齐：同样自持 kind，但名字取本包自己的）：
// 会话格式 v4 的来源准入明确拒绝共享的 `kind: 'plugin'`：
//
//   if (typeof value.kind !== 'string' || value.kind.length === 0 || value.kind === 'plugin')
//     throw new SessionFormatError('format v4 message requires a producer-owned source kind')
//
// 也就是说不声明自持 kind 的话，注入会把**每一轮**都打成失败。
// 本插件只在「每晚整理完成」时注入一次（低频），但仍必须走合规来源。

import { randomUUID } from 'node:crypto'

/** 生产者自持 kind：取 `plugin:<包名>` 形态，与 v3→v4 迁移的回落分支保持同一身份。 */
export const INJECTION_PRODUCER_KIND = 'plugin:dsh-anima'

/** 快照区块名，与 systemPrompt section 的 name 对应。 */
export const INJECTION_SECTION_NAME = 'anima:identity'

/**
 * 构造一条**模型可见**的注入消息。
 *
 * 与 `createInjectionSource` 的区别：那个只造 source（供宿主自己拼消息时用），
 * 这个直接返回可 push 进 messages 的完整 user 消息。pre-step 钩子需要后者。
 *
 * 三个字段都不是可选的：
 *   - `kind` 必须自持（会话格式 v4 拒绝共享的 `plugin`，见文件头）；
 *   - `form: 'snapshot'` 声明这是快照而非用户发言 —— 用它冒充用户会污染对话历史；
 *   - `sections` 必须给出文本，否则宿主无法把这条消息归档回具体区块。
 *
 * @param {string} text 注入文本
 * @param {string} [sectionName] 区块名，默认用质检段的
 * @returns {object}
 */
export function createNoticeMessage(text, sectionName = QUALITY_SECTION_NAME) {
  return {
    // 与宿主 createMessage() 同构：消息必须自带稳定 id。
    // 缺 id 的消息落库时无人校验，但加载时 assertMessageEventShape 会拒收，
    // 后果是**整个会话打不开**（session event at seq N lacks an identified message）。
    // 这里自持 id，不再依赖外部 pre-step 钩子事后补齐。
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: INJECTION_PRODUCER_KIND,
      form: 'snapshot',
      sections: [{ name: sectionName, text }]
    }
  }
}

/**
 * 构造注入消息的 source：自持 kind + snapshot 形态 + 命名区块。
 * @param {string} snapshotText 注入给模型的快照文本
 * @returns {{kind: string, form: string, sections: Array<{name:string,text:string}>}}
 */
export function createInjectionSource(snapshotText) {
  return {
    kind: INJECTION_PRODUCER_KIND,
    form: 'snapshot',
    sections: [{ name: INJECTION_SECTION_NAME, text: snapshotText }]
  }
}

/**
 * 每晚整理完成后的通知文案。
 *
 * **没事就说空串，调用方据此不注入。** 这条规则来自用户（m05776）：
 * 「有需要汇报的就汇报没有就不汇报」。修改前这段文案无条件返回，
 * 于是出现过注入「待审：0 条（整理前 0 条，自动去重/合并 0 条，超限淘汰 0 条）」
 * 的情况 —— 一条纯粹占注意力的通知，正是这个规则要消灭的形状。
 *
 * 判据全在 summary 里，不含任何模型判断：
 *   - 整理后仍有待审候选，或
 *   - 这次真的动了数据（去重 / 超限淘汰）
 *
 * @param {object} summary triage() 的 summary
 * @param {string[]} [pendingTitles] 存活候选的正文
 * @returns {string} 无事可说时返回空串（不是空行，是 ''）
 */
export function triageNoticeText(summary, pendingTitles) {
  const after = Number(summary?.pendingAfter ?? 0)
  const removed = Number(summary?.duplicatesRemoved ?? 0) + Number(summary?.overflowRemoved ?? 0)
  if (after <= 0 && removed <= 0) return ''

  const lines = [
    '[dsh-anima 记忆缓冲区] 每晚整理已完成。',
    `待审：${after} 条（整理前 ${summary.pendingBefore} 条，自动去重/合并 ${summary.duplicatesRemoved} 条，超限淘汰 ${summary.overflowRemoved} 条）。`
  ]
  if (Array.isArray(pendingTitles) && pendingTitles.length > 0) {
    lines.push('', '等待你裁决的候选：')
    for (const title of pendingTitles.slice(0, 10)) lines.push(`- ${title}`)
    if (pendingTitles.length > 10) lines.push(`- …还有 ${pendingTitles.length - 10} 条`)
  }
  lines.push('', '请在「设置 → 灵台」里逐条采纳或丢弃；未裁决的候选不会进入我的长期记忆。')
  return lines.join('\n')
}

/**
 * 巡夜汇报文案：每晚到点把「机器数得出来的事」汇总成一条。
 *
 * 与 triageNoticeText 的分工：那个只讲缓冲区整理，这个讲整晚的结论（缓冲区 +
 * 体检），同一晚只该出现一条。合并由调用方做（runPatrol 里传 triage 进来）。
 *
 * 措辞约束（同样是防止这条提醒变成表演）：
 *   ① 只列数字与来源，不写「我注意到你最近…」——那种话零新信息，全是编的；
 *   ② 必须写「没报的是什么」，否则用户会以为查过的地方都没问题；
 *   ③ 结尾给出可反查的出口（哪个命令/哪个页面能自己复算）。
 *
 * @param {object} input
 * @param {{pending:number, flagged:number, removed:number}} input.facts
 * @param {string[]} [input.pendingTitles]
 * @param {Array<{id:string, text:string, findings:Array}>} [input.flaggedDetails]
 * @param {object|null} [input.triage] 当晚的整理 summary（没有就传 null）
 * @param {number} [input.checked] 体检扫过的记忆条数
 * @returns {string}
 */
export function patrolNoticeText({ facts, pendingTitles = [], flaggedDetails = [], triage = null, checked = 0 }) {
  const f = facts ?? {}
  const lines = ['[dsh-anima 巡夜] 到点跑完，有下面这些要你看一眼。']

  if (Number(f.pending) > 0) {
    lines.push('', `待审候选：${f.pending} 条（未裁决的不会进长期记忆）`)
    for (const title of pendingTitles.slice(0, 5)) lines.push(`- ${title}`)
    if (pendingTitles.length > 5) lines.push(`- …还有 ${pendingTitles.length - 5} 条`)
  }

  if (Number(f.flagged) > 0) {
    lines.push('', `记忆体检：${f.flagged} 条需要你判（扫了 ${checked} 条）`)
    for (const item of flaggedDetails.slice(0, 5)) {
      const first = Array.isArray(item.findings) ? item.findings[0] : null
      lines.push(`- ${first?.detail ?? item.text}`)
      lines.push(`  ${`/anima mark ${item.id} state=contradicted`}`)
    }
    if (flaggedDetails.length > 5) lines.push(`- …还有 ${flaggedDetails.length - 5} 条，看设置页「记忆体检」`)
  }

  if (Number(f.removed) > 0) {
    lines.push('', `整理时动过 ${f.removed} 条（去重或超限淘汰），明细在设置页的整理记录里`)
  }

  if (triage && Number(triage.pendingBefore) !== Number(triage.pendingAfter) && Number(f.pending) === 0) {
    lines.push('', `缓冲区：${triage.pendingBefore} → ${triage.pendingAfter} 条`)
  }

  // ③ 必须写清这次没说什么。只报查到的问题，会让人误以为剩下的都通过了。
  const silent = []
  if (Number(f.pending) === 0) silent.push('待审候选（0 条）')
  if (Number(f.flagged) === 0) silent.push('体检问题（0 条）')
  lines.push(
    '',
    `没报的：${silent.join('、') || '无'}。`,
    '这两个数可以自己复算：设置页的记忆体检按钮，或 `GET /api/anima/memory/audit`。',
    '「这条记忆还算不算数」不在巡夜范围内 —— 那需要理解语义，代码不判。'
  )
  return lines.join('\n')
}

/**
 * 人设配置变更后的告知文案。
 *
 * 为什么需要单独注入一句：system prompt 的段落是每轮重新装配的，改完下一轮就已经是
 * 新内容；但**对话历史里**仍然躺着旧设定生效期间的那条系统提示。模型看得到两套规则，
 * 而没有任何东西告诉它哪套算数 —— 它会倾向沿用先出现的那套，于是「改了没生效」。
 * 一句明说「刚才那套作废」比重新注入整份提示词便宜得多，也够用。
 *
 * 只列字段名不列新值：新值已经在下一轮的提示词里了，重复一遍只是浪费上下文。
 *
 * 措辞刻意不写「用户刚刚改了」：同一个函数既服务于用户在设置页的改动，也服务于
 * 模型自己调用的 `set_assistant_persona`（工具确认关闭时它直接落盘）。把来源如实
 * 写出来，比默认假称是用户做的更可信 —— 这条消息的作用是让模型知道自己手上的
 * 设定来自哪里。
 *
 * @param {string[]} changedKeys 发生变化的配置键
 * @param {string} [source] 变更来源的可读标注（设置页 / 命令 / 模型工具 / 本工作区覆盖）
 * @returns {string}
 */
export function configChangedNoticeText(changedKeys, source = '设置页') {
  const list = Array.isArray(changedKeys) ? changedKeys.filter(Boolean) : []
  // 标题必须说真话：这段文案原来一律叫「助手人格设定刚有更新」，于是改一下对账档位
  // 也会被说成人格变了。用户看到的第一句话就是错的，后面再准确也没用 —— 而且它还会
  // 让模型以为「我这个人变了」，实际变的只是质检的判据。
  //
  // 分界不按「是不是提示词字段」分（两者都在提示词里），而按「改的是谁」分：
  // memory.* / quality.* 改的是「怎么记、怎么查」，人设字段改的是「我是谁」。
  const isPersona = (key) => !String(key).startsWith('memory.') && !String(key).startsWith('quality.')
  const personaCount = list.filter(isPersona).length
  const settingsCount = list.length - personaCount
  let header
  if (personaCount === 0) {
    header = '[dsh-anima 配置] 提示词里的设定刚有更新'
  } else if (settingsCount === 0) {
    header = '[dsh-anima 人格配置] 助手人格设定刚有更新'
  } else {
    header = '[dsh-anima 配置] 助手人格与其它提示词设定刚有更新'
  }
  const lines = [
    `${header}（来源：${source}）。`,
    list.length > 0 ? `变更字段：${list.map(describeConfigKey).join('、')}。` : '配置有更新。',
    personaCount > 0
      ? '新设定立刻生效，之前那套**不再适用**；被清空的字段按「没有这项设定」处理，不要沿用旧值。'
      : '新设定立刻生效，旧值**不再适用**，不要沿用。'
  ]
  return lines.join('\n')
}

/** 配置键 → 用户看得懂的名字。未收录的键原样显示（宁可露出内部名，也不要漏报变更）。 */
const CONFIG_KEY_LABELS = {
  enabled: '启用状态',
  agentName: '助手名字',
  agentRole: '角色设定',
  addressUserAs: '对用户的称呼',
  userOccupation: '用户职业',
  userBio: '用户介绍',
  style: '风格与语调',
  headingLists: '标题与列表',
  emoji: '表情符号',
  tables: '表格',
  replyLength: '回复长度',
  language: '回复语言',
  customInstructions: '补充指令',
  requireToolConfirmation: '工具改动确认',
  trailEnabled: '输入框光轨',
  trailColor: '光轨颜色',
  trailSpeed: '光轨速度',
  trailWidth: '光轨粗细',
  workspaceOverridesEnabled: '按工作区覆盖',
  workspaceFileDir: '覆盖文件目录',
  presets: '人设预设'
}

function describeConfigKey(key) {
  if (typeof key !== 'string') return String(key)
  if (CONFIG_KEY_LABELS[key]) return CONFIG_KEY_LABELS[key]
  if (key.startsWith('memory.')) return `记忆设置（${key.slice(7)}）`
  if (key.startsWith('quality.')) return `质检设置（${key.slice(8)}）`
  return key
}

// ==================== 质检提醒 ====================

/** 质检提醒的区块名，与 systemPrompt 的 anima:quality 段对应。 */
export const QUALITY_SECTION_NAME = 'anima:quality'

/**
 * 把一次代码检查的结果渲染成一条「下一步要照做」的提醒。
 *
 * 三条措辞约束（都是为了防止这条提醒本身变成表演）：
 *   ① 只说**机器判到了什么**，不说「我觉得你敷衍了」—— 后者是解释，前者是证据；
 *   ② 必须把**没查的**一起列出。只报查到的问题，会让人误以为剩下的都通过了；
 *   ③ 不给「已通过」这种话。没有 findings 时不发提醒，而不是发一句夸奖。
 *
 * @param {{findings:Array, uncovered:string[], checked:string[], meta:object}} result
 * @param {number} [limit] 最多列几条，超出的只说总数
 * @returns {string} 没有 findings 时返回 ''
 */
export function qualityReminderText(result, limit = 5) {
  const findings = Array.isArray(result?.findings) ? result.findings : []
  if (findings.length === 0) return ''
  const shown = findings.slice(0, Math.max(1, limit))
  const lines = [
    '[dsh-anima 质检] 代码在你上一条回答里判到了下面这些形状。这是机器判词，不是评价：'
  ]
  for (const f of shown) {
    lines.push(`- ${f.ruleId} ${f.name}：${f.detail}`)
  }
  if (findings.length > shown.length) {
    lines.push(`- …还有 ${findings.length - shown.length} 条同类问题未列出`)
  }
  const uncovered = Array.isArray(result?.uncovered) ? result.uncovered : []
  if (uncovered.length > 0) {
    lines.push(
      '',
      `这次没查：${uncovered.join('、')}。`
        + '别把上面这几条修掉就当「十二条全过」——没查的仍然是没查。'
    )
  }
  lines.push('', '下一步：能补的补（把来源、命令、原话补上），补不了的直接说没核过。不要在回答里声明自己「已经注意了」。')
  return lines.join('\n')
}
