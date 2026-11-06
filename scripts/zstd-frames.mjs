// scripts/zstd-frames.mjs — 会话日志的 zstd 分帧读取（scripts 下四个脚本共用）
//
// 为什么要单独一个文件：DSH 的会话日志是「每行一个 zstd 帧」的追加格式。
// 直接 `zstdDecompressSync` 整个文件只会解出**第一帧**，得到一份看起来正常、
// 实则残缺的事件表 —— 这是踩过的坑。正确做法是按 zstd 魔数切帧再逐帧解压。
//
// 这段逻辑原本在三处逐字重复（check-hook / remind-effect / trace-sources）。
// 三份实现的风险不是「重复难看」，而是**改一处漏两处**：哪天分帧边界需要修，
// 只修了当时正在调试的那一个，另外两个会继续产出残缺事件表，而它们看起来都正常。

import fs from 'node:fs'
import zlib from 'node:zlib'

/** zstd 帧魔数 0x28 0xB5 0x2F 0xFD。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

const isMagicAt = (raw, i) => raw[i] === ZSTD_MAGIC[0] && raw[i + 1] === ZSTD_MAGIC[1]
  && raw[i + 2] === ZSTD_MAGIC[2] && raw[i + 3] === ZSTD_MAGIC[3]

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
