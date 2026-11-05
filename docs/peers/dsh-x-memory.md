# dsh-x-memory（★766，DSH-X 内置件）—— 「冻结索引」这个设计只有它有

> 读取来源：`_research/dshx/`，走 `cdn.jsdelivr.net/gh/yyh-001/DSH-X@master/plugins/dsh-x-memory/`。
> 仓库 `yyh-001/DSH-X`，★**766**（GitHub API 2026-11-04 实测，`find_dsh_plugins` 报 769，差 3 条是抓取时点差）；整仓是桌面端产品（`src/server.js` 365KB），**记忆插件只是它的一个子件**（`plugins/dsh-x-memory/`）。
> 实读：`lib/index.js` 470 行 / 17247 B、`lib/store.js` 380 行 / 13582 B、`lib/tools.js`（只 grep）、`README.md` 93 行、`package.json`。
> **未读**：`lib/client.js`（20128 B 面板）、`test/store.test.mjs`、`test/tools.test.mjs`。

---

## 0. 一句话定位

**ZCode 那套「文件即记忆」的 DSH 移植版。** 一条事实一个 `.md` 文件 + 一份 `MEMORY.md` 索引，六把工具，索引在会话开始时注入。

它和我们是**两种不同的哲学**：我们是「用户点选 + 人工裁决」，它是「模型自己判断该不该记 + 六把工具」。**没有可比性，但有两个常数和一种机制值得抄。**

---

## 1. 「每会话冻结索引」—— 全生态只有它把这个做成开关

`lib/index.js:28-39`：

```js
/** 索引每会话只渲染一次：中途写记忆不改已经注入的内容，避免上下文抖动。 */
freezeIndexPerSession: true,
...
/** 每会话冻结索引的缓存上限（防长时间跑的服务内存慢慢涨）。 */
const SESSION_CACHE_MAX = 200
```

实现（`lib/index.js:229-251`）：

