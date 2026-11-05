# 邻居插件的可搬精华（供 dsh-anima 参照）

调研时间：2026-11-03 | 本机宿主 dsh `0.2.1-rc.3`
来源：各项目 README / 源码逐文件读取，行号为原文行号；凡是没读到的一律写在第 10 节，不补猜。

---

## 0. 我们现在的状况（自己仓库实测，先立靶子）

| 位置 | 现状 |
| --- | --- |
| `dsh-anima/index.mjs:114-117` | `ORDER_IDENTITY=10` `ORDER_MEMORY=20` `ORDER_PENDING=21` `ORDER_QUALITY=30` |
| `dsh-anima/index.mjs:475-478` | 四段全部走 `systemPrompt.section()` |
| `dsh-anima/lib/memory.mjs:545-549` | 注入排序键只有两段：`decayRank` 差 → `capturedAt` 倒序 |
| `dsh-anima/lib/memory.mjs:530-601` | `selectForInjection()` 每条已采纳记忆都给 `included` + `reason` + `reasonText`（**这是我们的优势，别改没了**） |
| `dsh-anima/lib/memory.mjs:583` | 预算按 `formatMemoryLine()` 渲染后行长算（也是优势） |
| `dsh-anima/lib/config.mjs:79-80` | `maxInjected=40` / `maxInjectedChars=4000` |
| `dsh-anima/lib/injection.mjs:13` | `INJECTION_PRODUCER_KIND='plugin:dsh-anima'`，`form:'snapshot'`（会话格式 v4 要求自持 kind） |

结论：**注入位置和召回打分这两处，我们还停在最原始的做法。**

---

## 0.5 宿主源码实测 —— 推翻了下面第 1 节的结论（2026-11-04 补）

第 1 节的所有说法都来自**邻居插件的注释**。我后来把宿主的 `app.asar` 拆开读了
`@deepseek-ai/dsh-system-prompt/lib/index.js`（410 行）和 `dsh-agent-loop`（2024 行），
结论不一样。完整记录见 [`docs/host-prompt-semantics.md`](host-prompt-semantics.md)。

**被推翻的三条：**

1. **「section 是死的，必须迁 context」—— 假。**
   `dsh-system-prompt.js:386-394` 里 `typeof section.text === "function"` 是支持的，
   每轮现算；`assemble()` 里 `layer.sections` 是**带 scope 合并**的（`:364`）。
   dsh-living-memory 注释里那句「section 路 scope 层断链（死）」，在宿主源码里找不到对应分支。
   **那是它在某个特定场景下的观察，不是宿主的设计。**

2. **「迁 context 是为了能注入」—— 假。迁 context 是为了保前缀缓存。**
   真正的分水岭是 `dsh-agent-loop.js:335-350` 里的一行：
   `if (this.retained?.text === snapshot) return;`（内容没变 → 一条事件都不发）。
   而 section 变了走 `SystemPromptProjection`，`if (head.text !== rendered)` → **整段 replace**。
   所以这不是「能不能注入」的问题，是「变了之后断多长」的问题。

3. **「四段都要加 `required: true`」—— 半假。`required` 只对 context 生效。**
   `dsh-system-prompt.js:395`（contexts 的 filter）和 `:401-405`（二次过滤）里才有
   `entry.required === true`，sections 从头到尾没有任何 `required` 判断。
   我们用 section，加了也没用；迁了 context 才必须加。

**新发现的两个真问题（比上面三条重要）：**

- **`{{` 会让整轮装配抛异常。** `interpolate()`（`:159-183`）遇到
  `{{` 后不跟 `标识符}}` 抛 `malformed`，标识符没注册抛 `unknown`，
  抛出点在 `assemble()` 内部 —— 不是「这段空着」，是整次请求起不来。
  而我们四段里有两段装用户自由文本（persona、记忆正文）。
  已实测：`compilePersona({userBio:'我的笔记格式是 {{key: value}}'})` 一路活到宿主并抛 malformed。
  **已在 `index.mjs:474-483` 四段全加 `interpolate: false`，并在 verify-core 加了 4 条回归。
  §8 第 127 行那条 fish 的 `{{time}}` 踩坑，就是这个坑，我们已经堵上了。**

- **context 的 text 函数每 step 跑一次，不是每轮一次。**
  `preStep()` 一次（`dsh-agent-loop.js:908`），每个 `step()` 再一次（`:1054` 的 `refreshContext`），
  而 `turn()` 里 `while(true)` 每个 step 都调 `preStep`（`:954-957`）。
  → 一个 turn 有 N 个 step，就是 **1+N 次**。
  dsh-auto-memory 注释说「恰好两次」，是它那个场景只有一个 step。
  **这对我们是硬约束：memory 的 text 函数里有文件 IO**
  （`overridesForContext` → `resolveOverridesFromCwdSync`，实测 0.073ms/次、7 次 statSync），
  迁到 context 会变成每 step 都跑。迁移前必须先把它变成纯内存或加缓存。

