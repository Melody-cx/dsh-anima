# 更新日志

本文件记录用户可见的变化。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

两套编号不要混：**插件版本**是 `package.json` 里的 semver（本文件记的就是它），
**存储格式戳**是 `lib/store.mjs` 里 `DOMAIN_VERSION` 的个位数。后者在 1.0.0 与 2.0.0 上都是 **1**，
所以从 1.0.0 升级不需要迁移数据。

---

## [2.1.3] - 2026-11-09

### 改进

这一版只动设置页的排版，不改任何存储字段、不改任何判据。原因：宿主把第三方分区
塞进一个 800px 宽、最高 800px 的设置面板里，左边已固定占掉 188px 导航、右边留
24px 内边距，**实际可用内容宽约 564px、可视滚动高约 722px**（这组数是按宿主
`dsh-client-ui-settings-general` 的 CSS 量出来的推断值，没截图量过）。而灵台这张
设置页有九张卡、约 1200 行渲染代码，其中记忆卡一张就占四分之一。

- **两条常驻栏不再同时吃视口**。原来的分区导航 `position:sticky;top:0` 与保存栏
  `position:sticky;bottom:0` 在 722px 的滚动窗口里常驻约 76px（≈10%）。现在导航
  **不再吸顶**（只有五栏、切换成本本来就低，吸顶收益抵不上它吃掉的高度）；
  保存栏**只在有未保存改动时才吸底**，干净时它留在页面末尾当普通一行 ——
  干净时它也没东西可保存，钉在那里只是占位。底部为吸底预留的 72px 内边距也只在
  脏态才给。
- **记忆卡里的四个清单区可折叠**：待审、手动添加、已采纳、已丢弃各有一个折叠按钮，
  默认「要动手的展开（待审、手动添加）、只核对的收起（已采纳、已丢弃）」。
  收起是 `display:none` 而**不是卸载子树** —— 子树里有未提交的草稿（手动添加的
  输入框、导入面板解析出来的预览），卸载等于把用户刚敲的字扔掉。折叠态与卡片折叠
  共用同一份 `localStorage`（键带 `block:` 前缀），刷新后记得住。
- **窄窗口下的字段折行**。三个并排的数字框原来挤在 300px 内容宽里会被压到不足
  90px，现在按 `flex-wrap` 自然折行。这条沿用本文件既有的「不用媒体查询」做法。
- **分区导航补上键盘操作**：左右方向键换栏、`Home`/`End` 跳到首末栏，焦点跟着
  一起走（只改选中不改焦点，下一次按 Tab 的落点会跳得很意外）。补了 `aria-controls`
  （指到本栏第一张卡）与 `role="tabpanel"` / `aria-labelledby`，tab 用漫游
  `tabIndex`（选中项 0，其余 -1）。

### 没做

- 自建左栏导航、双列栅格、给内容加 `max-width` 居中：这三条在量完宿主面板之后都
  不成立 —— 宿主导航已占 188px，内容列本来就只有约 564px，再分栏只会更窄。
- 把五个分区合并成四个：会改变用户可见的页面结构，需要单独确认。

### 验证

`verify-core` **254**、`smoke-host` **113**、`smoke-client` **77**（+1：记忆卡四个
子块的默认态、收起不卸子树、折叠态落盘）、`check-client-i18n` zh **395** / en **395**。

新加的那条 client 用例中途失败过三次，每次都是断言本身写错（默认收起态应有 4 个子块
但夹具里 `discarded` 是空的；`block:adopted` 存的是「收起没有」而不是「展开没有」；
卡片收起数被前一条用例翻过不能死写 1）—— 不是实现错。这三次都记在这里，因为
「用例红了先怀疑实现」差点让我把正确的代码改坏。

---

## [2.1.2] - 2026-11-09

### 修复

- **导入的记忆终于会生效了（这条是主 bug）**。导入分两步走：`parse` 把粘贴内容切成
  候选并给出「全局 / 本工作区」建议，`commit` 把用户确认过的那批落进待审缓冲区。
  旧实现的 `parse` 会把工作区坐标写进候选记录，`commit` 阶段却重新调了一次
  `makeCandidate()` 而**没带 `cwd`** ⇒ 落库记录没有 `cwd` 字段 ⇒ `matchLayer()` 判成
  `workspace-scope-unknown` ⇒ 用户明明采纳了，这条记忆却永远不会被注入，而界面上
  「已导入 N 条」一切正常。现在提交与解析走同一口径（`?cwd=` 查询参数），
  workspace 级条目落库时带上归一化后的坐标。
- **提交阶段的 `cwd` 只认查询参数，不认 body 里的 `item.cwd`**。`cwd` 决定「这条记忆
  在哪些工作区生效」，而 body 是请求方自己填的 —— 让它自报坐标等于让它自己划范围。
