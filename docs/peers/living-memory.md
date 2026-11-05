# dsh-living-memory（★3）—— 全生态里唯一把「先建账、后定尺」写进代码的

> 读取来源：`_research/living/`，走 `cdn.jsdelivr.net/gh/dearbld/dsh-living-memory@main/` 拉取（`raw.githubusercontent.com` 直连不通）。
> 仓库 `dearbld/dsh-living-memory`，★**3** / fork 0（GitHub API 2026-11-04 实测），**这是星数最低的一份，但内容密度是最高的一份**。
> `package.json:3` 版本 **0.2.10**（README 标题里写的 0.2.7 是配置参考那节的版本）。
> 实读文件：`index.cjs` **13848 行 / 556120 字节**（精读约 300 行 + 40 余次 grep，**未通读**）、`README.md` 290 行 / 16114 字节、`cordis.patch.yml` 22 行、`package.json` 61 行、`criteria-rules.default.json` 54 条、`guard-rules.default.json` 2403 字节、`dict-custom.json` 630 字节、`scripts/preflight.cjs` 7920 字节（只看了 README 描述 + 文件头）。
> **未读**：`client.js`（9784 字节，GUI 面板）、`NOTICE`、`RELEASE-NOTE-CLARIFICATION.md`、`scripts/preflight.cjs` 实现细节。

---

## 0. 一句话定位

它不是「记忆插件」，是**一个人维护的长期项目对「记忆该怎么自我维护」的完整回答**。代码注释里的日期从 2026-08-22 一直排到 2026-09-21，每一处改动都带「哪一天、哪个审计发现、为什么改、回退开关是哪个」。

星数 3 说明这东西**没打算做产品**。它对我们价值最大的一点恰恰在这里：**别人在替我们趟我们已经趟了一半的坑，而且写下了结论。**

---

## 1. 「先建账、后定尺」—— 全生态唯一的预算方法论

`index.cjs:1902-1940`，一整段注释加 40 行实现：

```
审计 §3-4 实勘：注入面 14 路（systemPrompt.context('legion-memory-recall') 10 路整块
＋ system-prompt/assemble waterfall 4 路变量块）零总预算——仅 8 路有条数帽、
无任何字节/行数总帽（MAX_RENDER_BYTES=50KB 是工具面板帽·不作用于注入面），
且唯一测量件 inject-budget-probe.cjs 已退役 ⇒ 连测量手段都缺。
```

它的做法：

```js
const INJECT_BUDGET_BYTES = Number(process.env.LEGION_INJECT_BUDGET_BYTES) || 0; // 0=观测期不告警
const injectMeter = { ctxLast, ctxMax, wfLast, wfMax, totalMax, samples, overBudget };
```

**帽值不凭空设**（原话「尺子三问」）：`LEGION_INJECT_BUDGET_BYTES` 不设 → 只测不告警（观测期），等实测 `max` 出来再据数据定帽。

后面还记了一条修正（`:1929-1935`）：

```
D1（独立审计 09-12 订正）：原 totalLast = ctxLast + wfLast 跨轮拼接（某轮只触发一路时
会把上一轮的另一路与本轮相加）⇒ 虚高。改为峰值上界语义：ctxMax + wfMax
（明示「非同轮实际量」）。
```

**这两条直接命中我们。** 我们 `lib/config.mjs:79-80` 的 `maxInjected: 40` / `maxInjectedChars: 4000` 是怎么定的？我翻遍 `docs/soul-plan.md` 和 `essence-from-peers.md`，**没有任何一处记录这个 4000 的来源**。它是拍的。而 living-memory 明确写了「先测，再定尺」。

**可搬的一招（成本极低）**：在 `index.mjs` 的注入路径上挂一个 `injectMeter`，只记 `maxInjectedChars` 实测峰值，先不告警。跑一周，"4000 到底该是多少" 就有数据了。

---

## 2. 衰减：三因子乘性融合，且有四个不衰减豁免

`index.cjs:12051-12115`。注释一行概括：

```
时序衰减——三因子乘性融合 final = bm25归一 × 空间权重 × decay
14 天半衰 0.5^(days/14)；decision/fact 衰减减半（28 天半衰）；
todo 不衰减（现行待办永在顶）；decay 下限 0.05（旧记忆沉底不归零——遗忘是排序不是删除）。
```

实现（`:12054-12100`）：

