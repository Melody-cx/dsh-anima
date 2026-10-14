# dsh-anima

DSH 的**助手人格与外挂记忆层**——一个独立插件，装上即可用。

它管的是「**你自己（助手）是谁**」：AI 的名字与角色、你对它的称呼、回复风格、
以及你自己写的行为准则；再加一套**带待审缓冲区的长期记忆**，
以及输入框光轨、输入框快捷开关、工具确认门槛这些界面能力。
字段集不依赖任何其它插件，也不从别处读取配置。

> **工具名为什么是 `set_assistant_persona`**：`tools.register()` 遇同层重名直接抛错
> （`dsh-tools/lib/index.js:2634`），与生态里任何同名工具共存时必有一方注册失败、
> 被 `.catch` 吞成一行 warn —— 那是发布级的静默故障。功能相似不要求撞名。

---

## 它解决什么

| 能力 | 说明 |
|---|---|
| **AI 自己的名字与角色** | `agentName` / `agentRole` —— 决定它怎么称呼自己、以什么身份说话 |
| 用户的称呼 / 背景 / 语气 / 长度 / 语言 | `addressUserAs` / `userOccupation` / `userBio` / `style` / `replyLength` / `language` |
| **按工作区两层覆盖** | 只覆盖声明的字段，其余继承全局；覆盖文件随目录走、可 git |
| **长期记忆** | 自动沉淀 → 待审缓冲区 → 用户裁决 → 注入 |
| 输入框光轨 / 快捷开关 / 工具确认 | 界面与安全开关 |
| 人设预设 | 6 条内置 + 自建；也可把当前配置存成预设 |
| **十二个字段全是自由文本** | 存的就是注入的原话，另有「一键填入 + 示例」按钮组 |
| **记忆随工作区分层** | 全局记忆处处生效，工作区记忆只在匹配时注入 |
| **注入可解释 / 字符预算** | 每条为什么进 / 不进，条数与字符双约束 |
| **本地聚类与冲突提示** | 纯本地 bigram 相似度，只提示不自动合并 |
| **人设变更审计日志** | 谁在什么时候把哪个字段改成什么 |
| **一键导入外部 AI 的记忆** | 复制提示词 → 粘贴结果 → 机械切分 → 逐条裁决层级 |
| 长期记忆的「自动写入」 | ❌ 刻意不做（见下） |

### 关于与 `dsh-soul` 的关系

