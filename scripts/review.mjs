// 把 OpenCodeReview（ocr）包成一层「不会骗人的」外壳。
//
// 为什么需要这层壳，而不是直接让 CI 跑 ocr：
//   ocr 有三种结局，而**其中两种的退出码都是 0**：
//     status="complete"  → 真查了，可能 0 条也可能 N 条
//     status="skipped"   → 没查（没有可选文件 / 全被规则排除）
//     status="failed"    → 查了但失败（预算耗尽 / LLM 报错 / 工具全挂），退出码 1
//   实测：空仓跑 `ocr review` 得 status="skipped" 且 exit=0；
//   把 --max-tokens-budget 压到 1 得 status="failed" 且 exit=1。
//   所以「退出码 0」既可能是「干净」也可能是「根本没审」。
//   这正是本项目反复吃过亏的那个形状：没查长得像查过没事。这层壳的唯一职责
//   就是把三种结局拆开，且**默认不说「通过」这个词**。
//
// 设计上遵守三条（和 scripts/acceptance.mjs 同源）：
//   1. 结论只来自 ocr 自己写下的 JSON，不从退出码反推；
//   2. 「没审成」必须显式打印，不能用空输出混过去；
//   3. 发现项按严重度分组打印，不替用户做去留决定。
//
// 用法见 --help。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

// 必须用 fileURLToPath 而不是 new URL().pathname：后者会把中文目录名百分号编码，
// 变成 D:\deepseek%E5%B7%A5... 这种不存在的路径。（同一个坑 acceptance.mjs 已记过一次）

// 每次运行独占一个临时子目录（mkdtempSync 带随机后缀），原因有两个：
//   ① 结果 JSON 里带源码片段，不该让同机其他用户读到，也不该被别人预先埋一个同名符号链接；
//   ② 固定文件名下两个并发审查会互相删对方的结果，一个可能读到另一个的 JSON 并当成自己的。
const OUT_PARENT = path.join(os.tmpdir(), 'anima-review')

// 严重度词表只写一次，桶和遍历顺序都由它派生，避免以后加一档时漏改某处。
const SEVERITIES = ['critical', 'high', 'medium', 'low']
const OTHER = 'other'
const SEVERITY_ORDER = [...SEVERITIES, OTHER]

const EXIT = {
  complete: 0, // 真审了
  failed: 1, // 没审成
  usage: 2, // 参数错 / 找不到 ocr
  skipped: 3, // 没审（没有可选文件）
  cleaned: 4, // --clean 完成（不是一次审查，所以不用 0）
}

const VALUE_OPTS = new Set(['--out', '--commit', '-c', '--from', '--to'])

/** 收集所有参数错误，而不是只留最后一个：一次说清，好改。 */
function parseArgs(argv) {
  const out = {
    out: null, commit: null, from: null, to: null,
    clean: false, quiet: false, help: false, errors: [],
  }
  const takeNext = (i, flag) => {
    const v = argv[i + 1]
    // 缺值、空串、或以 - 开头（含单个 -h）：都算参数错。
    // 以前只挡 `--` 开头，`--out -h` 会建出一个名叫 `-h` 的文件；
    // 而 `--from "$BASE_REF"` 在变量未设时传进来是空串，会被当成「没给」，
    // 于是静默退化成「审整个工作区」——正是本脚本要防的那种含糊。
    if (v === undefined || v === '' || v.startsWith('-')) {
      out.errors.push(`${flag} 缺少取值`)
      return null
    }
    return v
  }

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '-h' || a === '--help') { out.help = true; continue }
    if (a === '--clean') { out.clean = true; continue }
    if (a === '--quiet') { out.quiet = true; continue }

    if (VALUE_OPTS.has(a)) {
      const v = takeNext(i, a)
      if (v === null) continue
      i += 1
      if (a === '--out') out.out = v
      else if (a === '--commit' || a === '-c') out.commit = v
      else if (a === '--from') out.from = v
      else out.to = v
      continue
    }

    // `--x=值` 形式：带取值的选项统一支持，不含取值的选项一律当未知参数，
    // 免得 `--commit=x` 能用、`--from=y` 却报「未知参数」这种自相矛盾。
    const eq = a.match(/^(--[a-z-]+)=(.*)$/)
    if (eq) {
      const [, flag, v] = eq
      if (!VALUE_OPTS.has(flag)) { out.errors.push(`未知参数: ${a}`); continue }
      if (v === '' || v.startsWith('-')) { out.errors.push(`${flag} 缺少取值`); continue }
      if (flag === '--out') out.out = v
      else if (flag === '--commit') out.commit = v
      else if (flag === '--from') out.from = v
      else out.to = v
      continue
    }

    out.errors.push(`未知参数: ${a}`)
  }
  return out
}

