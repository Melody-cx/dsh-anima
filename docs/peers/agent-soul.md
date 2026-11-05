# dsh-agent-soul（`danshuyue/dsh-agent-soul`）工程机制调研

调研时间：2026-11-04 | 对象版本：**0.5.1**（npm 7 个版本，2026-10-28 → 2026-11-01）| 对比基线：本仓库 dsh-anima

## 0. 为什么专门读这一个（以及它有多冷）

**星数 0、fork 0**（GitHub API 2026-11-03 实测，`stargazers_count: 0` / `forks_count: 0`）。仓库 2026-10-28 建，2026-11-03 01:30 还有 push，四天发了 7 个版本 —— 冷但活着。

按用户「星高下载多的都看一遍」的标准，它**不该被读**。但它是全生态里与我们做的事**重合度最高**的一个，它自己的仓库描述写的是：

> 给 DSH 的 agent 一套会忘事的记忆、一份会变的人格、一份会起伏的心情和一件心里惦记的事

人格 + 会遗忘的记忆 + 惦记的事 + 心情 + 日记。五样里有四样和 `docs/soul-plan.md` 是同构的。所以这份报告的价值不在「学它有多成熟」，在「同一道题它怎么解、踩了哪些坑」。

**材料来源**：`D:\deepseek工作区\_research\agentsoul\` 下完整源码副本（77 文件，`lib/` 下 22 个 `.js`，合计 12055 行）。所有行号为原文行号。

**读不到的**：`lib/client.js`（1854 行）、`lib/diary.js`（1505 行）、`lib/api.js`（911 行）只做了 grep 级扫描，没有逐段通读；`attest.js` 读了头部设计说明与 `describe()`，未读完整上报路径。这些在涉及处会标注。

---

## 1. 注入位置：它用了 `systemPrompt.context`，不是 `section`

### 1.1 四段与 order

`lib/index.js:632, 665, 766, 814`：

| 段 | name | order | 钩子 |
| --- | --- | --- | --- |
| 人格 | `soul:persona` | **260** | `systemPrompt.context` |
| 记忆 | `soul:memory` | **250** | `systemPrompt.context` |
| 目的（惦记的事） | `soul:purpose` | **240** | `systemPrompt.context` |
| 心情末段 | `soul:mood-last` | **230** | `systemPrompt.context` |

四段全是 `context`，**没有一个走 `section`**。而我们现在四段（`index.mjs:475-478`）全是 `section`，order 10/20/21/30。

它自己的理由写在 `lib/index.js:10`：「为什么注入用 systemPrompt.context 而不是别的钩子」。我们这边 `index.mjs:474` 的注释则是「先释放旧 section 再注册新的，触发 `system-prompt/change`，让 DSH 丢弃当前会话已缓存的 system prompt 快照」—— 也就是说**我们选 section 是为了显式失效缓存**，它选 context 是为了别的目的。这两条路的分歧点值得单独讨论，见第 6 节。

### 1.2 `required: true` —— 一个我们完全没有的维度

四段都带 `required: true`。`lib/index.js:636-638` 的注释写得很直白：

> 人格是「她是谁」，不能因为是精简上下文（`includeRuntimeContext=false`）就整个丢掉 —— 那种模式下 agent 会变得没有身份。

记忆段的注释（`:667-670`）：

> `includeRuntimeContext=false` 的 agent 也要拿到记忆卡，否则「她是谁 / 她记得什么」在这类 agent 上直接失忆（见 DSH 的 assemble：`contexts.filter(entry => !suppressed || entry.required === true)`）。

**这是可验证的事实**：宿主 `assemble()` 里 contexts 的过滤条件是 `!suppressed || required === true`。我们四段一个 `required` 都没加，所以在 `includeRuntimeContext=false` 的会话里（子代理、精简 preset）——【推断】我们的人设段与记忆段会被整段抑制掉。

### 1.3 人格不是每轮都发：`PERSONA_REFRESH_TURNS = 15`

`lib/index.js:429` 定义 `const PERSONA_REFRESH_TURNS = 15`，判定在 `shouldInjectPersona()`（`lib/index.js:498-521`）：

```js
const first = isFirstTurnOfSession(agent)
const id = String(agent?.session?.header?.id ?? '')
if (id === '') return true

const human = turnCursorBySession.get(id)?.human ?? 0
const last = personaInjectAtBySession.get(id)

// 同一轮内会装配多次（重试 / 标题生成）。已经为这个 human 计数注入过，
// 就不要再注入一遍 —— 否则「省消耗」反而变成一轮发好几份人格。
if (last !== undefined && human === last) return false