上表左侧的能力划分与 `dsh-soul` 0.7.0 的字段集**有交集**，实现上也刻意与它保持一致
（工具确认语义、光轨动效参数、重置保留预设）。但本插件**不依赖它**：
字段集完整自持，不读它的配置文件，两者可同时安装且标识全部错开。
这层关系的完整说明见下方「[致谢与差异化声明](#致谢与差异化声明)」。

## 四个差异化设计

功能对齐不等于没有自己的判断。以下四点是本插件相对主流记忆插件的**真实增量**，
每一条都对应一个具体的失败模式。

### 1. 双约束注入：条数与字符同时生效

多数实现只有一个「最多注入 N 条」的上限。问题是 40 条长记忆一样能挤爆上下文，
而用户看到的是「我只设了 40 条啊」。

本插件的 `selectForInjection` 同时受 `memory.maxInjected`（条数，默认 40）与
`memory.maxInjectedChars`（字符，默认 4000）约束，**取先到者**。两条上限各有各的适用场景：
条数管「别让模型看太多碎片」，字符管「别让一次注入吃掉半屏上下文」。

### 2. 注入可解释：看得见每条为什么进 / 不进

注入不是黑箱。设置页的「注入情况」列出**每一条已采纳记忆**的去留与原因：

| 原因码 | 含义 |
|---|---|
| `included` | 已注入提示词 |
| `other-workspace` | 属于别的工作区，不在本会话注入 |
| `no-workspace-context` | 当前会话没有工作区信息，无法匹配工作区记忆 |
| `workspace-scope-unknown` | 标记为工作区记忆但没记录属于哪个工作区 |
| `over-max` | 已采纳条数超过注入上限，按时间取最新的 |
| `over-budget` | 单条就超出字符预算，取不下 |
| `dropped-by-budget` | 前面几条已占满字符预算 |
| `no-injection` | 记忆层已关闭或上限为 0 |

区分 `over-budget` 与 `dropped-by-budget` 是刻意的：前者要删那条，后者要腾位置 ——
报同一个码，用户不知道该动谁。原因文案由宿主下发（`INJECTION_REASON_TEXT` 只有一份），
客户端不重写翻译。

### 3. 本地聚类：只提示，不自动合并

待审缓冲区里若有多条明显在说同一件事，插件用**字符二元组（bigram）的 Jaccard 系数**
（纯本地、零依赖、零模型调用）算出相似度，把「这 3 条像在说同一件事」摆到用户面前。

**刻意不做自动合并**：合并意味着生成一段用户没说过的话。本插件的立场是
「判断什么值得记交给模型，什么真的生效交给用户」——自动合并恰好违背它。
聚类只让裁决更快，不替他裁决。同理「候选撞上已采纳记忆」只提示冲突，不改任何数据。

### 4. 人设变更审计日志

本插件有三个入口能改人设：设置页、`/anima` 命令、模型调用的 `set_assistant_persona` 工具。
而「工具确认」**默认是关的** —— 也就是说，模型可以直接把你叫它什么、它用什么语气回话改掉，
而你无从知道是谁在什么时候干的。

审计日志只记「改了什么」，不做判断、不参与提示词。它挂在 `StateStore.updateConfig` 这**一个**
收口上，而不是在各调用点分别埋点：所有写入路径最终都走这里，分散埋点迟早会漏掉一条，
而漏掉的那条恰恰可能是模型的静默改写。`resetConfig` 也走审计 —— 否则
「昨天还好好的，今天全空了」在日志里查无此事。

记录上限 200 条，独立成表（不塞进 `config`）：`config` 每次启动整条读入内存，
审计会涨到几百条，混在一起等于让启动开销随使用时长上升。
长值在写入时截断为 200 字并附「共 N 字」，数组/对象只记规模 —— 审计是索引，不是备份。

看到它的地方有两处：设置页「变更记录」卡（完整列表，可按条清空），
以及 `/anima show` 的**「最近变更」一行**——只显示最新那条，格式是
`[MM-DD HH:mm] <来源>：<字段名>`，**刻意不带具体值**：值可能很私人，而 `show`
的输出会被复制到对话里问人。

## 致谢与差异化声明

本插件的功能集**参考**了 [dsh-soul](https://github.com/Aliuyanfeng/dsh-soul)（MIT）与
`dsh-checkpoint-rewind` 的设计，并在若干处刻意与它们保持行为一致（存储惰性解析、
失败关闭的确认语义、重置保留用户预设、光轨动效参数）。

需要明确的是：

- **代码全部独立实现**，未拷贝上述项目的源码、注释、提示词文案或图形资源。
- 两处**动效参数刻意取同值**（8 层错位描边、虚线段长 12 / 步进 2.2 / 圆角 22 等），
  理由是避免同一台机器上出现两套观感。这类数值属于思想与参数，不受著作权保护；
  记在这里是为了不让读者误以为拷贝。
- **导航图标刻意画得不同形**：dsh-soul 用「光轨弧 + 火花」，本插件用「人像（头+肩）+ 火花」，
  单色 `currentColor`，viewBox 也另行收紧。
- **各类标识全部错开**，避免共存时互相顶替或注册失败：

  | 类别 | dsh-soul | 本插件 |
  |---|---|---|
  | 工具名 | `set_persona` | `set_assistant_persona` |
  | 设置页 id | `soul-settings` | `anima-settings` |
  | 光轨槽位 id | `soul-trail` | `anima-trail` |
  | 开关槽位 id | `soul-quick-toggle` | `anima-quick-toggle` |
  | 提示词 section | `soul:persona` | `anima:identity` / `:memory` / `:pending` |
  | 存储域 | —（自有文件） | `anima` |
  | 注入来源 kind | `plugin:dsh-soul` | `plugin:dsh-anima` |

工具名错开不只是礼貌：`dsh-tools` 的 `register()` 遇同层重名**直接抛错**
（`lib/index.js` 的 `NamedEntries` 冲突工厂），两者共存时必有一方注册失败、
并被 `.catch` 吞成一行 warn —— 那是发布级的静默故障。



## 核心设计：三段式记忆

这是本插件与市面上 15+ 记忆插件最不一样的地方。

```
对话中通过 remember 工具投递
        ↓
   待审缓冲区（不生效）
        ↓  每晚自动整理：去重 / 淘汰 / 与已采纳项比对
        ↓
   通知用户「有 N 条待你裁决」
        ↓
   用户在设置页逐个「采纳 / 丢弃 / 删除」
        ↓
   已采纳 → 注入提示词
```

**为什么不做静默自动写入**：记忆一旦静默写入就直接影响后续所有回答，写错了用户很难发现。
本插件把「判断什么值得记」交给模型，把「什么真的生效」交给用户。

整理这一步**纯本地、不调用模型**——只做去重、淘汰、与已采纳项比对，不做语义归纳。

记忆**分两层**：`global` 处处生效，`workspace` 只在 `cwd` 归一化后完全相等时注入。
不做「子目录继承」——工作区覆盖是精确匹配语义，记忆若采用继承语义，
用户在子目录里会看到父目录的记忆，排查起来极难。
分层之外的注入解释、预算与聚类见上文「四个差异化设计」。

## 凭据闸门

任何命中凭据形态的内容**在进入缓冲区之前就被拒收**（不落盘、不留痕），
覆盖私钥块、OpenAI/AWS/GitHub 令牌、通用 api_key / secret / 密码赋值、Bearer、
URL 内嵌凭据等 11 类模式。

理由：内容一旦落盘缓冲区，就处于「等待进入提示词」的状态，凭据不该走这条路。
凭据判定用的是 11 类正则的机械匹配，没有语义理解，会有误判——所以被拦下时界面会
把命中规则名一起说出来，用户可以删掉那串字符再粘贴。

## 一键导入外部 AI 的记忆

设置页记忆卡里有一个「导入外部 AI 的记忆」按钮，展开后是两步：

1. **复制提示词**——把一段整理画像的提示词发给你用得最多的那个 AI，让它把你的偏好
   整理成清单。按钮只在真的写进剪贴板后才显示「已复制」；没有剪贴板 API 时会明说
   「复制失败，请手动选中后复制」，不假装成功。
2. **粘贴结果**——粘贴框接受 AI 的输出，也接受你自己手写的笔记（不要求必须是 AI 生成的）。

解析后逐条预览，每条都能改层级（全局 / 本工作区）或直接丢弃，确认后才写进**待审缓冲区**
——和手动添加、模型投递走同一条路，仍然要用户逐条裁决才生效。

**切分是机械的，不做语义理解**：按 Markdown 标题、列表项、空行三种边界切；刻意不按句号切，
因为中文画像里「偏好：结论先行。」被切成两条会读不通。小节标签（如「我的使用画像」）
不进候选——它长得像记忆但没有可采纳内容。

**归类是建议不是判决**：`suggestLayer` 只看措辞——提到具体磁盘路径或「本项目 / 这个项目」
建议 `workspace`，提到「所有项目 / 一律 / 每次都要」建议 `global`。两条都没有时默认 `global`，
理由是把「记忆动不动就不生效」当默认体验，比跨项目污染更糟。每条建议都带一句理由显示在
条目下方，用户看到「本工作区」就能立刻知道凭什么。

**解析阶段就分流**：一条原文切完后按顺序过五道闸，没通过的会被分别归到不同的桶里，
每一桶都在界面上显示出来，**不静默少一条**：

| 处置 | 判定 | 界面上 |
| --- | --- | --- |
| 过短（`< 4` 信息量） | 切出的碎片太短，通常是编号残留 | 只在汇总里报个数 |
| 超长（`> 500` 字） | 单条超过记忆上限 | 不截断，明确告知「请拆成几条」 |
| 凭据 | 命中 11 类正则之一 | 整条拦下并说明命中了哪条规则 |
| 重复 | 与已有记忆文本相同 | 单独列出 |
| 超条数 | 超出单次上限（默认 60 条） | 余下部分不进这一批，另开一次导入 |
| 同义 | 与待审缓冲区里的某条相似度 ≥ 0.6 | 在条目下方提示「已有一条很像」，**不自动合并** |

原文上限 40000 字符，超出直接报错而不是截断（截断等于偷偷丢掉用户画像的后半段）。
同义提示刻意只提示不合并：自动合并会生成一段用户从没说过的话。

---

## 安装

### 从 GitHub 安装（推荐）

本插件尚未发布到 npm，从仓库直接装：

```
dsh plugin add github:Melody-cx/dsh-anima#v1.0.0
```

或者手工改 profile 的 `package.json`：

```jsonc
{
  "dependencies": {
    "dsh-anima": "github:Melody-cx/dsh-anima#v1.0.0"
  },
  "dsh": { "profile": { "bundles": [ /* ... */ "dsh-anima" ] } }
}
```

`#v1.0.0` 是标签（也可以写 commit SHA，或整个省略以跟随 `main`）。**建议 pin 住一个版本**，
否则上游的任何改动都会在下次安装时直接进入你的 profile。git 源下载的是**整个仓库 tarball**
（本仓库很小），首次安装可能比 npm 源慢一些，超时的话重试一次即可。

然后 `pnpm install`，**重启 DSH**。宿主侧改动一律需要重启才生效。

### 从源码安装（开发用）

在 profile 的 `package.json` 里加依赖（也可以用 `/plugins` 界面）：

```jsonc
{
  "dependencies": {
    "dsh-anima": "file:<仓库目录的绝对路径>"
  },
  "dsh": { "profile": { "bundles": [ /* ... */ "dsh-anima" ] } }
}
```

本地 `file:` 依赖是**复制**语义：改完源码要**重新安装**才生效，且重跑安装时若 pnpm 判定
`changed:false` 会直接跳过 —— 正确姿势是先 `remove_bundle` 再 `install_bundle`
（或比对 `node_modules` 副本与源码的 SHA256）。

**运行前提**（`package.json` 里已声明，装不上时先看这几条）：

- `engines.node` = `^22.19.0 || >=24.0.0`，`engines.dsh` = `>=0.1.6-0 <0.2.0 || >=0.2.0-0 <0.3.0-0`
- `peerDependencies` 四包：`@deepseek-ai/cordis`（`^4.0.1 || ^4.0.5-alpha.1`）、
  `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-tools`
  —— 它们由宿主提供，插件不打包它们
- `dependencies.zod`（`^4.4.3`）是唯一真正要装的运行时依赖
- 存储栈需在 profile 里组合：`@deepseek-ai/dsh-storage` + `@deepseek-ai/dsh-storage-json`（配 `root`）
  + `@deepseek-ai/dsh-storage-domain`（配 `backend: json`）。缺了不会崩，但插件会退化成
  「存储不可用」，设置页会明说原因（见下「存储」一节）

## 配置

设置页新增一栏「**灵台**」（`settings.section` id = `anima-settings`，order 51）。

- **助手身份**：`enabled` / `agentName` / `agentRole` / `addressUserAs` / `userOccupation` / `userBio`
- **回复风格**：`style` / `headingLists` / `emoji` / `tables` / `replyLength` / `language` / `customInstructions`
- **工作区覆盖**：`workspaceOverridesEnabled` / `workspaceFileDir`
  覆盖文件默认写在 `<工作区>/.dsh-anima/override.json`（目录名可用 `workspaceFileDir` 改），随目录走、可 git、可拷给别人；
  该目录会自动写入 `.gitignore`（内容 `*`），避免私人语气设定被推到远程。
- **输入框光轨**：`trailEnabled` / `trailColor`（`#RRGGBB`，落盘统一大写）/ `trailSpeed`（`slow|normal|fast`）/ `trailWidth`（`thin|normal|thick`）
- **工具确认**：`requireToolConfirmation` —— 开启后模型调 `set_assistant_persona` 只**提交提议**，不写配置
- **长期记忆**：`memory.enabled` / `autoCapture` / `nightlyTriage` / `nightlyHour` / `maxPending` /
  `maxInjected` / `maxInjectedChars` / `notifyOnSessionStart` / `defaultLayer`

### 不做任何迁移

本插件**不读任何其它插件或自己旧版本的配置**。它是 1.0.0，此前没有发布过任何版本 ——
没有「老用户的介质」这种东西需要兼容，所以代码里既没有一次性迁移，也没有存储格式回退。
这两块曾存在于开发期，都已删除；留着它们的唯一作用是让后人以为有一批需要照顾的存量用户。

将来真要升存储格式：只改 `lib/store.mjs` 的 `DOMAIN_VERSION`，并**先想清楚老用户的介质怎么办** ——
那个决定不该在发布之后临时补，因为补的时候介质已经在用户机器上了。范式可参考同生态的
`dsh-checkpoint-rewind`（双 spec 串行回退）。


### 十二个字段都是自由文本

`style` / `headingLists` / `emoji` / `tables` / `replyLength` / `language` 六个字段**不再是下拉框**，
存的就是要注入提示词的那句话本身。改之前它们是枚举（`style: 'roast'`），改之后
`style: '毒舌吐槽；直白指出问题、不留情面，但始终对事不对人。'` —— 你想怎么写就怎么写，
只要不超过字段上限（`agentName` / `addressUserAs` / `userOccupation` 各 50 字，`userBio` 500 字，
`agentRole` / `style` 各 800 字，`headingLists` / `emoji` / `tables` / `replyLength` / `language` 各 300 字，
`customInstructions` 2000 字 —— 逐字段取值见 `lib/config.mjs` 的 `FIELD_LIMITS`）。

留空是合法状态，**空串在提示词里等于「不提这件事」**：模型按自己判断来，而不是被一句
「请按默认方式处理标题」占用注意力。这也是三项特质的 `default` 档对应的实现 ——
它不是一个值为 `'default'` 的枚举，而是空串。

空输入框会劝退人，所以每个字段下方都有一排按钮：

| 按钮组 | 来源 | 点下去 |
|---|---|---|
| **一键填入** | `lib/wording.mjs` 的 `WORDING_TABLES` | 填入一句**定稿文案**（原档位那句话），填完可以继续改 |
| **示例** | `lib/wording.mjs` 的 `FIELD_EXAMPLES` | 填入一段**明显属于别人的第一人称**，等你改成自己的 |

两组都随 `GET /api/anima/state` 下发给设置页，客户端**不自己抄一份文案表** ——
否则改了 host 忘了客户端，界面上就会出现两套说法，而真正注入的是 host 那份。

`agentName` 刻意**不给示例**：按钮填一个名字进去用户很可能忘改，结果 AI 一直用别人起的名；
这个字段改由 placeholder 提示格式。`default` 档也刻意不生成按钮 —— 空文案做成按钮，
会让人以为点一下能得到什么，其实只是清空输入框。

**兼容旧配置**：升级不会等于「偷偷把用户的风格改回默认」。`migrateConfig` 会把旧版存的档位键
（`'professional'` / `'more'` / `'default'` …）自动翻译成对应文案，注入提示词的内容一字不变；
用户自己写的句子不命中任何档位键，原样保留。

`requireToolConfirmation` 与四个 `trail*` 字段**刻意不参与工作区覆盖**：一个是安全开关，
一组是界面偏好（而且必须是封闭集合 —— 它们是给 CSS 用的键），都不该因为「换个工作区」而悄悄换掉。

`maxInjectedChars`（默认 4000，单位字符）与 `maxInjected`（默认 40 条）**取先到者**：
只有条数约束时，40 条长记忆一样能挤爆上下文。两者的 `0` 含义**不一样**，别记混：

| 字段 | `0` 的含义 |
| --- | --- |
| `maxInjectedChars` | 不限字符数（只有条数约束生效） |
| `maxInjected` | **一条都不注入** —— 它同时关闭所有记忆注入；要停记忆请用 `memory.enabled` |
`defaultLayer` 决定新记忆记在 `global` 还是 `workspace`，默认 `global` 是刻意的 ——
把「记忆动不动就少一条」当默认体验，比跨工作区污染更难排查。

其余 12 个字段可被工作区覆盖，且覆盖是**字段级**的 —— 工作区只声明它在意的字段，其余继承全局。

配置落盘：**只用** `storageDomain`（域 `anima` —— 注意是下划线，宿主的域名校验只接受 `^[a-z][a-z0-9_]*$`，连字符会被拒）。

**惰性解析**（与 `dsh-checkpoint-rewind` 的做法一致）：不在 `apply` 阶段解析服务，首次真正使用时才 `ctx.get('storageDomain')`。
`dsh-storage-domain` 的 `apply` 体是 `ctx.inject(backendServices, …)` + 回调里 `provide('storageDomain', …)`，
而 `backendServices` 是 `storage.backend.json`（由 `storage-json` 提供）。本插件若比 `storage-json` 先装载，
`apply` 阶段那一次 `ctx.get()` 必然拿到 `undefined` —— 这正是 2026-10-10 冷启动时存储后端无声退化的真因：
旧版判空后退化到文件后端，还把结果**永久记忆化**，于是用户的配置留在旧文件里读不出来。

现在的契约：服务缺失 ⇒ 抛 `StorageUnavailableError('storage-not-composed')`，**绝不换落盘点**；
失败**不**记忆化（服务后来就绪时下一次调用就能成）；成功才缓存域句柄。
`index.mjs` 的 `apply` 首次 `reload()` 撞上它时，挂一个 cordis 原生就绪信号
`ctx.inject(['storageDomain'], …)` 等它 provide 后重试（依赖未就绪时 fiber 保持 PENDING，服务 `provide`
那一刻回调触发，本仓用真 cordis 探针实证过），期间三段 section 返回空串 —— 宁可不注入，也不冒充默认档。

**不做旧数据救援**：`storageDomain` 何时可用取决于装载顺序，同一个人可能早期把配置写进过别的落点。
但本插件是 1.0.0，没有「早期版本的用户」—— 所以打开域时不做任何导入或归档，只打开自己的域。
若将来真需要迁移，唯一安全的形状是：**仅在新域 config 记录不存在时**动手，且自己的任何失败都只记 warn，
绝不外抛（这段代码在打开域的 try 块里，外抛会被包成新域的 `open-failed`，让一个本该正常的插件停摆）。

**不可用原因可查**：`GET /api/anima/state` 的 `source` 段带 `reason`（错误码）与 `message`（原始报错）
两个字段，取值 `storage-not-composed` / `vocabulary-unavailable` / `open-failed: <原始报错>`；
正常走域时两者均为 `null`，且 `kind === 'storage'`。设置页把它翻成人话显示在「存储位置」下方。
存储不可用时该路由返回 **503 + `code`**，而不是 500 空壳 —— 设置页要靠它区分「插件没跑」与
「跑了但存储栈没组合」：前者该重装，后者补三行 `storage` / `storage-json` / `storage-domain` 即可。

**单一格式戳，无回退**：`storage-json` 的 single 布局在打开时**硬比对**版本戳 ——
`unit.version !== descriptor.version` 直接抛 `version-mismatch`，没有任何自动迁移。本插件的域版本
**恒为 1**（`lib/store.mjs` 的 `DOMAIN_VERSION`），只声明一个 spec，不做串行回退：1.0.0 之前没有发布过，
不存在「老用户的 v2/v3 介质」这种东西需要读。

开发期曾有过兼容回退（按 `[v3, v2, v1]` 串行 `open()`，只对 `version-mismatch` 继续试），随未发布的
v2/v3 格式一起删除。那段代码的教训保留在这里，因为将来升格式时用得上：**`compatibleVersions` 声明了
等于没写** —— 它只被 per-record 布局的 `acceptedStamps()` 读，single 布局的 `parse()` 根本不看。
真要做多版本兼容，只能像 `dsh-checkpoint-rewind` 那样声明**双 spec**（主 spec + 容错 spec），
且兼容 spec 必须声明**全部四张表** —— `DomainImpl.table()` 对未声明表直接抛错，少一张就会在下一次
`table('audit')` 时炸。

**两套编号，别混**：插件自己的版本是 `package.json` 的 semver（`1.0.0`，设置页右上角徽标那个），
存储格式戳是个位数（当前是 1），两者互不相干。界面上凡出现格式戳的地方一律写「存储格式 vN」，
凡出现插件版本的地方一律带小数点 —— 混着叫「本版 v3」时用户没法判断哪个数字在说他装的插件旧。
`lib/config.mjs` 里那个零引用的 `CONFIG_VERSION = 3` 已删除，就是为了不再制造第二个「v3」。

## 提示词段落

| section 名 | order | 内容 |
|---|---|---|
| `anima:identity` | 10 | 助手自身的名字与角色（可被工作区覆盖，装配期实时求值） |
| `anima:memory` | 20 | 已采纳的长期记忆 |
| `anima:pending` | 21 | 待审条数提示（**只报数量，不含内容**） |

刻意排在 `PLAN_POLICY`(500) 之前：人设是「我是谁」，应当在行为策略之前确立。

## 命令与工具

- `/anima [show|pending|adopt <id>|discard <id>|triage|name <名字>|enable|disable|set <键>=<值>|confirm|reject|reset]`
- 工具 `remember(text, note?, scope?)` —— 投递一条候选到待审缓冲区
- 工具 `set_assistant_persona(...)` —— 模型改助手人设；开启「工具确认」时只落提议，
  需用户 `/anima confirm` 或设置页点「确认」才生效

`/anima show` 是只读诊断命令：**存储栈没组合时它恰恰最该跑得通**——用户正是靠它才知道
「插件在，是存储没接上」，所以它容忍装载失败，把原因和「以上是内置默认值」的提示一起打出来。

## 界面挂载点

| 槽位 | id | order | 内容 |
|---|---|---|---|
| `settings.section` | `anima-settings` | 51 | 「灵台」设置页 |
| `conversation.input.left` | `anima-quick-toggle` | 51 | 输入框左侧的「人设已开 / 人设已关」快捷开关 |
| `conversation.input.overlay` | `anima-trail` | 51 | 输入框光轨（仅助手运行时亮起） |

三个 id 全部与 `dsh-soul` 的对应项错开：`settings.section` 的文档写明「复用已有 id 即替换那一格」，
撞上就会把对方的设置页顶掉。

**设置导航图标**用 DOM 替换实现（常量前缀 `data-an-settings-nav` / `data-an-icon-replaced`）：
壳层的导航图标是 id → 图标的硬编码映射，插件无法通过槽位声明自己的图标。
这是锦上添花的能力，所以代码在入口处检查 `document.querySelectorAll` 是否存在，没有就整体不接管
——绝不能因为画不出一个图标就让整个客户端装载失败。

**光轨为什么带三重自守**：它挂在输入框卡片上，一旦尺寸或定位算错就可能反过来影响宿主布局，
所以实现里有三道闸门——内联 `cssText` 写死 12 条关键属性（防第三方样式表覆盖）、
尺寸超过 `TRAIL_MAX_SIDE` 直接 `disable()`（防尺寸正反馈）、挂载后自检
`getComputedStyle(svg).position === 'absolute'`（防样式被覆盖）。

## 对外服务

```js
const svc = ctx.get('animaConfig')
await svc.getEffective()              // 全局 + 当前工作区合并后的有效人设
await svc.getConfig()
await svc.updateConfig(patch)
await svc.resetConfig()               // 与设置页「恢复默认」同一条路径，同样保留自建预设
await svc.getSystemPrompt(workspace)  // 模型此刻实际看到的人设文本（与三个 section 逐条对齐）
await svc.listPending()
await svc.runTriage()
```

`getSystemPrompt(workspacePath)` 的门控与 `anima:identity` / `anima:memory` / `anima:pending`
三个 section 函数逐条对齐——否则这个服务会答出一份**模型实际看不到**的文本，那比不提供它更坏。
它刻意不复用 `/api/anima/preview`：那是**设置页的展示口径**（带草稿、带 UI 需要的附加字段）。

## 开发

以下脚本在**源码仓库里**跑（`scripts/` 与 `pnpm-lock.yaml` 不进 npm 发布包 —— 发布包共 18 个文件：
`index.mjs` / `lib`（10 个 .mjs）/ `client` / `assets` / `cordis.patch.yml` / `package.json` /
`LICENSE` / `README.md` / `README_EN.md`）：

```bash
node scripts/verify-core.mjs        # 纯函数回归（136 项）
node scripts/smoke-host.mjs         # 宿主侧冒烟（77 项，用假 ctx 真跑 apply）
node scripts/check-client-i18n.mjs  # 客户端字典完整性 + zh/en 对称（zh=en=250 key）
node scripts/smoke-client.mjs       # 客户端渲染冒烟（41 项，假 __ModuleLoader__ + 真钩子运行时）
node scripts/check-live.mjs         # 运行态验收（需 DSH 在跑）
```

前四套都在进程外跑，只能证明「代码是这么写的」。**`check-live.mjs` 证明的是「进程里那份代码确实生效」**——
曾经发生过装机副本停留在旧版、新加的路由一条都没注册、而全部单测依然全绿的情况。
改完插件要**重新安装**才生效：pnpm 的 `file:` 依赖是**复制**语义，重跑 `install_bundle` 时若判定
`changed:false` 会直接跳过，正确姿势是 `remove_bundle` 再 `install_bundle`（或对比 `node_modules`
副本与源码的 SHA256 确认）。宿主侧改动一律需要**完整重启**，热重载不会换掉已缓存的 ESM 模块。

`check-live.mjs` 里的断言刻意**不钉具体值**：名字是你的资产，脚本要防的是「数据丢了」，
不是「你改了名」。同理「模型可改哪些字段」这类契约变化，断言长度而不是逐条枚举内容；
路由数量也一样——它点名核对关键路由是否注册，**不钉总条数**，否则每加一条路由都要回来改这个数字。


`verify-core.mjs` 与 `smoke-host.mjs` 都通过 `scripts/tools-loader.mjs` 把宿主内建包
（`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-storage-domain`）解析到本地替身 —— 它们只存在于宿主
asar 里，在 DSH 之外解析不到；装进 profile 后走的是真实包，由 `check-live.mjs` 覆盖。

## 路由守卫

本插件的 HTTP 路由会读写人设配置与记忆正文，而宿主 webserver **自身不带鉴权**
（`@deepseek-ai/dsh-host-webserver` README 原文：*the server carries no TLS,
authentication, or origin policy of its own*），且默认配置可能绑在 `0.0.0.0`。
因此每条路由都自加一道守卫（`index.mjs:467` 起），三档判定，任一不过即 403：
**非回环来源**一律拒；带了 `Sec-Fetch-Site` 且值不是 `same-origin` 的拒（浏览器发出的跨站请求会带这个头，
它比 `Origin` 更早生效，也覆盖了 `no-cors` 之类的场景）；带了 `Origin` 的还须协议为 http(s)、
主机是回环地址、且 `Origin` 与 `Host` 完全一致。
**不带 `Origin` 的回环请求是放行的**——本机脚本（curl / PowerShell）属于这一档，
这是刻意为之：守卫拦的是**浏览器跨站**，不是本机使用者。做法与生态一致
（`@michengai/dsh-skills-manager`、`@linxin666/dsh-remote-web-ui` 同类实现）。

## 破坏性动作的确认

`POST /api/anima/config/reset` 要求请求体里显式带 `{"confirm": true}`，空 body 一律
**400 + `code: "confirmation-required"`**，一个字段都不动。设置页的「恢复默认」按钮会先弹一次
确认框，通过后才带该字段。语义与 `dsh-checkpoint-rewind` 的失败关闭（fail closed）一致：
拿不到明确确认就什么都不做，并说明怎么做才有效。

重置**保留用户自建的人设预设**——行为与 `dsh-soul` 的 `defaultConfigPreservingPersonas(current)` 对齐，
预设是用户一条条攒出来的资产，重置语气设置不该连它一起清掉。

> 这条护栏来自一次真实事故：为确认路由是否注册，对写路由逐一 `POST {}` 探活，
> `/config/reset` 当场 200 并清空了 `agentName` / `agentRole` / `addressUserAs`。
> 现在有三道防线：路由要求显式确认、`smoke-host.mjs` 断言空 body 不得改动字段、
> `check-live.mjs` 在运行态探一次并在真被清空时就地恢复。

## 已知边界

- 配置写入是**非原子**的（无 tmp+rename），`storageDomain` 路径下由后端保证。
- `anima:pending` 只提示数量，不暴露候选内容——这是刻意的，避免未裁决内容影响回答。
- 工作区覆盖文件的向上查找最多 32 层。
- 路由守卫假定请求经过宿主 webserver；若将来宿主在前面加了反向代理，`remoteAddress`
  会变成代理地址，此守卫需要同步调整。
