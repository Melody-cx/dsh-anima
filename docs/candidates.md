# anima 候选池：还没做的九件事

写于 2026-11-08，对应 `c732b37`（v2.1.1）。

这份文档是给「有空时另起一个对话」用的交接单。目标不是替你决定做什么，是把每条候选的**现状、代价、判断依据**摆清楚，让下一个接手的人（不管是哪个模型）不用重新勘查一遍。

---

## 先看现状：为什么大部分候选现在动不了

| 事实 | 数值 | 出处 |
|---|---|---|
| 已采纳记忆 | **2 条** | `C:/Users/zmy/.dsh/storages/anima.json` → `tables.memories` |
| 待审缓冲 | **0 条** | 同上，`status === 'pending'` 计数 |
| pending 恒为 0 的原因 | `remember` 工具只有提示词引导，无机制层闸门 | `lib/prompt.mjs:300-303` 的注释自己承认了 |
| 真实用户发言语料 | 925 条 / 593 条（两种口径） | 见下「语料口径」一节 |
| 主会话轮次数 | 937 轮 | 探针实测 |
| 会话文件总数 | 53 个（主 18 / subagent 35） | `C:/Users/zmy/.dsh/sessions/` |
| qualityStats | checks=690, reminders=102 | `/api/anima/state` |

**核心判断：任何「记忆多起来以后怎么排序 / 怎么分档 / 怎么配额」的优化，在 2 条数据上都无法验证。** 这不是保守，是这轮已经踩过的坑 —— 下面每条都注明了「现在能不能验」。

---

## 语料口径（做任何阈值校准前必读）

2026-11-08 实测，从 53 个会话里剥出的真实用户发言。踩过的坑：

1. `user/message` 事件里混着大量**伪用户消息**：`<system-reminder>` 全表、`Background subagent <uuid> finished`、`Team message from ...`、`Agent <uuid> sent a message:`、subagent 任务书（`你的任务：`/`请实现`）、以及另一个插件伪装成 user 角色的 `〔论衡 H2 伦理脱敏〕`。
2. subagent 会话要用 `events.some(e => e.type === 'subagent/descriptor')` 剔掉（35 个）。
3. 任务板卡片也是 `source.kind === 'user'`，`rpcId` 形如 `task-board-<uuid>`；但**有些旧格式卡片的 rpcId 是普通 uuid**，只能靠 `/^只回一行/` 这类首句特征认。

剥干净之后：**925 条真实发言 → 加 `--days 14` 窗口后 593 条 → 9 条线索**。

探针脚本 `scripts/probe-retrospect.mjs` 可复用（只读，支持 `--days N`）。

---

## 九条候选

### ① 模块边界 try/catch 补齐

**要解决什么**：插件在异常入参上别把宿主搞崩。

**现状**：`index.mjs` 已有 25 处 `try {`。剩下没包的是几个当初故意留的点 —— 因为包了会静默吞掉真错误。

**代价**：约 10 行。**只能防崩，不能防「事办错」。**

**现在能验吗**：能。`verify-core` 可以直接传抛异常的渲染函数。

---

### ② 质量判据外置 JSON

**要解决什么**：十二条判据能从数据文件读，用户不用改代码就能调。

**现状**：硬编码在 `lib/quality.mjs:24` 的 `QUALITY_RULES`。实测 **12 条**：`R01 R02 R03 R04 R05 R06 R07 R08 R09 R10 R11 R12`，其中 `UNCOVERABLE_RULES` = **R03, R05, R06, R07, R10**（五条 `catchMode === 'human'`，机器判不了，只能人看）。

**代价**：约 200 行加载层 + 校验层。外置之后改错了就是「静默不检查」—— 必须带 schema 校验和「加载失败就退回内置」的兜底。

**现在能验吗**：能，但收益取决于你是否真的想改判据。不改就没意义。

---

### ③ 衰减豁免 + 被确认次数调制

**要解决什么**：反复被确认过的记忆，不该跟久没动过的一起被排到后头。

**现状**：**零实现**。`grep confirmCount|verifyCount|exempt` 全仓零命中。现有衰减在 `lib/decay.mjs`：`DECAY_WINDOWS_DAYS` / `DECAY_LEVELS = ['fresh','aging','stale']` / `memoryAgeDays` / `decayInfo` / `decayTag` / `decayRank`。设计上**只加标签 + 排最后，记录一个字节都不改**（这是 2.0.0 的明确约定，别破坏）。