**修正后的方向①表述**：不是「全部迁 context」，是
「identity/rules 留 section 进前缀缓存，memory/pending 迁 context 每轮现算」——
但迁之前要先解决「text 函数每 step 跑一次」这件事。

---

## 1. 注入位置 —— 三个项目独立收敛到同一答案

动态记忆不进 system prompt 主干：

- **dsh-fish-memory**：`systemPrompt.context({name:'memory', order:900})`。注释原文（`index.js:4260-4268`）：section 方案让「提示词只多了 550 token，但**整段一万二的缓存全废了**」。
- **dsh-mneme**：`ctx.systemPrompt.context({name:"memory", order:90})`，另有 `memory-guide` section `order:150`（`src/inject.js:345-360`）。
- **MemOS**：记忆干脆作为**一条独立 user 消息**追加（`dist/adapters/deepseek-harness/bridge.js:120-126`），`section` 只放 3 行静态引导、`order:114`（`index.js:313-317`）。全仓 `grep kv.cache|prompt cache|prefix cache` **零命中** —— 也就是说它这么写没有把理由归到缓存上，只是碰巧一样。

补充一条机制说明（dsh-memory-evolve 观察到）：`systemPrompt.context()` 的内容被 DSH materialize 成 user-role 尾部消息，**文本不变就不重新追加**，所以前缀缓存保得住。

代价：MemOS 自己在 `README:61-64` 承认 adjacency 不保证 —— 记忆和用户问题之间可能插进别的宿主上下文。

---

## 2. 召回打分 —— 我们最大的洞

### dsh-fish-memory（★460，npm 1.5.2，2026-11-03）

- 总分 `P = C × (0.55 + 0.25·A + 0.15·I + 0.05·E)`（`index.js:3054`）
- 证据分 `C = s / (s + 0.8)`，`s` = 命中词的 IDF 归一化稀有度之和（`index.js:3010-3011`、`2707-2738`）
- 刻意**不除以问句长度**；整句原话命中直接顶到 0.85
- 鲜活度 `A = 2^(-天数/H)`，`H = baseHalfLifeDays × (1 + 2·I)`（`index.js:2938`）
- 默认普通事件 **30 天**减半、情绪 **7 天**减半（`index.js:119-120`）
- `stable_profile` 恒定不衰，每轮固定带 2 条，**且不占那 6 个名额**（`index.js:2949`、`3423`）

### dsh-mneme

- `config.recallFusion` 三选一：`blend`（默认）/ `rrf` / `minmax`（`src/service.js:775-870`）
- RRF 公式 `Σ 1/(60 + rank + 1)`（`service.js:817-825`）
- 权重 `wv=0.6`（向量）、`wk=0.4`（关键词）（`DEFAULT_HYBRID_WEIGHTS`，`service.js:517`）

### MemOS（★12228，npm 2.0.21）

- 融合：`relevance = bestChannelScore + rrfWeight·Σ1/(k+rank+1) + priorityBoost + etaBoost`，`rrfConstant=60`（`core/retrieval/ranker.ts:79-83`）
- 重排：MMR `λ=0.7`（`core/config/defaults.ts:291`）+ 可选 LLM 精排一轮（`llmFilterMaxKeep: 4`）
- 四路召回：余弦 + FTS + pattern 关键词 + 结构化 error-signature
- 阈值是**相对**的：`relativeThresholdFloor: 0.2`（= `topRelevance × 0.2`）；硬门槛 `minTraceSim: 0.25`
- 被否掉的老公式（`ranker.ts:9-10`）：「without the **"cosine=0 for keyword hits"** trap the old formula had」

### 反面教材（照抄会踩）

- fish `CHANGELOG.md:1018-1019`：「早先试过『相对门槛』（`C >= 0.7 × 最高分` 就留），**误杀**：分数低不等于不相关，只是那条撞得没那么准 → 放弃了」
- MemOS `core/config/defaults.ts:209-224, 295-305` 把每次调参的「从多少到多少、为什么」写死在注释里。但同一文件出现**注释说 3→2、代码值是 1** 的脱节 —— 光写注释不够，当前值得自动生成。

---

## 3. 预算与名额

- 我们：40 条 / 4000 字
- fish：6 条 + 800 字，长期事实的 2 条**不占**这 6 个名额
- mneme：`maxInjectedItems=5`（1-20），单条 `injectContentMaxChars=300`，整块 `MAX_BLOCK=max(1500, maxContent+600)`，pin 条目硬顶 2000
- MemOS：`contextMaxChars=6000`，`tier1/2/3 topK = 3/5/2`

**关键数字（dsh-mneme README）**：`cap=16384` 时撞顶 **78.9%**、净总量 **+54.1%**；`cap=32768` 降到 **+15.9%**。
→ 预算卡太紧会反噬，不是越省越好。

---

## 4. 冲突与取代