if (first || last === undefined || human - last >= PERSONA_REFRESH_TURNS) {
  if (personaInjectAtBySession.size > 200) personaInjectAtBySession.clear()
  personaInjectAtBySession.set(id, human)
  return true
}
return false
```

设计理由是 `lib/index.js:640-643` 的两句：

> 人格只在会话首轮注入，之后每隔 PERSONA_REFRESH_TURNS 轮补一次。不每轮重发（树树说的：不想让用不到的东西持续做无用消耗），也不注入一次就再也不管（上下文压缩之后会把自己是谁也压掉）。

**这直接解释了「为什么用 context 不用 section」**：【推断】section 一旦注册就是静态快照，每轮都会进装配；context 的 `text()` 是函数，可以按轮次返回空串。它要的是「大部分轮次返回空串」，section 做不到这件事——除非每轮重新 dispose+register，那正是我们在做的事，代价是每轮都触发 `system-prompt/change` 使缓存失效。

### 1.4 动态函数与副作用收敛

`text: (context) => string` 是每轮现算。记忆段的 `text()` 里干了五件事（`lib/index.js:676-700`）：

1. `registerToneForTurn(context?.agent)` —— 心情计数，必须在任何 early return **之前**算，注释写「计数器是「每轮一次」，跳过去就不准了」
2. `tick(agent, cwd, cfg, { llm })` —— 增量提取 + 例行维护，不阻塞注入
3. `probeHostOnce(...)` —— 宿主形状自检，每会话首轮一次
4. `if (isSubagentSession(agent)) return ''` —— 子会话不注入
5. `currentUserText(agent)` —— 取当前这句用户话作为召回 query

它把「会不会产生写入」收敛在**一个函数**里（`tick`，`lib/index.js:521` 起），注释明说：

> 子会话整段跳过：不维护、不提取、不写日记。这是「会不会产生写入」的唯一收敛点 —— 判断只写在这里，别在调用方散写。

---

## 2. 记忆：五档清晰度 + 连续 retention 公式（我们只有三档阈值制）

### 2.1 五档

`lib/memory.js:43`：

```js
export const CLARITY_ORDER = Object.freeze(['vivid', 'clear', 'fuzzy', 'trace', 'forgotten'])
```

权重（`lib/memory.js:1109`）：

```js
const CLARITY_WEIGHT = Object.freeze({ vivid: 5, clear: 4, fuzzy: 2, trace: 1, forgotten: 0 })
```

### 2.2 `targetClarity()` 的完整公式（`lib/memory.js:382-410`）

```js
if (record.pinned === true) return 'vivid'

const ageDays = Math.max(0, (now - created) / DAY_MS)
const sinceSeenDays = Math.max(0, (now - seen) / DAY_MS)
const important = ownerImportant(record, cfg) || record.isInitial === true

if (ageDays > cfg.forgetAfterDays && Number(record.importance) < 50 && !important) {
  return 'forgotten'
}

let retention = Number(record.importance) || 0
retention += Math.min(12, (Number(record.recallCount) || 0) * 2)   // 每次被想起 +2，封顶 +12
if (ageDays <= cfg.recentDays) retention += 18
if (sinceSeenDays <= 2) retention += 8
retention -= Math.min(80, Math.max(0, ageDays - cfg.fuzzyAfterDays) * (important ? 0.12 : 0.35))
if (important) retention = Math.max(retention, 55)
if (ageDays <= cfg.recentDays) retention = Math.max(retention, 50)

