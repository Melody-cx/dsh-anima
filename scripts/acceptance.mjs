// 一次性把「这套东西现在到底能保证什么」验完，并如实列出「没保证什么」。
//
// 为什么要有这个文件：能力一块块加进来之后，最容易发生的不是功能坏掉，而是**没人知道
// 现在到底算不算能用**。前面几轮里我自己就犯过两次：把「没出现提醒」当成「没问题」，
// 把「测试全绿」当成「功能正确」。验收脚本存在的意义就是把这类推断变成可复跑的判定。
//
// 设计上刻意遵守三条：
//   1. 能自己算的绝不引用别人的结论（文件哈希、规则清单、存储字段覆盖都当场重算）；
//   2. 子进程一律 stdio:'inherit' —— 只要退出码，不让它把输出吞掉（沙箱下管道不可用，
//      而且用户应该看见每一套测试的真实输出）；
//   3. 最后必须打印「本次没验什么」，且 PASS 不等于「十二条全过」。
//
// 用法：
//   node scripts/acceptance.mjs                      # 只验静态与单测
//   node scripts/acceptance.mjs --url http://127.0.0.1:<PORT>
//   node scripts/acceptance.mjs --url ... --since 2026-10-20T01:12:20+08:00
//       加 --url 会额外验运行态（配置、提示词段、钩子活性、记忆字段覆盖）。
//       --since 是宿主重启时刻；不给就只能落 UNDETERMINED，不会冒充通过。
//
// 退出码：0 = 所有「必要条件」都过；1 = 有必要条件没过；2 = 参数错。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as quality from '../lib/quality.mjs'

// 必须用 fileURLToPath，不能用 new URL(...).pathname：
// 后者会把中文目录名做百分号编码（D:\deepseek工作区 → D:\deepseek%E5%B7%A5...），
// 于是 ROOT 变成一个不存在的路径，spawn 全部返回 null，而汇总只会说「退出码 null」——
// 看起来像测试挂了，实际是脚本自己找不到路。这个 bug 在第一次跑的时候真的发生了。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const NODE = process.execPath

function parseArgs(argv) {
  const out = { url: null, since: 0, quiet: false, installed: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--url') { out.url = argv[++i]; continue }
    if (a.startsWith('--url=')) { out.url = a.slice(6); continue }
    if (a === '--since') { out.since = Date.parse(argv[++i]); continue }
    if (a.startsWith('--since=')) { out.since = Date.parse(a.slice(8)); continue }
    if (a === '--installed') { out.installed = argv[++i]; continue }
    if (a.startsWith('--installed=')) { out.installed = a.slice(12); continue }
    if (a === '--quiet') { out.quiet = true; continue }
    if (a === '-h' || a === '--help') { out.help = true; continue }
    out.unknown = a
  }
  return out
}

const results = [] // {id, name, kind:'must'|'should'|'report', ok, detail}
const add = (id, name, kind, ok, detail) => results.push({ id, name, kind, ok, detail })
const note = (id, name, detail) => results.push({ id, name, kind: 'report', ok: null, detail })

/**
 * 跑一个子脚本，只要退出码。
 * stdio:'inherit' 是刻意的：沙箱里管道会 EPERM，而且把输出吞掉之后
 * 一旦失败就没法看是哪一条挂的 —— 那正是「测了但说不清」。
 */
function runScript(relPath, argv, id, name, kind = 'must') {
  if (!args.quiet) console.log(`\n──── ${name} ────`)
  const r = spawnSync(NODE, [path.join(ROOT, relPath), ...(argv ?? [])], {
    cwd: ROOT, stdio: 'inherit'
  })
  const code = r.status
  const ok = code === 0
  // 失败时把 signal 也带上：被信号杀掉时 status 是 null，只写退出码会写成「退出码 null」。
  let detail = `退出码 ${code}`
  if (ok) detail = '退出码 0'
  else if (r.signal) detail = `退出码 ${code} signal=${r.signal}`
  add(id, name, kind, ok, detail)
  return ok
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('用法：node scripts/acceptance.mjs [--url http://127.0.0.1:PORT] [--since ISO] [--installed PATH] [--quiet]')
  process.exit(0)
}
if (args.unknown) {
  console.error(`不认识的参数：${args.unknown}`)
  process.exit(2)
}

