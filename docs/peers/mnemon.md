# dsh-mnemon —— 唯一把「视图 + 预算 + 分档配额」做成协议的项目

> 两条独立读取合并而成：
> **(A) 我本地读的 npm 包** —— `_research/mnemon/pkg/package/`，`dsh-mnemon@0.5.39`，`lib/index.js` 796412 字节 / 18934 行，`lib/contracts.js` 1593 字节。精读约 200 行 + 60 余次 grep。
> **(B) 一份跑在别处的源码读** —— 走 jsdelivr 拉的 main 分支 `src/`、`docs/en/`、`strategy-default-three-tier/`，行号都记在文里。
> 仓库 `git+https://github.com/omdsh-dev/dsh-mnemon.git`，★861（GitHub API，2026-11-03 实测）。
> 所有 (A) 的行号对 `lib/index.js`，(B) 的行号对各自文件，**不能混用**。

---

## 0. 一句话定位

它不把自己当「记忆插件」，当**上下文的分层视图编译器**：记忆、文档、技能都只是 Source，由 Strategy 组装成每轮一份有预算上限的 View，模型再用 `mnemon_view_route` / `mnemon_view_action` 在这个视图上按 id 操作。

宿主集成形态 `package.json:2-4` + 入口 `src/host/plugin.ts:28-31`：

```
export const name = 'dsh-mnemon'
provide = ['mnemonMemory']
inject  = ['tools','settings','commands','agents','subagents']
```

是 Cordis 插件，不是 MCP server。peer 依赖写死 `dsh >=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.1 <0.3.0-0`。

这个抽象比我们（`selectForInjection` 直接返回数组）高一层。代价也直接：`lib/index.js` 796KB。

---

## 1. 注入：函数式 section + 固定 order 150

```js
// src/host/guidance.ts:25-33
name: 'mnemon:routing'
order: 150
text: () => config?.routingGuidance === false ? "" : ROUTING_GUIDANCE
```

三点：

- **`text` 传函数，不传字符串**。我们 `index.mjs:475-478` 传的 `identityText` / `memoryText` / `pendingText` / `qualityText` 其实也是函数（`index.mjs:228/246/262/300`），这一点我们**已经做对了**，不用改。
- **`config?.routingGuidance === false` 这种「先读再判」**：字段缺失时返回默认值，不抛。我们四个 text 函数用的是 `runtime.loaded` / `runtime.config.enabled` 守卫，等价。
- **order 150**：在我们 `SECTION_QUALITY=30`（`index.mjs:107-117`）之后、`PLAN_POLICY(500)` 之前。我们 10/20/21/30 全挤在 `<100`，留白够，不必跟。

路由指引正文（`lib/index.js:8004` 兜底串）里有一句态度值得抄：

> Installed tools do not imply an available Source. Never infer missing historical facts. An action offer is not authorization; a write exists only after its receipt.

翻成我们的语境：**「装了记忆工具不等于有记忆；没查到的事实不许补写；发起写入不等于已经写入，只认回执。」** 这三句正好是 R01 / R02 的邻居。

---

## 2. 它不只一个 section，还有 hook 兜底（这条比 section 更有用）

(B) 读到的钩子注册顺序（`src/host/lifecycle.ts:263-273`）：

```
session/event
system-prompt/assemble
agent/pre-step     ← { prepend: true }
agent/turn-stopping
```

`prepend: true` 让本插件成为**最外层**。注释给的理由（`lifecycle.ts:380-383`、`architecture.md:114`）：

> a prompt interceptor or late lifecycle registration cannot leave memory tools without their turn pin

意思是：提示词中间件有可能不经过后面的 hook，所以必须把自己挂最外层，否则会出现「视图没绑定到这一回合」的漂移。

【判断】我们 `index.mjs:380` 的 `ctx.on('agent/pre-step', …)` **没有 `prepend: true`**。如果哪天出现「本轮记忆没跟上」，这就是第一个该看的地方。这是本次调研里唯一一条「我们可能已经在踩、但还没意识到」的隐患。

另一处是记忆快照不走 section，走**自有 plugin message**（`lifecycle.ts:354-371`），且只在渲染文本变化时追加；key 是带 revision digest 的渲染文本（`:214-221`），注释自认：