if (retention >= 68) return 'vivid'
if (retention >= 46) return 'clear'
if (retention >= 24) return 'fuzzy'
if (retention >= 12) return 'trace'
return 'forgotten'
```

关键设计点：**主人相关 / 初次相遇的记忆，扣分速率只有普通的约 1/3**（0.12 vs 0.35），且有地板（`important` 保底 55 → 至少 clear；`recentDays` 内保底 50）。这解决的是一个真问题：重要但不常提到的记忆，不该因为「时间过去」和流水账一起烂掉。

对比我们 `lib/decay.mjs`：三档（`fresh`/`aging`/`stale`）、纯窗口阈值制、`DECAY_WINDOWS_DAYS = { fact: 0, preference: 540, stance: 365, event: 180 }`、只在超窗时加标签（`decayTag()` 返回 `'久未更新'` 或 `'较早的事'`）、排序只分两档（`decayRank` 返回 0/1）。

我们的做法是**刻意的**，`lib/decay.mjs:5-9` 的注释：

> 只有**超过**窗口才降级，不是「一天一天地淡出」—— 因为「淡出」需要每轮重算权重，而权重一旦进入排序，用户就无法解释「为什么这条昨天还在、今天没了」。

【判断】两种哲学各有代价，不是简单的「它对我们对」：

- 它的代价：`retention` 是个连续值，用户看到「这条从 clear 掉到 fuzzy」时，说不出是哪一天、因为什么。而且它有 `recallCount` —— **需要写盘**（每想起来一次就 +1），我们没有这个写入。
- 我们的代价：`fact` 类型窗口是 0（永不衰减），`preference` 540 天（一年半）。对「喜好会变」这件事来说，540 天等于永不复查。且我们没有「被想起几次」这个维度 —— 一条记忆无论被用过 1 次还是 50 次，衰减完全一样。
- 【可选】我们真正缺的不是连续权重，是 **`important` 这条豁免通道**：现在 `stance` 和 `preference` 超窗后照样只加个标签、照样可能被挤掉。它的 `Math.max(retention, 55)` 是「重不重要」而不是「新不新」在保护记忆，这条和我们 `fact: 0` 的思路是一路的，可以合并成：**给记录加一个「不可衰减」标记，而不是继续加类型**。

### 2.3 参数默认值全录（`lib/memory.js:1244-1305`）

```js
recentDays: 7,          // 最近 N 天的事至少保持「清楚」
fuzzyAfterDays: 7,      // 新记忆前 N 天不降档
forgetAfterDays: 60,    // 超过 N 天 且 importance<50 且非主人相关/初次 → 可彻底遗忘
minOwnerImportance: 65, // 主人相关且重要性达标 → 最差也保持「清楚」
maxRecords: 600,        // 单卡上限，超出压缩开始降档
warnChars: 24000,       // 渲染后字数告警（不自动删）
injectMaxChars: 3200,   // 注入预算
memoryRecall: true,     // 按当前用户消息召回（false = 退回整卡）
memoryRecallTopK: 3,    // 相关区最多几条
dailyHour: 4,           // 每天几点跑遗忘整理
autoCompact: true,
maxPerTick: 12,         // 单回合最多自动写几条
autoImportanceEvent: 70,
autoImportanceDefault: 42,
diarySessionId: '',     // 空串 = 未绑定，日记跳过
```

我们对应的是 `maxInjected: 40` / `maxInjectedChars: 4000`（`lib/config.mjs:79-80`）。

**它的 3200 字比我们 4000 少，但它的注入是「固定区 + 相关区」两段结构**（见 2.4），而我们是一整个平铺列表。这是同为「按预算截断」但产出质量不同的地方。

### 2.4 「固定区 + 相关区 + 兜底回填」—— 这条最值得抄

`lib/memory.js:1226-1240`：

```js
/** 固定区：priority >= 100，永远不参与预算裁剪。 */
const FIXED_PLAN = Object.freeze([
  { key: 'initial', title: '## 我们的开始', priority: 120 },
  { key: 'anchors', title: '## 永远不会忘的', priority: 100 }
])