- **dsh-mneme**：冲突对写进 `conflict_pending` 表，`outcome='conflict-pending'`，既不删也不归档；`GET /api/dsh-mneme/conflicts` 分页 + `POST /api/dsh-mneme/conflicts/resolve {id, winner:"a"|"b"|null, apply}`；**CAS 失败就不标记 `resolved_at`**，把冲突留在队列重试（`src/service.js:2092-2135`）。
- **fish**：用「事实键」（如 `她.身高`），同键只留最新，旧的标「已被取代」不再注入但可撤销；删除是软删，可单条/批量找回（`index.js:3125-3145`、`5533-5548`）。
- **MemOS**：supersede 交给模型决定，prompt schema 直接带 `supersedes_world_ids`（`core/memory/l3/abstract.ts:123`）；L2 层同签名不新建，转 `mergePolicyEvidence` 提升 `support`（`core/memory/l2/l2.ts:262-296`）。
- **mneme 的镜像同步**：写回 Markdown 前先 `reconcileHumanEdits` 三方合并，用 `sha256(title\0content)` 判人工改动；真冲突时**两边都留**（`src/mirror.js:1886-1930`）。

---

## 5. 触发点 —— 巡夜会踩的坑

- dsh-memory-evolve issue #24 原话：「DSH 核心不发 `agent/settled`……原监听永不触发 → 轮次计数恒 0 → review 永不 due」，2026-08-22 改成 `agent/turn-stopping`。
- 同一项目：到期**不清零**，注释「due stays sticky… so a missed turn cannot silently drop the review」。
- MemOS `core/pipeline/memory-core.ts:722-730`：`init()` 曾经 `await` 整条 reflect → reward → L2 链，**30k+ traces 时阻塞主事件循环 3-5s+**，直接超 WebSocket 的 3s 读探针 → 改成后台 promise。

---

## 6. 存储与迁移

- **MemOS**：SQLite（`better-sqlite3 13.0.3`），WAL + `busy_timeout` + `foreign_keys=ON`；原子写靠事务 + `withRetry` 处理 `SQLITE_BUSY`（3 次、25ms 自旋，`core/storage/tx.ts:24-57`）。迁移 19 个编号 `.sql` + `schema_migrations` 表，注释硬规定 **「Migrations are additive only. Renames / drops need a major version bump.」**
- **mneme**：主表含 `content_hash` / `content_history` / `epistemic_status` / `importance` / `last_accessed_at` / `evidence`（`src/store.js:21-45`）；审计表 `dream_runs` / `receipt_chain` / `recall_runs` / `conflict_pending`。

---

## 7. 元数据 —— 我们缺的维度

- **MemOS**：`policies.confidence`、`world_model.confidence`、`skills.eta`；三条溯源链 `source_episodes_json` / `source_trace_ids_json` / `policy_ids_json`。
- **mneme**：`epistemic_status`（默认 `subjective`）、`importance`（1-5）、`evidence`、`content_hash`、`content_history`。
- **evolve**：**没有置信度字段**，用 `hits`（同一建议复现次数）当事实上的置信度；条目头部顺序固定 `[id:8位hex]` → 时间戳 → `[git <branch>]`×N → `[branch:main,dev]` → `[dsh-only]` → `[summary:…]` → 正文，条目用 `\n§\n` 分隔。
- **我们**：只有 `type`（fact/preference/stance/event）+ `layer` + `verifyAt`。**没有「这条我有多大把握」这个维度。**

`[dsh-only]` 这个标记很有意思：注入给外部 CLI 时整条跳过，等于「这条记忆只在本家工具里用」。

---

## 8. 踩坑原文（可以直接抄进我们的注释）

- evolve issue #17：**Windows CRLF**，`name: foo\r` 解析失败 → 技能被**静默跳过**。（我们在 Windows 上，这条尤其要注意）
- evolve issue #59：展示层每剥掉一种元数据，就必须同步扩匹配层 —— `id` 与 `summary` 各漏过一次。
- evolve 原文：「本插件对 LLM 前缀缓存的优化是**尽力而为**，并未彻底解决。」
- evolve 被否：COI 记忆注入曾有全局默认开关，已移除（会诱导 AI 为拿记忆去选 project + 隐私风险）；Advisor 的「非用户指令」标记 2026-08-13 拍板放弃（会让人质疑来源、执行力下降）。
- MemOS `core/storage/keyword.ts:159`：「Length 1 is too noisy.」（单字不进关键词）
- MemOS `core/retrieval/llm-filter.ts:4-8`：「mechanical retrieval is **greedy** — any Python prompt pulls back every Python-tagged trace even when the sub-problem doesn't match」
- mneme README：`dream_consolidate` 输出 token 里只有约 **11.8%** 是决策正文，其余约 **88%** 是推理与 JSON 骨架。
- mneme README：`dreamCandidateMode=window` 下，「45 对『双方活跃且 sim≥0.85』里 **0 对**能同时进窗口」。
- fish `CHANGELOG.md:288-292`：记忆里存过 `{{time}}` 会让**每一轮都失败**，只能关插件。

