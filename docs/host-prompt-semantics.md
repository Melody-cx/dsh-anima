# 宿主提示词装配的真实语义（从 app.asar 里挖出来的，不是猜的）

> **这份文档的目的**：前面 `docs/peers/*.md` 里关于「`section` 好还是 `context` 好」的所有结论，都是**从邻居插件的注释反推**的。这份是直接用宿主自己的源码核的。
> **取源方式**：`D:\dsh\resources\app.asar`（**182434783 字节**，asar header 长度 **4748087**）。`D:/dsh/resources/app.asar.unpacked/dsh/node_modules` 下**只有原生模块**（`koffi`、`node-pty`、`sherpa-onnx` 等），JS 全在 asar 里。用 Node 读 header JSON → 拿 `offset`/`size` → 从 `16 + headerSize` 处按偏移读字节。
> **解出来的文件**：`D:\deepseek工作区\_research\dsh-system-prompt.js`（**19817 字节 / 410 行**，`@deepseek-ai/dsh-system-prompt/lib/index.js`）、`D:\deepseek工作区\_research\dsh-agent-loop.js`（**74599 字节 / 2024 行**，`@deepseek-ai/dsh-agent-loop/lib/index.js`）、`D:\deepseek工作区\_research\dsh-agent.js`（**28257 字节**，`@deepseek-ai/dsh-agent/lib/index.js`）。
> **宿主版本**：`dsh 0.2.1-rc.3`。

---

## 0. 一句话结论

**`section` 和 `context` 不是「一个坏了、一个能用」，是「渲染到两个不同的地方」：**

- `section` → 拼成 **system prompt 字符串** → 变成 `system/message` 事件 → 走 `SystemPromptProjection`
- `context` → 渲染成 **一条 user 消息** → 追加进历史 → 走 `RuntimeContextProjection`，且**内容没变就不追加**

**所以真正影响的是「前缀缓存」，不是「能不能注入」。** 邻居插件注释里说的「`section` 路 scope 层断链（死）」，**在宿主源码里找不到支撑**——见第 4 节。

---

## 1. 两个独立的 order 空间

`dsh-system-prompt.js:11-53`：

```js
const SECTION_ORDERS = {
	HARNESS_IDENTITY: -1e3,
	DEPLOYMENT_PERSONA_PREFIX: 0,
	PLAN_POLICY: 500,
	TEAM_POLICY: 600,
	PTC_ONLY: 800,
	FILE_REFERENCE: 900,
	TOOL_BASH: 1e3,
	TOOL_PWSH: 1010,
	TOOL_READ: 1100,
	TOOL_WRITE: 1200,
	TOOL_EDIT: 1300,
	TOOL_GLOB: 1400,
	TOOL_GREP: 1500,
	TOOL_JOBS: 1600,
	TOOL_PTY: 1700,
	TOOL_WEB_SEARCH: 2e3,
	TOOL_WEB_FETCH: 2100,
	TOOL_LSP: 2200,
	TOOL_SESSION_QUERY: 2300,
	TOOL_GOAL: 2400,
	TOOL_WORKFLOW: 2600,
	TOOL_RALPH: 2700,
	TOOL_SUBAGENT: 2800,
	TOOL_REPORT: 2900,
	TOOL_COMPUTER_USE: 3e3,
	MCP_SERVERS: 3100,
	TOOLS_SDK: 5e3,
	DELIVERABLE_FILE_REFERENCES: 9e3,
	STRUCTURED_OUTPUT: 9900,
	HARNESS_SOURCE: 1e4,
	WEB_SURFACE: 10100,
	DEPLOYMENT_PERSONA_SUFFIX: 10200
};
const CONTEXT_ORDERS = {
	WORKING_DIRECTORY: 100,
	SANDBOX_POLICY: 110,
	APPROVAL_POLICY: 115,
	SUBAGENT_DELEGATION: 120,
	TEAM_IDENTITY: 125,
	HARNESS_SOURCE: 200,
	WEB_SURFACE: 210
};
```

**这是两个互不相干的数轴。** `section` 只在 sections 内部排序，`context` 只在 contexts 内部排序，**永远不会交错**（`assemble()` 返回 `{sections, contexts, tools, variables}` 四个独立数组，`dsh-system-prompt.js:385-398`）。

### 1.1 我们现有四个段的真实位置

`index.mjs:107-117` 定义 identity(10) / memory(20) / pending(21) / quality(30)。放进 `SECTION_ORDERS` 的坐标系：