**代价**：动写入路径（要有地方记「被确认过几次」）。

**现在能验吗**：调不出效果 —— 2 条记忆，都在 fresh 窗口里。

---

### ④ 冲突消解四动作 ← 半成品，性价比最高

**要解决什么**：检出「候选与已采纳记忆高度相似」之后，能真的裁决（合并 / 取代 / 并存 / 丢弃）。

**现状：检测有，动作没有。**
- `lib/memory.mjs:516-568` 的 `detectConflicts` 返回 `{ clusters, conflicts }`，注释原文（`:518`）：「conflicts 是『候选与某条已采纳记忆高度相似』——采纳它就等于制造重复。」
- `conflicts` 已经通过 `/api/anima/state` 下发到界面。`index.mjs` 里 `conflicts` 出现 2 次，`client/index.mjs` 里 11 次。
- **`grep resolveConflict|applyConflict|conflictAction` → 零命中。** 也就是说界面能看见冲突，但没有按钮能处理。

**代价**：要新增「一套动作 + 一个裁决界面」。**这是九条里工作量最大的**，但也是唯一「半成品摆在那儿、补完就能真用」的。

**现在能验吗**：能 —— 冲突检测不依赖记忆条数，造两条相似的就能测。

---

### ⑤ 写入闸门两级漏斗 ← 建议划掉

**要解决什么**：该记的没记下来（2026-11-04 那次 C 盘抱怨之后，规则晚了一天才入库）。

**为什么建议划掉**：这轮已经用**回扫式复盘**覆盖了同一个需求（2.1.0 入版）。而且实测数据不支持闸门：

- mnemon 第一段四条件（显式记忆词 / 用户文本 ≥320 字符 / 助手文本 ≥600 字符 / 出现非 mnemon 工具调用）在 925 条语料上**只命中 4 条（0.4%）**
- 第二段打分公式（`reviewThreshold=5`）却让 **44.6% 的轮次**都要送审
- 分数分布：`{"1":264,"2":50,"3":46,"4":159,"5":133,"6":58,"7":40,"8":187}`
- **→ 要么太严要么太宽，中间没有可用档位。**

对照信号稀疏程度（937 轮里）：
```
抱怨记忆失败(我说过|有没有说过|不是说过|我跟你说过|早说过)  2 条 (0.2%)
纠正(不对|错了|搞错|谁让你|你他妈|你tm)                    6 条 (0.6%)
显式要求记住                                              1 条 (0.1%)
重申既有规则(C盘/表格/叫我)                                 3 条 (0.3%)
否定式约束(不要|别|不许|禁止|不准|不能)                      42 条 (4.5%)
高精度信号(纠正∪抱怨) 合计                                 4 条 (0.4%)
```

**代价**：中文触发词表得按真实语料重写（不能照抄 mnemon 那五个词）。

**现在能验吗**：能，但上面那组数字说明它大概率不值。

---

### ⑥ 召回分档配额

**要解决什么**：记忆多到超 `maxInjected` / `maxInjectedChars` 时，先注入哪些。

**现状**：`lib/memory.mjs:601` `selectForInjection(records, maxInjected, options)`，注释（`:578`）「双约束：条数（maxInjected）与字符数（maxInjectedChars）同时生效，取先到者」。默认 `maxInjected: 40` / `maxInjectedChars: 4000`（`lib/config.mjs:79-80`）。

**代价**：要定分档维度（类型？层级？新鲜度？确认次数？）。

**现在能验吗**：**不能** —— 2 条记忆，离 40 条上限差得远，任何阈值都是凭想象定的。

---

### ⑦ 置信度维度

**要解决什么**：区分「用户明说的」与「我自己推断的」。

**现状**：唯一沾边的是 `lib/import.mjs:149` 的 `confidence: 'high' | 'low'` —— 那是**导入时判断这条记忆属于 global 还是 workspace** 用的，不是记忆本身的置信度。真正的置信度维度零实现。

**代价**：动记忆 schema + 数据迁移。

**现在能验吗**：能测代码，但调不出真实收益。

**注意**：这条与记忆规则里的「不要记录你自己推断出的结论」是同一个问题的两面 —— 如果有置信度维度，「推断」就有地方落了。

---

### ⑧ 注入有效性 attest ← 我明确不熟

**要解决什么**：证明注入的消息真的到了模型眼里（而不是被宿主吞了）。

**现状**：**零实现**，`grep attest` 全仓零命中。

