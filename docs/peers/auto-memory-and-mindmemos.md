# 两份「大而全」的记忆件：dsh-auto-memory（★185）与 MindMemOS（★925）

> 为什么放一起：这两份都不是「一个记忆插件」，而是**带后台流水线的完整记忆系统**。它们体量远超我们（auto-memory `lib/index.js` **1459043 字节**，MindMemOS 光 `pipelines/dreaming/default.py` 就 46029 字节），所以能抄的不是架构，是**三处具体的纪律**。
> 读取来源：`_research/automem/`（`cdn.jsdelivr.net/gh/Aik358/dsh-auto-memory@main/`）、`_research/mmos/`（同法拉 MindMemOS）。
> **实读范围**：auto-memory 的 `index.js` 局部（约 200 行 + grep）、`fact-store.js` 47050 B（grep）、`context-host.js` 53746 B（grep）；MindMemOS 的 `pipelines/dreaming/default.py` 前半（约 150 行 + grep）。
> **未读**：auto-memory 的 `lib/client.js`（2304328 B）、`tests/`、`docs/internal/*`（约 40 份 × 90KB）；MindMemOS 的 `components/extractor/`、`components/searcher/`、全部 `mindmemos_eval/`。

---

## 一、dsh-auto-memory（★185）—— 把「前缀缓存」当成第一约束

### 1.1 它的核心论点：动态内容**不能**进 system prompt

`index.js:17549-17550` 注释原文：

```
动态记忆 → ctx.systemPrompt.context():渲染为 user-role 快照追加在历史尾部,
内容不变不重复注入(dsh-agent-loop project() 去重)。
system prompt 不再包含动态内容 → 字节级稳定 → DeepSeek 前缀缓存全程命中
(自动沉淀/跨天/切模型都不再击穿前缀)。
```

再补一句（`:8158`）：

```
不击穿前缀缓存：动态快照走 systemPrompt.context()（user-role，**追加在历史尾部**）
```

**关键信息：`systemPrompt.context()` 渲染出来是 user-role、追加在历史尾部，不是塞进 system prompt。**

这解释了为什么 `docs/essence-from-peers.md` §1 里四个项目独立收敛到 `context` —— 不是因为 `context` 更好用，是因为**它不动前缀**。`section` 一旦内容变了，整个 system prompt 的字节级前缀就废了。

### 1.2 但它同时对「静态」和「动态」用了两套

`index.js:8708` 注释：

```
静态纪律(不随状态变化)→ ctx.systemPrompt.section(): system prompt 保持字节级稳定,是 DeepSeek 前缀缓存的锚。
```

`renderMemoryStatic()`（`index.js:8709` 起）产出的是一段**固定纪律文本**，走 `section`。

**和 DSH-X 完全一致的分工**：静态的进 `section` 当缓存锚，动态的进 `context` 走历史尾部。两份独立实现，同一结论。

### 1.3 「死开关」事故 —— 我们自己可能有一模一样的

`index.js:17558-17565` 注释原文：

```
★v3.1.3（用户拍板「接线」）：`injectEnabled` 此前是**死开关** —— 键白名单内有、
  UI 能翻面能落盘，但全 lib/ 零读取点 ⇒ 用户关掉后记忆照旧每轮注入（界面骗人）。
  现在接入本回调最前面，作为**动态快照总闸**：关 = 真不注入。
  ⚠️解耦（用户硬性要求「单一开关不得顺带改变其他功能」）：只关这**一条**通路，不动
    · 静态规则段 renderMemoryStatic()（systemPrompt.section，下方 :~10900，缓存锚 + 属另一功能）
    · M6 tail surface（下方 :~10910）
    · 记忆写入（memory_log / 自动沉淀）与检索（memory_recall）—— 关注入 ≠ 关记忆
```

两个可直接搬的教训：

