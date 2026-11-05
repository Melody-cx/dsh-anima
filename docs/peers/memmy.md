# Memmy（MemTensor/memmy-agent）—— 星数最高的「跨 agent 记忆底座」

> 读取来源：本机副本 `_research/memmy/`，`src/` 下只有 15 个文件（GitHub 全量远不止，**这是抽样**）。
> 版本 `memmy-agent@1.2.401`（`src/package.json:3`）。
> 仓库数据：★**2191** / fork **216** / MIT / TypeScript / `pushed_at` 2026-11-04T03:39:34Z（GitHub API 实测，2026-11-04）。
> 已读全文或大段的文件（行数实测）：`Memory/src/service/memory-service.ts` 4003、`Memory/src/service/retrieval/retrieval-service.ts` 2819、`Memory/src/storage/schema.ts` 1095、`Memory/src/algorithm/plugin-algorithms.ts` 6383、`Memory/src/config/index.ts` 1588、`Memory/src/types.ts` 685、`Memory/src/service/retrieval/query-rewrite.ts` 39、`Memory/src/index.ts` 53。
> **未读**：`Memory/src/server/http.ts`（只 grep）、`App/`、`AgentSourceCore/`、`Knowledge/`、`Migrations/`、全部测试。所以下面凡涉及「它没有 X」的判断，只在这八个文件的范围内成立。

---

## 0. 一句话定位

它不做 DSH 插件，做的是**独立的本地记忆服务**（`http://127.0.0.1:18960`），DSH 只是它接入的第十来个 agent（`Memory/src/storage/schema.ts:860` 里能看到 `deepseek_harness` / `codex` / `cursor` / `claude_code` / `opencode` / `openclaw` / `hermes` 六个 source 分支）。CLI 三条：`memmy-memory search|add|get`（`README.md:136-142`）。

**和我们是两个物种**：它是记忆的「操作系统」，我们是记忆的「一个插件的 40 条名额」。所以能搬的不是架构，是四个常数和一个反例。

---

## 1. 检索链：七道闸，其中三道值得抄

主入口 `retrievePluginMemories`（`Memory/src/algorithm/plugin-algorithms.ts:4324`），执行顺序在 `:4385-4437`：

```
assignCandidateChannelRanks   :4385
recomputeCandidateRelevance   :4386
limitCandidatePoolByTier      :4387   ← 闸一：分档候选池
addEpisodeRollupCandidates    :4388
assignChannelRrf              :4407   ← 闸二：RRF
candidate.relevance += 0.4 * candidate.rrf   :4409
cutoff = topRelevance * relativeThresholdFloor (0.2)  :4411-4412  ← 闸三：相对阈值
mmrSelect                     :4429   ← 闸四：MMR
minRecallScore 0.12 过滤       :4430-4433  ← 闸五：绝对阈值
dedupeTraceEpisodeByEpisodeId :4436
```

### 1.1 闸一：分档候选池（**最值得抄的一个设计**）

`limitCandidatePoolByTier`（`:5355-5376`）：

```ts
const caps = {
  tier1: Math.ceil(config.tier1TopK * config.candidatePoolFactor),   // 3*4 = 12
  tier2: Math.ceil(config.tier2TopK * config.candidatePoolFactor),   // 5*4 = 20
  tier3: Math.ceil(config.tier3TopK * config.candidatePoolFactor)    // 2*4 = 8
};
```

常数在 `Memory/src/config/index.ts:502-534`：`tier1TopK:3 / tier2TopK:5 / tier3TopK:2 / candidatePoolFactor:4`。

翻译成一句话：**先按档位配额截候选池，再在池子里全局排序**。不是「全局取 top N」，而是「每档都有保底名额」。这和 dsh-mnemon 那套 `lowScoreThreshold 0.25 / highScoreThreshold 0.6 / maxMediumResults 4` 是同一个思想的两个实现——两个项目独立收敛，说明这不是巧合。

