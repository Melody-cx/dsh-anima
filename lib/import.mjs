// lib/import.mjs — 外部 AI 记忆导入（纯函数，无外部依赖）
//
// 场景（用户 m13808 拍板 Phase ②）：用户从别的 AI 工具里导出一份「使用画像」，
// 粘贴进来，本插件把它**切成一条条独立记忆**并给出归类建议，落到待审缓冲区。
//
// 为什么必须切分而不是整段存成一条：
//   ① 记忆层的价值在**逐条裁决** —— 一整段五千字存进去，用户在设置页只有
//      「采纳 / 丢弃」两个按钮，等于逼他全选或全不选，缓冲区这个设计就白做了；
//   ② 注入有条数与字符双预算，一条巨型记忆会独占预算，把其它记忆全挤出去；
//   ③ 跨 AI 的记忆里必然混着「这条我不想要」的部分，逐条才能剔除。
//
// 设计上的三条硬约束：
//   1. **切分是机械的，不做语义理解**。不调用模型、不猜意思 —— 只按显式分隔
//      （标题行、列表项、空行块）切开。理由：这一步在本地同步完成，用户粘贴后
//      立刻看到结果；调模型会让「粘贴 → 等十几秒 → 结果不可复现」。
//   2. **归类是建议，不是判决**。每条带上 layer 建议与理由，用户可改。
//   3. **凭据闸门与手动添加同一条**。跨 AI 的画像里最容易夹带 API Key 与
//      路径里的账号名 —— 走 makeCandidate 复用同一套正则，命中即拒绝入库。

import { findCredentials, makeCandidate, normalizeMemoryText, similarity } from './memory.mjs'
import { MEMORY_TEXT_MAX } from './config.mjs'

/**
 * 一次导入的条数上限。
 *
 * 与 maxPending 默认值（200）解耦：这是**单次操作**的上限，不是缓冲区容量。
 * 切出几百条会让用户在设置页面对一个自己没写的长列表，反而不如让他分批粘贴。
 */
export const IMPORT_MAX_ITEMS = 60

/** 单次粘贴的原文长度上限（字符）。超过就不再切分，直接报错让用户分批。 */
export const IMPORT_MAX_SOURCE = 40000

/** 切分后单条过短的丢弃阈值：低于它多半是标题残留、编号行或标点。 */
export const IMPORT_MIN_ITEM = 4

/**
 * 标题行要「本身算一条结论」所需的最短汉字数（汉字按 1 计，其它字符按 0.5）。
 *
 * 12 的来源：冒烟实测里 6 字的「我的使用画像」「沟通偏好」是标签，
 * 17 字的「跨项目通用的沟通偏好，一律结论先行」是结论。取中间偏保守的位置 ——
 * 漏掉一个长标题只是少一条候选（用户本来也能手动补），
 * 而多收一堆标签会让他以为导入很脏。
 */
const HEADING_STATEMENT_MIN = 12

/** 粗略的信息量：汉字算 1，其余算 0.5。只用于判断标题是标签还是句子。 */
function informationLength(text) {
  let score = 0
  for (const char of String(text ?? '')) {
    score += /[\u4e00-\u9fff]/.test(char) ? 1 : 0.5
  }
  return score
}

/**
 * 标题行是否本身就是一条「结论」。
 *
 * 冒烟实测教训：一开始把**所有**标题都收成条目，结果「我的使用画像」「我是谁」
 * 「沟通偏好」这类小节标签全成了候选 —— 它们在设置页里长得像记忆，实际上
 * 没有可采纳的内容，还会把缓冲区计数撑起来，让用户以为导进来一堆东西。
 *
 * 判定只看向两个信号，不做语义理解：
 *   - 长度：一句结论至少十几个字（「我的使用画像」6 字，明显是标签）；
 *   - 句读：带逗号/句号/问号的标题是句子，标签几乎不带标点。
 * 两者都不满足就丢弃，只当结构。**丢的是标签不是内容** —— 标题底下的段落
 * 照常成条，信息不会整体消失。
 */
function headingIsStatement(title) {
  if (informationLength(title) >= HEADING_STATEMENT_MIN) return true
  return /[，。；：！？,.;:!?]/.test(title)
}

/**
 * 切分粘贴文本。
 *
 * 识别四种边界（优先级从高到低）：
 *   ① Markdown 标题行（`#`、`##`…）—— 是结论则自成一 条，是标签则丢弃（只当结构）；
 *   ② 列表项（`-`、`*`、`+`、`1.`、`1、`、`（1）`）—— 每项一条；
 *   ③ 中文分号/句号结尾的连续行 —— 同段落内不切，整段一条；
 *   ④ 空行 —— 段落边界。
 *
 * 刻意**不按句号切**：中文画像里一句话常常不完整（「偏好：结论先行。」），
 * 按句号切会把「偏好：」和「结论先行。」拆成两条，两条都读不通。
 *
 * @param {string} source 粘贴的原文
 * @returns {string[]} 切分结果（已归一化空白，未过滤空串）
 */
