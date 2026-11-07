// client/index.mjs — dsh-anima Web UI 插件
//
// 在设置页新增一个栏目「灵台」（独立栏目，不依赖任何其它插件）：
//
//   1. 人设预设 —— 内置 6 套 + 自建；套用只覆盖预设声明的字段
//   2. 助手身份 —— AI 自己的名字与角色设定（某同类人设插件的 nickname 是「用户的名字」，
//      不是 AI 的名字，这是本插件补上的缺口）
//   3. 用户背景 —— 称呼 / 职业 / 简介，独立成段以免与助手身份混读
//   4. 回复风格与特质 —— 风格 / 标题列表 / 表情 / 表格 / 长度 / 语言 / 补充指令
//   5. 工作区覆盖 —— 选定工作区后，只覆盖它显式声明的字段，其余继承全局
//   6. 长期记忆 —— 待审缓冲区（可采纳/丢弃/删除）+ 已采纳列表 + 每晚整理
//   7. 提示词预览（只读）—— 取宿主真实装配结果，含尚未保存的改动
//
// 手工写的纯 JS + React jsx-runtime（不依赖 JSX 构建）。
// 注意：React 17+ 的 jsx-runtime 里 children 必须放在 props.children，
// 不能当第三个参数传（第三个参数是 key）。
//
// 数据通道与某同类人设插件保持同一形态：自建 fetch 打到本插件自己的 HTTP 路由
// （第三方客户端插件读不到宿主的 host.call，见 dsh-client-runtime 只 seed 平台模块）。

