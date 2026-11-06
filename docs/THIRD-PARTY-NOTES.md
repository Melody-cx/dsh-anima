# 第三方项目来源与许可说明

本仓库在 `docs/peers/` 下保存了一批对同生态插件的**只读调研记录**。那些记录里大量引用了他人的
文件名、行号、注释原文与参数值。为了让版权边界可核查，这里统一说明：

1. **这份文件只回答一件事**：我们读过谁、他们是什么许可、我们有没有把他们的代码搬进本插件。
2. 本插件自身许可见根目录 `LICENSE`（MIT），`package.json` 的 `license` 字段同为 `MIT`。

---

## 一、我们对这些项目做了什么，没做什么

**做了**：通过 jsDelivr CDN / npm tarball / GitHub API 拉取源码到本机临时目录（`_research/`，
该目录**不进版本库**），逐文件阅读，把机制、行号、踩坑原文写进 `docs/peers/*.md`。

**没做**：没有把任何第三方源码文件、注释块、提示词文案或图形资源复制进本仓库的可执行代码
（`index.mjs` / `lib/` / `client/` / `scripts/`）。

`docs/peers/` 里出现的第三方注释原文（例如某插件写在自己代码里的「缓存全废了」这类句子）属于
**引用与评论**，用途是记录设计依据，不构成本插件运行代码的一部分。

仓库里仅有两处可执行代码提到同类项目，且都是**注释**，不含对方代码：

- `index.mjs:111` —— 说明一条 1.0.0 时期的旧注释已不成立，点名 `dsh-agent-soul`。
- `lib/prompt.mjs:375` —— 转述 `dsh-x-memory` 写在它自己 `lib/index.js:233` 的一句注释，用来说明我们为何这样设计。

---

## 二、调研过的项目与许可（GitHub API 实测）

星数为取数当时的快照，**不同文档写作时间不同，数字会不一致**，以本表为准时请连同"取数日期"一起引用。

| 仓库 | 许可 | 星数 | 我们在哪份文档里写过它 |
| --- | --- | --- | --- |
| `agentscope-ai/ReMe` | Apache-2.0 | 3755 | `docs/peers/reme.md` |
| `MemTensor/MemOS` | Apache-2.0 | 12286 | `docs/essence-from-peers.md` §2/§3/§4/§6/§7/§8 |
| `MemTensor/memmy-agent` | MIT | 2200 | `docs/peers/memmy.md` |
| `aerovato/operator-memory` | BSD-3-Clause | 503 | `docs/peers/operator-memory.md` |
| `omdsh-dev/dsh-mnemon` | MIT | 906 | `docs/peers/mnemon.md` |
| `yyh-001/DSH-X`（含 `dsh-x-memory`） | MIT | 767 | `docs/peers/dsh-x-memory.md` |
| `dearbld/dsh-living-memory` | MIT | 3 | `docs/peers/living-memory.md` |
| `Aik358/dsh-auto-memory` | BSD-3-Clause | 187 | `docs/peers/auto-memory-and-mindmemos.md` |
| `mindscale-noah/MindMemOS` | **无许可声明**（见第四节） | 928 | `docs/peers/auto-memory-and-mindmemos.md` |
| `YuJunZhiXue/dsh-purge` | Apache-2.0 | 19358 | `docs/essence-from-peers.md` §0.5 |
| `Yuuyuko-uu/dsh-fish-memory` | 见第四节（`NOASSERTION`） | 483 | `docs/essence-from-peers.md` §1 |
| `csyangwen/dsh-memory-evolve` | MIT | 635 | `docs/essence-from-peers.md` §1/§5 |
| `findshan/dsh-agent-memory` | MIT | 1 | `docs/essence-from-peers.md` |
| `ousiqwq/dsh-soul-desk` | MIT | 0 | `docs/peers/soul-desk.md` |
| `danshuyue/dsh-agent-soul` | MIT | 1 | `docs/peers/agent-soul.md` |
| `Amakurai/dsh-liketavern` | MIT | 233 | `docs/essence-from-peers.md` §10 |
| `Scorp1o117/dsh-soul-md` | MIT | 34 | `docs/essence-from-peers.md` §10 |
| `Awoodwhale/dsh-agent-persona` | Apache-2.0 | 13 | `docs/essence-from-peers.md` §10 |
| `kiefeng/dsh-lan-memory` | MIT | 2 | `docs/essence-from-peers.md` §10 |
| `Aliuyanfeng/dsh-soul` | MIT | 9 | `README.md` 致谢节（功能参考） |