> `.context()` 过去能免费拿到 supersede-on-change，改自有消息后这是本插件责任

也就是说：**它放弃了 section 的自动失效，换来「只在变的时候才追加」的成本控制**。这条我们不必跟 —— 我们四个 section 每次 `register()` 重注册来触发失效（`index.mjs:468-480`），代价是每改一次配置就要重建，但实现简单得多。

---

## 3. 冲突判定：字符 bigram 的 Sørensen–Dice，阈值 0.6

整个包里**最直接可搬**的一段。我们 `lib/memory.mjs` 目前完全没有「两条记忆是不是在说同一件事」的判据。

```js
// lib/index.js:4948-4950
const CONFLICT_SIMILARITY = .6;
const MAX_DIFF_CONFLICTS = 40;

// lib/index.js:4951-4954 —— 去掉大小写、空白、标点、符号
function normalizeForSimilarity(text) {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}
// lib/index.js:4955-4960 —— 滑窗取 2 字，计频
function bigramsOf(value) {
  const counts = new Map();
  for (let index = 0; index + 1 < value.length; index += 1) {
    const gram = value.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}
```

`similarityOf`（`:4968-4982`）是 Dice 系数：`2 * overlap / (mineSize + theirsSize)`。

为什么选**字符** bigram 而不是词（`:4964-4966`）：

> Comparing characters rather than words is what lets a reworded sentence score high in any language, including the ones written without spaces.

**这条对中文特别关键**：按词分词要么装依赖，要么按空格切（中文直接废）。字符 bigram 是**零依赖**方案，`\p{P}\p{S}` 加 `u` flag，Node 26 原生支持。

`conflictsOf`（`:4989-5006`）还加了道门：`:4994 if (theirs.target !== mine.target) continue` —— 它那边 target 是 `memory` / `user` 两类（`:8051`）。我们对应「同 workspace + 同 type」才比。

【判断】可以搬但阈值要改。0.6 是给「跨设备同步同一份记忆」定的；我们是「同一条被重写」，两条独立笔记很容易就超过 0.6。建议先取 0.85，配「必须同 type + 同 workspace」，且**只当候选、不自动合并** —— 这跟 `lib/memory-audit.mjs`「只产候选、不替用户下结论」一致。

---

## 4. 预算：常量写宿主，校验写宿主，模型不许数

(A) 读到的常量（`lib/index.js:8042-8050`）：

```js
const MAX_ENTRY_CHARS     = 24e3;   // 24000
const MAX_DOCUMENTS       = 60;
const MAX_REMOTE_ENTRIES  = 60;
const MAX_REMOTE_CHARS    = 8e3;    // 8000
const MAX_GUIDANCE        = 2e3;    // 2000
const MAX_OPINION_CHARS   = 4e3;    // 4000
const MAX_FIELD           = 4e3;    // 4000
const MAX_SUMMARY         = 2e3;    // 2000
const MAX_TITLE           = 200;
```

View 级预算（`lib/contracts.js:19-24`）：

```js
const DEFAULT_MEMORY_VIEW_BUDGET = Object.freeze({
  maxEvidenceResults: 16,
  maxEvidenceCharacters: 16384
});
```

**运行时记忆的真实上限是另一组数**（B，`storage-model.md:145-152` + `configuration.md:102-103`）：

- `USER.md` **4096 B**
- `MEMORY.md` **10240 B**
- 溢出时**整条迁移归档**到 Memory Space，按 importance 在字节预算内保留

⚠️ 我一开始把 `MAX_ENTRY_CHARS = 24e3` 当成「单条记忆上限」，**这是错的**：那是文档 / 远端条目的上限，和 4096 / 10240 不是一个层级。

**核心纪律**：预算由宿主执行，模型只知道要装进去，不许自己数（`lib/index.js:9296`）：

> Do not count bytes; the host validates exact UTF-8 size and revision.

配套校验（`:9882-9883`）**先归一化空白再算字节**：

```js
const candidateBytes = Buffer.byteLength(
  candidates.map((entry) => entry.content.trim().replace(/\s+/gu, " ")).join(RUNTIME_ENTRY_DELIMITER),
  "utf8"
);
if (candidateBytes > budget) throw new Error(`USER.md compaction did not fit the host budget (${candidateBytes} > ${budget} bytes)`);
```