/**
 * 找 ocr 并解析出「用什么命令跑它」。
 *
 * 这里踩过一个 Windows 的坑，值得留着：npm 的全局 bin 在 Windows 上是 `ocr.cmd`
 * 这个批处理垫片，而 Node 在 **spawnSync 且未开 shell 时拒绝执行 .cmd**，直接
 * `EINVAL`（CVE-2024-27980 之后加的防护，不是权限问题）。实测：
 *   spawnSync('D:\\dev\\npm-global\\ocr.cmd', [...]) → EINVAL
 * 三个解法各有代价：开 shell:true（多一层引号转义，路径含中文/空格时容易碎）、
 * 走 cmd /c（同上）、或者**顺着垫片读出它真正要跑的 js 入口，直接用当前 node 跑**。
 * 这里取第三种：不经过 shell，参数原样传递，中文路径也不会被二次解析。
 */
function findOcr() {
  if (process.env.OCR_BIN) {
    if (!fs.existsSync(process.env.OCR_BIN)) return null
    return { cmd: process.execPath, args: [process.env.OCR_BIN], how: 'OCR_BIN' }
  }

  const isWin = process.platform === 'win32'
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)

  if (isWin) {
    for (const d of dirs) {
      const exe = path.join(d, 'ocr.exe')
      try { if (fs.statSync(exe).isFile()) return { cmd: exe, args: [], how: 'exe' } } catch { /* 没有 */ }
    }
  } else {
    for (const d of dirs) {
      const p = path.join(d, 'ocr')
      try { if (fs.statSync(p).isFile()) return { cmd: p, args: [], how: 'bin' } } catch { /* 没有 */ }
    }
  }

  // Windows 垫片：从 .cmd 里抠出被调用的 .js 路径
  if (isWin) {
    for (const d of dirs) {
      const shim = path.join(d, 'ocr.cmd')
      let text
      try { text = fs.readFileSync(shim, 'utf8') } catch { continue }
      // 垫片末行形如: "%_prog%"  "%dp0%\node_modules\...\ocr.js" %*
      const m = text.match(/"%~?dp0%?\\?([^"]+\.js)"/) || text.match(/"?%~?dp0%?\\([^"\r\n]+\.js)"?/)
      if (!m) continue
      const jsPath = path.join(d, m[1].replace(/\\/g, path.sep))
      if (fs.existsSync(jsPath)) {
        return { cmd: process.execPath, args: [jsPath], how: `shim→${path.basename(jsPath)}` }
      }
    }
  }

  return null
}

/** 建一个本次运行独占的临时目录，并确认它真的是目录而不是别人埋的符号链接。 */
function makeRunDir() {
  fs.mkdirSync(OUT_PARENT, { recursive: true, mode: 0o700 })
  const st = fs.lstatSync(OUT_PARENT)
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error(`${OUT_PARENT} 不是普通目录（可能是符号链接），拒绝往里写带源码的结果`)
  }
  const dir = fs.mkdtempSync(path.join(OUT_PARENT, 'run-'))
  try { fs.chmodSync(dir, 0o700) } catch { /* Windows 上 chmod 基本无效，忽略 */ }
  return dir
}

/** 清理时也要先确认 OUT_PARENT 是普通目录：它是临时目录下的固定名字，
 *  别人可以先把它做成指向任意位置的符号链接，readdirSync 会跟进去、
 *  rmSync 就会删到目标目录里。makeRunDir 有这层检查，--clean 以前没有。 */
function assertRealDir(dir) {
  const st = fs.lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error(`${dir} 不是普通目录（可能是符号链接），拒绝清理`)
  }
}

function removeAllEntries(dir) {
  let entries = []
  try {
    assertRealDir(dir)
    entries = fs.readdirSync(dir)
  } catch (e) {
    if (e.code === 'ENOENT') return 0
    throw e
  }
  let n = 0
  for (const name of entries) {
    const p = path.join(dir, name)
    try {
      const st = fs.lstatSync(p)
      if (st.isDirectory() && !st.isSymbolicLink()) fs.rmSync(p, { recursive: true, force: true })
      else fs.unlinkSync(p)
      n += 1
    } catch { /* 单个删不掉不影响其余 */ }
  }
  return n
}