```js
ctx.systemPrompt.context({
  name: 'x-memory:index',
  order: 95,
  text: (assemble) => {
    // 渲染必须是同步且绝不抛：装配失败会带走整个回合。任何异常都降级成「不注入」。
    try {
      const cfg = config()
      if (!cfg.autoInject) return ''
      const agent = assemble?.agent
      const workspace = workspaceOf(agent)
      const key = sessionKeyOf(agent)
      if (cfg.freezeIndexPerSession && sessionIndex.has(key)) return sessionIndex.get(key)
      const store = storeForWorkspace(workspace)
      const body = store.indexForInjection({ maxLines: cfg.indexMaxLines, maxBytes: cfg.indexMaxBytes })
      const text = body ? `# 记忆索引\n\n工作区记忆目录：${store.rootDir}\n\n${body}` : ''
      if (cfg.freezeIndexPerSession) rememberSession(key, text)
      return text
    } catch (error) {
      logger.warn?.(`[dsh-x-memory] 索引注入失败：${error instanceof Error ? error.message : error}`)
      return ''
    }
  },
})
```

三个设计点：

1. **`freezeIndexPerSession` 默认 true**。理由写在 README（`:52`）："会话过半时新写的记忆不会改变已经注入的内容（对应 ZCode 的「索引每会话载入」；也避免上下文抖动）"。
2. **`SESSION_CACHE_MAX = 200` + 简单的 FIFO 淘汰**（`:215-218`）：「防长时间跑的服务内存慢慢涨」。
3. **`text` 函数体里的 try/catch 是硬要求**，注释原文：「装配失败会带走整个回合。任何异常都降级成「不注入」」。

### 对我们的意义

这和我们 `docs/peers/agent-soul.md` 里记的 `renderOnce` / `WeakMap` 记忆化是**同一件事的两种实现**（operator-memory 也有一份）。三个项目独立收敛，但**只有 DSH-X 把它做成了默认开的开关，且给了缓存上限**。

我们的 `memory` 段在 `index.mjs:114-117` 是静态 order 20 的 `section`，`text` 是每轮重的字符串拼接 —— 实际上**效果上已经等价于「每轮刷新」**，而且会打断前缀缓存。

但注意：`docs/soul-plan.md` 里已经论证过，「memory 段不能冻结」——因为我们的记忆是用户点选采纳的，用户刚点完就希望下一轮生效。**DSH-X 能冻结是因为它的记忆由模型自己写，用户不期待实时性。**

**可搬的不是冻结，是那个 200 的缓存上限和 try/catch。** 我们的 `compileMemory()` 在 `lib/prompt.mjs:189`，如果哪天加缓存，必须同时加淘汰。

---

## 2. 索引预算：200 行 / 25000 字节，**超限不静默**

`lib/store.js:23-24`：

```js
export const INDEX_MAX_LINES = 200
export const INDEX_MAX_BYTES = 25_000
```

`formatIndex` 的实现（`lib/store.js:133-157`）值得逐行看：

```js
export function formatIndex(entries, { maxLines = INDEX_MAX_LINES, maxBytes = INDEX_MAX_BYTES } = {}) {
  const lines = entries.map(formatIndexEntry)
  let text = lines.join('\n')
  let truncated = false
  if (lines.length > maxLines) {
    text = lines.slice(0, maxLines).join('\n')
    truncated = true
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {   // ← 按 UTF-8 字节数，不是 String.length
    let bytes = 0
    const kept = []
    for (const line of text.split('\n')) {
      const size = Buffer.byteLength(`${line}\n`, 'utf8')
      if (bytes + size > maxBytes - 200) break        // ← 留 200 字节余量给警告行
      bytes += size
      kept.push(line)
    }
    text = kept.join('\n')
    truncated = true
  }
  if (truncated) {
    text += `\n\n> WARNING: 记忆索引超过 ${maxLines} 行 / ${Math.round(maxBytes / 1024)}KB，只加载了一部分。请把内容拆进主题文件，索引每行保持一句话。`
  }
  return { text, truncated, count: entries.length }
}
```

**四个细节，我们一个都没有：**

1. **双预算（行数 + 字节）**，先到者截断。
2. **`Buffer.byteLength(…, 'utf8')`** —— 不是 `.length`。中文一字符 = 3 字节，用 `.length` 会低估三倍。这正是 dsh-mnemon 同一处踩过的坑（见 `essence-from-peers.md` §13）。
3. **`maxBytes - 200` 的余量**，留给超限警告行，否则警告本身会把字节数又顶破。
4. **超限时不静默** —— 追加一条可见的 WARNING 告诉模型「你只看到了一部分，把内容拆进主题文件」。

我们 `lib/config.mjs:79-80` 的 `maxInjectedChars: 4000` 是 **`String.length`** 口径（`lib/memory.mjs` 的 `selectForInjection` 里用 `.length` 累加）。**中文场景下这个 4000 实际是 12000 字节。** 这不是 bug（4000 字符对中文来说反而宽松），但**口径必须写清楚**，否则将来换成按字节算会突然砍掉三分之二。

**可搬的低成本改法**：`selectForInjection` 里加一个 `truncated` 标记，超预算时在注入段末尾追加一行「已截断 N 条」，而不是无声丢弃。我们现在是**静默截断**。

---

## 3. 检索：字段加权 + 全部词必须命中

`lib/store.js:307-336`：

```js
search(query, { limit = 8 } = {}) {
  const tokens = String(query ?? '').toLowerCase().split(/\s+/u).map((t) => t.trim()).filter(Boolean)
  if (tokens.length === 0) return []
  const hits = []
  for (const entry of this.scan()) {
    const title = ...toLowerCase(); const description = ...; const name = ...; const body = ...
    let score = 0
    let all = true
    for (const token of tokens) {
      let tokenScore = 0
      if (title.includes(token)) tokenScore += 5
      if (name.includes(token)) tokenScore += 4
      if (description.includes(token)) tokenScore += 3
      const occurrences = body.split(token).length - 1
      if (occurrences > 0) tokenScore += 1 + Math.min(occurrences, 4) * 0.5
      if (tokenScore === 0) { all = false; break }
      score += tokenScore
    }
    if (!all) continue
    hits.push({ ...entry, score, snippet: snippetFor(entry.body, tokens[0]) })
  }
  return hits.sort((l, r) => r.score - l.score || r.mtimeMs - l.mtimeMs).slice(0, Math.max(1, limit))
}
```

权重表：**标题 5 / 名字 4 / 描述 3 / 正文 1 + min(出现次数, 4) × 0.5**。

**关键设计：`all = false; break` —— 全部词必须命中，否则直接淘汰。** 这不是排序问题，是布尔门。

对照我们自己：`lib/memory.mjs` 的 `similarity()` 是字符级相似度（不是检索）。我们**根本没有检索**，靠 `maxInjected` 全量注入 40 条。当记忆从 0 条涨到 40 条时这是对的，**涨到 200 条就崩了**。

**这个字段加权表的数值没有来源标注**（没有实验、没有论文、没有 A/B），是拍的。但它**至少是有结构的拍**：标题比正文重要 5 倍，这个常识不需要实验支撑。

**不建议搬「全部词必须命中」**：中文用户的一句话查询（「上次那个插件」）拆词后大概率零命中。DSH-X 是英文语境设计（`.split(/\s+/)` 对中文等于只有一个 token）。

---

## 4. 它做对的一件我们该注意的事：**同步、绝不抛**

`lib/index.js:233` 那行注释值一整个设计原则：

> **渲染必须是同步且绝不抛：装配失败会带走整个回合。任何异常都降级成「不注入」。**

我们的 `lib/prompt.mjs` 的 `compileMemory` / `compilePersona` 里，如果 `memories` 数组里有一条格式不对（比如 `sourceRef` 是对象而不是字符串），会不会抛？我 grep 过 `lib/prompt.mjs`，**没有任何 try/catch**。

`lib/memory.mjs:530` 的 `selectForInjection` 也没有 try/catch。

**这是个真实的单点故障**：`anima.json` 里一条脏数据能让整个提示词装配失败，而装配失败 = 整个回合失败。我们的 `store.mjs` 有区域级校验（`:217-225`），但**校验只在写入时做，读出的数据没有二次防御**。

**这是本轮性价比最高的一条**：三处 try/catch（`compilePersona` / `compileMemory` / `selectForInjection`），每处一行 `return ''` 或 `return []` + 一条 warn 日志。**10 行代码，消灭一整类崩溃。**

---

## 5. 它的提示词纪律段（`GUIDANCE`）—— 699 字，纯静态

`lib/index.js:45-62`，注册为 `section`（**不是 context**），`order: 700`，`interpolate: false`。

内容是「什么时候写 / 不记什么 / 一条记忆 = 一条事实 / 保存前先查重 / 索引由工具维护不要手改」。

**注意：它用的是 `section` 不是 `context`。** 这和我们在 `essence-from-peers.md` §1 里「三个项目独立收敛到 context」的结论**矛盾**。

怎么解释：`section` 的 `text` 是**固定字符串**（`GUIDANCE` 常量），静态内容放 section 进前缀缓存是对的；`context` 的 `text` 是**函数**，用于每轮现算的动态内容。**DSH-X 两个都用，按「内容会不会变」分工。**

这个区分比「section 不好 context 好」精确得多。我们 `index.mjs:114-117` 四个段全是 `section`，其中 identity / rules 是静态的（放 section 对），**memory 和 pending 是动态的（该放 context）**。

**这修正了 `docs/soul-plan.md` 方向①的表述**：不是「全部迁到 context」，是「**identity / rules 留在 section（进缓存），memory / pending 迁到 context（每轮现算）**」。

---

## 6. 「不静默」这个原则它贯彻得比我们彻底

三处证据：

- 索引超限 → 追加 WARNING 行（`store.js:153-155`）
- 注入失败 → `logger.warn` + 返回空（`index.js:247`）
- 配置合并 → `cordis.patch.yml` 行 > 默认值，面板覆盖 > patch 行（`README.md:60`），**三层优先级写清楚**

我们的对照：`lib/memory.mjs` 静默截断、`lib/decay.mjs` 静默后移（有标签，不算静默）、`lib/patrol.mjs` 明确写了「有需要汇报的就汇报，没有就不汇报」（这是对的，是用户自己定的规则）。

**唯一该改的是截断静默。**

---

## 7. 给 dsh-anima 的四条

| 动作 | 具体改法 | 代价 | 值不值 |
| --- | --- | --- | --- |
| **三处 try/catch** | `compilePersona` / `compileMemory` / `selectForInjection` 各自包一层，失败返回 `''` / `[]` + warn | 10 行 | **最值**。消灭「一条脏数据炸掉整个回合」 |
| **memory / pending 段迁 context** | `index.mjs:114-117` 保持 identity(10) / rules(30) 为 section，把 memory(20) / pending(21) 改成 `systemPrompt.context` | 两处注册改动 + 要确认 order 语义 | 值。同时解决前缀缓存和实时性 |
| **截断要可见** | `selectForInjection` 加 `truncated` 标记，注入段末尾追加「已截断 N 条」 | 5 行 + 要改 `compileMemory` | 值 |
| **双预算（行数 + 字节）** | 现在只有 chars，加一个 `maxInjectedBytes`，用 `Buffer.byteLength` | 15 行 + 要改 config schema | **不急**。先弄清 4000 chars 够不够用 |

---

## 8. 一句话教训

**它的 `order: 95` 落在我们 order 10–30 和宿主 PLAN_POLICY(500) 之间——也就是说，一份 766 星的插件把记忆索引塞在「行为策略之前」，而我们刻意把 identity 排在 500 之前、memory 排在 20。两条路都成立，区别是它把「记忆」当**上下文**，我们把「记忆」当**身份的一部分**。**

这个差异不能用「谁对谁错」判断，它是产品哲学：**它是「助手查资料」，我们是「这个人记得什么」**。