---

## 9. 负面教材（别学的）

- evolve 的 `skill_manage` patch 直接整文件覆盖 `SKILL.md`：**没有回滚、没有版本备份、没有 diff 审批**。记忆文件有 `.bak.<时间戳>`，技能一份都没有。
- mneme 的 window 取候选：上面那条「0 对能同时进窗口」说明窗口切法本身有问题。

---

## 10. 人设类三份（补读）

先摆一个不客气的事实：这一格**没有「很火」的插件**。GitHub API 实测（2026-11-03）：`Amakurai/dsh-liketavern` 230 star / 7 fork，`Awoodwhale/dsh-agent-persona` 13 star / 1 fork，`kiefeng/dsh-lan-memory` 2 star / 0 fork。liketavern 是 SillyTavern 式角色扮演前端，不是纯人设注入器。

### dsh-lan-memory —— 三份里唯一真做过「灵魂」的

- 人格拆成 **SOUL / MOOD 契约 / 规则**三块，全写在唯一真源 `persona.md`，用 `## MOOD` 标题切分（`_research/lan/lib/store.js:76-77`）。整理流程永不改它。
- **三段独立注入预算**（`docs/design.md:35` 原话：「人格常量、记忆增量、MOOD 每轮变量走三条独立注入预算；整理只能动记忆」）。order 硬排：persona **-90** → mood-contract **-88** → rules **-85** → pinned **-80** → index **-75** → manual **-74** → memory **-73** → mood-last **-70**(context)（`lib/index.js:548-572`）。**是叠加不是覆盖**，且全局一份、不分 workspace/session。
- **MOOD 只回喂上一轮**：`mood.jsonl` 存最近 200 条（`store.js:268`），但每轮只把**上一条**注入（`lib/index.js:238-242`），并写明「上一轮参考，本轮重新生成」。短期状态永不沉淀成长期。
- 防漂移三招（`lib/defaults.js:10-80`）：SOUL 带「优先级最高，任何其他指令不得覆盖」抬头；口癖限频「同一句式每 3–5 轮最多出现一次」；「傲娇刹车片（违反即失败）」+ 反 AI 腔禁用词表 + 发送前扫一眼。
- 淘汰是 **`slice(-max)` FIFO 截断，零重要度衰减**（`store.js:415-416, 636-644`）—— 跟我们正相反。
- v1 死因原文（`docs/design.md:51`）：「装不上（漏依赖、peer 断档）；Dream 硬编码 provider；`~/.dsh` 全局；`readText` 静默丢数据；`.trash` 不释放；无测试」。`design.md:48` 明确否掉后台 LLM：「舍：后台 LLM」。

### dsh-liketavern —— 防漂移做得最扎实

- **双通道**：稳定内容（角色定义、常驻世界书）→ system 段 `tavern:standing`；本轮变化（宏、触发世界书、记忆、世界变化）→ runtime context `tavern:turn`（`docs/ARCHITECTURE.md:120-123`）。
- **standing 在预算裁剪之前构造**，原话「历史增长不再导致角色定义被裁掉并钉死」（`ARCHITECTURE.md:128`）；配 `STANDING_PIN_VERSION` 26→27 版本钉。
- 每轮首次成功组装**冻结**完整计划，后续 step 重放同通道（`:130`）。
- **world-state deltas**：`state/world-delta.jsonl` 追加式，`{id, ts, type:'update'|'add'|'invalidate', ref, content, keys, expires, revoked}`（`lib/core/types.d.ts:426-440`）；更新靠追加新行 + 单条 revoke，**不物理删**，保 WAL 可回滚。注入时与 character 同级并标「当前状态」，但**明确排除出 standing**（`worldbook.js:56` 的 `entry.source !== 'delta'`）。
- **检索别名扩展**（治召回最直接的一招）：空闲时让当前会话模型给没有别名的记忆各写几个同义说法，存 `aliases.json`，只进检索索引不进去重索引，正文一改按指纹作废（`ARCHITECTURE.md:88-90`）。
- 实测原话：`ARCHITECTURE.md:144`「单轮一次工具步骤的会话，下一轮只命中约 5k/24k」（前缀缓存）；`ARCHITECTURE.md:94`「试过把『句首的字』也放宽，20 句无关短句里会多一句误命中，没有采用」。

### dsh-agent-persona —— 覆盖式、无防漂移，但有一个好端点

