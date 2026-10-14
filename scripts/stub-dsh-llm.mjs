// scripts/stub-dsh-llm.mjs — 仅供测试：把 `@deepseek-ai/dsh-llm` 里的消息工厂替成最小实现。
//
// 真实包会连上 cordis / 模型适配器等宿主内建模块，在 DSH 之外的进程里加载不进来。
// 本替身只保证**调用形态**：插件真正用到的只有 `createUserMessage`，它拿到的
// 是 `{content, source}`，这里原样包一层返回，让被测代码能把消息交给假 Agent。

export function createUserMessage(input) {
  const message = {
    role: 'user',
    content: Array.isArray(input?.content) ? input.content : [],
    source: input?.source
  }
  if (input?.createdAt !== undefined) message.createdAt = input.createdAt
  return message
}