【判断】这条能立刻抄，而且补的是我们一个真洞：`lib/config.mjs:79-80` 的 `maxInjected: 40` / `maxInjectedChars: 4000` 是「取先到者」，但**我没找到「谁在数、按什么口径数」**。如果按 `String.length` 数，中文一字算 1、字节算 3，我们在 4000 上**少估了三倍**。要抄就抄「UTF-8 字节 + 先归一化空白」。

---

## 5. 容量溢出的三级降级 + 截断保尾

溢出不是丢弃，是按顺序降级（`lib/index.js:9487-9493` + `:9607`）：

1. **本地压缩 USER.md**（不外发、不许降 importance）
2. **MEMORY.md 条目归档进 Memory Space**（有空间就路由）
3. **没空间可归档 → Runtime Source 本地归档**（`Moved ${archived} MEMORY.md entries to the local archive`）

路由批量硬边界（`:9494-9495`）：

```js
const RUNTIME_ROUTE_ENTRY_CHARACTERS = 384;   // 单条摘录上限
const RUNTIME_ROUTE_CHUNK_CHARACTERS = 1024;  // 每批总字符上限
```

截断是「保头 + 保尾 + 中间留标记」（`:9496-9501`）：

```js
const marker = "\n[... host-truncated routing excerpt ...]\n";
const prefix = Math.ceil(342 * .7);   // ≈240
return `${value.slice(0, prefix)}${marker}${value.slice(-102)}`;
```

【判断】截断保尾可以用于 `compileMemory` —— 长记忆的结论常在末尾。但这里有坑：`342` 和 `102` 是**写死的**，不是从 `RUNTIME_ROUTE_ENTRY_CHARACTERS - 102 - marker.length` 推的，改常量时静默漂。抄要写成推导式。

---

## 6. 合并的验收：四条硬断言

`lib/index.js:9862-9877`。真做合并的话，这就是现成验收标准：

```js
// 1. 每条输出必须至少覆盖一个输入（不许凭空造）
if (entry.sourceIndexes.length === 0) throw new Error("USER.md compaction returned an entry without a source");
// 2. 每个输入的编号必须恰好被覆盖一次（不许漏、不许重复）
if (index < 1 || index > plan.entries.length || seen.has(index)) throw new Error("USER.md compaction source coverage is invalid");
// 3. 合并后的 importance 不得低于任一来源里最高的那个
requiredRank = Math.max(requiredRank, importanceRank[plan.entries[index - 1].importance]);
if (importanceRank[entry.importance] < requiredRank) throw new Error("USER.md compaction lowered source importance");
// 4. 不许悄悄丢条目
if (seen.size !== plan.entries.length) throw new Error("USER.md compaction omitted committed entries");
```

importance 三档 `low:0 / normal:1 / critical:2`（`:9862-9866`）。

它防的正是「整理记忆时把用户说过的话弄丢」。我们 `lib/memory-audit.mjs` 现在只做路径存在性 + `verifyAt` 过期，**根本没有合并**，所以也没有对应校验。真要加合并，抄这四条。

---

## 7. 检索：有兜底分词，没有融合公式；分档配额才是真货

这条最容易误读，分三层说清楚。

### 7.1 默认关向量

`configuration.md:105`：`embedding.enabled = false`，端点 `localhost:11434`，模型 `nomic-embed-text`。

### 7.2 词面兜底：确定性 bigram 分词器

`plugins/dsh-mnemon-source-memory-spaces/src/search-tokens.ts:3-16`：

- NFKC + 小写
- **汉字 >2 字按相邻二字 bigram；≤2 整段**
- 拉丁按 `[\p{L}\p{N}_-]+` 且长度 ≥2
- 去重后**最多 64 个 token**

匹配计数 `:18-21`，门槛 `requiredMatches:24-27`：token 数 <4 时要求命中 1；否则要求 `ceil(n/4)`，至少 2。