- 人设 = 一条记录 `{id,name,enabled,text,mode,targets[]}`（`src/index.ts:8-11`），正文即整段 system prompt。
- **按位置选一条、只取第一条、不拼接**；解析：target 命中 → 具体度打分（会话 ID 3 分 > 工作区 1 分）→ 同分取靠前 → 谁都没命中用默认 → 正文空 = 显式关掉（`README.md:170-181, 234`）。
- 注入点 `order = getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1`，即 **1**（`src/index.ts:26-32, 1846-1853`）。replace 模式把 `deployment:persona-prefix` 与 `harness:identity` 两段置空（`:1196-1221`）。
- **`sessionPrompt` 端点值得抄**：不重算，而是从会话持久化事件日志里读最后一条 `system/message` 的文本 —— `sessionPersistence.open(id,'read')` → `handle.read(cursor, 2000)` 分页最多 12 页（`src/index.ts:1273-1308`）。注释：「read out of its own event log, so it is the assembled text rather than a reconstruction」。
- 防漂移：**没有**。作者自己在 `README.md:226` 说「人设是行为约束，不是安全边界」。
- 工程上最值得抄的是 `tools.guard` 按**能力**判定而非工具名（`src/index.ts:1864-1866`）—— 因为它踩过：两个工具名白名单放过了 `str_replace_editor`、`terminal_send` 和 apply_patch 的正文。

### dsh-agent-soul —— 0★，但和我们同构度最高

完整报告见 [`docs/peers/agent-soul.md`](peers/agent-soul.md)。`danshuyue/dsh-agent-soul` **0 star / 0 fork**（GitHub API 2026-11-03 实测），2026-10-28 建仓、四天发 7 个版本、`_research/agentsoul/` 有完整 12055 行源码。按「星高」的标准它不该被读；按「同一道题别人怎么解」它有四样和我们重合：人格 + 会遗忘的记忆 + 惦记的事 + 心情。

只挑四条最硬的：

- **`required: true` 我们一段都没加**。它四段全加，理由是宿主 `assemble()` 只按 `!suppressed || required === true` 过滤 contexts（`lib/index.js:636-638, 667-670`）。【推断】在 `includeRuntimeContext=false` 的会话里我们的人设与记忆会被整段抑制。
- **它用 `systemPrompt.context` 而我们用 `section`**，根本差别是：context 的 `text()` 是函数，可以「首轮注入、之后每 15 轮补一次」（`PERSONA_REFRESH_TURNS = 15`，`lib/index.js:429, 498-521`），section 做不到，只能每轮 dispose+register——**我们每轮都在付缓存重建的钱，它不用**。
- **注入分「固定区 + 相关区 + 兜底回填」三段**（`lib/memory.js:1226-1240, 1288, 1351`）：`priority >= 100` 的固定区永不被预算裁剪，相关区按当前用户消息打分只取 topK=3 且每行 ≤48 字，全文交给 `soul_memory` 工具按需查。我们是 40 条平铺，预算紧张时「用户是学生」和「三天前吃了什么」平等竞争。
- **`attest.js` 是我们完全没有的验证维度**：它等 `system-prompt/assemble` 的 waterfall 返回后直接读 `assembly.contexts`，来判断「返回的文本有没有真的进最终提示词」。原话「程序没崩，就当成了送到了」。我们全仓 `grep "system-prompt/assemble\|contexts"` **零命中**——我们只检查回答（十二条质检），不检查注入。

反面：它也没有解决「相关性 vs 时效性」（自认「一条 clarity 高的旧事可能排在今天刚发生的事前面」，`lib/memory.js:1173`），mood 判定依赖外部 LLM（25 秒超时候打 siliconflow），目的机制引入跨会话持续漂移的内部状态。

## 11. ReMe（★3747，全生态星数最高的记忆项目）

完整报告见 [`docs/peers/reme.md`](peers/reme.md)。挑四条硬的：

- **没有时间衰减，一个都没有**。`memory_as_file` / `memory_search` / `auto_memory` / `auto_dream` / `auto_link` / `proactive` / `steps/index/search.py` 里找不到任何 decay / importance / 访问频次打分。规模控制靠三样：容量上限、BM25+HNSW 的 **tombstone 删 + 夜间 `optimize_index_cron` 压实**、以及每晚 23 点的 dream 重组。
  【判断】这不证明我们的 `lib/decay.mjs` 错，但说明**规模控制有两条路：删（衰减）和重组（合并提炼）**。我们只有前者。
- **`CREATE / CORROBORATE / REFINE / CORRECT` 四动作，且 `Integrate has no SKIP action`**。这正是我们缺的冲突消解模型 —— 我们 `stance` 类型打架时只有人工 `supersededBy`，没有「同一件事再次确认 → 加权」「措辞更准 → 改写」「说错了 → 纠正」。
- **`request_id` 幂等**（1–128 字符，同 ID 不同输入直接拒绝）。我们 `memory.add` 只靠 `similarity()` 去重，重试会生成两条近乎一样的记录。
- **`min_score=0.05` 把混合检索结果全杀了**：双路命中时 RRF 上限只有 `1/61 ≈ 0.01639`，任何非零阈值都误杀，且现象是「一条都搜不出来」很难联想。我们若按 `soul-plan.md` 加 RRF，**`min_score` 默认必须是 0**。

反面：它的检索结果正文**没有 token 预算**，`search.py` 直接把 `c.text` 全量拼进 answer。这一项我们比它强，`maxInjectedChars=4000` 不要动。

