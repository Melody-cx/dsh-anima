// lib/injection.mjs — 会话注入消息的 source 构造（纯函数，零依赖）
//
// 为什么必须自持 kind（与 dsh-soul 的行为对齐：同样自持 kind，但名字取本包自己的）：
// 会话格式 v4 的来源准入明确拒绝共享的 `kind: 'plugin'`：
//
//   if (typeof value.kind !== 'string' || value.kind.length === 0 || value.kind === 'plugin')
//     throw new SessionFormatError('format v4 message requires a producer-owned source kind')
//
// 也就是说不声明自持 kind 的话，注入会把**每一轮**都打成失败。
// 本插件只在「每晚整理完成」时注入一次（低频），但仍必须走合规来源。

/** 生产者自持 kind：取 `plugin:<包名>` 形态，与 v3→v4 迁移的回落分支保持同一身份。 */
export const INJECTION_PRODUCER_KIND = 'plugin:dsh-anima'

/** 快照区块名，与 systemPrompt section 的 name 对应。 */
export const INJECTION_SECTION_NAME = 'anima:identity'

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

/** 每晚整理完成后的通知文案（注入给活动会话，让用户看到待审清单）。 */
export function triageNoticeText(summary, pendingTitles) {
  const lines = [
    '[dsh-anima 记忆缓冲区] 每晚整理已完成。',
    `待审：${summary.pendingAfter} 条（整理前 ${summary.pendingBefore} 条，自动去重/合并 ${summary.duplicatesRemoved} 条，超限淘汰 ${summary.overflowRemoved} 条）。`
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
  const lines = [
    `[dsh-anima 人格配置] 助手人格设定刚有更新（来源：${source}）。`,
    list.length > 0 ? `变更字段：${list.map(describeConfigKey).join('、')}。` : '配置有更新。',
    '新设定立刻生效，之前那套**不再适用**；被清空的字段按「没有这项设定」处理，不要沿用旧值。'
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
  return key
}