function printHelp() {
  console.log(`用法: node scripts/review.mjs [选项]

  --commit, -c <ref>   审单个提交（与其父提交比）
  --from <ref>         审分支区间起点（必须同时给 --to）
  --to <ref>           审分支区间终点（必须同时给 --from）
  --out <path>         审查结果另存一份到你指定的路径（原始 JSON 仍留在临时目录）
  --clean              清空 ${OUT_PARENT} 下本次运行之外的所有临时结果，不跑审查
  --quiet              少打印

环境变量:
  OCR_BIN              ocr 入口（bin/ocr.js 路径；默认从 PATH 自动找）

退出码:
  0 = complete  真审了（**不代表 0 条发现**，发现项见输出）
  1 = failed    没审成（预算耗尽 / LLM 报错 / 结果读不到）
  2 = 参数错或找不到 ocr
  3 = skipped   没审（没有可选文件）——CI 里这也算失败，别当成通过
  4 = cleaned   --clean 跑完了（这不是一次审查，别当通过）`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) { printHelp(); return EXIT.complete }

  if (args.errors.length > 0) {
    for (const e of args.errors) console.error(e)
    return EXIT.usage
  }

  // --commit 与 --from/--to 是两种互斥的选范围方式。
  // 都给的话以前会原样丢给 ocr，让 ocr 自己挑一个或者干脆报错；这里直接说不清就不跑。
  if (args.commit && (args.from || args.to)) {
    console.error('--commit 与 --from/--to 不能同时使用')
    return EXIT.usage
  }
  if (args.from && !args.to) {
    console.error('--from 必须配合 --to 使用（ocr 自己也是这么要求的）')
    return EXIT.usage
  }
  if (args.to && !args.from) {
    console.error('--to 必须配合 --from 使用，否则会被静默忽略')
    return EXIT.usage
  }

  if (args.clean) {
    const n = removeAllEntries(OUT_PARENT)
    console.log(`已清理 ${n} 项临时结果（${OUT_PARENT}）`)
    // 刻意不用 0：一次「清理」不是一次「审查通过」。
    // 脚本里如果有人把 --clean 误加进 CI 命令，0 会被读成通过。
    if (args.out) console.log(`注意：--out 指定的 ${args.out} 不会被 --clean 碰，要删请自己动手。`)
    return EXIT.cleaned
  }

  const ocr = findOcr()
  if (!ocr) {
    console.error('找不到 ocr。请先 `npm i -g @alibaba-group/open-code-review`，或用 OCR_BIN 指定它的 bin/ocr.js。')
    // 刻意为非 0：找不到工具时「什么都没输出」不能被读成「没问题」。
    return EXIT.usage
  }

  let runDir
  try { runDir = makeRunDir() } catch (e) {
    console.error(`建临时目录失败：${e.message}`)
    return EXIT.failed
  }
  // ocr 永远只往本次独占的临时目录里写；用户要求的 --out 是事后复制过去的。
  // 这样 `--out package.json` 不会在跑之前就把 package.json 删掉。
  const ocrOut = path.join(runDir, 'review.json')

  const ocrArgs = ['review', '--audience', 'agent', '--format', 'json', '--output', ocrOut]
  if (args.commit) ocrArgs.push('--commit', args.commit)
  if (args.from) ocrArgs.push('--from', args.from, '--to', args.to)

  if (!args.quiet) {
    console.log(`[review] ocr：${ocr.cmd} ${ocr.args.join(' ')}（${ocr.how}）`)
    console.log(`[review] 参数：${ocrArgs.join(' ')}\n`)
  }

  const r = spawnSync(ocr.cmd, [...ocr.args, ...ocrArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    // ocr 会打大量进度行，默认 1MB 缓冲可能不够。
    // 注意：spawnSync 超 maxBuffer 会直接杀掉子进程，所以那时结果文件可能根本没写完，
    // 不能像以前那样说「不影响结果 JSON」。
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  })

  let truncated = false
  if (r.error) {
    const code = r.error.code
    if (code === 'ENOBUFS') {
      truncated = true
      console.error('[review] ocr 输出超过缓冲上限，子进程已被终止——结果 JSON 可能没写完')
    } else if (code === 'ETIMEDOUT') {
      console.error('[review] ocr 超时，当作没审成')
      return EXIT.failed
    } else {
      console.error(`[review] 启动 ocr 失败：${r.error.message}`)
      return EXIT.failed
    }
  }

  let doc
  try {
    doc = JSON.parse(fs.readFileSync(ocrOut, 'utf8'))
  } catch (e) {
    // 没有 JSON 就当没审成。绝不能因为「读不到结果」而落到「通过」。
    console.error(`[review] 读不到本次的 ocr 结果 JSON（${ocrOut}）：${e.message}${truncated ? '（此前输出被截断，多半就是这个原因）' : ''}`)
    if (r.stderr) console.error(String(r.stderr).trim())
    return EXIT.failed
  }

  // 用户要了副本就复制过去。放在这里：只有真拿到结果才复制，跑挂了不会留下半份。
  if (args.out) {
    try {
      const dest = path.resolve(process.cwd(), args.out)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(ocrOut, dest)
    } catch (e) {
      console.error(`[review] 复制结果到你指定的路径失败：${e.message}`)
      return EXIT.failed
    }
  }

  const status = doc.status
  const s = doc.summary ?? {}
  const comments = Array.isArray(doc.comments) ? doc.comments : []
  const failedItems = Array.isArray(doc.manifest?.coverage?.failed) ? doc.manifest.coverage.failed : []

  if (status === 'failed') {
    console.error(`[review] ✗ 没审成：${doc.message ?? '(无说明)'}`)
    for (const f of failedItems) {
      console.error(`         ${f.path ?? '?'} — ${f.classification ?? '?'}：${f.reason ?? ''}`)
    }
    if (r.stderr) console.error(String(r.stderr).trim())
    return EXIT.failed
  }

  if (status === 'skipped') {
    // 这一行是本脚本存在的核心理由：0 个文件被审 ≠ 0 个问题。
    console.error(`[review] ⚠ 什么都没审：${doc.message ?? '(没有可选文件)'}`)
    console.error('[review]   这不等于「代码没问题」——它是「这次没看」。')
    return EXIT.skipped
  }

  if (status !== 'complete') {
    console.error(`[review] ✗ 未知 status=${JSON.stringify(status)}，当作没审成处理`)
    return EXIT.failed
  }

  const bySev = Object.fromEntries(SEVERITY_ORDER.map((k) => [k, []]))
  for (const c of comments) {
    const k = SEVERITIES.includes(c.severity) ? c.severity : OTHER
    bySev[k].push(c)
  }

  const line = '─'.repeat(60)
  console.log(line)
  console.log(`[review] 审了 ${s.files_reviewed ?? 0} 个文件，得到 ${comments.length} 条发现`)
  console.log(`[review] tokens ${s.total_tokens ?? 0}（缓存命中 ${s.cache_read_tokens ?? 0}）· 耗时 ${s.elapsed ?? '?'} · 工具调用 ${doc.tool_calls?.total ?? 0} 次（失败 ${doc.tool_calls?.failure ?? 0}）`)

  if (comments.length === 0) {
    console.log('[review] 真审了，这一批没有达到阈值的发现。（不是「没审」）')
  } else {
    const parts = SEVERITY_ORDER.filter((k) => bySev[k].length > 0).map((k) => `${k}=${bySev[k].length}`)
    console.log(`[review] 严重度：${parts.join(' ')}`)
    console.log(line)
    for (const k of SEVERITY_ORDER) {
      for (const c of bySev[k]) {
        const hasLine = c.start_line !== null && c.start_line !== undefined
        // 无行号时给 'L?'：ocr 有些 finding 是文件级的，没有 start_line。
        let range = 'L?'
        if (hasLine) {
          range = c.start_line === c.end_line ? `L${c.start_line}` : `L${c.start_line}-${c.end_line}`
        }
        console.log(`\n[${k}/${c.category ?? '?'}] ${c.path}:${range}`)
        console.log(String(c.content ?? '').split('\n').map((l) => `  ${l}`).join('\n'))
      }
    }
    console.log(`\n${line}`)
  }
  console.log(`[review] 原始 JSON（含源码片段，注意留存）：${ocrOut}`)
  if (args.out) console.log(`[review] 副本：${path.resolve(process.cwd(), args.out)}`)
  return EXIT.complete
}

process.exitCode = main()