```js
const decayOf = (row) => {
  if (row.type === "todo") return 1.0;
  if (row.essential === 1) return 1.0;                          // 常驻核心不衰
  if (String(row.source || "").startsWith("mirror:")) return 1.0;  // 进化史镜像=长期资产
  const anchor = row.event_at || row.ts;                        // 事件钟锚：补记条目不再凭空折损半衰
  const days = Math.max(0, (Date.now() - t) / 86400000);
  let half;
  if (LEGION_DECAY_LEGACY) half = type==='decision'||type==='fact' ? 28 : 14;
  else if (row.type === "fact" && (space==='xhs'||space==='fetcher')) half = 7;   // 分 space 档
  else if (row.type === "decision" && (space==='brain'||space==='maintain')) half = 56;
  else half = type==='decision'||type==='fact' ? 28 : 14;
  // FadeMem 重要性调制：验证越多忘得越慢
  if (!LEGION_FADEMEM_OFF) {
    const vcF = Number(row.validated_count) || 1;
    if (vcF > 1) half = half * Math.min(2.0, 1 + 0.35 * Math.log(vcF));
  }
  const base = Math.max(0.05, 0.5 ** (days / half));
  const rel = row.relevancy ?? 1.0;
  return base * Math.min(1.5, Math.max(0.5, rel));
};
```

三个可以直接对照我们的点：

### 2.1 **事件钟锚**（`row.event_at || row.ts`）

原话：「补记条目不再凭空折损半衰」。一条 2025 年发生的事、今天才被记下来，如果按 `createdAt` 算衰减，它会被当成「新鲜事」，永不沉底；按 `event_at` 算才对。

**我们 `lib/decay.mjs` 只有一个时间戳**（`capturedAt`），没有「事发时间」。这是个真实的洞，但补齐要改 store schema 和 add 接口，代价不小。

### 2.2 **FadeMem 验证调制**（`half × (1 + 0.35·ln(vc))`，帽 2.0）

翻译：被验证过 2 次 → 半衰 ×1.24；4 次 → ×1.48；≥8 次 → ×2.0。**「被反复确认的事忘得慢」**。

我们 `lib/memory.mjs:545-549` 的排序键是 `decayRank` 差 → `capturedAt` 倒序。**没有「被确认过几次」这个维度**（`memories` 表现在还是 0 条，连 `validated_count` 的对应物都没有）。

`docs/peers/reme.md` 里的 `CORROBORATE` 动作解决的是同一个问题（同一件事再次确认 → 加权），两个项目独立收敛到「重复确认要能影响排序」。**这条我认为比 §2.1 更值得做**，因为它不需要新时间戳，只需要一个计数。

### 2.3 **decay 下限 0.05 而不是 0**

原话「旧记忆沉底不归零——遗忘是排序不是删除」。这和我们现在 `lib/decay.mjs` 的做法一致（不改 state、不删、只排序后移），**这点我们已经做对了**。差别在它有个明确下限值，我们只是「排后面」。

---

## 3. RRF：**k=2 而不是 k=60，且有实测数字**

`index.cjs:11915-11934`：

```js
let rrfBoost = null;
if (vecIds.length > 0) {
  rrfBoost = new Map();
  const K = 2; // 2026-08-31 item1：k=60 vec 消音翻案——扫描实证 k=2 总召回 22.2%→80.6%
               //（Qdrant 08-22 经验律：单真相关场景 k=2~5）；spoken 层对 k 免疫=词汇鸿沟须粒度/前缀/底座治
  ftsRows.slice(0, 50).forEach((r, i) => rrfBoost.set(r.id, 1 / (K + i + 1)));
  vecIds.forEach((id, i) => rrfBoost.set(id, (rrfBoost.get(id) || 0) + 1 / (K + i + 1)));
}
```

然后是映射（`:11928-11933`）：

```js
const rr = -Number(r.rank || 0);           // bm25 负值·越负越相关
const ftsBase = Math.max(0, rr / (1 + rr)); // → (0,1) 单调升
const vecPart = rrfBoost?.has(r.id) ? rrfBoost.get(r.id) * 10 : 0;
const base = Math.max(ftsBase, vecPart);    // 不是相加，是取大
```

后面还有一条（`:11936-11953`）：**vec 独有命中要打折**

