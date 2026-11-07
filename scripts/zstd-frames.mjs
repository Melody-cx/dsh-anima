// scripts/zstd-frames.mjs — 会话日志的 zstd 分帧读取（开发脚本共用入口）
//
// 实现已经搬到 `lib/sessions.mjs`，这里只做转出。
//
// 为什么搬：回扫式复盘要在**运行时**读会话日志，而 `package.json` 的 `files`
// 里没有 `scripts/` —— 线上装好的插件看不到这个目录。实现留在 scripts 下等于
// 「开发时能跑、装好就坏」。四个开发脚本的 import 路径保持不变，实现只有一份
// （改一处漏两处的老问题，见下）。
//
// 历史：这段逻辑原本在三处逐字重复（check-hook / remind-effect / trace-sources）。
// 三份实现的风险不是「重复难看」，而是**改一处漏两处**：哪天分帧边界需要修，
// 只修了当时正在调试的那一个，另外两个会继续产出残缺事件表，而它们看起来都正常。

export {
  frameOffsets,
  decodeFrames,
  readSessionEvents,
  hasZstdSupport,
  sessionsRoot,
  listSessionFiles,
  toLeadEvents,
  isSubagentSession
} from '../lib/sessions.mjs'