我们的对照：`dsh-anima/lib/memory.mjs:545-549` 现在是「`decayRank` 差 → `capturedAt` 倒序」两键排序 + `selectForInjection` 顺序取，**没有档、没有保底名额**。一条 `fact` 和一条 `event` 抢同一个池子。

### 1.2 闸二：RRF 的实际用法

`assignChannelRrf`（`:5541-5548`）：

```ts
candidate.rrf = candidate.channels.reduce(
  (sum, channel) => sum + 1 / (rrfConstant + channel.rank + 1), 0);
```

然后 `:4409` 只给 `+0.4 * rrf` 的**加成**，不是拿 RRF 当主排序键。

这一条纠正了 `docs/soul-plan.md` 里的一个想当然：RRF 不必是融合主体，可以只做「多路都命中」的加分项。**0.4 这个系数**是它调出来的（未见注释说明来源）。

`rrfConstant: 60` 是 RRF 论文的经典值，和 ReMe 那边 `1/61` 的上限呼应。

### 1.3 闸三：相对阈值，不是绝对阈值

`:4411-4422`：

```ts
const topRelevance = Math.max(...rankedCandidates.map(c => c.relevance));
const cutoff = topRelevance * config.relativeThresholdFloor;   // 0.2
// 没过线但 channels.length >= 2 的，multiChannelBypass 直接放行
```

**这是 ReMe 那条教训的正面解**：ReMe 用绝对阈值 `min_score=0.05` 把 RRF 结果全杀了（详见 `docs/peers/reme.md`）；Memmy 用「相对 top 的 20%」，尺度随查询自适应，再加一条「多路命中就绕过阈值」的豁免。

我们的对照：`selectForInjection` 有 `reason: 'over-limit'` 之类的丢弃理由（`lib/memory.mjs:530-601`），但没有「相对 top 分数」的概念——因为我们现在**根本没有分数**。

### 1.4 闸四：MMR（`mmrLambda: 0.7`）

`mmrSelect`（`:5673-5730`）+ `mmrCandidateScore`（`:5732-5742`）：

```ts
score = mmrLambda * relevance - (1 - mmrLambda) * redundancy
// redundancy = max(cosine(candidate.vector, 已选向量))
```

细节一：**只有 `candidate.vector` 存在才算冗余**，没有向量的候选 `redundancy = 0`（`:5738-5740`）。所以无向量环境下 MMR 退化成纯 relevance 排序——它不假装能用文本相似度替代。

细节二：`mmrSelect` 的**前段是按 tier 轮转**（`:5685-5708` 的 `for (const tier of tiers)` 循环，每轮每档最多选 1 条），选完三轮才进 `while` 循环补满（`:5710`）。也就是说 tier1/tier2/tier3 各先保底 1 条，再按 MMR 补。

细节三：`smartSeed`（`:5683-5684`）——`seedCutoff = top * 0.7`，低于这个的候选在种子阶段直接跳过。这是给「分数断崖」留的刹车。

对照我们：`docs/soul-plan.md` 写过要加 MMR。这里给出了两个我们没考虑到的约束——**无向量时的降级路径**和**档位轮转的选序**。

### 1.5 一个真实的坑：`budget` 是装饰品

`buildInjectedContext(hits, budget, ...)`（`:609-696`）签名里有 `budget`，第 `:655` 行是：

```ts
void budget;
```

`used` 变量一路累加（`:666`、`:677`、`:682`），**但从来没有和 `budget` 比较过**，`droppedDueToBudget` 数组从头到尾没有 `push` 过一次（`:659` 声明 → `:694` 原样返回，全文 grep `droppedDueToBudget.push` 零命中）。

调用点 `:2046` 传的是 `request.contextBudget ?? 1800`，`http.ts:801-802` 还在老老实实校验这个参数是不是有限数。**整条预算链是空的。**