## 12. operator-memory（★493）—— 唯一一个故意把「智能」全砍掉的项目

完整报告见 [`docs/peers/operator-memory.md`](peers/operator-memory.md)。它不是 DSH 插件，是**跨 7 个 harness 的文档型记忆层**，DSH 只是一个宿主，`packages/deepseek/src/index.ts` 39 行，`inject=["systemPrompt"]`，**和我们是竞争关系**。

它的四个「没有」：没有检索（`Nothing is ranked, guessed, or retrieved by similarity`）、没有打分、没有衰减（frontmatter 只有 `description` / `read_if` 两个字段，物理上没有衰减原料）、没有预算（preamble 长度完全由磁盘文件大小决定）。

真正值得看的是三条：

- **单位置覆盖式真相 + 权威序**：`Private > User > Shared`，`preamble.ts` 原文「On conflict, later wins」。冲突消解不判断「哪条更新」，判断**哪个分区更权威**。【判断】可搬但要缩范围：只给 `stance` 做「一个话题一个槽」，`fact`/`event` 保持逐条。
- **渲染一次 + `WeakMap<Agent, Promise<string>>` 记忆化**，配纪律「Do not refresh on every turn merely to track Brain edits」。这是前缀缓存问题的标准答案，且明确写出代价：**本轮写的东西本轮看不见**。所以只能套到 identity/style/instructions 三段，**memory 段绝对不能套**。
- **失败即丢弃**：任一分区加载失败，整段记忆换成诊断文本（`preamble.ts` 约 28–33 行）。一致性最高，代价是一次坏文件整段消失 —— 必须接巡夜上报，否则用户永远不知道记忆被降级了。

它自认**没有任何 benchmark**（issue #48 作者原话：Operator 无法被测试）。所以这条路的真实水平目前无人知道。它给我们的价值不是一个可抄的实现，而是**一个反例边界**：如果哪天我们开始堆越来越多的打分参数、阈值、衰减窗口、后台进程，可以回头问一句 —— 这些真的比「写清楚、让人读」更有用吗？

## 13. dsh-mnemon（★861）—— 唯一把「分档配额」做实了的

完整报告见 [`docs/peers/mnemon.md`](peers/mnemon.md)。它和我们是同一件事的两个极端：它 796KB、16 个工具、模型驱动召回；我们 40 条记忆、0 工具、用户点选。所以能搬的不是架构，是**三个常数**。

真正值得抄的四条：

- **相关性分档 + 配额**（`recall-quality/policies.ts:32-34, 45-59`）：`lowScoreThreshold 0.25` / `highScoreThreshold 0.6` / `candidateMultiplier 3` / `maxMediumResults 4` / `maxRankedResults 4` / `maxUnknownResults 2`。翻译：低于 0.25 直接丢，0.25–0.6 最多 4 条，≥0.6 最多 4 条，分数不可用的最多 2 条。**这是我们 `selectForInjection` 最缺的东西** —— 现在是「两个排序键 + 取先到者」，等于有排序没分档，0.9 分和 0.2 分进同一个池子。代价：得先把排序键归一化到 0–1，否则阈值无从谈起。
- **预算口径按 UTF-8 字节 + 先归一化空白**（`lib/index.js:9882-9883`）。我们 `maxInjectedChars: 4000` 如果按 `String.length` 数，中文一字算 1、字节算 3，实际少估三倍。代价：要统一改三处入口（`index.mjs:254`、设置页预览、`/api/anima/state`），否则「预览有、实际没有」的老病再犯一次。
- **写入闸门两级漏斗**（`lifecycle.ts:683-709` + `review-activity.ts:7-46`）：先用便宜的正则 / 长度（用户 ≥320 字、助手 ≥600 字）/ 非本插件工具调用筛「这一轮值得审」，再让模型判断写什么。这直接解释我们的 `memories` 表为什么是 **0 条** —— `autoCapture: true` 开着但表是空的，说明捕获触发条件没接上。代价：中文触发词表要按实际语料重写。
- **`agent/pre-step` 的 `{ prepend: true }`**（`lifecycle.ts:263-273`）。注释原文：「a prompt interceptor or late lifecycle registration cannot leave memory tools without their turn pin」。我们 `index.mjs:380` 的钩子**没有** `prepend`。代价：一行改动，但要跑 `scripts/verify-core.mjs` 确认顺序没被别处依赖。

**它没有的**（已 grep 反证，不是我漏看）：BM25、RRF 融合、rerank、时间衰减。`lib/` 下搜 `bm25|rrf|rerank` 的 59 处命中里 54 处是 `refused` 误命中，剩下全是 Provider 文案；`grep decay|ttl|half-life|prune` 在已读范围**零命中**。它靠 `importance` 三档 + 容量上限（USER.md 4096B / MEMORY.md 10240B）做取舍，满了就整条归档，不判时间。