【判断】这套分词和我们上面 §3 的 bigram 是**同一个思路的两种用法**：一个用于相似度比对，一个用于召回匹配。我们可以只写一份 `lib/similarity.mjs`，两处复用。中文门槛「≥2 个字才算一个 token」这个细节要记住 —— 单字（"我"、"你"）作 token 会让几乎所有条目都命中。

### 7.3 「混合 + RRF」名不副实

`service.ts:905-909`：

```js
federatedScore = 1 / (60 + providerRank)
// 排序实际按 providerRank - bodyOrder
```

**不跨列表求和**，且只在多 provider 时才触发。所以这不是 RRF，是个标注值。

我用 `bm25|BM25|rrf|RRF|rerank|reciprocal` 在 `lib/` 下 grep 得 59 处命中，逐条看：**54 处是 `refused` 被 `rrf` 这个短模式误命中**（`refused` 里含 `rfs`… 实际是含 `fus`，但边界松），真要只有 `lib/client.js:1511/2001`（retaindb 文案「云端混合向量/BM25 召回」）和 `:1530/2020`（`providerField.rerank`「重排检索结果」）—— **都是 Provider 文案，不是实现**。

**结论**：`dsh-mnemon` 自身核心**没有 BM25、没有 RRF 融合、没有 rerank 实现**，这些能力外包给下游 Provider（Mem0 / OpenViking / retaindb）。它自己的「检索」只有两层：确定性分词兜底 + 模型发起的查询。

方法论教训：用 `rerank` 这种短词 grep 会被 `refused` 污染，下次加词边界 `\bBM25\b`。

### 7.4 真正可搬的：相关性分档 + 配额

这才是本次最有价值的发现（`configuration.md:111-117` + `recall-quality/policies.ts:32-34, 45-59`）：

```js
lowScoreThreshold     = 0.25
highScoreThreshold    = 0.6
candidateMultiplier   = 3
maxMediumResults      = 4
maxRankedResults      = 4
maxUnknownResults     = 2

// policies.ts:10-12 —— 候选池
pool = min(50, max(limit, ceil(limit * 3)))

// policies.ts:30-31 —— score > 1 视为「有排序证据但非校准置信度」，保留
```

翻译成规则：**低于 0.25 直接丢；0.25–0.6 算「中等」，最多 4 条；≥0.6 算「高分」，最多 4 条；分数不可用的（unknown）最多 2 条。** 候选池取需求的 3 倍，上限 50。

每轮检索配额（`strategy-default-three-tier/README.md:9-14` + `src/retrieval.ts:68-77`）：

- 两次 Recall **共享** 6 条 / 4800 字符
- 单条上限 1200 字符
- 单轮最多 **2 次** Recall
- Related 只 **1 次**
- Documents 独立配额：4 条 / 6000 字符

【判断】这是我们 `selectForInjection` 最缺的东西。我们现在是**两个排序键 + 取先到者**，等于「有排序、没分档」：一条 0.9 分的和一条 0.2 分的都进同一个池子，先到先得。加分档只改 `lib/memory.mjs` 一个函数，代价是得先把我们的排序键**归一化到 0–1**（现在应该是天数差和 type 权重，量纲不同，不能直接比阈值）。

---

## 8. 写入闸门：先算「值不值得写」，再让模型写

(B) 读到的两段判定，这是它解决「记忆表是空的」这个问题的答案。

**第一段 reviewAdmitted（`lifecycle.ts:683-709`）**，四条任一成立就进入审核：

1. 显式记忆词正则命中（`:127-131`，含「记住 / 记下来 / 长期记录」与 `remember`、`save memory`）
2. 用户文本 ≥ **320** 字符（`:125`）
3. 助手文本 ≥ **600** 字符（`:126`）
4. 本轮出现任何**非 `mnemon_`** 工具调用

**第二段 scoreReviewActivity（`review-activity.ts:7-46`）**，打分过阈值才真审核：

```
reviewThreshold        = 5
textLengthScoreUnit    = 50   (cap 3)
toolCountScoreUnit     = 5    (cap 2)
toolDiversityThreshold = 3    (cap 2)
turnScore              = 1
```

