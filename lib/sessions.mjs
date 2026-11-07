// lib/sessions.mjs — 读宿主会话日志（zstd 分帧），只读
//
// 这段逻辑原本只在 `scripts/` 下（check-hook / remind-effect / trace-sources 三处
// 各写过一遍，后来抽成 scripts/zstd-frames.mjs）。现在回扫式复盘要在**运行时**
// 用它，而 `package.json` 的 `files` 里没有 `scripts/` —— 线上装好的插件根本看不到
// 那个目录。所以真正实现在这里，`scripts/zstd-frames.mjs` 改成从这里转出，
// 保持四个开发脚本的 import 路径不变，同时只有一份实现（改一处漏两处的老问题）。
//
// 一条必须守住的规矩：**空结果和读失败不能长得一样。**
//   · 目录不存在 → 说「目录不存在」
//   · zstd 能力不存在 → 说「这个 Node 不支持 zstd」
//   · 帧解压失败 → 把 failedFrames 报上去
// 历史上踩过的坑正是这个：`zstd -dc` 管道静默失败，扫出来一堆 0，看着像「没有数据」。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

/** zstd 帧魔数 0x28 0xB5 0x2F 0xFD。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

const isMagicAt = (raw, i) => raw[i] === ZSTD_MAGIC[0] && raw[i + 1] === ZSTD_MAGIC[1]
  && raw[i + 2] === ZSTD_MAGIC[2] && raw[i + 3] === ZSTD_MAGIC[3]

/** 这个 Node 有没有 zstd 解压能力。没有就明说，不要假装扫过了。 */
export function hasZstdSupport() {
  return typeof zlib.zstdDecompressSync === 'function'
}

/**
 * 把整个 Buffer 按 zstd 魔数切成帧边界。
 * @param {Buffer} raw
 * @returns {number[]} 每帧的起始偏移（升序）
 */
export function frameOffsets(raw) {
  const starts = []
  for (let i = 0; i + 4 <= raw.length; i += 1) {
    if (isMagicAt(raw, i)) starts.push(i)
  }
  return starts
}

/**
 * 逐帧解压，产出每帧解压后的文本。
 * @param {Buffer} raw
 * @returns {{texts: string[], frames: number, failedFrames: number}}
 *   failedFrames 必须往上报：解压失败的帧意味着事件表缺了一段，
 *   而缺了的那一段在后续统计里会安静地消失 —— 不报就等于假装没发生。
 */
export function decodeFrames(raw) {
  const starts = frameOffsets(raw)
  const texts = []
  let failedFrames = 0
  for (let k = 0; k < starts.length; k += 1) {
    const begin = starts[k]
    const end = k + 1 < starts.length ? starts[k + 1] : raw.length
    try {
      texts.push(zlib.zstdDecompressSync(raw.subarray(begin, end)).toString('utf8'))
    } catch {
      failedFrames += 1
    }
  }
  return { texts, frames: starts.length, failedFrames }
}

/**
 * 读一个会话日志文件，返回解压后的事件数组。
 * @param {string} file
 * @returns {{events: object[], frames: number, failedFrames: number}}
 */
export function readSessionEvents(file) {
  const { texts, frames, failedFrames } = decodeFrames(fs.readFileSync(file))
  const events = []
  for (const text of texts) {
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      // 半行是写入过程被中断留下的，跳过即可 —— 它不是错误，是正常尾部。
      try { events.push(JSON.parse(t)) } catch { /* 半行 */ }
    }
  }
  return { events, frames, failedFrames }
}

/** 会话日志根目录。宿主把它放在 DSH_HOME/sessions 下。 */
export function sessionsRoot(home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')) {
  return path.join(String(home), 'sessions')
}

/**
 * 列出会话日志文件。
 *
 * @param {object} [opts]
 * @param {string} [opts.root] 会话根目录；默认 sessionsRoot()
 * @param {number} [opts.sinceMs] 只留修改时间晚于这个时刻的文件（省得每个都去解一遍）
 * @returns {{files: Array<{file: string, mtimeMs: number, size: number}>, rootExists: boolean, error: string|null}}
 */
export function listSessionFiles({ root, sinceMs = 0 } = {}) {
  const dir = root ?? sessionsRoot()
  let rootStat = null
  try { rootStat = fs.statSync(dir) } catch { rootStat = null }
  if (!rootStat || !rootStat.isDirectory()) {
    // 目录不存在是「没有会话可扫」，不是「扫了发现没问题」。必须能分辨。
    return { files: [], rootExists: false, error: `会话目录不存在：${dir}` }
  }
  const out = []
  const walk = (d) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.zstd')) continue
      let st
      try { st = fs.statSync(p) } catch { continue }
      if (sinceMs > 0 && st.mtimeMs < sinceMs) continue
      out.push({ file: p, mtimeMs: st.mtimeMs, size: st.size })
    }
  }
  walk(dir)
  return { files: out, rootExists: true, error: null }
}

/**
 * 宿主事件 → 回扫用的扁平形状。
 *
 * 时间字段实测是 `ev.time`（epoch 毫秒）。曾经按 `ev.at` / `ev.timestamp` 读过，
 * 两者都是 undefined，于是每条线索的出处都是空串 —— 那种线索没法反查，等于没记。
 *
 * @param {object[]} events
 * @returns {Array<{type: string, seq: number|null, at: string, text: string, sourceKind: string}>}
 */
export function toLeadEvents(events) {
  const out = []
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev?.type !== 'user/message') continue
    const content = ev?.data?.content ?? ev?.data?.message?.content
    const blocks = Array.isArray(content) ? content : []
    const text = blocks
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (!text) continue
    const ms = typeof ev.time === 'number' ? ev.time : NaN
    out.push({
      type: 'user/message',
      seq: Number.isInteger(ev.seq) ? ev.seq : null,
      at: Number.isFinite(ms) ? new Date(ms).toISOString() : '',
      text,
      sourceKind: ev?.data?.source?.kind ?? ev?.data?.message?.source?.kind ?? '',
      // 任务板下发的卡片也是 `source.kind = 'user'`（rpcId 形如 `task-board-<uuid>`），
      // 但那是卡片提示词，不是人说的话。实测捞出来两条「不要调用任何工具，不要读文件」
      // 全是任务板的 —— 靠 rpcId 前缀能准确分开。
      rpcId: String(ev?.data?.source?.rpcId ?? ev?.data?.message?.source?.rpcId ?? '')
    })
  }
  return out
}

/**
 * 一个会话是不是 subagent 会话。
 *
 * 为什么必须判：subagent 会话里 `source.kind` 也是 `'user'`，但那些「用户发言」
 * 是父 agent 派活时写的任务书（实测有「不要调用任何工具，不要读文件」这种）。
 * 把它们当用户原话捞出来，线索表会变成我自己的笔记。
 *
 * @param {object[]} events
 * @returns {boolean}
 */
export function isSubagentSession(events) {
  return (Array.isArray(events) ? events : []).some((e) => e?.type === 'subagent/descriptor')
}
