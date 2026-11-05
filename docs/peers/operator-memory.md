# operator-memory（`aerovato/operator-memory`）工程机制调研

调研时间：2026-11-04 | 对象版本：main@`c535a55` | 对比基线：本仓库 dsh-anima

## 0. 材料来源与可信度边界

**这份报告的数据来自一个子代理的 `read_page` 通读，不是我本人逐行读的源码。** 通道是 Firecrawl 云渲染打 `github.com/blob` 页，行号可能与真实文件有偏差 —— 下面用「文件 + 行号/函数名 + 原文」定位，行号仅供参考。

读过的文件：`README.md`、`docs/{architecture,comparison,getting-started,troubleshooting,harnesses/deepseek}.md`、`packages/{core,deepseek,helper}/src` 关键文件、`.operator-shared/specs/preamble.md`、issue #48 评论。

**没读到**：`packages/core/src/memory/{user,common,utils}.ts`、`test/*.test.ts` 正文、npm 上适配器实际版本号、未实跑 `operator-helper lint`。所以下文「没有 X」一律是**未见**，不是证否。

---

## 1. 一句话概括

它不是 DSH 插件，是**跨 7 个 harness 通用的文档型记忆层**（Claude Code、Codex、OpenCode V2/V1、Pi、DeepSeek Harness、Kiro），DSH 只是其中一个宿主。

DSH 侧适配器是真插件：`packages/deepseek/src/index.ts`（39 行），`export const name="operator-memory"`、`inject=["systemPrompt"]`。安装方式 `dsh plugin --profile <p> add @aerovato/operator-deepseek`。

**它和 dsh-anima 是竞争关系**：两者都占 systemPrompt 段，而且它是把 preamble 直接 `unshift` 到 sections 最前面，**不走 order 编号**。

---

## 2. 最反直觉的一点：检索、打分、衰减、预算 —— 一个都没实现

不是「实现了没写文档」，也不是「留了接口待做」，而是**认为应该用提示词 + 文件结构替代这些模块**。

`docs/architecture.md` 原文：

> Nothing is ranked, guessed, or retrieved by similarity.
> Loading is deterministic: the same session start produces the same orientation, every time.

`docs/comparison.md` 的立场更硬：criticize「historian model rewrites old conversation while under context pressure while persisting zero inspectable project truth」，也 criticize「dreamers, curators, and verifiers burn quota around the clock curating records you cannot open, review, or trust」。

它还自认**没有任何 benchmark**。issue #48 里作者 kevinMEH 说：Operator 无法被测试，因为它依赖 agent 完成工作后提交知识，而不是摄入句片再回忆。

【判断】这一条必须诚实对待：**它故意做了一件与我们相反的事，而且有明确的理由。** 我们的路线（打分 + 衰减 + 双闸预算）不是唯一正确答案；它的路线（全确定 + 全可读 + 零推断）也不是。区别在于我们服务的是「同一个 agent 的人格连续性」，它服务的是「多个 harness 共享项目真相」。它要的是**跨宿主可移植与可审计**，所以牺牲了相关性。我们要的是**相关性 + 人格感**，所以牺牲了一些确定性。**两者不冲突，但不能混着搬。**

---

## 3. 组织形态：三分区 × 三件套

三个分区（分层轴不是「短期/长期」，而是**权威序 + 谁拥有这份真相**）：

- `.operator-shared/` —— 随仓库共享
- `.operator/` —— 私有
- `~/.operator/user/` —— 跨项目

每分区固定三件套：`operator.md`（指令）、`catalog.md`（目录）、`index/**/*.md`（索引，递归、字典序排序，`memory/project.ts` 的 `readIndexes`）。

freeform 正文分三类：`specs/`（系统真相）、`guides/`（用法）、`product/`（业务意图）。

冲突解决：**`Private > User > Shared`**，`prompts/preamble.ts` 原文「On conflict, later wins」。

frontmatter 只有两个字段：`description` / `read_if`（`memory/frontmatter.ts`）。**没有 timestamp / confidence / weight** —— 所以它**物理上没有**做衰减的原料。

【判断】**这条对我们最有价值**：冲突消解不需要「哪条更新」，可以是「哪个分区更权威」。我们现在的冲突处理只有人工 `supersededBy`，`lib/decay.mjs` 的 `TYPE_WINDOWS` 只影响显示排序，**都不解决「两条说法打架时信谁」**。而它的答案是：不判断新旧，判断**所有权**。

