# ReMe（`agentscope-ai/ReMe`）工程机制调研

调研时间：2026-11-04 | 对象版本：main（GitHub ★**3747**，2026-11-03 GitHub API 实测）| 对比基线：本仓库 dsh-anima

## 0. 材料来源与可信度边界（先说清楚）

**这份报告的数据来自一个子代理的 `read_page` 通读，不是我本人逐行读的源码。** 通道是 Firecrawl 云渲染打 `github.com/blob` 页，它自带行块编号，但可能与真实文件有 ±2 偏差 —— 所以下面全部用「路径 + 函数/常量名 + 原文」定位，不引用精确行号。

读过的文件：`docs/en/{memory_as_file, memory_search, auto_memory, auto_dream, auto_link, proactive, faq, framework, context_compaction}.md`、`reme/steps/index/search.py`、`reme/steps/index/_single_search.py`、`reme/components/keyword_index/bm25_index.py`、`integrations/dsh/src/guidance.ts`、`integrations/dsh/README_ZH.md`。

**没读到**：`reme/components/file_store/` 与 `file_graph` 的实现全文、`reme/config/default.yaml` 原文（只读到 docs 里的引用片段）、GitHub issue 区。所以下文「没有 X」一律是**未见**，不是证否。

---

## 1. 一句话概括

ReMe 把长期记忆做成「**Markdown 文件是唯一真相源 + 派生索引可重建**」，检索是 BM25 为主、向量可选、RRF 融合；写入分两段（`auto_memory` 记 daily，`auto_dream` 提炼 digest）；**完全没有时间衰减**；对宿主只注入一段固定指引，**不注入记忆本体**。

---

## 2. 组织形态：文件，四层

（`docs/en/memory_as_file.md`）

- `session/` + `resource/` —— 源记录
- `daily/` —— 工作记忆。`daily/YYYY-MM-DD.md` 是索引页，正文按主题命名的卡片
- `digest/` —— 长期记忆，再分三桶：`personal/`（偏好与持久事实）、`procedure/`（流程 runbook）、`wiki/`（通用知识与决策先例）
- `metadata/` —— 系统态，**可重建**

`wikilink` 是**字面路径语义**，原文：「`[[X]]` → `target_path = "X"`」，不补 `.md`、不按文件名解析。由此长出 FileLink 边。

存储层 `reme/components/file_store/local_file_store.py` 很薄：内存里一个 `file_chunks: dict[str, FileChunk]`，落盘 `file_chunks_{name}_{store_version}.jsonl.zst`。

【判断】「唯一真相源是文件、索引可重建」这条对我们的意义：它把「数据」和「加速结构」彻底分开。我们 `anima.json` 里 memories / meta / audit 三张表混在一个文件里，没有「坏了能重建」的派生层 —— 我们也不需要，因为我们没有索引。**如果我们将来加词面检索，这条是必须遵守的：索引不能是唯一存储。**

---

## 3. 写入：两段式，都有 LLM，但门在 Extract

### 3.1 前段 `auto_memory`（`docs/en/auto_memory.md`）

同一 `date` 下按 `session_id` 至多一张卡片；文件名由 Agent 从校验过的 frontmatter `name` 取；幂等靠调用方传 `request_id`（1–128 字符），**同 ID 不同输入直接拒绝**。

【判断】`request_id` 幂等是我们完全没有的概念。我们 `memory.add` 只靠 `similarity()` 去重，重试或重复调用会产生两条近乎一样的记录。

### 3.2 后段 `auto_dream`（`docs/en/auto_dream.md`）

`cron 0 23 * * *`、`scan_days=2`、`max_units=5`。两个阶段：

**Extract** 一次看全部变更文件，输出 `name/bucket/summary/paths`。原文：

> extraction merges cross-file evidence for the same abstraction and drops passing mentions, per-file summaries, and weak candidates without reusable value

**Integrate** 每 unit 一个 agent，**只有 `CREATE / CORROBORATE / REFINE / CORRECT` 四动作**。原文：

> Integrate has no SKIP action

【判断】**这四条动作枚举是我们最该抄的一条**。我们的记忆写入只有「加一条」，没有 `CORROBORATE`（同一件事再次确认 → 增强可信度）、没有 `REFINE`（措辞更准）、没有 `CORRECT`（纠错）。`stance` 类型现在唯一的冲突处理是人工 `supersededBy`。而它强制「不许跳过」——每次整合必须落地一个动作，这防的是「模型看完觉得没什么可做就什么都不做」。

### 3.3 去重靠检索，不靠相似度