console.log('=== dsh-anima 验收 ===')
console.log(`脚本位置：${ROOT}`)
console.log(`时间：${new Date().toISOString()}`)

// ==================== 一、单测与回归 ====================
runScript('scripts/verify-core.mjs', [], 'verify-core', '核心单测（含误报回归 / 字段 / 对账）')
runScript('scripts/smoke-host.mjs', [], 'smoke-host', '宿主侧冒烟（含钩子、命令、路由）')
runScript('scripts/smoke-client.mjs', [], 'smoke-client', '客户端渲染冒烟（含保存载荷）')
runScript('scripts/check-client-i18n.mjs', [], 'i18n', '客户端字典 zh/en 对称')
runScript('test/run-m0.mjs', [], 'fixtures', 'M0 十二条样例（可判定部分）')

// ==================== 二、判据自身的完整性 ====================
//
// 这一段防的是最阴的一种腐坏：quality.mjs 被人删掉两条规则、或把 UNCOVERABLE 改短，
// 所有测试照旧全绿，而「未查」清单悄悄变短了 —— 那等于把没查说成查了。
const ids = quality.QUALITY_RULES.map((r) => r.id)
const expectIds = Array.from({ length: 12 }, (_, i) => `R${String(i + 1).padStart(2, '0')}`)
add('rules-12', '十二条齐全且编号连续', 'must',
  JSON.stringify(ids) === JSON.stringify(expectIds),
  `实际 ${ids.join(',')}`)

const uncovered = [...quality.UNCOVERABLE_RULES].sort()
const expectUncovered = ['R03', 'R05', 'R06', 'R07', 'R10']
add('uncoverable-5', '「机器判不了」清单为且仅为 5 条', 'must',
  JSON.stringify(uncovered) === JSON.stringify(expectUncovered),
  `实际 ${uncovered.join(',')}`)

// 「未查」清单必须真的出现在判词里，否则提醒正文会看起来像「全查了」。
const saysUncovered = quality.UNCOVERABLE_RULES.every((id) => {
  const rule = quality.QUALITY_RULES.find((r) => r.id === id)
  return rule?.catchMode === 'human'
})
add('uncoverable-honest', '被列为判不了的规则，catchMode 确实是 human', 'must',
  saysUncovered, saysUncovered ? '一致' : '有规则自相矛盾')

// 提示词段必须包含让模型别自称「通过」的那句。删掉它等于悄悄取消这条红线。
const ledgerRules = quality.compileLedgerRules('three')
const qualityRules = quality.compileQualityRules()
add('prompt-honesty', '提示词里写明「未查」不能省且禁止「已检查，无异常」', 'must',
  ledgerRules.includes('未查') && /已检查.*无异常/.test(ledgerRules),
  `ledgerRules ${ledgerRules.length} 字`)
// 只检查「有没有写机器判不了」是不够的：写死一个错的名单同样能通过。
// 踩过的坑：提示词写死四条（R03/R05/R06/R07），UNCOVERABLE_RULES 算出五条（多 R10），
// 旧断言只 grep 「判不了」四个字，全绿。现在要求提示词里那条句子逐字等于现算结果。
const uncoverableSentenceOk = (() => {
  const want = `其中 ${quality.UNCOVERABLE_RULES.join(' / ')} 机器判不了`
  return qualityRules.includes(want)
})()
add('prompt-uncoverable', '提示词里写明哪几条机器判不了', 'must', uncoverableSentenceOk,
  `qualityRules ${qualityRules.length} 字；应为 ${quality.UNCOVERABLE_RULES.join('/')}`)

// 对账三档必须真的能各自命中，且 'off' 真的关掉 —— 否则「全开」是假的。
const tierProbe = [
  ['tier1', '共 7 个源文件'],
  ['tier2', '已确认全部通过'],
  ['tier3', '据官方文档可知，限制是每分钟 60 次']
]
const tierOk = tierProbe.every(([, text]) => quality.detectLedgerTriggers(text, 'three').needed)
add('tiers-work', '对账三档各自都能被触发', 'must', tierOk,
  tierProbe.map(([k]) => k).join('/'))