---

## 4. 写入：判定逻辑全在一段提示词里

`packages/core/src/prompts/preamble.ts`（198 行 / 15.4 KB）—— 这是整套系统里唯一「有逻辑」的地方。

原文：

> As you work, record only what future sessions will need. **Do not document anything already evident from the code.**

> **DO NOT create multiple sources of truth.**

> **DO** proactively consolidate or reorganize the freeform brain when an opportunity arises.

**没有模型提炼环节** —— 不存在 extractor/summarizer/curator 进程。写什么由当前 agent 现场决定，直接编辑 Markdown。去重/合并是**软提示**，不是硬约束。

唯一硬约束是格式，由 CLI 校验：`packages/helper/src/lint.ts`（120 行）：
- frontmatter 缺 `description` / `read_if` → `error:true`
- 共享区文档里出现 `.operator/` 私有路径 → `error:true`

**lint 只校验格式，不校验内容真伪、冲突、重复。**

【判断】「软提示写、硬规则只查格式」这个组合比想象中弱：它把内容质量完全押在模型自觉上。它自己的 `getting-started.md` 就承认「Due to inertia, agents may hesitate to write their first documents」。**这正是我们 `dsh-anima` 待审缓冲存在的理由** —— 我们的 `memory.add` 先进 pending，用户裁决后才进长期库。它没有这一层，所以它的记忆质量取决于那个 agent 当天有多勤快。

---

## 5. 检索：没有检索，只有「两级惰性路由」

preamble 只注入三样：`catalog.md` 全文 + index 的**树形清单**（路径 + Description + Read If）+ 主 index 正文。

**子索引正文不注入。** 靠提示词让模型自己判断：

> Read cataloged files when their Read If matches the task.

【判断】这是��「相关性外包给模型」的做法。好处：零推断、零打分、可全量审计。坏处：**你不知道自己不知道** —— 除非 catalog 写全了，否则模型永远想不起来去读某个文件。而且 catalog 本身也是模型写的，同样受「惰性」影响。

对比我们的两段排序键（超窗 → `capturedAt`）：我们至少保证「拿到的都是没超窗的、较新的」，它保证的是「拿到的目录是全的、可读的」。**它的漏是漏在入口，我们的漏是漏在出口。**

---

## 6. 预算：没有

`preamble.ts` 全函数无 token 计数、无字符上限、无截断；`memory/project.ts` 的 `listMarkdownFiles` 无深度/大小/数量上限。

preamble 长度**完全由磁盘文件大小决定**。

【判断】这一项它比我们**倒退**。我们有 `maxInjected: 40` + `maxInjectedChars: 4000`（`lib/config.mjs:79-80`，取先到者）。**这一项不要动。**

---

## 7. 缓存友好：渲染一次 + WeakMap 记忆化

DSH 侧在 `context.on("system-prompt/assemble", ...)` 里把 preamble 塞进 `assembly.sections` 最前，`interpolate:false`；用 `WeakMap<Agent, Promise<string>>` 记忆化，**每个 agent 只渲染一次**。

`.operator-shared/specs/preamble.md` 原文：

> Prefer a synthetic model-call contribution rendered once and held immutable for the session so its prefix remains cacheable.
> Do not refresh on every turn merely to track Brain edits.

【判断】**这是前缀缓存问题的标准答案**，且它给出了配套纪律「本会话内不刷新」。我们现在的做法是每轮 `dispose` + `register` 四段（`index.mjs:475-478`），每轮都产生新的前缀 → 每轮都 miss。这条与 `agent-soul` 的「每 15 轮补一次」形成第三种方案：**一次都不补，且明确写出为什么**。

代价必须说清：**本轮写进去的东西本轮看不见。** 对人格注入无所谓（人格本来就稳定），对记忆注入就不行（刚说的话应该能被引用）。所以这条只适用于**稳定段**（identity / style / instructions），**不能套用到 memory 段**。

---

## 8. 失败模式：失败即丢弃

任一分区加载失败，**整段记忆被换成诊断文本**（`prompts/preamble.ts` 约 28–33 行）。

