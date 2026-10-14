// scripts/stub-dsh-storage-domain.mjs — 仅测试用的 @deepseek-ai/dsh-storage-domain 替身
//
// 为什么需要它：真实包由宿主体内解析，进程外的测试（smoke-host / verify-core）
// import 不到。装上 profile 后走的是真实包（与 dsh-checkpoint-rewind 同一条路径）。
//
// 替身复刻真实包**被本插件用到**的那部分语义：
//   ① defineDomain(spec) —— 只做名称/版本/表的形状校验，返回 spec 的浅拷贝；
//   ② domainTable(valueSchema) —— 包一层，让 spec 里的表定义可被识别；
//   ③ 真实的 open() 在宿主侧，这里由冒烟测试自己提供（见 smoke-host 的 makeCtx）。
//
// ⚠️ 替身只保证「本插件调用的形态成立」，不保证真实 zod 校验行为；
//    真实校验（invalid-record 等）由装机后的 check-live 覆盖。

export function defineDomain(spec) {
  if (spec === null || typeof spec !== 'object') {
    throw new Error('defineDomain: expected a spec object')
  }
  const { name, version, tables } = spec
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`domain name must match /^[a-z][a-z0-9_]*$/, got ${JSON.stringify(name)}`)
  }
  // 与真实包逐字对齐（dsh-storage-domain\lib\index.js:63）：版本只需是非负整数。
  // 这里**刻意不**校验「同一进程内版本不能递减」—— 真实包没有这条约束。曾误加过这条
  // 检查，结果是替身自己挡下了合法调用，报出一个真实环境里不存在的错误：替身比真实包
  // 更严不会更安全，只会制造无法复现的假失败。
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`domain '${name}' version must be a non-negative integer, got ${JSON.stringify(version)}`)
  }
  if (tables === null || typeof tables !== 'object' || Object.keys(tables).length === 0) {
    throw new Error(`domain '${name}' must declare at least one table`)
  }
  return { ...spec }
}

export function domainTable(valueSchema) {
  return { valueSchema, __key: undefined }
}