/** 兜底回填的顺序：和 renderCard 的分区顺序一致（关于你的事 → 最近记得的 → 正在模糊的）。 */
const BACKFILL_PLAN = Object.freeze([
  { key: 'owner', title: '## 关于你的事', priority: 40 },
  { key: 'recent', title: '## 最近记得的', priority: 30 },
  { key: 'fuzzy', title: '## 正在模糊的', priority: 10 }
])
```

`renderRecalledBlock()`（`lib/memory.js:1288` 起）的三段结构，注释写清了为什么不能复用整卡渲染（`:1281-1286`）：

> 整卡是按分区从尾裁条目，裁掉的往往是「最近记得的」这种最贴当前语境的分区；而固定区（开始 / 永远不会忘的）反而必须一条不裁。

裁剪策略（`:1351`）：

> ③ 相关区超预算时从尾部（分数最低的）剔；固定区（priority>=100）永不动。

还有一条 `RELATED_LINE_MAX = 48`（`lib/memory.js:1248`）：相关区每行最多 48 字，理由（`:1245-1247`）：

> 具体内容她自己会用 `soul_memory` 去查；把全文塞进提示词是重复付费。

**这是我们最该抄的一条**。我们现在是：40 条上限 + 4000 字，按「超没超窗」两段排序完就从头往下塞，塞到预算满为止。结果是：

1. 预算紧张时被挤掉的是**排后面的**（更旧的），但我们没有任何「这条永远不能挤」的概念 —— 「用户是学生」「叫什么名字」这种和「三天前吃了什么」在截断时完全平等。
2. 一整个平铺列表，模型要自己判断哪条和当前话题有关。它把这件事在**渲染阶段**做了：当前用户消息 → 打分 → 只进 topK=3 条进「相关区」。
3. 没有「按需取全文」的出口。它有 `soul_memory` 工具的 `recall`，注入的只是线索。

### 2.5 召回打分公式

`lib/memory.js:1188-1196`：

```js
const clarity = CLARITY_WEIGHT[record?.clarity] ?? 0
let score = (Number(hitScore) || 0) + importance * 0.6 + clarity * 2
if (record?.pinned === true) score += 60
```

四个分量：**命中分 + 重要度×0.6 + 清晰度×2 + 固定+60**（另有 `kindBonus`，未读实现）。

注释里对每一项的理由（`:1179-1185`）：

> · 重要度 × 0.6：importance 本身是 scoreRecord 的产物，0~100 → 最多 60
> · pinned +60：固定过的是「永远要记得」的，命中时优先给它

以及它自己承认的局限（`:1173`）：

> 不回答「这件事本身值不值得现在拿出来」。只按命中排的话，一条 clarity=feeling 的旧事可能排在今天刚发生的事前面。

**这说明它也没解决「相关性 vs 时效性」的融合问题**，只是用加权和硬压。我们的两段排序键（先 `decayRank` 再 `capturedAt` 倒序）反过来——完全不看相关性。两个极端。

### 2.6 跨度去重

跨卡去重（`lib/memory.js:1296`）：

> 跨卡去重：双写会让同一条同时躺在项目卡和全局卡里，注入两遍是纯浪费。

### 2.7 `forgotten` 是硬删除

`lib/memory.js:1210`：`if (record.clarity === 'forgotten') continue` —— 渲染时直接跳过。不是标注、不是排后，是不出现。配合 `forgetAfterDays: 60`，一条不重要（`importance<50`）且非主人相关的记忆，**60 天后彻底消失**。

我们的 `state` 是四值 + `supersededBy`（`lib/store.mjs:217-225`），删除要走 `memory.delete`（有 tombstone 概念）。【判断】它这种「时间到了就不出现」省掉了一次用户裁决，但也意味着用户无法知道「有哪些东西被忘了」—— 它没有 tombstone。我们这边更保守，代价是需要人参与。

---

## 3. 写入路径：两道门，第二道是「模型不许编」

### 3.1 第一道：`isHumanEvent` 与「信封」

`lib/extract.js` 里有三个防污染机制，全部有明确注释的踩坑来源：

**① `INJECTED_SOURCES`（`lib/extract.js:57`）**：一组「注入源」kind，命中即 `return false`（`:131`）。防止把我们自己注入的内容又当成用户说的话记一遍。

**② 剥「信封」（`lib/extract.js:138-176`）**：

> 桥接层的「信封」—— 正文前面那截括号说明。
> `（QQ 私聊·用户本人 QQ 3472302240）起了起了` → 剥掉信封就是正文
> ⚠️ 剥信封为什么不只是"好看"：括号说明有 20 多字，会把「起了起了」这种

**③ 回显检测（`lib/extract.js:240-247`）**：

> 这条 user/message 是不是**她自己刚说过的话被桥回显**。
> 代价是"主人复述她刚说过的话"会被误判成回显 —— 少见，且丢一条远好过自我强化。

实现是先收一遍这一轮里她说的话（`:205`、`:346`），再逐条比对。触发模板整条丢弃（`:168`）。

**这一段对我们完全陌生**：我们只有「凭据形态直接拒收」一道闸门（`lib/memory.mjs`），没有「这条 user/message 其实是机器注入的」这个概念。因为它是接 QQ 桥的，我们是纯 DSH 会话，但【推断】子代理的 prompt 注入、tool result 回放、`user/message` 形式的系统提醒，在我们这边同样可能被误当成用户真实发言提取 —— 我们靠的是 `autoCapture` 阶段的模型判断，它靠的是**提取阶段的机械过滤**。

### 3.2 第二道：`refine.js` 的三条硬约束

`lib/refine.js:18`：

> 2. 没有信息量就输出空数组：**宁可少记**。记忆是有限预算，塞满废话最糟。

`:93`：

> 5. ⭐ **没有信息量就输出空数组 []**。寒暄、语气词、「嗯」「好的」「起了起了」、任务指令，

`:95`：

> 6. **宁可空数组，也不许把「${owner}让我干什么」当成记忆。** 这是最容易犯的错。

【判断】第 6 条值得抄进我们的 `lib/prompt.mjs`。我们现在的 `autoCapture` 提示词没有明确禁「把用户的指令当成关于用户的事实」。二者区别是：**「老大让我读 3 个文件」不是记忆，「老大是学生」是记忆**。

### 3.3 `scoreRecord()` 打分（`lib/memory.js`，行号见下）

基准 8 分，然后：

```js
if (isOwner) { importance += isPrivate ? 36 : 26 }   // 主人私下说 / 群里说
if (direct) importance += 8                            // 直接对你说的
if (emotion > 0) importance += emotion + 6             // 情绪浓度 + 保底 6
if (isFirst || FIRST_RE.test(text)) importance += 30   // 第一次
if (PROMISE_RE.test(text)) importance += 16            // 约定 / 将来要做的事
if (CONFLICT_RE.test(text)) importance += 14           // 矛盾 / 道歉 / 和好
if (SELF_RE.test(text)) importance += 8                // 关于自己的偏好
if (FACT_RE.test(text)) importance += 18               // 长期事实（目标/专业/习惯/身份）
if (EPHEMERAL_RE.test(text)) importance -= 20          // 一次性日常
if (text.length < 6) importance -= 12                  // 太短
```

**两条改分史本身就是踩坑实录**：

`lib/memory.js`（`scoreRecord` 内，2026-10-29 注释）：

> 从 42/32 降到 36/26：原来私聊直接 +42，而入选阈值就是 42，等于「只要是主人私下说的」就免检入库 —— **判据失去了区分度，流水账和画像分不出高低**。

`lib/memory.js:1286-1296`（配置默认值处）：

> 为什么 event 要单独提到 70：用户当场在项目卡里抓到三条"记忆"，全是一次性任务/进度（「帮我改插件」「对桥接代码做最后一次检测」），重要度 44~52 —— **旧阈值 42 等于「只要是主人说的就收」**。

以及一条「单一真源」教训（`:1294`）：

> 这里是**唯一**的默认值来源：`store.js` 的 `DEFAULT_CONFIG` 直接引用它，落库判断统一走 `extract.js` 的 `minImportanceForKind`，别在调用方散写 42/70。

**我们完全没有重要度打分。** `lib/memory.mjs` 全文只有去重用的 `similarity()`（`:477`、`:498`），没有任何 importance/weight 字段。所有记忆在排序上平等，靠 `capturedAt` 分先后。

【判断】这是我们的结构性缺失，但补它要付出代价：打分要写进记录、要能被用户解释、要有一个「这条为什么比我另一条重要」的答案 —— 我们的设计原则是「用户能用一句话解释」。它的解法是「存 reasons 数组」（`scoreRecord` 里每次加分都 `reasons.push(...)`），这正好也是可解释的。这条值得抄，见第 6 节。

---

## 4. 目的机制（`lib/purpose.js`）—— 它的「灵魂」核心

文件头（`lib/purpose.js:1-26`）是这一段里最好的设计说明之一，全文照录关键部分：

> SurfCore 的目的机制不是为了「定时发一句问候」，而是给 AI 一个**会衰减的内在状态**：
> - 几个需求维度（好奇 / 在乎 / 想分享 / 想搞懂）各有 0~1 的驱动值；
> - 驱动值随时间半衰期衰减回基线，被素材反复刺激又会涨；
> - 从记忆里提炼「没闭合的事」作为目标候选；
> - 说出去了驱动才真的降（×0.45），没说只轻微回落。
>
> ……本地 DSH 会话里**没有推送渠道**（用户不打开就没有回合），所以：
> - 删掉所有排程、静默时段、投递/回执逻辑（那些属于「发消息」，不属于「有目的」）；
> - 保留驱动衰减 + 从记忆提炼目标 + 影响语气；
> - 注入一段「你心里惦记的事」，让**她自己**决定要不要提 —— 决定权在模型手里，这比硬塞一句「去问候主人」更像自主，也更不容易变成复读。
>
> 一句话：本地的「主动」不是主动发消息，是**主动想起**。

参数：

- `NEEDS = ['curiosity', 'care', 'share', 'mastery']`（`:34`），标签「想弄明白 / 在乎树树 / 想分享 / 想搞懂」
- `BASE_DRIVES = { curiosity: 0.35, care: 0.45, share: 0.3, mastery: 0.4 }`（`:43`）
- `outcome === 'sent' ? 0.45 : 0.85`（`:141`）—— 说出口了驱动降 55%，没说只降 15%
- 为什么是四个不是八个（`:27-33`）：

> 维度越多，单个维度的信号越弱，最后所有驱动都停在基线附近、谁也推不动行为。

【判断】这一整块我们**完全没有**，也是 `docs/soul-plan.md` 里最靠近「灵魂」这个词的部分。但要抄必须先承认代价：它引入了**一个持续存在、跨会话累积、且在无人看时也会变的内部状态**。这个状态会写盘、会漂移、会让「今天的助手和昨天不一样」。我们的 `soul-plan.md` 立的原则是「可被检查的行为约束 + 可反悔的记忆 + 不替用户下结论」—— 目的机制和第三条有张力：**一个「心里惦记的事」本质上就是 AI 自己给自己下了一个结论**。

它的对策是把决定权交回模型（「她自己决定要不要提」），也就是**只增加了一个可以不被使用的输入**。这是它的解法，能不能接受要你拍板。

---

## 5. 心情与语气：挂在用户消息上，不进系统提示

### 5.1 `tone.js` 的完整论证（`lib/tone.js:1-30`）

> 它只做一件事：**隔几轮，往当前这句用户消息后面挂一行心情**。
>
> ── 为什么挂在用户消息上，而不是系统提示末尾 ──
>
> 一开始想的是在 system prompt 末尾加一句「今天不太有劲」。那个方案有两个毛病：
> ① 缓存。系统提示一变，长缓存全失效。心情每轮都在动，等于每轮重建。
> ② 更根本的：那是**当下的状态**，说出口就开始过时。三小时后回头看还写着「今天不太有劲」，已经不对了。
>
> 树树给的改法把这个想通了：心情不是「现在的状态」，是**那一刻的状态**，应该像照片上的日期一样跟着那条消息冻结。挂在消息上之后：
> - 系统提示一个字不动，缓存照吃
> - 三小时后回头看，那条消息记的是「当时」，永远是对的
>
> 代价是长会话里越往后心情越旧 —— 所以**当前这一轮永远用当轮的**，历史消息照旧冻结。
>
> ── 三档 + 每 N 轮 ──
>
> 中档（大多数时候）什么都不加。低/高才发，而且每 N 轮才发一次。真正的约束不是「省 token」，是**给长会话一个硬上限**：注入条数 ≤ 轮数 / N，永远不会攒出几百条。
>
> 计数器按「发出去几条」算，不按「第几轮」算 —— 按轮次算的话，中间换档会错位，两条之间可能只隔 1 轮。

- `TONE_DEFAULT_EVERY = 7`（`lib/tone.js:32`）
- `TONE_LEVELS`（`:34-38`）：`low: '今天不太有劲，说话会短一些，不太想解释。'` / `mid: ''` / `high: '今天心情不错，愿意多说两句。'`
- 每档多个 `VARIANTS`，理由「避免同一句话反复出现显得在演」（`:41`）

**【这是全报告里我认为最该整段搬过来的一条】**，理由与它无关，与我们有关：我们四段全走 `section`，每轮重新注册以失效缓存 —— 也就是说**我们每轮都在付缓存重建的钱**。它的方案证明「频繁变化的东西不该进系统提示」不是妥协，是更正确的建模：**状态应该跟着它产生的那一刻冻结**。

### 5.2 mood 参数

`lib/mood.js`：`MOOD_STEP_DIVISOR = 3`（`:32`）、`DIM_TOP_PERCENT = 25`（`:77`）、`DIM_HALF_LIFE_MIN = 90`（`:82`）、`DECAY_NOTE_STEP = 3`（`:85`）。判定用外部模型（`JUDGE_TIMEOUT_MS = 25000`，`:568`，打 `https://api.siliconflow.cn/v1/chat/completions`，`:570`）。