**但宿主的口子已经查到了**（`docs/host-prompt-semantics.md:255-278`）：`dsh-system-prompt.js:399` 有
```js
const transformed = await this.ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, () => Promise.resolve(assembly));
```
入参是整个 assembly（`{sections, contexts, tools, variables}`），返回值是权威结果，可以改。也就是说**「在装配完成的那一刻看一眼最终结果」是可能的** —— 这正是 attest 需要的位置。

**不确定性在别处**：我能拿到「装配结果里有什么」，但拿不到「模型实际收到了什么」。要证明后者，得看宿主有没有在请求发出前留钩子 —— **这个我没查过**。`docs/host-prompt-semantics.md` 只覆盖到 assemble，不覆盖到「发给模型」那一步。

**代价**：接 waterfall + 定位请求前的钩子。**我必须说清楚：assemble 这段我读过原文，请求层完全没碰过。**

**现在能验吗**：只能验前半（装配结果可观测），后半取决于宿主有没有那个钩子。

---

### ⑨ section/context 迁移

**要解决什么**：省掉每轮重复求值的开销。

**现状**：
- 五个 section 全部 `interpolate: false`（`index.mjs:573-577`），这是**必需的安全阀不是性能优化** —— `docs/host-prompt-semantics.md:255-278` 记了原因：`interpolate()`（宿主 `:159-183`）遇到未注册变量会**抛异常**，而 `renderPrompt` 与 `renderContextSections` 都会调它（`:119`、`:155`），于是**任何一段里出现 `{{未注册变量}}`，整次装配直接抛**。identity/memory 两段含用户自由输入，所以必须关掉。
- `identityText(context)`（`index.mjs:281`）每轮装配期实时求值，好处是工作区覆盖立刻生效无需重启会话。
- 它调 `overridesForContext`（`index.mjs:257`）→ `resolveOverridesFromCwdSync(cwd, ...)`（`index.mjs:262`）—— **同步文件 IO，每个 step 一次**。

**`docs/host-prompt-semantics.md:282-294` 已经把结论写死了**：不迁 context，除非明确要抓前缀缓存，且迁之前先去掉 text 函数里的 IO。同一份文档 `:237` 还有一节「`context` 的 text 函数每轮跑不止一次」—— 也就是说迁过去**不一定省钱**。

**代价**：要改成分内容静态/动态两套。

**现在能验吗**：能测性能，但收益取决于插件被调用的频率，我没有这个数据。而且上面那份文档的结论是「动机不存在，只要缓存才迁」——**动它之前先读那一节**。

---

## 该记录的三条教训（做上面任何一条之前先读）

### 教训 1：zod schema 少一个键 = 静默丢配置

`lib/store.mjs` 有两处必须先对齐：
- `configSchema`（`lib/store.mjs:128`）里的 `retrospectEnabled`（`:173`）、`retrospectDays`
- `metaSchema`（`lib/store.mjs:264`）里的 `leadsAt`（`:356`）、以及 `files`/`messages`/`found`/`leadsDropped` 的 `.nullable()`

2026-11-08 这轮踩了两次：schema 没声明的字段，**写入路径照落盘，读回被 zod 静默 strip**。现象是「设置页保存返回 200，但读回是默认值」—— 看起来像前端 bug，其实是 schema 少一行。与 2026-10-24 那次 `metaSchema` bug 同一形状。

### 教训 2：新增 `memory.*` 键要改**四处**，漏一处就是「静默改回默认值」

1. `lib/config.mjs` 默认值块 `memory: {`（`:73-92`）
2. `lib/config.mjs` `sanitizeConfig`（boolKeys 在 `:307`、数值区间在 `:339-344`）
3. `lib/config.mjs` `migrateConfig`（bool 循环 `:514`、数值 clamp `:524`）
4. `index.mjs` 三张白名单：`SET_MEMORY_KEYS`（`:2110`）、`SET_BOOLEAN_KEYS`（`:2133`）、`SET_NUMBER_KEYS`（`:2141`）

`lib/config.mjs:521` 的注释原文：「漏搬的后果不是『读不出来』而是『静默改回默认值』」。

### 教训 3：开关必须有它自己的读取点

曾经把回扫写在 `nightlyTriage` 分支里 —— 「关掉巡夜」会连带让回扫永远不跑，而设置页里回扫是单开的。`verify-core` 现在有一条源码级断言守着这个（`retrospectScannedToday(` 出现 ≥3 次、`if (config.retrospectEnabled)` 出现 ≥2 次）。

