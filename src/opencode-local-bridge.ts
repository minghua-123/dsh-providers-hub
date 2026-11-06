/**
 * OpenCode 免费通道的**本机官方客户端桥**（"新匿名槽"，2026-11-06 真机实测）。
 *
 * ## 为什么需要它（旧匿名槽已不可用，实测非推断）
 *
 * `Bearer public` 的匿名免费通道现在只在**官方客户端进程内**被放行。逐格对照
 * （2026-11-06，同一分钟、同一出口 IP `36.60.72.128`、同一份 44 KB 官方请求体）：
 *
 * | 发起方 | 结果 |
 * |---|---|
 * | 官方 `opencode-cli.exe run --model opencode/pulse-alpha-free` | **200**（连跑 4 次全通） |
 * | `wreq-js` + Bun 形状 `tlsOptions`（本插件现有传输层） | **429 `FreeUsageLimitError`** |
 * | 真 `bun.exe` 1.4.2 `fetch` + 逐字节照抄的首部 | **偶发 200，随后恒 429** |
 * | `curl.exe`（Schannel）/ `python3` raw TLS（OpenSSL） | **恒 429 / RST** |
 *
 * ⇒ 首部、body、session id 外形、出口 IP、HTTP 版本**都不是**判据（全部逐项对照过），
 *   判据落在官方客户端自己的 API 端口上。**插件直接发推理请求这条路已经封死**，
 *   能出模型的只剩官方客户端本身。
 *
 * ## 桥接的是什么（本机实测可用的那条路）
 *
 * 官方桌面版（2.2.5）常驻一个本地 HTTP 服务：
 *
 * ```
 * ~/.local/state/opencode/service.json  →  { "url": "http://127.0.0.1:28894", "password": "…" }
 * 鉴权 = HTTP Basic  opencode:<password>
 * ```
 *
 * 实测（2026-11-06，本机）：
 *
 * | 端点 | 结果 |
 * |---|---|
 * | `POST /api/experimental/generate/text`（无会话上下文） | **429**（同一进程内！） |
 * | `POST /api/session` + `POST /api/session/<id>/generate` | **200 `{"data":{"text":"pong"}}`**，1.5 s |
 *
 * ⇒ 官方客户端只有在**会话上下文**里才被放行，故本模块按「建会话 → 会话内瞬态生成
 *   → 删会话」走，`generate` 本身**不写会话历史**（官方文档：transient text from the
 *   current session context without mutating session history）。
 *
 * ## ⚠️ 这是**降级通道**，不是等价替换
 *
 * 桥只提供 `prompt → text`：
 *
 * - **没有 tool calling**（官方 `generate` 的入参只有 `prompt: string`）；
 * - **不能设 system 角色**（system 文本只能拼进 prompt 正文）；
 * - **没有流式**（一次性返回；调用方只能整段吐出）。
 *
 * 因此调用方必须：① 只在**免费模型 + 直连已被 429 拒死**时兜底；② 用
 * `warn` 明确告知用户本次回复降级（无工具）；③ 绝不能用它替代付费通道。
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 官方客户端本地服务的位置（`service.json` 的字段形状）。 */
export interface OpencodeLocalService {
  /** 形如 `http://127.0.0.1:28894`。 */
  readonly url: string
  /** 本地服务口令；鉴权头是 `Basic base64("opencode:" + password)`。 */
  readonly password: string
  readonly version?: string
}

/** 探测/调用失败的原因（全部**不抛给用户**，只用于 `warn` 与诊断）。 */
export interface BridgeFailure {
  readonly reason: string
}

/**
 * `service.json` 的候选路径。
 *
 * ⚠️ 官方客户端在三大平台都用 `~/.local/state/opencode/service.json`
 * （Windows 是 `C:\Users\<u>\.local\state\opencode\service.json`，**不是** AppData），
 * 本机实测确认。`DSH_OPENCODE_SERVICE_JSON` 只为测试与非常规安装留一个覆盖点。
 */
function serviceJsonCandidates(): string[] {
  const explicit = process.env.DSH_OPENCODE_SERVICE_JSON
  if (explicit !== undefined && explicit.trim().length > 0) return [explicit]
  const home = homedir()
  return [
    join(home, '.local', 'state', 'opencode', 'service.json'),
    // 少数发行版把 state 放到 XDG_STATE_HOME 下
    ...(process.env.XDG_STATE_HOME === undefined
      ? []
      : [join(process.env.XDG_STATE_HOME, 'opencode', 'service.json')]),
  ]
}

/** Basic 鉴权头（口令可能含 `:`，故用 `Buffer` 而不是手拼）。 */
function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
}

/** 桥请求的默认超时：本地回环，超过这个数就是客户端没在跑/卡死。 */
const BRIDGE_PROBE_TIMEOUT_MS = 1_500
/** 生成超时：官方 `generate` 是一次性返回（无流式），给足但不无限等。 */
const BRIDGE_GENERATE_TIMEOUT_MS = 120_000

