// lib/memory-audit.mjs — 记忆的机械体检
//
// 为什么需要这个文件：`state` 字段（current / superseded / contradicted / dropped）
// 加进 schema 之后一直是空的，因为**没有任何代码写它**。而「哪条记忆被哪条取代了」
// 是语义判断 —— 记忆库一旦自动做语义判断，就会生成用户没说过的话，那正是这个插件
// 从第一天起拒绝的事（见 README「刻意不做静默自动写入」与 lib/memory.mjs 里
// applyMemoryMeta 的注释）。
//
// 所以这里只做**机械能验的**那一半，并且严格区分两件事：
//
//   能自动的：这条记忆里写的路径还在不在、复核点过没过。这些答案来自文件系统与
//             日历，不是来自我的判断；就算我判错了，也能拿一条命令复现。
//   不能自动的：「这句话现在还算不算数」「新的那条有没有推翻旧的」。这需要理解语义，
//             而理解语义就等于替用户下结论。这一半永远留给用户，代码只负责把
//             「哪些条目值得你复核」摆出来，并附上可以直接复制的命令。
//
// 因此本文件的输出一律叫「体检结果」，不叫「判定」；每条建议都带 evidence，
// 且调用方不得在没有用户动作的情况下写盘（见 index.mjs 的 /memory/audit 路由）。

/** 一条记忆最多取多少个路径去探 —— 防止有人在一条记忆里塞一百个路径把磁盘打爆。 */
export const MAX_PATHS_PER_MEMORY = 8

/** Windows 盘符路径 / UNC 路径。刻意只认 Windows 形态：本插件的用户数据全在这台机器上。 */
const WIN_PATH = /(?:[A-Za-z]:[\\/]|\\\\)[^\s，。；、）)\]】》」"'`|]+/g

/** 路径里出现这些字符说明它是个占位样板，不是一个真实路径。 */
const PLACEHOLDER = /[<>{}*?]/

/** 去掉路径尾部的标点：中文标点常紧跟路径，不剥掉就永远探不到。 */
function trimPath(raw) {
  let s = String(raw ?? '').trim()
  // 成对括号可能被正则一起吃进来（例如 `（D:\a\b）` 的右括号），从尾部反复剥。
  // 尾部的分隔符 `\` `/` 也要剥：样板路径切出来的前缀会以分隔符结尾，
  // 而 `existsSync('D:\\a\\b\\')` 与 `existsSync('D:\\a\\b')` 虽然等价，
  // 写进报告的路径却会多一个尾巴，用户复制去手测时容易怀疑是不是自己看错了。
  while (s.length > 0 && /[，。；：、）)\]】》」"'`,.;:!?\\/]/.test(s.slice(-1))) s = s.slice(0, -1)
  return s
}

/**
 * 从一条记忆里取出所有「看起来是路径」的片段。
 *
 * 为什么要带占位符的路径单独标出来：`D:\c\VC\Tools\MSVC\<版本号>\bin\...` 里
 * `<版本号>` 是用户自己记得的样板，不是磁盘上真实的目录名。直接拿去探必然 false，
 * 那会产出一条假警报 —— 而假警报比不检查更糟，它会让用户学会无视整份报告。
 * 正确做法是探它前面的真实前缀，并把「这条是样板」如实说出来。
 *
 * @param {string} text
 * @returns {{raw:string, path:string, templated:boolean}[]}
 */
export function extractPaths(text) {
  return extractPathsWithStats(text).paths
}

/**
 * extractPaths 的带统计版本。
 *
 * 为什么需要它：`MAX_PATHS_PER_MEMORY` 截断时，`extractPaths` 会**安静地**
 * 少还几个路径。调用方拿到一个 8 条的结果，无法分辨「这条记忆里只有 8 个路径」
 * 和「有 20 个，只查了前 8 个」。两种情况下体检报告长得一模一样 —— 都是
 * 「查了、没发现问题」，而后者实际上有 12 个路径从来没被探过。
 *
 * 这正是「不许让没查长得像查过没事」在这份报告里的具体形态：假阴性比假阳性
 * 更难发现，因为它什么都不显示。
 *
 * 保留 `extractPaths` 原来的签名（返回数组）是因为它已经被测试与调用方依赖，
 * 改形状会牵连一串；统计另走一个函数，两者共用同一份实现。
 *
 * @param {string} text
 * @returns {{paths: {raw:string, path:string, templated:boolean}[], total:number, truncated:boolean, dropped:number}}
 *   total 是**匹配到的路径总数**（截断前），dropped = total - paths.length。
 */
