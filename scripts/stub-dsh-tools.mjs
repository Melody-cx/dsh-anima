// scripts/stub-dsh-tools.mjs — 仅测试用的 @deepseek-ai/dsh-tools 替身
//
// 为什么需要它：真实包依赖 cordis / schemastery / dsh-scope / dsh-llm 等一堆
// 宿主内建模块，在没有 DSH 宿主的环境里 import 不进来。装上 profile 后
// 走的是真实包（与 dsh-soul 同一条解析路径）。
//
// 这个替身只复刻冒烟测试需要用到的部分：TOOL_RUNTIME_SCHEDULER 哨兵 +
// defineTool 的「参数属性表 → JSON Schema」转换 + 原样返回 execute。
//
// ⚠️ 替身必须复刻真实的拒绝规则，否则绿灯没有意义（上一次「存储域名含连字符」
//    缺陷就是因为替身没做校验而漏检）。这里复刻两处：
//    ① required 的层级差异：参数属性层允许 `required: true`；output.schema 走
//       compileValueSchema，根与嵌套出现 `required` 一律抛错。
//    ② output.render 的**无条件包装**：真实 defineTool 会执行
//       `const userRender = options.output.render` 并包出一个直接调用它的 render
//       （dsh-tools/lib/types/schema.js:283 与 :304-306）。注意它在**定义期不校验**，
//       所以缺 render 会注册成功、却让每次调用在展示层炸掉。替身必须同样只在调用期
//       暴露问题，否则「缺 render」这类缺陷又会溜过冒烟测试。

export const TOOL_RUNTIME_SCHEDULER = Symbol('test.dsh-tools.scheduler')

/** 复刻 compileValueSchema 对 required 的拒绝（根与嵌套都不放行）。 */
function assertNoRequired(value, path) {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRequired(item, `${path}[${index}]`))
    return
  }
  if (Object.hasOwn(value, 'required')) {
    throw new Error(`unsupported JSON schema: ${path}.required is not supported by the value schema DSL`)
  }
  for (const [key, child] of Object.entries(value)) {
    assertNoRequired(child, `${path}.${key}`)
  }
}

/** 把 { name: {type, description} } 属性表编译成 JSON Schema 对象。 */
function compilePropertyMap(spec, label) {
  if (spec === undefined || spec === null || typeof spec !== 'object') {
    throw new Error(`${label}: expected a property map`)
  }
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec)) {
    if (value === null || typeof value !== 'object') {
      throw new Error(`${label}.${key}: expected a property descriptor`)
    }
    const { description, required: isRequired, ...rest } = value
    if (isRequired !== undefined && isRequired !== true) {
      throw new Error(`${label}.${key}.required must be true when present`)
    }
    if (isRequired === true) required.push(key)
    properties[key] = {
      ...rest,
      ...(description === undefined ? {} : { description })
    }
  }
  return { properties, required }
}

export function defineTool(options) {
  if (!options || typeof options.name !== 'string' || options.name.length === 0) {
    throw new Error('defineTool: name is required')
  }
  if (typeof options.execute !== 'function') {
    throw new Error(`defineTool(${options.name}): execute is required`)
  }
  if (!options.output || typeof options.output !== 'object') {
    throw new Error(`defineTool(${options.name}): output is required`)
  }

  const compiled = compilePropertyMap(options.parameters, 'parameters')
  const parameters = {
    type: 'object',
    properties: compiled.properties,
    ...(compiled.required.length === 0 ? {} : { required: compiled.required })
  }
  const outputSchema = { ...options.output.schema }
  assertNoRequired(outputSchema, 'schema')

  // 复刻真实的 render 包装：定义期不校验，调用期才炸（报错文案与真实实现一致）。
  // oxlint-disable-next-line typescript/unbound-method
  const userRender = options.output.render

  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render(args, value) {
        return userRender(args, value)
      }
    },
    execute: options.execute
  }
}

export default { defineTool, TOOL_RUNTIME_SCHEDULER }