```
vec 独有命中（FTS 未中但语义近）注入候选：RRF 分×10×0.5 折扣——
全量评测实证（75.8%<92.5%）：语义近似行不打折会顶掉跨域正确答案（加权链竞争失衡）
```

**三条硬数字**：
- `k=60 → k=2`，总召回 **22.2% → 80.6%**
- 不打折：**75.8%**；打折后：**92.5%**
- 融合方式是 `max` 不是 `sum`

这三条和 §1 的 RRF 常数正交：dsh-mneme / MemOS / Memmy 全用 `k=60`（教科书值），这份用 `k=2` 并给出实测。**我们若按 `soul-plan.md` 加 RRF，`k` 的初值应该测，不应该抄 60。** 但注意：它的场景是 **2 通道**（FTS + vec）且语料是中文笔记，`k=2` 未必能直接搬到 40 条记忆上。

---

## 4. 「配置即数据」—— 三层 guard-rules，第一层整体覆盖

`README.md:105-145` + `guard-rules.default.json` + `criteria-rules.default.json`。

规则分三层，**加载时整体覆盖而不是逐条合并**：

| 层 | 路径 | 内容 |
| --- | --- | --- |
| 1 | `~/.dsh/dsh-living-memory/guard-rules.json` | 本机规则（建议 chmod 600） |
| 2 | `<package>/guard-rules.default.json` | 出厂通用集：凭据 / 注入 / 编码负载形态 |
| 3 | `index.cjs` 的 `GUARD_FLOOR` | 内建最后防线 |

原话解释了为什么不逐条合并：

> three layers, first readable file wins *as a whole* (no per-rule union, because a half-applied ruleset is much harder to debug than a replaced one)

**但 Layer 3 的 reject 规则总是追加**（`README.md:121`）：数据文件不能把最后防线关掉。

`criteria-rules.default.json` 更进一步：**行为判据也外置成 JSON 了**（11 个 key，`metaExclusion` / `intentGate` / `stashHint` / `taskCompleted` / `recallStopwords` / `exemptShort` / `alertFamily` / `sysAutoPrefix` / `opsHook` / `sentryCritical` / `inboxPath`）。文件头写清了这么做的理由：

```
动因：该判据曾被净化链整体英文化 + 加 i 而未披露（C 路实测产物＝/in progress|…/i）
⇒ 字面量留码面＝每次净化都再改一次行为且无人知；外置后 code 面零机改。
```

**翻译成人话**：发布前要脱敏（把作者自己的站点词汇去掉），脱敏脚本一跑就把行为改了，而且没人知道。外置之后，「改词」和「改逻辑」彻底分开。

**这条直接命中我们。** 我们 `lib/quality.mjs` 的 `QUALITY_RULES`（`:26-114`）是硬编码在 JS 里的，`docs/soul-plan.md` 里也没提过「这些词用户能不能改」。如果哪天要改 R01–R12 的措辞、或者做多语言，现在只能改代码。

代价：要动 `lib/config.mjs` 加一个规则文件加载层 + 三层 fallback + 失败不崩，估计 150–250 行。

---

## 5. 发布闸门：`preflight.cjs` 扫四类，报告只给 `file:line` 不给命中文本

`README.md:147-154`：

> `npm publish` runs `scripts/preflight.cjs` first. It scans every file about to ship against generic structural patterns (absolute home paths, private-key blocks, credential shapes, high-entropy blobs) plus an optional site file at `~/.dsh/dsh-living-memory-preflight.json` for site-specific vocabulary. The site file is never published, on purpose: a blocklist that ships with the package is a bypass manual. If it is present but unreadable, the gate **fails closed**. Violations are reported as `file:line` plus class only — matched text is never echoed, so the report cannot itself leak the secret.

三个设计点：

1. **`site-preflight.json` 永不发布**——「一个随包发布的黑名单就是一本绕过手册」。
2. **存在但读不了 → 直接失败（fail closed）**。
3. **报告只给 `file:line` + 类别，不回显命中文本**——因为报告本身可能泄密。

我们 `dsh-anima` 有一条 `scripts/acceptance.mjs` 的 `parity` 检查（源码 vs 安装副本逐文件哈希），但**没有发布前的污染扫描**。我们仓库里现在有没有 `D:\deepseek工作区` 这种绝对路径？grep 过，`docs/` 里有，`lib/` 里也有（`lib/memory-audit.mjs` 的测试用例）。**这条是发布前必须补的**。