顺带一条方法论教训：`rerank` / `rrf` 这种短模式 grep 会被 `refused` 污染，下次加词边界。

## 14. Memmy（★2191）—— 星数最高的那个，预算链是空的

完整报告见 [`docs/peers/memmy.md`](peers/memmy.md)。它是独立本地记忆服务（`127.0.0.1:18960`），DSH 只是它接入的第十来个 agent，**不是我们的同类**，但四个常数有用：

- **分档保底**（`Memory/src/algorithm/plugin-algorithms.ts:5355-5376`）：先按 `tier1TopK×4 / tier2TopK×4 / tier3TopK×4` 截候选池，再池内全局排。不是「全局取 top N」，是「每档都有保底名额」。和 dsh-mnemon 的 `maxMediumResults:4 / maxRankedResults:4` 是同一思想的两个实现——两项目独立收敛。我们 `lib/memory.mjs:545-549` 只有两键排序，一条 `event` 能挤掉一条 `fact`。代价：得先定「档」怎么分，但**不需要分数**，是现在就能做的一版。
- **RRF 只做加成不做主体**（`:4409`）：`candidate.relevance += 0.4 * candidate.rrf`，不是拿 RRF 当主排序键。这条纠正了 `soul-plan.md` 的一个想当然。代价：0.4 这个系数没注释来源，搬过来得自己调。
- **相对阈值而非绝对阈值**（`:4411-4422`）：`cutoff = topRelevance × relativeThresholdFloor(0.2)`，且「两路都命中」时 `multiChannelBypass` 直接绕过阈值。这是 ReMe 那条 `min_score=0.05` 事故的正面解。代价：依赖先有分数。
- **写入幂等**（`Memory/src/service/memory-service.ts:1133-1156`）：`operation:adapterId:requestId` 做 key，同 key 不同 body 直接抛 `conflict`。ReMe 用 `request_id` 做同样的事——又一次独立收敛。代价：要动 add 路由 + store 区域 + 前端传 id。

**反例价值最大**：`buildInjectedContext(hits, budget)` 里第 `:655` 行是 `void budget;`，`droppedDueToBudget` 声明了从头到尾没 `push` 过一条，调用点 `:2046` 还在传 `request.contextBudget ?? 1800`。**整条预算链是空的。** `estimateTokens` 还是 `Math.ceil(text.length / 4)`（`:545`），中文低估三倍——和 mnemon 同一个坑。

结论：我们 `maxInjectedChars: 4000` 真的会丢，这一点比它强，**别因为它是 2000 星就去改**。

它没有的（在已读的 8 个 `Memory/src` 文件内 grep 反证）：BM25、在线整合（`consolidat` 零命中，L1→L2 提炼推测在未读的 `AgentSourceCore/`）、人工裁决闸门。

## 15. dsh-living-memory（★3）—— 全生态唯一一句「帽值不凭空设」

完整报告见 [`docs/peers/living-memory.md`](peers/living-memory.md)。**★3，是这轮读过的所有插件里星数最低的，也是信息密度最高的一份**：`index.cjs` 13848 行，注释里的日期从 2026-08-22 排到 2026-09-21，每处改动都写着「哪天、哪个审计发现、为什么改、回退开关是哪个」。

四条值得抄的：

- **先建账、后定尺**（`index.cjs:1902-1940`）：`INJECT_BUDGET_BYTES` 默认 **0 = 观测期不告警**，先只记 `ctxMax/wfMax/samples`，等实测峰值出来再定帽。原话「帽值**不凭空设**」。这直接打脸我们 `lib/config.mjs:79-80` 的 `maxInjectedChars: 4000` —— 那个数是拍的，`soul-plan.md` 里翻不到来源。代价：20 行 meter，不碰逻辑。
- **RRF 用 k=2 不是 k=60**（`index.cjs:11918`）：实测总召回 **22.2%→80.6%**，注释引 Qdrant「单真相关场景 k=2~5」。另两条硬数字：vec 独有命中必须 **×0.5 打折**，否则 92.5%→75.8%；融合取 `max` 不取 `sum`。这修正了 `soul-plan.md` 把 k=60 当默认值的想当然。代价：`k` 必须先测，我们语料只有 40 条，照抄 2 也未必对。
- **衰减的四个豁免**（`index.cjs:12054-12100`）：`todo` / `essential` / `mirror:` 源 / `event_at` 锚。最有价值的是 **FadeMem 验证调制** `half × (1+0.35·ln(vc))`，帽 2.0 —— 被确认越多忘得越慢。我们排序键 `decayRank → capturedAt` 压根没有「被确认过几次」这一维。代价：要动 store schema，但 `memories` 表现在 0 条，**现在改零成本**。
- **配置即数据**（`criteria-rules.default.json`）：行为判据全部外置成 JSON，11 个 key。动因原话「该判据曾被净化链整体英文化 + 加 i 而**未披露** ⇒ 字面量留码面＝每次净化都再改一次行为且无人知」。我们 `lib/quality.mjs:26-114` 的 `QUALITY_RULES` 硬编码在 JS 里，改措辞只能改代码。代价：~200 行加载层 + 三层 fallback。