【判断】这条**对我们的 0 条记忆有直接解释力**。我们 `anima.json` 里 `autoCapture: true` 是开的，但 `memories` 表实测 0 条 —— 说明我们的捕获触发条件要么太严，要么根本没接上。它的做法是：**先用便宜的正则 + 长度 + 工具调用把「这一轮值得审」筛出来，再让模型判断写什么**。两级漏斗，第一级不花钱。

去重与改写（`storage-model.md:140-143`）：`add` 完全相同内容不重复写；`replace` / `remove` **要求唯一匹配**，零匹配、多重匹配、歧义子串一律拒绝，不做模糊改。跨机整合走 reconcile 规划器，模型只提方案、人批准，上限 40 条操作（`reconcile.ts:12, 60-70`）。

---

## 9. 遗忘：**没有**时间衰减，靠 importance + 容量

(B) 在已读的 `src/host/*`、`source-runtime`、`strategy`、`docs/en/reference` 里 grep `decay|ttl|half-life|prune` **无命中**。

替代设计三件套：

1. **importance 三档** `critical | normal | low` 作为维护期保留优先级（`storage-model.md:103`、`source.ts:11`）
2. **天数标注纯展示**：`created=14d; updated=2d`（`storage-model.md:125-136`），不参与打分
3. **容量驱动淘汰**：4096 / 10240 字节满了就按 importance 决定谁留下（`:145-152`）

`forget` 是软删（`:231`）。review 节流（`configuration.md:77-80`）：`minIntervalMs 300000`（5 分钟）、`maxPerSession 20`、`maxContextChars 24000`、`maxTokens 4096`。

【判断】我们的 `lib/decay.mjs`（`TYPE_WINDOWS = { fact: 0, preference: 540, stance: 365, event: 180 }`）**比它激进得多**，而且我们自认那组天数「没有任何数据支撑」。它这套更保守：不判时间，只在容量满时按重要度取舍。**能借的只有一条**：把 importance 引入「超预算时先砍谁」的决策 —— 我们现在是纯排序后截断，没有「critical 永不砍」的概念。

---

## 10. 工具集全景（看清边界）

grep `name: "mnemon_` 在 `lib/index.js` 得到 16 个：

| 分组 | 工具 |
| --- | --- |
| 视图 | `mnemon_view_route`、`mnemon_view_action` |
| 读 | `mnemon_recall`、`mnemon_related`、`mnemon_status`、`mnemon_memory_bodies` |
| 文档 | `mnemon_document_search`、`mnemon_document_create`、`mnemon_document_manage` |
| 写 | `mnemon_runtime_memory`、`mnemon_remember`、`mnemon_link`、`mnemon_forget` |
| 空间管理 | `mnemon_memory_body_create`、`mnemon_memory_body_update`、`mnemon_memory_body_merge` |

写入参数（`tools.ts:386-421`）：`action = add | replace | remove`、`target`、`importance`、`branches`。

对比我们：**0 个工具，21 条 HTTP 路由**（`/api/anima/*`）。它把读写交给模型用工具做，我们把读写交给用户在设置页点。这是**产品取向分歧**，不是能力差距：

- 它的代价：模型乱写会污染记忆，所以要配上很重的「受监督写入」（`WRITE_PERSONA` `:9247`、`REVIEW_LAYERS` `:9273`、`REVIEW_NO_HOT_MEMORY` `:9276` 三段 persona）。
- 我们的代价：用户不点就永远不记住，`memories` 表 **0 条**（活体配置 `C:\Users\zmy\.dsh\storages\anima.json`）。

【判断】这条是本次调研里**对我们最有行动价值的一条**：不是抄它的工具，而是解释我们为什么是 0 条。

---

## 11. 它踩过的坑（原话）