---

## 6. 注入：`systemPrompt.context` + order 300，且注释写了「为什么从 section 迁过来」

`index.cjs:5079-5086`：

```js
const stopSection = systemPrompt.context({
  name: "legion-memory-recall",
  order: 300,
  text: (context) => promptSafeContext(() => {
```

注释原文（`:5080-5082`）：

```
案C(ops note)：section→context 迁移——section 路 scope 层断链（死），
context 投影路=每轮 materialize（活·autorecall 同位）；接口同构（types L47-74）。
order 300 沿用（context 亦按 order 排序）。
```

这是**第四份独立证据**指向同一个结论：`section` 有问题，`context` 才是活的。前三个是 `dsh-agent-soul`（`systemPrompt.context`，见 `docs/peers/agent-soul.md`）、`dsh-soul-desk`、`dsh-lan-memory`（`order: -70` 走 context）。

`docs/soul-plan.md` 里我们已经把它列为方向①，**四份独立实现都这么干，这个优先级应该提到最高。**

另外它还走了 `system-prompt/assemble` waterfall（`:8078`），做了 4 路变量块注入，用 `assembly.variables[name] = "{{name}}"` + `assembly.contexts.push(...)` 的模式（`:8070-8073`）。这是宿主提供的第二注入面，我们目前**完全没用**。

---

## 7. 它踩过的坑（原文摘，可直接抄进我们的注释）

- `:1929-1931`「原 `totalLast = ctxLast + wfLast` **跨轮拼接**（某轮只触发一路时会把上一轮的另一路与本轮相加）⇒ 虚高」——**计量口径的合成要在同一轮内完成**。
- `:5080`「`section` 路 scope 层断链（死）」——不是「不好用」，是**断了**。
- `:11918`「`k=60` vec 消音翻案」——教科书值在这个语料上是错的。
- `:11937`「语义近似行不打折会顶掉跨域正确答案」——**语义通道天然占优，必须打折**。
- `:3613`「常驻核心标…亲判核心知识——decay 恒 1.0 不衰 + 注入面常驻席（帽 3·按验证度排序）」——常驻席位**要有上限**，否则一旦标记永久占席（`:370` 那条注释记的就是这个事故：「治『一旦标记永久占席』·13/17 条 ts 早于 09-13 实证」）。
- `README.md:129-131`「When adding a credential prefix, keep the `(?<![A-Za-z0-9])` boundary: without it, file names like `…yml.bak-20260827`, `task-…` or `disk-…` get caught by the `ak-`/`sk-` substring and the gate starts eating legitimate notes.」——**凭据正则缺边界会把正常文件名吃掉**。

---

## 8. 给 dsh-anima 的三条（按性价比排）

| 动作 | 具体改法 | 代价 | 值不值 |
| --- | --- | --- | --- |
| **注入预算先建账** | `index.mjs` 注入路径挂 meter，只记 `maxInjectedChars` 实测峰值 + 样本数，不告警 | 20 行左右，不碰逻辑 | **最值**。我们现在 4000 这个数是拍的，有数据才能谈调 |
| **被确认次数进排序** | `lib/store.mjs` 加 `corroborateCount`，`similarity()` 判为同一件事时 +1，`lib/decay.mjs` 用它调制半衰 | 要改 store schema + add 路由 + 迁移（现有 0 条记忆，**现在改零成本**） | 值。`memories` 表现在是 0 条，越晚改越贵 |
| **发布前污染扫描** | 抄 `preflight.cjs` 的四类扫描：绝对 home 路径 / 私钥块 / 凭据形态 / 高熵串，报告只给 `file:line` | 独立脚本，不影响运行时 | 值，但可以等发版前再做 |

**不建议搬的**：14 路注入 / PPR 知识图谱 / jieba 分词 / SQLite（我们是 JSON store，为 40 条记忆引数据库是纯税）/ 27 个 `LEGION_*_OFF` 开关（那是单人长期项目的自保机制，我们不需要）。

---

## 9. 一句话教训

**★3 的项目里有全生态唯一一句「帽值不凭空设」，而 ★2191 的 Memmy 里 `budget` 参数是 `void budget;`。**

按星数排序去读插件，会错过这份。这也是我们把这轮调研做完的最大收获：**星数衡量的是可发现性，不是工程量。**
