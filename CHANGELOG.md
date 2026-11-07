# 更新日志

本文件记录用户可见的变化。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

两套编号不要混：**插件版本**是 `package.json` 里的 semver（本文件记的就是它），
**存储格式戳**是 `lib/store.mjs` 里 `DOMAIN_VERSION` 的个位数。后者在 1.0.0 与 2.0.0 上都是 **1**，
所以从 1.0.0 升级不需要迁移数据。

---

## [2.1.0] - 2026-11-08

### 新增

- **回扫式复盘**（`lib/retrospect.mjs`、`lib/sessions.mjs`）：回头扫最近 N 天的会话日志，
  挑出用户当时在纠正 / 抱怨 / 明说要记 / 明说禁令的句子，产出**带出处的线索**。
  三条硬规矩：只产线索不写记忆库、无论有没有线索都写一条 `meta.retrospect`、
  默认关闭（它要读磁盘会话日志，是新开的口子）。
  入口四个：`/anima 复盘`、`POST /api/anima/retrospect`、设置页「回扫一次」按钮、
  `/api/anima/state` 的 `retrospectMeta` 下发；打开开关后还会随夜间定时与启动补跑自动跑。
- 新配置项 `memory.retrospectEnabled`（默认 `false`）与 `memory.retrospectDays`（默认 14，区间 1–365）。
  默认关闭的理由与开关必须真有读取点：关着时接口明确回「已关闭」且**不写任何记录** ——
  「被关掉」和「跑了没成」混进同一条记录，以后看到「上次回扫失败」会以为坏了。
- `scripts/probe-retrospect.mjs`：只读探针，用真实语料复核判据命中率。本机 53 个会话 /
  593 条真实发言实测产出 9 条线索（complaint 2 / explicit 0 / correction 7 / constraint 0），
  全量扫描约 3 秒。

### 变更

- `scripts/zstd-frames.mjs` 从实体实现改为对 `lib/sessions.mjs` 的纯 re-export。
  原因：`package.json` 的 `files` 数组不含 `scripts/`，实现留在那里等于「开发时能跑、装好就坏」。

### 修复

- `lib/store.mjs` 的 `configSchema.memory` 补上 `retrospectEnabled` / `retrospectDays`。
  缺这两个字段不会报错，而是**设置页保存成功、刷新后又变回关闭** —— zod 读回时把它们静默剥掉，
  写入路径却照落盘，于是 POST 返回 200 而 GET 读不到。与 2026-10-24 那次 `metaSchema` 是同一形状。
- `metaSchema` 的 `files` / `messages` / `found` / `leadsDropped` 允许 `null`。回扫失败的轮次
  这几个值**未知**，写成 0 就变成「扫了 0 个会话、0 条发言、0 条线索」，
  与「扫过没事」长得一模一样。
- **没有新线索的轮次不再清空上一批明细**。旧实现每次写 `leads: 新的一批 or null`，
  于是用户第二次点「回扫一次」之后，界面上原本找到的线索全不见了 —— 读起来像
  「上次找到的都丢了」。它们其实还在 `leadKeys` 里、也不会重报，只是不再显示。
  现在没有新线索时保留上一批明细，并新增 `meta.retrospect.leadsAt` 记录**这批明细是
  哪一轮找到的**（与 `scannedAt` 分开：扫描时刻每轮都新，明细时刻可能很旧），
  界面据此显示「这批线索是 X 那轮找到的；这轮没有新的，所以沿用」。

### 变更（定时）

- 回扫接进**夜间定时**与**启动补跑**，与巡夜各自判自己的开关和日期。
  曾经把它写在 `nightlyTriage` 分支里 —— 「关掉巡夜」会连带让回扫永远不跑，
  而设置页里回扫是单开的。`verify-core` 加了一条源码级断言守住「回扫有自己的开关读取点」。

### 验证

`verify-core` 234 → **251**、`smoke-host` 103 → **111**、`smoke-client` 69 → **74**、
`check-client-i18n` zh 377 → **394** / en 377 → **394**，四套全绿。

---

## [2.0.0] - 2026-11-07

首个完整发布版。1.0.0 是发布前打的标签，只有人设与记忆的骨架；2.0.0 补上了回答质检、
记忆衰减、巡夜、记忆体检四层能力，并做了一轮完整的外部代码审查。

### 新增

- **回答质检层**（`lib/quality.mjs`）：把十二条判据固化进提示词，并区分「机器能判」与
  「只有人能干」。机器判不了的（答非所问、假装忘记、选择性呈现）照样列出来，
  但标成 `catchMode: 'human'` 并在回报里写清 —— 检查器自己先不许谎报。
  配套脚本 `scripts/audit-response.mjs` 做事后验证，模型无权调用它决定何时检查自己。
- **对账块**：回答里出现数字 / 自查类断言 / 归属类引用时，末尾必须追一个三行的
  【对账】块（查了什么、没查什么）。触发条件写在 `lib/quality.mjs`，不靠自觉。
- **记忆衰减**（`lib/decay.mjs`）：按日历算一条记忆几岁了、有没有超出它那一类的时间窗。
  超窗的只做两件事：注入行尾部加字面标签、在注入排序里排到最后。**记录一个字节都不改。**
- **巡夜**（`lib/patrol.mjs`）：到点自己醒，有需要汇报的才说话，没有就不说。
  堵法：**汇报可以不发，巡夜记录必须留** —— 否则「沉默」会同时代表「查过没事」和「压根没跑」。