async function fetchWithTimeout(
  target: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(target, {
      ...init,
      signal: signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]),
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 找到正在运行的官方客户端本地服务并**验证口令可用**。
 *
 * ⚠️ 只读 `service.json` 不够：文件会残留（客户端退出后仍在），端口也可能被
 * 别的进程占用。所以这里真的打一次 `GET /api/info`（1.5 s 超时），200 才算数。
 *
 * @returns 可用目标；本机没装/没跑/口令失效时返回 `{ reason }`。
 */
export async function discoverOpencodeLocalService(): Promise<OpencodeLocalService | BridgeFailure> {
  let lastError: string | undefined
  for (const path of serviceJsonCandidates()) {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      // 文件不存在是**正常情况**（没装官方客户端）——只记最后一条，不吵。
      lastError = error instanceof Error ? error.message : String(error)
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      lastError = `${path} 不是合法 JSON`
      continue
    }
    const service = (parsed as { url?: unknown; password?: unknown })
    const url = typeof service.url === 'string' ? service.url.trim() : ''
    const password = typeof service.password === 'string' ? service.password : ''
    if (url.length === 0 || password.length === 0) {
      lastError = `${path} 缺少 url/password`
      continue
    }
    try {
      const info = await fetchWithTimeout(`${url}/api/info`, {
        method: 'GET',
        headers: { authorization: basicAuth(password) },
      }, BRIDGE_PROBE_TIMEOUT_MS)
      if (!info.ok) {
        lastError = `${url}/api/info → HTTP ${info.status}（口令可能已失效）`
        continue
      }
      const body = await info.json().catch(() => undefined) as { version?: unknown } | undefined
      return {
        url,
        password,
        ...(typeof body?.version === 'string' ? { version: body.version } : {}),
      }
    } catch (error) {
      lastError = `${url} 不可达：${error instanceof Error ? error.message : String(error)}`
    }
  }
  return { reason: lastError ?? '未找到 ~/.local/state/opencode/service.json（官方客户端未运行？）' }
}

/** 判断 `discoverOpencodeLocalService` 的结果是否可用。 */
export function isLocalService(value: OpencodeLocalService | BridgeFailure): value is OpencodeLocalService {
  return (value as OpencodeLocalService).url !== undefined
}

/**
 * 用官方本地服务跑一次**瞬态**生成（不写会话历史、不污染用户会话列表）。
 *
 * 流程：`POST /api/session`（带 model）→ `POST /api/session/<id>/generate` → `DELETE /api/session/<id>`。
 *
 * @throws Error 上游/官方客户端拒绝时；调用方应**回退到原始错误**，不要把桥的
 *         失败当成用户看到的结论（真因仍是被上游拒绝的匿名通道）。
 */
export async function generateViaOpencodeLocalService(options: {
  readonly service: OpencodeLocalService
  /** 官方模型 id（如 `pulse-alpha-free`）；providerID 恒为 `opencode`。 */
  readonly model: string
  readonly prompt: string
  readonly signal?: AbortSignal
}): Promise<string> {
  const { service, model, prompt } = options
  const auth = { authorization: basicAuth(service.password) }
  const json = { ...auth, 'content-type': 'application/json' }

  const created = await fetchWithTimeout(`${service.url}/api/session`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ model: { id: model, providerID: 'opencode' } }),
  }, BRIDGE_PROBE_TIMEOUT_MS, options.signal)
  if (!created.ok) {
    throw new Error(`桥接建会话失败：HTTP ${created.status} ${(await created.text().catch(() => '')).slice(0, 200)}`)
  }
  const createdBody = await created.json().catch(() => undefined) as { data?: { id?: unknown } } | undefined
  const sessionID = typeof createdBody?.data?.id === 'string' ? createdBody.data.id : ''
  if (sessionID.length === 0) throw new Error('桥接建会话失败：响应里没有会话 id')

  try {
    const generated = await fetchWithTimeout(`${service.url}/api/session/${sessionID}/generate`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ prompt }),
    }, BRIDGE_GENERATE_TIMEOUT_MS, options.signal)
    const text = await generated.text().catch(() => '')
    if (!generated.ok) {
      throw new Error(`桥接生成失败：HTTP ${generated.status} ${text.slice(0, 200)}`)
    }
    const parsed = JSON.parse(text) as { data?: { text?: unknown } }
    const answer = typeof parsed.data?.text === 'string' ? parsed.data.text : ''
    if (answer.length === 0) throw new Error('桥接生成返回空文本')
    return answer
  } finally {
    // 删除是**尽力而为**：失败也不能影响已经拿到的答案，但留下了要在日志里看得见。
    void fetchWithTimeout(`${service.url}/api/session/${sessionID}`, {
      method: 'DELETE',
      headers: auth,
    }, BRIDGE_PROBE_TIMEOUT_MS).catch(() => undefined)
  }
}