add('tier-off', "ledgerLevel='off' 时一条都不触发", 'must',
  tierProbe.every(([, text]) => quality.detectLedgerTriggers(text, 'off').needed === false), '')

// ==================== 三、源码与安装副本是否一致 ====================
//
// 这一项存在的理由：改完源码不等于插件变了。profile 里是真目录副本，
// 不重跑同步就是「装好了但没通电」，而界面上完全看不出来。
const srcDir = ROOT
// 安装副本目录：优先 --installed，其次 DSH_HOME，最后用户主目录下的 .dsh。
// 这里的兜底原本写死了开发机的用户名，换台机器就会指向一个不存在的目录，
// 于是「源码与安装副本一致」这一项会在「安装副本不存在」和「真不一致」之间含混。
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const instDir = args.installed
  ?? path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-anima')

// 清单必须从源码树自动推导，不能写死。
// 第一版写死了 15 个文件，而 _sync_install.cjs 实际同步 32 个 —— 中间 17 个文件
// 漏同步永远不会被发现，而这一项的名字还叫「源码与安装副本一致」。
// 判据写死的那天起，它就不再检验现实，只检验自己的清单。
//
// 第二版的教训更贵：清单从「写死的 15 个」改成「扫全树」之后，这一项
// 反而**永远红**。因为扫描把 docs/、scripts/、test/、pnpm-lock.yaml 全算进去了，
// 而 package.json 的 `files` 字段根本不发布它们 —— 安装副本里永远不可能有，
// 于是「不一致」是一次结构性误报，不是一次真回归。
// 一个永远红的闸门等于没有闸门：人看一眼就学会忽略它。
//
// 现在以 package.json 的 `files` 为唯一事实来源：发布什么就比什么。
// 新增目录若也想被比，就去 package.json 里声明，而不是在这里偷偷放行。
const SKIP_DIRS = new Set(['node_modules', '.git', '.install-backup'])
const PUBLISHED = (() => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const entries = Array.isArray(pkg.files) ? pkg.files : []
  const out = new Set()
  for (const raw of entries) {
    const rel = String(raw).replace(/^\.\//, '').replace(/\/$/, '')
    const abs = path.join(ROOT, rel)
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      for (const name of fs.readdirSync(abs)) {
        out.add(`${rel}/${name}`)
      }
    } else {
      out.add(rel)
    }
  }
  return out
})()
/** 一个相对路径是否落在 package.json `files` 声明的发布集合内。 */
function isPublished(rel) {
  if (PUBLISHED.has(rel)) return true
  for (const p of PUBLISHED) {
    if (rel.startsWith(`${p}/`)) return true
  }
  return false
}
const SYNC_FILES = (function walk(dir, prefix = '') {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue
      out.push(...walk(path.join(dir, ent.name), rel))
      continue
    }
    if (!/\.(mjs|cjs|js|json|yml|yaml|md)$/.test(ent.name)) continue
    if (!isPublished(rel)) continue
    out.push(rel)
  }
  return out
})(ROOT)

if (!fs.existsSync(instDir)) {
  add('parity', '源码与安装副本一致', 'must', false, `安装副本不存在：${instDir}`)
} else {
  const crypto = await import('node:crypto')
  const hashOf = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
  const missing = []
  const differ = []
  let same = 0
  for (const rel of new Set(SYNC_FILES)) {
    const a = path.join(srcDir, rel)
    const b = path.join(instDir, rel)
    if (!fs.existsSync(b)) { missing.push(rel); continue }
    if (!fs.existsSync(a)) { missing.push(`${rel}(源码缺)`); continue }
    if (hashOf(a) === hashOf(b)) same += 1
    else differ.push(rel)
  }
  const ok = missing.length === 0 && differ.length === 0
  add('parity', '源码与安装副本逐文件哈希一致', 'must', ok,
    ok ? `${same} 个文件全部一致` : `缺 ${missing.join(',') || '无'}；不一致 ${differ.join(',') || '无'}`)

  // 安装副本的 mtime 必须早于运行中的进程，否则这一版根本没被加载。
  let newest = 0
  for (const rel of new Set(SYNC_FILES)) {
    const b = path.join(instDir, rel)
    if (fs.existsSync(b)) newest = Math.max(newest, fs.statSync(b).mtimeMs)
  }
  note('installed-mtime', '安装副本最新修改时刻', new Date(newest).toISOString())
}