| 位置 | 段 | order |
| --- | --- | --- |
| 1 | `HARNESS_IDENTITY` | **-1000** |
| 2 | `DEPLOYMENT_PERSONA_PREFIX` | **0** |
| 3 | **`anima:identity`（我们）** | **10** |
| 4 | **`anima:memory`（我们）** | **20** |
| 5 | **`anima:pending`（我们）** | **21** |
| 6 | **`anima:quality`（我们）** | **30** |
| 7 | `PLAN_POLICY` | **500** |
| 8 | `TEAM_POLICY` | 600 |
| … | 一堆 TOOL_* | 1000–10100 |
| 末 | `DEPLOYMENT_PERSONA_SUFFIX` | **10200** |

**结论（事实）：我们的四段确实全部夹在 persona-prefix(0) 和 PLAN_POLICY(500) 之间，`index.mjs:105` 那句注释「排在 dsh-soul 的 soul:persona（order 0）之后、PLAN_POLICY(500) 之前」里，前半句是错的——`soul:persona` 用的是 context 上 order 0 时代的写法，现在 dsh-agent-soul 已经改成 context order 260（`_research/agentsoul/lib/index.js:634-636`）。后半句对。**

### 1.2 邻居插件的 context order 全落在「宿主内建之后」

| 插件 | context order | 落在 |
| --- | --- | --- |
| dsh-x-memory | **95** | `WORKING_DIRECTORY(100)` **之前** |
| dsh-living-memory | **300** | `WEB_SURFACE(210)` **之后** |
| dsh-agent-soul 人格 | **260** | 同上，之后 |
| dsh-agent-soul 记忆 | **250** | 同上，之后 |
| dsh-auto-memory | **10000** | 远超所有内建 |

**四份实现，五个值，跨度 95 → 10000。** 说明这个 order 在 context 数轴上没有公认语义，**纯凭感觉**。

**我们若要迁 memory 段到 context，order 必须重新选。** 合理区间是 **220–320**（`WEB_SURFACE(210)` 之后，与 agent-soul 的 250/260 同族），而不是把 section 的 20 直接搬过去——搬过去会比 `WORKING_DIRECTORY(100)` 还靠前，排在「你的工作目录是 X」之前，语义上是错的。

---

## 2. `section.text` 也能是函数 —— 所以「动态内容必须用 context」这个说法是错的

`dsh-system-prompt.js:386-394`：

```js
sections: sectionDefinitions.map((section) => {
	const assembled = {
		name: section.name,
		text: typeof section.text === "function" ? section.text(context) : section.text,
		...section.interpolate !== void 0 ? { interpolate: section.interpolate } : {}
	};
	if (section.complete === true) completeSection = { ...assembled };
	return assembled;
}),
```

`typeof section.text === "function"` —— **section 完全支持函数文本，每轮现算。**

我们就是这么用的：`index.mjs:475-478` 注册的四个 `section`，`text` 分别指向 `identityText` / `memoryText` / `pendingText` / `qualityText` 四个函数（`index.mjs:228, 246, 262, 300`）。

**所以「迁到 context」的动机不成立。** 真正要问的是：动态内容放在 section 里，代价是什么？

---

## 3. 真正的区别：渲染到哪儿，以及「没变就不发」

### 3.1 section → system prompt 字符串

`dsh-system-prompt.js:118-120`：

```js
function renderPrompt(assembly) {
	return assembly.sections
		.map((section) => section.interpolate === false ? section.text : interpolate(section, assembly.variables, "section"))
		.filter((text) => text.length > 0)
		.join("\n\n");
}
```

### 3.2 context → 一条 user 消息

`dsh-system-prompt.js:140`：