1. **开关必须有读取点，且读取点必须能被 grep 到。** 它的病是「UI 有、白名单有、回调里没有」—— 配置链通了三段，最后一段断在消费侧。
2. **「关注入」不等于「关记忆」**，而且注释里明确写了不许顺带关别的。这是产品级纪律。

**对照我们**：`lib/config.mjs` 的 `memory.enabled` / `quality.enabled` / `quality.preStepCheck` 这些开关，每一个在 `index.mjs` 里都有读取点吗？我没系统核过。**这是一条值得单独跑一遍的检查**，而且用 `grep` 就能做完 —— 把 config schema 里的所有布尔键抓出来，逐个 grep 是否被读取。

### 1.4 「诊断类降级不写进注入文本」

`index.js:8700-8705`：

```
诊断类降级（`inject: false`，如"合计超预算"）只进 `envelopeMeta`，不进注入文本：它不改变内容，
每轮写字数反而制造噪声（长会话里这类噪声会累积）。
```

这是**对「超限要可见」这条原则的精确化**。DSH-X 的做法是超限追加 WARNING 行进注入文本；auto-memory 的做法是**分两类**：

- **内容类降级**（真的少给了条目）→ 进注入文本，让模型知道
- **诊断类降级**（只是统计信息，比如总字数超了但内容没少）→ 只进 meta，不进文本

理由：「每轮写字数反而制造噪声（长会话里这类噪声会累积）」。

**这修正了我在 `docs/peers/dsh-x-memory.md` §6 里「超限不静默」的说法。** 精确的规则是：**内容缺失必须说，统计指标不必说。**

### 1.5 一个我们必须确认的事实：`order: 10000`

`index.js:338`：

```js
const SECTION_ORDER = 10000
```

而 `context` 注册用的是这个 order（`:17553`）。

对照我们的四段：identity **10** / memory **20** / pending **21** / quality **30**，刻意排在 PLAN_POLICY(**500**) 之前（`index.mjs:105-118` 注释）。

**10000 vs 500** —— 差了 20 倍。这说明宿主对 `context` 的 order 语义和 `section` 的 order 语义**可能不是同一个量纲**。dsh-agent-soul 用的是 context order 250/260（`lib/index.js:632, 663`），dsh-living-memory 用 context order 300（`index.cjs:5085`），DSH-X 用 context order 95（`lib/index.js:231`）。

**四份 context order：95 / 250 / 260 / 300 / 10000。** 跨度两个数量级，说明这个值是**拍的不是算的**。

**我们若把 memory 段从 section 迁到 context，order 必须重新选，不能沿用 20。** 而且需要一个实测：宿主到底按什么排序、`section` 和 `context` 是不是同一个序列。

---

## 二、MindMemOS（★925）—— 「梦境」流水线里的两道反幻觉闸门

它是一套 Python 记忆系统（`pipelines/dreaming/default.py` 46029 字节），DSH 只是个客户端。**不能搬架构（要部署 LLM + 向量库 + Kafka），但它的两道闸门值得抄。**

### 2.1 主体一致性守卫（Subject Consistency Guard）

`default.py:613-623`：

```python
# Subject consistency guard: reject groups where memories have
# different subject entities (entities[0]). This catches cross-subject
# groupings (e.g. different people sharing the same country, or different
# songs sharing the same performer) that the LLM misclassified.
subject_entities: set[str] = set()
for mid in valid_ids:
    mem = mem_by_id.get(mid)
    if mem is not None:
        raw = mem.metadata.get("entities", [])
        if raw:
            subject_entities.add(raw[0])
if len(subject_entities) > 1:
    continue
```

**翻译**：LLM 判定「这几条记忆在说同一件事」之后，再用一个机械规则复核——**它们的第一个实体必须相同**。不同人共享同一个国家、不同歌共享同一个歌手，都会被 LLM 误判成「同一件事」。

**这直接命中我们 `lib/memory.mjs:469-490` 的「疑似重复」检测。** 我们用的是二元组（bigram）集合的 `similarity()`，纯字面，**本来就不会跨主体误判**（不同人名的 bigram 不同）。所以这条对我们**不适用**——但它的**方法论**适用：**LLM 判断之后要有机械复核，不能只有一个模型说是就是。**