另有两条负面证据：`README.md:129-131`「凭据正则缺 `(?<![A-Za-z0-9])` 边界会把 `task-…`/`disk-…` 当成 `sk-`/`ak-` 吃掉」；`:370` 记的「一旦标记永久占席」事故（13/17 条常驻席全是旧条）——**常驻席位必须有上限**，它定的是 3 条。

**这句话值得单独立在这儿**：★3 的项目里有全生态唯一一句「帽值不凭空设」，而 ★2191 的 Memmy 里 `budget` 参数是 `void budget;`。**按星数排序读插件，会错过这份。**

## 16. dsh-x-memory（★766，DSH-X 内置件）—— 「按内容变不变分工」比「section 还是 context」精确

完整报告见 [`docs/peers/dsh-x-memory.md`](peers/dsh-x-memory.md)。ZCode「文件即记忆」的 DSH 移植，一条事实一个 `.md` + `MEMORY.md` 索引 + 六把工具。和我们哲学不同（它模型自判该记什么，我们用户点选），但三件事值得抄：

- **`section` 和 `context` 按「内容会不会变」分工**（`lib/index.js:222-251`）：`GUIDANCE` 常量走 `section`（`order: 700`，`interpolate: false`，进前缀缓存）；动态索引走 `context`（`order: 95`，`text` 是函数）。**这修正了 soul-plan 方向①的表述** —— 不是「全部迁 context」，是「identity/rules 留 section 进缓存，memory/pending 迁 context 每轮现算」。代价：两处注册改动。
- **三处 try/catch，失败即降级**（`lib/index.js:233` 注释原文：「渲染必须是同步且绝不抛：**装配失败会带走整个回合**。任何异常都降级成「不注入」」）。我们 `lib/prompt.mjs` 和 `lib/memory.mjs` grep 实测**零个 `try {`**（`grep -c "try {"` = 0 / 0）。`compilePersona` / `compileMemory` / `selectForInjection` 任一处遇到脏数据就炸整回合。代价：10 行。**这是本轮性价比最高的一条。**
- **超限不静默 + 双预算**（`lib/store.js:133-157`）：`INDEX_MAX_LINES = 200` / `INDEX_MAX_BYTES = 25_000` 双帽取先到，按 `Buffer.byteLength(…, 'utf8')` 数（不是 `.length`），且截断后追加一行可见 WARNING 让模型知道「你只看到一部分」。我们 `lib/memory.mjs:584-589` 是 `.length` + 静默截断。代价：`truncated` 标记 5 行。

**它做对照的价值**：`order: 95` 落在我们 memory(20) 和 PLAN_POLICY(500) 之间 —— 它把记忆当**上下文**（助手查资料），我们把记忆当**身份的一部分**（这个人记得什么）。两条路都成立，不能用对错判。

**未读**：`lib/client.js`（20128 B 面板）、`test/store.test.mjs`、`test/tools.test.mjs`。

## 17. 没读到的（不含糊）

- ~~`dearbld/dsh-living-memory`~~ —— 已读，见 §15。**未通读**：`index.cjs` 13848 行只精读约 300 行 + 40 余次 grep；`client.js`（9784 B）、`scripts/preflight.cjs` 实现细节、`NOTICE`、`RELEASE-NOTE-CLARIFICATION.md` 未读。
- **`MemTensor/memmy-agent`（★2191 / fork 216 / MIT / `pushed_at` 2026-11-04T03:39:34Z）只读了 `Memory/src` 下 8 个文件**（本机抽样 15 个文件，全仓远不止）。`App/` `AgentSourceCore/` `Knowledge/` `Migrations/` 与全部测试**未读**，所以 §14 里「它没有 X」只在已读范围内成立。
- `@dsh-kit/agent-memory` 这个 npm scope **不存在**（`registry.npmjs.org/@dsh-kit/agent-memory/latest` 直接 404）；真实仓库是 `findshan/dsh-agent-memory`，包名 `dsh-evolving-memory` v0.2.1，main 已重写为 v2 纯 Markdown 文件式，v1 的 confidence/状态机被整体推翻。
- `dsh-agent-soul` 的 `lib/client.js`（1854 行）、`lib/diary.js`（1505 行）、`lib/api.js`（911 行）只 grep 未通读。
- MemOS 的 `core/memory/l1/README.md` 与 `docs/Reflect2Skill_算法设计核心.md`（拉取失败）
- MemOS README 声称的 35.24% / 云端 72% token 节省，**未回溯原始基准**

另：`dsh-purge`（★16393）纠正了一个常见假设 —— 它代码里**没有**按 model id / provider 选提示词的逻辑，`injectAllowedNow(config)` 全文只有 `return config.enabled !== false`，真正分支的维度是 **agent preset**。