【判断】这一步引入了一个**外部 LLM 依赖 + 25 秒超时**。我们 `dsh-anima` 目前零外部网络调用，搬 mood 判定会破坏这条。可以做本地版（规则判定 → 三档），但那退化成 `tone.js` 本身。

---

## 6. 装配证词（`attest.js`）—— 一个我们完全没有的验证维度

`lib/attest.js:1-40` 是这份代码里最「元」的一节，值得原样摘：

> soul 的三段（人格 / 记忆 / 目的）都是 `systemPrompt.context` 的 `text()` 函数。
> `text()` 返回什么，插件自己看得见；但「这段文本有没有真的进最终系统提示词」，它**一个字都看不见**。
>
> 这跟 2026-10-31 那个日记 bug 是同一类病：程序没崩，就当成了送到了。那天是一行「已发送」的日志骗了人；今天是「我返回了文本」这件事，被当成了「模型收到了文本」。这两件事之间隔着装配、过滤、覆盖三道闸门。
>
> ── 怎么拿到硬证据 ──
> 在 `system-prompt/assemble` 的 waterfall 最外层（prepend）等 `next()` 返回，然后直接读 `assembly.contexts` —— 那就是这一次装配**真实携带**的上下文清单。
>
> 为什么这样读是安全的：
> - `contexts` 在进入 waterfall 之前就已经 resolve 成 `{ name, text }`，也就是说 `text()` 已经跑完了。我们在 `next()` 之后只做 find + 测长度，**不会**再调用任何 `text()`，所以不会重复触发提取、心情、提炼这些副作用。
> - 只读不写，不碰 sections、不改进出，装配结果逐字节不变。
>
> ── 为什么记的是 contexts 而不是 sections ──
> DSH 的 `assemble()` 在 waterfall 之后还有一手：如果有段声明了 `complete: true`，所有 sections 会被压成 `[那一段]`。但 contexts 只按 `required` 过滤，不受 complete 影响。……**拿 sections 当证据会误报，拿 contexts 才是对的。**