export function splitImportedText(source) {
  const body = String(source ?? '').replace(/\r\n?/g, '\n')
  const lines = body.split('\n')
  const out = []
  let buffer = []

  const flush = () => {
    const text = normalizeMemoryText(buffer.join('\n'))
    buffer = []
    if (text) out.push(text)
  }

  // 列表项与标题行都能独立成条；普通行累积到段落结束。
  const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)、]|（\d+）|\(\d+\))\s+(.*)$/
  const HEADING = /^\s*(#{1,6})\s+(.*)$/

  for (const line of lines) {
    if (!line.trim()) {
      flush()
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      const title = normalizeMemoryText(heading[2])
      if (headingIsStatement(title)) out.push(title)
      continue
    }

    const item = LIST_ITEM.exec(line)
    if (item) {
      flush()
      const text = normalizeMemoryText(item[1])
      if (text) buffer.push(text)
      // 列表项自身立即收尾：下一行若不是列表项，会是新段落。
      flush()
      continue
    }

    buffer.push(line.trim())
  }
  flush()

  return out
}

/**
 * 归类：给一条候选建议 layer，并说明理由。
 *
 * 判断依据只有**文本里出现的坐标证据**，不做语义猜测：
 *   - 出现具体盘符/项目路径（`D:\...`、`/home/...`、`~/...`）或「本工作区」「这个项目」，
 *     说明这条讲的是某个具体项目 ⇒ 建议 `workspace`；
 *   - 出现「所有项目」「任何项目」「通用」「一律」「每次都要」等全局措辞 ⇒ 建议 `global`；
 *   - 两者都有或都没有 ⇒ 建议 `global`（默认层）。
 *
 * 为什么默认 global 而不是 workspace：把「记忆动不动就不生效」作为默认体验，
 * 比跨项目污染更糟 —— 用户先看见它在起作用，才会去调范围。反过来用户会以为功能坏了。
 *
 * @param {string} text
 * @returns {{layer: 'global'|'workspace', reason: string, confidence: 'high'|'low'}}
 */
export function suggestLayer(text) {
  const body = String(text ?? '')
  const projectHits = []
  const globalHits = []

  // 具体路径：盘符（Windows）、/home、/Users、~/ 开头、或形如 D:/x/y 的写法
  if (/[A-Za-z]:[\\/][^\s，。；]+/.test(body)) projectHits.push('具体磁盘路径')
  if (/(?:^|\s)(?:\/home\/|\/Users\/|~\/)[^\s，。；]+/.test(body)) projectHits.push('具体磁盘路径')
  if (/本工作区|这个项目|本项目|当前项目|该项目|此项目/.test(body)) projectHits.push('「本项目」措辞')

  if (/所有项目|任何项目|跨项目|通用|一律|每个项目|每次都要|不管哪个项目|无论什么项目/.test(body)) {
    globalHits.push('「所有/任何」措辞')
  }

  if (projectHits.length > 0 && globalHits.length === 0) {
    return {
      layer: 'workspace',
      reason: `检测到${projectHits.join('、')}，建议只在对应工作区生效`,
      confidence: 'high'
    }
  }
  if (globalHits.length > 0 && projectHits.length === 0) {
    return {
      layer: 'global',
      reason: `检测到${globalHits.join('、')}，建议全局生效`,
      confidence: 'high'
    }
  }
  if (projectHits.length > 0 && globalHits.length > 0) {
    return {
      layer: 'global',
      reason: '同时出现项目相关与全局措辞，先按全局收下，你可以在下面改成仅本工作区',
      confidence: 'low'
    }
  }
  return {
    layer: 'global',
    reason: '没检测到工作区坐标，按全局生效（可在下面改）',
    confidence: 'low'
  }
}

/**
 * 把粘贴文本转成一批**候选记录**（不改状态、不落盘）。
 *
 * 返回的分类刻意分成四类，因为调用方对它们的处置完全不同：
 *   - `items`  可以入库的候选
 *   - `skipped` 太短/空的碎片（丢弃）
 *   - `tooLong` 超过单条上限的（丢弃并告知，不截断 —— 截断会造出一条
 *               前半句是用户的偏好、后半句断在半个词上的记忆）
 *   - `blocked` 命中凭据闸门的（丢弃并告警，是安全事件而非格式问题）
 *
 * `duplicates` 是与**已有记忆**（含缓冲区里已有的）内容重复的条目 —— 单独列出来，
 * 因为它不是错误：用户可能就是从本插件导出后又粘回来。
 *
 * @param {string} source 粘贴文本
 * @param {object[]} existing 现有全量记忆（用于去重）
 * @param {object} options {maxItems, cwd}
 * @returns {object}
 */
