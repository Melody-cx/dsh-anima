// client/index.mjs — dsh-anima Web UI 插件
//
// 在设置页新增一个栏目「灵台」（独立栏目，不依赖任何其它插件）：
//
//   1. 人设预设 —— 内置 6 套 + 自建；套用只覆盖预设声明的字段
//   2. 助手身份 —— AI 自己的名字与角色设定（dsh-soul 的 nickname 是「用户的名字」，
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
// 数据通道与 dsh-soul 保持同一形态：自建 fetch 打到本插件自己的 HTTP 路由
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
    const VERSION = '1.0.0'
    const REQUEST_TIMEOUT_MS = 15000

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

    // ── 光轨（对照 dsh-soul 的 trail 四项）──────────────────────────────
    //
    // 参数与 dsh-soul 保持一致，这样两者的观感不会出现「同一台机器上两套动效」；
    // 但实现完全自写：dsh-soul 用 8 层错位描边动画，这里同样画 8 层 —— 层数、
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
      notifyOnSessionStart: config?.memory?.notifyOnSessionStart !== false
    })

    /**
     * 工具确认门槛 + 光轨四项（对照 dsh-soul 的 requireToolConfirmation / trail*）。
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

    // -------------------------------------------------------------------------
    // 轻量快照 store（dsh-soul 同款 —— 第三方插件不能用 client-runtime 的 store）
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
      '.an-root{display:flex;flex-direction:column;gap:16px;padding:4px 0 32px}',
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
      '.an-audit-changes{margin-top:6px;display:flex;flex-direction:column;gap:4px}',
      '.an-audit-change{display:flex;gap:8px;font-size:11px;line-height:1.6;align-items:baseline}',
      '.an-audit-key{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-family:Consolas,Menlo,monospace}',
      '.an-audit-arrow{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);word-break:break-word}',
      '.an-audit-from{text-decoration:line-through;text-decoration-color:color-mix(in srgb, currentColor 50%, transparent)}',
      '.an-audit-to{color:var(--dsw-alias-label-primary)}',
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
      '.an-proposal-detail{margin-top:6px;font-family:Consolas,Menlo,monospace;color:var(--dsw-alias-label-secondary);word-break:break-all}'
    ].join('')

    // -------------------------------------------------------------------------
    // 词典
    // -------------------------------------------------------------------------

    const zh = {
      'nav.label': '灵台',
      'page.title': '灵台',
      'page.desc': '这里管 AI 自己的名字与角色、按工作区的覆盖，以及带待审缓冲区的长期记忆。',

      'identity.title': '助手身份',
      'identity.desc': '描述 AI 自己是谁。与下面「用户背景」方向相反 —— 那段描述你，这段描述它。',
      'identity.name': 'AI 的名字',
      'identity.nameHint': '这是助手叫自己的名字，不是你对它的称呼（那个在下一张卡里）。留空则不注入身份段落。',
      // 不给示例按钮，就在这里说清楚格式 —— 见 lib/wording.mjs 的 FIELD_EXAMPLES
      // 注释：名字被一键填进来太容易被原样留下，然后长期叫错。
      'identity.namePlaceholder': '例如「小沃」「阿榆」——两三个字，别用职位或昵称',
      'identity.role': '角色设定',
      'identity.roleHint': '例如「资深架构师，先给结论再解释权衡」。上限 800 字。',
      'identity.enabled': '启用助手身份注入',
      'identity.enabledHint': '关闭后本插件不再向提示词写入身份与记忆段落。',

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
      'preset.desc': '预设是一套现成的人设字段组合。套用只覆盖它声明的字段，其余保持你当前的值。',
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
      'ws.desc': '只覆盖下面填写的字段，留空即继承全局。覆盖写入工作区目录内的文件，可随项目一起 git。',
      'ws.pick': '选择工作区',
      'ws.none': '（未选择）',
      'ws.empty': '尚未登记任何工作区。',
      'ws.enabled': '允许工作区覆盖',
      'ws.dir': '覆盖目录名',
      'ws.dirHint': '工作区根目录下的单段目录名，默认 .dsh-anima。',
      'ws.filePath': '覆盖文件',
      'ws.exists': '该工作区已有覆盖文件',
      'ws.notExists': '该工作区尚无覆盖文件',
      'ws.save': '保存覆盖',
      'ws.clear': '清除全部覆盖',
      'ws.saved': '工作区覆盖已保存',
      'ws.cleared': '工作区覆盖已清除',
      'ws.effective': '该工作区最终生效',
      'ws.globalOnly': '未选择工作区时，下面显示的是全局值。',
      'ws.hint': '留空 = 继承全局（灰色文字是当前全局值）',
      'ws.styleHint': '本工作区若要用别的说法，写在这里；留空就沿用全局。',
      'ws.inheritNow': '当前：继承全局 ——',
      'ws.inheritEmpty': '（全局这一项没填）',
      'ws.overrideNow': '当前：本工作区覆盖全局',
      'ws.inherit': '继承全局',
      'ws.section.identity': '助手身份',
      'ws.section.user': '用户背景',
      'ws.section.style': '风格与特质',

      'mem.title': '长期记忆',
      'mem.desc': '自动收集到的内容先进入待审缓冲区，由你逐条裁决；只有被采纳的才会进入提示词。',
      'mem.enabled': '启用记忆层',
      'mem.autoCapture': '自动收集候选',
      'mem.autoCaptureHint': '模型调用 remember 工具时写入缓冲区，不直接生效。',
      'mem.nightly': '每晚自动整理',
      'mem.nightlyHour': '整理时刻（0–23 时）',
      'mem.notify': '会话开始时提醒待审数量',
      'mem.maxPending': '缓冲区上限',
      'mem.maxInjected': '最多注入条数',
      'mem.maxInjectedHint': '0 = 一条都不注入（等于停用记忆注入）。',
      'mem.maxInjectedChars': '最多注入字符',
      'mem.maxInjectedCharsHint': '与条数取先到者；0 表示不限字符数。',
      'mem.pending': '待审缓冲区',
      'mem.adopted': '已采纳',
      'mem.discarded': '已丢弃',
      'mem.emptyPending': '缓冲区为空。',
      'mem.emptyAdopted': '还没有已采纳的记忆。',
      'mem.adopt': '采纳',
      'mem.discard': '丢弃',
      'mem.remove': '删除',
      'mem.triage': '立即整理',
      'mem.add': '手动添加',
      'mem.addPlaceholder': '要记住的内容（上限 500 字）',
      'mem.addNote': '备注（可选）',
      'mem.addScope': '作用域（可选，例如工作区路径）',
      'mem.lastTriage': '上次整理',
      'mem.triageDone': '整理完成',
      'mem.adoptedTag': '已采纳',
      'mem.pendingTag': '待审',
      'mem.discardedTag': '已丢弃',
      'mem.credential': '含凭据的内容会被直接拒收',
      // ── 一键导入（Phase ②）──
      'imp.open': '导入外部 AI 的记忆',
      'imp.step1': '第 1 步：把下面这段提示词复制到其它 AI 的对话里',
      'imp.step1Hint': '在你用得最多的那个 AI 里发一次，让它把你的偏好整理成一份清单。',
      'imp.copy': '复制提示词',
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
      'imp.done': '已导入 {n} 条到待审缓冲区，请在上面逐条裁决。',
      'imp.rejectedSome': '{n} 条未通过校验，未导入。',
      'imp.selected': '已选 {n} / {total} 条',
      // 同义提示：这条跟待审缓冲区里某条候选几乎一样。只提示，不替用户合并或丢弃 ——
      // 合并意味着生成一段他没说过的话（与 clusterPending 同一立场）。
      'imp.overlap': '待审缓冲区里已有一条很像：{text}',

      'inj.title': '注入情况',
      'inj.toggle': '查看每条为什么进 / 不进',
      'inj.hide': '收起',
      'inj.desc': '只有已采纳的记忆会进提示词，而且受条数与字符两个上限约束，先到者为准。',
      'inj.empty': '还没有已采纳的记忆。',
      'inj.count': '条数',
      'inj.chars': '字符',
      'inj.included': '已注入',
      'inj.excluded': '未注入',
      'inj.cwd': '按工作区',
      'inj.cwdNone': '当前会话没有工作区信息',

      'cluster.title': '疑似重复的候选',
      'cluster.similarity': '相似度',
      'conflict.title': '与已采纳记忆重复',
      'conflict.adopted': '已采纳',

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

      'preview.title': '提示词预览',
      'preview.toggle': '显示本插件注入的内容',
      'preview.desc': '只读。展示这段人设真正会写进提示词的样子 —— 含尚未保存的修改。',
      'preview.empty': '当前没有可注入的内容。',
      'preview.live': '已含未保存的修改',
      'preview.saved': '按已保存的设置渲染',
      'preview.refresh': '刷新预览',
      'preview.loading': '渲染中…',
      'preview.chars': '字符数',
      'preview.invalidTitle': '以下草稿没有被采纳（预览用的是上一次的合法值）：',

      // 卡片折叠
      'card.collapse': '收起',
      'card.expand': '展开',

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
      'trail.desc': '助手回复时，输入框外圈会有一道流动的光。纯前端动效，不写入提示词。',
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
      'proposal.gone': '该提议已不存在（进程重启会清掉待确认提议）'
    }

    const en = {
      'nav.label': 'Persona & Memory',
      'page.title': 'Persona & Memory',
      'page.desc': 'Owns the assistant\'s own name and role, per-workspace overrides, and long-term memory with a review buffer.',

      'identity.title': 'Assistant identity',
      'identity.desc': 'Describes who the assistant is. Opposite in direction to "Your background" below — that card describes you, this one describes the assistant.',
      'identity.name': 'Assistant name',
      'identity.nameHint': 'The name the assistant calls itself — not how you address it (that is the next card). Leave empty to skip the identity section.',
      'identity.namePlaceholder': 'e.g. "Wally", "Nova" — a word or two, not a job title or a pet name',
      'identity.role': 'Role',
      'identity.roleHint': 'For example "senior architect; conclusion first, then tradeoffs". Max 800 characters.',
      'identity.enabled': 'Inject assistant identity',
      'identity.enabledHint': 'When off, no identity or memory section is written to the prompt.',

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
      'preset.desc': 'A preset is a ready-made set of persona fields. Applying one overrides only the fields it declares; everything else keeps your current value.',
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
      'ws.desc': 'Only the fields you fill in are overridden; empty fields inherit the global value. The override lives inside the workspace and can be committed with the project.',
      'ws.pick': 'Workspace',
      'ws.none': '(none selected)',
      'ws.empty': 'No workspace registered yet.',
      'ws.enabled': 'Allow workspace overrides',
      'ws.dir': 'Override directory name',
      'ws.dirHint': 'A single directory name under the workspace root; defaults to .dsh-anima.',
      'ws.filePath': 'Override file',
      'ws.exists': 'This workspace has an override file',
      'ws.notExists': 'No override file yet',
      'ws.save': 'Save override',
      'ws.clear': 'Clear all overrides',
      'ws.saved': 'Workspace override saved',
      'ws.cleared': 'Workspace override cleared',
      'ws.effective': 'Effective in this workspace',
      'ws.globalOnly': 'With no workspace selected, the values below are the global ones.',
      'ws.hint': 'Empty means inherit from global (grey text is the current global value)',
      'ws.styleHint': 'Write a different wording for this workspace; leave empty to keep using the global one.',
      'ws.inheritNow': 'Now: inherited from global —',
      'ws.inheritEmpty': '(global field is empty)',
      'ws.overrideNow': 'Now: this workspace overrides global',
      'ws.inherit': 'Inherit global',
      'ws.section.identity': 'Assistant identity',
      'ws.section.user': 'Your background',
      'ws.section.style': 'Style and traits',

      'mem.title': 'Long-term memory',
      'mem.desc': 'Captured items land in a review buffer first. Only what you adopt reaches the prompt.',
      'mem.enabled': 'Enable memory',
      'mem.autoCapture': 'Auto-capture candidates',
      'mem.autoCaptureHint': 'The remember tool writes to the buffer; nothing takes effect directly.',
      'mem.nightly': 'Nightly tidy-up',
      'mem.nightlyHour': 'Hour (0–23)',
      'mem.notify': 'Mention pending count on session start',
      'mem.maxPending': 'Buffer limit',
      'mem.maxInjected': 'Max injected',
      'mem.maxInjectedHint': '0 = inject nothing at all (memory injection stops).',
      'mem.maxInjectedChars': 'Max injected characters',
      'mem.maxInjectedCharsHint': 'Whichever comes first with the count ceiling; 0 means no character limit.',
      'mem.pending': 'Review buffer',
      'mem.adopted': 'Adopted',
      'mem.discarded': 'Discarded',
      'mem.emptyPending': 'The buffer is empty.',
      'mem.emptyAdopted': 'No adopted memories yet.',
      'mem.adopt': 'Adopt',
      'mem.discard': 'Discard',
      'mem.remove': 'Delete',
      'mem.triage': 'Tidy up now',
      'mem.add': 'Add manually',
      'mem.addPlaceholder': 'What to remember (max 500 characters)',
      'mem.addNote': 'Note (optional)',
      'mem.addScope': 'Scope (optional, e.g. a workspace path)',
      'mem.lastTriage': 'Last tidy-up',
      'mem.triageDone': 'Tidy-up finished',
      'mem.adoptedTag': 'adopted',
      'mem.pendingTag': 'pending',
      'mem.discardedTag': 'discarded',
      'mem.credential': 'Content containing credentials is rejected outright',
      // ── Import from another AI (Phase ②) ──
      'imp.open': 'Import memories from another AI',
      'imp.step1': 'Step 1 — copy this prompt into another AI conversation',
      'imp.step1Hint': 'Send it once in whichever AI you use most, and let it write up your preferences as a list.',
      'imp.copy': 'Copy prompt',
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
      'imp.done': 'Imported {n} item(s) into the review buffer — decide on them above.',
      'imp.rejectedSome': '{n} item(s) failed validation and were not imported.',
      'imp.selected': '{n} of {total} kept',
      // Near-duplicate notice: this item closely matches a pending candidate already in
      // the review buffer. Notice only — never merged or dropped on the user's behalf.
      'imp.overlap': 'Already looks like this pending item: {text}',

      'inj.title': 'Prompt injection',
      'inj.toggle': 'Show why each item is in or out',
      'inj.hide': 'Hide',
      'inj.desc': 'Only adopted memories reach the prompt, and only within both the count and the character ceiling — whichever comes first.',
      'inj.empty': 'No adopted memories yet.',
      'inj.count': 'items',
      'inj.chars': 'characters',
      'inj.included': 'In',
      'inj.excluded': 'Out',
      'inj.cwd': 'By workspace',
      'inj.cwdNone': 'This session carries no workspace information',

      'cluster.title': 'Possibly duplicate candidates',
      'cluster.similarity': 'Similarity',
      'conflict.title': 'Duplicates an adopted memory',
      'conflict.adopted': 'Adopted',

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

      'preview.title': 'Prompt preview',
      'preview.toggle': 'Show what this plugin injects',
      'preview.desc': 'Read-only. Shows how this persona will actually read in the prompt, including unsaved edits.',
      'preview.empty': 'Nothing to inject right now.',
      'preview.live': 'Includes unsaved edits',
      'preview.saved': 'Rendered from saved settings',
      'preview.refresh': 'Refresh preview',
      'preview.loading': 'Rendering…',
      'preview.chars': 'Characters',
      'preview.invalidTitle': 'These draft fields were not accepted (the preview uses the last valid values):',

      // Card folding
      'card.collapse': 'Collapse',
      'card.expand': 'Expand',

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
      'trail.desc': 'A light runs around the input box while the assistant is replying. Pure front-end effect; never written into the prompt.',
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
      'proposal.gone': 'That proposal is gone (pending proposals are dropped when the process restarts)'
    }

    const FALLBACK_T = (key) => zh[key] ?? key

    // -------------------------------------------------------------------------
    // 小工具
    // -------------------------------------------------------------------------

    const STATUS_TAG_KEY = { pending: 'mem.pendingTag', adopted: 'mem.adoptedTag', discarded: 'mem.discardedTag' }

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
    // 只记「收起来了」的卡片 id（展开是默认态），存成一个小对象。设置页很长，
    // 每次进来都要把同样的几张卡重新收一遍很烦；但「记不住」最多是烦，让整个
    // 页面崩掉才是事故 —— 所以 localStorage 的读写全部吞掉异常（隐私模式、
    // 存储配额、非浏览器环境都可能在这两行上抛）。
    const COLLAPSED_KEY = 'dsh-anima:collapsed-cards'

    function readCollapsedCards() {
      try {
        const raw = globalThis.localStorage?.getItem(COLLAPSED_KEY)
        if (!raw) return {}
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
        const out = {}
        // 只认 true：存进去的脏值（0、"yes"、嵌套对象）一律按「没收起」处理，
        // 否则一次手改 localStorage 就能让某张卡永远打不开。
        for (const [key, value] of Object.entries(parsed)) if (value === true) out[key] = true
        return out
      } catch {
        return {}
      }
    }

    function writeCollapsedCards(value) {
      try {
        globalThis.localStorage?.setItem(COLLAPSED_KEY, JSON.stringify(value))
      } catch {
        // 存不下就算了：下次打开会全部展开，不影响任何设置本身。
      }
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
      return e('section', { className: `an-card${collapsed ? ' an-card-collapsed' : ''}` },
        e('div', { className: 'an-card-head' },
          e('div', { style: { minWidth: 0 } },
            e('h3', { className: 'an-card-title' }, props.title),
            props.desc ? e('p', { className: 'an-card-desc' }, props.desc) : null
          ),
          e('div', { className: 'an-card-aside' },
            props.aside ?? null,
            id ? e('button', {
              type: 'button',
              className: 'an-card-toggle',
              'aria-expanded': collapsed ? 'false' : 'true',
              title: collapsed ? t('card.expand') : t('card.collapse'),
              onClick: () => { if (typeof props.onToggle === 'function') props.onToggle(id) }
            }, collapsed ? t('card.expand') : t('card.collapse')) : null
          )
        ),
        collapsed ? null : props.children
      )
    }

    // ── 光轨实现 ────────────────────────────────────────────────────────
    //
    // 做法：往输入框卡片里插一层绝对定位的 SVG，画 8 条同心的圆角矩形描边，
    // 每条只露出一小段虚线（stroke-dasharray "12 88"）并按层号错开相位，
    // 动画让虚线段绕周长跑一圈 —— 叠起来就是「一圈光在环绕」。
    //
    // 三个必须自守的边界（都是 dsh-soul 踩过并写进注释的坑）：
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

      return e('div', { className: 'an-item' },
        e('div', { className: 'an-item-main' },
          e('div', { className: 'an-item-text' }, record.text),
          e('div', { className: 'an-item-meta' },
            e('span', { className: 'an-badge' }, t(STATUS_TAG_KEY[record.status] ?? 'mem.pendingTag')),
            meta.map((text, index) => e('span', { key: index }, text))
          )
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

      return e('div', { className: 'an-field', style: { marginTop: 16 } },
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
          ? e('div', { className: 'an-kv', style: { marginTop: 10 } },
              bars.map(([labelKey, used, max]) => [
                e('dt', { key: `${labelKey}-k` }, t(labelKey)),
                e('dd', { key: `${labelKey}-v` }, `${used} / ${max}`)
              ]).flat()
            )
          : null,

        open
          ? e('div', null,
              decisions.length === 0
                ? e('div', { className: 'an-empty' }, t('inj.empty'))
                : e('div', { className: 'an-list' },
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
            )
          : null
      )
    }

    /**
     * 聚类与冲突提示。只提示，不自动合并 —— 合并等于替用户写一段他没说过的话，
     * 而本插件的立场是「判断什么值得记交给模型，什么真的生效交给用户」。
     */
    function ClusterNotes(props) {
      const t = props.t
      const clusters = Array.isArray(props.clusters) ? props.clusters : []
      const conflicts = Array.isArray(props.conflicts) ? props.conflicts : []
      if (clusters.length === 0 && conflicts.length === 0) return null

      return e('div', { style: { marginTop: 12 } },
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

      return e('div', { style: { marginTop: 20 } },
        e('div', { className: 'an-row-between' },
          e('div', { className: 'an-card-title' }, t('imp.open')),
          e('button', {
            type: 'button',
            className: 'an-btn an-btn-sm',
            onClick: () => (open ? closePanel() : setOpen(true))
          }, open ? t('imp.cancel') : t('imp.open'))
        ),

        open ? e('div', { className: 'an-import' },
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
            }, copied ? t('imp.copied') : t('imp.copy'))
          ),
          e('pre', { className: 'an-import-prompt' }, spec.prompt),

          e('hr', { className: 'an-import-divider' }),

          // ── 第 2 步：粘贴 ──
          e('div', { className: 'an-import-title' }, t('imp.step2')),
          e('div', { className: 'an-field', style: { marginTop: 8 } },
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
            }, busy === 'parse' ? t('imp.parsing') : t('imp.parse'))
          ),
          e(ErrorBox, { error }),

          // ── 解析结果 ──
          result ? e('div', null,
            e('hr', { className: 'an-import-divider' }),
            e('div', { className: 'an-import-title' }, t('imp.resultTitle')),
            e('div', { className: 'an-import-summary' },
              t('imp.resultCounts')
                .split('{pieces}').join(String(counts.pieces ?? items.length))
                .split('{accepted}').join(String(counts.accepted ?? items.length))
            ),

            items.length === 0
              ? e('div', { className: 'an-import-summary' }, t('imp.emptyResult'))
              : e('div', null,
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
              ),

            // ── 被拦下的部分：逐类说明为什么没进来 ──
            blocked.length > 0 ? e('div', { className: 'an-import-blocked' },
              e('div', null, t('imp.blockedTitle')),
              blocked.map((entry, index) => e('div', { key: `b-${index}` },
                e('code', null, `[${(entry.credentials ?? []).join(', ')}] `),
                entry.text
              )),
              e('div', null, t('imp.blockedHint'))
            ) : null,

            tooLong.length > 0 ? e('div', { className: 'an-import-summary' },
              t('imp.tooLongTitle'),
              e('div', null, t('imp.tooLongHint').split('{max}').join(String(500)))
            ) : null,

            duplicates.length > 0 ? e('div', { className: 'an-import-summary' },
              t('imp.duplicateTitle')
            ) : null,

            overflow.length > 0 ? e('div', { className: 'an-import-summary' },
              t('imp.overflowTitle'),
              e('div', null, t('imp.overflowHint').split('{max}').join(String(spec.maxItems)))
            ) : null,

            Number(counts.skipped ?? 0) > 0 ? e('div', { className: 'an-import-summary' },
              t('imp.skippedHint').split('{n}').join(String(counts.skipped))
            ) : null
          ) : null
        ) : null
      )
    }

    /**
     * 一条审计记录。
     *
     * 渲染上的两个取舍：
     *   ① 「原值 → 新值」用并排的两小段，而不是一行字符串拼接 —— 人设字段里
     *      有中文长句（自定义指令、角色描述），拼一行会读不出来；
     *   ② 值恰好相等（presets 这类只记规模的摘要）时只显示一次，不去编造差异。
     */
    function AuditItem(props) {
      const t = props.t
      const entry = props.entry
      const sourceText = props.sourceText ?? {}
      const actors = { user: t('audit.actor.user'), agent: t('audit.actor.agent'), system: t('audit.actor.system') }
      const show = (value) => (value === null || value === '' || value === undefined ? t('audit.emptyValue') : String(value))
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
              e('span', { className: 'an-audit-key' }, change.key),
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
     * 设置页「变更记录」卡片。
     *
     * 数据先由 /state 随包下发尾部若干条（省一次可能挂起的往返），
     * 展开时再打 /audit 取全量。
     */
    function AuditCard(props) {
      const t = props.t
      const state = props.state
      const controller = props.controller
      const setToast = props.setToast
      const open = state.showAudit === true
      const audit = state.audit ?? { entries: [], total: 0, max: 200, sourceText: {} }
      const entries = Array.isArray(audit.entries) ? audit.entries : []

      const toggle = async () => {
        controller.store.update((s) => { s.showAudit = !s.showAudit })
        if (!open) await controller.loadAudit()
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

      return e(Card, {
        id: 'audit',
        t,
        collapsed: props.collapsed === true,
        onToggle: props.onToggle,
        title: t('audit.title'),
        desc: t('audit.desc'),
        aside: e('div', { className: 'an-actions' },
          e('span', { className: 'an-badge' }, `${t('audit.total')} ${audit.total ?? 0} ${t('audit.records')}`.trim()),
          e('button', {
            type: 'button',
            className: 'an-btn an-btn-sm',
            onClick: toggle
          }, open ? t('audit.hide') : t('audit.toggle'))
        )
      },
        open
          ? e('div', null,
              state.auditError ? e(ErrorBox, { error: state.auditError }) : null,
              state.auditLoading && entries.length === 0
                ? e('div', { className: 'an-empty' }, t('audit.loading'))
                : (entries.length === 0
                    ? e('div', { className: 'an-empty' }, t('audit.empty'))
                    : e('div', { className: 'an-list' },
                        // 新的在上：读日志的人先关心「刚刚发生了什么」
                        entries.slice().reverse().map((entry) => e(AuditItem, {
                          key: entry.id,
                          t,
                          entry,
                          sourceText: audit.sourceText
                        }))
                      )),
              e('div', { className: 'an-actions', style: { marginTop: 12 } },
                e('button', {
                  type: 'button',
                  className: 'an-btn an-btn-sm an-btn-danger',
                  disabled: entries.length === 0,
                  onClick: clear
                }, t('audit.clear'))
              ),
              e(Hint, null, t('audit.maxHint'))
            )
          : null
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
          onDelete: props.onDelete
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

      const [local, setLocal] = React.useState(() => ({
        enabled: true,
        ...personaDefaults(),
        workspaceOverridesEnabled: true,
        workspaceFileDir: '.dsh-anima',
        memory: memoryDefaults(null),
        ...toolDefaults(null)
      }))
      const [wsLocal, setWsLocal] = React.useState(() => personaDefaults())
      const [newMemory, setNewMemory] = React.useState({ text: '', note: '', scope: '' })
      const [showPreview, setShowPreview] = React.useState(false)
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
      const [collapsed, setCollapsed] = React.useState(() => readCollapsedCards())
      // 导入面板（Phase ②）那一小块的全部状态。刻意提到这一层：ImportPanel 必须
      // 保持无状态（理由见那边的注释），而它内部的交互又比卡片折叠复杂得多 ——
      // 收在这里比在组件内部再摆一排 useState 更贵，但换来的是渲染树可被遍历式调用。
      const [memoryImport, setMemoryImport] = React.useState({})

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
        setCollapsed((prev) => {
          const next = { ...prev }
          if (next[id] === true) delete next[id]
          else next[id] = true
          writeCollapsedCards(next)
          return next
        })
      }

      // 每张卡的折叠接线都从这一处来：新增卡片时只要写 id，
      // 不必记得同时传 collapsed 与 onToggle（漏一个就是「按钮点了没反应」）。
      const cardState = (id) => ({ collapsed: collapsed[id] === true, onToggle: toggleCard })

      // 服务端状态 → 本地表单
      React.useEffect(() => {
        if (!config) return
        setLocal({
          enabled: config.enabled !== false,
          ...pickPersona(config),
          workspaceOverridesEnabled: config.workspaceOverridesEnabled !== false,
          workspaceFileDir: config.workspaceFileDir ?? '.dsh-anima',
          memory: memoryDefaults(config),
          ...toolDefaults(config)
        })
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
        if (!showPreview || !config) return undefined
        const timer = setTimeout(() => {
          controller.loadPreview(state.workspacePath, { ...pickPersona(local), enabledHint: undefined })
        }, 400)
        return () => clearTimeout(timer)
      }, [showPreview, previewKey])

      const patchLocal = (key, value) => setLocal((prev) => ({ ...prev, [key]: value }))
      const patchMemory = (key, value) => setLocal((prev) => ({ ...prev, memory: { ...prev.memory, [key]: value } }))
      const patchWs = (key, value) => setWsLocal((prev) => ({ ...prev, [key]: value }))

      // 提交给 host 的载荷形状（保存与脏检查必须完全一致，否则会出现「看着没改却一直脏」）
      const configPayload = (source) => ({
        enabled: source.enabled !== false,
        ...pickPersona(source),
        workspaceOverridesEnabled: source.workspaceOverridesEnabled !== false,
        workspaceFileDir: source.workspaceFileDir ?? '.dsh-anima',
        ...toolDefaults(source),
        memory: {
          enabled: source.memory?.enabled !== false,
          autoCapture: source.memory?.autoCapture !== false,
          nightlyTriage: source.memory?.nightlyTriage !== false,
          nightlyHour: Number(source.memory?.nightlyHour ?? 3),
          maxPending: Number(source.memory?.maxPending ?? 200),
          maxInjected: Number(source.memory?.maxInjected ?? 40),
          notifyOnSessionStart: source.memory?.notifyOnSessionStart !== false
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
        // 与 dsh-soul 删预设同一套写法（globalThis.confirm）：重置会清空
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

      return e('div', { className: 'an-root' },
        toast
          ? e('div', { className: `an-toast ${toast.kind === 'err' ? 'an-toast-err' : 'an-toast-ok'}` }, toast.text)
          : null,

        e('div', { className: 'an-row-between' },
          e('div', { style: { minWidth: 0 } },
            e('div', { style: { fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('page.title')),
            e('div', { className: 'an-hintline' }, t('page.desc'))
          ),
          e('span', { className: 'an-badge' }, `v${VERSION}`)
        ),

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
              state.pendingProposal.proposedAt
                ? e('div', { className: 'an-hintline', style: { marginTop: 6 } },
                    `${t('proposal.at')} ${shortTime(state.pendingProposal.proposedAt)}`)
                : null,
              e('div', { className: 'an-actions', style: { marginTop: 8 } },
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
          ...cardState('preset'),
          title: t('preset.title'),
          desc: t('preset.desc'),
          aside: e('span', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            activePreset
              ? e('span', { className: 'an-badge an-badge-ok', title: t('preset.activeHint') },
                `${t('preset.activeTag')}：${activePreset.name}`)
              : null,
            e('span', { className: 'an-badge' }, `${(state.presets ?? []).length} 项`)
          )
        },
          e('div', { className: 'an-row', style: { gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' } },
            e('div', { className: 'an-field', style: { flex: '1 1 240px' } },
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

          e('div', { style: { marginTop: 16 } },
            e('div', { className: 'an-card-title' }, t('preset.saveTitle')),
            e('div', { className: 'an-row', style: { gap: 8, marginTop: 10, flexWrap: 'wrap' } },
              e('div', { className: 'an-field', style: { flex: '1 1 200px' } },
                e('input', {
                  className: 'an-input',
                  type: 'text',
                  value: presetForm.name,
                  maxLength: 40,
                  placeholder: t('preset.namePlaceholder'),
                  onChange: (event) => setPresetForm((prev) => ({ ...prev, name: event.target.value }))
                })
              ),
              e('div', { className: 'an-field', style: { flex: '2 1 260px' } },
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
              ? e('div', { className: 'an-list', style: { marginTop: 10 } },
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
          ...cardState('identity'),
          title: t('identity.title'),
          desc: t('identity.desc'),
          aside: e('div', { className: 'an-actions' },
            dirty ? e('span', { className: 'an-badge' }, t('common.unsaved')) : null,
            e('button', {
              type: 'button',
              className: 'an-btn an-btn-primary',
              disabled: !dirty || state.saving,
              onClick: doSave
            }, t('common.save')),
            e('button', {
              type: 'button',
              className: 'an-btn',
              disabled: state.saving,
              onClick: doReset
            }, t('common.reset'))
          )
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
          state.source
            ? e('dl', { className: 'an-kv' },
                e('dt', null, t('source.label')),
                e('dd', null, `${state.source.kind === 'storage' ? t('source.domain') : t('source.none')}${state.source.path ? `　${state.source.path}` : ''}`),
                state.source.kind !== 'storage' && state.source.reason
                  ? e('dt', null, t('source.reason'))
                  : null,
                state.source.kind !== 'storage' && state.source.reason
                  ? e('dd', null, reasonText(t, state.source.reason))
                  : null,
                state.source.kind !== 'storage' && state.source.message
                  ? e('dt', null, t('source.message'))
                  : null,
                state.source.kind !== 'storage' && state.source.message
                  ? e('dd', null, state.source.message)
                  : null,
                // 「存储格式」一行：只在域真打开了（有版本戳）时出现。它是诊断信息 ——
                // 排查「插件到底读的哪份介质」时，位置与格式戳缺一不可。
                Number.isInteger(state.source.domainVersion)
                  ? e('dt', null, t('source.format'))
                  : null,
                Number.isInteger(state.source.domainVersion)
                  ? e('dd', null, t('source.formatText')
                    .split('{n}').join(String(state.source.domainVersion)))
                  : null
              )
            : null
        ),

        // ---------------- 用户背景 ----------------
        e(Card, {
          id: 'user',
          t,
          ...cardState('user'),
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
          ...cardState('style'),
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
          e('div', { className: 'an-row', style: { gap: 16, flexWrap: 'wrap' } },
            e('div', { style: { flex: '1 1 240px', minWidth: 0 } },
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
            e('div', { style: { flex: '1 1 240px', minWidth: 0 } },
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
            e('div', { style: { flex: '1 1 240px', minWidth: 0 } },
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
          e('div', { className: 'an-row', style: { gap: 16, flexWrap: 'wrap' } },
            e('div', { style: { flex: '1 1 240px', minWidth: 0 } },
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
            e('div', { style: { flex: '1 1 240px', minWidth: 0 } },
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
          ...cardState('trail'),
          title: t('trail.title'),
          desc: t('trail.desc')
        },
          e(Toggle, {
            id: 'trail-enabled',
            checked: local.trailEnabled === true,
            label: t('trail.enabled'),
            onChange: (checked) => patchLocal('trailEnabled', checked)
          }),
          e('div', { className: 'an-row', style: { gap: 16, flexWrap: 'wrap' } },
            e('div', { className: 'an-field', style: { flex: '1 1 200px' } },
              e('label', { htmlFor: 'an-trail-color' }, t('trail.color')),
              e('div', { className: 'an-row', style: { gap: 8, alignItems: 'center' } },
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
            e('div', { className: 'an-field', style: { flex: '1 1 140px' } },
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
            e('div', { className: 'an-field', style: { flex: '1 1 140px' } },
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
          e('div', { className: 'an-actions', style: { flexWrap: 'wrap' } },
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
          ...cardState('ws'),
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
          state.workspacePath
            ? e('div', null,
                e(Hint, null, t('ws.hint')),

                e('div', { className: 'an-card-title', style: { marginTop: 14 } }, t('ws.section.identity')),
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

                e('div', { className: 'an-card-title', style: { marginTop: 14 } }, t('ws.section.user')),
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

                e('div', { className: 'an-card-title', style: { marginTop: 14 } }, t('ws.section.style')),
                e(Hint, null, t('ws.styleHint')),
                e('div', { className: 'an-row', style: { gap: 16, flexWrap: 'wrap' } },
                  e('div', { style: { flex: '1 1 240px', minWidth: 0 } },
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
                  e('div', { style: { flex: '1 1 240px', minWidth: 0 } },
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
                  e('div', { style: { flex: '1 1 240px', minWidth: 0 } },
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
                e('div', { className: 'an-row', style: { gap: 16, flexWrap: 'wrap' } },
                  e('div', { style: { flex: '1 1 240px', minWidth: 0 } },
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
                  e('div', { style: { flex: '1 1 240px', minWidth: 0 } },
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
                  e('div', { style: { flex: '1 1 240px', minWidth: 0 } },
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

                wsState
                  ? e('div', { className: 'an-note' },
                      `${wsState.exists ? t('ws.exists') : t('ws.notExists')}　${wsState.path ?? ''}`
                    )
                  : null,
                e('div', { className: 'an-actions', style: { marginTop: 12 } },
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
            : e('div', { className: 'an-hintline' }, t('ws.globalOnly'))
        ),

        // ---------------- 长期记忆 ----------------
        e(Card, {
          id: 'mem',
          t,
          ...cardState('mem'),
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
          e('div', { className: 'an-row', style: { gap: 16 } },
            e('div', { className: 'an-field', style: { flex: '1 1 0' } },
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
            e('div', { className: 'an-field', style: { flex: '1 1 0' } },
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
            e('div', { className: 'an-field', style: { flex: '1 1 0' } },
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
          e('div', { className: 'an-actions' },
            e('button', {
              type: 'button',
              className: 'an-btn an-btn-primary',
              disabled: !dirty || state.saving,
              onClick: doSave
            }, t('common.save'))
          ),

          // 待审缓冲区
          e('div', { style: { marginTop: 20 } },
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
                }, t('mem.triage'))
              )
            ),
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
          e('div', { style: { marginTop: 20 } },
            e('div', { className: 'an-card-title' }, t('mem.add')),
            e('div', { className: 'an-field', style: { marginTop: 10 } },
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
          e('div', { style: { marginTop: 20 } },
            e('div', { className: 'an-card-title' }, `${t('mem.adopted')}（${adopted.length}）`),
            e(MemoryList, {
              t,
              items: adopted,
              status: 'adopted',
              emptyText: t('mem.emptyAdopted'),
              busy: Boolean(busyId),
              onDecide: decide,
              onDelete: removeMemory
            })
          ),

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
            ? e('div', { style: { marginTop: 16 } },
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

        // ---------------- 变更记录 ----------------
        // 放在记忆之后、预览之前：它记录的是「设置页上这些字段被谁改过」，
        // 挨着被记录的字段群读起来才连得起来。
        e(AuditCard, {
          t,
          state,
          controller,
          setToast,
          ...cardState('audit')
        }),

        // ---------------- 预览 ----------------
        e(Card, {
          id: 'preview',
          t,
          ...cardState('preview'),
          title: t('preview.title'),
          desc: t('preview.desc'),
          aside: e('div', { className: 'an-actions' },
            showPreview
              ? e('span', { className: 'an-badge' }, state.preview?.draft ? t('preview.live') : t('preview.saved'))
              : null,
            e('button', {
              type: 'button',
              className: 'an-btn an-btn-sm',
              onClick: () => setShowPreview((open) => !open)
            }, t('preview.toggle'))
          )
        },
          showPreview
            ? e('div', null,
                state.previewError ? e(ErrorBox, { error: state.previewError }) : null,
                state.previewLoading && !previewText
                  ? e('div', { className: 'an-empty' }, t('preview.loading'))
                  : (previewText ? e(Pre, { text: previewText }) : e('div', { className: 'an-empty' }, t('preview.empty'))),
                // 字符数：注入是要花上下文的，长人设会挤掉对话本身。给个数字，
                // 让「这段到底多长」有个可比较的量，而不是只能靠肉眼估。
                previewText
                  ? e(Hint, null, `${t('preview.chars')}: ${previewText.length}`)
                  : null,
                // 被校验挡下的草稿字段。预览刻意不为半截输入报错（用户还在打字），
                // 但必须说清楚「你刚打的这个没算进去」—— 否则用户会以为预览里
                // 就是自己输入的样子，而其实用的是上一次的合法值。
                Array.isArray(state.preview?.invalid) && state.preview.invalid.length > 0
                  ? e('div', { className: 'an-invalid' },
                      t('preview.invalidTitle'),
                      e('ul', { style: { margin: '4px 0 0', paddingLeft: 18 } },
                        state.preview.invalid.map((item, index) =>
                          e('li', { key: item?.key ?? index },
                            `${item?.key ?? ''}${item?.reason ? ` — ${reasonText(t, item.reason) ?? item.reason}` : ''}`
                          )
                        )
                      )
                    )
                  : null,
                state.preview?.description
                  ? e(Hint, null, Object.entries(state.preview.description).map(([key, value]) =>
                      e('span', { key, style: { marginRight: 12 } }, `${key}: ${value}`)
                    ))
                  : null
              )
            : null
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

      // 与 dsh-soul 的图标（光轨弧 + 火花）刻意不同形，避免两个栏目在导航栏里
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

      // 设置页注册：id 必须与 dsh-soul 的 'soul-settings' 区分开，
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

      // 输入框左下角的快捷开关。id 同样避开 dsh-soul 的 'soul-quick-toggle'。
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
      // id 避开 dsh-soul 的 'soul-trail'。
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