实现要点：`WATCHED` 三段名硬编码（`:38-42`），`HISTORY_CAP = 20`，只在内存不落盘（`:32-36`：「这是运行时诊断，不是持久数据。……要回查历史，`note()` 的日志里已经留了转折点那几行」），`describe()` 拼成 `人格 812 字 · 记忆 1403 字 · 目的 空串（2/3 到位）`。

**我们的现状**：`grep -n "system-prompt/assemble\|contexts" index.mjs lib/*.mjs` 全仓**零命中**。只有 `index.mjs:212` 一条注释提到 `assembleContextFor` 是 `context.agent` 的来源。

【判断】这意味着我们现在无法回答一个问题：「设置页显示人设已生效」和「模型真的收到了人设」之间差几道闸门。`docs/soul-plan.md` 里「可被检查」是核心原则之一，但检查的是**回答**（十二条质检），不是**注入**。这条是原则内部的缺口，不只是功能缺失。

---

## 7. 工具：`soul_memory` + `soul_goal`

`lib/tool.js:70` 起 `soul_memory`：

- `action`: `write`（记一条）/ `recall`（按关键词回想）/ `forget`（忘掉一条）/ `pin`（固定为永不遗忘）/ `list`（看最近记了什么）
- `text` 的 description（`:86`）：「写「谁说了什么、什么时候、为什么重要」，一句话说完，不要写成流水账」
- `query`：「recall 时的关键词，两三个词就够」
- `layer`（`:93`）：「global 记到所有会话都看得到的地方；project 只记在当前项目里。默认 global」