顺带：`estimateTokens` 是 `Math.ceil(text.length / 4)`（`:545`），纯字符数除四，中文会**低估三倍**——和 dsh-mnemon 那个「按 UTF-8 字节数 + 先归一化空白」是同一个坑的两个版本（见 `docs/peers/mnemon.md`）。

**这条给我们的价值是反向的**：我们 `lib/memory.mjs:583` 按 `formatMemoryLine()` 渲染后的行长算预算、并且真的会丢，这一点**我们比它强，不要因为它是 2000 星就去改**。

---

## 2. 记忆层模型：L1 / L2 / L3 / Skill 四层

`Memory/src/types.ts:30`：

```ts
export type MemoryLayer = "L1" | "L2" | "L3" | "Skill";
```

- **L1 = trace**：一次动作的执行记录，带 `value` / `ts` / `reflection`（`reflection` 是 `IRRELEVANT | RELATED | RELATED_DEFAULT | PIVOTAL` 四值，见 `:4311-4313`）
- **L2 = policy**：从多条 trace 提炼出的经验
- **L3 = world model**
- **Skill**：可复用的操作技能

检索时按层分档（`query-rewrite.ts:39`）：`Skill → tier1`，`L3 → tier3`，其余 → `tier2`。

### 2.1 Policy 的状态机（**第二个值得抄的**）

`plugin-algorithms.ts:86`：

```ts
status: "candidate" | "active" | "verification_required" | "quarantined" | "superseded" | "archived";
```

配套字段（`:87-103`）：`experienceType`（6 值）、`evidencePolarity`（`positive|negative|mixed|neutral`）、`confidence`、`support`、`gain`、`freshnessClass`（`stable|dynamic`）、`lastVerifiedAt`、`revalidateAfter`、`salience`。

对照我们：`lib/store.mjs:217-225` 的 state 只有四值（`pending` / `adopted` / `rejected` / `superseded`），**没有 `verification_required` 和 `quarantined`**——也就是没有「先收下但标为待验证」和「隔离起来别再注入」这两个状态。

`freshnessClass: stable | dynamic` + `revalidateAfter` 这一对也很直接：**事实类记忆不需要复核，偏好类需要**。我们的 `verifyAt` 现在对所有类型一视同仁。

### 2.2 衰减：有的，而且是唯一的

`priorityFor`（`:4317-4322`）：

```ts
const decay = Math.pow(0.5, dtDays / halfLife);   // halfLife 默认 30 天
return Math.max(value, 0) * decay;
```

这个分数**只作用于 L1 trace**（`:5522-5527` 的 `else if (candidate.memory.memoryLayer === "L1")` 分支），而且只是 `relevance += priorityBlendFor(config) * priorityFor(...)` 的加成项，其中 `priorityBlendFor` 是 `Math.min(weightPriority, 0.3)`（`:5664-5667`）——**上限锁死在 0.3**。

翻译：衰减最多只影响排序的 30%，且不影响 L2/L3/Skill。这比我们 `lib/decay.mjs` 那套「四个类型四个窗口、只影响显示排序」稍微硬一点，但硬得有限。

诚实说：`TYPE_WINDOWS = { fact: 0, preference: 540, stance: 365, event: 180 }`（我们 `lib/decay.mjs:49-52`）和它的 `halfLife: 30` 相比，**我们更保守**（更长窗口 + 不参与打分）。谁对谁错没有数据，两个项目都是拍的。

### 2.3 幂等：**第三个值得抄的**

`Memory/src/service/memory-service.ts:1133-1156`：

```ts
const idempotencyKey = `${operation}:${request.adapterId}:${request.requestId}`;
const requestHash = sha256Hex(canonicalJson({ operation, fingerprint }));
if (existing.requestHash !== requestHash) {
  throw new MemoryServiceError("conflict", "idempotency key reused with different request body");
}
```

同 key 同 body → 返回缓存响应；同 key 不同 body → **直接报错**，不静默覆盖。