来源：`docs/peers/auto-memory-and-mindmemos.md:61-64` 的教训「开关必须有读取点，且读取点必须能被 grep 到」。

---

## 开发环境怎么跑（每次都要设）

```bash
cd "D:/deepseek工作区/dsh-anima"
export TMPDIR="D:/deepseek工作区/_tmp_verify"
export TMP="D:/deepseek工作区/_tmp_verify"
export TEMP="D:/deepseek工作区/_tmp_verify"
```

**必须分三条独立 `export`。** 写在同一行时 `$TMPDIR` 在赋值前展开为空，会退化成 `mkdir 'C:\WINDOWS\temp\anima-XXXXXX'` 报 `EPERM`，`verify-core` 会 FAILED 18/251。

四条验证 + 一条验收（当前基线）：

```bash
node scripts/verify-core.mjs        # PASSED all 251
node scripts/smoke-host.mjs         # PASSED all 111
node scripts/smoke-client.mjs       # 通过 74 项
node scripts/check-client-i18n.mjs  # zh=394 / en=394
node scripts/acceptance.mjs --url http://127.0.0.1:<当前端口>
```

`acceptance.mjs` 不带 `--url` 只跑离线部分，`live` 一项会明确写「未给 --url，跳过（这不是通过，是没验）」—— 别把跳过当通过。

---

## 其它环境陷阱（都是这轮踩出来的）

- **同步安装副本**：`C:/Users/zmy/.dsh/profiles/desktop/node_modules/dsh-anima` 是**实体拷贝不是链接**，改完仓库必须手动 `cp`。`workspace-write` 下 `cp` 会被沙箱拦，要 `sandbox_permissions: danger-full-access`。
  - **坑**：`cp src1 src2 dest/` 会按 basename 落位。`client/index.mjs` 和 `index.mjs` 同名，必须分开 `cp` —— 这轮真的把 152KB 的宿主半边覆盖成了 285KB 的客户端文件。
- **git 远程操作在 `workspace-write` 下必然失败**：`error: cannot create standard input pipe for remote-https: Permission denied`。不是网络问题，不是凭据问题，别误判。
- **改 `anima.json` 会被宿主覆盖**：宿主的 meta 表有内存态/写回机制，从外部直接改盘，下一次刷盘就改回去。要测「已有数据的下一轮」只能走 API，不能改文件。实测：用哨兵把 `meta.retrospect.found` 写成 4242，磁盘立刻可见，但 `GET /api/anima/state` 读到 0，再读磁盘又变回 0。
- **`conflicts` 检测的相似度判据**没读过实现细节，动 ④ 之前要先读 `lib/memory.mjs:516-568` 全文。
- **端口每次重启都变**：这轮见过 50430 / 49656 / 54599 / 63918 / 50114，runtime context 里写的经常是过期的，以 `curl` 实测为准。

---

## 我自己的排序（仅供参考，不是结论）

1. **④ 冲突消解** —— 唯一半成品，补完就能真用，但工作量最大
2. **① try/catch** —— 最便宜，不过只防崩不防办错
3. **⑤ 写入闸门** —— **建议直接划掉**，回扫已覆盖同一需求，且实测数据不支持

中间那几条（②③⑥⑦⑨）都得等**实际记忆多起来**、或者你明确想改某一处，才有判断依据。现在动它们等于凭想象定阈值 —— 这也是这轮做回扫时最核心的一条方法学：先拿真实语料量一遍，再决定阈值。

⑧ attest 我明确不熟，要动它得先从宿主 asar 里查接口。

---

## 没做完的两件事（不属于候选池，是欠账）

1. **`leadsAt` 的真实路径从没跑到过**。代码在（`index.mjs:1070-1080` 的 `hasNew` 三表达式 + `index.mjs:1079` 的 `leadsAt` 写入）、断言在（`scripts/smoke-host.mjs:2052-2067` 四条，含 `meta.leadsAt !== meta.scannedAt`）、五套验证全绿，但真实数据里那一支从未触发 —— 因为要「先有一批非空 leads、再跑一轮空的」，而宿主的 meta 内存态让外部改盘无效。等哪天真的捞到新线索，它自然填上，届时看一眼就知道对不对。
2. **2026-11-07 那次系统级事故的完整账目**。删了什么、改了什么权限、改了什么配置，一直没有逐条交代。与 anima 无关，但用户有权知道。