export function extractPathsWithStats(text) {
  const body = String(text ?? '')
  const out = []
  const seen = new Set()
  let total = 0
  for (const match of body.matchAll(WIN_PATH)) {
    const raw = trimPath(match[0])
    if (!raw) continue
    const templated = PLACEHOLDER.test(raw)
    // 样板路径只探占位符之前的那一段：`D:\c\VC\Tools\MSVC\<版本号>\...` → `D:\c\VC\Tools\MSVC`
    const probePath = templated ? trimPath(raw.split(PLACEHOLDER)[0]) : raw
    if (!probePath || probePath.length < 3) continue
    // 只有盘符（`D:\`）没有信息量，探它永远是 true。
    if (/^[A-Za-z]:[\\/]?$/.test(probePath)) continue
    if (seen.has(probePath)) continue
    seen.add(probePath)
    // 先去重再计数：total 要表达的是「有多少个不同的路径值得探」，
    // 而不是「正则匹配了多少次」—— 同一条路径在一句记忆里出现三次，
    // 报「还有 2 个没查」是假警报。
    total += 1
    if (out.length >= MAX_PATHS_PER_MEMORY) continue
    out.push({ raw, path: probePath, templated, at: match.index, end: match.index + match[0].length })
  }
  return {
    paths: out,
    total,
    truncated: total > out.length,
    dropped: Math.max(0, total - out.length)
  }
}

/**
 * 路径里带空格时，正则会在第一个空格处截断。
 *
 * `D:\Windows Kits` 会被截成 `D:\Windows`，而后者不存在 —— 于是产出一条
 * 「记忆里写的路径已经不存在」的假警报。**假警报比不检查更糟**：它会让用户
 * 学会无视整份报告，那时真警报也一起失效了。
 *
 * 修法不是「把空格也吃进正则」（那会把后面的中文整段吞掉），而是：
 * 只有当**延长后的路径确实在磁盘上存在**时才采用它。延长必须由文件系统证实，
 * 不是由我猜 —— 这样既不会误报，也不会凭空造出一个路径。
 */
function extendToExisting(text, candidate, endIndex, checkPath) {
  let rest = text.slice(endIndex)
  let current = candidate
  for (let i = 0; i < 4; i += 1) {
    const piece = /^[ \t][A-Za-z0-9_.\-\\/]+/.exec(rest)
    if (!piece) return null
    current += piece[0]
    rest = rest.slice(piece[0].length)
    if (checkPath(current) === true) return current
  }
  return null
}

/**
 * 体检一组记忆。
 *
 * @param {object[]} records 全量记忆（只查 status==='adopted' 的）
 * @param {object} options
 * @param {(p:string)=>boolean} options.probe 路径是否存在。注入而不是直接 import fs：
 *   这样单测可以喂一个纯函数，不必依赖这台机器上真实有什么。
 * @param {Date} [options.now]
 * @returns {{checked:number, flagged:object[], clean:number, note:string}}
 */