【判断】一致性最高（绝不会出现半截记忆），但代价是一次坏文件整段记忆消失。我们有 `lib/memory-audit.mjs` 做体检、`lib/patrol.mjs` 做巡夜留痕，正好能补这个缺口 —— **可以把「诊断替代记忆」抄进来，但必须让诊断文本同时触发巡夜上报**，否则用户永远不知道自己的记忆被降级了。

---

## 9. 踩坑原文（可直接抄进注释）

1. `docs/comparison.md` ——「Extraction drops motivations, lessons, constraints, and rationale before any search runs; retrieval can never recover what was never stored.」
   （提炼阶段丢掉动机、教训、约束、理由，检索永远捞不回来 —— 这是对我们 `similarity()` 合并策略的直接警告）

2. `docs/comparison.md` ——「An obsolete decision and its replacement rank side by side; the model gets both and guesses. Nothing in the system knows which is current.」

3. `docs/harnesses/deepseek.md` ——「An out-of-process ACP, SDK, Codex, or Claude Code delegated agent does not receive Operator from its parent.」
   （**子 agent 不继承 preamble** —— 我们如果用 `spawn_teammate`，同样的问题）

4. `docs/troubleshooting.md` ——「Project initialization ensures the exact `.operator/` entry is in the global Git ignore, but does not untrack files already committed or staged.」
   （私密分区曾漏进 git —— 我们的 `anima.json` 在 `C:\Users\zmy\.dsh\storages\` 下，不在工作区，没有这个问题，但 `workspaceFileDir=".dsh-anima"` 那个目录要注意）

5. `docs/getting-started.md` ——「Due to inertia, agents may hesitate to write their first documents」

---

## 10. 对 dsh-anima 的可搬清单

| # | 做法 | 出处 | 代价 | 我的判断 |
| --- | --- | --- | --- | --- |
| 1 | **单位置覆盖式真相 + 权威序**（Private > User > Shared） | `architecture.md`、`preamble.ts` | 我们是逐条记录，改成「每类一个 canonical 槽」是结构性重写 | 可搬，但要缩小范围：只给 `stance` 类做「一个话题一个槽」，`fact`/`event` 保持逐条 |
| 2 | **渲染一次 + WeakMap 记忆化 + 本会话不刷新** | `preamble.ts`、`specs/preamble.md` | 本轮写的东西本轮看不见 | **可搬，只限 identity/style/instructions 三段；memory 段绝对不能套** |
| 3 | 双地图 + `read_if` 惰性路由 | `prompts/preamble.ts` | 相关性外包给模型，漏在入口 | 可选；如果将来记忆条数上百，这是替代全文注入的一条路 |
| 4 | 失败即丢弃（诊断替代记忆） | `preamble.ts` ~28–33 | 一次坏文件整段消失 | 可搬，但必须接巡夜上报 |
| 5 | lint 只查格式，不查内容 | `helper/src/lint.ts` | —— | 不搬。我们已有 `lib/memory-audit.mjs` 查路径与 `verifyAt`，比它强 |

**明确不建议搬的**：

- **不做检索**。它不做是因为它要跨 7 个 harness 保持确定性，我们不需要这个约束。`operator-memory` 的 `comparison.md` 是在批评**别的项目做错了检索**，不是说检索本身错。
- **不做时间衰减**。它对，因为它没有 timestamp 字段。我们有，且我们服务的是单 agent 的人格连续性 —— 衰减是对的。
- **`unshift` 到 sections[0] 不走 order**。我们自己定义 order 10/20/21/30 是有序的，`unshift` 会破坏与 `PLAN_POLICY(500)` 的相对位置。

---

## 11. 一句话结论

`operator-memory` 是这份调研里**唯一一个故意把「智能」全砍掉的项目**：没有检索、没有衰减、没有预算、没有提炼进程，只有目录、条件、和一段提示词。它赌的是「模型足够聪明，只要告诉它有什么，它自己会去读」。

它赌赢了吗？它自己说没有 benchmark 能测。所以这条路的真实水平**目前无人知道**。

对我们来说，它的价值不在于「抄什么」，而在于**提供一个反例边界**：如果我们哪天发现自己正在堆越来越多的打分参数、阈值、衰减窗口、后台进程，可以回头问一句 —— 这些真的比「写清楚、让人读」更有用吗？