// ==================== 三·五、设置页质检 UI 的存在性（静态） ====================
//
// 这里只证明「代码里有这段 UI」，不证明「浏览器里画得出来」——后者需要人看一眼。
// 之所以仍然要验：设置页卡片是这一层唯一的当场刹车，它被某次重构悄悄删掉时，
// 所有其它测试都会照样全绿（宿主侧完全感觉不到界面缺了一块）。
//
// 判据从源码文本取，不 import 客户端模块（它依赖 window.__ModuleLoader__ 与 react）。
{
  const clientPath = path.join(ROOT, 'client', 'index.mjs')
  const src = fs.existsSync(clientPath) ? fs.readFileSync(clientPath, 'utf8') : ''
  // 判据用纯子串，不写 `id: '...'`：Toggle 传的是不带前缀的 props.id（组件内部加 an-），
  // 而 select / input 直接写最终的 `an-quality-*`。两种形状在一处源码里同时存在，
  // 第一版判据只认其中一种，于是把「控件齐全」判成了「缺两个」——判据写死比没写更糟。
  const need = ['quality-enabled', 'quality-ledger', 'quality-strict', 'quality-precheck', 'quality-max']
  const missing = need.filter((s) => !src.includes(s))
  // 三种缺法要分开说：读不到源码 / 缺控件 / 齐全。挤成一个三元没人看得懂哪一种是哪种。
  let uiDetail = '五个控件齐全'
  if (src.length === 0) uiDetail = 'client/index.mjs 读不到'
  else if (missing.length > 0) uiDetail = `缺 ${missing.join(' / ')}`
  add('client-quality-ui', '设置页质检卡片的五个控件都在源码里', 'must',
    src.length > 0 && missing.length === 0,
    uiDetail)

  // 载荷必须带 quality 段：只画控件不提交，就是「能改却存不下」那个老 bug 的形状。
  add('client-quality-payload', '保存载荷里带 quality 段（不是只画了控件）', 'must',
    src.includes('quality: qualityDefaults(source)'),
    src.includes('quality: qualityDefaults(source)') ? '已在 configPayload 内' : 'configPayload 里没有 quality')

  // 两个词典都得有这套 key。只验「行数是偶数」不够：全塞在 zh 里也是偶数。
  // 所以按 key 统计出现次数，要求每个 key 恰好出现两次（zh 一次、en 一次）。
  //
  // 但计数必须**只在词典体内**做。第一版这条正则在整份 client/index.mjs 上跑，
  // 于是 AUDIT_FIELD_KEY 里那几行 `'quality.enabled': 'field.quality.enabled'`
  // （改动记录的字段名映射表，不是词典）也被算了进去：四个键变成 ×3、
  // 而 `quality.maxFindingsInReminder` 只存在于映射表、词典里叫 `quality.maxFindings`，
  // 于是报成 ×1。判据读起来是「文案不配对」，实际文案一条不缺 —— 这是判据的错，
  // 不是文案的错。改成先切出两个词典体，再在体内计数。
  const dictBody = (name) => {
    const start = src.indexOf(`const ${name} = {`)
    if (start < 0) return ''
    const lines = src.slice(start).split('\n')
    let depth = 0
    for (let i = 0; i < lines.length; i += 1) {
      for (const ch of lines[i]) {
        if (ch === '{') depth += 1
        else if (ch === '}') {
          depth -= 1
          if (depth === 0) return lines.slice(0, i + 1).join('\n')
        }
      }
    }
    return ''
  }
  const zhDict = dictBody('zh')
  const enDict = dictBody('en')
  const keysIn = (body) => {
    const out = new Set()
    for (const m of body.matchAll(/^\s*['"](quality\.[A-Za-z0-9_.]+)['"]\s*:/gm)) out.add(m[1])
    return out
  }
  const zhKeys = keysIn(zhDict)
  const enKeys = keysIn(enDict)
  const counts = new Map()
  for (const key of zhKeys) counts.set(key, (counts.get(key) ?? 0) + 1)
  for (const key of enKeys) counts.set(key, (counts.get(key) ?? 0) + 1)
  // 只在一边出现的键，计数值是 1 —— 与「同一侧写了两遍」同样是坏形状，都要报出来。
  const badI18n = [...counts].filter(([, n]) => n !== 2).map(([k, n]) => `${k}×${n}`)
  let i18nDetail = `${counts.size} 个 key 各两份`
  if (counts.size === 0) i18nDetail = '源码里找不到任何 quality.* 词典条目'
  else if (badI18n.length > 0) i18nDetail = `不配对：${badI18n.join(', ')}`
  add('client-quality-i18n', '质检文案的每个 key 在 zh/en 两侧各一份', 'must',
    counts.size > 0 && badI18n.length === 0,
    i18nDetail)
}

// ==================== 四、运行态（需要 --url） ====================
if (!args.url) {
  note('live', '运行态检查', '未给 --url，跳过（这不是通过，是没验）')
} else {
  const base = args.url.replace(/\/$/, '')
  let state = null
  try {
    const res = await fetch(`${base}/api/anima/state`)
    state = await res.json()
    add('live-state', '宿主 /api/anima/state 可读', 'must', res.ok && state?.ok === true,
      `HTTP ${res.status}`)
  } catch (err) {
    add('live-state', '宿主 /api/anima/state 可读', 'must', false, String(err?.message || err))
  }

  if (state) {
    add('live-loaded', '插件已装载（loaded）', 'must', state.loaded === true, `loaded=${state.loaded}`)
    const q = state?.config?.quality
    add('live-quality', '质量配置已生效（五项俱全）', 'must',
      Boolean(q && typeof q.enabled === 'boolean' && typeof q.ledgerLevel === 'string'),
      JSON.stringify(q ?? null))

    // 运行计数：没有它，设置页只能显示「宿主还没下发」，而用户会把它读成
    // 「没有提醒 = 没有问题」—— 那正是这一整套要防的误读。
    const qs = state?.qualityStats
    add('live-stats', '宿主下发了质检运行计数（checks 是数字）', 'must',
      Boolean(qs && typeof qs.checks === 'number'),
      qs ? `checks=${qs.checks} reminders=${qs.reminders}` : '没有 qualityStats 段')

    // 巡夜：只报有事之后，「没汇报」必须能反查成「真的没事」。
    // 没有 patrolMeta 这一项，沉默就同时代表「没事」和「没跑」—— 分不开。
    //
    // 注意：这一项在旧宿主上会红，而那正是它该做的事 —— 新代码没加载时
    // 不能装作已经具备反查能力。
    const pm = state?.patrolMeta
    add('live-patrol', '宿主下发了巡夜记录（沉默可反查的前提）', 'must',
      Boolean(pm && typeof pm.at === 'string' && typeof pm.reported === 'boolean'),
      pm ? `at=${pm.at} reported=${pm.reported} signature=${String(pm.signature).slice(0, 40)}`
        : '没有 patrolMeta 段（巡夜从未跑过，或宿主仍是旧代码）')

    // 提示词段：这是模型这一轮真正看到的东西，缺了等于规则没进上下文。
    try {
      const pv = await (await fetch(`${base}/api/anima/preview`)).json()
      const seg = pv?.sections?.quality
      const ok = typeof seg === 'string' && seg.length > 200
        && seg.includes('十二条') && seg.includes('【对账】') && seg.includes('不是你自己')
      add('live-prompt', '提示词里含十二条 + 对账 + 「不是你自己」', 'must', ok,
        typeof seg === 'string' ? `${seg.length} 字` : '没有 quality 段')
    } catch (err) {
      add('live-prompt', '提示词里含十二条 + 对账 + 「不是你自己」', 'must', false, String(err?.message || err))
    }

    // 记忆字段的真实覆盖度：字段加进 schema 不等于数据里有值。
    const adopted = state?.memories?.adopted ?? []
    const cov = (k) => adopted.filter((r) => r[k] !== undefined && r[k] !== null).length
    const total = adopted.length
    note('field-coverage', '已采纳记忆的字段覆盖',
      total === 0
        ? '没有已采纳记忆'
        : `共 ${total} 条：type ${cov('type')} / state ${cov('state')} / verifyAt ${cov('verifyAt')} / sourceRef ${cov('sourceRef')}`)
    if (total > 0 && cov('type') === 0) {
      add('field-typed', '已采纳记忆至少有一部分带类型', 'should', false,
        `0/${total} 带 type —— 字段是空壳，注入时的分类标注不会出现`)
    } else if (total > 0) {
      add('field-typed', '已采纳记忆至少有一部分带类型', 'should', true, `${cov('type')}/${total}`)
    }

    // 钩子活性：交给既有脚本，它自己的判词比这里复写一份可靠。
    if (args.since > 0) {
      runScript('scripts/check-hook.mjs', ['--url', base, '--since', new Date(args.since).toISOString()],
        'hook', '质检钩子活性（与计数器交叉核对）', 'must')
    } else {
      runScript('scripts/check-hook.mjs', ['--url', base],
        'hook', '质检钩子活性（未给 --since，只能落 UNDETERMINED）', 'should')
    }

    runScript('scripts/check-live.mjs', [base], 'check-live', '路由与护栏（check-live）')
  }
}

// ==================== 五、汇总 ====================
const musts = results.filter((r) => r.kind === 'must')
const shoulds = results.filter((r) => r.kind === 'should')
const mustFailed = musts.filter((r) => r.ok !== true)
const shouldFailed = shoulds.filter((r) => r.ok !== true)

console.log('\n\n=== 验收汇总 ===')
const pad = (s, n) => String(s).padEnd(n)
for (const kind of ['must', 'should', 'report']) {
  const group = results.filter((r) => r.kind === kind)
  if (!group.length) continue
  const kindLabel = { must: '必要条件', should: '应当满足', report: '观察项' }
  const label = kindLabel[kind] ?? '观察项'
  console.log(`\n[${label}]`)
  for (const r of group) {
    // 观察项一律打 '·'：它没有通过/失败语义，标成 FAIL 会让人以为要修。
    let mark = 'FAIL'
    if (r.kind === 'report') mark = '·'
    else if (r.ok === true) mark = 'ok'
    console.log(`  ${pad(mark, 4)} ${pad(r.id, 16)} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
  }
}

console.log('')
if (mustFailed.length === 0) {
  console.log(`必要条件 ${musts.length} 项全部通过${shouldFailed.length ? `；但有 ${shouldFailed.length} 项「应当满足」没满足` : ''}。`)
} else {
  console.log(`必要条件有 ${mustFailed.length} 项没过：${mustFailed.map((r) => r.id).join(', ')}`)
}

// 这一段落必须存在且必须难看：任何「验收通过」的结论都不能被读成「能力齐了」。
console.log('')
console.log('=== 本次没验什么（不是免责，是给你反查用的） ===')
console.log(`  · ${quality.UNCOVERABLE_RULES.join('、')}：机器判不了，只能由人看`)
console.log('  · 内容是否正确：判词只看形状（有没有对账块、有没有来源），不看内容对不对')
console.log('  · 记忆状态机：只能手动改（/anima mark <id> supersededBy=… 或 state=…）；「哪条被哪条取代」没有任何代码自动判定，全凭你或我当场说明')
// 这一行曾经写着「client 里没有 quality 的 UI」——那句话在加完设置页卡片之后就变成了假的，
// 而验收脚本的「没验什么」最不该出现的就是过期事实：读者会据此以为某一项还不存在。
console.log('  · 设置页质检卡片：只能证明代码里有这段 UI（见 client-quality-ui 一项），不能证明浏览器里渲染正常')
console.log('  · 巡夜的判据：只验了 lib/patrol.mjs 这套纯函数与「宿主下发了 patrolMeta」，没验过「连着几晚真的只有该报的那晚才报」——那需要真实时间流过')
console.log('  · 巡夜汇报是否真的被模型看见：注入到会话的是消息，模型有没有照它行事，机器测不出来')
console.log('  · 真实对话里会不会太吵：只有你连续用几天才知道，任何测试都替代不了')
if (!args.url) console.log('  · 整个运行态：没给 --url，一项都没验')

console.log('')
console.log('结论口径：本脚本只能证明「上面这些检查确实执行过且结果是那样」，')
console.log('不能证明「这套东西有用」。两者是不同的东西。')

process.exit(mustFailed.length === 0 ? 0 : 1)