- **记忆体检**（`lib/memory-audit.mjs`）：只做机械能验的那一半 —— 记忆里写的路径还在不在、
  复核点过没过。答案来自文件系统与日历，不是来自模型的判断，所以每条结论都能拿命令复现。
- **`remember` 工具**：把值得长期保留的信息投递到待审缓冲区。**投递不等于生效**，
  要用户在设置页采纳后才进长期记忆。
- **注入消息自持 producer id**：会话格式 v4 要求注入消息自带身份，`lib/injection.mjs` 已对齐。
- **两套编号的界面口径**：格式戳一律写「存储格式 vN」，插件版本一律带小数点，
  免得用户分不清哪个数字在说他装的插件旧。

### 变更

- **版本号 1.0.0 → 2.0.0**。存储格式未变（`DOMAIN_VERSION` 仍是 1，四张表 spec 逐字一致），
  从 1.0.0 升级不需要数据迁移。
- **发布物去除所有第三方项目名**：代码注释、README、脚本里的 71 处改为中性表述
  （「某同类人设插件」「某记忆插件」等）。**这只是改称呼，不改事实** ——
  机制来自谁、依据是哪一行，在 `docs/peers/` 的调研记录里仍可逐条核对。
- **逐字引用改为复述**：`lib/store.mjs` 与 `lib/prompt.mjs` 里原先逐字摘抄了同生态项目的
  中文注释，改为用自己的话复述并指明出处位置。
- **示例昵称去个人化**：界面占位符里的具体人名改成通用示例。

### 修复

这些是外部代码审查（按 ocr 的 TypeScript/JavaScript 规则文档逐条判）查出来的：

- **27 处嵌套三元**（`client/index.mjs` 15、`scripts/acceptance.mjs` 5、`test/run-m0.mjs` 3、
  `index.mjs` 1、`lib/injection.mjs` 1、`lib/memory.mjs` 1、`scripts/review.mjs` 1）——
  规则原文「Nested ternary expressions are not allowed」。全部改为扁平化：条件提前算进变量，
  或用 `if` 链。`lib/memory.mjs` 的优先级顺序（disabled > count > chars > error > none）现在是函数体的
  语句顺序，读起来比原表达式清楚。
- **3 处非严格相等** —— 规则原文 `==` / `!=` 一律禁止。关键是 `acc == null` 的语义是
  null ∪ undefined，直接换成 `=== null` 会在中间键缺失时抛 TypeError，所以两处都写了显式判空。
- **65 处静态 inline style** —— 规则原文只豁免动态样式。全部搬进 26 个 CSS 类；
  剩下 1 处 `background: color` 是真动态，按规则保留。
- **1 处硬编码默认 URL** —— `scripts/backfill-types.mjs` 原写着 `http://127.0.0.1:54537`。
  改为无默认值并强制传 `--url`：宿主每次启动端口是随机的，猜错会连到别的进程上。
- **硬编码端口** —— `scripts/check-live.mjs` 与 `scripts/trace-sources.mjs` 同上处理。
- **用户名兜底** —— 三个脚本里 `process.env.USERPROFILE ?? 'C:\Users\...'` 写死了一个用户名，
  改为 `process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')`。
- **zstd 分帧代码重复三份** —— 抽成 `scripts/zstd-frames.mjs`，导出 `frameOffsets` /
  `decodeFrames` / `readSessionEvents`。这是真 bug 的温床：直接解整个文件只能得到第一帧，
  看起来正常实则残缺。
- **`scripts/smoke-client.mjs` 的 `byClass` 判等太严** —— 原来要求 `className` 整串相等，
  加了版式类名后断言全挂。改为按空白切 token 做子集匹配（`an-badge` 仍不会匹配 `an-badge-ok`）。
- **零引用导入与注释拼写** —— `writeFile` / `parsePatrolSignature` / `patrolSignature` 三处删除；
  `lib/injection.mjs` 的 `finduings` 改为 `findings`。

### 验证

发布时四套验证全部通过：

- `node scripts/verify-core.mjs` → 234 项
- `node scripts/smoke-host.mjs` → 103 项
- `node scripts/smoke-client.mjs` → 69 项
- `node scripts/check-client-i18n.mjs` → 中英字典各 377 条，源码用到的 key 全部存在

另外 `node scripts/acceptance.mjs` 会跑端到端验收（会启动宿主、需要指定端口），
`node scripts/review.mjs` 可以把外部代码审查工具接进来。

### 已知未做

- **没发 npm**。安装走 GitHub 标签（见 README「安装」节）。
- **`docs/` 里的第三方名字保留**。它不在 `package.json` 的 `files` 里，不进发布包；
  留着是为了让「这条机制来自哪个仓库的哪一行」可核对。
- **没有 CI**。四套验证靠发布前手动跑。

---

## [1.0.0] - 2026-10-15

发布前打的第一个标签。只有人设与记忆的骨架（`lib/config.mjs` / `lib/memory.mjs` /
`lib/prompt.mjs` / `lib/store.mjs` / `lib/workspace.mjs` / `lib/injection.mjs` / `lib/presets.mjs`
与设置页），没有质检层、衰减、巡夜、记忆体检。

存储格式戳当时就是 **1**，四张表（config / memories / meta / audit）与 2.0.0 一致。