对照我们：`memory.add` 只靠 `similarity()` 去重，重试会生成两条近乎一样的记录（这条在 `docs/peers/reme.md` 里也记了，ReMe 用 `request_id` 1–128 字符做同样的事）。**两个项目独立收敛到「写入要幂等」**。

---

## 3. 多查询合并：RRF 在这里才是主体

`query-rewrite.ts:21-34` 的 `mergeRetrievalResults`：多条改写后的 query 各检索一遍，然后

```ts
entry.score += 1 / (rank + 1 + rrfConstant);   // :25
```

合并后还做了**保底**（`:29-31`）：

```ts
const perQueryKeep = Math.min(minPerQuery, Math.max(1, floor(limit / retrievals.length)));
const reserved = new Set(retrievals.flatMap(r => r.hits.slice(0, perQueryKeep).map(h => h.id)));
const hits = [...ranked.filter(e => reserved.has(e.hit.id)),
              ...ranked.filter(e => !reserved.has(e.hit.id))].slice(0, limit);
```

**每条 query 的前 `perQueryKeep` 条先占位，剩下的按 RRF 总分补**。这是「公平性 vs 最优性」的标准折中，和 §1.1 的分档保底是同一个思路。

对照我们：`selectForInjection` 是单路召回，没有这个问题的解法，但**如果按 `soul-plan.md` 加词面检索，就会出现两路合并**——这才是 RRF 真正该用的地方，不是 §1.2 那种加成用法。

---

## 4. 它没有的东西（已 grep 反证）

- **没有 BM25**：八个文件 grep `bm25|BM25` 的命中全部落在配置/注释，没有实现。向量检索 + FTS 是它的两条通道（`assignCandidateChannelRanks` 附近）。
- **没有在线整合**（consolidation）：grep `consolidat` 在 `Memory/src` **零命中**。L1→L2 的提炼不在本目录，推测在 `AgentSourceCore/`（**未读，不排除**）。
- **没有人工裁决闸门**：写入直接落库，状态机靠模型/规则推进，没有「等用户点头」这一步。
- **没有按 workspace 隔离**的记忆分区：`schema.ts` 里有 `namespace` / `project_id`，但我没读全 schema，**不下结论**。

---

## 5. 给 dsh-anima 的三条（按性价比排）

| 动作 | 具体改法 | 代价 | 值不值 |
| --- | --- | --- | --- |
| **分档保底** | `lib/memory.mjs` 的 `selectForInjection` 前加一层：按 `type` 分档（`fact`/`stance` 一档，`event` 一档，`preference` 一档），每档先保底 N 条再从全局补 | 改动集中在 `selectForInjection` 一个函数；要先定「档」的定义。我们现在**没有分数**，所以保底是唯一能立刻做的版本 | **值**，一次改动就能解决「一条 event 挤掉 fact」 |
| **相对阈值** | 有了分数之后，丢条件从「超 40 条」改成「低于 top × 0.2 且只命中一路」 | 依赖先有分数（这轮没有） | 留到有分数那一步 |
| **幂等键** | `memory.add` 加 `requestId`，同 id 同内容返回原记录，同 id 不同内容报错 | 要改 `index.mjs` 的 add 路由 + `lib/store.mjs` 的区域；前端要能传 id | 中等，取决于用户会不会重复点 |

**不建议搬的**：L1/L2/L3/Skill 四层（我们的 `type` 四值已经够用，加层是纯税）、四档状态机（`verification_required` / `quarantined` 在我们「用户点选采纳」的模型里没有对应动作）、MMR（没有向量，退化后没用）。

---

## 6. 一句话教训

一个 2191 星、TypeScript、MIT、有桌面端有 CLI 有 HTTP 服务的项目，`buildInjectedContext` 的 `budget` 参数是 `void budget;`，`droppedDueToBudget` 从头到尾没 push 过一条。

**星数不证明细节正确。** 我们 `maxInjectedChars: 4000` 真的会丢，这一点比它强，别改。
