// lib/workspace.mjs — 工作区两级覆盖的读写与解析
//
// 存储位置：<workspace>/.dsh-anima/override.json
//   - 跟项目走、可 git、可拷给别人（拍板 ⑦）
//   - 风险：会进用户的 git，第一次 commit 就可能把私人语气推到远程。
//     因此本模块额外维护 .gitignore，默认忽略整个目录（可关）。
//
// 解析链：会话 cwd → 向上找最近的 override.json → sanitizeOverrides → mergePersona

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { sanitizeOverrides } from './config.mjs'

const OVERRIDE_FILE = 'override.json'

export function overrideDirFor(workspacePath, dirName) {
  return join(workspacePath, dirName || '.dsh-anima')
}

export function overrideFileFor(workspacePath, dirName) {
  return join(overrideDirFor(workspacePath, dirName), OVERRIDE_FILE)
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    if (err instanceof SyntaxError) {
      const e = new Error(`覆盖文件不是合法 JSON：${path}`)
      e.code = 'INVALID_JSON'
      throw e
    }
    throw err
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, path)
}

/**
 * 确保工作区目录不需要把覆盖文件提交进 git。
 * 在覆盖目录内写一个 .gitignore（内容 `*`），该规则只作用于本目录。
 * 失败不抛错 —— gitignore 只是保险，不该阻断保存。
 */
export async function ensureIgnored(workspacePath, dirName) {
  try {
    const gitignore = join(overrideDirFor(workspacePath, dirName), '.gitignore')
    await mkdir(dirname(gitignore), { recursive: true })
    await readFile(gitignore, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      try {
        await writeFile(join(overrideDirFor(workspacePath, dirName), '.gitignore'), '*\n', 'utf8')
      } catch { /* 忽略 */ }
    }
  }
}

/**
 * 读取某工作区的覆盖。
 * @returns {{overrides: object, path: string, exists: boolean, errors: Record<string,string>}}
 */
export async function readOverrides(workspacePath, dirName) {
  const path = overrideFileFor(workspacePath, dirName)
  let raw = null
  try {
    raw = await readJsonIfExists(path)
  } catch (err) {
    if (err.code === 'INVALID_JSON') {
      return { overrides: {}, path, exists: true, errors: { _: err.message } }
    }
    throw err
  }
  if (raw === null) return { overrides: {}, path, exists: false, errors: {} }
  const { overrides, errors } = sanitizeOverrides(raw)
  return { overrides, path, exists: true, errors }
}

/** 写入某工作区的覆盖；空对象表示清除覆盖（写空文件而不是删文件，便于用户看到）。 */
export async function writeOverrides(workspacePath, dirName, overrides) {
  const path = overrideFileFor(workspacePath, dirName)
  await writeJsonAtomic(path, { overrides })
  invalidateSyncCache(path)
  return path
}

/** 删除覆盖文件；不存在返回 false。 */
export async function removeOverrides(workspacePath, dirName) {
  const path = overrideFileFor(workspacePath, dirName)
  try {
    const { rm } = await import('node:fs/promises')
    await rm(path)
    invalidateSyncCache(path)
    return true
  } catch (err) {
    if (err && err.code === 'ENOENT') return false
    throw err
  }
}

/**
 * 从会话 cwd 向上寻找最近的覆盖文件（同步版）。
 *
 * **为什么需要同步版**：`systemPrompt.section()` 的 `text` 为函数时，
 * dsh-system-prompt 在装配期是**同步**调用 `section.text(context)`（见
 * dsh-system-prompt\lib\index.js:342），拿不到 Promise。而 section 必须在
 * 每一轮装配期重新求值才能反映「此时此会话的工作区」，所以这条读取路径
 * 只能是同步的。
 *
 * 用 mtime 做缓存键：文件没变就不重复解析，避免每个模型 step 都读盘。
 *
 * @returns {{workspacePath: string, overrides: object, path: string, errors: object}|null}
 */
const syncCache = new Map() // path -> {mtimeMs, size, result}

export function resolveOverridesFromCwdSync(cwd, dirName) {
  if (!cwd || typeof cwd !== 'string') return null
  const name = dirName || '.dsh-anima'
  let current = resolve(cwd)
  const root = resolve(sep)

  for (let depth = 0; depth < 32; depth += 1) {
    const candidate = join(current, name, OVERRIDE_FILE)
    let stat = null
    try {
      stat = statSync(candidate)
    } catch {
      stat = null
    }
    if (stat && stat.isFile()) {
      const cached = syncCache.get(candidate)
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached.result === null ? null : { ...cached.result, workspacePath: current }
      }
      let result
      try {
        const raw = JSON.parse(readFileSync(candidate, 'utf8'))
        const { overrides, errors } = sanitizeOverrides(raw)
        result = { overrides, path: candidate, errors }
      } catch (err) {
        result = {
          overrides: {},
          path: candidate,
          errors: { _: err instanceof SyntaxError ? `覆盖文件不是合法 JSON：${candidate}` : String(err?.message || err) }
        }
      }
      syncCache.set(candidate, { mtimeMs: stat.mtimeMs, size: stat.size, result })
      return { ...result, workspacePath: current }
    }
    if (current === root) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

/** 写入后使同步缓存失效（否则同一 mtime 精度内的连续写入会读到旧值）。 */
export function invalidateSyncCache(path) {
  if (path) syncCache.delete(path)
  else syncCache.clear()
}