window.__ModuleLoader__.load({
  id: 'dsh-anima',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const { jsx: h, jsxs: hs } = require('react/jsx-runtime')
    const React = require('react')

    // 组件库在宿主的 module table 里已 seed；万一取不到就退化成原生元素。
    let ui = null
    try {
      ui = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      ui = null
    }

    const e = (type, props, ...children) => {
      const p = props || {}
      if (children.length === 0) return h(type, p)
      if (children.length === 1) return h(type, { ...p, children: children[0] })
      return hs(type, { ...p, children })
    }

    const NS = 'anima'
    // 与 package.json 的 "version" 保持同一条口径：徽标上显示的版本和发布的版本
    // 必须是同一个数字，否则用户报 bug 时对不上号。
    const VERSION = '2.1.0'
    const REQUEST_TIMEOUT_MS = 15000

    // ── 设置页分区 ──────────────────────────────────────────────────────
    //
    // 十张卡片平铺在一页里时，用户的原话是「太乱了我看不明白」。分区不是为了
    // 好看，是为了让任何时刻屏幕上只有一类东西 —— 找「记忆」不必先滚过四张卡。
    //
    // 这里只声明「哪张卡属于哪一栏」，卡片的渲染顺序与折叠机制一概不变；
    // 不活跃的分区**仍然渲染**，只是被 display:none 藏起来。理由有两条：
    //   ① 折叠态、未保存的表单值都在这些卡片自己的子树里，真不渲染会把用户
    //      切走前敲了半截的内容一起丢掉；
    //   ② 渲染树是测试的取样对象，整片不渲染会让大量既有断言失去落点。
    // 代价是首屏 DOM 不变小 —— 但用户看到的确实少了，而这是他提的问题。
    const SECTIONS = [
      { id: 'persona', cards: ['identity', 'user', 'style'] },
      { id: 'preset', cards: ['preset'] },
      { id: 'memory', cards: ['mem'] },
      { id: 'behavior', cards: ['quality', 'trail'] },
      // 变更记录不在这张表里：它常驻在页面顶部（RecentChanges），
      // 不再是一张要切到「高级」栏、再点开才看得见的卡。
      { id: 'advanced', cards: ['ws', 'preview'] }
    ]
    const SECTION_IDS = SECTIONS.map((item) => item.id)
    // 上次看的是哪一栏。与折叠状态同样的处理：读写全吞异常，脏值一律回第一栏。
    const ACTIVE_SECTION_KEY = 'dsh-anima:active-section'

    const INITIAL = {
      loading: true,
      saving: false,
      error: null,
      lastChanged: [],
      config: null,
      source: null,
      limits: null,
      // 档位文案与示例两组按钮的来源，均随 /state 从 host 下发。
      // wording 是「点一下就定稿的档位」，examples 是「点一下还要改成你自己的」，
      // 分开存是因为界面行为不同 —— 也正因如此，两个字段都得在这里接住，
      // 漏接会让按钮组整片消失（不报错，只是画不出来）。
      wording: {},
      examples: {},
      presets: [],
      // 当前生效的预设 id（按字段比对算出，不是「上次点了哪个」）。不在任何预设上时为 null。
      activePresetId: null,
      builtinPresetCount: 0,
      // 模型提出、等待用户点头的人设变更（宿主开启工具确认时才有内容）。
      // 进程内状态：宿主重启后一律为 null。
      pendingProposal: null,
      memories: { pending: [], adopted: [], discarded: [] },
      // 一键导入（Phase ②）：host 下发的提示词与两个上限。老宿主没有 ⇒ null，
      // 此时不画导入按钮（而不是画一个点了没反应的按钮）。
      memoryImport: null,
      // 注入可解释性：每一条已采纳记忆「为什么进 / 为什么不进」，
      // 以及条数与字符两个预算的用量。纯计算，由宿主随 /state 下发。
      injection: { cwd: '', decisions: [], budget: null },
      // 本地聚类（几条候选像在说同一件事）与冲突（候选撞上已采纳记忆）。
      // 只作提示，不自动合并 —— 合并等于替用户写一段他没说过的话。
      clusters: [],
      conflicts: [],
      triageMeta: null,
      // 巡夜记录（最近一次到点或手动跑的结果，无论报没报）。
      // 只报有事之后，「没汇报」必须能反查成「真的没事」，否则沉默同时代表
      // 「没事」和「它坏了」—— 这个字段就是那个反查出口。
      patrolMeta: null,
      // 回扫式复盘的记录（最近一次手动或定时跑的结果，无论有没有线索）。
      // 与巡夜同一条纪律：它存在的意义就是让「没线索」能被反查成「真的扫过」，
      // 而不是和「压根没扫」长得一模一样。
      retrospectMeta: null,
      // 质检钩子的运行计数（宿主内存态，重启清零）。
      // 放在 state 里跟着 /state 一起来，因为它唯一的用途就是让用户一眼区分
      // 「查了、没事」和「根本没查」—— 藏进日志等于要用的时候用不上。
      qualityStats: null,
      workspaces: [],
      workspacePath: '',
      workspaceState: null,
      workspaceSaving: false,
      workspaceError: null,
      preview: null,
      previewLoading: false,
      previewError: null,
      presetBusy: false,
      // 人设变更审计日志（谁在什么时候把哪个字段改成了什么）。
      // 宿主随 /state 下发尾部若干条，这里先接住，展开时再拉全量。
      audit: { entries: [], total: 0, max: 200, sourceText: {}, actors: [] },
      auditLoading: false,
      auditError: null,
      showAudit: false,
      showInjection: false,
      toast: null
    }

    // 人设字段清单 —— 与 host 侧 OVERRIDABLE_FIELDS / PRESET_FIELDS 同集合。
    // 客户端的脏检查、工作区覆盖表单、预览同步都按这份清单走，避免三处各写一遍。
    const PERSONA_FIELDS = [
      'agentName', 'agentRole', 'addressUserAs', 'userOccupation', 'userBio',
      'style', 'headingLists', 'emoji', 'tables', 'replyLength', 'language',
      'customInstructions'
    ]

    /**
     * 六个「风格类」字段 —— 它们的取值是一整段话，不是枚举键。
     *
     * v3 起这几个字段存的就是要注入提示词的文案本身（见 host 侧 lib/wording.mjs），
     * professional / more / concise 这类英文键已经不再落进配置里。这里保留清单，
     * 只为渲染「一键填入」按钮组，以及告诉渲染层「这几项要多行输入」。
     *
     * 按钮上写什么、点下去填什么，一律取自 host 随 /state 下发的 wording ——
     * 客户端不自己抄一份文案表，否则改了 host 忘了客户端就会出现两套说法。
     */
    const WORDING_FIELDS = ['style', 'headingLists', 'emoji', 'tables', 'replyLength', 'language']

    /**
     * 取某个字段的「一键填入」候选。
     *
     * 数据来自 host：`/state` 的 wording 是 `{ 字段名: [{id, text}] }`，其中 text
     * 为空的档位（三项特质的 default）host 已经过滤掉了 —— 空串在提示词里等于
     * 「不提这件事」，做成按钮会让人以为点一下能得到什么，其实只是清空输入框。
     */
    const wordingOptions = (state, field) => {
      const table = state?.wording?.[field]
      return Array.isArray(table) ? table : []
    }

    /**
     * 取某个字段的**示例**候选（身份与背景字段用）。
     *
     * 数据来自 host 随 /state 下发的 `examples`：`{ 字段名: [文本, …] }`（见
     * lib/wording.mjs 的 FIELD_EXAMPLES）。空数组表示 host 刻意不给示例，
     * 这里据此不画按钮组 —— 画一个空的「示例」标签只会让人以为哪里有东西没加载出来。
     *
     * 与 wordingOptions 的差别在语义而不在实现：那边填的是定稿的档位文案，
     * 这边填的是**属于别人的示例**，界面上要提示用户改成自己的情况。
     */
    const exampleOptions = (state, field) => {
      const table = state?.examples?.[field]
      if (!Array.isArray(table)) return []
      // 示例在 host 侧是纯字符串数组（没有档位 id，也不需要），这里补一个稳定 key。
      return table.map((text, index) => ({ id: `example-${index}`, text }))
    }

    /** 默认的人设字段值 —— 新建表单、恢复默认、比较脏值都用它。 */
    const personaDefaults = () => ({
      agentName: '',
      agentRole: '',
      addressUserAs: '',
      userOccupation: '',
      userBio: '',
      // 风格类六项默认留空：空串在提示词里等于「不提这件事」，由人设自带的
      // 通用语气接管。写死一段默认文案会让「我没设过」变成「我设过这个」。
      style: '',
      headingLists: '',
      emoji: '',
      tables: '',
      replyLength: '',
      language: '',
      customInstructions: ''
    })

    // ── 光轨（对照某同类人设插件的 trail 四项）──────────────────────────────
    //
    // 参数与某同类人设插件保持一致，这样两者的观感不会出现「同一台机器上两套动效」；
    // 但实现完全自写：某同类人设插件用 8 层错位描边动画，这里同样画 8 层 —— 层数、
    // 虚线段长与步进是「看起来像光线在跑」的最小充分条件，不是可随意取的值。
    const TRAIL_DASH = 12
    const TRAIL_LAYERS = 8
    const TRAIL_LAYER_STEP = 2.2
    const TRAIL_RADIUS = 22
    const TRAIL_COLOR_FALLBACK = '#679EFE'
    const TRAIL_PRESET_COLORS = ['#679EFE', '#22C55E', '#EF4444', '#A855F7', '#06B6D4', '#F59E0B']
    const TRAIL_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/
    const TRAIL_SPEED_VALUES = ['slow', 'normal', 'fast']
    const TRAIL_WIDTH_VALUES = ['thin', 'normal', 'thick']
    // 对账档位。与宿主 lib/config.mjs 的 LEDGER_LEVELS 同集合 —— 客户端不能 import
    // 宿主模块（分成两个 bundle），所以这里必须手抄一份；抄错了宿主会按非法值静默
    // 回落默认档，界面却仍显示用户选的那一档。改这里时同步改宿主那份。
    const LEDGER_LEVELS = ['off', 'three', 'five']
    const TRAIL_PAD = 2
    // 尺寸自检上限：宿主尺寸异常（例如 observer 触发了自己）时宁可关掉光轨，
    // 也不要让它把输入框越撑越大。
    const TRAIL_MAX_SIDE = 20000

    /** 颜色兜底：非法值回退到内置色，合法值统一成大写。 */
    const safeTrailColor = (value) => {
      if (typeof value !== 'string' || !TRAIL_COLOR_PATTERN.test(value.trim())) return TRAIL_COLOR_FALLBACK
      return value.trim().toUpperCase()
    }

    /**
     * 从配置对象里摘出 12 个人设字段。
     *
     * v3 起全是自由文本，所以只剩「不是字符串就当空」这一条规则 —— 旧版这里对
     * 六个风格字段做枚举白名单回退（脏值退回 professional 之类），那是因为当时
     * 下拉框必须选中某一项。现在输入框里可以什么都没有，回退反而会凭空造出
     * 一段用户没写过的要求。
     */
    const pickPersona = (config) => {
      const out = personaDefaults()
      if (!config) return out
      for (const key of PERSONA_FIELDS) {
        out[key] = typeof config[key] === 'string' ? config[key] : ''
      }
      return out
    }

    /**
     * 摘出工作区覆盖文件里的字段。
     *
     * 与 pickPersona 的关键差别：**空值必须保持为空**。
     * 全局配置里「没填」等于默认值（例如 style 缺省 = professional）；
     * 但在工作区覆盖里「没填」等于**继承全局**，是第三种状态。
     * 若在这里回退默认，用户会看到下拉框凭空选中「专业严谨」，
     * 一保存就把全局风格顶掉了 —— 这正是覆盖语义最容易被误解的地方。
     * 因此枚举字段保留 ''，由渲染层给出「继承（当前：X）」这一项。
     */
    const pickOverrides = (overrides) => {
      const out = {}
      for (const key of PERSONA_FIELDS) {
        const value = overrides?.[key]
        out[key] = typeof value === 'string' ? value : ''
      }
      return out
    }

    const memoryDefaults = (config) => ({
      enabled: config?.memory?.enabled !== false,
      autoCapture: config?.memory?.autoCapture !== false,
      nightlyTriage: config?.memory?.nightlyTriage !== false,
      nightlyHour: config?.memory?.nightlyHour ?? 3,
      maxPending: config?.memory?.maxPending ?? 200,
      maxInjected: config?.memory?.maxInjected ?? 40,
      // 字符预算曾经只出现在表单里、没进载荷：输入框能打字、能显示，
      // 但 configPayload 不带这个键 ⇒ 脏检测也看不到它变化 ⇒ 保存按钮一直是灰的，
      // 用户以为自己设了，实际一个字节都没写盘。这类「看得见却存不下」的字段
      // 比没有这个字段更坏。三个地方必须同时有它：默认值、载荷、宿主 schema。
      maxInjectedChars: config?.memory?.maxInjectedChars ?? 4000,
      notifyOnSessionStart: config?.memory?.notifyOnSessionStart !== false,
      // 回扫：默认关（=== true 才开）。两个键必须同时在默认值、载荷、宿主 schema
      // 里出现，否则就是上面注释说的那种「看得见却存不下」。
      retrospectEnabled: config?.memory?.retrospectEnabled === true,
      retrospectDays: config?.memory?.retrospectDays ?? 14
    })

    /**
     * 工具确认门槛 + 光轨四项（对照某同类人设插件的 requireToolConfirmation / trail*）。
     *
     * 与 memoryDefaults 一样是「夹带在 config 里的子表单」：它们不参与工作区覆盖
     * （一个安全开关、一组界面偏好，都不该因为换个工作区而悄悄换掉），但必须走
     * 同一条保存载荷，否则设置页改了色值、宿主判「无变化」不落盘。
     */
    const toolDefaults = (config) => ({
      requireToolConfirmation: config?.requireToolConfirmation === true,
      trailEnabled: config?.trailEnabled !== false,
      trailColor: safeTrailColor(config?.trailColor),
      trailSpeed: TRAIL_SPEED_VALUES.includes(config?.trailSpeed) ? config.trailSpeed : 'slow',
      trailWidth: TRAIL_WIDTH_VALUES.includes(config?.trailWidth) ? config.trailWidth : 'thin'
    })

    /**
     * 质检层五项（开关 / 对账档位 / 严格判词 / 机制检查 / 每轮最多报几条）。
     *
     * 与 memoryDefaults、toolDefaults 同一类：夹带在 config 里的子表单，不参与工作区
     * 覆盖，但必须走同一条保存载荷 —— 少一个键就是「界面上能改、实际存不下」，
     * maxInjectedChars 已经因为这件事被修过一次。
     *
     * 这五项此前只能靠 `/anima set quality.xxx=…` 改。加界面不是为了好看：这个钩子
     * 是唯一会往对话里插消息的部件，而「它太吵了、我现在就想关」恰恰发生在会话进行
     * 中 —— 那一刻人不会去翻命令帮助。
     */
    const qualityDefaults = (config) => ({
      enabled: config?.quality?.enabled !== false,
      ledgerLevel: LEDGER_LEVELS.includes(config?.quality?.ledgerLevel) ? config.quality.ledgerLevel : 'three',
      strict: config?.quality?.strict !== false,
      preStepCheck: config?.quality?.preStepCheck !== false,
      maxFindingsInReminder: Number(config?.quality?.maxFindingsInReminder ?? 5)
    })

    // -------------------------------------------------------------------------
    // 轻量快照 store（某同类人设插件同款 —— 第三方插件不能用 client-runtime 的 store）
    // -------------------------------------------------------------------------

    const createSnapshotStore = (init) => {
      let state = init
      const listeners = new Set()
      const notify = () => { for (const fn of [...listeners]) fn() }
      return {
        getSnapshot: () => state,
        subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
        update: (mutator) => {
          const next = { ...state }
          mutator(next)
          state = next
          notify()
        }
      }
    }

    /**
     * 订阅者 hook：把 store 接到 React 上。
     *
     * 客户端 builtin 只声明了 createElement/useState/useEffect 三个 hook，
     * useSyncExternalStore 虽然实际存在但不在声明清单里 —— 因此这里做能力探测，
     * 缺失时退回 useState + useEffect 的订阅写法，避免整个设置页装载即崩。
     */
    const makeUseStore = (store) => (selector) => {
      const read = () => (typeof selector === 'function' ? selector(store.getSnapshot()) : store.getSnapshot())

      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(store.subscribe, read, read)
      }

      const [value, setValue] = React.useState(read)
      React.useEffect(() => {
        let alive = true
        const sync = () => { if (alive) setValue(read()) }
        sync()
        const unsubscribe = store.subscribe(sync)
        return () => { alive = false; unsubscribe() }
      }, [store, selector])
      return value
    }

    function hostBase() {
      const origin = globalThis.location?.origin
      return origin && origin !== 'null' ? origin : 'http://127.0.0.1'
    }

    function messageOf(error) {
      if (!error) return '未知错误'
      if (error.name === 'AbortError') return `请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒）`
      return String(error.message || error)
    }

    // -------------------------------------------------------------------------
    // 控制器：所有后端往返都集中在这里
    // -------------------------------------------------------------------------

    class AnimaController {
      constructor(fetcher = (input, init) => fetch(input, init)) {
        this.fetcher = fetcher
        this.store = createSnapshotStore(INITIAL)
        this.disposed = false
        this.useStore = makeUseStore(this.store)
      }

      async request(path, { method = 'GET', body } = {}) {
        const url = new URL(path, hostBase())
        const init = { method }
        if (body !== undefined && body !== null) {
          init.headers = { 'content-type': 'application/json' }
          init.body = JSON.stringify(body)
        }
        // 超时保护：宿主未就绪或路由未挂上时，fetch 可能长时间挂起。
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        init.signal = controller.signal
        try {
          const response = await this.fetcher(url, init)
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload.ok !== true) {
            throw new Error(payload.error || `HTTP ${response.status}`)
          }
          return payload
        } finally {
          clearTimeout(timer)
        }
      }

      applyState(payload) {
        this.store.update((s) => {
          if (payload.config) s.config = payload.config
          if (payload.source) s.source = payload.source
          if (payload.limits) s.limits = payload.limits
          // 用「是对象就整体替换」而不是合并：host 侧改了文案表就得整片换掉，
          // 半新半旧会出现两个按钮填出同一段旧话。空对象是合法值（尚未下发）。
          if (payload.wording && typeof payload.wording === 'object') s.wording = payload.wording
          if (payload.examples && typeof payload.examples === 'object') s.examples = payload.examples
          if (Array.isArray(payload.presets)) s.presets = payload.presets
          // 用 in 判定：预设脱离时要能把它清回 null，否则徽标会挂在不存在的预设上。
          if ('activeId' in payload) s.activePresetId = payload.activeId ?? null
          if (typeof payload.builtinPresetCount === 'number') s.builtinPresetCount = payload.builtinPresetCount
          // 提议可能从有到无（用户确认/拒绝后），故用 in 判定而不是真值判定，
          // 否则「刚才还挂着一条」会一直留在界面上。
          if ('pendingProposal' in payload) s.pendingProposal = payload.pendingProposal ?? null
          if (payload.memories) s.memories = payload.memories
          // 导入面板要用的提示词与两个上限，随 state 下发（常量，不随配置走）。
          // 这里刻意**无条件覆盖**（与上面几处用 in 判定的字段不同）：缺字段时置空，
          // 入口整个消失。若用 in 判定，一次缺字段的响应就会把上一次的提示词永远留
          // 在界面上 —— 入口看着还在，点下去却打不到路由。
          s.memoryImport = payload.memoryImport ?? null
          // 这三样可能在同一次响应里从有到无（比如把记忆层关掉后 decisions 变空），
          // 所以用 in 判定而不是真值判定，否则界面会一直停在上一版的解释。
          if (payload.injection) s.injection = payload.injection
          if (Array.isArray(payload.clusters)) s.clusters = payload.clusters
          if (Array.isArray(payload.conflicts)) s.conflicts = payload.conflicts
          if ('triageMeta' in payload) s.triageMeta = payload.triageMeta
          // 巡夜记录也用 in 判定：它整体消失时界面必须回到「没跑过」，
          // 而不是继续挂着上一次的「跑过了，没事」——那正是这个项目一直在防的形状。
          if ('patrolMeta' in payload) s.patrolMeta = payload.patrolMeta ?? null
          if ('retrospectMeta' in payload) s.retrospectMeta = payload.retrospectMeta ?? null
          // 同上，用 in 判定：宿主重启后这个对象整体消失，若用真值判定会把上一轮的
          // 计数一直挂在界面上 —— 那正好是「显示着检查过，其实这轮没检查」。
          if ('qualityStats' in payload) s.qualityStats = payload.qualityStats ?? null
          if (payload.workspaces) s.workspaces = payload.workspaces
          // 审计随 state 一起来：客户端首次 RPC 通道未就绪时可能长时间挂起，
          // 少一次往返就少一个失败面。展开看全量时才单独打 /audit。
          if (payload.audit) s.audit = payload.audit
        })
      }

      /** 拉全量审计（设置页展开这块时调用）。 */
      async loadAudit() {
        if (this.disposed) return
        this.store.update((s) => { s.auditLoading = true; s.auditError = null })
        try {
          const payload = await this.request('/api/anima/audit')
          this.store.update((s) => {
            s.auditLoading = false
            s.audit = {
              entries: Array.isArray(payload.entries) ? payload.entries : [],
              total: typeof payload.total === 'number' ? payload.total : 0,
              max: typeof payload.max === 'number' ? payload.max : 200,
              sourceText: payload.sourceText ?? s.audit.sourceText ?? {},
              actors: Array.isArray(payload.actors) ? payload.actors : (s.audit.actors ?? [])
            }
          })
        } catch (error) {
          if (this.disposed) return
          this.store.update((s) => { s.auditLoading = false; s.auditError = messageOf(error) })
        }
      }

      /** 清空审计日志（不可撤销，调用前由界面拦一次）。 */
      async clearAudit() {
        try {
          const payload = await this.request('/api/anima/audit', { method: 'DELETE' })
          await this.loadAudit()
          return payload
        } catch (error) {
          if (this.disposed) return { ok: false, error: messageOf(error) }
          this.store.update((s) => { s.auditError = messageOf(error) })
          return { ok: false, error: messageOf(error) }
        }
      }

      async loadState() {
        if (this.disposed) return
        this.store.update((s) => { s.loading = true; s.error = null })
        try {
          const payload = await this.request('/api/anima/state')
          this.store.update((s) => { s.loading = false })
          this.applyState(payload)
        } catch (error) {
          if (this.disposed) return
          this.store.update((s) => { s.loading = false; s.error = messageOf(error) })
        }
      }

      async saveConfig(patch) {
        this.store.update((s) => { s.saving = true; s.error = null })
        try {
          const payload = await this.request('/api/anima/config', { method: 'POST', body: patch })
          this.store.update((s) => {
            s.saving = false
            s.lastChanged = Array.isArray(payload.changed) ? payload.changed : []
          })
          this.applyState(payload)
          await this.loadState()
          return payload
        } catch (error) {
          this.store.update((s) => { s.saving = false; s.error = messageOf(error) })
          return { ok: false, error: messageOf(error) }
        }
      }

      async resetConfig() {
        this.store.update((s) => { s.saving = true; s.error = null })
        try {
          // 宿主侧这条路由要求显式确认（fail closed）：空 body 一律 400。
          // 见 index.mjs `/config/reset` 的注释 —— 2026-10-10 的事故就是这么来的。
          const payload = await this.request('/api/anima/config/reset', { method: 'POST', body: { confirm: true } })
          this.store.update((s) => { s.saving = false; s.lastChanged = ['<reset>'] })
          await this.loadState()
          return payload
        } catch (error) {
          this.store.update((s) => { s.saving = false; s.error = messageOf(error) })
          return { ok: false, error: messageOf(error) }
        }
      }

      /**
       * 确认 / 拒绝一份「模型提出的人设变更」。
       *
       * 这条路径存在的前提是宿主开启了工具确认（requireToolConfirmation）：
       * 模型调 set_assistant_persona 时宿主只落一份提议，不写配置。提议是
       * 进程内状态，重启即失效 —— 所以「找不到提议」是正常回执，不是异常。
       */
      async decideProposal(action) {
        this.store.update((s) => { s.saving = true; s.error = null })
        try {
          const payload = await this.request('/api/anima/proposal', { method: 'POST', body: { action } })
          this.store.update((s) => {
            s.saving = false
            s.lastChanged = Array.isArray(payload.changed) ? payload.changed : []
          })
          await this.loadState()
          return payload
        } catch (error) {
          this.store.update((s) => { s.saving = false; s.error = messageOf(error) })
          return { ok: false, error: messageOf(error) }
        }
      }

      async loadWorkspace(path) {
        this.store.update((s) => { s.workspacePath = path; s.workspaceError = null; s.workspaceState = null })
        if (!path) return
        try {
          const payload = await this.request(`/api/anima/workspace?workspacePath=${encodeURIComponent(path)}`)
          this.store.update((s) => { s.workspaceState = payload })
        } catch (error) {
          this.store.update((s) => { s.workspaceError = messageOf(error) })
        }
      }

      async saveWorkspace(path, overrides) {
        this.store.update((s) => { s.workspaceSaving = true; s.workspaceError = null })
        try {
          const payload = await this.request('/api/anima/workspace', {
            method: 'POST',
            body: { workspacePath: path, overrides }
          })
          this.store.update((s) => { s.workspaceSaving = false; s.workspaceState = payload })
          await this.loadState()
          return payload
        } catch (error) {
          this.store.update((s) => { s.workspaceSaving = false; s.workspaceError = messageOf(error) })
          return { ok: false, error: messageOf(error) }
        }
      }

      async decide(id, decision) {
        try {
          await this.request('/api/anima/memory/decide', { method: 'POST', body: { id, decision } })
          await this.loadState()
          return { ok: true }
        } catch (error) {
          return { ok: false, error: messageOf(error) }
        }
      }

      async removeMemory(id) {
        try {
          await this.request('/api/anima/memory/delete', { method: 'POST', body: { id } })
          await this.loadState()
          return { ok: true }
        } catch (error) {
          return { ok: false, error: messageOf(error) }
        }
      }

      async runTriage() {
        try {
          const payload = await this.request('/api/anima/memory/triage', { method: 'POST', body: {} })
          await this.loadState()
          return payload
        } catch (error) {
          return { ok: false, error: messageOf(error) }
        }
      }

      /**
       * 手动跑一次巡夜（整理 + 体检 + 判定要不要汇报）。
       *
       * 与定时那次走同一条判据：如果手动能绕过「指纹没变就不说」，用户就永远
       * 测不到定时触发的真实行为 —— 手点一次和它自己跑一次给出不同答案的机制，
       * 等于没法验证。
       */
      async runPatrol() {
        try {
          const payload = await this.request('/api/anima/patrol', { method: 'POST', body: {} })
          await this.loadState()
          return payload
        } catch (error) {
          return { ok: false, error: messageOf(error) }
        }
      }

      /**
       * 手动跑一次回扫式复盘。
       *
       * 与巡夜同样的理由走同一条判据：手动若能绕过「已报过的键不再报」，
       * 那就永远测不出这一轮到底是不是真新的。
       */
      async runRetrospect() {
        try {
          const payload = await this.request('/api/anima/retrospect', { method: 'POST', body: {} })
          await this.loadState()
          return payload
        } catch (error) {
          return { ok: false, error: messageOf(error) }
        }
      }

      async addMemory(text, note, scope) {
        try {
          await this.request('/api/anima/memory/add', { method: 'POST', body: { text, note, scope } })
          await this.loadState()
          return { ok: true }
        } catch (error) {
          return { ok: false, error: messageOf(error) }
        }
      }

      /**
       * 记忆体检：只读，不改任何东西。
       *
       * 刻意不叫 runAudit —— 已有的 audit 是「人设变更审计日志」，两者同名会让下一个人
       * 以为体检会往审计日志里写东西。它什么也不写，只把机器能验的那两件事查一遍。
       */
      async runCheckup() {
        try {
          const payload = await this.request('/api/anima/memory/audit', { method: 'POST', body: {} })
          return { ok: true, ...payload }
        } catch (error) {
          return { ok: false, error: messageOf(error) }
        }
      }

      /**
       * 改一条记忆的元数据（类型 / 状态 / 复核点 / 出处）。
       *
       * 与 decide 分开的理由和宿主侧一致：decide 是「要不要留下」的裁决，改元数据
       * 是在已留下的条目上做整理。混成一个接口，将来误传参数会顺手改掉裁决状态。
       * 成功后必须 loadState：徽章读的是 state 快照，不重拉就还在画旧值。
       */
      async updateMemoryMeta(id, patch) {
        try {
          const payload = await this.request('/api/anima/memory/meta', { method: 'POST', body: { id, ...patch } })
          await this.loadState()
          return { ok: true, ...payload }
        } catch (error) {
          return { ok: false, error: messageOf(error) }
        }
      }

      /**
       * 导入第一步：只解析，不写盘。
       *
       * cwd 走查询参数（与 /state 同一口径）：归类建议里的「本工作区」需要这个坐标。
       * 不带 cwd 也能用，只是所有条目都会建议成全局 —— 这不是错误，是缺信息时的合理降级。
       */
      async parseImport(text, cwd) {
        const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
        try {
          const payload = await this.request(`/api/anima/memory/import/parse${query}`, {
            method: 'POST',
            body: { text }
          })
          return { ok: true, ...payload }
        } catch (error) {
          return { ok: false, error: messageOf(error) }
        }
      }

      /** 导入第二步：把用户在预览里确认过（可能改过 layer）的那批写进缓冲区。 */
      async commitImport(items) {
        try {
          const payload = await this.request('/api/anima/memory/import/commit', {
            method: 'POST',
            body: { items }
          })
          await this.loadState()
          return { ok: true, ...payload }
        } catch (error) {
          return { ok: false, error: messageOf(error) }
        }
      }

      /**
       * 拉取提示词预览。
       *
       * 这里刻意**不**依赖已保存的配置：调用方把当前表单值作为 query 传给 host，
       * 因此用户边打字边看预览，不需要先保存。预览失败不打断页面（只记 error）。
       */
      async loadPreview(workspacePath, persona) {
        this.store.update((s) => { s.previewLoading = true; s.previewError = null })
        const params = new URLSearchParams()
        if (workspacePath) params.set('workspacePath', workspacePath)
        for (const key of PERSONA_FIELDS) {
          const value = persona?.[key]
          if (typeof value === 'string' && value) params.set(key, value)
        }
        const query = params.toString()
        try {
          const payload = await this.request(`/api/anima/preview${query ? `?${query}` : ''}`)
          this.store.update((s) => { s.previewLoading = false; s.preview = payload })
          return payload
        } catch (error) {
          this.store.update((s) => { s.previewLoading = false; s.previewError = messageOf(error) })
          return { ok: false, error: messageOf(error) }
        }
      }

      async applyPreset(idOrName) {
        this.store.update((s) => { s.presetBusy = true; s.error = null })
        try {
          const payload = await this.request('/api/anima/presets/apply', {
            method: 'POST',
            body: { id: idOrName }
          })
          this.store.update((s) => { s.presetBusy = false; s.lastChanged = payload.changed ?? [] })
          await this.loadState()
          return payload
        } catch (error) {
          this.store.update((s) => { s.presetBusy = false })
          return { ok: false, error: messageOf(error) }
        }
      }

      async savePreset(preset) {
        this.store.update((s) => { s.presetBusy = true; s.error = null })
        try {
          const payload = await this.request('/api/anima/presets/save', {
            method: 'POST',
            body: { preset }
          })
          this.store.update((s) => { s.presetBusy = false })
          await this.loadState()
          return payload
        } catch (error) {
          this.store.update((s) => { s.presetBusy = false })
          return { ok: false, error: messageOf(error) }
        }
      }

      async deletePreset(id) {
        this.store.update((s) => { s.presetBusy = true; s.error = null })
        try {
          const payload = await this.request('/api/anima/presets/delete', {
            method: 'POST',
            body: { id }
          })
          this.store.update((s) => { s.presetBusy = false })
          await this.loadState()
          return payload
        } catch (error) {
          this.store.update((s) => { s.presetBusy = false })
          return { ok: false, error: messageOf(error) }
        }
      }

      dispose() {
        this.disposed = true
      }
    }

    // -------------------------------------------------------------------------
    // 样式
    // -------------------------------------------------------------------------

    const css = [
      // 底部留 72px：保存栏是 sticky bottom（约 52px 高），不留够它就会压住最后一行内容。
      // 用户录屏里「还有 N 条」和保存栏文案叠在一行，就是这个原因 —— 底部空间不够。
      '.an-root{display:flex;flex-direction:column;gap:16px;padding:4px 0 72px}',
      // ── 分区导航 ──
      // 吸附在页面顶部：设置页本身就是一个可滚动的长面板，翻到第三张卡时还看得见
      // 分区在哪一排，才谈得上「随时能切」。背景取页面底色而不是卡片色，避免与
      // 下面的卡片混成一片。
      '.an-sectnav{display:flex;flex-wrap:wrap;gap:2px;padding:3px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);position:sticky;top:0;z-index:20}',
      '.an-sectnav-tab{padding:5px 14px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}',
      '.an-sectnav-tab:hover{color:var(--dsw-alias-label-primary)}',
      // 选中态必须一眼看得见。原来用 --dsw-alias-bg-base 当背景，那是**页面自身底色**，
      // 垫在同一块的 layer-1 上等于没变（用户录屏里五个标签一个都看不出被选中）。
      // 现在改成「更亮的表面 + 品牌色下划线 + 加粗」三重，深浅色主题下都成立。
      '.an-sectnav-tab-on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:inset 0 -2px 0 var(--dsw-alias-brand-primary)}',
      // ── 底部保存栏 ──
      // 卡片里原来散着六处「保存」，每张卡各自一份、四条走的是同一个 doSave。
      // 收成一条固定栏之后，「现在有改动没保存」这件事只有一个说法。
      // 吸附在底部并压暗上缘：它盖住内容时仍看得出下面还有东西。
      '.an-savebar{position:sticky;bottom:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:4px;padding:10px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1));box-shadow:0 -6px 16px -12px rgba(0,0,0,.28)}',
      '.an-savebar-text{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.an-savebar-text-dirty{color:var(--dsw-alias-label-warning,#d48806)}',
      '.an-card{padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.an-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}',
      '.an-card-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}',
      '.an-card-desc{margin:4px 0 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
      '.an-field{margin-bottom:14px}',
      '.an-field:last-child{margin-bottom:0}',
      '.an-field > label{display:block;margin-bottom:6px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '.an-field .an-hintline{margin-top:4px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.an-input,.an-textarea,.an-select{width:100%;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;box-sizing:border-box;font-family:inherit}',
      '.an-textarea{min-height:88px;resize:vertical}',
      '.an-input:focus,.an-textarea:focus,.an-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 25%, transparent)}',
      '.an-select option{color:var(--dsw-alias-label-primary)}',
      // 「一键填入」按钮组 —— 旧版这里是下拉框，档位改成一段现成的说法之后，
      // 用一排小按钮比下拉更容易发现「原来还可以填这个」。
      '.an-fill{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px}',
      '.an-fill-label{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin-right:2px}',
      '.an-chip{padding:2px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;font-family:inherit;cursor:pointer;white-space:nowrap}',
      '.an-chip:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.an-root{color-scheme:light}',
      'body[data-ds-dark-theme] .an-root{color-scheme:dark}',
      '.an-row{display:flex;align-items:center;gap:8px}',
      '.an-row-between{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.an-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.an-btn{padding:6px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit;cursor:pointer;white-space:nowrap}',
      '.an-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}',
      '.an-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.an-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:500}',
      '.an-btn-sm{padding:3px 10px;font-size:12px}',
      '.an-btn-danger{color:var(--dsw-alias-label-error)}',
      '.an-btn-danger:hover:not(:disabled){border-color:var(--dsw-alias-label-error)}',
      '.an-toggle-row{display:flex;align-items:center;gap:10px}',
      '.an-toggle-row input[type=checkbox]{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;flex:0 0 auto}',
      '.an-toggle-row label{font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.an-badge{align-self:flex-start;font-size:11px;line-height:16px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.an-badge-ok{color:var(--dsw-static-green-500,#22c55e);border-color:color-mix(in srgb, var(--dsw-static-green-500,#22c55e) 45%, transparent)}',
      '.an-badge-src{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent)}',
      '.an-list{display:flex;flex-direction:column;gap:0;margin-top:8px}',
      '.an-item{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l2);font-size:12px}',
      '.an-item:first-child{border-top:0}',
      '.an-item-main{flex:1;min-width:0}',
      '.an-item-text{color:var(--dsw-alias-label-primary);line-height:1.6;word-break:break-word}',
      '.an-item-meta{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-tertiary);display:flex;gap:8px;flex-wrap:wrap}',
      '.an-item-actions{display:flex;gap:6px;flex:0 0 auto;align-items:center}',
      '.an-empty{padding:14px 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.an-error{margin-top:8px;padding:8px 12px;border:1px solid var(--dsw-alias-label-error);border-radius:6px;color:var(--dsw-alias-label-error);font-size:12px;box-sizing:border-box}',
      '.an-note{margin-top:8px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}',
      // ── 导入外部记忆（Phase ②）──
      // 面板刻意做成卡片内联展开而不是浮层弹窗：设置页本身已经在宿主设置面板里，
      // 再叠一层浮层会出现两个遮罩、两层 Esc 语义，而且浮层在窄面板里不好用。
      '.an-import{margin-top:10px;padding:12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.an-import-step{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}',
      '.an-import-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.an-import-prompt{margin:0 0 12px 0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base,rgba(127,127,127,.06));color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;font-family:inherit}',
      '.an-import-divider{margin:14px 0;border:0;border-top:1px solid var(--dsw-alias-border-l2)}',
      // 切出来的条目：一行一条，行内可改层级。改层级用两个小按钮而不是下拉 ——
      // 只有两种取值，下拉要多一次点击才能看到「原来还能选」。
      '.an-import-item{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l2);font-size:12px}',
      '.an-import-item:first-child{border-top:0}',
      '.an-import-item-text{flex:1;min-width:0;color:var(--dsw-alias-label-primary);line-height:1.6;word-break:break-word}',
      '.an-import-item-actions{display:flex;gap:6px;flex:0 0 auto;align-items:center}',
      '.an-import-summary{margin-top:8px;font-size:11px;line-height:1.7;color:var(--dsw-alias-label-tertiary)}',
      '.an-import-blocked{margin-top:8px;padding:8px 12px;border:1px solid var(--dsw-alias-label-error);border-radius:6px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-error)}',
      '.an-import-blocked code{font-size:11px;word-break:break-all}',
      '.an-pre{margin:8px 0 0 0;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto;font-family:Consolas,Menlo,monospace}',
      '.an-toast{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);padding:8px 16px;border-radius:6px;font-size:13px;font-weight:500;z-index:10000;box-shadow:0 2px 8px rgba(0,0,0,.15);pointer-events:none;white-space:nowrap}',
      '.an-toast-ok{background:#f6ffed;border:1px solid #b7eb8f;color:#52c41a}',
      '.an-toast-err{background:#fff1f0;border:1px solid #ffa39e;color:#f5222d}',
      '.an-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px;margin-top:10px}',
      '.an-kv dt{color:var(--dsw-alias-label-tertiary)}',
      '.an-kv dd{margin:0;color:var(--dsw-alias-label-primary);word-break:break-all}',
      // ── 变更记录 ──
      // 每个字段一行；值可能很长（自定义指令、角色描述），所以给值留出换行空间
      // 而不是让整行被撑出卡片。
      //
      // 字段名这里刻意用正文字体，不用等宽 —— 等宽是它当初显示 `memory.maxInjected`
      // 这类代码键名时留下的。现在显示的是「每次带几条记忆」，等宽反而像代码。
      '.an-audit-changes{margin-top:6px;display:flex;flex-direction:column;gap:4px}',
      '.an-audit-change{display:flex;gap:8px;font-size:11px;line-height:1.6;align-items:baseline}',
      '.an-audit-key{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}',
      '.an-audit-arrow{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);word-break:break-word}',
      '.an-audit-from{text-decoration:line-through;text-decoration-color:color-mix(in srgb, currentColor 50%, transparent)}',
      '.an-audit-to{color:var(--dsw-alias-label-primary)}',
      // ── 「最近改了什么」（下拉式） ──
      // 外形对齐下拉菜单而不是卡片：收起时只占**一行**（标题 + 条数 + 箭头），
      // 展开才铺开明细。原先是常驻 3 条预览，用户反馈「太大占位置」——
      // 那条预览每行都带「原值 → 新值」，一屏就被它吃掉三分之一。
      '.an-recent{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.an-recent-toggle{display:flex;align-items:center;gap:8px;width:100%;padding:7px 12px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}',
      '.an-recent-toggle:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)}',
      '.an-recent-caret{flex:0 0 auto;width:10px;font-size:9px;line-height:1;color:var(--dsw-alias-label-tertiary);transition:transform .12s ease}',
      '[data-an-recent="open"] .an-recent-caret{transform:rotate(90deg)}',
      '.an-recent-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.an-recent-body{display:flex;flex-direction:column;gap:4px;padding:2px 12px 10px}',

      // ── 光轨 ──
      '.an-trail-svg{position:absolute;display:none;pointer-events:none;contain:strict;overflow:hidden;margin:0;padding:0;border:0;transform:none;animation:none;max-width:none;max-height:none}',
      '.an-trail-svg .an-trail-layer{stroke:var(--an-trail-color,#679EFE);stroke-linecap:round;animation:an-trail-run linear infinite}',
      '[data-an-trail-speed="slow"] .an-trail-svg .an-trail-layer{animation-duration:4.8s}',
      '[data-an-trail-speed="normal"] .an-trail-svg .an-trail-layer{animation-duration:3.6s}',
      '[data-an-trail-speed="fast"] .an-trail-svg .an-trail-layer{animation-duration:2.4s}',
      '[data-an-trail-width="thin"] .an-trail-svg .an-trail-layer{stroke-width:1.5}',
      '[data-an-trail-width="normal"] .an-trail-svg .an-trail-layer{stroke-width:2.5}',
      '[data-an-trail-width="thick"] .an-trail-svg .an-trail-layer{stroke-width:4}',
      '[data-an-trail="off"] .an-trail-svg{display:none}',
      // 光轨运行时把输入框自己的描边让出去，否则两层边框会叠成毛边
      '[data-composer-card][data-an-trail="on"]{--dsw-elevation-stroke-color:transparent}',
      '@keyframes an-trail-run{from{stroke-dashoffset:0}to{stroke-dashoffset:-100}}',
      '@media (prefers-reduced-motion:reduce){.an-trail-svg .an-trail-layer{animation:none}}',
      // ── 光轨配色预览 ──
      // 刻意不用 flex 居中：absolute 的静态位置在 flex 容器里会落到正中间，
      // 光轨画出来就与边框错位。这里让宿主保持 block，标签自己绝对定位居中。
      '.an-trail-preview{position:relative;height:52px;margin-top:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.an-trail-preview[data-an-trail="on"]{border-color:transparent}',
      '.an-trail-preview-label{position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);text-align:center;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      // 关掉总开关时预览保留静态圆环：配色仍然看得见，但因为不动了，不会让人误以为还开着。
      '.an-trail-preview[data-an-trail-static="on"] .an-trail-layer{animation:none}',
      '.an-input-color{flex:0 0 auto;width:38px;height:28px;padding:1px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;cursor:pointer}',
      // ── 卡片折叠 ──
      '.an-card-aside{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}',
      '.an-card-toggle{flex:0 0 auto;padding:2px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:18px;cursor:pointer}',
      '.an-card-toggle:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}',
      // ── 预览卡附注 ──
      '.an-charcount{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.an-invalid{margin-top:6px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-warning,#d48806);word-break:break-all}',
      // ── 输入框快捷开关 ──
      '.an-quick-toggle{position:relative;isolation:isolate;display:inline-flex;align-items:center;gap:6px;min-height:28px;overflow:hidden;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}',
      '.an-quick-toggle[data-enabled="true"]{color:var(--dsw-alias-brand-primary)}',
      '.an-quick-toggle:disabled{cursor:wait;opacity:.6}',
      '.an-quick-toggle-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-label-tertiary)}',
      '.an-quick-toggle[data-enabled="true"] .an-quick-toggle-dot{background:var(--an-toggle-on,#22c55e);animation:an-status-pulse 1.8s ease-in-out infinite}',
      '@keyframes an-status-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
      '@media (prefers-reduced-motion:reduce){.an-quick-toggle[data-enabled="true"] .an-quick-toggle-dot{animation:none}}',
      // ── 设置页导航图标（DOM 替换后由我们接管的那一格）──
      '[data-an-settings-nav] [data-an-icon-replaced]{display:block;flex:0 0 auto}',
      // ── 待确认提议条 ──
      '.an-proposal{margin-top:10px;padding:10px 12px;border:1px solid var(--dsw-alias-label-warning,#d48806);border-radius:6px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:1.6}',
      '.an-proposal-title{font-weight:600;color:var(--dsw-alias-label-warning,#d48806)}',
      '.an-proposal-detail{margin-top:6px;font-family:Consolas,Menlo,monospace;color:var(--dsw-alias-label-secondary);word-break:break-all}',
      // ── 版式工具类 ──
      // 这些值是「排版常量」，不随状态变化，所以按 ocr 的 ts_js_tsx_jsx.md
      // 「Inline Styles: Avoid using inline `style` attributes, except for dynamic styles」
      // 搬成类；真正动态的那一处（会话色块的 background 取自变量）仍留 inline。
      // 命名沿用已有的 an- 前缀 + 语义缩写，避免按数值起名后就无法再改数值。
      '.an-mt4{margin-top:4px}',
      '.an-mt6{margin-top:6px}',
      '.an-mt8{margin-top:8px}',
      '.an-mt10{margin-top:10px}',
      '.an-mt12{margin-top:12px}',
      '.an-mt14{margin-top:14px}',
      '.an-mt16{margin-top:16px}',
      '.an-mt20{margin-top:20px}',
      '.an-mr12{margin-right:12px}',
      '.an-minw0{min-width:0}',
      '.an-gap16{display:flex;gap:16px}',
      '.an-gap16wrap{display:flex;flex-wrap:wrap;gap:16px}',
      '.an-gap12wrap{display:flex;flex-wrap:wrap;gap:12px}',
      '.an-rowcenter{display:flex;gap:8px;align-items:center}',
      '.an-rowend{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}',
      '.an-rowgap8mt10{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}',
      '.an-badgewrap{display:flex;gap:6px;flex-wrap:wrap}',
      '.an-wrap{display:flex;flex-wrap:wrap}',
      // 响应式两列/三列：flex-basis 固定，窄屏时自然折行，不需要媒体查询。
      '.an-flex240{flex:1 1 240px}',
      '.an-flex240an{flex:1 1 240px;min-width:0}',
      '.an-flex200{flex:1 1 200px}',
      '.an-flex140{flex:1 1 140px}',
      '.an-flex260{flex:2 1 260px}',
      '.an-flexfill{flex:1 1 0}',
      '.an-page-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.an-list-indent{margin:4px 0 0;padding-left:18px}'
    ].join('')

    // -------------------------------------------------------------------------
    // 词典
    // -------------------------------------------------------------------------

    const zh = {
      'nav.label': '灵台',
      'page.title': '灵台',
      'page.desc': '这里管三件事：AI 叫什么、只对这个项目生效的设置、以及它会记住什么。',

      'identity.title': '助手身份',
      'identity.desc': '描述 AI 自己是谁。与下面「用户背景」方向相反 —— 那段描述你，这段描述它。',
      'identity.name': 'AI 的名字',
      'identity.nameHint': '这是 AI 给自己的名字，不是你对它的称呼（那个在下一张卡里）。留空就不告诉它自己叫什么。',
      // 不给示例按钮，就在这里说清楚格式 —— 见 lib/wording.mjs 的 FIELD_EXAMPLES
      // 注释：名字被一键填进来太容易被原样留下，然后长期叫错。
      'identity.namePlaceholder': '例如「小林」「阿哲」——两三个字，别用职位或昵称',
      'identity.role': '角色设定',
      'identity.roleHint': '例如「资深架构师，先给结论再解释权衡」。上限 800 字。',
      'identity.enabled': '把助手身份告诉 AI',
      'identity.enabledHint': '关闭后，这段描述不再发给 AI —— 它也就不知道自己是谁。',

      'user.title': '用户背景',
      'user.desc': '描述你本人。独立成段是为了不与上面的「助手身份」混读 —— 两段语义方向相反。',
      'user.address': '对用户的称呼',
      'user.addressHint': '留空则不写称呼。',
      'user.occupation': '你的职业',
      'user.bio': '关于你',
      'user.bioHint': '身份、技术背景、当前在做的事。上限 500 字。',

      'style.title': '回复风格与特质',
      'style.desc': '这几项决定「怎么说」，与回答内容无关。填的就是要交给模型的原话，留空则表示不作要求。',
      'style.style': '回复风格',
      'style.headingLists': '标题和列表',
      'style.emoji': '表情符号',
      'style.tables': '表格',
      'style.replyLength': '回复长度',
      'style.language': '回复语言',
      'style.styleHint': '一句话说清你想要什么语气。',
      'style.fill': '一键填入',
      'style.fillHint': '点一下把这段说法填进输入框，之后可以随意改。',
      'style.custom': '补充指令',
      'style.customHint': '额外的行为准则。上限 2000 字。',
      // 示例按钮组：身份与背景字段专用。与「一键填入」的区别写在按钮文案里 ——
      // 风格档位点一下就是定稿，示例点一下还得改成自己的情况。
      'example.label': '示例（点一下填进去，改成你自己的）',

      'wording.professional': '专业严谨',
      'wording.casual': '轻松自然',
      'wording.humorous': '幽默风趣',
      'wording.roast': '毒舌吐槽',
      'wording.efficient': '高效干练',
      'wording.more': '增强',
      'wording.less': '减弱',
      'wording.concise': '简洁',
      'wording.normal': '适中',
      'wording.detailed': '详尽',
      'wording.zh': '简体中文',
      'wording.en': 'English',

      'preset.title': '人设预设',
      'preset.desc': '预设是一套现成的人设。套用时只换预设里写到的项，其余保持你现在填的。',
      'preset.pick': '套用预设',
      'preset.apply': '套用',
      'preset.applied': '已套用预设',
      'preset.saved': '预设已保存',
      'preset.deleted': '预设已删除',
      'preset.saveTitle': '把当前设置存为预设',
      'preset.name': '预设名',
      'preset.namePlaceholder': '例如「午夜的毒舌」',
      'preset.descField': '说明（可选）',
      'preset.descPlaceholder': '例如「写代码时用，先给结论再解释权衡」',
      'preset.save': '保存为预设',
      'preset.delete': '删除',
      'preset.builtinTag': '内置',
      'preset.customTag': '自建',
      'preset.builtinHint': '内置预设不可删除；与自建重名时内置优先。',
      'preset.saveHint': '保存的是当前**已保存**的设置。请先点上面的「保存」。',
      'preset.activeTag': '当前生效',
      // 说明为什么「改一个字就掉徽标」：预设是一次性套用的，插件不记「你点过哪个」，
      // 而是拿预设声明的字段跟当前值逐个对；改掉其中任何一个，这条预设就不再是现状了。
      'preset.activeHint': '按字段比对得出：预设声明的每个字段都与当前值一致才算「当前生效」。改动其中任何一项，它就会消失 —— 这表示你的设置已经不再等于那条预设。',

      'source.label': '存储位置',
      'source.domain': 'DSH 存储域（storageDomain）',
      'source.none': '尚未打开',
      'source.path': '路径',
      'source.reason': '不可用原因',
      'source.message': '详细信息',
      'source.reason.storage-not-composed': '这份 profile 没有组合存储栈。插件本身照常装载，但读不到你保存的人设与记忆。补上 storage / storage-json / storage-domain 三行即可。',
      'source.reason.vocabulary-unavailable': '存储域词汇表（@deepseek-ai/dsh-storage-domain / zod）无法解析。',
      'source.reason.open-failed': '打开存储域失败：',
      // 「存储格式」一行：让用户看得见插件到底在往哪种介质里读写。
      //
      // 措辞刻意**不写「本版 vN」**：页面顶部那个徽标是插件版本（v1.0.0 这种 semver），
      // 与介质上的格式戳（个位数）完全是两套编号。两个都叫「本版 vN」时，用户没法判断
      // 哪个数字在说他装的插件旧。格式戳一律带「格式」二字，插件版本一律带小数点。
      'source.format': '存储格式',
      'source.formatText': '格式 v{n}（介质上的格式戳；与插件版本是两套编号）',

      'ws.title': '工作区覆盖',
      'ws.desc': '只有你填了字的那几项会被替换，留空就用全局设置。这些设置存在项目目录里的一个文件，可以跟项目一起提交。',
      'ws.pick': '选择工作区',
      'ws.none': '（未选择）',
      'ws.empty': '尚未登记任何工作区。',
      'ws.enabled': '允许这个项目用单独的设置',
      'ws.dir': '设置存放的文件夹名',
      'ws.dirHint': '放在项目根目录下的一个文件夹名，默认 .dsh-anima。',
      'ws.filePath': '设置文件',
      'ws.exists': '这个项目已经有设置文件',
      'ws.notExists': '这个项目还没有设置文件',
      'ws.save': '保存本项目的设置',
      'ws.clear': '清除本项目的设置',
      'ws.saved': '本项目的设置已保存',
      'ws.cleared': '本项目的设置已清除',
      'ws.effective': '这个项目最后实际生效的',
      'ws.globalOnly': '没选项目时，下面显示的是全局设置。',
      'ws.hint': '留空 = 用全局设置（灰字是全局当前填的值）',
      'ws.styleHint': '这个项目想用别的说法就写在这里；留空就跟全局一样。',
      'ws.inheritNow': '当前：跟全局一样 ——',
      'ws.inheritEmpty': '（全局这一项没填）',
      'ws.overrideNow': '当前：这个项目用自己的设置',
      'ws.inherit': '继承全局',
      'ws.section.identity': '助手身份',
      'ws.section.user': '用户背景',
      'ws.section.style': '风格与特质',

      'mem.title': '长期记忆',
      'mem.desc': 'AI 自己攒下的东西不会直接用，先摆出来问你；你说要的，它才记住，以后也才用得上。',
      'mem.enabled': '启用记忆层',
      'mem.autoCapture': '自动收集候选',
      'mem.autoCaptureHint': 'AI 觉得该记的事会先存进这里等你点头，不会直接生效。',
      'mem.retrospect': '回扫式复盘（读旧会话找漏记的）',
      'mem.retrospectHint': '回扫最近几天的历史会话，专找「你说过但当时没记下来」的话。它只产线索，绝不自动写进记忆。要读磁盘上的会话日志，所以默认关闭。',
      'mem.retrospectDays': '回扫窗口（天）',
      'mem.retrospectDaysHint': '1–365。全量扫 53 个会话约 3 秒，窗口越小越快。',
      'mem.nightly': '每晚自动整理',
      'mem.nightlyHour': '整理时刻（0–23 时）',
      'mem.notify': '新对话开始时，提醒我有几条等你确认',
      'mem.maxPending': '这里最多存几条',
      'mem.maxInjected': '每次最多带上几条',
      'mem.maxInjectedHint': '0 = 一条都不带（等于关掉记忆）。',
      'mem.maxInjectedChars': '每次最多带多少字',
      'mem.maxInjectedCharsHint': '跟条数比，先到哪个算哪个；0 = 不限字数。',
      'mem.pending': '等你确认',
      'mem.adopted': '已记住',
      'mem.discarded': '已丢弃',
      'mem.emptyPending': '还没有等你确认的内容。',
      'mem.emptyAdopted': '还什么都没记住。',
      'mem.adopt': '记住它',
      'mem.discard': '丢弃',
      'mem.remove': '删除',
      'mem.triage': '立即整理',
      'mem.add': '手动添加',
      'mem.addPlaceholder': '要记住的内容（上限 500 字）',
      'mem.addNote': '备注（可选）',
      'mem.addScope': '作用域（可选，例如工作区路径）',
      'mem.lastTriage': '上次整理',
      'mem.triageDone': '整理完成',
      'mem.adoptedTag': '已记住',
      'mem.pendingTag': '待确认',
      'mem.discardedTag': '已丢弃',
      'mem.credential': '含凭据的内容会被直接拒收',
      // ── 记忆的分类与出处（这几项以前只在 JSON 里能看到）──
      'mem.type': '类型',
      'mem.typeFact': '事实',
      'mem.typePreference': '偏好',
      'mem.typeStance': '立场',
      'mem.typeEvent': '事件',
      'mem.verifyAt': '到期再看看',
      'mem.verifyOverdue': '该复查了',
      'mem.sourceRef': '出处',
      'mem.sourceRefNone': '没写出处',
      'mem.stateSuperseded': '曾如此',
      'mem.stateContradicted': '有争议',
      'mem.stateDropped': '已删除',
      'mem.stateHint': '「曾如此」= 你后来改过主意；「有争议」= 跟后来发生的事对不上、还没定论。两者说的都是过去，不是现在的样子。',
      // ── 记忆体检（只查机器能查的两件事）──
      'checkup.run': '体检',
      'checkup.running': '正在查…',
      'checkup.done': '体检完成',
      'checkup.clean': '机器能查的两件事都通过了：记忆里提到的文件路径都还在，也没有到了复查日期的。注意——这**不**代表记忆内容仍然成立，那只有你知道。',
      'checkup.summary': '查了 {checked} 条，{flagged} 条有事。',
      'checkup.note': '只查两件事：记忆里提到的文件路径还在不在、有没有到了复查日期的。它不判断内容对不对、也不判断两条记忆是不是在说同一件事。',
      'checkup.kindPathMissing': '路径不存在',
      'checkup.kindPathPrefixMissing': '路径前缀不存在',
      'checkup.kindPathUnprobed': '探不到（不是不存在）',
      'checkup.kindVerifyExpired': '该复查了',
      'checkup.kindOther': '其它',
      'checkup.suggest': '建议',
      'checkup.suggestNone': '只提示，不替你改',
      'checkup.command': '命令',
      'checkup.apply': '按建议标为「有争议」',
      'checkup.applied': '已标为「有争议」',
      'checkup.stale': '结果来自上一次体检，记忆可能已经变了。',
      // ── 巡夜（只报有事；沉默必须能反查成「真的没事」）──
      'patrol.run': '现在查一次',
      'patrol.running': '正在查…',
      'patrol.last': '上次自查',
      'patrol.never': '还没查过。这不是「没事」—— 是「没查」。',
      'retrospect.run': '回扫一次',
      'retrospect.running': '正在回扫…',
      'retrospect.last': '上次回扫',
      'retrospect.never': '还没回扫过。这不是「没有该记的」—— 是「没扫」。',
      'retrospect.scope': '{d} 天 / {f} 个会话',
      'retrospect.none': '没有新线索',
      'retrospect.found': '新线索 {n} 条',
      'retrospect.details': '这一轮找到的线索（只是线索，不是结论）',
      'retrospect.leadsOlder': '这批线索是 {t} 那轮找到的；这轮没有新的，所以沿用。',
      'retrospect.moreDropped': '还有 {n} 条没列出',
      'retrospect.error': '这次没扫成：{e}',
      'retrospect.toastFound': '回扫完成：新线索 {n} 条。要不要记由你定。',
      'retrospect.toastNone': '回扫完成：没有新线索。这不是没扫 —— 记录挂在下面。',
      'patrol.reported': '跑过了，报过',
      'patrol.silent': '查过了，没发现新情况，所以没有提醒我',
      'patrol.pending': '待确认',
      'patrol.flagged': '体检问题',
      'patrol.removed': '整理动过',
      'patrol.toastSilent': '查完了：没发现新情况，所以没有提醒。记录留在下方。',
      'patrol.toastReported': '查完了：已提醒你的 {n} 个对话。',
      // 巡夜记录里的体检明细：只有数字等于「我知道有 3 条问题，但不告诉我是哪 3 条」。
      'patrol.details': '这次体检点到的问题',
      'patrol.moreDropped': '另有 {n} 条没存下来（只留最近 20 条，要看完整的点「体检」重算）',
      'patrol.detailNoEvidence': '没有留下证据行',
      // ── 元数据编辑 ──
      'mem.editMeta': '改元数据',
      'mem.editMetaHide': '收起',
      'mem.saveMeta': '保存',
      'mem.metaSaved': '元数据已更新',
      'mem.metaNoChange': '没有任何改动',
      'mem.metaTypeHint': '类型决定衰减窗口：事实不因年龄衰减，偏好 540 天、立场 365 天、事件 180 天。',
      'mem.metaStateHint': '「曾如此 / 有争议 / 已删除」说的都是过去，不是现在的样子。改回「现行」会同时清掉它被哪条取代的记录。',
      'mem.metaVerifyHint': '格式 YYYY-MM-DD。过去日期会被拒收——要标过期请直接改状态。',
      'mem.metaSourceHint': '可核对的出处：消息编号、文件:行号、链接。没有就留空，不要编。',
      'mem.stateCurrent': '现行',

      'quality.title': '回答质检',
      'quality.desc': '每轮回答结束前，由代码（不是模型）按固定判据检查一遍形状；抓到问题就往下一条消息里插一条提醒。它判形状，不判内容对错。',
      'quality.enabled': '启用质检层',
      'quality.enabledHint': '关掉之后：发给 AI 的十二条与对账规则不再带上，每轮的自动检查也停止。',
      'quality.ledgerLevel': '对账档位',
      'quality.ledger.off': '关闭（不要求对账块）',
      'quality.ledger.three': '三档（数字 / 自查 / 引用）',
      'quality.ledger.five': '五档（三档 + 每类各写一行）',
      'quality.ledgerLevelHint': '出现这几类形状时必须写【对账】块。关掉它，R01 / R02 也就无从判起。',
      'quality.strict': '严格判词',
      'quality.strictHint': '多判三条：R08 置信度错配、R11 稻草人、R12 越界自信。误报变多时通常是关这一项，而不是关掉整个质检层。',
      'quality.preStepCheck': '每轮机制检查',
      'quality.preStepCheckHint': '关掉后不再往对话里插提醒，但发给 AI 的规则还在。',
      'quality.maxFindings': '每轮最多报几条',
      'quality.maxFindingsHint': '超出只写「还有 N 条未列出」。报太多会让提醒本身变成噪音。',
      'quality.stats': '运行计数（本进程内）',
      'quality.statsUnknown': '还没有拿到运行计数 —— 这不等于「没问题」。',
      'quality.statsIdle': '检查次数为 0：这一整套没在工作。别把「没有提醒」当成「没有问题」。',
      'quality.statsChecks': '已检查',
      'quality.statsReminders': '已提醒',
      'quality.statsSuppressed': '被每轮上限压住',
      'quality.statsLast': '最近一次',
      'quality.statsChars': '字',
      'quality.statsFindings': '判词',
      'quality.statsNone': '无',
      // ── 一键导入（Phase ②）──
      'imp.open': '导入外部 AI 的记忆',
      'imp.step1': '第 1 步：把下面这段话复制到别的 AI 的对话里',
      'imp.step1Hint': '在你用得最多的那个 AI 里发一次，让它把你的偏好整理成一份清单。',
      'imp.copy': '复制这段话',
      'imp.copied': '已复制',
      'imp.copyFailed': '复制失败，请手动选中后复制',
      'imp.step2': '第 2 步：把结果粘贴到下面',
      'imp.placeholder': '在此粘贴你的记忆（也可以直接粘贴自己的笔记，不必非得是 AI 生成的）',
      'imp.parse': '解析',
      'imp.parsing': '解析中…',
      'imp.cancel': '取消',
      'imp.commit': '导入选中项',
      'imp.committing': '导入中…',
      'imp.resultTitle': '解析结果',
      'imp.resultCounts': '读出 {pieces} 条，可导入 {accepted} 条。',
      'imp.layerGlobal': '全局',
      'imp.layerWorkspace': '本工作区',
      'imp.layerToggle': '切换层级',
      'imp.keep': '保留',
      'imp.drop': '不要',
      'imp.restore': '恢复',
      'imp.blockedTitle': '以下内容含疑似凭据，已拒绝入库',
      'imp.blockedHint': '凭据不该进入记忆。如果这是误判，请先删掉那串字符再粘贴。',
      'imp.tooLongTitle': '以下单条过长，未导入',
      'imp.tooLongHint': '单条上限 {max} 字。请拆成几条再粘贴 —— 截断会造出一条读不通的记忆。',
      'imp.duplicateTitle': '以下内容与已有记忆重复，已跳过',
      'imp.overflowTitle': '本次超出条数上限，未导入',
      'imp.overflowHint': '一次最多 {max} 条。剩下的请另开一次导入。',
      'imp.skippedHint': '另有 {n} 条碎片（过短或只是小标题）被忽略。',
      'imp.emptyResult': '没有解析出可导入的内容。若你粘贴的是纯列表，请确认每行以「- 」或「1. 」开头。',
      'imp.done': '已导入 {n} 条，等你确认——在上面逐条选要还是不要。',
      'imp.rejectedSome': '{n} 条未通过校验，未导入。',
      'imp.selected': '已选 {n} / {total} 条',
      // 同义提示：这条跟待审缓冲区里某条候选几乎一样。只提示，不替用户合并或丢弃 ——
      // 合并意味着生成一段他没说过的话（与 clusterPending 同一立场）。
      'imp.overlap': '等确认的里面已经有一条很像：{text}',

      'inj.title': '哪些记忆进了对话',
      'inj.toggle': '查看每一条为什么带上 / 没带上',
      'inj.hide': '收起',
      'inj.desc': '只有你说要记住的那些才会带给 AI，而且受条数和字数两个上限限制，先到哪个算哪个。',
      'inj.empty': '还什么都没记住。',
      'inj.count': '条数',
      'inj.chars': '字符',
      // 只在真的有超窗条目时才画。现在 21 条全是 7 天龄、全部 fresh，
      // 常显会长期显示「0 条」，变成一条永远不动的装饰；而装饰一旦习惯，
      // 真正跳成「3 条」时也不会被注意。
      'inj.decayed': '其中已超窗',
      'inj.included': '带上了',
      'inj.excluded': '没带上',
      'inj.cwd': '按工作区',
      'inj.cwdNone': '当前会话没有工作区信息',
      'inj.bytes': '占用字节',
      'inj.limitedBy': '卡在',
      'inj.limitedByCount': '条数上限',
      'inj.limitedByChars': '字符预算',
      'inj.limitedByNone': '没卡',
      // 这条必须说清「不是没有」，否则用户看到「0 条注入」会先去查 bug。
      'inj.omitted': '因预算未带上',

      'cluster.title': '疑似重复的候选',
      'cluster.similarity': '相似度',
      'conflict.title': '与已记住的内容重复',
      'conflict.adopted': '已记住',

      'audit.title': '变更记录',
      'audit.desc': '谁在什么时候改了这一页的哪一项。模型通过工具改人设时默认也要问你，但那个开关可以关掉 —— 关掉之后，这里是唯一的凭证。',
      'audit.toggle': '展开明细',
      'audit.hide': '收起',
      'audit.empty': '还没有任何变更记录。',
      'audit.loading': '读取中…',
      'audit.total': '共',
      'audit.records': '条',
      'audit.maxHint': '只保留最近 200 条，更早的自动淘汰。',
      'audit.clear': '清空记录',
      'audit.clearConfirm': '清空全部变更记录？此操作不可撤销。',
      'audit.cleared': '已清空',
      'audit.actor.user': '你',
      'audit.actor.agent': '模型',
      'audit.actor.system': '系统',
      'audit.from': '原值',
      'audit.to': '新值',
      'audit.emptyValue': '（空）',
      'audit.note': '备注',

      'preview.title': 'AI 实际看到的内容',
      'preview.toggle': '显示我给 AI 加的内容',
      'preview.desc': '只读。看看这段人设真正发给 AI 时长什么样 —— 包括还没保存的改动。',
      'preview.empty': '现在没有要带给 AI 的内容。',
      'preview.live': '已含未保存的修改',
      'preview.saved': '按已保存的设置显示',
      'preview.refresh': '刷新预览',
      'preview.loading': '正在生成预览…',
      'preview.chars': '字符数',
      'preview.invalidTitle': '以下几项暂时不算数（预览用的是上一次能用的值）：',

      // 卡片折叠
      'card.collapse': '收起',
      'card.expand': '展开',
      // 分区名（设置页顶部的横排标签）。用名词而不是动词：它们标的是「这里面
      // 装的是什么」，不是「点了会做什么」。
      'section.persona': '人设',
      'section.preset': '预设',
      'section.memory': '记忆',
      'section.behavior': '表现',
      'section.advanced': '高级',
      'savebar.clean': '没有未保存的修改',
      'savebar.dirty': '有未保存的修改',

      'common.save': '保存',
      'common.reset': '恢复默认',
      'common.reset.confirm': '恢复默认会清空已保存的人设字段（名字、角色、称呼等）。确定继续？',
      'common.refresh': '刷新',
      'common.loading': '加载中…',
      'common.saved': '已保存',
      'common.reset.done': '已恢复默认',
      'common.full500': '接近 500 字上限',
      'common.unsaved': '有未保存的修改',
      'common.cancel': '取消',
      'common.optional': '（可选）',

      // 输入框左下角的快捷开关
      'quick.enable': '开启助手人设',
      'quick.disable': '暂时关闭助手人设',
      'quick.statusEnabled': '人设已开',
      'quick.statusDisabled': '人设已关',

      // 光轨设置卡
      'trail.title': '输入框光轨',
      'trail.desc': '助手回复时，输入框外圈会有一道流动的光。纯界面效果，不会发给 AI。',
      'trail.enabled': '显示光轨',
      'trail.color': '颜色',
      'trail.colorHint': '六位十六进制，例如 #679EFE',
      'trail.speed': '速度',
      'trail.speed.slow': '慢',
      'trail.speed.normal': '中',
      'trail.speed.fast': '快',
      'trail.width': '粗细',
      'trail.width.thin': '细',
      'trail.width.normal': '中',
      'trail.width.thick': '粗',
      'trail.preview': '在下方方框里预览当前配色',

      // 工具确认门槛
      'tool.title': '工具确认',
      'tool.confirmLabel': '模型改人设前需要我确认',
      'tool.confirmDesc': '开启后，模型调用工具修改人设只会生成一份提议，等你点头才真正写入。',

      // 待确认提议条
      'proposal.title': '有一份待确认的人设变更',
      'proposal.at': '提出于',
      'proposal.confirm': '确认生效',
      'proposal.reject': '拒绝',
      'proposal.confirmed': '已确认并生效',
      'proposal.rejected': '已拒绝，配置未改动',
      'proposal.gone': '该提议已不存在（进程重启会清掉待确认提议）',

      // 改动记录里的字段名（人话版）
      // 用途：改动记录原来显示 agentName / memory.maxInjected 这类代码键名。
      // 这里逐条换成「屏幕上这句话是什么意思」，键名必须与 lib/store.mjs 的 diffConfig 对齐。
      'field.enabled': '总开关',
      'field.agentName': 'AI 的名字',
      'field.agentRole': 'AI 的角色',
      'field.addressUserAs': '它怎么称呼我',
      'field.userOccupation': '我的职业',
      'field.userBio': '关于我',
      'field.style': '说话风格',
      'field.headingLists': '标题与列表',
      'field.emoji': '表情符号',
      'field.tables': '表格',
      'field.replyLength': '回复长度',
      'field.language': '语言',
      'field.customInstructions': '补充指令',
      'field.requireToolConfirmation': '改人设前要我确认',
      'field.trailEnabled': '光轨',
      'field.trailColor': '光轨颜色',
      'field.trailSpeed': '光轨速度',
      'field.trailWidth': '光轨粗细',
      'field.workspaceOverridesEnabled': '按项目单独设置',
      'field.workspaceFileDir': '工作区文件位置',
      'field.presets': '预设列表',
      'field.memory.enabled': '记忆总开关',
      'field.memory.autoCapture': '自动收集记忆',
      'field.memory.nightlyTriage': '夜间自动整理',
      'field.memory.nightlyHour': '整理时间',
      'field.memory.maxPending': '待确认条数上限',
      'field.memory.maxInjected': '每次带几条记忆',
      'field.memory.maxInjectedChars': '记忆占用字数上限',
      'field.memory.notifyOnSessionStart': '新会话时提醒',
      'field.quality.enabled': '质检开关',
      'field.quality.ledgerLevel': '记录详细程度',
      'field.quality.strict': '严格模式',
      'field.quality.preStepCheck': '动手前先自查',
      'field.quality.maxFindingsInReminder': '提醒里最多几条'
    }

    const en = {
      'nav.label': 'Persona & Memory',
      'page.title': 'Persona & Memory',
      'page.desc': 'Three things live here: what the assistant calls itself, settings that only apply to this project, and what it remembers.',

      'identity.title': 'Assistant identity',
      'identity.desc': 'Describes who the assistant is. Opposite in direction to "Your background" below — that card describes you, this one describes the assistant.',
      'identity.name': 'Assistant name',
      'identity.nameHint': 'The name the assistant calls itself — not how you address it (that is the next card). Leave empty and it will not be told its own name.',
      'identity.namePlaceholder': 'e.g. "Wally", "Nova" — a word or two, not a job title or a pet name',
      'identity.role': 'Role',
      'identity.roleHint': 'For example "senior architect; conclusion first, then tradeoffs". Max 800 characters.',
      'identity.enabled': 'Tell the assistant who it is',
      'identity.enabledHint': 'When off, this description is no longer sent — the assistant will not know who it is.',

      'user.title': 'Your background',
      'user.desc': 'Describes you. It is a separate section so the model cannot merge it with the assistant identity above — the two point in opposite directions.',
      'user.address': 'How to address you',
      'user.addressHint': 'Leave empty for no salutation.',
      'user.occupation': 'Your occupation',
      'user.bio': 'About you',
      'user.bioHint': 'Identity, technical background, what you are working on. Max 500 characters.',

      'style.title': 'Reply style and traits',
      'style.desc': 'These decide how answers read, not what they contain. What you type here is sent to the model verbatim; leave a field empty for no requirement.',
      'style.style': 'Style',
      'style.headingLists': 'Headings and lists',
      'style.emoji': 'Emoji',
      'style.tables': 'Tables',
      'style.replyLength': 'Reply length',
      'style.language': 'Language',
      'style.styleHint': 'One sentence saying how you want it to sound.',
      'style.fill': 'Fill in',
      'style.fillHint': 'Click to drop that wording into the box, then edit it freely.',
      'style.custom': 'Extra instructions',
      'style.customHint': 'Additional behaviour rules. Max 2000 characters.',
      'example.label': 'Examples (click to fill, then make it yours)',

      'wording.professional': 'Professional',
      'wording.casual': 'Casual',
      'wording.humorous': 'Humorous',
      'wording.roast': 'Blunt',
      'wording.efficient': 'Efficient',
      'wording.more': 'More',
      'wording.less': 'Less',
      'wording.concise': 'Concise',
      'wording.normal': 'Normal',
      'wording.detailed': 'Detailed',
      'wording.zh': '简体中文',
      'wording.en': 'English',

      'preset.title': 'Persona presets',
      'preset.desc': 'A preset is a ready-made persona. Applying it replaces only the items it covers; everything else keeps what you have now.',
      'preset.pick': 'Apply a preset',
      'preset.apply': 'Apply',
      'preset.applied': 'Preset applied',
      'preset.saved': 'Preset saved',
      'preset.deleted': 'Preset deleted',
      'preset.saveTitle': 'Save the current settings as a preset',
      'preset.name': 'Preset name',
      'preset.namePlaceholder': 'For example "Midnight blunt"',
      'preset.descField': 'Description (optional)',
      'preset.descPlaceholder': 'e.g. "For coding: conclusion first, then the tradeoffs"',
      'preset.save': 'Save as preset',
      'preset.delete': 'Delete',
      'preset.builtinTag': 'built-in',
      'preset.customTag': 'custom',
      'preset.builtinHint': 'Built-in presets cannot be deleted; a built-in wins over a custom preset with the same name.',
      'preset.saveHint': 'Saves the settings as currently **stored**. Hit Save above first.',
      'preset.activeTag': 'in effect',
      'preset.activeHint': 'Derived by comparing fields: a preset counts as "in effect" only when every field it declares still matches your current value. Change any one of them and the tag disappears — that means your settings no longer equal that preset.',

      'source.label': 'Storage',
      'source.domain': 'DSH storage domain',
      'source.none': 'not opened',
      'source.path': 'Path',
      'source.reason': 'Unavailable reason',
      'source.message': 'Details',
      'source.reason.storage-not-composed': 'This profile mounts no storage stack. The plugin still loads, but cannot read your saved persona or memories. Add the storage / storage-json / storage-domain rows.',
      'source.reason.vocabulary-unavailable': 'The storage-domain vocabulary (@deepseek-ai/dsh-storage-domain / zod) could not be resolved.',
      'source.reason.open-failed': 'Opening the storage domain failed: ',
      'source.format': 'Storage format',
      'source.formatText': "v{n} (the medium's format stamp — a separate numbering from the plugin version)",

      'ws.title': 'Workspace override',
      'ws.desc': 'Only the items you fill in are replaced; empty ones use the global setting. These settings live in one file inside the project, so they can be committed with it.',
      'ws.pick': 'Workspace',
      'ws.none': '(none selected)',
      'ws.empty': 'No workspace registered yet.',
      'ws.enabled': 'Let this project use its own settings',
      'ws.dir': 'Folder name for these settings',
      'ws.dirHint': 'A single folder name under the project root; defaults to .dsh-anima.',
      'ws.filePath': 'Settings file',
      'ws.exists': 'This project already has a settings file',
      'ws.notExists': 'This project has no settings file yet',
      'ws.save': 'Save this project\'s settings',
      'ws.clear': 'Clear this project\'s settings',
      'ws.saved': 'This project\'s settings saved',
      'ws.cleared': 'This project\'s settings cleared',
      'ws.effective': 'What actually applies in this project',
      'ws.globalOnly': 'With no project selected, the values below are the global ones.',
      'ws.hint': 'Empty means use the global setting (grey text is the global value)',
      'ws.styleHint': 'Write a different wording for this project; leave empty to keep the global one.',
      'ws.inheritNow': 'Now: same as global —',
      'ws.inheritEmpty': '(global field is empty)',
      'ws.overrideNow': 'Now: this project uses its own settings',
      'ws.inherit': 'Inherit global',
      'ws.section.identity': 'Assistant identity',
      'ws.section.user': 'Your background',
      'ws.section.style': 'Style and traits',

      'mem.title': 'Long-term memory',
      'mem.desc': 'Anything the assistant picks up is shown to you first. Only what you say yes to gets remembered — and only then does it get used.',
      'mem.enabled': 'Enable memory',
      'mem.autoCapture': 'Auto-capture candidates',
      'mem.autoCaptureHint': 'Things the assistant thinks are worth keeping wait here for your yes or no; nothing takes effect directly.',
      'mem.retrospect': 'Rescan old sessions for missed items',
      'mem.retrospectHint': 'Scans recent sessions for things you said but were never written down. It only produces leads; it never writes to memory by itself. Reads session logs from disk, so it is off by default.',
      'mem.retrospectDays': 'Rescan window (days)',
      'mem.retrospectDaysHint': '1–365. A full scan of 53 sessions takes about 3 seconds; a smaller window is faster.',
      'mem.nightly': 'Nightly tidy-up',
      'mem.nightlyHour': 'Hour (0–23)',
      'mem.notify': 'Mention how many are waiting when a chat starts',
      'mem.maxPending': 'How many can wait here',
      'mem.maxInjected': 'How many to carry per turn',
      'mem.maxInjectedHint': '0 = carry none at all (memory effectively off).',
      'mem.maxInjectedChars': 'How many characters to carry',
      'mem.maxInjectedCharsHint': 'Whichever limit is hit first; 0 means no character limit.',
      'mem.pending': 'Waiting for your yes or no',
      'mem.adopted': 'Remembered',
      'mem.discarded': 'Discarded',
      'mem.emptyPending': 'Nothing is waiting for your yes or no.',
      'mem.emptyAdopted': 'Nothing remembered yet.',
      'mem.adopt': 'Remember it',
      'mem.discard': 'Discard',
      'mem.remove': 'Delete',
      'mem.triage': 'Tidy up now',
      'mem.add': 'Add manually',
      'mem.addPlaceholder': 'What to remember (max 500 characters)',
      'mem.addNote': 'Note (optional)',
      'mem.addScope': 'Scope (optional, e.g. a workspace path)',
      'mem.lastTriage': 'Last tidy-up',
      'mem.triageDone': 'Tidy-up finished',
      'mem.adoptedTag': 'remembered',
      'mem.pendingTag': 'waiting',
      'mem.discardedTag': 'discarded',
      'mem.credential': 'Content containing credentials is rejected outright',
      'mem.type': 'Type',
      'mem.typeFact': 'fact',
      'mem.typePreference': 'preference',
      'mem.typeStance': 'stance',
      'mem.typeEvent': 'event',
      'mem.verifyAt': 'Recheck on',
      'mem.verifyOverdue': 'due for a recheck',
      'mem.sourceRef': 'Source',
      'mem.sourceRefNone': 'no source recorded',
      'mem.stateSuperseded': 'was true',
      'mem.stateContradicted': 'contested',
      'mem.stateDropped': 'removed',
      'mem.stateHint': '“was true” means you later changed your mind; “contested” means it clashes with later facts and has not been settled. Both describe the past, not the present.',
      // ── Memory checkup (only the two machine-checkable things) ──
      'checkup.run': 'Check up',
      'checkup.running': 'Checking…',
      'checkup.done': 'Checkup done',
      'checkup.clean': 'Both machine-checkable things passed: every file path mentioned in a memory still exists, and nothing is past its recheck date. Note — this does **not** mean the memories still hold; only you know that.',
      'checkup.summary': '{checked} checked, {flagged} with findings.',
      'checkup.note': 'Only two things are checked: whether the file paths mentioned in a memory still exist, and whether a recheck date has passed. It does not judge whether the content is right, nor whether two memories are about the same thing.',
      'checkup.kindPathMissing': 'path missing',
      'checkup.kindPathPrefixMissing': 'path prefix missing',
      'checkup.kindPathUnprobed': 'could not probe (not the same as missing)',
      'checkup.kindVerifyExpired': 'recheck date passed',
      'checkup.kindOther': 'other',
      'checkup.suggest': 'Suggestion',
      'checkup.suggestNone': 'flagged only, not changed for you',
      'checkup.command': 'Command',
      'checkup.apply': 'Mark as “contested” as suggested',
      'checkup.applied': 'Marked as “contested”',
      'checkup.stale': 'These results are from the previous checkup; the memories may have changed since.',
      // ── Patrol (report only when there is news; silence must be auditable) ──
      'patrol.run': 'Check now',
      'patrol.running': 'Checking…',
      'patrol.last': 'Last check',
      'patrol.never': 'This has never run. That is not “all clear” — it is “not run”.',
      'retrospect.run': 'Rescan now',
      'retrospect.running': 'Rescanning…',
      'retrospect.last': 'Last rescan',
      'retrospect.never': 'This has never been rescanned. That is not “nothing worth keeping” — it is “not scanned”.',
      'retrospect.scope': '{d} days / {f} sessions',
      'retrospect.none': 'no new leads',
      'retrospect.found': '{n} new leads',
      'retrospect.details': 'Leads found this round (leads, not conclusions)',
      'retrospect.leadsOlder': 'These leads came from the round at {t}; this round found none new, so they are kept.',
      'retrospect.moreDropped': '{n} more not listed',
      'retrospect.error': 'This round did not complete: {e}',
      'retrospect.toastFound': 'Rescan done: {n} new leads. Whether to keep any is your call.',
      'retrospect.toastNone': 'Rescan done: no new leads. Not “not scanned” — the record is below.',
      'patrol.reported': 'ran, reported',
      'patrol.silent': 'ran, found nothing new, so stayed quiet',
      'patrol.pending': 'waiting',
      'patrol.flagged': 'checkup findings',
      'patrol.removed': 'triage touched',
      'patrol.toastSilent': 'Check finished: nothing new, so nothing was reported. The record is kept below.',
      'patrol.toastReported': 'Check finished: told {n} of your chats.',
      'patrol.details': 'What this checkup flagged',
      'patrol.moreDropped': '{n} more were not stored (only the latest 20 are kept; run the checkup for the full list)',
      'patrol.detailNoEvidence': 'no evidence line was recorded',
      // ── Metadata editing ──
      'mem.editMeta': 'Edit metadata',
      'mem.editMetaHide': 'Collapse',
      'mem.saveMeta': 'Save',
      'mem.metaSaved': 'Metadata updated',
      'mem.metaNoChange': 'Nothing changed',
      'mem.metaTypeHint': 'The type sets the decay window: facts never age out, preferences 540 days, stances 365, events 180.',
      'mem.metaStateHint': '“was true” / “contested” / “removed” all describe the past, not the present. Setting it back to current also clears the record of which entry superseded it.',
      'mem.metaVerifyHint': 'Format YYYY-MM-DD. A date in the past is rejected — to mark it expired, change the state instead.',
      'mem.metaSourceHint': 'A checkable source: message id, file:line, URL. Leave it empty rather than making one up.',
      'mem.stateCurrent': 'current',

      'quality.title': 'Answer check',
      'quality.desc': 'Before each turn ends, code (not the model) checks the shape of the answer against fixed rules; if something is caught, a notice is inserted into the next message. It judges shape, not whether the content is right.',
      'quality.enabled': 'Enable the check layer',
      'quality.enabledHint': 'Off means: the twelve rules and the ledger rules are no longer sent with the prompt, and the mechanical check stops running.',
      'quality.ledgerLevel': 'Ledger level',
      'quality.ledger.off': 'Off (no ledger block required)',
      'quality.ledger.three': 'Three tiers (numbers / self-claims / citations)',
      'quality.ledger.five': 'Five tiers (three, plus one line per class)',
      'quality.ledgerLevelHint': 'When these shapes appear, a ledger block is required. With this off, R01 and R02 cannot be judged at all.',
      'quality.strict': 'Strict verdicts',
      'quality.strictHint': 'Judges three more: R08 confidence mismatch, R11 straw man, R12 overreach. When false positives pile up, turn this off rather than the whole layer.',
      'quality.preStepCheck': 'Mechanical check each turn',
      'quality.preStepCheckHint': 'Off means no notices are inserted, though the rules sent to the assistant stay in place.',
      'quality.maxFindings': 'Max findings per turn',
      'quality.maxFindingsHint': 'Beyond this, only "N more not listed" is written. Reporting too many turns the notice itself into noise.',
      'quality.stats': 'Run counters (this process)',
      'quality.statsUnknown': 'No run counters yet — this does not mean nothing was wrong.',
      'quality.statsIdle': 'Zero checks: none of this is running. Do not read "no notices" as "nothing was wrong".',
      'quality.statsChecks': 'Checked',
      'quality.statsReminders': 'Notices sent',
      'quality.statsSuppressed': 'Suppressed by per-turn cap',
      'quality.statsLast': 'Last run',
      'quality.statsChars': 'chars',
      'quality.statsFindings': 'Findings',
      'quality.statsNone': 'none',
      // ── Import from another AI (Phase ②) ──
      'imp.open': 'Import memories from another AI',
      'imp.step1': 'Step 1 — copy this text into another AI conversation',
      'imp.step1Hint': 'Send it once in whichever AI you use most, and let it write up your preferences as a list.',
      'imp.copy': 'Copy this text',
      'imp.copied': 'Copied',
      'imp.copyFailed': 'Copy failed — select the text and copy it manually',
      'imp.step2': 'Step 2 — paste the result below',
      'imp.placeholder': 'Paste your memories here (own notes are fine too — it need not come from an AI)',
      'imp.parse': 'Parse',
      'imp.parsing': 'Parsing…',
      'imp.cancel': 'Cancel',
      'imp.commit': 'Import kept items',
      'imp.committing': 'Importing…',
      'imp.resultTitle': 'Parse result',
      'imp.resultCounts': 'Read {pieces} items; {accepted} can be imported.',
      'imp.layerGlobal': 'Global',
      'imp.layerWorkspace': 'This workspace',
      'imp.layerToggle': 'Toggle scope',
      'imp.keep': 'Keep',
      'imp.drop': 'Drop',
      'imp.restore': 'Restore',
      'imp.blockedTitle': 'These look like credentials and were refused',
      'imp.blockedHint': 'Credentials do not belong in memory. If this is a false positive, remove that string and paste again.',
      'imp.tooLongTitle': 'These items are too long and were not imported',
      'imp.tooLongHint': 'The limit is {max} characters per item. Please split them — truncating would produce a memory that reads as broken.',
      'imp.duplicateTitle': 'These duplicate existing memories and were skipped',
      'imp.overflowTitle': 'Over the per-import limit — not imported',
      'imp.overflowHint': 'At most {max} items per import. Import the rest in another pass.',
      'imp.skippedHint': '{n} fragments (too short, or just headings) were ignored.',
      'imp.emptyResult': 'Nothing importable was found. If you pasted a plain list, make sure each line starts with "- " or "1. ".',
      'imp.done': 'Imported {n} item(s) — they are waiting for your yes or no above.',
      'imp.rejectedSome': '{n} item(s) failed validation and were not imported.',
      'imp.selected': '{n} of {total} kept',
      // Near-duplicate notice: this item closely matches a pending candidate already in
      // the review buffer. Notice only — never merged or dropped on the user's behalf.
      'imp.overlap': 'Something very similar is already waiting: {text}',

      'inj.title': 'What went into the conversation',
      'inj.toggle': 'Show why each item was sent or not',
      'inj.hide': 'Hide',
      'inj.desc': 'Only what you chose to remember is sent to the assistant, and only within both the item and character ceilings — whichever comes first.',
      'inj.empty': 'Nothing remembered yet.',
      'inj.count': 'items',
      'inj.chars': 'characters',
      'inj.decayed': 'Past their window',
      'inj.included': 'sent',
      'inj.excluded': 'not sent',
      'inj.cwd': 'By workspace',
      'inj.cwdNone': 'This session carries no workspace information',
      'inj.bytes': 'bytes used',
      'inj.limitedBy': 'limited by',
      'inj.limitedByCount': 'item ceiling',
      'inj.limitedByChars': 'character budget',
      'inj.limitedByNone': 'not limited',
      'inj.omitted': 'left out by budget',

      'cluster.title': 'Possibly duplicate candidates',
      'cluster.similarity': 'Similarity',
      'conflict.title': 'Duplicates something already remembered',
      'conflict.adopted': 'Remembered',

      'audit.title': 'Change log',
      'audit.desc': 'Who changed which setting on this page, and when. The model asks before rewriting your persona by default — but that switch can be turned off, and once it is, this log is the only record.',
      'audit.toggle': 'Show details',
      'audit.hide': 'Hide',
      'audit.empty': 'No changes recorded yet.',
      'audit.loading': 'Loading…',
      'audit.total': 'Total',
      'audit.records': '',
      'audit.maxHint': 'Only the latest 200 entries are kept; older ones are dropped.',
      'audit.clear': 'Clear log',
      'audit.clearConfirm': 'Clear the whole change log? This cannot be undone.',
      'audit.cleared': 'Cleared',
      'audit.actor.user': 'You',
      'audit.actor.agent': 'Model',
      'audit.actor.system': 'System',
      'audit.from': 'was',
      'audit.to': 'now',
      'audit.emptyValue': '(empty)',
      'audit.note': 'Note',

      'preview.title': 'What the assistant actually sees',
      'preview.toggle': 'Show what this plugin adds',
      'preview.desc': 'Read-only. Shows how this persona will actually read to the assistant — including unsaved edits.',
      'preview.empty': 'There is nothing to send to the assistant right now.',
      'preview.live': 'Includes unsaved edits',
      'preview.saved': 'From saved settings',
      'preview.refresh': 'Refresh preview',
      'preview.loading': 'Building preview…',
      'preview.chars': 'Characters',
      'preview.invalidTitle': 'These drafts are not counted yet (the preview uses the last valid value):',

      // Card folding
      'card.collapse': 'Collapse',
      'card.expand': 'Expand',
      'section.persona': 'Persona',
      'section.preset': 'Presets',
      'section.memory': 'Memory',
      'section.behavior': 'Behavior',
      'section.advanced': 'Advanced',
      'savebar.clean': 'No unsaved changes',
      'savebar.dirty': 'Unsaved changes',

      'common.save': 'Save',
      'common.reset': 'Reset to defaults',
      'common.reset.confirm': 'Resetting clears your saved persona fields (name, role, how I address you, etc.). Continue?',
      'common.refresh': 'Refresh',
      'common.loading': 'Loading…',
      'common.saved': 'Saved',
      'common.reset.done': 'Defaults restored',
      'common.full500': 'Near the 500-character limit',
      'common.unsaved': 'Unsaved changes',
      'common.cancel': 'Cancel',
      'common.optional': '(optional)',

      // Quick toggle beside the input box
      'quick.enable': 'Turn the persona on',
      'quick.disable': 'Turn the persona off for now',
      'quick.statusEnabled': 'Persona on',
      'quick.statusDisabled': 'Persona off',

      // Trail card
      'trail.title': 'Composer trail',
      'trail.desc': 'While the assistant replies, a light runs around the input box. A pure UI effect — it is never sent to the assistant.',
      'trail.enabled': 'Show the trail',
      'trail.color': 'Color',
      'trail.colorHint': 'Six hex digits, e.g. #679EFE',
      'trail.speed': 'Speed',
      'trail.speed.slow': 'Slow',
      'trail.speed.normal': 'Normal',
      'trail.speed.fast': 'Fast',
      'trail.width': 'Thickness',
      'trail.width.thin': 'Thin',
      'trail.width.normal': 'Normal',
      'trail.width.thick': 'Thick',
      'trail.preview': 'Preview the current color below',

      // Tool confirmation gate
      'tool.title': 'Tool confirmation',
      'tool.confirmLabel': 'Ask me before the model changes the persona',
      'tool.confirmDesc': 'When on, a tool call that changes the persona only drafts a proposal; it is written only after you approve.',

      // Pending proposal strip
      'proposal.title': 'A persona change is waiting for your approval',
      'proposal.at': 'Proposed at',
      'proposal.confirm': 'Approve and apply',
      'proposal.reject': 'Reject',
      'proposal.confirmed': 'Approved and applied',
      'proposal.rejected': 'Rejected; nothing changed',
      'proposal.gone': 'That proposal is gone (pending proposals are dropped when the process restarts)',

      // Field names inside the change log (plain-English versions).
      // The change log used to print raw config keys such as agentName or
      // memory.maxInjected. These keys must stay aligned with diffConfig in lib/store.mjs.
      'field.enabled': 'On/off',
      'field.agentName': 'Assistant name',
      'field.agentRole': 'Assistant role',
      'field.addressUserAs': 'What it calls you',
      'field.userOccupation': 'Your occupation',
      'field.userBio': 'About you',
      'field.style': 'Tone',
      'field.headingLists': 'Headings and lists',
      'field.emoji': 'Emoji',
      'field.tables': 'Tables',
      'field.replyLength': 'Reply length',
      'field.language': 'Language',
      'field.customInstructions': 'Extra instructions',
      'field.requireToolConfirmation': 'Confirm before changing persona',
      'field.trailEnabled': 'Light trail',
      'field.trailColor': 'Trail color',
      'field.trailSpeed': 'Trail speed',
      'field.trailWidth': 'Trail width',
      'field.workspaceOverridesEnabled': 'Per-project settings',
      'field.workspaceFileDir': 'Workspace file location',
      'field.presets': 'Presets',
      'field.memory.enabled': 'Memory on/off',
      'field.memory.autoCapture': 'Collect memories automatically',
      'field.memory.nightlyTriage': 'Nightly cleanup',
      'field.memory.nightlyHour': 'Cleanup time',
      'field.memory.maxPending': 'Pending limit',
      'field.memory.maxInjected': 'Memories per prompt',
      'field.memory.maxInjectedChars': 'Memory character budget',
      'field.memory.notifyOnSessionStart': 'Remind on new session',
      'field.quality.enabled': 'Quality check on/off',
      'field.quality.ledgerLevel': 'How much gets logged',
      'field.quality.strict': 'Strict mode',
      'field.quality.preStepCheck': 'Check before acting',
      'field.quality.maxFindingsInReminder': 'Findings per reminder'
    }

    const FALLBACK_T = (key) => zh[key] ?? key

    // -------------------------------------------------------------------------
    // 小工具
    // -------------------------------------------------------------------------

    const STATUS_TAG_KEY = { pending: 'mem.pendingTag', adopted: 'mem.adoptedTag', discarded: 'mem.discardedTag' }

    /** 记忆类型 → 词典键。写错的类型回落 fact，与宿主 normalizeMemoryType 同一套默认。 */
    const TYPE_TAG_KEY = {
      fact: 'mem.typeFact',
      preference: 'mem.typePreference',
      stance: 'mem.typeStance',
      event: 'mem.typeEvent'
    }

    /** 记忆状态 → 词典键。current 不画徽章：现行状态不需要标签，画出来只是噪音。 */
    const STATE_TAG_KEY = {
      superseded: 'mem.stateSuperseded',
      contradicted: 'mem.stateContradicted',
      dropped: 'mem.stateDropped'
    }

    /**
     * 体检发现的种类 → 词典键。
     *
     * 用白名单查表而不是「拼 key 去试探」：词典缺 key 时 t() 要么抛错要么把 key
     * 当文案显示出来，两条路都糟。未收录的种类走 kindOther，原文 detail 仍然照画 ——
     * 宁可标签是「其它」，也不要把诊断信息吞掉。
     */
    const CHECKUP_KIND_KEY = {
      'path-missing': 'checkup.kindPathMissing',
      'path-prefix-missing': 'checkup.kindPathPrefixMissing',
      'path-unprobed': 'checkup.kindPathUnprobed',
      'verify-expired': 'checkup.kindVerifyExpired'
    }

    /** 类型下拉的选项顺序 —— 与宿主 MEMORY_TYPES 同集合，顺序按「最常见 → 最少见」。 */
    const MEMORY_TYPE_VALUES = ['fact', 'preference', 'stance', 'event']

    /** 状态下拉的选项顺序。current 排第一：绝大多数记忆都该是它。 */
    const MEMORY_STATE_VALUES = ['current', 'superseded', 'contradicted', 'dropped']

    /**
     * 状态下拉单独的标签表。
     *
     * 不能复用 STATE_TAG_KEY：那张表故意不给 current 键（徽章不画它），
     * 而下拉框必须能显示「现行」，否则用户打开表单会看到一个空选项。
     */
    const MEMORY_STATE_LABEL_KEY = {
      current: 'mem.stateCurrent',
      superseded: 'mem.stateSuperseded',
      contradicted: 'mem.stateContradicted',
      dropped: 'mem.stateDropped'
    }

    /**
     * 改动记录里的字段名 → 人话。
     *
     * 这张表存在的理由很具体：改动记录原来直接显示 `diffConfig` 的原始键名
     * （`agentName`、`memory.maxInjected`），屏幕上出现的是代码，不是「我改过什么」。
     * 用户的原话是「UI 是面向人类的不是面向 ai 的」，这些键名就是最硬的证据。
     *
     * 键集合必须与 `lib/store.mjs` 的 `diffConfig` 保持一致。少一个的后果不是报错，
     * 而是那一行退化成裸键名 —— 所以查不到时**回落到原键名**而不是显示「其它设置」：
     * 露出难看的真相，好过把改动藏起来。
     */
    const AUDIT_FIELD_KEY = {
      enabled: 'field.enabled',
      agentName: 'field.agentName',
      agentRole: 'field.agentRole',
      addressUserAs: 'field.addressUserAs',
      userOccupation: 'field.userOccupation',
      userBio: 'field.userBio',
      style: 'field.style',
      headingLists: 'field.headingLists',
      emoji: 'field.emoji',
      tables: 'field.tables',
      replyLength: 'field.replyLength',
      language: 'field.language',
      customInstructions: 'field.customInstructions',
      requireToolConfirmation: 'field.requireToolConfirmation',
      trailEnabled: 'field.trailEnabled',
      trailColor: 'field.trailColor',
      trailSpeed: 'field.trailSpeed',
      trailWidth: 'field.trailWidth',
      workspaceOverridesEnabled: 'field.workspaceOverridesEnabled',
      workspaceFileDir: 'field.workspaceFileDir',
      presets: 'field.presets',
      'memory.enabled': 'field.memory.enabled',
      'memory.autoCapture': 'field.memory.autoCapture',
      'memory.nightlyTriage': 'field.memory.nightlyTriage',
      'memory.nightlyHour': 'field.memory.nightlyHour',
      'memory.maxPending': 'field.memory.maxPending',
      'memory.maxInjected': 'field.memory.maxInjected',
      'memory.maxInjectedChars': 'field.memory.maxInjectedChars',
      'memory.notifyOnSessionStart': 'field.memory.notifyOnSessionStart',
      'quality.enabled': 'field.quality.enabled',
      'quality.ledgerLevel': 'field.quality.ledgerLevel',
      'quality.strict': 'field.quality.strict',
      'quality.preStepCheck': 'field.quality.preStepCheck',
      'quality.maxFindingsInReminder': 'field.quality.maxFindingsInReminder'
    }

    /** 字段键 → 显示名。查不到就回落原键名（见上）。 */
    function auditFieldLabel(t, key) {
      const dictKey = AUDIT_FIELD_KEY[key]
      return dictKey ? t(dictKey) : String(key ?? '')
    }

    function shortTime(value) {
      if (!value) return ''
      const d = new Date(value)
      if (Number.isNaN(d.getTime())) return String(value)
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    // 不可用原因是机器可读短码（宿主 lib/store.mjs 里 StorageUnavailableError 的 code）。
    // 这里刻意用**白名单**查表，而不是拿 t() 去试探：词典缺 key 时 t() 可能是抛错或回显
    // key，两条路都糟 —— 前者会把整页渲染带崩，后者会把 key 当成文案显示出来。
    // 未收录的短码原样显示：宁可显示生僻短码，也不要把诊断信息吞掉。
    const REASON_KEYS = {
      'storage-not-composed': 'source.reason.storage-not-composed',
      'vocabulary-unavailable': 'source.reason.vocabulary-unavailable',
      'open-failed': 'source.reason.open-failed'
    }

    // ── 折叠状态持久化 ──────────────────────────────────────────────────
    //
    // 只记「手动展开过」或「手动收起过」的卡片 id —— 现在默认态由卡片自己决定
    // （要改的默认展开、只是查看的默认收起，见 DEFAULT_COLLAPSED），所以必须
    // 记住**两个方向**，不能只记一个。
    //
    // 键名从 dsh-anima:collapsed-cards 换成 dsh-anima:card-state：语义反了
    // （旧键记「收起的」，在新规则下「收起的」反而是默认态），沿用旧键会让
    // 以前手展开过的卡在新版本里永久收起、点一下才对、下次又错。
    const CARD_STATE_KEY = 'dsh-anima:card-state'

    function readCardState() {
      try {
        const raw = globalThis.localStorage?.getItem(CARD_STATE_KEY)
        if (!raw) return {}
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
        const out = {}
        // 只认布尔：存进去的脏值（0、"yes"、嵌套对象）一律丢弃，回落到卡片的
        // 默认态，否则一次手改 localStorage 就能让某张卡永远打不开。
        for (const [key, value] of Object.entries(parsed)) {
          if (value === true || value === false) out[key] = value
        }
        return out
      } catch {
        return {}
      }
    }

    function writeCardState(value) {
      try {
        globalThis.localStorage?.setItem(CARD_STATE_KEY, JSON.stringify(value))
      } catch {
        // 存不下就算了：下次打开会回到默认态，不影响任何设置本身。
      }
    }

    /** 读上次停在的分区。任何异常/脏值都退回第一栏 —— 打不开设置页比记不住更糟。 */
    function readActiveSection() {
      try {
        const raw = globalThis.localStorage?.getItem(ACTIVE_SECTION_KEY)
        if (!raw) return SECTION_IDS[0]
        // 存的是裸字符串而不是 JSON：只有一个小写标识符，没必要为它解析一次。
        return SECTION_IDS.includes(raw) ? raw : SECTION_IDS[0]
      } catch {
        return SECTION_IDS[0]
      }
    }

    function writeActiveSection(id) {
      try {
        globalThis.localStorage?.setItem(ACTIVE_SECTION_KEY, id)
      } catch {
        // 存不下就每次回到第一栏，不影响任何设置本身。
      }
    }

    /** 某张卡片属于哪一栏。找不到时回 null —— 新加的卡片忘了登记也不该整页崩。 */
    function sectionOfCard(cardId) {
      for (const section of SECTIONS) if (section.cards.includes(cardId)) return section.id
      return null
    }

    function reasonText(t, reason) {
      if (!reason) return ''
      const text = String(reason)
      if (text === 'open-failed' || text.startsWith('open-failed:')) {
        const detail = text.slice('open-failed'.length).replace(/^:\s*/, '')
        return `${t(REASON_KEYS['open-failed'])}${detail}`
      }
      const key = REASON_KEYS[text]
      return key ? t(key) : text
    }

    function Pre(props) {
      return e('pre', { className: 'an-pre' }, props.text ?? '')
    }

    function Hint(props) {
      return e('div', { className: 'an-hintline' }, props.children)
    }

    /**
     * 分区导航。一排横向标签，只切换「显示哪一栏」，不改任何设置值。
     *
     * 刻意不用下拉框：分区只有五栏，横排一眼能看全，也能直接看出「原来还有
     * 别的页」，而下拉把这件事藏进一次点击之后。
     */
    function SectionNav(props) {
      const t = typeof props.t === 'function' ? props.t : FALLBACK_T
      return e('div', { className: 'an-sectnav', role: 'tablist' },
        SECTIONS.map((section) =>
          e('button', {
            key: section.id,
            type: 'button',
            role: 'tab',
            className: `an-sectnav-tab${props.active === section.id ? ' an-sectnav-tab-on' : ''}`,
            'aria-selected': props.active === section.id ? 'true' : 'false',
            onClick: () => {
              if (typeof props.onSelect === 'function') props.onSelect(section.id)
            }
          }, t(`section.${section.id}`))
        )
      )
    }

    function ErrorBox(props) {
      if (!props.error) return null
      return e('div', { className: 'an-error' }, String(props.error))
    }

    function Toggle(props) {
      const id = `an-${props.id}`
      return e('div', { className: 'an-toggle-row' },
        e('input', {
          id,
          type: 'checkbox',
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.checked)
        }),
        e('label', { htmlFor: id }, props.label)
      )
    }

    function Card(props) {
      // 折叠是可选能力：给了 id 才有折叠按钮，且状态由父组件持有 —— 卡片之间
      // 不共享 JS 状态，但共享同一份落盘结果（localStorage）。
      //
      // 这里刻意不自己 useState：Card 会被渲染成树里的一层，而测试与其它遍历式
      // 代码会「就地调用」函数组件。一旦它在遍历期分配 hook 槽位，就会挤进真实
      // 渲染用的索引池。状态放在设置页顶层，组件本身保持纯函数。
      const id = typeof props.id === 'string' && props.id ? props.id : ''
      const collapsed = props.collapsed === true
      const t = typeof props.t === 'function' ? props.t : FALLBACK_T
      // 不在当前分区里的卡片用 display:none 藏起来，而不是不渲染。
      //
      // 两种「藏」的差别在这里是要紧的：不渲染会把这张卡里的未保存表单值、
      // 折叠态、展开的预览一起丢掉，用户切个分区回来发现刚敲的字没了。
      // 用 CSS 藏则整棵子树还在，只是看不见 —— 代价是首屏 DOM 不变小。
      const hidden = props.hidden === true
      // 折叠按钮的四个取值先算出来再拼元素：原来是 `id ? e(...) : null` 里面又套了
      // 两个三元（标题、aria-expanded），规则明确禁止嵌套三元，读起来也确实费劲。
      const toggleLabel = collapsed ? t('card.expand') : t('card.collapse')
      const ariaExpanded = collapsed ? 'false' : 'true'
      let toggle = null
      if (id) {
        toggle = e('button', {
          type: 'button',
          className: 'an-card-toggle',
          'aria-expanded': ariaExpanded,
          title: toggleLabel,
          onClick: () => { if (typeof props.onToggle === 'function') props.onToggle(id) }
        }, toggleLabel)
      }
      return e('section', {
        className: `an-card${collapsed ? ' an-card-collapsed' : ''}`,
        'data-an-card': id || undefined,
        style: hidden ? { display: 'none' } : undefined
      },
        e('div', { className: 'an-card-head' },
          e('div', { className: 'an-minw0' },
            e('h3', { className: 'an-card-title' }, props.title),
            props.desc ? e('p', { className: 'an-card-desc' }, props.desc) : null
          ),
          e('div', { className: 'an-card-aside' },
            props.aside ?? null,
            toggle
          )
        ),
        collapsed ? null : props.children
      )
    }

    // 哪些卡默认收起：判据是「你是来改东西的，还是来查东西的」。
    //
    // 用户原话：「每个正常人类打开这个设置肯定是想改这个设置相关的东西，
    // 比如人设就改人设」。所以人设/预设/表现三栏全展开；记忆栏里「待审」
    // 和「手动添加」要展开（那是要动手的），「已采纳」只是一份清单，收起；
    // 高级栏的工作区是要动配置的，展开；预览是查看结果，收起。
    // 变更记录不在 Card 体系里，它常驻在页面顶部，永远可见。
    const DEFAULT_COLLAPSED = { mem: false, preview: true }

    // 卡片此刻该不该收起：用户手动改过就听用户的，没改过就看默认表。
    // 默认表里没有的卡片一律展开 —— 新加的卡默认看得见，比默认藏起来安全。
    function cardCollapsed(id, overrides) {
      if (overrides && typeof overrides[id] === 'boolean') return overrides[id]
      return DEFAULT_COLLAPSED[id] === true
    }

    // ── 光轨实现 ────────────────────────────────────────────────────────
    //
    // 做法：往输入框卡片里插一层绝对定位的 SVG，画 8 条同心的圆角矩形描边，
    // 每条只露出一小段虚线（stroke-dasharray "12 88"）并按层号错开相位，
    // 动画让虚线段绕周长跑一圈 —— 叠起来就是「一圈光在环绕」。
    //
    // 三个必须自守的边界（都是某同类人设插件踩过并写进注释的坑）：
    //   ① 尺寸自反馈：SVG 挂进卡片后若参与布局，宿主会变大 → ResizeObserver 回调
    //      → 再变大。故 SVG 自身 pointer-events/contain 全关，且尺寸超上限就自毁。
    //   ② 样式被覆盖：第三方 CSS 若把 position 改掉，光轨会跑到整个页面上去。
    //      挂载后自检一次计算样式，不对就禁用。
    //   ③ 闪帧：挂载那一帧还没读到运行态，先按「关」渲染，拿到状态再决定。
    const SVG_NS = 'http://www.w3.org/2000/svg'

    /** 画 8 层描边（不含尺寸与位置 —— 那些由 sizeTrailSvg 按宿主实测填）。 */
    function buildTrailSvg() {
      const svg = document.createElementNS(SVG_NS, 'svg')
      svg.setAttribute('class', 'an-trail-svg')
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute('fill', 'none')
      for (let layer = 0; layer < TRAIL_LAYERS; layer += 1) {
        const rect = document.createElementNS(SVG_NS, 'rect')
        rect.setAttribute('class', 'an-trail-layer')
        rect.setAttribute('data-layer', String(layer))
        rect.setAttribute('fill', 'none')
        rect.setAttribute('pathLength', '100')
        rect.setAttribute('stroke-dasharray', `${TRAIL_DASH} ${100 - TRAIL_DASH}`)
        rect.setAttribute('stroke-dashoffset', String(layer * TRAIL_LAYER_STEP))
        rect.setAttribute('rx', String(TRAIL_RADIUS))
        svg.appendChild(rect)
      }
      return svg
    }

    /** 按宿主的边框盒算出光轨外框，并把每层矩形摆到宿主内缩 PAD 的位置。 */
    function sizeTrailSvg(svg, host, width, height) {
      const computed = globalThis.getComputedStyle ? globalThis.getComputedStyle(host) : null
      const borderX = computed ? parseFloat(computed.borderLeftWidth) || 0 : 0
      const borderY = computed ? parseFloat(computed.borderTopWidth) || 0 : 0
      const boxW = width + borderX * 2 + TRAIL_PAD * 2
      const boxH = height + borderY * 2 + TRAIL_PAD * 2

      const key = `${width}x${height}`
      if (svg.dataset.trailKey === key) return { boxW, boxH }
      svg.dataset.trailKey = key
      svg.setAttribute('viewBox', `0 0 ${boxW} ${boxH}`)
      svg.setAttribute('width', String(boxW))
      svg.setAttribute('height', String(boxH))
      // 外框比宿主大出 PAD，故往左上挪半个 PAD 再减掉边框宽度
      for (const rect of svg.querySelectorAll('.an-trail-layer')) {
        rect.setAttribute('x', String(TRAIL_PAD))
        rect.setAttribute('y', String(TRAIL_PAD))
        rect.setAttribute('width', String(width))
        rect.setAttribute('height', String(height))
      }
      return { boxW, boxH }
    }

    /**
     * 把光轨挂到宿主元素上。
     * @returns {{svg: SVGElement, setVisible: Function, unmount: Function}|null}
     */
    function mountTrailRing(host, anchor) {
      if (!host || !anchor || !anchor.appendChild) return null
      // 光轨是纯粹的界面装饰：拿不到建 SVG 的能力时直接不接管，而不是抛出去。
      // 与 registerSettingsNavIcon 同一条原则 —— 锦上添花的东西不该让整个
      // 客户端装载失败。真实浏览器永远有 createElementNS，这条守的是受限环境
      // （以及把客户端放进无 DOM 替身里跑的测试）。
      if (typeof document === 'undefined' || typeof document.createElementNS !== 'function') return null
      const svg = buildTrailSvg()
      // 内联样式必须写死在这，不能只靠样式表：这套属性的作用就是「让 SVG 不参与
      // 任何布局与命中测试」，少一条都可能触发上面的尺寸自反馈。
      svg.style.cssText = [
        'position:absolute',
        'display:none',
        'pointer-events:none',
        'contain:strict',
        'overflow:hidden',
        'margin:0',
        'padding:0',
        'border:0',
        'transform:none',
        'animation:none',
        'max-width:none',
        'max-height:none'
      ].join(';')

      let disabled = false
      let observer = null
      const disable = () => {
        disabled = true
        svg.style.display = 'none'
        if (observer && typeof observer.disconnect === 'function') observer.disconnect()
        observer = null
      }

      const sync = () => {
        if (disabled) return
        const width = host.offsetWidth
        const height = host.offsetHeight
        if (!width || !height) return
        if (width > TRAIL_MAX_SIDE || height > TRAIL_MAX_SIDE) {
          disable()
          return
        }
        sizeTrailSvg(svg, host, width, height)
      }

      anchor.appendChild(svg)
      sync()

      // 一次性自检：样式表若把 position 覆盖掉，光轨会脱离卡片铺满页面。
      // 只在挂载后查一次 —— 用户中途换主题导致的重算不值得每帧都查。
      const computed = globalThis.getComputedStyle ? globalThis.getComputedStyle(svg) : null
      if (computed && computed.position !== 'absolute') {
        disable()
        return { svg, setVisible: () => {}, unmount: () => { svg.remove() } }
      }

      if (typeof globalThis.ResizeObserver === 'function') {
        observer = new globalThis.ResizeObserver(() => sync())
        observer.observe(host)
      }

      return {
        svg,
        setVisible(visible) {
          if (disabled) return
          svg.style.display = visible ? 'block' : 'none'
        },
        unmount() {
          if (observer && typeof observer.disconnect === 'function') observer.disconnect()
          observer = null
          if (svg.parentNode) svg.parentNode.removeChild(svg)
        }
      }
    }

    /**
     * 设置页里的光轨配色预览。
     *
     * 复用 composer 上那套 mountTrailRing —— 它只要求「一个用来量尺寸的元素」
     * 和「一个用来 appendChild 的父元素」，与输入框没有耦合。这样预览与实际
     * 效果共用同一段绘制代码，不会出现「预览好看、真跑起来不一样」。
     *
     * 两种状态刻意分开：
     *   - 总开关开着 ⇒ 环在跑（data-an-trail="on"，预览框让出自己的描边）
     *   - 总开关关着 ⇒ 环静止但**仍然画出来**（data-an-trail="static"）。
     *     直接设成 "off" 会被 `[data-an-trail="off"] .an-trail-svg{display:none}`
     *     整条隐藏，用户就看不到自己选的配色了 —— 而调色时最需要看见它。
     */
    function TrailPreview(props) {
      const t = typeof props.t === 'function' ? props.t : FALLBACK_T
      // 用 ref 回调 + state 代替 useRef：客户端 builtin 只有 React 三件套，
      // 而渲染替身连 useRef 都没有。ref 回调是标准 React 用法，两边都不会出事。
      const [host, setHost] = React.useState(null)
      const [mounted, setMounted] = React.useState(null)
      const enabled = props.enabled === true
      const color = safeTrailColor(props.color)
      const speed = TRAIL_SPEED_VALUES.includes(props.speed) ? props.speed : 'slow'
      const width = TRAIL_WIDTH_VALUES.includes(props.width) ? props.width : 'thin'

      React.useEffect(() => {
        if (!host || typeof mountTrailRing !== 'function') return undefined
        const ring = mountTrailRing(host, host)
        setMounted(ring)
        return () => {
          if (ring && typeof ring.unmount === 'function') ring.unmount()
        }
      }, [host])

      React.useEffect(() => {
        if (!host) return
        host.setAttribute('data-an-trail', enabled ? 'on' : 'static')
        host.setAttribute('data-an-trail-static', enabled ? 'off' : 'on')
        host.setAttribute('data-an-trail-speed', speed)
        host.setAttribute('data-an-trail-width', width)
        if (host.style) host.style.setProperty('--an-trail-color', color)
        if (mounted && typeof mounted.setVisible === 'function') mounted.setVisible(true)
        // 卸载交给「挂载」那个 effect 的清理函数：那是一处一定会跑的真实生命周期。
        // 设置页被整体卸载时它才生效 —— 正常情况下这块预览一直挂在设置页里。
      }, [host, mounted, enabled, color, speed, width])

      return e('div', { className: 'an-trail-preview', ref: setHost },
        e('span', { className: 'an-trail-preview-label' }, t('trail.preview'))
      )
    }

    /**
     * 工作区覆盖用的自由文本输入。
     *
     * 覆盖语义下「没填」是第三种状态（继承全局），而全局表单里「没填」就是没要求 ——
     * 这两种含义必须在界面上分得开。旧版靠下拉里的一个空前缀项来承担，现在字段
     * 改成自由文本后，改用「placeholder 放全局当前值 + 下方一行说明当前是继承还是覆盖」。
     */
    function overrideInput(props) {
      const field = props.field

      return e('div', { className: 'an-field' },
        e('label', { htmlFor: `an-${props.id}` }, props.label),
        e('textarea', {
          id: `an-${props.id}`,
          className: 'an-textarea',
          value: props.value ?? '',
          maxLength: props.maxLength,
          placeholder: props.placeholder ?? '',
          onChange: (event) => props.onChange(field, event.target.value)
        }),
        props.hint ? e(Hint, null, props.hint) : null
      )
    }

    /**
     * 工作区覆盖字段下方那行说明。
     *
     * 自由文本下「空」有两种读法，必须说清是哪一种：输入框空着 ⇒ 本工作区不覆盖，
     * 沿用全局；输入框有内容 ⇒ 本工作区用自己的。全局值放进 placeholder，是因为
     * 用户最常问的就是「不填的话会怎么样」。
     */
    const wsFieldHint = (globalValue, localValue, t) => {
      const globalText = typeof globalValue === 'string' && globalValue.trim() ? globalValue.trim() : ''
      const overridden = typeof localValue === 'string' && localValue.trim() !== ''
      if (overridden) return t('ws.overrideNow')
      return globalText
        ? `${t('ws.inheritNow')}　${globalText}`
        : `${t('ws.inheritNow')}　${t('ws.inheritEmpty')}`
    }

    /**
     * 「一键填入」按钮组。
     *
     * 旧版这里是一个下拉框：五个风格档位、三个特质档位各占一项。改成自由文本后
     * 那些档位并没有消失，而是降级成了「一段现成的说法」——点一下填进输入框，
     * 之后随便改。保留它们的理由是：多数人不想从零写风格描述，但也不该被锁死在
     * 五个选项里。
     *
     * 文案来自 host 随 /state 下发的 wording（见 lib/wording.mjs）。按钮上只放短
     * 标签，完整文案放在 title 里 —— 一段 40 字的说明塞进按钮会把整行撑爆。
     */
    function wordingPicker(props) {
      const options = Array.isArray(props.options) ? props.options : []
      if (options.length === 0) return null

      return e('div', { className: 'an-fill' },
        e('span', { className: 'an-fill-label' }, props.label),
        options.map((option) =>
          e('button', {
            key: option.id,
            type: 'button',
            className: 'an-chip',
            title: option.text,
            onClick: () => props.onFill(option.text)
          }, props.labelOf ? props.labelOf(option.id) : option.id)
        )
      )
    }

    /**
     * 全局表单里的一个风格字段：多行输入 + 一键填入按钮组。
     *
     * 输入框本体不用受控的 `value` 与 textarea 的 `maxLength` 打架：长度上限由
     * host 的 sanitizeConfig 兜底（超限会带着字段名报错），这里只做展示计数，
     * 免得用户打了 400 字才在保存时被告知超了。
     */
    function wordingField(props) {
      const value = props.value ?? ''
      const limit = props.limit

      return e('div', { className: 'an-field' },
        e('label', { htmlFor: `an-${props.id}` }, props.label),
        e('textarea', {
          id: `an-${props.id}`,
          className: 'an-textarea',
          value,
          maxLength: limit,
          placeholder: props.placeholder ?? '',
          onChange: (event) => props.onChange(event.target.value)
        }),
        e(Hint, null, limit
          ? `${props.hint ?? ''}　${value.length}/${limit}`
          : props.hint),
        e(wordingPicker, {
          label: props.fillLabel,
          options: props.options,
          labelOf: props.labelOf,
          onFill: props.onChange
        })
      )
    }

    /**
     * 把一段示例压成按钮上的短标签。
     *
     * 示例是一整段话（「研究生在读，方向是自然语言处理……」），原样塞进按钮会把整行
     * 撑爆，所以取到第一个句号/换行为止，超长再截断。用户扫一眼按钮就能认出
     * 「这是不是在说我」，点开之前不必读全文 —— 全文仍在 title 里。
     */
    const exampleLabel = (text, limit = 14) => {
      const flat = String(text).split('\n')[0].trim()
      const stop = flat.search(/[。！？!?；;]/)
      const head = stop > 0 ? flat.slice(0, stop) : flat
      return head.length > limit ? `${head.slice(0, limit)}…` : head
    }

    /**
     * 示例按钮组（身份与背景字段用）。
     *
     * 与 wordingPicker 长得一样，语义不同，所以分成两个组件而不是加一个开关：
     * 风格档位是「点一下定稿」，示例是「点一下填进去、还要改成你自己的」——
     * 后者必须带一句提醒，否则用户会照抄「三年前端开发，主要写 React」并一直用下去。
     * 用户 m08898 要的正是「告诉别人自定义的时候要怎么设定」。
     */
    function examplePicker(props) {
      const options = Array.isArray(props.options) ? props.options : []
      if (options.length === 0) return null

      return e('div', { className: 'an-fill' },
        e('span', { className: 'an-fill-label' }, props.label),
        options.map((option) =>
          e('button', {
            key: option.id,
            type: 'button',
            className: 'an-chip',
            title: option.text,
            onClick: () => props.onFill(option.text)
          }, exampleLabel(option.text))
        )
      )
    }

    // -------------------------------------------------------------------------
    // 记忆条目
    // -------------------------------------------------------------------------

    function MemoryItem(props) {
      const t = props.t
      const record = props.record
      const busy = props.busy === true
      const meta = []
      if (record.capturedAt) meta.push(shortTime(record.capturedAt))
      if (record.source) meta.push(`来源：${record.source}`)
      if (record.scope) meta.push(`作用域：${record.scope}`)
      if (record.note) meta.push(`备注：${record.note}`)

      // 分类 / 状态 / 复核点 / 出处。
      //
      // 这四项以前只在 JSON 里能看到，等于「记了但你看不见」：一条记忆属于
      // 事实还是偏好，决定它该不该按同一速度衰减；复核点过期意味着它可能已经
      // 不成立；出处决定它能不能被核对。看不见这三样，用户就只能选择相信整份记忆库。
      const badges = []
      const typeKey = TYPE_TAG_KEY[record.type]
      if (typeKey) badges.push(e('span', { className: 'an-badge' }, t(typeKey)))
      const stateKey = STATE_TAG_KEY[record.state]
      if (stateKey) {
        // 「曾如此 / 有争议」与「已采纳」在语义上是冲突的两件事（一个是历史，一个是身份），
        // 所以状态徽章加一圈提示，别让人以为它还现行。
        badges.push(e('span', { className: 'an-badge', title: t('mem.stateHint') }, t(stateKey)))
      }

      const extra = []
      if (record.verifyAt) {
        // 过期与否由日期算，不由我判断 —— 日历说的和「还算不算数」是两件事，
        // 这里只报日历，不替用户裁「这点已经作废」。
        const overdue = String(record.verifyAt) < new Date().toISOString().slice(0, 10)
        extra.push(`${t('mem.verifyAt')}：${record.verifyAt}${overdue ? `（${t('mem.verifyOverdue')}）` : ''}`)
      }
      if (record.sourceRef) extra.push(`${t('mem.sourceRef')}：${record.sourceRef}`)

      // 元数据编辑表单。只在「正在编辑这一条」时出现 —— 常驻会让每一条记忆
      // 都变成一个四行表单，扫一遍库变成苦差事。
      const editing = props.metaEditing === true
      const draft = props.metaDraft ?? {}
      // 已采纳的条目才给「改元数据」按钮：待审的还没决定要不要，先改分类是本末倒置。
      // onClick 与文案在元素树外算好 —— 它们若留在 e(...) 参数里就会落进外层三元的
      // consequent，构成嵌套三元（规则禁止）。
      const metaLabel = editing ? t('mem.editMetaHide') : t('mem.editMeta')
      const metaOnClick = editing ? props.onCancelMeta : () => props.onStartMeta(record)
      let metaEditButton = null
      if (props.status === 'adopted') {
        metaEditButton = e('button', {
          type: 'button',
          className: 'an-btn an-btn-sm',
          disabled: busy,
          onClick: metaOnClick
        }, metaLabel)
      }
      const form = editing
        ? e('div', { className: 'an-field an-mt10' },
            e('label', null, t('mem.type')),
            e('select', {
              className: 'an-select',
              value: draft.type ?? 'fact',
              onChange: (event) => props.onChangeMeta('type', event.target.value)
            },
              MEMORY_TYPE_VALUES.map((value) =>
                e('option', { key: value, value }, t(TYPE_TAG_KEY[value]))
              )
            ),
            e(Hint, null, t('mem.metaTypeHint')),

            e('label', null, t('mem.stateCurrent')),
            e('select', {
              className: 'an-select',
              value: draft.state ?? 'current',
              onChange: (event) => props.onChangeMeta('state', event.target.value)
            },
              MEMORY_STATE_VALUES.map((value) =>
                e('option', { key: value, value }, t(MEMORY_STATE_LABEL_KEY[value]))
              )
            ),
            e(Hint, null, t('mem.metaStateHint')),

            e('label', null, t('mem.verifyAt')),
            e('input', {
              className: 'an-input',
              type: 'date',
              value: draft.verifyAt ?? '',
              onChange: (event) => props.onChangeMeta('verifyAt', event.target.value)
            }),
            e(Hint, null, t('mem.metaVerifyHint')),

            e('label', null, t('mem.sourceRef')),
            e('input', {
              className: 'an-input',
              type: 'text',
              value: draft.sourceRef ?? '',
              maxLength: 200,
              onChange: (event) => props.onChangeMeta('sourceRef', event.target.value)
            }),
            e(Hint, null, t('mem.metaSourceHint')),

            e('div', { className: 'an-actions' },
              e('button', {
                type: 'button',
                className: 'an-btn an-btn-sm an-btn-primary',
                disabled: busy,
                onClick: () => props.onSaveMeta(record.id)
              }, t('mem.saveMeta')),
              e('button', {
                type: 'button',
                className: 'an-btn an-btn-sm',
                disabled: busy,
                onClick: props.onCancelMeta
              }, t('common.cancel'))
            )
          )
        : null

      return e('div', { className: 'an-item' },
        e('div', { className: 'an-item-main' },
          e('div', { className: 'an-item-text' }, record.text),
          e('div', { className: 'an-item-meta' },
            e('span', { className: 'an-badge' }, t(STATUS_TAG_KEY[record.status] ?? 'mem.pendingTag')),
            badges,
            meta.map((text, index) => e('span', { key: index }, text))
          ),
          extra.length > 0 ? e('div', { className: 'an-item-meta' }, extra.map((text, index) => e('span', { key: index }, text))) : null,
          form
        ),
        e('div', { className: 'an-item-actions' },
          props.status === 'pending'
            ? e('button', {
                type: 'button',
                className: 'an-btn an-btn-sm an-btn-primary',
                disabled: busy,
                onClick: () => props.onDecide(record.id, 'adopt')
              }, t('mem.adopt'))
            : null,
          props.status === 'pending'
            ? e('button', {
                type: 'button',
                className: 'an-btn an-btn-sm',
                disabled: busy,
                onClick: () => props.onDecide(record.id, 'discard')
              }, t('mem.discard'))
            : null,
          // 元数据只对已采纳的条目开：待审的还没决定要不要，先改分类是本末倒置。
          // 编辑态的按钮文案与回调先算好，避免在元素树里套三元（规则禁止）。
          metaEditButton,
          e('button', {
            type: 'button',
            className: 'an-btn an-btn-sm an-btn-danger',
            disabled: busy,
            onClick: () => props.onDelete(record.id)
          }, t('mem.remove'))
        )
      )
    }

    /**
     * 「注入情况」——本插件相对多数记忆实现的差异点：注入不是黑箱。
     *
     * 用户看得见每一条**为什么**没进去（属于别的工作区 / 超条数 / 超字符预算 /
     * 记忆层关着），而不是面对一个静默截断的列表。宿主已在 /state 里算好，
     * 这里只负责画。
     */
    function InjectionPanel(props) {
      const t = props.t
      const state = props.state
      const controller = props.controller
      const open = state.showInjection === true
      const injection = state.injection ?? { decisions: [], budget: null, cwd: '' }
      const decisions = Array.isArray(injection.decisions) ? injection.decisions : []
      const budget = injection.budget ?? null
      const included = decisions.filter((d) => d.included === true)
      const excluded = decisions.filter((d) => d.included !== true)

      const toggle = () => controller.store.update((s) => { s.showInjection = !s.showInjection })

      // 条数与字符各画一行进度。字符预算为 0 表示没设上限，这时不画 ——
      // 一条永远空着的进度条比没有更让人困惑。
      const bars = []
      if (budget) {
        if (budget.maxCount > 0) {
          bars.push(['inj.count', budget.usedCount ?? 0, budget.maxCount])
        }
        if (budget.maxChars > 0) {
          bars.push(['inj.chars', budget.usedChars ?? 0, budget.maxChars])
        }
      }

      // 字节不画成「用了 / 上限」：字符预算没有对应的字节上限，硬凑一个分母
      // （比如 maxChars * 3）就是编一个数字让人误会。只报实际占用。
      const usedBytes = budget?.maxChars > 0 ? (budget.usedBytes ?? 0) : 0

      // 卡在哪个闸：只有真的卡住了才显示。没卡时显示「没卡」等于
      // 在常驻界面上挂一句永远成立的话，看久了就没人再读它。
      const limitKey = {
        count: 'inj.limitedByCount',
        chars: 'inj.limitedByChars'
      }[budget?.limitedBy]

      // 因预算没带上的条数：与宿主 summarizeOmission 同源口径，
      // 客户端不自己再定一套「哪些算预算原因」，否则两处迟早对不上。
      const omitted = excluded.filter((d) => d.reason === 'over-max'
        || d.reason === 'over-budget'
        || d.reason === 'dropped-by-budget').length

      // 已超窗的条数：只在大于 0 时出现。
      // 理由与上面「字符预算为 0 不画进度条」相同 —— 现在 21 条全是 7 天龄、
      // 全部 fresh，常显会长期挂着一个 0；而一个长期不动的数字会让人不再看它，
      // 真跳到 3 条那天也不会被注意到。
      // 只计数、不解释「为什么超窗」：那是 lib/decay.mjs 按日历算的，
      // 客户端不重新实现一遍判据，免得两边哪天算出不同的数。
      const decayedCount = included.filter((d) => d.decayed === true).length

      // 三行「补充用量」各自独立，先收集再决定画不画整块：
      // 直接在元素树里写 `cond ? [...] : []` 会落进外层三元的 consequent（嵌套三元，规则禁止）。
      const usageRows = []
      if (usedBytes > 0) {
        usageRows.push(e('dt', { key: 'bytes-k' }, t('inj.bytes')), e('dd', { key: 'bytes-v' }, String(usedBytes)))
      }
      if (limitKey) {
        usageRows.push(e('dt', { key: 'lim-k' }, t('inj.limitedBy')), e('dd', { key: 'lim-v' }, t(limitKey)))
      }
      if (omitted > 0) {
        usageRows.push(e('dt', { key: 'omit-k' }, t('inj.omitted')), e('dd', { key: 'omit-v' }, String(omitted)))
      }

      // 展开后的决策列表：没有决策时要说「一条都没有」，不能画成空白。
      let decisionList = null
      if (open) {
        if (decisions.length === 0) {
          decisionList = e('div', { className: 'an-empty' }, t('inj.empty'))
        } else {
          decisionList = e('div', { className: 'an-list' },
            // 已注入的排前面：用户最常问的是「模型现在到底知道什么」
            [...included, ...excluded].map((decision) => e('div', {
              key: decision.id,
              className: 'an-item'
            },
              e('div', { className: 'an-item-main' },
                e('div', { className: 'an-item-text' }, decision.text),
                e('div', { className: 'an-item-meta' },
                  e('span', {
                    className: decision.included ? 'an-badge an-badge-ok' : 'an-badge'
                  }, decision.included ? t('inj.included') : t('inj.excluded')),
                  // reasonText 由宿主给（lib/memory.mjs 的 INJECTION_REASON_TEXT），
                  // 客户端不重写一份翻译，否则两处会漂移。
                  e('span', null, decision.reasonText ?? decision.reason)
                )
              )
            ))
          )
        }
      }

      return e('div', { className: 'an-field an-mt16' },
        e('div', { className: 'an-row-between' },
          e('div', { className: 'an-card-title' }, t('inj.title')),
          e('button', {
            type: 'button',
            className: 'an-btn an-btn-sm',
            onClick: toggle
          }, open ? t('inj.hide') : t('inj.toggle'))
        ),
        e(Hint, null, t('inj.desc')),
        // 工作区坐标：注入是按工作区匹配的，看不出「按哪个工作区算的」就没法排查
        e(Hint, null, injection.cwd
          ? `${t('inj.cwd')}：${injection.cwd}`
          : t('inj.cwdNone')),

        // 预算用量常显，不必展开 —— 用户最常问的是「离上限还有多远」，
        // 而展开是为了看**每一条**为什么没进去。两件事的粒度不同。
        bars.length > 0
          ? e('div', { className: 'an-kv an-mt10' },
              bars.map(([labelKey, used, max]) => [
                e('dt', { key: `${labelKey}-k` }, t(labelKey)),
                e('dd', { key: `${labelKey}-v` }, `${used} / ${max}`)
              ]).flat()
            )
          : null,

        decayedCount > 0
          ? e('div', { className: 'an-kv an-mt10' },
              e('dt', null, t('inj.decayed')),
              e('dd', null, String(decayedCount))
            )
          : null,

        // 字节与「卡在哪个闸」：两个都是补上原来只显示字符数造成的误读。
        // 「4000 字」看着很宽裕，中文实际能到 12000 字节；而「只带了 3 条」
        // 到底该删条目还是调预算，取决于卡在哪一闸。
        usedBytes > 0 || limitKey || omitted > 0
          ? e('div', { className: 'an-kv an-mt10' }, usageRows)
          : null,

        decisionList
      )
    }

    /**
     * 聚类与冲突提示。只提示，不自动合并 —— 合并等于替用户写一段他没说过的话，
     * 而本插件的立场是「判断什么值得记交给模型，什么真的生效交给用户」。
     */
    /**
     * 巡夜记录那一行。
     *
     * 用户定的规则（m05776）是「有需要汇报的就汇报，没有就不汇报」。这条规则
     * 有一个必须当场堵住的洞：只报有事之后，「沉默」同时代表两件事 ——
     *   (a) 巡过了，没事
     *   (b) 巡夜那个东西根本没跑 / 坏了
     * 所以**汇报可以不发，记录必须留**。这一行的职责就是把 (a) 和 (b) 分开：
     * 有记录 = 跑过，reported=false = 那次判定为无事；没有这一行 = 从没跑过。
     *
     * 三种态视觉可分：
     *   meta 为空 → 明确说「还没跑过」，不许画成「没事」
     *   reported=false → 说「跑过了，判为无事」，并列出它当时看的是什么
     *   reported=true → 说「跑过了，报过」，带时间
     */
    function PatrolLine(props) {
      const t = props.t
      const meta = props.meta
      const running = props.running === true

      if (!meta) {
        return e('div', { className: 'an-hintline' }, t('patrol.never'))
      }

      const facts = meta.facts ?? {}
      const bits = [
        `${t('patrol.pending')} ${Number(facts.pending) || 0}`,
        `${t('patrol.flagged')} ${Number(facts.flagged) || 0}`,
        `${t('patrol.removed')} ${Number(facts.removed) || 0}`
      ]
      const verdict = meta.reported === true ? t('patrol.reported') : t('patrol.silent')

      // 明细（2026-10-25 加）：`体检问题 3` 只说得出「有几条」，说不出「哪几条」。
      // 汇报消息里点过名，但那是会话历史，翻不到就没了。这里把当晚点到的
      // 那几条直接铺在记录下面 —— 用户想问「是哪条」时不必再跑一次体检。
      const items = Array.isArray(meta.flaggedItems) ? meta.flaggedItems : []
      const dropped = Number(meta.flaggedDropped) || 0

      // 明细块与「还有 n 条没列出」提示。两者都只在有内容时出现，
      // 但判据不同（items 有 vs dropped > 0），先在元素树外算好再拼。
      const droppedHint = dropped > 0
        ? e('div', { className: 'an-hintline' }, t('patrol.moreDropped').replace('{n}', String(dropped)))
        : null
      let details = null
      if (items.length > 0) {
        details = e('div', { className: 'an-mt4' },
          e('div', { className: 'an-note' }, t('patrol.details')),
          e('div', { className: 'an-list an-mt4' },
            items.map((item) => e('div', { key: item.id, className: 'an-item' },
              e('div', { className: 'an-item-main' },
                e('div', { className: 'an-item-text' }, item.detail || item.id),
                e('div', { className: 'an-item-meta' },
                  // 证据是「凭什么说它有问题」的唯一凭据。当初没记（旧记录没有这一栏）
                  // 就如实说没记，不能画一个空徽章冒充「无可奉告」。
                  e('span', null, item.evidence || t('patrol.detailNoEvidence')),
                  ' ',
                  e('span', { className: 'an-badge' }, `/anima mark ${item.id} state=contradicted`)
                )
              )
            ))
          ),
          droppedHint
        )
      }

      return e('div', null,
        e('div', { className: 'an-hintline' },
          e('span', { className: 'an-badge' }, `${t('patrol.last')} ${shortTime(meta.at)}`),
          ' ',
          e('span', null, `${verdict}${running ? `（${t('patrol.running')}）` : ''}`),
          ' ',
          e('span', null, bits.join('｜'))
        ),
        details
      )
    }

    /**
     * 回扫式复盘的记录行。
     *
     * 与巡夜那行同一纪律：**没线索也必须出现**。只报有事的话，
     * 「界面上一片安静」既可能是「扫过，真没有该记的」，也可能是「压根没扫」——
     * 这正是这套记录要消灭的那种沉默。
     *
     * 扫不成的轮次（目录不存在 / Node 不支持 zstd）尤其要说清，
     * 因为那与「扫了 0 个会话」在数字上看不出区别。
     */
    function RetrospectLine(props) {
      const t = props.t
      const meta = props.meta
      const running = props.running === true

      if (!meta) {
        return e('div', { className: 'an-hintline' }, t('retrospect.never'))
      }

      const failed = typeof meta.error === 'string' && meta.error !== ''
      const files = typeof meta.files === 'number' ? meta.files : null
      const days = Number(meta.scannedDays) || 0
      const found = Number(meta.found) || 0

      // 没扫成时不能显示「0 个会话」—— 那个 0 会被读成「扫了，没事」。
      const scope = files === null
        ? t('retrospect.error').replace('{e}', meta.error || '')
        : t('retrospect.scope').replace('{d}', String(days)).replace('{f}', String(files))
      const verdict = failed
        ? ''
        : (found > 0
            ? t('retrospect.found').replace('{n}', String(found))
            : t('retrospect.none'))

      const items = Array.isArray(meta.leads) ? meta.leads : []
      const dropped = Number(meta.leadsDropped) || 0
      const droppedHint = dropped > 0
        ? e('div', { className: 'an-hintline' }, t('retrospect.moreDropped').replace('{n}', String(dropped)))
        : null

      // 明细可能来自更早的那一轮（这一轮没有新线索时会被保留下来）。
      // 不说清它有多旧，用户会以为这是刚才扫出来的。
      const leadsAt = typeof meta.leadsAt === 'string' ? meta.leadsAt : ''
      const older = leadsAt && leadsAt !== meta.scannedAt
        ? e('div', { className: 'an-note' }, t('retrospect.leadsOlder').replace('{t}', shortTime(leadsAt)))
        : null

      let details = null
      if (items.length > 0) {
        details = e('div', { className: 'an-mt4' },
          e('div', { className: 'an-note' }, t('retrospect.details')),
          older,
          e('div', { className: 'an-list an-mt4' },
            items.map((item) => e('div', { key: item.key, className: 'an-item' },
              e('div', { className: 'an-item-main' },
                e('div', { className: 'an-item-text' }, item.text || ''),
                e('div', { className: 'an-item-meta' },
                  // 只给类型徽章，不给「建议记成什么」—— 那等于替用户写他没说过的话。
                  e('span', { className: 'an-badge' }, item.kind || '')
                )
              )
            ))
          ),
          droppedHint
        )
      }

      return e('div', null,
        e('div', { className: 'an-hintline' },
          e('span', { className: 'an-badge' }, `${t('retrospect.last')} ${shortTime(meta.scannedAt)}`),
          ' ',
          e('span', null, `${scope}${verdict ? `｜${verdict}` : ''}${running ? `（${t('retrospect.running')}）` : ''}`)
        ),
        details
      )
    }

    /**
     * 记忆体检面板。
     *
     * 它只报「机器能验的两件事」：路径还在不在、复核点过没过。刻意不显示任何
     * 「这条可能过时了」的语义判断 —— 那等于替用户下结论，而记忆库里一旦出现
     * 用户没说过的话，整个记忆就不可信了。
     *
     * 三种态必须视觉可分：没查过（什么都不画）、查了没事（画结论 + 那句免责）、
     * 查出问题（逐条列出证据与可复制的命令）。把「没查」画成「没事」是这个项目
     * 一直在防的那件事。
     */
    function CheckupPanel(props) {
      const t = props.t
      const result = props.result
      const busy = props.busy === true
      const onRun = props.onRun
      const onApply = props.onApply
      const applyBusy = props.applyBusy

      const flagged = Array.isArray(result?.flagged) ? result.flagged : []
      const checked = result?.checked
      const running = result?.running === true || busy

      // 没查过 vs 查了没事：前者一个字都不说（result 为 null 时整块不画）。
      // 三种结果的画法各不相同，先在元素树外算好 —— 原来全塞在 e(...) 实参里，
      // 构成了外层三元的嵌套（规则禁止），而且缩进一深就看不出哪一层是哪个条件。
      let body = null
      if (result !== null) {
        let cleanNote = null
        if (flagged.length === 0) {
          cleanNote = e('div', { className: 'an-note' }, t('checkup.clean'))
        }
        let flaggedList = null
        if (flagged.length > 0) {
          flaggedList = e('div', { className: 'an-list an-mt8' },
            flagged.map((finding) => {
              const suggestion = finding.suggestion ?? null
              const canApply = Boolean(suggestion && suggestion.state)
              const commandLine = suggestion?.command
                ? e('div', { className: 'an-item-meta' },
                    e('span', null, `${t('checkup.command')}：${suggestion.command}`)
                  )
                : null
              let applyButton = null
              if (canApply) {
                applyButton = e('button', {
                  type: 'button',
                  className: 'an-btn an-btn-sm',
                  disabled: applyBusy === true,
                  onClick: () => onApply(finding)
                }, t('checkup.apply'))
              }
              return e('div', { key: finding.id, className: 'an-item' },
                e('div', { className: 'an-item-main' },
                  e('div', { className: 'an-item-text' }, finding.text),
                  e('div', { className: 'an-item-meta' },
                    (finding.findings ?? []).map((f, index) =>
                      e('span', { key: index, className: 'an-badge' },
                        `${t(CHECKUP_KIND_KEY[f.kind] ?? 'checkup.kindOther')}｜${f.detail}`
                      )
                    )
                  ),
                  // 证据单独一行：这是「凭什么说它有问题」的唯一凭据，
                  // 混在徽章里会被当成标签，而它其实是可复查的断言。
                  e('div', { className: 'an-item-meta' },
                    (finding.findings ?? []).map((f, index) =>
                      e('span', { key: `e-${index}` }, f.evidence)
                    )
                  ),
                  e('div', { className: 'an-item-meta' },
                    e('span', null, `${t('checkup.suggest')}：${suggestion?.state ? suggestion.state : t('checkup.suggestNone')}`)
                  ),
                  commandLine
                ),
                e('div', { className: 'an-item-actions' }, applyButton)
              )
            })
          )
        }
        body = e('div', { className: 'an-mt10' },
          e('div', { className: 'an-note' },
            t('checkup.summary').replace('{checked}', String(checked ?? 0)).replace('{flagged}', String(flagged.length))
          ),
          cleanNote,
          flaggedList,
          // 结果是快照，不是实时状态。不加这句，用户会拿十分钟前的结论
          // 去判断刚改过的记忆。
          e('div', { className: 'an-hintline' }, t('checkup.stale'))
        )
      }

      return e('div', { className: 'an-mt16' },
        e('div', { className: 'an-row-between' },
          e('div', { className: 'an-card-title' }, t('checkup.run')),
          e('button', {
            type: 'button',
            className: 'an-btn an-btn-sm',
            disabled: running,
            onClick: onRun
          }, running ? t('checkup.running') : t('checkup.run'))
        ),
        e(Hint, null, t('checkup.note')),
        body
      )
    }

    function ClusterNotes(props) {
      const t = props.t
      const clusters = Array.isArray(props.clusters) ? props.clusters : []
      const conflicts = Array.isArray(props.conflicts) ? props.conflicts : []
      if (clusters.length === 0 && conflicts.length === 0) return null

      return e('div', { className: 'an-mt12' },
        clusters.map((cluster, index) => e('div', { key: `c-${index}`, className: 'an-note' },
          `${t('cluster.title')}（${t('cluster.similarity')} ${cluster.similarity}）：${(cluster.texts ?? []).join('　|　')}`
        )),
        conflicts.map((conflict, index) => e('div', { key: `f-${index}`, className: 'an-note' },
          `${t('conflict.title')}：${conflict.candidateText}　→　${t('conflict.adopted')}：${conflict.adoptedText}（${t('cluster.similarity')} ${conflict.similarity}）`
        ))
      )
    }

    /**
     * 从别的 AI 一键导入记忆（Phase ②）。
     *
     * 做成卡片内联展开而不是浮层，理由见 CSS 那段注释。两段式对齐的是「人已经在
     * 别处有一段关于自己的对话」这个真实场景：第 1 步给出提示词（复制走），
     * 第 2 步收回结果。
     *
     * 三个刻意的设计：
     *   ① 解析结果先预览、可逐条丢弃、可改层级 —— 归类是**建议**不是判决。切分是
     *      机械的（按列表项/空行），它不知道哪条真的重要，只有用户知道。
     *   ② 导入的是 pending（待审缓冲区），不是直接生效的长期记忆。这一层是整条
     *      记忆路径的立场：写进来容易，生效要人点头。
     *   ③ 面板里不放「全选/全不选」这类批量开关：一次导入最多几十条，逐条扫一遍
     *      本来就是这一步的目的。
     */
    function ImportPanel(props) {
      const t = props.t
      const controller = props.controller
      const spec = props.state?.memoryImport
      const cwd = props.cwd

      // 状态由设置页顶层持有，本组件保持无状态 —— 与 Card 同一条理由：walk() 之类
      // 的遍历式代码会「就地调用」函数组件，组件自己分配 hook 槽位就会挤进真实
      // 渲染用的索引池，且卡片折叠（子树消失）会让索引整体错位。
      //
      // 这一层是把顶层那份对象包成局部名字，下面整段逻辑与有状态版本逐字一致。
      const value = props.value ?? {}
      const setValue = props.setValue
      const open = value.open === true
      const text = typeof value.text === 'string' ? value.text : ''
      const busy = typeof value.busy === 'string' ? value.busy : ''
      const result = value.result ?? null
      const dropped = value.dropped ?? {}
      const layers = value.layers ?? {}
      const copied = value.copied === true
      const error = value.error ?? null
      const setOpen = (next) => setValue({ open: next })
      const setText = (next) => setValue({ text: next })
      const setBusy = (next) => setValue({ busy: next })
      const setResult = (next) => setValue({ result: next })
      const setDropped = (next) => setValue({ dropped: typeof next === 'function' ? next(dropped) : next })
      const setLayers = (next) => setValue({ layers: typeof next === 'function' ? next(layers) : next })
      const setCopied = (next) => setValue({ copied: next })
      const setError = (next) => setValue({ error: next })

      // 老宿主不下发这段配置 ⇒ 不画入口。画一个点了没反应的按钮比没有更糟。
      if (!spec || typeof spec.prompt !== 'string') return null

      const items = Array.isArray(result?.items) ? result.items : []
      const counts = result?.counts ?? {}
      const blocked = Array.isArray(result?.blocked) ? result.blocked : []
      const tooLong = Array.isArray(result?.tooLong) ? result.tooLong : []
      const duplicates = Array.isArray(result?.duplicates) ? result.duplicates : []
      const overflow = Array.isArray(result?.overflow) ? result.overflow : []
      const keptCount = items.filter((_item, index) => dropped[index] !== true).length
      const layerOf = (item, index) => layers[index] ?? item.layer ?? 'global'

      const copyPrompt = async () => {
        setError(null)
        try {
          const clipboard = globalThis.navigator?.clipboard
          if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('no clipboard')
          await clipboard.writeText(spec.prompt)
          setCopied(true)
        } catch {
          // 复制失败不是死路：提示词就在上面，可以手动选中。
          setError(t('imp.copyFailed'))
        }
      }

      const doParse = async () => {
        if (!text.trim() || busy) return
        setBusy('parse')
        setError(null)
        const response = await controller.parseImport(text, cwd)
        setBusy('')
        if (response?.ok === false) {
          setError(response.error)
          // 连上次的预览一起清掉：留着它，界面会一边报「解析失败」一边继续显示
          // 上一段文本的结果区与「导入选中项」按钮，用户会以为失败的是那一段。
          setResult(null)
          setDropped({})
          setLayers({})
          return
        }
        setResult(response)
        setDropped({})
        setLayers({})
      }

      const doCommit = async () => {
        if (busy) return
        const payload = items
          .map((item, index) => ({ item, index }))
          .filter(({ index }) => dropped[index] !== true)
          .map(({ item, index }) => ({ text: item.text, layer: layerOf(item, index) }))
        if (payload.length === 0) return
        setBusy('commit')
        setError(null)
        const response = await controller.commitImport(payload)
        setBusy('')
        if (response?.ok === false) {
          setError(response.error)
          return
        }
        // 宿主回的 added / rejected 都是**记录数组**。这里刻意不写成
        // `response.added.length`：一旦宿主换了形态（比如回计数），读 `.length`
        // 会静默变成 0，提示语就成了「已导入 0 条」而实际成功了。两种形态都认，
        // 认不出来时宁可什么都不说（下面 parts 为空就不弹提示）。
        const countOf = (value) => {
          if (Array.isArray(value)) return value.length
          if (Number.isFinite(value)) return Number(value)
          return 0
        }
        const added = countOf(response?.added)
        const rejected = countOf(response?.rejected)
        const parts = added > 0 ? [t('imp.done').split('{n}').join(String(added))] : []
        if (rejected > 0) parts.push(t('imp.rejectedSome').split('{n}').join(String(rejected)))
        if (parts.length > 0) props.onDone?.(parts.join('　'))
        setResult(null)
        setText('')
        setDropped({})
        setLayers({})
      }

      const closePanel = () => {
        setOpen(false)
        setResult(null)
        setError(null)
      }

      const layerButton = (item, index) => {
        const current = layerOf(item, index)
        return e('span', { className: 'an-import-item-actions' },
          e('button', {
            type: 'button',
            className: `an-btn an-btn-sm${current === 'global' ? ' an-btn-primary' : ''}`,
            title: t('imp.layerToggle'),
            onClick: () => setLayers((prev) => ({ ...prev, [index]: 'global' }))
          }, t('imp.layerGlobal')),
          e('button', {
            type: 'button',
            className: `an-btn an-btn-sm${current === 'workspace' ? ' an-btn-primary' : ''}`,
            title: t('imp.layerToggle'),
            onClick: () => setLayers((prev) => ({ ...prev, [index]: 'workspace' }))
          }, t('imp.layerWorkspace'))
        )
      }

      const header = e('div', { className: 'an-row-between' },
        e('div', { className: 'an-card-title' }, t('imp.open')),
        e('button', {
          type: 'button',
          className: 'an-btn an-btn-sm',
          onClick: () => (open ? closePanel() : setOpen(true))
        }, open ? t('imp.cancel') : t('imp.open'))
      )

      // 面板正文只在打开时构建。原来写成 `open ? e(...) : null`，而它里面又套着
      // 「解析出结果没有」「解析出几条」「这一条是不是被丢掉了」几层三元 ——
      // 规则明确禁止嵌套三元，而且四层缩进之后没人能看出哪个条件管哪一块。
      // 改成顺序构建：每块各自判断，最后拼起来。
      let panelBody = null
      if (open) {
        const copyLabel = copied ? t('imp.copied') : t('imp.copy')
        const parseLabel = busy === 'parse' ? t('imp.parsing') : t('imp.parse')

        let resultBlock = null
        if (result) {
          let itemsBlock = null
          if (items.length === 0) {
            itemsBlock = e('div', { className: 'an-import-summary' }, t('imp.emptyResult'))
          } else {
            itemsBlock = e('div', null,
              items.map((item, index) => e('div', {
                key: `imp-${index}`,
                className: 'an-import-item'
              },
                e('div', { className: 'an-import-item-text' },
                  dropped[index] === true
                    ? e('s', null, item.text)
                    : item.text,
                  // 归类理由放在条目下方：用户看到「本工作区」会立刻问「凭什么」。
                  item.reason ? e('div', { className: 'an-import-summary' }, item.reason) : null,
                  // 同义提示（宿主用 findImportOverlaps 算的）：撞上缓冲区里已有的候选时
                  // 说清「跟哪条像」。只提示 —— 两条都留着也完全合法，用户删哪条由他定。
                  item.overlap
                    ? e('div', { className: 'an-import-summary' },
                      t('imp.overlap').split('{text}').join(String(item.overlap.pendingText ?? '')))
                    : null
                ),
                dropped[index] === true
                  ? e('span', { className: 'an-import-item-actions' },
                    e('button', {
                      type: 'button',
                      className: 'an-btn an-btn-sm',
                      onClick: () => setDropped((prev) => ({ ...prev, [index]: false }))
                    }, t('imp.restore'))
                  )
                  : e('span', { className: 'an-import-item-actions' },
                    layerButton(item, index),
                    e('button', {
                      type: 'button',
                      className: 'an-btn an-btn-sm',
                      onClick: () => setDropped((prev) => ({ ...prev, [index]: true }))
                    }, t('imp.drop'))
                  )
              )),

              e('div', { className: 'an-import-summary' },
                t('imp.selected').split('{n}').join(String(keptCount)).split('{total}').join(String(items.length))
              ),
              e('div', { className: 'an-actions' },
                e('button', {
                  type: 'button',
                  className: 'an-btn an-btn-sm',
                  disabled: keptCount === 0 || busy !== '',
                  onClick: doCommit
                }, busy === 'commit' ? t('imp.committing') : t('imp.commit')),
                e('button', {
                  type: 'button',
                  className: 'an-btn an-btn-sm',
                  disabled: busy !== '',
                  onClick: closePanel
                }, t('imp.cancel'))
              )
            )
          }

          // ── 被拦下的部分：逐类说明为什么没进来 ──
          let blockedBlock = null
          if (blocked.length > 0) {
            blockedBlock = e('div', { className: 'an-import-blocked' },
              e('div', null, t('imp.blockedTitle')),
              blocked.map((entry, index) => e('div', { key: `b-${index}` },
                e('code', null, `[${(entry.credentials ?? []).join(', ')}] `),
                entry.text
              )),
              e('div', null, t('imp.blockedHint'))
            )
          }
          let tooLongBlock = null
          if (tooLong.length > 0) {
            tooLongBlock = e('div', { className: 'an-import-summary' },
              t('imp.tooLongTitle'),
              e('div', null, t('imp.tooLongHint').split('{max}').join(String(500)))
            )
          }
          let duplicatesBlock = null
          if (duplicates.length > 0) {
            duplicatesBlock = e('div', { className: 'an-import-summary' },
              t('imp.duplicateTitle')
            )
          }
          let overflowBlock = null
          if (overflow.length > 0) {
            overflowBlock = e('div', { className: 'an-import-summary' },
              t('imp.overflowTitle'),
              e('div', null, t('imp.overflowHint').split('{max}').join(String(spec.maxItems)))
            )
          }
          let skippedBlock = null
          if (Number(counts.skipped ?? 0) > 0) {
            skippedBlock = e('div', { className: 'an-import-summary' },
              t('imp.skippedHint').split('{n}').join(String(counts.skipped))
            )
          }

          resultBlock = e('div', null,
            e('hr', { className: 'an-import-divider' }),
            e('div', { className: 'an-import-title' }, t('imp.resultTitle')),
            e('div', { className: 'an-import-summary' },
              t('imp.resultCounts')
                .split('{pieces}').join(String(counts.pieces ?? items.length))
                .split('{accepted}').join(String(counts.accepted ?? items.length))
            ),
            itemsBlock,
            blockedBlock,
            tooLongBlock,
            duplicatesBlock,
            overflowBlock,
            skippedBlock
          )
        }

        panelBody = e('div', { className: 'an-import' },
          // ── 第 1 步：提示词 ──
          e('div', { className: 'an-import-step' },
            e('div', null,
              e('div', { className: 'an-import-title' }, t('imp.step1')),
              e(Hint, null, t('imp.step1Hint'))
            ),
            e('button', {
              type: 'button',
              className: 'an-btn an-btn-sm',
              onClick: copyPrompt
            }, copyLabel)
          ),
          e('pre', { className: 'an-import-prompt' }, spec.prompt),

          e('hr', { className: 'an-import-divider' }),

          // ── 第 2 步：粘贴 ──
          e('div', { className: 'an-import-title' }, t('imp.step2')),
          e('div', { className: 'an-field an-mt8' },
            e('textarea', {
              id: 'an-import-text',
              className: 'an-textarea',
              value: text,
              placeholder: t('imp.placeholder'),
              maxLength: spec.maxSource,
              onChange: (event) => setText(event.target.value)
            }),
            e(Hint, null, `${text.length}/${spec.maxSource}`)
          ),
          e('div', { className: 'an-actions' },
            e('button', {
              type: 'button',
              className: 'an-btn an-btn-sm',
              disabled: !text.trim() || busy !== '',
              onClick: doParse
            }, parseLabel)
          ),
          e(ErrorBox, { error }),

          // ── 解析结果 ──
          resultBlock
        )
      }

      return e('div', { className: 'an-mt20' }, header, panelBody)
    }

    /**
     * 一条审计记录。
     *
     * 渲染上的两个取舍：
     *   ① 「原值 → 新值」用并排的两小段，而不是一行字符串拼接 —— 人设字段里
     *      有中文长句（自定义指令、角色描述），拼一行会读不出来；
     *   ② 值恰好相等（presets 这类只记规模的摘要）时只显示一次，不去编造差异。
     *
     * 为什么这里不再有 compact（截断）分支：以前收起态会常驻 3 条预览，
     * 所以需要把 1435 字的长值截成 28 字。现在收起态一行明细都不画，
     * 能看到明细的时候一定是用户主动展开的 —— 那时候他要的就是全文。
     * 留着 compact 只会变成一段永远走不到的代码。
     */
    function AuditItem(props) {
      const t = props.t
      const entry = props.entry
      const sourceText = props.sourceText ?? {}
      const actors = { user: t('audit.actor.user'), agent: t('audit.actor.agent'), system: t('audit.actor.system') }
      const show = (value) => {
        if (value === null || value === '' || value === undefined) return t('audit.emptyValue')
        return String(value)
      }
      const changes = Array.isArray(entry.changes) ? entry.changes : []
      const sourceLabel = sourceText[entry.source] ?? entry.source ?? ''

      return e('div', { className: 'an-item' },
        e('div', { className: 'an-item-main' },
          e('div', { className: 'an-item-meta' },
            // 记录人排在第一位：这份日志存在的理由就是分辨「谁改的」
            e('span', { className: 'an-badge' }, actors[entry.actor] ?? entry.actor),
            e('span', null, shortTime(entry.at)),
            e('span', null, sourceLabel),
            entry.note ? e('span', null, `${t('audit.note')}：${entry.note}`) : null
          ),
          e('div', { className: 'an-audit-changes' },
            changes.map((change, index) => e('div', { key: `${change.key}-${index}`, className: 'an-audit-change' },
              e('span', { className: 'an-audit-key' }, auditFieldLabel(t, change.key)),
              change.from === change.to
                // 摘要值可能相等（[1 项] → [1 项]）：这时编造「从 A 改成 B」是撒谎
                ? e('span', { className: 'an-audit-arrow' }, show(change.to))
                : e('span', { className: 'an-audit-arrow' },
                    e('span', { className: 'an-audit-from' }, show(change.from)),
                    ' → ',
                    e('span', { className: 'an-audit-to' }, show(change.to))
                  )
            ))
          )
        )
      )
    }

    /**
     * 「最近改了什么」—— 设置页顶部的一个**下拉条**，不是常驻卡片。
     *
     * 演进史（三次都记在这里，省得下一个人又改回去）：
     *   ① 最早它是「高级」栏里的一张卡，默认收起、还要再点一次「展开明细」——
     *      用户原话「我根本不知道改成啥了」，等于没有。
     *   ② 后来搬到顶部常驻、默认露最近 3 条。看得见了，但**太大**：每行都带
     *      「原值 → 新值」，一屏吃掉三分之一，用户这次的原话是「太大了占位置不好看」。
     *   ③ 现在折中成下拉：收起态只占**一行**（标题 + 条数 + 箭头），点一下才铺开。
     *      信息还在同一个位置，但不再抢版面。
     *
     * 数据仍分两级：收起态用 /state 随包下发的计数，**不发请求**；
     * 展开才打 /audit 取全量 —— 首屏不该为一份日志等。
     */
    function RecentChanges(props) {
      const t = props.t
      const state = props.state
      const controller = props.controller
      const setToast = props.setToast
      const expanded = state.showAudit === true
      const audit = state.audit ?? { entries: [], total: 0, max: 200, sourceText: {} }
      const entries = Array.isArray(audit.entries) ? audit.entries : []
      // 新的在上：读日志的人先关心「刚刚发生了什么」
      const ordered = entries.slice().reverse()
      const shown = expanded ? ordered : []

      const toggle = async () => {
        controller.store.update((s) => { s.showAudit = !s.showAudit })
        if (!expanded) await controller.loadAudit()
      }

      const clear = async () => {
        if (typeof globalThis.confirm === 'function' && !globalThis.confirm(t('audit.clearConfirm'))) return
        const result = await controller.clearAudit()
        if (result?.ok === false) {
          setToast({ kind: 'err', text: result.error })
          return
        }
        setToast({ kind: 'ok', text: t('audit.cleared') })
      }

      const total = audit.total ?? 0

      // 展开后的明细。空态里那句文案本身又是一个三元（「正在加载」vs「确实没有」），
      // 若留在外面就会构成嵌套三元；这里先算好再拼。
      let body = null
      if (expanded) {
        let emptyText = t('audit.empty')
        if (state.auditLoading && entries.length === 0) emptyText = t('audit.loading')
        const listOrEmpty = shown.length === 0
          ? e('div', { className: 'an-empty' }, emptyText)
          : e('div', { className: 'an-list' },
              shown.map((entry) => e(AuditItem, {
                key: entry.id,
                t,
                entry,
                sourceText: audit.sourceText,
                compact: false
              }))
            )
        body = e('div', { className: 'an-recent-body' },
          state.auditError ? e(ErrorBox, { error: state.auditError }) : null,
          listOrEmpty,
          e('div', { className: 'an-actions an-mt10' },
            e('button', {
              type: 'button',
              className: 'an-btn an-btn-sm an-btn-danger',
              disabled: entries.length === 0,
              onClick: clear
            }, t('audit.clear'))
          ),
          // 「只保留最近 200 条」属于说明，只在真正展开看全量时才提一句。
          e(Hint, null, t('audit.maxHint'))
        )
      }

      return e('section', {
        className: 'an-recent',
        // 展开态放 data 属性而不是往 className 里再拼一个词：
        // 树遍历式断言（byClass）按 className 精确匹配，多一个词就让整块失联。
        'data-an-recent': expanded ? 'open' : 'closed'
      },
        // 整行就是那个开关。不再套一个内层按钮：按钮里嵌按钮在 DOM 里是非法结构，
        // 而且下拉的惯例本来就是「整行可点」。
        e('button', {
          type: 'button',
          className: 'an-recent-toggle',
          'aria-expanded': expanded ? 'true' : 'false',
          title: expanded ? t('audit.hide') : t('audit.toggle'),
          onClick: toggle
        },
          e('span', { className: 'an-recent-caret' }, '▶'),
          e('span', { className: 'an-recent-title' }, t('audit.title')),
          // 条数是这一行里唯一必须常驻的数字：它回答「值不值得点开」
          e('span', { className: 'an-badge' }, `${t('audit.total')} ${total} ${t('audit.records')}`.trim())
        ),
        body
      )
    }

    function MemoryList(props) {
      const t = props.t
      const items = Array.isArray(props.items) ? props.items : []
      if (items.length === 0) {
        return e('div', { className: 'an-empty' }, props.emptyText)
      }
      return e('div', { className: 'an-list' },
        items.map((record) => e(MemoryItem, {
          key: record.id,
          t,
          record,
          status: props.status,
          busy: props.busy,
          onDecide: props.onDecide,
          onDelete: props.onDelete,
          // 元数据编辑：只有「已采纳」那一个列表会传这几项。待审与已丢弃传进来
          // 也不会画出按钮（MemoryItem 里按 status 判），多传一层没有副作用。
          metaEditing: props.metaEditingId === record.id,
          metaDraft: props.metaEditingId === record.id ? props.metaDraft : null,
          onStartMeta: props.onStartMeta,
          onCancelMeta: props.onCancelMeta,
          onChangeMeta: props.onChangeMeta,
          onSaveMeta: props.onSaveMeta
        }))
      )
    }

    /**
     * 定出光轨该挂进哪个元素。
     *
     * 槽位给的锚点可能已经被别的插件包了一层，直接 append 会让 SVG 的定位基准
     * 变成中间那层而不是卡片。规则：锚点的父元素就是卡片 ⇒ 用锚点；否则往上找到
     * 「父元素即卡片」的那个祖先；都不满足再退回卡片本身（内联 position 兜底）。
     */
    function resolveTrailMountPoint(card, anchor) {
      if (anchor && anchor.parentElement === card) return anchor
      const parent = anchor && anchor.parentElement
      if (!parent) return card
      let node = parent
      while (node !== card && node.parentElement && node.parentElement !== card) node = node.parentElement
      if (node !== card && node.parentElement === card) return node
      return card
    }

    /**
     * 光轨（挂在 conversation.input.overlay）。
     *
     * 组件本身只输出一个零高度的隐形锚点；真正可见的 SVG 由 effect 手动挂到
     * 输入框卡片上 —— 因为卡片不是我们的子树，拿不到它的尺寸，只能绕过渲染层。
     */
    function AnimaTrail(props) {
      const useSession = props.useSession
      const useStore = props.useAnimaStore
      const running = typeof useSession === 'function'
        ? useSession((snapshot) => snapshot.running === true)
        : false
      const state = typeof useStore === 'function' ? useStore((snapshot) => snapshot) : null
      const anchorRef = React.useRef(null)
      const mountedRef = React.useRef(null)

      React.useEffect(() => {
        const anchor = anchorRef.current
        // 组件位于卡片内的 overlay 锚点中，closest 定位可避免全局查询误命中
        const card = anchor && typeof anchor.closest === 'function'
          ? anchor.closest('[data-composer-card]')
          : null
        if (!card) return undefined

        const mountPoint = resolveTrailMountPoint(card, anchor)
        const mounted = mountTrailRing(card, mountPoint)
        if (!mounted) return undefined
        mountedRef.current = { card, mounted }
        // 先隐藏：effect 在首帧绘制后跑，不先关掉会闪出一帧光轨
        card.setAttribute('data-an-trail', 'off')
        mounted.setVisible(false)
        return () => {
          const current = mountedRef.current
          mountedRef.current = null
          if (!current) return
          current.mounted.unmount()
          current.card.removeAttribute('data-an-trail')
          current.card.removeAttribute('data-an-trail-speed')
          current.card.removeAttribute('data-an-trail-width')
          current.card.style.removeProperty('--an-trail-color')
        }
      }, [])

      // 显隐与外观：只在「Agent 正在回复 + 开关开着」时显示
      React.useEffect(() => {
        const current = mountedRef.current
        if (!current) return
        const { card, mounted } = current
        const enabled = state !== null && state.config?.trailEnabled === true
        const visible = running && enabled
        card.setAttribute('data-an-trail', visible ? 'on' : 'off')
        card.setAttribute('data-an-trail-speed', state?.config?.trailSpeed || 'slow')
        card.setAttribute('data-an-trail-width', state?.config?.trailWidth || 'thin')
        card.style.setProperty('--an-trail-color', safeTrailColor(state?.config?.trailColor))
        mounted.setVisible(visible)
      }, [running, state])

      return e('span', { ref: anchorRef, hidden: true, 'aria-hidden': true })
    }

    /**
     * 输入框左下的快捷开关（挂在 conversation.input.left）。
     *
     * 与设置页里那个总开关是同一个字段：把它放在输入框旁边，是因为「临时关掉
     * 人设」是高频动作，而每次都要开设置页才能关，等于逼用户留着它不关。
     */
    function AnimaQuickToggle(props) {
      const t = typeof props.t === 'function' ? props.t : FALLBACK_T
      const useStore = props.useAnimaStore
      const controller = props.controller
      const state = useStore((snapshot) => snapshot)
      const enabled = state.config?.enabled === true
      const busy = state.saving === true

      const toggle = async () => {
        if (busy) return
        // 刻意只发 enabled 这一个字段：宿主侧是「补丁式」更新，未提供的字段保持
        // 不变。整份 config 回写会把用户在设置页里没保存的编辑一起冲掉。
        await controller.saveConfig({ enabled: !enabled })
      }

      return e('button', {
        type: 'button',
        className: 'an-quick-toggle',
        'data-enabled': enabled ? 'true' : 'false',
        'aria-pressed': enabled,
        'aria-label': enabled ? t('quick.disable') : t('quick.enable'),
        title: enabled ? t('quick.disable') : t('quick.enable'),
        disabled: busy,
        onClick: toggle
      },
        e('span', { className: 'an-quick-toggle-dot', 'aria-hidden': true }),
        enabled ? t('quick.statusEnabled') : t('quick.statusDisabled')
      )
    }

    // -------------------------------------------------------------------------
    // 主设置页
    // -------------------------------------------------------------------------

    function AnimaSettings(props) {
      const t = typeof props.t === 'function' ? props.t : FALLBACK_T
      const useStore = props.useAnimaStore
      const controller = props.controller
      const state = useStore((snapshot) => snapshot)

      const config = state.config
      const limits = state.limits ?? { agentName: 50, agentRole: 800, addressUserAs: 50 }

      /**
       * 宿主配置 → 本地表单。初始渲染与 config 变化后的同步**必须共用同一份**，
       * 否则两边会慢慢长歪（一边漏一个字段，脏检查就会永远说「有未保存的修改」）。
       *
       * 初始渲染就要用它，而不是先摆一份空默认值等 useEffect 来填：useState 的
       * 惰性初始化在首次渲染时就执行，useEffect 要等首帧**绘制之后**才跑。中间
       * 那一帧 config 已有值、local 还是空默认值 ⇒ dirty 为真 ⇒ 用户每次打开
       * 设置页都会先看到一眼「有未保存的修改」和亮起的保存按钮，然后才消失。
       */
      const localFromConfig = (source) => ({
        enabled: source?.enabled !== false,
        ...pickPersona(source),
        workspaceOverridesEnabled: source?.workspaceOverridesEnabled !== false,
        workspaceFileDir: source?.workspaceFileDir ?? '.dsh-anima',
        memory: memoryDefaults(source ?? null),
        quality: qualityDefaults(source ?? null),
        ...toolDefaults(source ?? null)
      })

      const [local, setLocal] = React.useState(() => localFromConfig(config))
      const [wsLocal, setWsLocal] = React.useState(() => personaDefaults())
      const [newMemory, setNewMemory] = React.useState({ text: '', note: '', scope: '' })
      const [presetPick, setPresetPick] = React.useState('')

      // 下面两个派生值必须排在各 useState 之后：它们读 presetPick，
      // 而 const 声明的 useState 结果在声明前落在暂时性死区里，
      // 提前读会直接抛「Cannot access 'presetPick' before initialization」。
      // 当前生效的预设：id 由宿主算好（按字段比对），这里只负责翻成一条记录来显示名字。
      const activePreset = (state.presets ?? []).find((preset) => preset.id === state.activePresetId) ?? null
      // 下拉框的实选值：手动点过就用点的那条，没点过则显示「当前生效」的那条。
      // 两者必须共用同一个值 —— 否则界面显示着 A 而「套用」按钮按的是空值，点了没反应。
      const pickedPresetId = presetPick !== '' ? presetPick : (state.activePresetId ?? '')
      const [presetForm, setPresetForm] = React.useState({ name: '', description: '' })
      const [busyId, setBusyId] = React.useState(null)
      const [toast, setToast] = React.useState(null)
      // 哪些卡片被收起来了。初始值只读一次（useState 的惰性初始化），
      // 之后由 toggleCard 同时改内存与落盘 —— 若每次渲染都重新读 localStorage，
      // 页面上其它地方触发的重渲染会把用户刚展开的卡片又收回去。
      const [cardStateMap, setCardStateMap] = React.useState(() => readCardState())
      // 当前看的是哪一栏。与折叠态一样只在初始化时读一次本地存储，
      // 之后由 setActiveSection 同时改内存与落盘。
      const [activeSection, setActiveSectionState] = React.useState(() => readActiveSection())
      // 预览卡是否展开：直接读卡片折叠态，不再单独存一份。
      // 原来这里有一个独立的 showPreview 开关，叠在卡片折叠之上 —— 二层门，
      // 而且两层的默认态互不相干（卡默认展开、开关默认关），用户点开卡
      // 看到的是一片空，还以为坏了。
      //
      // 必须放在 cardStateMap 之后：const 声明的 useState 结果在声明前落在
      // 暂时性死区里，提前读会抛「Cannot access 'cardStateMap' before
      // initialization」—— 这条注释是踩过一次之后写的。
      const previewOpen = !cardCollapsed('preview', cardStateMap)
      // 导入面板（Phase ②）那一小块的全部状态。刻意提到这一层：ImportPanel 必须
      // 保持无状态（理由见那边的注释），而它内部的交互又比卡片折叠复杂得多 ——
      // 收在这里比在组件内部再摆一排 useState 更贵，但换来的是渲染树可被遍历式调用。
      const [memoryImport, setMemoryImport] = React.useState({})
      // 记忆体检结果。null = 还没查过（此时不画任何结论 —— 「没查」和「查了没事」
      // 必须长得不一样，这是整个项目的立场）。带一个 savedAt，用来在结果旁边
      // 提醒「这是刚才的结果，记忆可能已经变了」。
      const [checkup, setCheckup] = React.useState(null)
      // 巡夜正在跑。单独一个状态而不是复用 checkup.running：巡夜包含整理 + 体检
      // 两步，用体检的运行态画它会让「正在体检」和「正在巡夜」混在一起。
      const [patrolRunning, setPatrolRunning] = React.useState(false)
      // 回扫是另一条独立动作（读磁盘上的旧会话），运行态与巡夜分开：
      // 两者都可能跑几十秒，共用一个布尔会让界面同时显示两个「正在查」。
      const [retrospectRunning, setRetrospectRunning] = React.useState(false)
      // 正在编辑元数据的那条记忆的 id，以及编辑中的草稿。草稿与 record 分开存，
      // 因为取消编辑要能原样丢弃，不该写回 state 快照。
      const [metaEditing, setMetaEditing] = React.useState(null)
      const [metaDraft, setMetaDraft] = React.useState({})

      const setImportState = (patch) => {
        setMemoryImport((prev) => ({ ...prev, ...patch }))
      }

      // 「已复制」两秒后自己退回去：一直挂着会让人以为按钮坏了，再点一次也没反馈。
      React.useEffect(() => {
        if (memoryImport.copied !== true) return undefined
        const timer = setTimeout(() => setImportState({ copied: false }), 2000)
        return () => clearTimeout(timer)
      }, [memoryImport.copied])

      const toggleCard = (id) => {
        if (!id) return
        setCardStateMap((prev) => {
          const next = { ...prev }
          // 记的是「翻转后」的态：先按当前规则算出现在是什么，再取反写死。
          // 直接 delete 等于「回到默认」，只有默认态恰好相反时才表现为翻转，
          // 而用户点按钮的意图永远是「翻一下」，不管默认是什么。
          next[id] = !cardCollapsed(id, prev)
          writeCardState(next)
          return next
        })
      }

      // 每张卡的折叠接线都从这一处来：新增卡片时只要写 id，
      // 不必记得同时传 collapsed 与 onToggle（漏一个就是「按钮点了没反应」）。
      const cardState = (id) => ({ collapsed: cardCollapsed(id, cardStateMap), onToggle: toggleCard })

      const selectSection = (id) => {
        if (!SECTION_IDS.includes(id)) return
        writeActiveSection(id)
        setActiveSectionState(id)
      }

      // 卡片的三态接线：折叠态 + 「此刻是不是在这一栏」。
      // 与 cardState 分开命名而不是加参数，是因为所有调用点都写 `...cardState(id)`，
      // 加参数会静默漏掉后面新增的卡片（漏了就是「点进去什么也没有」）。
      const cardSlot = (id) => ({ ...cardState(id), hidden: sectionOfCard(id) !== activeSection })

      // 服务端状态 → 本地表单
      React.useEffect(() => {
        if (!config) return
        setLocal(localFromConfig(config))
      }, [config])

      // 工作区覆盖 → 本地表单（空串 = 继承全局，不做默认值回退）
      const wsState = state.workspaceState
      React.useEffect(() => {
        setWsLocal(pickOverrides(wsState?.overrides))
      }, [wsState])

      React.useEffect(() => {
        if (toast) {
          const timer = setTimeout(() => setToast(null), 2000)
          return () => clearTimeout(timer)
        }
        return undefined
      }, [toast])

      // 预览：展开时拉一次；之后本地表单每次变化都重新拉（400ms 防抖）。
      // 直接把当前表单值当 query 传给 host，所以未保存的改动也能预览。
      const previewKey = JSON.stringify({ p: pickPersona(local), on: local.enabled !== false, m: local.memory?.enabled, x: local.memory?.maxInjected, w: state.workspacePath })
      React.useEffect(() => {
        if (!previewOpen || !config) return undefined
        const timer = setTimeout(() => {
          controller.loadPreview(state.workspacePath, { ...pickPersona(local), enabledHint: undefined })
        }, 400)
        return () => clearTimeout(timer)
      }, [previewOpen, previewKey])

      const patchLocal = (key, value) => setLocal((prev) => ({ ...prev, [key]: value }))
      const patchMemory = (key, value) => setLocal((prev) => ({ ...prev, memory: { ...prev.memory, [key]: value } }))
      const patchQuality = (key, value) => setLocal((prev) => ({ ...prev, quality: { ...prev.quality, [key]: value } }))
      const patchWs = (key, value) => setWsLocal((prev) => ({ ...prev, [key]: value }))

      // 提交给 host 的载荷形状（保存与脏检查必须完全一致，否则会出现「看着没改却一直脏」）
      const configPayload = (source) => ({
        enabled: source.enabled !== false,
        ...pickPersona(source),
        workspaceOverridesEnabled: source.workspaceOverridesEnabled !== false,
        workspaceFileDir: source.workspaceFileDir ?? '.dsh-anima',
        ...toolDefaults(source),
        quality: qualityDefaults(source),
        // 质检段用 qualityDefaults 归一，理由与 memory 段手写每个数字相同：
        // 非法值必须先被夹到合法集合里再提交，否则宿主 sanitize 会整条拒绝，
        // 而界面已经把用户的选择显示出来了。
        memory: {
          enabled: source.memory?.enabled !== false,
          autoCapture: source.memory?.autoCapture !== false,
          nightlyTriage: source.memory?.nightlyTriage !== false,
          nightlyHour: Number(source.memory?.nightlyHour ?? 3),
          maxPending: Number(source.memory?.maxPending ?? 200),
          maxInjected: Number(source.memory?.maxInjected ?? 40),
          maxInjectedChars: Number(source.memory?.maxInjectedChars ?? 4000),
          notifyOnSessionStart: source.memory?.notifyOnSessionStart !== false,
          // 回扫默认关（=== true 才开），与宿主 config.mjs 的默认值一致；
          // 两边不一致会让「打开设置页看起来是关的，保存后却变成开的」。
          retrospectEnabled: source.memory?.retrospectEnabled === true,
          retrospectDays: Number(source.memory?.retrospectDays ?? 14)
        }
      })

      // dirty 检测（只比参与保存的字段）
      const savedKey = config ? JSON.stringify(configPayload(config)) : ''
      const localKey = JSON.stringify(configPayload(local))
      const dirty = savedKey !== '' && savedKey !== localKey

      // 工作区覆盖的脏检查：两边都过 pickOverrides，空串=继承，形状天然一致
      const wsSaved = wsState ? pickOverrides(wsState.overrides) : null
      const wsDirty = wsSaved ? JSON.stringify(wsSaved) !== JSON.stringify(pickOverrides(wsLocal)) : false

      const doSave = async () => {
        const result = await controller.saveConfig(configPayload(local))
        if (result?.ok === false) {
          setToast({ kind: 'err', text: result.error })
          return
        }
        setToast({ kind: 'ok', text: t('common.saved') })
      }

      const doReset = async () => {
        // 与某同类人设插件删预设同一套写法（globalThis.confirm）：重置会清空
        // 已保存的人设字段，值得一次拦截。非浏览器环境没有 confirm 就直接放行。
        if (typeof globalThis.confirm === 'function' && !globalThis.confirm(t('common.reset.confirm'))) return
        const result = await controller.resetConfig()
        if (result?.ok === false) {
          setToast({ kind: 'err', text: result.error })
          return
        }
        setToast({ kind: 'ok', text: t('common.reset.done') })
      }

      const doSaveWorkspace = async () => {
        if (!state.workspacePath) return
        // 只有非空字段进 overrides —— 空串在工作区文件里表示「继承全局」，
        // 写进去就等于把全局值冻结成工作区值，是覆盖语义里最容易出事的地方。
        const overrides = {}
        for (const key of PERSONA_FIELDS) {
          const value = (wsLocal[key] ?? '').trim()
          if (value) overrides[key] = value
        }
        const result = await controller.saveWorkspace(state.workspacePath, overrides)
        if (result?.ok === false) {
          setToast({ kind: 'err', text: result.error })
          return
        }
        setToast({ kind: 'ok', text: Object.keys(overrides).length === 0 ? t('ws.cleared') : t('ws.saved') })
      }

      // 底部保存栏按一次要落两处：全局配置与工作区覆盖。两者脏状态独立
      // （一个写全局、一个写工作区文件），但用户按的是同一个按钮 ——
      // 只存一边会留下一半「看着存好了其实没存」的改动。
      //
      // 全局那份先存，失败就整条停下（不继续写工作区、也不弹成功提示）。
      // 工作区那份由 doSaveWorkspace 自己弹 toast（保存与清除两种文案不同），
      // 所以它跑过就不再追加一条，避免连弹两个提示。
      const doSaveAll = async () => {
        if (dirty) {
          const result = await controller.saveConfig(configPayload(local))
          if (result?.ok === false) {
            setToast({ kind: 'err', text: result.error })
            return
          }
        }
        if (wsDirty && state.workspacePath) {
          await doSaveWorkspace()
          return
        }
        setToast({ kind: 'ok', text: t('common.saved') })
      }

      const applyPresetById = async () => {
        if (!pickedPresetId) return
        const result = await controller.applyPreset(pickedPresetId)
        if (result?.ok === false) {
          setToast({ kind: 'err', text: result.error })
          return
        }
        // 不在这里清空下拉框了：host 会随下一份 state 给出 activeId，
        // 选中项本来就有了着落 —— 清空反而会让人以为「什么也没生效」。
        setToast({ kind: 'ok', text: `${t('preset.applied')}：${result.applied ?? ''}` })
      }

      const saveCurrentAsPreset = async () => {
        const name = (presetForm.name ?? '').trim()
        if (!name) return
        const preset = {
          name,
          description: (presetForm.description ?? '').trim(),
          fields: configPayload(config ?? local)
        }
        const result = await controller.savePreset(preset)
        if (result?.ok === false) {
          setToast({ kind: 'err', text: result.error })
          return
        }
        setPresetForm({ name: '', description: '' })
        setToast({ kind: 'ok', text: t('preset.saved') })
      }

      const deletePreset = async (id) => {
        const result = await controller.deletePreset(id)
        if (result?.ok === false) {
          setToast({ kind: 'err', text: result.error })
          return
        }
        setToast({ kind: 'ok', text: t('preset.deleted') })
      }

      const decide = async (id, decision) => {
        setBusyId(id)
        const result = await controller.decide(id, decision)
        setBusyId(null)
        if (result?.ok === false) setToast({ kind: 'err', text: result.error })
      }

      const removeMemory = async (id) => {
        setBusyId(id)
        const result = await controller.removeMemory(id)
        setBusyId(null)
        if (result?.ok === false) setToast({ kind: 'err', text: result.error })
      }

      const triageOnce = async () => {
        const result = await controller.runTriage()
        if (result?.ok === false) {
          setToast({ kind: 'err', text: result.error })
          return
        }
        setToast({ kind: 'ok', text: t('mem.triageDone') })
      }

      const patrolOnce = async () => {
        setPatrolRunning(true)
        const result = await controller.runPatrol()
        setPatrolRunning(false)
        if (result?.ok === false) {
          setToast({ kind: 'err', text: result.error })
          return
        }
        // 安抚语必须是「跑了」而不是「没事」：这次没汇报时，用户需要知道的是
        // 「它确实跑过并判定为无事」，而不是一句让人以为检查过的「一切正常」。
        const delivered = Number(result?.delivered) || 0
        setToast({
          kind: 'ok',
          text: delivered > 0
            ? t('patrol.toastReported').replace('{n}', String(delivered))
            : t('patrol.toastSilent')
        })
      }

      const retrospectOnce = async () => {
        setRetrospectRunning(true)
        const result = await controller.runRetrospect()
        setRetrospectRunning(false)
        if (result?.ok === false) {
          setToast({ kind: 'err', text: result.error })
          return
        }
        // 同样不能说「一切正常」：没线索的时候用户要知道的是「扫过了，没有」，
        // 而不是一句听起来像检查通过的安慰。
        const found = Number(result?.verdict?.newLeads?.length) || 0
        setToast({
          kind: 'ok',
          text: found > 0
            ? t('retrospect.toastFound').replace('{n}', String(found))
            : t('retrospect.toastNone')
        })
      }

      const addMemory = async () => {
        if (!(newMemory.text ?? '').trim()) return
        const result = await controller.addMemory(
          newMemory.text,
          newMemory.note,
          newMemory.scope || undefined
        )
        if (result?.ok === false) {
          setToast({ kind: 'err', text: result.error })
          return
        }
        setNewMemory({ text: '', note: '', scope: '' })
      }

      // 体检：只读。查完把结果存在本地，不写进 state —— 它是「这一刻的快照」，
      // 而 state 会在每次 loadState 后刷新，混在一起会让旧结论看起来是新的。
      const runCheckup = async () => {
        setCheckup((prev) => ({ ...(prev ?? {}), running: true }) )
        const result = await controller.runCheckup()
        if (result?.ok === false) {
          setCheckup(null)
          setToast({ kind: 'err', text: result.error })
          return
        }
        setCheckup({ ...result, running: false, savedAt: new Date().toISOString() })
        setToast({ kind: 'ok', text: t('checkup.done') })
      }

      // 「按建议标为有争议」—— 引擎给的是候选，这里必须由用户点一次才落盘。
      // 传的是 suggestion.state，不是写死的 'contradicted'：将来若某种发现有别的
      // 建议，这里不该假装自己知道该改成什么。
      const applySuggestion = async (finding) => {
        const suggestion = finding?.suggestion
        if (!suggestion || !suggestion.state) return
        setBusyId(finding.id)
        const result = await controller.updateMemoryMeta(finding.id, { state: suggestion.state })
        setBusyId(null)
        if (result?.ok === false) {
          setToast({ kind: 'err', text: result.error })
          return
        }
        setToast({ kind: 'ok', text: t('checkup.applied') })
        // 结果里那条已经处理过了，原地剔掉，避免用户手滑点第二次
        setCheckup((prev) => {
          if (!prev) return prev
          const flagged = (prev.flagged ?? []).filter((f) => f.id !== finding.id)
          return { ...prev, flagged, clean: (prev.clean ?? 0) + 1 }
        })
      }

      const startMetaEdit = (record) => {
        setMetaEditing(record.id)
        setMetaDraft({
          type: record.type ?? 'fact',
          state: record.state ?? 'current',
          verifyAt: record.verifyAt ?? '',
          sourceRef: record.sourceRef ?? ''
        })
      }

      const cancelMetaEdit = () => {
        setMetaEditing(null)
        setMetaDraft({})
      }

      const saveMeta = async (id) => {
        setBusyId(id)
        // 只提交**真的改了**的字段：全量提交会把「没动过」也当成一次写入，
        // 而宿主对空变化的回执是 changed: []，用户会以为保存失败了。
        const result = await controller.updateMemoryMeta(id, metaDraft)
        setBusyId(null)
        if (result?.ok === false) {
          setToast({ kind: 'err', text: result.error })
          return
        }
        const changed = Array.isArray(result.changed) ? result.changed : []
        setToast({
          kind: 'ok',
          text: changed.length === 0 ? t('mem.metaNoChange') : t('mem.metaSaved')
        })
        setMetaEditing(null)
        setMetaDraft({})
      }

      // 待确认提议：确认 / 拒绝各一次调用，回执文案走 toast。
      const decideProposal = async (action) => {
        const result = await controller.decideProposal(action)
        if (result?.ok === false) {
          // 提议是进程内状态，重启即失效 —— 「找不到提议」是正常回执，
          // 用专门文案说明，别让用户以为是自己点错了。
          const gone = /没有待确认|not.*pending|no.*proposal/i.test(String(result.error ?? ''))
          setToast({ kind: 'err', text: gone ? t('proposal.gone') : result.error })
          return
        }
        setToast({ kind: 'ok', text: action === 'confirm' ? t('proposal.confirmed') : t('proposal.rejected') })
      }

      if (state.loading && !config) {
        return e('div', { className: 'an-root' }, e('div', { className: 'an-empty' }, t('common.loading')))
      }

      const pending = state.memories?.pending ?? []
      const adopted = state.memories?.adopted ?? []
      const discarded = state.memories?.discarded ?? []

      // 预览：优先用宿主返回的**真实**装配结果（带工作区覆盖与记忆），
      // 宿主不可用时退回本地粗拼 —— 保证预览区永远不空着。
      const previewText = (() => {
        const fromHost = state.preview?.persona
        if (typeof fromHost === 'string' && fromHost) return fromHost
        if (state.preview && state.preview.sections) {
          const sections = state.preview.sections
          const joined = [sections.identity, sections.userProfile, sections.style, sections.instructions, sections.memory]
            .filter((text) => typeof text === 'string' && text)
            .join('\n\n')
          if (joined) return joined
        }
        const lines = []
        if (local.enabled !== false) {
          const persona = pickPersona(local)
          if (persona.agentName || persona.agentRole) {
            lines.push('## 助手身份')
            if (persona.agentName) lines.push(`- 你的名字：${persona.agentName}`)
            if (persona.agentRole) lines.push(`- 角色设定：${persona.agentRole}`)
          }
          if (persona.addressUserAs || persona.userOccupation || persona.userBio) {
            lines.push('## 用户背景')
            if (persona.addressUserAs) lines.push(`- 你对用户的称呼：${persona.addressUserAs}`)
            if (persona.userOccupation) lines.push(`- 用户的职业：${persona.userOccupation}`)
            if (persona.userBio) lines.push(`- 关于用户：${persona.userBio}`)
          }
          // 风格段照 lib/prompt.mjs 的 compileStyle 拼：六个字段各是一段话，长的
          // 可能要折行 —— 续行缩进两个空格，否则第二行读起来像另一条规定。
          const styleLines = []
          const bullet = (label, value) => {
            const parts = String(value).split('\n').map((line) => line.trim()).filter(Boolean)
            if (parts.length === 0) return
            styleLines.push(`- ${label}${parts[0]}`)
            for (const extra of parts.slice(1)) styleLines.push(`  ${extra}`)
          }
          bullet('风格与语调：', persona.style)
          bullet('', persona.headingLists)
          bullet('', persona.emoji)
          bullet('', persona.tables)
          bullet('回复长度：', persona.replyLength)
          bullet('语言：', persona.language)
          if (styleLines.length > 0) lines.push('## 回复风格', ...styleLines)
          if (persona.customInstructions) lines.push('## 补充指令', persona.customInstructions)
        }
        if (local.memory?.enabled !== false && adopted.length > 0) {
          const max = local.memory?.maxInjected ?? 40
          const picked = adopted.slice(0, max)
          lines.push('## 长期记忆（已由用户采纳）')
          for (const record of picked) lines.push(`- ${record.text}`)
          if (adopted.length > picked.length) {
            lines.push(`（另有 ${adopted.length - picked.length} 条超出注入上限，未展示）`)
          }
        }
        return lines.join('\n')
      })()

      // toast 的种类决定配色；先算好类名，避免在 e(...) 实参里套三元。
      let toastNode = null
      if (toast) {
        const toastClass = toast.kind === 'err' ? 'an-toast an-toast-err' : 'an-toast an-toast-ok'
        toastNode = e('div', { className: toastClass }, toast.text)
      }

      // 提议条里的「提出于」是可选的。它若直接以三元塞在提议条内部，
      // 就构成嵌套三元（规则禁止），所以在元素树外先算好。
      let proposalTimeLine = null
      if (state.pendingProposal && state.pendingProposal.proposedAt) {
        proposalTimeLine = e('div', { className: 'an-hintline an-mt6' },
          `${t('proposal.at')} ${shortTime(state.pendingProposal.proposedAt)}`)
      }

      // 存储来源这一块：信息是「排查插件到底读的哪份介质」，所以位置与格式戳缺一不可。
      // 原来整块写成 `state.source ? e(...) : null`，里面四行各自又套三元（含一个
      // 嵌套在 class 模板里的 kind 判断），规则禁止。改成先收集行再决定画不画。
      const sourceInfo = (() => {
        const source = state.source
        if (!source) return null
        const isStorage = source.kind === 'storage'
        const rows = [
          e('dt', { key: 'src-k' }, t('source.label')),
          e('dd', { key: 'src-v' },
            `${isStorage ? t('source.domain') : t('source.none')}${source.path ? `　${source.path}` : ''}`)
        ]
        if (!isStorage && source.reason) {
          rows.push(e('dt', { key: 'rsn-k' }, t('source.reason')))
          rows.push(e('dd', { key: 'rsn-v' }, reasonText(t, source.reason)))
        }
        if (!isStorage && source.message) {
          rows.push(e('dt', { key: 'msg-k' }, t('source.message')))
          rows.push(e('dd', { key: 'msg-v' }, source.message))
        }
        // 「存储格式」一行：只在域真打开了（有版本戳）时出现。它是诊断信息 ——
        // 排查「插件到底读的哪份介质」时，位置与格式戳缺一不可。
        if (Number.isInteger(source.domainVersion)) {
          rows.push(e('dt', { key: 'fmt-k' }, t('source.format')))
          rows.push(e('dd', { key: 'fmt-v' }, t('source.formatText').split('{n}').join(String(source.domainVersion))))
        }
        return e('dl', { className: 'an-kv' }, rows)
      })()

      return e('div', { className: 'an-root' },
        toastNode,

        e('div', { className: 'an-row-between' },
          e('div', { className: 'an-minw0' },
            e('div', { className: 'an-page-title' }, t('page.title')),
            e('div', { className: 'an-hintline' }, t('page.desc'))
          ),
          e('span', { className: 'an-badge' }, `v${VERSION}`)
        ),

        // ---------------- 分区导航 ----------------
        //
        // 放在标题下、提议条上：提议有时效性要显眼，但它是偶发的一块；
        // 分区是常驻的、每次进来都要用的东西，放在最上面才找得到。
        e(SectionNav, { t, active: activeSection, onSelect: selectSection }),

        // ---------------- 最近改了什么 ----------------
        //
        // 常驻在分区导航下面：不管当前在哪一栏都看得见。用户要的正是这个
        // ——「改的咋样我根本不知道改成啥了」。
        e(RecentChanges, { t, state, controller, setToast }),

        // ---------------- 待确认的人设变更 ----------------
        //
        // 只在「工具确认」开启、且模型确实提了一份改动时出现。放在页面最上方是因为
        // 它有时效性（提议是进程内状态，重启即失效）—— 埋在下面等于让用户错过它。
        state.pendingProposal
          ? e('div', { className: 'an-proposal' },
              e('div', { className: 'an-proposal-title' }, t('proposal.title')),
              e('div', { className: 'an-proposal-detail' },
                Object.entries(state.pendingProposal.patch ?? {})
                  .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
                  .join('\n')
              ),
              proposalTimeLine,
              e('div', { className: 'an-actions an-mt8' },
                e('button', {
                  type: 'button',
                  className: 'an-btn an-btn-primary an-btn-sm',
                  disabled: state.saving,
                  onClick: () => decideProposal('confirm')
                }, t('proposal.confirm')),
                e('button', {
                  type: 'button',
                  className: 'an-btn an-btn-sm an-btn-danger',
                  disabled: state.saving,
                  onClick: () => decideProposal('reject')
                }, t('proposal.reject'))
              )
            )
          : null,

        // ---------------- 人设预设 ----------------
        e(Card, {
          id: 'preset',
          t,
          ...cardSlot('preset'),
          title: t('preset.title'),
          desc: t('preset.desc'),
          aside: e('span', { className: 'an-badgewrap' },
            activePreset
              ? e('span', { className: 'an-badge an-badge-ok', title: t('preset.activeHint') },
                `${t('preset.activeTag')}：${activePreset.name}`)
              : null,
            e('span', { className: 'an-badge' }, `${(state.presets ?? []).length} 项`)
          )
        },
          e('div', { className: 'an-row an-rowend' },
            e('div', { className: 'an-field an-flex240' },
              e('label', { htmlFor: 'an-preset-pick' }, t('preset.pick')),
              e('select', {
                id: 'an-preset-pick',
                className: 'an-select',
                value: pickedPresetId,
                onChange: (event) => setPresetPick(event.target.value)
              },
                e('option', { value: '' }, t('ws.none')),
                (state.presets ?? []).map((preset) =>
                  e('option', { key: preset.id, value: preset.id },
                    `${preset.name}（${preset.builtin ? t('preset.builtinTag') : t('preset.customTag')}）`
                    + (preset.id === state.activePresetId ? ` · ${t('preset.activeTag')}` : ''))
                )
              )
            ),
            e('button', {
              type: 'button',
              className: 'an-btn an-btn-primary',
              disabled: !pickedPresetId || state.presetBusy,
              onClick: applyPresetById
            }, t('preset.apply'))
          ),
          e(Hint, null, t('preset.builtinHint')),

          e('div', { className: 'an-mt16' },
            e('div', { className: 'an-card-title' }, t('preset.saveTitle')),
            e('div', { className: 'an-row an-rowgap8mt10' },
              e('div', { className: 'an-field an-flex200' },
                e('input', {
                  className: 'an-input',
                  type: 'text',
                  value: presetForm.name,
                  maxLength: 40,
                  placeholder: t('preset.namePlaceholder'),
                  onChange: (event) => setPresetForm((prev) => ({ ...prev, name: event.target.value }))
                })
              ),
              e('div', { className: 'an-field an-flex260' },
                e('input', {
                  className: 'an-input',
                  type: 'text',
                  value: presetForm.description,
                  maxLength: 200,
                  placeholder: t('preset.descPlaceholder'),
                  onChange: (event) => setPresetForm((prev) => ({ ...prev, description: event.target.value }))
                })
              ),
              e('button', {
                type: 'button',
                className: 'an-btn',
                disabled: !(presetForm.name ?? '').trim() || state.presetBusy,
                onClick: saveCurrentAsPreset
              }, t('preset.save'))
            ),
            e(Hint, null, t('preset.saveHint')),

            // 自建预设可删（内置不可删，故不给按钮）
            (state.presets ?? []).filter((preset) => !preset.builtin).length > 0
              ? e('div', { className: 'an-list an-mt10' },
                  (state.presets ?? []).filter((preset) => !preset.builtin).map((preset) =>
                    e('div', { className: 'an-item', key: preset.id },
                      e('div', { className: 'an-item-main' },
                        e('div', null, preset.name),
                        preset.description ? e(Hint, null, preset.description) : null
                      ),
                      e('button', {
                        type: 'button',
                        className: 'an-btn an-btn-sm an-btn-danger',
                        disabled: state.presetBusy,
                        onClick: () => deletePreset(preset.id)
                      }, t('preset.delete'))
                    )
                  )
                )
              : null
          )
        ),

        // ---------------- 助手身份 ----------------
        e(Card, {
          id: 'identity',
          t,
          ...cardSlot('identity'),
          title: t('identity.title'),
          desc: t('identity.desc'),
          // 保存与恢复默认已经收到页面底部的保存栏里。这张卡头只留状态徽标 ——
          // 原来这里有六处「保存」（四张卡各一份），点哪一个做的都是同一件事，
          // 用户得先判断「我现在在哪张卡里」才知道该按哪个。
          aside: dirty ? e('span', { className: 'an-badge' }, t('common.unsaved')) : null
        },
          e('div', { className: 'an-field' },
            e(Toggle, {
              id: 'enabled',
              checked: local.enabled !== false,
              label: t('identity.enabled'),
              onChange: (value) => patchLocal('enabled', value)
            }),
            e(Hint, null, t('identity.enabledHint'))
          ),
          e('div', { className: 'an-field' },
            e('label', { htmlFor: 'an-agent-name' }, t('identity.name')),
            e('input', {
              id: 'an-agent-name',
              className: 'an-input',
              type: 'text',
              value: local.agentName ?? '',
              maxLength: limits.agentName ?? 50,
              placeholder: t('identity.namePlaceholder'),
              onChange: (event) => patchLocal('agentName', event.target.value)
            }),
            e(Hint, null, t('identity.nameHint'))
          ),
          e('div', { className: 'an-field' },
            e('label', { htmlFor: 'an-agent-role' }, t('identity.role')),
            e('textarea', {
              id: 'an-agent-role',
              className: 'an-textarea',
              value: local.agentRole ?? '',
              maxLength: limits.agentRole ?? 800,
              onChange: (event) => patchLocal('agentRole', event.target.value)
            }),
            e(Hint, null, `${t('identity.roleHint')}　${(local.agentRole ?? '').length}/${limits.agentRole ?? 800}`),
            e(examplePicker, {
              label: t('example.label'),
              options: exampleOptions(state, 'agentRole'),
              onFill: (text) => patchLocal('agentRole', text)
            })
          ),
          sourceInfo
        ),

        // ---------------- 用户背景 ----------------
        e(Card, {
          id: 'user',
          t,
          ...cardSlot('user'),
          title: t('user.title'),
          desc: t('user.desc')
        },
          e('div', { className: 'an-field' },
            e('label', { htmlFor: 'an-address' }, t('user.address')),
            e('input', {
              id: 'an-address',
              className: 'an-input',
              type: 'text',
              value: local.addressUserAs ?? '',
              maxLength: limits.addressUserAs ?? 50,
              onChange: (event) => patchLocal('addressUserAs', event.target.value)
            }),
            e(Hint, null, t('user.addressHint')),
            e(examplePicker, {
              label: t('example.label'),
              options: exampleOptions(state, 'addressUserAs'),
              onFill: (text) => patchLocal('addressUserAs', text)
            })
          ),
          e('div', { className: 'an-field' },
            e('label', { htmlFor: 'an-user-occupation' }, t('user.occupation')),
            e('input', {
              id: 'an-user-occupation',
              className: 'an-input',
              type: 'text',
              value: local.userOccupation ?? '',
              maxLength: limits.userOccupation ?? 50,
              onChange: (event) => patchLocal('userOccupation', event.target.value)
            }),
            e(examplePicker, {
              label: t('example.label'),
              options: exampleOptions(state, 'userOccupation'),
              onFill: (text) => patchLocal('userOccupation', text)
            })
          ),
          e('div', { className: 'an-field' },
            e('label', { htmlFor: 'an-user-bio' }, t('user.bio')),
            e('textarea', {
              id: 'an-user-bio',
              className: 'an-textarea',
              value: local.userBio ?? '',
              maxLength: limits.userBio ?? 500,
              onChange: (event) => patchLocal('userBio', event.target.value)
            }),
            e(Hint, null, `${t('user.bioHint')}　${(local.userBio ?? '').length}/${limits.userBio ?? 500}`),
            e(examplePicker, {
              label: t('example.label'),
              options: exampleOptions(state, 'userBio'),
              onFill: (text) => patchLocal('userBio', text)
            })
          )
        ),

        // ---------------- 回复风格与特质 ----------------
        //
        // 六个字段全是自由文本，配一组「一键填入」。旧版的下拉框换掉了：档位名
        // （professional / more / concise）对用户没有信息量，对模型也没有 —— 真正
        // 要注入的是那段中文说明，所以干脆让输入框里存的就是它。
        e(Card, {
          id: 'style',
          t,
          ...cardSlot('style'),
          title: t('style.title'),
          desc: t('style.desc')
        },
          e(wordingField, {
            id: 'style',
            label: t('style.style'),
            hint: t('style.styleHint'),
            fillLabel: t('style.fill'),
            value: local.style,
            limit: limits.style ?? 800,
            options: wordingOptions(state, 'style'),
            labelOf: (id) => t(`wording.${id}`),
            onChange: (next) => patchLocal('style', next)
          }),
          e('div', { className: 'an-row an-gap16wrap' },
            e('div', { className: 'an-flex240an' },
              e(wordingField, {
                id: 'trait-heading',
                label: t('style.headingLists'),
                fillLabel: t('style.fill'),
                value: local.headingLists,
                limit: limits.headingLists ?? 300,
                options: wordingOptions(state, 'headingLists'),
                labelOf: (id) => t(`wording.${id}`),
                onChange: (next) => patchLocal('headingLists', next)
              })
            ),
            e('div', { className: 'an-flex240an' },
              e(wordingField, {
                id: 'trait-emoji',
                label: t('style.emoji'),
                fillLabel: t('style.fill'),
                value: local.emoji,
                limit: limits.emoji ?? 300,
                options: wordingOptions(state, 'emoji'),
                labelOf: (id) => t(`wording.${id}`),
                onChange: (next) => patchLocal('emoji', next)
              })
            ),
            e('div', { className: 'an-flex240an' },
              e(wordingField, {
                id: 'trait-tables',
                label: t('style.tables'),
                fillLabel: t('style.fill'),
                value: local.tables,
                limit: limits.tables ?? 300,
                options: wordingOptions(state, 'tables'),
                labelOf: (id) => t(`wording.${id}`),
                onChange: (next) => patchLocal('tables', next)
              })
            )
          ),
          e('div', { className: 'an-row an-gap16wrap' },
            e('div', { className: 'an-flex240an' },
              e(wordingField, {
                id: 'length',
                label: t('style.replyLength'),
                fillLabel: t('style.fill'),
                value: local.replyLength,
                limit: limits.replyLength ?? 300,
                options: wordingOptions(state, 'replyLength'),
                labelOf: (id) => t(`wording.${id}`),
                onChange: (next) => patchLocal('replyLength', next)
              })
            ),
            e('div', { className: 'an-flex240an' },
              e(wordingField, {
                id: 'language',
                label: t('style.language'),
                fillLabel: t('style.fill'),
                value: local.language,
                limit: limits.language ?? 300,
                options: wordingOptions(state, 'language'),
                labelOf: (id) => t(`wording.${id}`),
                onChange: (next) => patchLocal('language', next)
              })
            )
          ),
          e('div', { className: 'an-field' },
            e('label', { htmlFor: 'an-custom' }, t('style.custom')),
            e('textarea', {
              id: 'an-custom',
              className: 'an-textarea',
              value: local.customInstructions ?? '',
              maxLength: limits.customInstructions ?? 2000,
              onChange: (event) => patchLocal('customInstructions', event.target.value)
            }),
            e(Hint, null, `${t('style.customHint')}　${(local.customInstructions ?? '').length}/${limits.customInstructions ?? 2000}`),
            e(examplePicker, {
              label: t('example.label'),
              options: exampleOptions(state, 'customInstructions'),
              onFill: (text) => patchLocal('customInstructions', text)
            })
          )
        ),

        // ---------------- 输入框光轨 + 工具确认 ----------------
        e(Card, {
          id: 'trail',
          t,
          ...cardSlot('trail'),
          title: t('trail.title'),
          desc: t('trail.desc')
        },
          e(Toggle, {
            id: 'trail-enabled',
            checked: local.trailEnabled === true,
            label: t('trail.enabled'),
            onChange: (checked) => patchLocal('trailEnabled', checked)
          }),
          e('div', { className: 'an-row an-gap16wrap' },
            e('div', { className: 'an-field an-flex200' },
              e('label', { htmlFor: 'an-trail-color' }, t('trail.color')),
              e('div', { className: 'an-row an-rowcenter' },
                // 原生取色器与文本输入绑同一个值，因此天然双向：色板里挑一个，
                // 文本立刻跟着变；手打一个十六进制，色板也跟着走到那个颜色。
                // 取色器只认 #rrggbb，所以喂给它的值必须先过 safeTrailColor，
                // 否则用户打了一半的「#67」会让它回落到黑色（看起来像被改坏了）。
                e('input', {
                  id: 'an-trail-color-picker',
                  className: 'an-input-color',
                  type: 'color',
                  value: safeTrailColor(local.trailColor),
                  'aria-label': t('trail.color'),
                  onChange: (event) => patchLocal('trailColor', String(event.target.value).toUpperCase())
                }),
                e('input', {
                  id: 'an-trail-color',
                  className: 'an-input',
                  type: 'text',
                  value: local.trailColor ?? TRAIL_COLOR_FALLBACK,
                  placeholder: TRAIL_COLOR_FALLBACK,
                  onChange: (event) => patchLocal('trailColor', event.target.value)
                })
              ),
              e(Hint, null, t('trail.colorHint'))
            ),
            e('div', { className: 'an-field an-flex140' },
              e('label', { htmlFor: 'an-trail-speed' }, t('trail.speed')),
              e('select', {
                id: 'an-trail-speed',
                className: 'an-select',
                value: local.trailSpeed ?? 'slow',
                onChange: (event) => patchLocal('trailSpeed', event.target.value)
              },
                TRAIL_SPEED_VALUES.map((value) =>
                  e('option', { key: value, value }, t(`trail.speed.${value}`))
                )
              )
            ),
            e('div', { className: 'an-field an-flex140' },
              e('label', { htmlFor: 'an-trail-width' }, t('trail.width')),
              e('select', {
                id: 'an-trail-width',
                className: 'an-select',
                value: local.trailWidth ?? 'thin',
                onChange: (event) => patchLocal('trailWidth', event.target.value)
              },
                TRAIL_WIDTH_VALUES.map((value) =>
                  e('option', { key: value, value }, t(`trail.width.${value}`))
                )
              )
            )
          ),
          // 取色的三个入口（取色器 / 文本 / 下面这排内置色）写的是同一个字段，
          // 所以三处永远同步 —— 不需要额外的状态机。内置色仍保留：它是最快的
          // 一条路（一次点击，不用先想颜色再记十六进制），但不再是唯一入口。
          e('div', { className: 'an-actions an-wrap' },
            TRAIL_PRESET_COLORS.map((color) =>
              e('button', {
                key: color,
                type: 'button',
                className: 'an-btn an-btn-sm',
                onClick: () => patchLocal('trailColor', color)
              },
                e('span', {
                  style: {
                    display: 'inline-block',
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    marginRight: 6,
                    background: color,
                    verticalAlign: 'middle'
                  }
                }),
                color
              )
            )
          ),
          e(Toggle, {
            id: 'tool-confirm',
            checked: local.requireToolConfirmation === true,
            label: t('tool.confirmLabel'),
            onChange: (checked) => patchLocal('requireToolConfirmation', checked)
          }),
          e(Hint, null, t('tool.confirmDesc')),
          e(TrailPreview, {
            t,
            enabled: local.trailEnabled === true,
            color: local.trailColor,
            speed: local.trailSpeed,
            width: local.trailWidth
          })
        ),

        // ---------------- 工作区覆盖 ----------------
        e(Card, {
          id: 'ws',
          t,
          ...cardSlot('ws'),
          title: t('ws.title'),
          desc: t('ws.desc')
        },
          e('div', { className: 'an-field' },
            e(Toggle, {
              id: 'ws-enabled',
              checked: local.workspaceOverridesEnabled !== false,
              label: t('ws.enabled'),
              onChange: (value) => patchLocal('workspaceOverridesEnabled', value)
            })
          ),
          e('div', { className: 'an-field' },
            e('label', { htmlFor: 'an-ws-dir' }, t('ws.dir')),
            e('input', {
              id: 'an-ws-dir',
              className: 'an-input',
              type: 'text',
              value: local.workspaceFileDir ?? '.dsh-anima',
              onChange: (event) => patchLocal('workspaceFileDir', event.target.value)
            }),
            e(Hint, null, t('ws.dirHint'))
          ),
          (state.workspaces ?? []).length === 0
            ? e('div', { className: 'an-empty' }, t('ws.empty'))
            : e('div', { className: 'an-field' },
                e('label', { htmlFor: 'an-ws-pick' }, t('ws.pick')),
                e('select', {
                  id: 'an-ws-pick',
                  className: 'an-select',
                  value: state.workspacePath || '',
                  onChange: (event) => controller.loadWorkspace(event.target.value)
                },
                  e('option', { value: '' }, t('ws.none')),
                  (state.workspaces ?? []).map((workspace) =>
                    e('option', { key: workspace.id, value: workspace.path },
                      workspace.title ? `${workspace.title} — ${workspace.path}` : workspace.path)
                  )
                )
              ),
          state.workspaceError ? e(ErrorBox, { error: state.workspaceError }) : null,
          (() => {
            if (!state.workspacePath) return e('div', { className: 'an-hintline' }, t('ws.globalOnly'))
            // 工作区状态那行是可选诊断信息。它原来写成 `wsState ? e(...) : null`，
            // 而外层本来就是三元，两下一叠就是规则禁止的嵌套三元 —— 先算好再拼。
            let wsNoteLine = null
            if (wsState) {
              let existsLabel = t('ws.notExists')
              if (wsState.exists) existsLabel = t('ws.exists')
              wsNoteLine = e('div', { className: 'an-note' }, `${existsLabel}　${wsState.path ?? ''}`)
            }
            return e('div', null,
                e(Hint, null, t('ws.hint')),

                e('div', { className: 'an-card-title an-mt14' }, t('ws.section.identity')),
                e('div', { className: 'an-field' },
                  e('label', { htmlFor: 'an-ws-name' }, t('identity.name')),
                  e('input', {
                    id: 'an-ws-name',
                    className: 'an-input',
                    type: 'text',
                    value: wsLocal.agentName ?? '',
                    placeholder: config?.agentName || '',
                    onChange: (event) => patchWs('agentName', event.target.value)
                  })
                ),
                e('div', { className: 'an-field' },
                  e('label', { htmlFor: 'an-ws-role' }, t('identity.role')),
                  e('textarea', {
                    id: 'an-ws-role',
                    className: 'an-textarea',
                    value: wsLocal.agentRole ?? '',
                    placeholder: config?.agentRole || '',
                    onChange: (event) => patchWs('agentRole', event.target.value)
                  })
                ),

                e('div', { className: 'an-card-title an-mt14' }, t('ws.section.user')),
                e('div', { className: 'an-field' },
                  e('label', { htmlFor: 'an-ws-address' }, t('user.address')),
                  e('input', {
                    id: 'an-ws-address',
                    className: 'an-input',
                    type: 'text',
                    value: wsLocal.addressUserAs ?? '',
                    placeholder: config?.addressUserAs || '',
                    onChange: (event) => patchWs('addressUserAs', event.target.value)
                  })
                ),
                e('div', { className: 'an-field' },
                  e('label', { htmlFor: 'an-ws-occupation' }, t('user.occupation')),
                  e('input', {
                    id: 'an-ws-occupation',
                    className: 'an-input',
                    type: 'text',
                    value: wsLocal.userOccupation ?? '',
                    placeholder: config?.userOccupation || '',
                    onChange: (event) => patchWs('userOccupation', event.target.value)
                  })
                ),
                e('div', { className: 'an-field' },
                  e('label', { htmlFor: 'an-ws-bio' }, t('user.bio')),
                  e('textarea', {
                    id: 'an-ws-bio',
                    className: 'an-textarea',
                    value: wsLocal.userBio ?? '',
                    placeholder: config?.userBio || '',
                    onChange: (event) => patchWs('userBio', event.target.value)
                  })
                ),

                e('div', { className: 'an-card-title an-mt14' }, t('ws.section.style')),
                e(Hint, null, t('ws.styleHint')),
                e('div', { className: 'an-row an-gap16wrap' },
                  e('div', { className: 'an-flex240an' },
                    e(overrideInput, {
                      id: 'ws-style',
                      label: t('style.style'),
                      value: wsLocal.style,
                      field: 'style',
                      placeholder: config?.style || '',
                      hint: wsFieldHint(config?.style, wsLocal.style, t),
                      onChange: patchWs
                    })
                  ),
                  e('div', { className: 'an-flex240an' },
                    e(overrideInput, {
                      id: 'ws-heading',
                      label: t('style.headingLists'),
                      value: wsLocal.headingLists,
                      field: 'headingLists',
                      placeholder: config?.headingLists || '',
                      hint: wsFieldHint(config?.headingLists, wsLocal.headingLists, t),
                      onChange: patchWs
                    })
                  ),
                  e('div', { className: 'an-flex240an' },
                    e(overrideInput, {
                      id: 'ws-emoji',
                      label: t('style.emoji'),
                      value: wsLocal.emoji,
                      field: 'emoji',
                      placeholder: config?.emoji || '',
                      hint: wsFieldHint(config?.emoji, wsLocal.emoji, t),
                      onChange: patchWs
                    })
                  )
                ),
                e('div', { className: 'an-row an-gap16wrap' },
                  e('div', { className: 'an-flex240an' },
                    e(overrideInput, {
                      id: 'ws-tables',
                      label: t('style.tables'),
                      value: wsLocal.tables,
                      field: 'tables',
                      placeholder: config?.tables || '',
                      hint: wsFieldHint(config?.tables, wsLocal.tables, t),
                      onChange: patchWs
                    })
                  ),
                  e('div', { className: 'an-flex240an' },
                    e(overrideInput, {
                      id: 'ws-length',
                      label: t('style.replyLength'),
                      value: wsLocal.replyLength,
                      field: 'replyLength',
                      placeholder: config?.replyLength || '',
                      hint: wsFieldHint(config?.replyLength, wsLocal.replyLength, t),
                      onChange: patchWs
                    })
                  ),
                  e('div', { className: 'an-flex240an' },
                    e(overrideInput, {
                      id: 'ws-language',
                      label: t('style.language'),
                      value: wsLocal.language,
                      field: 'language',
                      placeholder: config?.language || '',
                      hint: wsFieldHint(config?.language, wsLocal.language, t),
                      onChange: patchWs
                    })
                  )
                ),
                e('div', { className: 'an-field' },
                  e('label', { htmlFor: 'an-ws-custom' }, t('style.custom')),
                  e('textarea', {
                    id: 'an-ws-custom',
                    className: 'an-textarea',
                    value: wsLocal.customInstructions ?? '',
                    placeholder: config?.customInstructions || '',
                    onChange: (event) => patchWs('customInstructions', event.target.value)
                  })
                ),

                wsNoteLine,
                e('div', { className: 'an-actions an-mt12' },
                  e('button', {
                    type: 'button',
                    className: 'an-btn an-btn-primary',
                    disabled: !wsDirty || state.workspaceSaving,
                    onClick: doSaveWorkspace
                  }, t('ws.save')),
                  e('button', {
                    type: 'button',
                    className: 'an-btn',
                    disabled: state.workspaceSaving,
                    onClick: () => setWsLocal(pickOverrides({}))
                  }, t('ws.clear'))
                )
              )
          })(),
        ),

        // ---------------- 长期记忆 ----------------
        e(Card, {
          id: 'mem',
          t,
          ...cardSlot('mem'),
          title: t('mem.title'),
          desc: t('mem.desc')
        },
          e('div', { className: 'an-field' },
            e(Toggle, {
              id: 'mem-enabled',
              checked: local.memory.enabled !== false,
              label: t('mem.enabled'),
              onChange: (value) => patchMemory('enabled', value)
            })
          ),
          e('div', { className: 'an-field' },
            e(Toggle, {
              id: 'mem-auto',
              checked: local.memory.autoCapture !== false,
              label: t('mem.autoCapture'),
              onChange: (value) => patchMemory('autoCapture', value)
            }),
            e(Hint, null, t('mem.autoCaptureHint'))
          ),
          e('div', { className: 'an-field' },
            e(Toggle, {
              id: 'mem-nightly',
              checked: local.memory.nightlyTriage !== false,
              label: t('mem.nightly'),
              onChange: (value) => patchMemory('nightlyTriage', value)
            })
          ),
          // 回扫式复盘默认关：它要读磁盘上的历史会话日志，是比「整理内存」更外扩的一步。
          // 打开时把窗口天数一起摆出来 —— 只给开关不给窗口，用户没法判断它扫多少。
          e('div', { className: 'an-field' },
            e(Toggle, {
              id: 'mem-retrospect',
              checked: local.memory.retrospectEnabled === true,
              label: t('mem.retrospect'),
              onChange: (value) => patchMemory('retrospectEnabled', value)
            }),
            e(Hint, null, t('mem.retrospectHint'))
          ),
          local.memory.retrospectEnabled === true
            ? e('div', { className: 'an-field' },
                e('label', { htmlFor: 'an-mem-retro-days' }, t('mem.retrospectDays')),
                e('input', {
                  id: 'an-mem-retro-days',
                  className: 'an-input',
                  type: 'number',
                  min: 1,
                  max: 365,
                  value: local.memory.retrospectDays ?? 14,
                  onChange: (event) => patchMemory('retrospectDays', Number(event.target.value))
                }),
                e(Hint, null, t('mem.retrospectDaysHint'))
              )
            : null,
          e('div', { className: 'an-field' },
            e('label', { htmlFor: 'an-mem-hour' }, t('mem.nightlyHour')),
            e('input', {
              id: 'an-mem-hour',
              className: 'an-input',
              type: 'number',
              min: 0,
              max: 23,
              value: local.memory.nightlyHour ?? 3,
              onChange: (event) => patchMemory('nightlyHour', Number(event.target.value))
            })
          ),
          e('div', { className: 'an-row an-gap16' },
            e('div', { className: 'an-field an-flexfill' },
              e('label', { htmlFor: 'an-mem-max' }, t('mem.maxPending')),
              e('input', {
                id: 'an-mem-max',
                className: 'an-input',
                type: 'number',
                min: 1,
                max: 5000,
                value: local.memory.maxPending ?? 200,
                onChange: (event) => patchMemory('maxPending', Number(event.target.value))
              })
            ),
            e('div', { className: 'an-field an-flexfill' },
              e('label', { htmlFor: 'an-mem-inject' }, t('mem.maxInjected')),
              e('input', {
                id: 'an-mem-inject',
                className: 'an-input',
                type: 'number',
                min: 0,
                max: 500,
                value: local.memory.maxInjected ?? 40,
                onChange: (event) => patchMemory('maxInjected', Number(event.target.value))
              }),
              // 两个 0 含义相反：字符数 0 = 不限，条数 0 = 一条都不注入。少了这行提示，
              // 用户会照「0 表示不限」的直觉填 0，结果记忆静默全停 —— 而界面上一切正常。
              e(Hint, null, t('mem.maxInjectedHint'))
            ),
            // 字符预算与条数取先到者。只有条数时，40 条长记忆一样能挤爆上下文 ——
            // 所以这一项不是「高级选项」，它和条数一样是硬约束。
            e('div', { className: 'an-field an-flexfill' },
              e('label', { htmlFor: 'an-mem-chars' }, t('mem.maxInjectedChars')),
              e('input', {
                id: 'an-mem-chars',
                className: 'an-input',
                type: 'number',
                min: 0,
                max: 100000,
                value: local.memory.maxInjectedChars ?? 4000,
                onChange: (event) => patchMemory('maxInjectedChars', Number(event.target.value))
              }),
              e(Hint, null, t('mem.maxInjectedCharsHint'))
            )
          ),
          e('div', { className: 'an-field' },
            e(Toggle, {
              id: 'mem-notify',
              checked: local.memory.notifyOnSessionStart !== false,
              label: t('mem.notify'),
              onChange: (value) => patchMemory('notifyOnSessionStart', value)
            })
          ),
          // 这一段的保存按钮已收到页面底部的保存栏（理由见 identity 卡头）。

          // 待审缓冲区
          e('div', { className: 'an-mt20' },
            e('div', { className: 'an-row-between' },
              e('div', { className: 'an-card-title' }, `${t('mem.pending')}（${pending.length}）`),
              e('div', { className: 'an-actions' },
                state.triageMeta?.lastTriageAt
                  ? e('span', { className: 'an-badge' }, `${t('mem.lastTriage')} ${shortTime(state.triageMeta.lastTriageAt)}`)
                  : null,
                e('button', {
                  type: 'button',
                  className: 'an-btn an-btn-sm',
                  onClick: triageOnce
                }, t('mem.triage')),
                // 巡夜可以手动跑一次，且与定时那次走同一条判据 —— 否则「手点一次」
                // 和「它自己跑一次」会给出不同答案，这个机制就永远没法验。
                e('button', {
                  type: 'button',
                  className: 'an-btn an-btn-sm',
                  disabled: patrolRunning,
                  onClick: patrolOnce
                }, patrolRunning ? t('patrol.running') : t('patrol.run')),
                // 回扫式复盘：与巡夜分开一条按钮，因为它是两件不同的事 ——
                // 巡夜看的是**记忆库自身的状态**，回扫看的是**你说过但没被记下来的话**。
                e('button', {
                  type: 'button',
                  className: 'an-btn an-btn-sm',
                  disabled: retrospectRunning,
                  onClick: retrospectOnce
                }, retrospectRunning ? t('retrospect.running') : t('retrospect.run'))
              )
            ),
            // 巡夜记录：**这是「没汇报」可反查的唯一出口。**
            // 只报有事之后，沉默有两种意思 —— 巡过了没事 / 巡夜没跑。前者有这一行，
            // 后者根本没有，于是用户随时能分清。所以这行必须在「没汇报」时也出现。
            e(PatrolLine, {
              t,
              meta: state.patrolMeta ?? null,
              onRun: patrolOnce,
              running: patrolRunning
            }),
            // 回扫记录：与巡夜那行同样的理由必须常驻 —— 「没有线索」要能被反查成
            // 「真的扫过、确实没有」，而不是和「没扫」长得一样。
            e(RetrospectLine, {
              t,
              meta: state.retrospectMeta ?? null,
              onRun: retrospectOnce,
              running: retrospectRunning
            }),
            e(MemoryList, {
              t,
              items: pending,
              status: 'pending',
              emptyText: t('mem.emptyPending'),
              busy: Boolean(busyId),
              onDecide: decide,
              onDelete: removeMemory
            })
          ),

          // 手动添加
          e('div', { className: 'an-mt20' },
            e('div', { className: 'an-card-title' }, t('mem.add')),
            e('div', { className: 'an-field an-mt10' },
              e('textarea', {
                className: 'an-textarea',
                value: newMemory.text,
                placeholder: t('mem.addPlaceholder'),
                maxLength: 500,
                onChange: (event) => setNewMemory((prev) => ({ ...prev, text: event.target.value }))
              }),
              e(Hint, null, `${newMemory.text.length}/500　${t('mem.credential')}`),
              e(examplePicker, {
                label: t('example.label'),
                options: exampleOptions(state, 'memory'),
                onFill: (text) => setNewMemory((prev) => ({ ...prev, text }))
              })
            ),
            e('div', { className: 'an-field' },
              e('input', {
                className: 'an-input',
                type: 'text',
                value: newMemory.note,
                placeholder: t('mem.addNote'),
                maxLength: 200,
                onChange: (event) => setNewMemory((prev) => ({ ...prev, note: event.target.value }))
              })
            ),
            e('div', { className: 'an-field' },
              e('input', {
                className: 'an-input',
                type: 'text',
                value: newMemory.scope,
                placeholder: t('mem.addScope'),
                onChange: (event) => setNewMemory((prev) => ({ ...prev, scope: event.target.value }))
              })
            ),
            e('div', { className: 'an-actions' },
              e('button', {
                type: 'button',
                className: 'an-btn an-btn-primary',
                disabled: !newMemory.text.trim(),
                onClick: addMemory
              }, t('mem.add'))
            )
          ),

          // 已采纳
          e('div', { className: 'an-mt20' },
            e('div', { className: 'an-card-title' }, `${t('mem.adopted')}（${adopted.length}）`),
            e(MemoryList, {
              t,
              items: adopted,
              status: 'adopted',
              emptyText: t('mem.emptyAdopted'),
              busy: Boolean(busyId),
              onDecide: decide,
              onDelete: removeMemory,
              metaEditingId: metaEditing,
              metaDraft,
              onStartMeta: startMetaEdit,
              onCancelMeta: cancelMetaEdit,
              onChangeMeta: (key, value) => setMetaDraft((prev) => ({ ...prev, [key]: value })),
              onSaveMeta: saveMeta
            })
          ),

          // 记忆体检：只查机器能查的两件事。放在「已采纳」下面，因为它查的正是
          // 这批已经生效、会被注入的记忆 —— 待审的还没进去，查它没有意义。
          e(CheckupPanel, {
            t,
            result: checkup,
            busy: checkup?.running === true,
            applyBusy: Boolean(busyId),
            onRun: runCheckup,
            onApply: applySuggestion
          }),

          // 注入情况（每条为什么进 / 不进）+ 本地聚类与冲突提示。
          // 都挂在记忆卡片内部：它们讲的都是「这批记忆接下来会怎么被用」。
          e(InjectionPanel, { t, state, controller }),
          e(ImportPanel, {
            t,
            state,
            controller,
            // cwd 用当前工作区：归类的「本工作区」建议要靠它，而用户此刻正在看的
            // 就是这个工作区。没填工作区时传空串，条目会一律建议全局。
            cwd: state.workspacePath || '',
            value: memoryImport,
            setValue: setImportState,
            onDone: (message) => setToast({ kind: 'ok', text: message })
          }),
          e(ClusterNotes, { t, clusters: state.clusters, conflicts: state.conflicts }),

          // 已丢弃（折叠为计数，避免占屏）
          discarded.length > 0
            ? e('div', { className: 'an-mt16' },
                e('div', { className: 'an-card-title' }, `${t('mem.discarded')}（${discarded.length}）`),
                e(MemoryList, {
                  t,
                  items: discarded,
                  status: 'discarded',
                  emptyText: '',
                  busy: Boolean(busyId),
                  onDecide: decide,
                  onDelete: removeMemory
                })
              )
            : null
        ),

        // ---------------- 回答质检 ----------------
        // 放在记忆之后、变更记录之前：它讲的是「我这条回答会不会被检查」，
        // 而变更记录讲的是「这些设置被谁改过」——被记录的对象在前，记录在后。
        e(Card, {
          id: 'quality',
          t,
          ...cardSlot('quality'),
          title: t('quality.title'),
          desc: t('quality.desc')
        },
          e('div', { className: 'an-field' },
            e(Toggle, {
              id: 'quality-enabled',
              checked: local.quality.enabled !== false,
              label: t('quality.enabled'),
              onChange: (value) => patchQuality('enabled', value)
            }),
            e(Hint, null, t('quality.enabledHint'))
          ),
          e('div', { className: 'an-field' },
            e('label', { htmlFor: 'an-quality-ledger' }, t('quality.ledgerLevel')),
            e('select', {
              id: 'an-quality-ledger',
              className: 'an-select',
              value: local.quality.ledgerLevel ?? 'three',
              onChange: (event) => patchQuality('ledgerLevel', event.target.value)
            },
              LEDGER_LEVELS.map((value) =>
                e('option', { key: value, value }, t(`quality.ledger.${value}`))
              )
            ),
            e(Hint, null, t('quality.ledgerLevelHint'))
          ),
          e('div', { className: 'an-field' },
            e(Toggle, {
              id: 'quality-strict',
              checked: local.quality.strict !== false,
              label: t('quality.strict'),
              onChange: (value) => patchQuality('strict', value)
            }),
            // 严格档会多判三条（R08 置信度、R11 稻草人、R12 越界自信）。关掉它的
            // 唯一理由通常是误报变多 —— 所以提示里写清代价，而不是只说「更严格」。
            e(Hint, null, t('quality.strictHint'))
          ),
          e('div', { className: 'an-field' },
            e(Toggle, {
              id: 'quality-precheck',
              checked: local.quality.preStepCheck !== false,
              label: t('quality.preStepCheck'),
              onChange: (value) => patchQuality('preStepCheck', value)
            }),
            e(Hint, null, t('quality.preStepCheckHint'))
          ),
          e('div', { className: 'an-field' },
            e('label', { htmlFor: 'an-quality-max' }, t('quality.maxFindings')),
            e('input', {
              id: 'an-quality-max',
              className: 'an-input',
              type: 'number',
              min: 1,
              max: 20,
              value: local.quality.maxFindingsInReminder ?? 5,
              onChange: (event) => patchQuality('maxFindingsInReminder', Number(event.target.value))
            }),
            e(Hint, null, t('quality.maxFindingsHint'))
          ),
          // 保存按钮已收到页面底部的保存栏（理由见 identity 卡头）。

          // 运行计数：这一块存在的唯一理由，是让「查了没事」与「压根没跑」可区分。
          // checks=0 时界面必须明说「没在工作」，不能因为「没有提醒 = 没问题」而显示得
          // 和一切正常一样 —— 那正是用户定的红线里最忌讳的那种谎报。
          e('div', { className: 'an-mt20' },
            e('div', { className: 'an-card-title' }, t('quality.stats')),
            (() => {
              const stats = state.qualityStats
              if (!stats) return e('div', { className: 'an-empty' }, t('quality.statsUnknown'))
              if (stats.checks === 0) {
                return e('div', { className: 'an-invalid' }, t('quality.statsIdle'))
              }
              const findingsLabel = stats.last
                ? (() => {
                  // 「一次都没报」和「报了几条」在界面上必须是两种不同的说法；
                  // 把这句话先算出来，它就不会在 e() 的实参里再套一层三元。
                  if (stats.last.findings.length === 0) return t('quality.statsNone')
                  return stats.last.findings.join('、')
                })()
                : ''
              let lastRunLine = null
              if (stats.last) {
                lastRunLine = e(Hint, null,
                  `${t('quality.statsLast')} seq=${stats.last.seq} · ${stats.last.chars} ${t('quality.statsChars')} · `
                  + `${t('quality.statsFindings')} ${findingsLabel}`
                )
              }
              return e('div', null,
                e('div', { className: 'an-row an-gap12wrap' },
                  e('span', { className: 'an-badge' }, `${t('quality.statsChecks')} ${stats.checks}`),
                  e('span', { className: 'an-badge' }, `${t('quality.statsReminders')} ${stats.reminders}`),
                  stats.suppressed > 0
                    ? e('span', { className: 'an-badge' }, `${t('quality.statsSuppressed')} ${stats.suppressed}`)
                    : null
                ),
                lastRunLine
              )
            })()
          )
        ),

        // ---------------- 预览 ----------------
        //
        // 预览卡的两处内容都在这里先算好：aside（草稿/已保存徽标）与整块正文。
        // 它们原来直接以三元塞在 e(Card, ...) 的实参里，而正文内部又有 loading /
        // empty / invalid 三层三元 —— 那就是规则禁止的嵌套三元，必须在元素树外算。
        (() => {
          const previewAside = (() => {
            if (!previewOpen || !state.preview) return null
            return e('div', { className: 'an-actions' },
              e('span', { className: 'an-badge' }, state.preview.draft ? t('preview.live') : t('preview.saved'))
            )
          })()

          const previewBody = (() => {
            if (!previewOpen) return null
            let textBlock = null
            if (state.previewLoading && !previewText) {
              textBlock = e('div', { className: 'an-empty' }, t('preview.loading'))
            } else if (previewText) {
              textBlock = e(Pre, { text: previewText })
            } else {
              textBlock = e('div', { className: 'an-empty' }, t('preview.empty'))
            }
            let charLine = null
            if (previewText) charLine = e(Hint, null, `${t('preview.chars')}: ${previewText.length}`)
            // 被校验挡下的草稿字段。预览刻意不为半截输入报错（用户还在打字），
            // 但必须说清楚「你刚打的这个没算进去」—— 否则用户会以为预览里
            // 就是自己输入的样子，而其实用的是上一次的合法值。
            let invalidBlock = null
            if (Array.isArray(state.preview?.invalid) && state.preview.invalid.length > 0) {
              invalidBlock = e('div', { className: 'an-invalid' },
                t('preview.invalidTitle'),
                e('ul', { className: 'an-list-indent' },
                  state.preview.invalid.map((item, index) =>
                    e('li', { key: item?.key ?? index },
                      `${item?.key ?? ''}${item?.reason ? ` — ${reasonText(t, item.reason) ?? item.reason}` : ''}`
                    )
                  )
                )
              )
            }
            let descLine = null
            if (state.preview?.description) {
              descLine = e(Hint, null, Object.entries(state.preview.description).map(([key, value]) =>
                e('span', { key, className: 'an-mr12' }, `${key}: ${value}`)
              ))
            }
            return e('div', null,
              state.previewError ? e(ErrorBox, { error: state.previewError }) : null,
              textBlock,
              charLine,
              invalidBlock,
              descLine
            )
          })()

          return e(Card, {
            id: 'preview',
            t,
            ...cardSlot('preview'),
            title: t('preview.title'),
            desc: t('preview.desc'),
            aside: previewAside
          }, previewBody)
        })(),

        // ---------------- 底部保存栏 ----------------
        //
        // 这里是这一页**唯一**的保存与恢复默认入口。原来六处按钮散在四张卡里
        // （其中四条调的都是同一个 doSave），用户要先判断「我在哪张卡」才知道
        // 该按哪个；而把所有卡都收进分区导航之后，那张卡可能根本不在眼前。
        //
        // 工作区覆盖有自己的脏状态（写的是工作区文件，不是全局配置），
        // 但对用户来说都是「我改了东西还没落盘」，所以同一根栏里一起报、一起存。
        e('div', { className: 'an-savebar' },
          e('div', { className: dirty || wsDirty ? 'an-savebar-text an-savebar-text-dirty' : 'an-savebar-text' },
            dirty || wsDirty ? t('savebar.dirty') : t('savebar.clean')
          ),
          e('div', { className: 'an-actions' },
            e('button', {
              type: 'button',
              className: 'an-btn',
              disabled: state.saving || state.workspaceSaving,
              onClick: doReset
            }, t('common.reset')),
            e('button', {
              type: 'button',
              className: 'an-btn an-btn-primary',
              disabled: !(dirty || wsDirty) || state.saving || state.workspaceSaving,
              onClick: doSaveAll
            }, t('common.save'))
          )
        )
      )
    }

    // -------------------------------------------------------------------------
    // 装配
    // -------------------------------------------------------------------------

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const controller = new AnimaController()
      ctx.provide('animaController', controller)
      ctx.effect(() => () => controller.dispose(), 'dsh-anima: browser lifecycle')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-anima: dictionaries')

      // 宿主样式插入（随客户端运行清理）
      ctx.effect(() => {
        const previous = document.querySelector('style[data-plugin-css="dsh-anima/styles.css"]')
        if (previous) previous.remove()
        const tag = document.createElement('style')
        tag.setAttribute('data-plugin-css', 'dsh-anima/styles.css')
        tag.textContent = css
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'dsh-anima: styles')

      const navT = ctx.locale.bind(NS)

      // ── 设置导航图标 ────────────────────────────────────────────────────
      //
      // DSH 的设置导航图标是壳层硬编码的 id → 图标映射（见 ui-settings-general 的
      // navIcon()：account/models/agent-presets/plugins/archived-sessions，其余一律
      // 回退成设置齿轮），插件无法通过槽位声明自己的图标（settings.section 的选项
      // 只有 id / order / label）。因此改用 DOM 替换。
      const NAV_MARKER = 'data-an-settings-nav'
      const ICON_MARKER = 'data-an-icon-replaced'

      // 与某同类人设插件的图标（光轨弧 + 火花）刻意不同形，避免两个栏目在导航栏里
      // 长得一样。本插件管的是「人设 + 记忆」，故用「人像 + 火花」：
      // 头 + 肩是「谁」，火花是「随时间沉淀下来」。单色线描，配色交给 currentColor
      // —— 与邻居统一，并自动跟随主题/选中/禁用态，不必自己判暗色。
      const NAV_ICON_VIEW_BOX = '3.8 3.8 28.4 28.4'
      const NAV_ICON_HEAD_D = 'M18 8.6a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 1 0 0-9.2'
      const NAV_ICON_BODY_D = 'M8.8 29.8c0-5.08 4.12-9.2 9.2-9.2s9.2 4.12 9.2 9.2'
      const NAV_ICON_SPARK_D = 'M27.2 5.2c.32 2.2 1.78 3.66 3.98 3.98-2.2.32-3.66 1.78-3.98 3.98-.32-2.2-1.78-3.66-3.98-3.98 2.2-.32 3.66-1.78 3.98-3.98Z'
      // 线宽按**显示后的像素**与邻居对齐：宿主图标是 16 网格 + 1.3 线宽，而我们
      // 的窗口是 28.4 单位宽、显示成 16px（缩放 16 ÷ 28.4 ≈ 0.5634），所以取
      // 1.3 ÷ 0.5634 ≈ 2.3。
      const NAV_ICON_STROKE_WIDTH = '2.3'
      // 宿主按 size=16 渲染，宽高是 svg 的属性（不是 CSS）。将来若改由 CSS 控制
      // 尺寸，由这里补一个 16 —— 否则 svg 会退回 300×150 默认尺寸，撑坏导航栏。
      const NAV_ICON_FALLBACK_SIZE = '16'

      /** 建一个 SVG 元素并铺上属性（避免 innerHTML，无需解析）。 */
      const svgNode = (name, attributes) => {
        const node = document.createElementNS(SVG_NS, name)
        for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value)
        return node
      }

      /**
       * 把导航按钮里宿主生成的齿轮图标改画成本插件的图标。
       *
       * 只替换 <svg> 的内容与 viewBox，保留节点本身 —— 宿主的 className、width/
       * height（size=16）与 aria-hidden 因此原样生效，不必自己复刻尺寸规则；
       * 只有宿主将来不给宽高时才补默认值。
       *
       * 宿主 svg 上挂着 fill="none" 与 stroke-width，会向下继承，所以每条 path
       * 都写全自身样式：头与肩只要描边，火花只要填充（描边会把那个尖角撑钝）。
       */
      const paintNavIcon = (svg) => {
        svg.setAttribute('viewBox', NAV_ICON_VIEW_BOX)
        if (!svg.getAttribute('width')) svg.setAttribute('width', NAV_ICON_FALLBACK_SIZE)
        if (!svg.getAttribute('height')) svg.setAttribute('height', NAV_ICON_FALLBACK_SIZE)

        const strokeProps = {
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': NAV_ICON_STROKE_WIDTH,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round'
        }
        const head = svgNode('path', { d: NAV_ICON_HEAD_D, ...strokeProps })
        const body = svgNode('path', { d: NAV_ICON_BODY_D, ...strokeProps })
        const spark = svgNode('path', { d: NAV_ICON_SPARK_D, fill: 'currentColor', stroke: 'none' })

        svg.replaceChildren(head, body, spark)
      }

      // 导航按钮靠文字识别：label 由 locale 词典渲染，中英两版都要认。
      // 词典变了这里得同步 —— 是刻意的耦合，因为文档化的 settings.section 只给
      // 了 id/order/label，没有「把 DOM 节点指给我」的钩子。
      const NAV_LABELS = new Set([zh['nav.label'], en['nav.label']])

      const registerSettingsNavIcon = () => {
        let disposed = false
        let timer = null

        // 没有 DOM 查询能力就整体不接管：客户端跑在受限环境（或测试替身）里时，
        // 图标替换属于纯粹的锦上添花，不该因此让整个客户端装载失败。
        if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
          return () => {}
        }

        const sync = () => {
          if (disposed) return
          const buttons = document.querySelectorAll('[role="dialog"] nav button')
          for (const button of buttons) {
            if (!NAV_LABELS.has(button.textContent?.trim())) {
              button.removeAttribute(NAV_MARKER)
              continue
            }
            button.setAttribute(NAV_MARKER, '')
            // React 重建按钮时标记随之消失，会重新画一次
            if (button.hasAttribute(ICON_MARKER)) continue
            const existingIcon = button.querySelector('svg')
            if (existingIcon) {
              button.setAttribute(ICON_MARKER, 'true')
              paintNavIcon(existingIcon)
            }
          }
        }

        // 延迟首跑：设置面板尚未渲染时 querySelectorAll 拿到空列表
        timer = setTimeout(sync, 500)

        const observer = typeof MutationObserver === 'function'
          ? new MutationObserver(() => {
              // 防抖必须在回调里重新赋值 timer —— 否则 clearTimeout 永远只清掉
              // 首跑那个计时器，防抖形同虚设，每次 DOM 变动都调度一次 sync。
              clearTimeout(timer)
              timer = setTimeout(sync, 100)
            })
          : null
        if (observer) observer.observe(document.body, { childList: true, subtree: true })

        return () => {
          disposed = true
          clearTimeout(timer)
          if (observer) observer.disconnect()
          if (typeof document.querySelectorAll !== 'function') return
          document.querySelectorAll(`[${NAV_MARKER}]`).forEach((el) => el.removeAttribute(NAV_MARKER))
          document.querySelectorAll(`[${ICON_MARKER}]`).forEach((el) => el.removeAttribute(ICON_MARKER))
        }
      }

      ctx.effect(() => registerSettingsNavIcon(), 'dsh-anima: settings navigation icon')

      // ── 自动刷新 ────────────────────────────────────────────────────────
      //
      // 设置页开着的时候，状态还可能从别处变化：命令行的 /anima set、模型调
      // set_assistant_persona、另一个窗口里的操作。没有这条线，用户看到的就是
      // 一份打开那一刻的旧快照，还会拿它去覆盖新值。
      //
      // 只在「用户回到这一页」时拉一次 —— 不做定时轮询。理由是收益太低而代价
      // 明确：每隔几秒打一次本地 HTTP，换来的多半是「和刚才一模一样的数据」，
      // 却让设置页一直有后台请求在跑。
      ctx.effect(() => {
        const target = globalThis.document
        if (!target || typeof target.addEventListener !== 'function') return undefined
        // 浏览器里 globalThis 就是 window，两个监听器都挂得上；但宿主以外的
        // 运行环境（测试替身）可能没有 window.addEventListener，故分开判。
        const hasWindowEvents = typeof globalThis.addEventListener === 'function'
        let lastAt = 0
        const refresh = () => {
          if (controller.disposed) return
          // 后台↔前台切换与点击聚焦常常连着触发，10 秒内只认第一次，
          // 否则每次点回窗口都打两个一模一样的请求。
          const now = Date.now()
          if (now - lastAt < 10000) return
          lastAt = now
          controller.loadState()
        }
        const onVisible = () => {
          if (target.visibilityState === 'visible') refresh()
        }
        target.addEventListener('visibilitychange', onVisible)
        if (hasWindowEvents) globalThis.addEventListener('focus', refresh)
        return () => {
          target.removeEventListener('visibilitychange', onVisible)
          if (hasWindowEvents) globalThis.removeEventListener('focus', refresh)
        }
      }, 'dsh-anima: settings auto refresh')

      // ── 槽位注册 ────────────────────────────────────────────────────────

      // 设置页注册：id 必须与某同类人设插件的 它占用的设置页 id 区分开，
      // 否则会顶替它的那一格（settings.section 的文档：复用已有 id 即替换该格）。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'anima-settings',
        order: 51,
        label: () => navT('nav.label'),
        locale: NS,
        inject: () => ({
          hooks: { animaStore: controller.store },
          controller
        })
      }, AnimaSettings))

      // 输入框左下角的快捷开关。id 同样避开某同类人设插件的 它占用的快捷开关 id。
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'anima-quick-toggle',
        order: 51,
        locale: NS,
        inject: () => ({
          hooks: { animaStore: controller.store },
          controller
        })
      }, AnimaQuickToggle))

      // 输入框光轨。挂 overlay 槽位是因为它渲染在卡片内部，closest 能定位到卡片；
      // id 避开某同类人设插件的 它占用的光轨开关 id。
      ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay',
        id: 'anima-trail',
        order: 51,
        inject: () => ({
          hooks: { animaStore: controller.store }
        })
      }, AnimaTrail))

      controller.loadState()
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