（`docs/en/auto_link.md`）让 agent 先调 `node_search`（digest-only，建议 `limit=20-30`）做三分类：`same_abstraction / related / unrelated`。

【判断】这个顺序是对的：**先看「我已经记了什么」，再决定要不要记**。我们现在是先算 `similarity(seed.text, other.text)` 找最像的，命中阈值就合并 —— 阈值是拍出来的，且只能发现「字面像」，发现不了「换了说法讲同一件事」。

---

## 4. 检索：BM25 + 可选向量，RRF(k=60)

`reme/steps/index/search.py`：

```python
_RRF_K = 60
_MAX_CANDIDATES = 200
vector_weight          # 默认 0.7，clip 到 [0,1]
text_weight = 1.0 - vector_weight
candidates = min(200, max(1, limit * candidate_multiplier))   # candidate_multiplier 默认 5.0
contrib = weight / (60 + rank)                                 # 按 chunk.id 累加
```

- 单路命中不回退融合，直接返回原生分
- 默认 `limit` 5（环境变量 `REME_SEARCH_LIMIT` 可覆盖），上限 50
- BM25 参数（`reme/components/keyword_index/bm25_index.py`）：`k1=1.5`、`b=0.75`，IDF = `log(1 + (n_docs - df + 0.5) / (df + 0.5))`

### 4.1 一个已经写进文档的坑（原文）

`docs/en/memory_search.md`：

> `min_score=0.05` removes every hybrid result even if its native vector or BM25 score is high

原因是双路命中时 RRF 上限只有 `1/61 ≈ 0.01639`。代码只 warning，**不自动降阈值**。

【判断】这就是我们自己的坑的另一面：我们两段排序键（超窗 → `capturedAt`）根本没有「分」这个概念，所以不会有阈值误杀，但也不会有相关性。**如果我们按 `docs/soul-plan.md` 加 RRF，第一条纪律必须是 `min_score` 默认 0** —— 否则 0.01639 这个量级会把所有结果都过滤掉，而且现象是「一条都搜不出来」，很难联想到这里。

### 4.2 一条实现不一致（值得注意的脏代码）

`_single_search.py` 里单后端路径 `_CANDIDATE_MULTIPLIER = 10`，与混合路径的 5.0 不一致。

【判断】不算洞，但说明「同一常量两处各写一份」是这个领域的高频事故 —— 与我们 `lib/decay.mjs` 把窗口写在一处、`agent-soul` 在 `lib/memory.js:1262-1264` 留的那条注释是同一类。

---

## 5. 遗忘：没有时间衰减

`memory_as_file` / `memory_search` / `auto_memory` / `auto_dream` / `auto_link` / `proactive` / `steps/index/search.py` 里**没有任何 decay / importance / 访问频次打分函数或参数**。

实际起作用的「遗忘」：

- BM25 与 FAISS HNSW 用 **tombstone 删**，`optimize_index_cron`（`0 2 * * *`）夜间**压实**
- proactive 侧：`carry_forward_days=14`、`max_carry_forward_topics=20`、`max_topics=10`
- dream 侧：`scan_days=2`、`max_units=5`
- 检索侧：`seen_ttl_hours=24`（同一 `tool_context` 内去重，**不是**记忆遗忘）

**这是本报告最重要的一条对比。** 我们花了 `lib/decay.mjs` 131 行做三档窗口衰减，`agent-soul` 花了 `targetClarity()` 连续公式做五档 —— 而 ★3747 的项目**一个衰减都没有**，靠容量上限 + 墓碑压实 + 定期重组（dream）来控制规模。

【判断】这不证明衰减是错的，但要承认：**规模控制有两条路**，删（衰减/淘汰）和重组（合并/提炼）。ReMe 选后者。我们的 `lib/memory-audit.mjs` 只做体检（路径存在性 + `verifyAt` 过期），不合并。如果记忆条数会长期增长，重组是迟早要补的；如果不增长，衰减够用。

---

## 6. 宿主接口：库 / HTTP / MCP 三形态，但注入的是指引不是记忆

### 6.1 能力边界（原文）

`docs/en/framework.md`：

> Single-session context-window management is outside the scope of ReMe v4… Those capabilities belong in the host agent framework.

【判断】这句把「长期记忆」和「单会话上下文管理」切得很干净。我们两边都做（注入预算 + 记忆），好处是能协同，坏处是边界模糊 —— 比如 `maxInjectedChars=4000` 到底是记忆预算还是上下文预算。

### 6.2 官方 DSH 插件的做法（可直接参考）

