// scripts/tools-loader.mjs — 仅供测试：把宿主内建包解析到本地替身。
//
// 真实包会 import cordis / schemastery / dsh-scope / dsh-llm 等宿主内建模块，
// 在 DSH 之外的进程里加载不进来。装进 profile 后走的是真实包。

const STUBS = new Map([
  ['@deepseek-ai/dsh-tools', new URL('./stub-dsh-tools.mjs', import.meta.url).href],
  ['@deepseek-ai/dsh-llm', new URL('./stub-dsh-llm.mjs', import.meta.url).href],
  ['@deepseek-ai/dsh-storage-domain', new URL('./stub-dsh-storage-domain.mjs', import.meta.url).href]
])

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS.get(specifier)
  if (stub !== undefined) {
    return { url: stub, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