- **没选定工作区时，不再建议「本工作区」**。旧实现只看措辞（「这个项目」「本项目」…）、
  不看有没有坐标，于是没选工作区的用户会得到一批 `workspace` 建议，落库全是死记录。
  现在 `suggestLayer()` 收 `hasCwd`：没坐标时降级为全局、置信度 `low`，理由里写明缺工作区；
  设置页把「本工作区」按钮置灰并给出提示；宿主对「选了 workspace 但没带坐标」的提交
  **逐条拒绝并说明原因**，而不是静默降级成全局 —— 降级会改变它生效的范围，那是用户的
  决定，不是服务端的。
- **被否决过的记忆不再永久挡住重新导入**。查重指纹表原来看全量记录，一条已经
  `discarded`（或 `state: 'dropped'`）的记忆会让用户永远重导不进来，而界面只显示「重复」。
  现在只拿「还活着」的记录做指纹；已采纳的仍然参与查重（那条行为没错）。
- **没有空格的列表项也能切成独立条目**。`LIST_ITEM` 原来要求列表符号后必须跟空白，
  `-没有空格的补充说明` 会被并进上一行，切出一条「1、xxx -没有空格的行」的缝合怪。
- **单条长度上限不再在界面上硬编码 500**。真实上限是 `MEMORY_TEXT_MAX`，
  `/state` 现在把它作为 `memoryImport.maxText` 下发，界面读它。原先这是两份独立数字，
  改了一处另一处不会跟着动。
- **设置页的注入解释面板不再拿错答案**。`loadState()` 原来打的是裸
  `/api/anima/state`，而宿主用 `?cwd=` 决定「按哪个工作区算注入」——不带就是按
  「没有工作区上下文」算，于是一条**正在生效**的工作区记忆会被标成
  `no-workspace-context`，面板指着它说「这条没进去」。现在拉 state 带上当前工作区，
  且 `loadWorkspace()` 改完坐标会重算一遍（空路径也重算 —— 那是「回到全局」，
  decisions 同样要变）。这个错以前看不出来，因为工作区记忆根本落不了库（上面那条
  主 bug），没有工作区条目可解释。

### 验证

`verify-core` **254**（+3：无 cwd 不给 workspace 建议 / 被丢弃的不参与查重 / 无空格列表项）、
`smoke-host` **113**（+2：提交必须带 cwd 且 global 不带 / 没 cwd 时逐条拒绝；
原 commit 用例补了 `cwd` 断言）、`smoke-client` **76**（+2：没工作区时按钮置灰、
预览里挂着的 workspace 显示成全局、提交不带空 cwd 参数；拉 state 必须带工作区坐标；
原用例补了"提交必须带 cwd"）、`check-client-i18n` zh **395** / en **395**。

这四套以前全都不断言 `cwd`，所以这个 bug 一直跑绿 —— 这也是本轮每条新用例都盯
「坐标有没有落下去」的原因。新加的那条 client 用例做过反向验证：把 `?cwd=` 去掉后
它确实 FAIL（报「拉 state 没带工作区坐标」），装回来才 ok。

---

## [2.1.1] - 2026-11-08

### 修复

- **没有新线索的轮次不再清空上一批明细**。旧实现每次写 `leads: 新的一批 or null`，
  于是用户第二次点「回扫一次」之后，界面上原本找到的线索全不见了 —— 读起来像
  「上次找到的都丢了」。它们其实还在 `leadKeys` 里、也不会重报，只是不再显示。
  现在没有新线索时保留上一批明细，并新增 `meta.retrospect.leadsAt` 记录**这批明细是
  哪一轮找到的**（与 `scannedAt` 分开：扫描时刻每轮都新，明细时刻可能很旧），
  界面据此显示「这批线索是 X 那轮找到的；这轮没有新的，所以沿用」。

### 验证

`verify-core` **251**、`smoke-host` **111**、`smoke-client` **74**、
`check-client-i18n` zh **394** / en **394**，四套全绿（其中 smoke-client 与 i18n
各加 1 项，守住「旧明细必须说清是哪一轮找到的」）。

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

### 变更（定时）

- 回扫接进**夜间定时**与**启动补跑**，与巡夜各自判自己的开关和日期。
  曾经把它写在 `nightlyTriage` 分支里 —— 「关掉巡夜」会连带让回扫永远不跑，
  而设置页里回扫是单开的。`verify-core` 加了一条源码级断言守住「回扫有自己的开关读取点」。

### 验证

`verify-core` 234 → **251**、`smoke-host` 103 → **111**、`smoke-client` 69 → **73**、
`check-client-i18n` zh 377 → **393** / en 377 → **393**，四套全绿。

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