```js
return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`;
```

`dsh-agent-loop.js:335-350`（`RuntimeContextProjection.project`）：

```js
project(current, sections) {
	if (this.retained === void 0 && current.length === 0) return;
	const snapshot = current.length === 0 ? CLEARED : current;
	if (this.retained?.text === snapshot) return;   // ← 内容没变，不追加
	return createUserMessage({
		content: [{ type: "text", text: snapshot }],
		source: sections.length === 0 ? { kind: SOURCE } : {
			kind: SOURCE,
			form: "snapshot",
			sections
		}
	});
}
```

**这一行 `if (this.retained?.text === snapshot) return;` 是全部价值的来源。** 记忆没变 → 不追加任何消息 → 后面的历史完全不动 → 缓存前缀保住。

### 3.3 section 变了会怎样

`dsh-agent-loop.js:265-283`（`SystemPromptProjection.project`）：

```js
project(rendered, input) {
	const nodes = this.systemNodes();
	const head = nodes[0];
	if (head === void 0) return [{ message: createSystemMessage(rendered), intent: { surfaceOp: "append" } }];
	const latest = nodes.findLast((node) => node.text !== "") ?? head;
	if (!input.inHistory || input.startsSeries || rendered.length === 0) {
		const updates = nodes.slice(1).filter((node) => node.text !== "").map((node) => this.replace(node.seq, ""));
		if (head.text !== rendered) updates.push(this.replace(head.seq, rendered));   // ← 整段替换
		return updates;
	}
	if (latest.text === rendered) return [];
	return [{ message: createSystemMessage(rendered), intent: { surfaceOp: "append" } }];
}
```

- 默认路线（`!input.inHistory`）：**整条 system message 被 replace**。我们的 memory 段只要有一条记忆变化，整个 system prompt 字符串就变，整段被替换。
- `inHistory` 路线：不改旧的，**追加一条新的 system message**。但这��� `preparedCall.systemPromptUpdate === "in-history"`（`:1059`）决定的，**是 route 的能力，不是我们能选的**。

### 3.4 一句话

| | section | context |
| --- | --- | --- |
| 文本来源 | 可以静态，也可以是函数 | 同上 |
| 渲染成 | `system/message` | `user/message`（追加在历史尾部） |
| 内容变了 | **整段 replace** | **追加一条新的** |
| 内容没变 | `if (head.text !== rendered)` 不 replace（省了写事件，但 system prompt 还是那一份） | `if (this.retained?.text === snapshot) return` **完全不产生事件** |
| 前缀缓存 | 变了就断 | 变了只断在追加点，前面的全保 |
| `order` 数轴 | 0–10200（宿主内建：-1000 / 0 / 500 / 600 / 1000…10100 / 10200） | 100–210（宿主内建），插件实际用 95–10000 |
| `required: true` | **无效**（只对 contexts 生效） | 有效 |

**`required: true` 只对 context 生效**，证据 `dsh-system-prompt.js:395`（`contexts` 数组的 filter）和 `:401-405`（waterfall 之后的二次过滤）——sections 从头到尾没有任何 `required` 判断。

**这修正了 `docs/peers/agent-soul.md:38-48` 的推断。** 那里写的「四段全加 required，我们一段没加，所以在 `includeRuntimeContext=false` 的会话里我们的人设段与记忆段会被整段抑制」——**前提是错的：我们用的是 section，section 根本不受 `runtimeContextSuppressors` 影响。** dsh-agent-soul 必须加 `required` 是因为它用 context。**我们如果用 section，压根不需要 required；一旦迁到 context，就必须加，否则在子代理 / 精简 preset 下会消失。**

---

## 4. 「section 断链（死）」这个说法，宿主源码里找不到

`docs/peers/living-memory.md:213` 引的是 dsh-living-memory 的注释：

```
案C(ops note)：section→context 迁移——section 路 scope 层断链（死），
context 投影路=每轮 materialize（活·autorecall 同位）；接口同构（types L47-74）。
```

我按宿主源码逐条核：

- `section` 注册：`dsh-system-prompt.js:247-259`（`section()`），只校验 `Number.isFinite(section.order)`，**没有 scope 限制**。
- `section` 合并：`assemble()` 里 `this.layers.merge(scope, (layer) => layer.sections)`（`:364`）——**是带 scope 合并的**。
- `section` 渲染：`assemble()` 里无条件 `sectionDefinitions.map(...)` 算出 text（`:386`），**没有「scope 层断链」的分支**。

**所以「断链」是 dsh-living-memory 作者在某个特定 scope 场景下观察到的现象，不是宿主的设计。** 我们如果照抄这句话当依据去改架构，就是**用一个未经验证的二手结论驱动重构**。

**这条要记进 R01 的反面教材**：邻居插件的注释是「有人说」，不是「宿主说」。

---

## 5. 一个被忽略的事实：`context` 的 text 函数每轮跑不止一次

`dsh-agent-loop.js`：

- `:908` `preStep()` → `const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));`
- `:915`（preStep 的 waterfall 默认分支）→ `renderContextSections(assembly)`
- `:1054`（每次 `step()`）→ `const sections = renderContextSections(this.loopCtx.systemPrompt.refreshContext(assembly, assembleContextFor(this, signal)));`

`refreshContext`（`dsh-system-prompt.js:325-346`）会**重新调用每个 context 的 `text(context)`**（`:334` 的 `resolveContext` → `:188` 的 `entry.text(context)`）。

**所以一个 turn 里如果有 N 个 step，context 的 text 函数就跑 1 + N 次。** dsh-auto-memory 的注释说「恰好两次」（`_research/automem/index.js:17449`），那是它那个场景下 turn 里只有一个 step。

**这对我们是硬约束**：如果 memory 段的 text 函数里做了 IO（读 `anima.json`、跑 `memory-audit`、算衰减），**一次对话里会被调用多次**。现在我们的 `memoryText` 每次调用都 `ctx`/config 读一遍——放到 context 里会变成每个 step 都读。

**迁移前必须先做的优化：把 text 函数变成纯内存计算，或加一个按 `(sessionId, step)` 的缓存。** 否则迁完会变慢。

---

## 6. 另一个可用的注入面：`system-prompt/assemble` waterfall

`dsh-system-prompt.js:399`：

```js
const transformed = await this.ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, () => Promise.resolve(assembly));
```

- waterfall 的入参是**整个 assembly**（`{sections, contexts, tools, variables}`），返回值是权威结果。
- 可以改 `sections`（`dsh-living-memory` 就干这个：`assembly.variables[name] = "{{name}}"` + `assembly.contexts.push({ name, text: "{{" + name + "}}" })`，`_research/living/index.cjs:8070-8073`）。
- **注意变量语法**：`interpolate()`（`:159-183`）遇到未知变量会**抛异常**（`:173-176`）：

```js
if (!Object.hasOwn(variables, name)) {
	const known = Object.keys(variables);
	throw new Error(`unknown prompt variable "{{${name}}}" in ${kind} "${input.name}"; registered variables: ${known.length > 0 ? known.join(", ") : "(none)"}`);
}
```

而且 `renderPrompt` 和 `renderContextSections` 都会调 `interpolate`（`:119`、`:155`）。**任何一个段里出现 `{{未注册的变量}}`，整次装配直接抛。** 我们 `compilePersona` 的输出里如果用户写了 `{{` 后跟 `}}`，就会炸。

**这是一个真实风险：用户在 persona 里写了带 `{{...}}` 的文本。** 我们 `lib/prompt.mjs` 里没有任何转义处理。**必须加一道：注册 section 时传 `interpolate: false`，或者把 `{{` 转义掉。**

`interpolate: false` 是官方支持的（`:119`、`:155`、`:189`），**一行改动，直接关掉这个风险面**。唯一的代价：我们就不能用宿主变量了——我们本来也没用。

---

## 7. 给 dsh-anima 的结论（推翻前一版的三条）

| 之前的说法（来自 peer 注释） | 宿主源码的真相 | 该怎么改 |
| --- | --- | --- |
| 「`section` 是死的，必须迁 context」 | 假。section 支持函数文本、支持 scope 合并、正常渲染 | **不迁**。动机不存在 |
| 「迁 context 是为了能注入」 | 假。迁 context 是为了**不整段替换 system prompt**，保前缀缓存 | 要迁的理由只剩缓存，是**性能优化**不是**功能修复** |
| 「四段都要加 `required: true`」 | 半假。`required` 只对 context 生效，我们用 section 时加了也没用 | 只有迁了 context 才需要加，且改了就必须加 |

**真正该做、且现在就能做的三件事：**

1. **给四段加 `interpolate: false`** —— `index.mjs:475-478` 每行加一个字段。消灭「用户文本里的 `{{x}}` 炸掉整次装配」这个风险面。**这是 4 个字段的改动，收益最大。**
2. **不迁 context**，或者只在明确要抓前缀缓存时迁，且迁之前先去掉 text 函数里的 IO（第 5 节）。
3. **order 语义的注释改掉** —— `index.mjs:105` 那句「与 dsh-soul 的 `soul:persona`（order 0）错开」现在是错的（对方已改 context 260）。注释里的错误比没有注释更危险，因为它会被当成事实传下去。

---

## 8. 一句话教训

**读邻居插件的注释，能得到「他们在做什么」，得不到「宿主在做什么」。**

这一轮读了 11 份插件，其中 `dsh-living-memory` 的「section 断链」如果被我照抄进方案，就会驱动一次**没有必要的重构**——而且是被一个已经有替代方案（context）的项目说服的，它自己也没说清楚断链的前提。

花 20 分钟把 `app.asar` 拆开读 410 行，比读 11 份插件的注释更接近真相。