`lib/tool.js:251` 起 `soul_goal`：`add` / `done` / `list`；`text` 的 description（`:260`）：「一句话，写清「想做什么」而不是「刚才聊了什么」」。

注意 **两处 description 都在教模型写什么、不写什么** —— 和 3.2 的 refine 约束是同一个思想：**防「流水账」靠的是提示词里反复写清楚反例，不是靠后处理**。

【判断】我们有 21 条 `/api/anima` 路由，但那是**给设置页用的**，不是给模型用的。`soul_memory` 这种「模型自己在会话里按需查记忆」的出口我们一个都没有 —— 这正好是 2.4「相关区只给 48 字线索、全文工具查」的另一半。两者是配套的，单搬一半会变成「线索给了但查不到」。

---

## 8. 存储布局

`lib/paths.js:32-48`：

```js
export const agentsDir = () => join(dshHome(), 'agents')
export const projectsDir = () => join(agentsDir(), 'projects')
export const memoryDir = () => join(agentsDir(), 'memory')
export const memoryProjectsDir = () => join(memoryDir(), 'projects')
export const globalPersonaPath = () => join(dshHome(), 'AGENT.md')
export const globalMemoryPath = () => join(memoryDir(), 'global.json')
export const archivePath = () => join(memoryDir(), 'archive.jsonl')
export const configPath = () => join(agentsDir(), 'persona.json')
export const injectLogPath = () => join(agentsDir(), 'inject-log.jsonl')
export const moodDir = () => join(agentsDir(), 'mood')
export const diaryDir = () => join(agentsDir(), 'diary')
```

要点：

- **人格在 `~/.dsh/AGENT.md`，直接用 Markdown**，用户可以用编辑器改（`lib/store.js:67` 注释：「配置缓存带 mtime：用户可能直接用编辑器改 persona.json（README 明确说可以）」）。我们是 `anima.json` 里的单条 config 记录 + 可选 `.dsh-anima/` 工作区覆盖。
- **`archive.jsonl`**（`lib/store.js:513`）：退役的记忆进追加式归档，不物理删。
- **`inject-log.jsonl`**：注入记账。我们没有这个。
- `migrateMoodFiles()`（`lib/store.js:256`）：旧版散落的 `<session>.json` 迁到 `global.json`，幂等、存在就跳过、挑时间线最多的一份 —— 迁移逻辑写得很省事。
- **无 JSON Schema**，只有 `normalizeConfig` 兜底。【判断】这点和我们一样（我们也是 `lib/config.mjs` 手写 normalize），不算差距。

---

## 9. 踩坑原文（可直接抄进我们注释的）

按可迁移性排序：