`integrations/dsh/src/guidance.ts`：`GUIDANCE` 是一段常量字符串（en/zh，**5 行**），会话创建时作为一条 plugin context 注入，带 `kind=reme-memory`、`form=instructions` 元数据；`hasGuidance()` 扫 `session.events` 与 pending 消息**防重复注入**。

【判断】**这是 ⌈每会话只注入一次⌋ 的一个完整实现样本**，正好对应 `agent-soul` 的 `PERSONA_REFRESH_TURNS`（每 15 轮补一次）之外的另一极：一次都不补。两者共同的敌人都是我们现在的做法 —— 每轮重新 `dispose` + `register` 四段。

### 6.3 预算控制只有三处

- `limit`（默认 5，上限 50）
- `max_search_calls`（超出直接返回 `Error: search call limit of N reached`）
- `compact_context` 的 `max_state_tokens=25000 / max_request_tokens=30000 / evidence_chars=2000 / preview_chars=300 / preserve_recent_messages=6 / drop_threshold=0.1 / total_timeout_seconds=30 / max_concurrency=4`

**检索结果正文没有 token 预算**：`search.py` 直接把 `c.text` 全量拼进 answer。`context_compaction.md` 还特意写：

> ReMe's search tokenizers are not model token counters

【判断】这意味着 ★3747 的项目在这一点上比我们**倒退**：它没有注入预算，我们有 4000 字双闸（条数 + 字数）。**这一项不要动。**

---

## 7. 踩坑原文（可直接抄进我们注释）

按可迁移性排序：

1. `auto_link.md`——「An UPDATE should be additive whenever possible: do not delete existing wikilinks or source entries.」（更新要增量，别覆盖丢边）
2. `memory_as_file.md`——「an agent may rewrite the wording, but it must not lose evidence edges」（可以改写措辞，不能丢证据链）
3. `memory_as_file.md`——「Do not put long body text into YAML fields.」（长正文不要塞进 frontmatter —— 这条直接适用于我们 `sourceRef` / `verifyAt` 字段的设计克制）
4. `context_compaction.md`——「The threshold is a conservative starting point, not a calibrated guarantee」（阈值是保守起点，不是校准过的保证 —— 我们的 `TYPE_WINDOWS` 自认「没有任何数据支撑」，是同一句话的更诚实版本）
5. `context_compaction.md`——实验结论：「Top 4–5 do not improve the scores: more original text does not guarantee better answers」。Top 3 把分数从 82.0%/79.4% 拉到 99.5%/97.9%，但输入 token 从 summary-only 涨到 3241/3193。
6. `memory_search.md`——`min_score=0.05` 误杀（见 4.1）
7. `faq.md`——「Do not stop an unknown listener. Select another port.」（听起来无关，但对「装了多个插件同时占 systemPrompt 段」的场景是个提醒）

---

## 8. 对 dsh-anima 的可搬清单

| # | 做法 | 出处 | 代价 |
| --- | --- | --- | --- |
| 1 | `CREATE/CORROBORATE/REFINE/CORRECT` 四动作 + 无 SKIP | `auto_dream.md` | 要真调 LLM；应挂巡夜而非实时路径。补的正是我们「立场冲突只能人工 `supersededBy`」那个洞 |
| 2 | `request_id` 幂等 | `auto_memory.md` | 加一个字段 + 一次查表，改动小 |
| 3 | 去重改成「先检索已记内容再决定」 | `auto_link.md` | 依赖第 4 条（要有检索）；纯 `similarity` 阈值可以留着做兜底 |
| 4 | BM25 + RRF(k=60) | `search.py` | 要维护倒排索引 + tokenizer 指纹；`min_score` 必须默认 0（见 4.1） |
| 5 | 每会话只注入一次指引（`hasGuidance` 扫事件） | `guidance.ts` | 与 `agent-soul` 的「每 15 轮补一次」是两种取舍，要实测 | 
| 6 | 「索引可重建」——派生结构不承载唯一数据 | `memory_as_file.md` | 只有在我们加索引时才成为约束 |
| 7 | 重组（dream）替代淘汰（衰减） | `auto_dream.md` | 与现有 `lib/decay.mjs` 是两条路线，二选一或并存需拍板 |

**不值得抄的**：整套 Markdown 文件工作区（`session/`+`daily/`+`digest/`+`metadata/` 四层 + wikilink + tombstone + 夜间压实）。我们已有 `lib/memory-audit.mjs` 与衰减，搬进来是净负债，迁移与双写成本高。