export function parseImport(source, existing = [], options = {}) {
  const { maxItems = IMPORT_MAX_ITEMS, cwd = '' } = options
  const raw = String(source ?? '')

  if (!raw.trim()) {
    return { ok: false, error: '粘贴内容为空' }
  }
  if (raw.length > IMPORT_MAX_SOURCE) {
    return {
      ok: false,
      error: `粘贴内容过长（${raw.length} 字符，上限 ${IMPORT_MAX_SOURCE}）。请分批粘贴 —— 一次导入几百条，你在下面根本审不完。`
    }
  }

  const pieces = splitImportedText(raw)
  const items = []
  const skipped = []
  const tooLong = []
  const blocked = []
  const duplicates = []
  const overflow = []

  // 已有指纹：内容归一化后比较，避免「同一句话多个空格」被判成两条。
  const seen = new Set()
  for (const record of existing ?? []) {
    const digest = normalizeMemoryText(record?.text).toLowerCase()
    if (digest) seen.add(digest)
  }

  for (const text of pieces) {
    if (text.length < IMPORT_MIN_ITEM) {
      skipped.push(text)
      continue
    }
    if (text.length > MEMORY_TEXT_MAX) {
      tooLong.push(text)
      continue
    }

    const credentials = findCredentials(text)
    if (credentials.length > 0) {
      blocked.push({ text, credentials })
      continue
    }

    const digest = text.toLowerCase()
    if (seen.has(digest)) {
      duplicates.push(text)
      continue
    }
    seen.add(digest)

    if (items.length >= maxItems) {
      overflow.push(text)
      continue
    }

    const layer = suggestLayer(text)
    const created = makeCandidate({
      text,
      layer: layer.layer,
      source: 'import',
      cwd: layer.layer === 'workspace' ? cwd : ''
    })
    if (!created.ok) {
      // makeCandidate 还会再拦一次（长度/凭据口径一致），
      // 走到这里说明上面两道闸门与它不一致 —— 按 blocked 处理，别静默丢。
      blocked.push({ text, credentials: ['makeCandidate 拒绝'], reason: created.error })
      continue
    }
    items.push({ record: created.record, suggested: layer, text })
  }

  return {
    ok: true,
    items,
    skipped,
    tooLong,
    blocked,
    duplicates,
    overflow,
    counts: {
      source: raw.length,
      pieces: pieces.length,
      accepted: items.length,
      skipped: skipped.length,
      tooLong: tooLong.length,
      blocked: blocked.length,
      duplicates: duplicates.length,
      overflow: overflow.length
    }
  }
}

/**
 * 在待审缓冲区里找出「与刚导入的这批高度相似」的已有候选。
 *
 * 单独做这一步而不是塞进 parseImport：相似度比较是 O(n·m)，
 * 且只有调用方知道「跟谁比」（缓冲区 vs 全量）。
 *
 * @param {object[]} imported 刚解析出的 items
 * @param {object[]} pending 现有待审候选
 * @param {object} options {threshold}
 * @returns {object[]} [{itemIndex, pendingId, similarity, pendingText}]
 */
export function findImportOverlaps(imported, pending, options = {}) {
  const { threshold = 0.6 } = options
  const out = []
  for (let i = 0; i < (imported ?? []).length; i += 1) {
    const text = imported[i]?.text
    if (!text) continue
    for (const candidate of pending ?? []) {
      const score = similarity(text, candidate?.text)
      if (score >= threshold) {
        out.push({
          itemIndex: i,
          pendingId: candidate.id,
          similarity: Number(score.toFixed(3)),
          pendingText: candidate.text
        })
      }
    }
  }
  return out
}

/**
 * Phase ② 第一步给用户复制的那段提示词。
 *
 * 用途（WorkBuddy 两段式的第一段）：让用户在**别的 AI 工具**里把散落的偏好整理成
 * 一份结构化画像，再粘回来。所以这段提示词是给别的模型看的，不是给我们自己的。
 *
 * 措辞上刻意要求「保留原本的表述方式，不要过度改写」：改写过的偏好会丢掉
 * 用户的原话口吻，而人设层最需要的恰恰是他的原话（「别跟我绕」比
 * 「偏好简洁直接的沟通风格」有用得多）。
 */
export const IMPORT_PROMPT = [
  '请帮我整理一份我的个人使用画像，用途是让我在不同 AI 工具之间保持一致的协作体验。',
  '请基于你当前能访问到的、与我相关的长期信息和本次会话上下文进行整理。',
  '在涉及我的指令和偏好时，请尽量保留我原本的表述方式，不要过度改写。'
].join('')

/**
 * 给别的 AI 的完整请求（比 IMPORT_PROMPT 多了输出格式要求）。
 *
 * 为什么把格式要求独立出来：用户可以只复制简短版（他自己的模型已经知道该输出什么），
 * 也可以复制完整版（含格式约束，结果更规整）。两种粘贴回来都能被 splitImportedText 处理。
 */
export const IMPORT_PROMPT_FULL = `${IMPORT_PROMPT}

请按下面的格式输出，每条一行，以「- 」开头，一行说一件事：

- 我是谁：职业、技术背景、当前在做的事
- 我说话和做事的方式：沟通风格、语气偏好、明确不喜欢什么
- 我的工具与工作习惯：常用软件、项目路径、目录约定
- 我希望你记住的长期约定：需要一直遵守的规则

每条尽量独立成句，不要写成一大段。如果某条只适用于某个具体项目，请在句中说明是哪个项目。`