1. **`lib/attest.js:6-9`**——「程序没崩，就当成了送到了。……这两件事之间隔着装配、过滤、覆盖三道闸门。」
2. **`lib/memory.js` `scoreRecord` 2026-10-29 注释**——「等于『只要是主人私下说的』就免检入库 —— 判据失去了区分度，流水账和画像分不出高低。」（阈值 = 加分项之一，等于判据失效）
3. **`lib/tone.js:5-13`**——「系统提示一变，长缓存全失效。心情每轮都在动，等于每轮重建。」+「那是**当下的状态**，说出口就开始过时」
4. **`lib/memory.js:1262-1264`**——「旧实现两处各写一份（这里 2400、store.js 1600），实际生效 1600、告警却按 2400 算，改预算时两边容易只改一半。」（**配置默认值必须单一真源**）
5. **`lib/extract.js:247`**——「代价是『主人复述她刚说过的话』会被误判成回显 —— 少见，且丢一条远好过自我强化。」（宁可漏记也不要自我强化）
6. **`lib/index.js:227-229`（记忆段注释）**——「落库判断统一走 `extract.js` 的 `minImportanceForKind`，别在调用方散写 42/70。」
7. **`lib/index.js:505-509`**——「同一轮内会装配多次（重试 / 标题生成）。已经为这个 human 计数注入过，就不要再注入一遍 —— 否则『省消耗』反而变成一轮发好几份人格。」（**这条我们可能有同样的问题**：我们四段每轮 `dispose` + 重新 `register`，如果装配在一轮内跑两次，就会触发两次 `system-prompt/change`）
8. **`lib/purpose.js:20-22`**——「本地 DSH 会话里**没有推送渠道**（用户不打开就没有回合）」—— 这句是对「主动」这件事最诚实的界定。

---

## 10. 对 dsh-anima 的可搬清单（按代价从低到高）

| # | 做法 | 出处 | 代价 |
| --- | --- | --- | --- |
| 1 | 四段都加 `required: true` | `lib/index.js:636-638` | 一行改动；【推断】会改变子代理 / 精简 preset 下的行为，需要实测影响面 |
| 2 | refine 提示词加「禁止把用户指令当记忆」 | `lib/refine.js:95` | 改提示词一句；需要重跑 `verify-core` 里相关用例 |
| 3 | 配置默认值单一真源审计 | `lib/memory.js:1262-1264` | 纯审计，零功能变化 |
| 4 | 「固定区 + 相关区」两段注入 | `lib/memory.js:1226-1240, 1288, 1351` | 要改 `selectForInjection` 的返回结构与 `compileMemory` 的渲染；我们现有的 `decisions` 每条形解释机制可以原样保留，只是加一个 `pinned` 维度 |
| 5 | 交给用户裁决的「固定（永不遗忘）」标记 | 同上 + `lib/tool.js` 的 `pin` | 要加字段 + 加 API + 加设置页开关 |
| 6 | 按当前用户消息做召回打分 | `lib/memory.js:1188-1196` | 需要词面检索（我们现在零）；且必须解决它自己承认的「相关性 vs 时效性」加权问题 |
| 7 | 心情挂在用户消息上、不进系统提示 | `lib/tone.js:1-30` | 需要宿主是否支持给单条消息追加文本 API（未核实）；**这是唯一能减少我们缓存重建成本的方向** |
| 8 | 目的机制（四维驱动 + 衰减） | `lib/purpose.js` | 引入跨会话持续漂移的内部状态，与 `soul-plan.md` 第三条原则有张力，需你拍板 |
| 9 | 装配证词（读 `assembly.contexts`） | `lib/attest.js` | 纯增量诊断，风险最低，但价值取决于是否真的怀疑注入失效 |
| 10 | 重要度打分 + `reasons` 数组 | `lib/memory.js` `scoreRecord` | 要写进记录、要解释、要和现有 `decayRank` 排序叠加；**改动面最大的一条** |

---

## 11. 没读到的（不含糊）

- `lib/client.js`（1854 行）、`lib/diary.js`（1505 行）、`lib/api.js`（911 行）：只 grep 未通读。所以设置页交互、日记生成流程、21 条 API 的完整语义**都没有核实**。
- `lib/attest.js` 的上报路径（`record()` 全函数）与 `lib/registry.js`、`lib/secrets.js`、`lib/host.js` 未读。
- `kindBonus` 的具体系数（`lib/memory.js:1194` 附近）未读到定义。
- 它的 `importance` 字段范围（注释说 0~100）与 `scoreRecord` 基准 8 的对应关系，未在代码里找到 clamp 验证。
- 全部结论仅来自 `_research/agentsoul/` 本地副本（v0.5.1），**未与 npm 上的 0.5.1 tarball 逐字节比对**。
- 星数 0 是 GitHub API 快照，不代表未来。