### 2.2 置信度只做「同 key 择优」，不参与排序

`default.py:626-629`：

```python
key = (group.issue_type, tuple(sorted(valid_ids)))
normalized = group.model_copy(update={"memory_ids": valid_ids})
existing = dedup.get(key)
if existing is None or _confidence_rank(normalized.confidence) > _confidence_rank(existing.confidence):
    dedup[key] = normalized
```

`_confidence_rank`（`:971-972`）：

```python
def _confidence_rank(confidence: str) -> int:
    return {"low": 0, "medium": 1, "high": 2}.get(confidence, 1)
```

三档 low/medium/high，**只用于「同一个 key 的两条候选保留哪条」**，不参与召回排序、不参与衰减。

**这和 `dsh-evolving-memory` 的 PRD §11「置信度只带来复杂度」是同一结论的两面**：一个把 confidence 删了，一个把 confidence 压到只做去重。**两条路都指向「别让置信度进排序」。**

**对照我们**：`lib/store.mjs` 没有 confidence 字段。这是对的，别加。

### 2.3 五个「降级」反例

它的 `_bounded_parser`（`default.py:637-646`）：

```python
_parse_attempts = 0
_max_parse_attempts = 5

def _bounded_parser(content: str) -> ConsolidationAction:
    nonlocal _parse_attempts
    _parse_attempts += 1
    if _parse_attempts > _max_parse_attempts:
        return ConsolidationAction()      # ← 空动作
    return action_planning_parser(content)
```

**解析失败 5 次就返回空动作**，而不是抛异常、不是重试到死。

这条对我们有直接参照：我们 `lib/quality.mjs` 的判据是**正则**，不会解析失败；但 `lib/memory-audit.mjs` 会 `fs.existsSync`，`lib/patrol.mjs` 会读 meta。**这些地方现在没有「失败几次就放弃」的上限**。

---

## 三、给 dsh-anima 的四条（合并两份）

| 动作 | 具体改法 | 代价 | 值不值 |
| --- | --- | --- | --- |
| **开关消费侧体检** | 把 `lib/config.mjs` 的所有布尔键抓出来，逐个 grep `index.mjs` 是否有读取点；没有的就是死开关 | 纯 grep，30 分钟 | **最值**。auto-memory 踩过这个坑，症状是「UI 能关但关不掉」 |
| **降级分两类** | 内容缺失（真少给了条目）→ 进注入文本；统计信息（超字数但内容齐）→ 只进 meta | 要改 `selectForInjection` 返回结构 | 值。现在我们的截断是「一律静默」，等于两类都不说 |
| **`context` 的 order 要重新实测** | 迁移时不能用 20。已知四份 peer 用 95/250/260/300/10000，跨度两个数量级 | 需要写个小脚本打印宿主装配后的 segments 顺序 | 值，且**迁移前必须做**，否则 order 20 可能把 memory 排到所有 context 之前或之后 |
| **失败次数上限** | `memory-audit` / `patrol` 的 IO 操作加「连续失败 N 次就跳过并记账」 | 各 5 行 | 不急。现在是本地文件，失败概率低 |

**不建议搬的**：MindMemOS 的整套 dreaming 流水线（要 LLM + 向量库 + Kafka 三件套）、auto-memory 的 1.4MB 单文件结构、它的 `M0/M1` 分层命名（那是它自己的历史包袱）。

---

## 四、一句话教训

**「超限要可见」这句话我说得太粗。** 精确版是 auto-memory 那句：**内容缺失必须说，统计指标不必说** —— 因为长会话里前者会导致模型基于残缺记忆做判断，后者只是噪声。

而 DSH-X 的「超限追加 WARNING」之所以成立，是因为它的索引超限**真的少给了条目**（内容类），不是统计类。两份不矛盾，是我一开始没分清。