export function auditMemories(records, { probe, now = new Date() } = {}) {
  const list = Array.isArray(records) ? records.filter((r) => r?.status === 'adopted') : []
  const today = now.toISOString().slice(0, 10)
  const checkPath = typeof probe === 'function' ? probe : () => true
  const flagged = []
  let clean = 0
  // 截断统计：只要有一条记忆的路径被截断了，整份报告就必须说清「还有 N 个没查」。
  // 不说的话，报告读起来就是「全查过了，没问题」—— 而实际上有没查的部分。
  let truncatedRecords = 0
  let truncatedPaths = 0

  for (const record of list) {
    const findings = []

    // ① 路径存在性：答案来自磁盘，不来自我。
    const pathScan = extractPathsWithStats(record.text)
    if (pathScan.truncated) {
      truncatedRecords += 1
      truncatedPaths += pathScan.dropped
      findings.push({
        kind: 'paths-truncated',
        detail: `这条记忆里有 ${pathScan.total} 个不同的路径，单条最多只查 ${MAX_PATHS_PER_MEMORY} 个，`
          + `还有 ${pathScan.dropped} 个**没有检查**。别把这份结果当成「全部路径都在」`,
        evidence: `extractPathsWithStats：total=${pathScan.total} checked=${pathScan.paths.length} dropped=${pathScan.dropped}`
      })
    }
    for (const p of pathScan.paths) {
      let exists = false
      try {
        exists = checkPath(p.path) === true
        // 截断的路径先别急着报「不存在」：它可能只是被空格切断了
        // （`D:\Windows Kits` → `D:\Windows`）。只有当延长后的真实路径确实存在时
        // 才采信，这一步由文件系统证实，不是由我猜。
        if (!exists && !p.templated) {
          const longer = extendToExisting(record.text, p.path, p.end, checkPath)
          if (longer) exists = true
        }
      } catch {
        // 探针本身抛错（权限、非法字符）不能算「不存在」—— 那会把「我查不到」
        // 说成「它没有了」，正是用户最烦的那种糊弄。
        findings.push({
          kind: 'path-unprobed',
          detail: `探不到「${p.path}」：探测时出错，无法判断它还在不在`,
          evidence: `probe(${JSON.stringify(p.path)}) threw`
        })
        continue
      }
      if (!exists) {
        if (p.templated) {
          findings.push({
            kind: 'path-prefix-missing',
            detail: `这条记忆里的路径样板，前缀「${p.path}」已经不存在了`,
            evidence: `fs.existsSync(${JSON.stringify(p.path)}) === false（原样 ${p.raw}）`
          })
        } else {
          findings.push({
            kind: 'path-missing',
            detail: `记忆里写的路径「${p.path}」现在已经不存在`,
            evidence: `fs.existsSync(${JSON.stringify(p.path)}) === false`
          })
        }
      }
    }

    // ② 复核点过期：答案来自日历，不来自我。
    const verify = String(record.verifyAt ?? '').slice(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(verify) && verify < today) {
      findings.push({
        kind: 'verify-expired',
        detail: `复核点是 ${verify}，已经过去了 —— 这条是不是还成立，只有你知道`,
        evidence: `verifyAt=${verify} < today=${today}`
      })
    }

    if (findings.length === 0) {
      clean += 1
      continue
    }

    // 建议状态：只给「事实已经不成立」的那两类。复核点过期只提示，不建议改状态 ——
    // 「过没过期」是日历说的，「还算不算数」得用户说。
    const hasMissing = findings.some((f) => f.kind === 'path-missing' || f.kind === 'path-prefix-missing')
    flagged.push({
      id: record.id,
      text: record.text,
      type: record.type,
      state: record.state,
      capturedAt: record.capturedAt,
      verifyAt: record.verifyAt,
      findings,
      suggestion: hasMissing
        ? {
            state: 'contradicted',
            why: '这条记忆指向的东西已经不在了；标成「有争议」后，注入时会写明它可能不成立，而不是照旧当真',
            command: `/anima mark ${record.id} state=contradicted`
          }
        : {
            state: null,
            why: '只有复核点过期。要不要标「可能已过时」由你决定，代码不替你判',
            command: `/anima mark ${record.id} state=contradicted`
          }
    })
  }

  return {
    checked: list.length,
    flagged,
    clean,
    // 截断的显式告知。放在顶层而不是只埋在 flagged 里，是因为它是**关于这份
    // 报告本身**的事实，不是某一条记忆的问题：读者看汇总就要知道「没查全」。
    truncated: {
      records: truncatedRecords,
      paths: truncatedPaths,
      limit: MAX_PATHS_PER_MEMORY,
      note: truncatedRecords === 0
        ? ''
        : `有 ${truncatedRecords} 条记忆的路径数超过单条上限 ${MAX_PATHS_PER_MEMORY}，`
          + `合计 ${truncatedPaths} 个路径**这次没有检查**。`
          + `「没报问题」在这些条上不等于「没有问题」。`
    },
    note: '这份体检只做两件机械能验的事：路径还在不在、复核点过没过。'
      + '「这句话还算不算数」需要理解语义，代码不判 —— 那等于替用户下结论。'
      + '所有状态都不会被自动修改，每条建议都得你自己点一次。'
  }
}