**取数方式**：`https://api.github.com/repos/<owner>/<repo>` 的 `license.spdx_id` 与
`stargazers_count` 字段，逐个请求，2026-11-06 执行。

---

## 三、逐类结论

### 3.1 我们实际"抄了机制"的部分

机制、分层思路、阈值量级、失败教训——这些属于**思想与方法**，不在著作权保护范围内。我们搬的是这些：

- 注入位置从 `systemPrompt.section()` 迁到 `systemPrompt.context()` 的理由（缓存）——来自
  `dsh-fish-memory` 与 `MemOS` 的注释，但**代码是我们自己写的**。
- 记忆预算链、分档配额、超限可见性——来自 `Memmy` / `dsh-mnemon` / `dsh-auto-memory` 的对比结论。
- 类型/状态/复核点的记忆元数据模型——来自 `dsh-agent-soul` 与 `MemOS` 的字段对照。

### 3.2 我们刻意"没抄"的部分

- `dsh-soul-desk` 的 monkey-patch `prompt.assemble`、全量塞 `sections`、假备份恢复、DOM hack —— `docs/peers/soul-desk.md` 里标为"必须避开"。
- `dsh-liketavern` 的整套角色扮演前端（与我们不是同一类产品）。
- `MindMemOS` 的 Python pipeline 架构（体积与运行环境都不匹配）。

### 3.3 与 `dsh-soul` 的关系

`Aliuyanfeng/dsh-soul`（MIT，9★）是本插件**功能集**上参考最直接的一个。差异已写在 `README.md`
的「致谢与差异化声明」一节：工具名、设置页 id、槽位 id、提示词 section 名、存储域、注入来源 kind
全部错开，动效参数刻意取同值并已在 README 说明原因，图标另行绘制。

---

## 四、两处需要留意（不是问题，但要留痕）

### 4.1 `mindscale-noah/MindMemOS` —— 无许可声明

GitHub API 返回 `license: null`，即仓库**没有附带任何开源许可**。按著作权默认规则，
无许可 = 保留所有权利。

我们做的是：只读，把「三条纪律」写进 `docs/peers/auto-memory-and-mindmemos.md`，
**没有复制它的任何文件到本仓库**。这个状态可以接受，但应避免：
- 不要把它的源码贴进本仓库任何文件（包括 `docs/`）；
- 不要把它当作可以直接 vendoring 的依赖。

### 4.2 `Yuuyuko-uu/dsh-fish-memory` —— `NOASSERTION`

GitHub 识别到许可文件但无法归类（`package.json` 写的是
`SEE LICENSE IN LICENSE`）。**要复用它的代码前必须先读它的 `LICENSE` 原文**。
目前我们只引用了它的一句注释作为设计依据，没有复制代码。

---

## 五、如果将来要真的复制代码

以上所有结论的前提是「只读、只搬思想」。一旦要复制某个项目的**代码块**，必须：

1. 确认 SPDX 许可允许（MIT / Apache-2.0 / BSD-3-Clause 均可，但 Apache-2.0 与 BSD-3-Clause 有
   **署名与声明保留**义务，且 Apache-2.0 还涉及专利授权条款）；
2. 在源文件头部保留原始版权声明；
3. 在本文件中新增一节，记录「哪个文件复制自哪个仓库的哪个路径、对应哪个 commit」；
4. `MindMemOS` 不允许复制（无许可）；`fish-memory` 先读许可原文。

---

## 六、这份文件的维护

- 新增一份 `docs/peers/*.md` 时，同步在上表加一行。
- 星数与许可都带时效性；引用数字时请标日期，不要当成永久事实。
- 本文件不对 `_research/` 目录负责——那里是临时读取副本，不属本仓库，也会被清理。