- `docs/pr-assets/issue-389-recall-budget/README.md:14`：「The replay was meant to stop retrieval without failing the call, but the result looked like an ordinary hit for the new question.」—— 「预算用完后重放」看起来像一次普通的命中，模型完全分不出来。修法（`:18`）：预算外的新读 **不跑查询、不返回内容**，返回 `notRun: true, budgetExhausted: true`；并行第三个读还要等前两个结算（`:20`）。
- `docs/pr-assets/neutral-vector-note/README.md:5`：「That is the expected state of an install without an embedding service, yet it read as a failure on every save」—— 没装嵌入服务是**正常状态**，但每次保存都显示成失败。文案改成「仍可被关键词搜到」（`:15`）。
- `storage-model.md:154`：「Similar but distinct facts cannot be skipped or semantically replace each other during archival.」—— 相似但不同的事实，归档时既不能跳过、也不能互相替代。
- `architecture.md:112`：「Each turn pins one immutable View.」
- `lib/index.js:9296`：「Do not count bytes; the host validates exact UTF-8 size and revision.」
- `lib/index.js:8114`：「A removal needs a reason strong enough for a reviewer to agree with it. Never propose an operation against a target the evidence does not contain, and never propose more than 40 operations.」—— 删除要给评审能认可的理由；不许对证据里没有的目标下手。**这正是 R01 的邻居**。
- `lib/index.js:8118`：「When the same subject is stated twice, the two texts cannot both stand: propose one entry that keeps what both said, and never leave the duplicate in place.」

---

## 12. 可搬 / 不搬（按性价比排序）

**可搬**

1. **相关性分档 + 配额**（§7.4）。改 `lib/memory.mjs:530 selectForInjection`。代价：得先把排序键归一化到 0–1，否则阈值无从谈起；且分档参数（0.25 / 0.6 / 4 / 4 / 2）是我们拍的，没有数据支撑，要写清是猜测。
2. **UTF-8 字节 + 归一化空白算预算**（§4）。改预算口径，`maxInjectedChars: 4000` 才名副其实。代价：要统一改三处入口（`index.mjs:254 injectionSelection`、设置页预览、`/api/anima/state`），否则「预览有、实际没有」的老病会再犯。
3. **字符 bigram + Dice 做冲突候选**（§3）。新增 `lib/similarity.mjs` 约 40 行，零依赖。代价：中文短句 Dice 虚高，要加最小长度门；阈值要按我们的语料重定，不能直接用 0.6。
4. **`agent/pre-step` 加 `prepend: true`**（§2）。一行改动。代价：几乎为零，但改了要跑一遍 `scripts/verify-core.mjs` 确认钩子顺序没被别处依赖。
5. **写入闸门的两级漏斗**（§8）。先正则 + 长度 + 工具调用筛，再让模型判断。代价：中文触发词表要按你的实际语料重写，不能照抄「记住 / 记下来」这五个词。
6. **合并的四条断言**（§6）。等真做合并时用。代价：现在没合并功能，抄了是死代码。
7. **截断保尾**（§5）。代价：常量必须写成推导式，别照抄 `342`。

**不搬**

1. **16 个工具 + 受监督写入**（§10）。等于重做产品。
2. **模型驱动的召回**（`mnemon_recall` 每轮 1 次初始 + 1 次改写）。模型不知道自己不知道什么，我们有巡夜兜底，不需要换范式。
3. **View / Strategy 抽象**。40 条记忆 × 4000 字用不上编译器。
4. **importance 三档直接抄**。我们的 type 四值（fact/preference/stance/event）已经在做类似的事，叠一套 importance 会变成两个正交维度，用户看不懂。

---

## 13. 没读到的（不含糊）

- `lib/index.js` 18934 行只精读约 200 行，其余靠 grep。**「它没有 X」只有 §7.3 的 BM25 / RRF / rerank 做了完整 grep 反证**，其它「没有」都是「没见到」。
- `src/host/runtime-capacity.ts`、`src/host/review-admission.ts` **两份都读不到**（jsdelivr 403 / 超 50MB）。这两个文件最可能藏真遗忘逻辑，属于**已知盲区**。
- `lib/core.js`、`lib/bundle.js`、`lib/runtime-0u6dOiF9.js`、`lib/starter.js`、`lib/strategy-configuration-CKP2kRss.js`、`lib/definitions-DU7MLBhu.js`、`lib/client.js`（12000+ 行）、`lib/types/**` 全部未读。
- `cordis.patch.yml`（补丁机制）、`bin/`、`README.md` / `README.zh-CN.md` / `SECURITY.md` 未读。
- `default-three-tier` 策略怎么分层、`mnemon_document_*` 存储格式、跨设备同步是否真跑得通 —— 全空白。
- 星数来自 GitHub API 一次读取，未复查。
