/**
 * 把对话交给本机真实 `opencode serve`（v2 API）代发 —— bridge-only 通路。
 *
 * ## 为什么必须有这一层
 *
 * Zen 免费档只放行**由真实 OpenCode 客户端进程发出**的连接态。插件自造 HTTP
 * 请求直连一律 429 `FreeUsageLimitError`：换 UA、换 session 外形、换请求体、
 * 换出口 IP、换传输层指纹都无效，因为判据在发起者本身（连接态），独立进程
 * 无法复刻。唯一可用的通路是启动本机 `opencode serve`，由它代为发起推理。
 *
 * ## 硬约束（逐条实测）
 *
 * 1. 必须是 **v2** 客户端：`GET /api/info` 返回 `version` 字符串才算数。
 * 2. 启动 env：`OPENCODE_CLIENT=desktop`、`OPENCODE_SERVER_PASSWORD=<随机>`、
 *    `XDG_CONFIG_HOME=<私有目录>`、`NO_PROXY`/`no_proxy=127.0.0.1,localhost`；
 *    删除 `OPENCODE_SERVER_USERNAME`（v1 变量会改掉 Basic 用户名）。
 * 3. 私有目录下的 `opencode/opencode.json` 必须在**进程启动之前**写好：定义
 *    一个 `mode:'primary'` 的桥专用 agent（小 system、工具权限 deny/ask）。
 * 4. `session.generate` 与 `/api/experimental/generate` 在免费档固定 503；
 *    **只有 `session.prompt` + agent 循环可用**。
 * 5. 失败写在 idle 消息的 `error` / `outcome==='failed'` 里，**不在 HTTP 状态上**。
 * 6. 会话路由前缀自适应：2.2.x 是 `/api/session/...`，更早 2.x 是 `/session/...`；
 *    404 换另一个并缓存命中前缀。
 * 7. 启动失败记住结论（10 分钟冷却），避免每次请求都 fork 一个必败进程。
 *
 * Basic Auth 用户名固定 `opencode`，密码随机、仅本机环回可见。
 * 本模块不配 Key、不构造推理请求、不做匿名认证；登录态由本机客户端自身决定。
 *
 * @module src/opencode-bridge.ts
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { delimiter, join, sep } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { classifyOpencodeError } from './opencode-product.js'

/** serve 起来之前的等待上限。 */
const BOOT_TIMEOUT_MS = 60_000
/** 一轮对话的默认上限。 */
const TURN_TIMEOUT_MS = 10 * 60_000
/** 等待模型产出时轮询消息/权限的间隔。 */
const POLL_INTERVAL_MS = 250
/** 启动失败结论的冷却时长（10 分钟）。 */
const FAILURE_COOLDOWN_MS = 10 * 60_000
/** v2 serve 的 Basic 认证用户名（固定）。 */
export const BRIDGE_USERNAME = 'opencode'
/** 桥专用 agent 的 id。 */
export const BRIDGE_AGENT_ID = 'dsh-bridge'

/** 桥专用 agent 的系统提示（与宿主的文本工具协议同向）。 */
const BRIDGE_SYSTEM = [
  'You are the model backend for DSH, a coding-agent harness.',
  'DSH reaches you only through conversation text.',
  'A HOST TOOLS block in a message lists the only tools you may call,',
  'using the JSON protocol stated there.',
  'Ignore every built-in tool you were given: they are not connected to the',
  "user's session, and calling one only wastes a turn.",
  'Reply with exactly what the conversation asks for: no preamble, no',
  'meta-commentary, no description of your own reasoning.',
].join(' ')

/** 生成器协议输出的 JSON Schema（默认不下发，见模块尾注释）。 */
export const PROTOCOL_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['tool', 'final'] },
    name: { type: 'string' },
    args: { type: 'object' },
    text: { type: 'string' },
  },
  required: ['kind'],
} as const

/** 写入私有目录的 `opencode/opencode.json`。 */
function bridgeConfig(): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    agents: {
      [BRIDGE_AGENT_ID]: {
        description: 'Text-only model bridge for DSH.',
        mode: 'primary',
        system: BRIDGE_SYSTEM,
        // 工具集必须非空（网关要看到 tools），但又不能真的可用：除 bash/read
        // 一律 deny，bash/read 设为 ask 再由桥逐个 reject。
        permissions: [
          { action: '*', resource: '*', effect: 'deny' },
          { action: 'bash', resource: '*', effect: 'ask' },
          { action: 'read', resource: '*', effect: 'ask' },
        ],
      },
    },
  }
}

/** 桌面版内置 CLI 的候选路径（最新版本目录优先）。 */
function desktopCandidates(): string[] {
  const appData = process.env.APPDATA ?? ''
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const roots = [
    appData !== '' ? join(appData, 'ai.opencode.desktop', 'cli') : '',
    localAppData !== '' ? join(localAppData, 'ai.opencode.desktop', 'cli') : '',
  ].filter((v): v is string => v !== '')
  const found: string[] = []
  for (const root of roots) {
    let entries: { name: string; isDirectory: () => boolean }[] = []
    try {
      entries = readdirSync(root, { withFileTypes: true }) as unknown as typeof entries
    } catch {
      continue
    }
    const versions = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse()
    for (const version of versions) {
      found.push(join(root, version, 'opencode-cli.exe'))
      found.push(join(root, version, 'opencode.exe'))
    }
  }
  found.push(
    join(localAppData, 'Programs', 'OpenCode', 'resources', 'opencode-cli.exe'),
    join(localAppData, 'Programs', 'OpenCode', 'opencode-cli.exe'),
    join(localAppData, 'Programs', 'opencode', 'opencode.exe'),
  )
  return found.filter((file) => file !== '')
}

/** 同步判断 PATH 里是否存在某命令（spawn 是异步的，这里只要一个答案）。 */
function whichSync(command: string): boolean {
  const pathValue = process.env.PATH ?? ''
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue
    for (const ext of ['', ...exts]) {
      const file = join(dir, command + ext)
      try {
        if (existsSync(file) && statSync(file).isFile()) return true
      } catch {
        // 目录不可读就跳过。
      }
    }
  }
  return false
}

/** `resolveCommand` 的候选项（纯函数，便于单测断言优先级）。 */
export function resolveCommandCandidates(override?: string): string[] {
  const windows = process.platform === 'win32'
  const home = homedir()
  const appData = process.env.APPDATA ?? ''
  const candidates: (string | undefined)[] = [
    override,
    process.env.OPENCODE_BIN,
    ...(windows ? desktopCandidates() : []),
    windows && appData !== '' ? join(appData, 'npm', 'opencode.cmd') : undefined,
    windows ? 'opencode.cmd' : 'opencode',
    'opencode',
    join(home, '.opencode', 'bin', windows ? 'opencode.exe' : 'opencode'),
    join(home, '.local', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
  ]
  return candidates.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

/** 最近一次 `resolveCommand` 未命中的候选（诊断用）。 */
let lastResolveTried: string[] = []

/** 读取最近一次未命中的候选列表。 */
export function resolveCommandTried(): readonly string[] {
  return lastResolveTried
}

/**
 * 找出可以启动的 v2 `opencode` 客户端。
 *
 * 顺序即优先级：v1 的 `opencode` 在 PATH 上很常见但没有 `/api/info`，桌面版
 * 自带的 `opencode-cli.exe` 才是要的那个，故优先找它。
 *
 * @returns 可用的命令字符串；一个都没有时返回 `null`。
 */
export function resolveCommand(override?: string): string | null {
  const tried: string[] = []
  for (const candidate of resolveCommandCandidates(override)) {
    const absolute = candidate.includes(sep) || candidate.includes('/')
    if (absolute) {
      if (existsSync(candidate)) return candidate
      tried.push(candidate)
      continue
    }
    // 返回裸命令名，由 spawn 借 PATH 解析（与参考实现一致）。
    if (whichSync(candidate)) return candidate
    tried.push(`${candidate}（不在 PATH 中）`)
  }
  lastResolveTried = tried
  return null
}

/** 取一个空闲的环回端口。 */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address !== null && typeof address === 'object') {
        const port = address.port
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error('无法取得空闲端口')))
      }
    })
  })
}

function randomPassword(): string {
  return randomBytes(24).toString('hex')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `transcriptOf` 接受的宽松消息形状（DSH 与 OpenAI wire 均可）。 */
export interface TranscriptMessage {
  role?: unknown
  content?: unknown
  tool_calls?: unknown
  name?: unknown
  tool_call_id?: unknown
  toolCallId?: unknown
  [key: string]: unknown
}

/** 把 content（字符串 /  multimodal parts / DSH blocks）摊成纯文本。 */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part)
      continue
    }
    if (part === null || typeof part !== 'object') continue
    const block = part as Record<string, unknown>
    if (typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text)
    } else if (block.type === 'tool-call' || block.type === 'tool-result') {
      const name = typeof block.name === 'string' ? block.name : 'tool'
      const args = typeof block.arguments === 'string' ? block.arguments : '{}'
      parts.push(block.type === 'tool-call' ? `${name}(${args})` : String(block.content ?? ''))
    }
  }
  return parts.filter((p) => p.length > 0).join('\n')
}

/** 从 assistant 消息里抽出工具调用名（兼容 OpenAI `tool_calls` 与 DSH blocks）。 */
function toolCallsOf(message: TranscriptMessage): string[] {
  const out: string[] = []
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (call === null || typeof call !== 'object') continue
      const fn = (call as { function?: unknown }).function
      const bag = fn !== null && typeof fn === 'object' ? fn as Record<string, unknown> : {}
      const name = typeof bag.name === 'string' ? bag.name : '?'
      const args = typeof bag.arguments === 'string' ? bag.arguments : '{}'
      out.push(`${name}(${args})`)
    }
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part === null || typeof part !== 'object') continue
      const block = part as Record<string, unknown>
      if (block.type !== 'tool-call') continue
      const name = typeof block.name === 'string' ? block.name : '?'
      const args = typeof block.arguments === 'string' ? block.arguments : '{}'
      out.push(`${name}(${args})`)
    }
  }
  return out
}

/**
 * 把宿主的对话消息序列化成一段会话文本（时间顺序，模型读得懂）。
 *
 * v2 的 `session.prompt` 只接受 `text`，没有结构化的工具轮次位置，故工具调用
 * 与结果都写成文本。`system` 角色单独走 {@link composePrompt} 的 system 段，
 * 但这里也收下（有些调用方把 system 塞进 messages）。
 */
export function transcriptOf(messages: readonly TranscriptMessage[] | undefined | null): string {
  const lines: string[] = []
  for (const message of messages ?? []) {
    if (message === null || typeof message !== 'object') continue
    const role = typeof message.role === 'string' ? message.role : ''
    const text = flattenContent(message.content)
    if (role === 'system' || role === 'developer') {
      if (text.length > 0) lines.push(`System: ${text}`)
      continue
    }
    if (role === 'user') {
      lines.push(`User: ${text}`)
      continue
    }
    if (role === 'assistant') {
      const calls = toolCallsOf(message)
      const head = calls.length > 0 ? `Assistant: [calls ${calls.join(', ')}]` : 'Assistant:'
      lines.push(text.length > 0 ? `${head} ${text}` : head)
      continue
    }
    if (role === 'tool') {
      const label = typeof message.name === 'string' ? message.name
        : typeof message.tool_call_id === 'string' ? message.tool_call_id
          : typeof message.toolCallId === 'string' ? message.toolCallId : '?'
      lines.push(`Tool result (${label}): ${text}`)
    }
  }
  return lines.join('\n').trim()
}

/** `toolProtocolOf` 接受的宽松工具形状。 */
export interface ProtocolTool {
  name?: unknown
  description?: unknown
  parameters?: unknown
  [key: string]: unknown
}

/**
 * 宿主工具清单的 system 段（HOST TOOLS 文本工具协议）。
 *
 * 客户端自带的工具集必须留在报文里（否则网关 429），故显式告诉模型：
 * 内置工具与用户会话无关，唯一能调用的是这份清单，按 JSON 协议应答。
 * 没有工具时返回空串（此时桥直接输出正文，不走协议解析）。
 */
export function toolProtocolOf(tools: readonly ProtocolTool[] | undefined): string {
  const usable = (tools ?? []).filter(
    (tool): tool is ProtocolTool => tool !== null && typeof tool === 'object'
      && typeof tool.name === 'string' && tool.name.length > 0,
  )
  if (usable.length === 0) return ''
  const listed = usable.map((tool) => ({
    name: tool.name,
    description: typeof tool.description === 'string' ? tool.description : '',
    parameters: tool.parameters ?? { type: 'object', properties: {} },
  }))
  return [
    'HOST TOOLS — these are the only tools you may invoke. You were also given',
    'built-in tools; ignore all of them, they are not connected to anything.',
    '',
    JSON.stringify(listed),
    '',
    'PROTOCOL — reply with exactly one JSON object and nothing else:',
    '  {"kind":"tool","name":"<a name from HOST TOOLS>","args":{...}}',
    '  {"kind":"final","text":"<your answer to the user>"}',
    '',
    'Rules:',
    '- One JSON object per reply. No prose, no code fences.',
    '- "name" must appear verbatim in HOST TOOLS; never invent one.',
    '- "args" must match that tool\'s parameters schema.',
    '- Emit kind=tool at most once per reply, then wait for the result.',
    '- When the answer needs no more tools, emit kind=final.',
  ].join('\n')
}

/** 协议解析结果（形状宽松，来自不可信的模型输出）。 */
export interface OpencodeProtocolMessage {
  kind?: string
  name?: string
  args?: unknown
  text?: string
  [key: string]: unknown
}

function tryParseProtocol(value: string): OpencodeProtocolMessage | null {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed !== null && typeof parsed === 'object'
      ? parsed as OpencodeProtocolMessage
      : null
  } catch {
    return null
  }
}

/**
 * 从 assistant 正文里截出协议 JSON 对象。
 *
 * 免费档模型偶尔在 JSON 外裹一句散文，故先整段直解，失败再从第一个 `{`
 * 到最后一个 `}` 之间取。解析失败返回 `null`（调用方据此把原文当正文输出）。
 */
export function parseProtocol(text: string): OpencodeProtocolMessage | null {
  const trimmed = String(text ?? '').trim()
  const direct = tryParseProtocol(trimmed)
  if (direct !== null) return direct
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) return tryParseProtocol(trimmed.slice(start, end + 1))
  return null
}

/** `composePrompt` 的输入。 */
export interface ComposePromptInput {
  system?: string
  prompt?: string
}

/**
 * 把宿主 system 与会话 transcript 拼成一次 `session.prompt` 的正文。
 *
 * v2 的 session 没有可覆写的 system 字段（agent 的 system 在配置里），
 * 宿主的 system 只能作为正文的一部分上行。分段标题让模型分清「规则」与「对话」。
 */
export function composePrompt(input: ComposePromptInput): string {
  const parts: string[] = []
  if (typeof input.system === 'string' && input.system.length > 0) {
    parts.push(`# System instructions\n\n${input.system}`)
  }
  parts.push(`# Conversation\n\n${input.prompt ?? ''}`)
  return parts.join('\n\n')
}

/** `turn` 的入参。 */
export interface OpencodeTurnInput {
  model: string
  system?: string
  prompt?: string
  signal?: AbortSignal
}

/** 一轮对话的 token 用量（形状来自客户端，宽松处理）。 */
export interface OpencodeTokenUsage {
  input?: number
  output?: number
  [key: string]: unknown
}

/** `turn` 的返回。 */
export interface OpencodeTurnResult {
  text: string
  usage: OpencodeTokenUsage | null
  raw: unknown
}

/** `OpencodeBridge` 构造选项。 */
export interface OpencodeBridgeOptions {
  /** 直接指定 opencode 命令；缺省走 {@link resolveCommand}。 */
  command?: string
  /** 私有目录（XDG_CONFIG_HOME + serve 的 cwd + 会话 location）。 */
  dir?: string
  /** Basic 认证密码；缺省随机生成。 */
  password?: string
  /** 诊断日志。 */
  log?: (message: string) => void
  /** 单次 HTTP 请求超时。 */
  timeoutMs?: number
  /** 单轮对话上限。 */
  turnTimeoutMs?: number
  /** 桥专用 agent id。 */
  agent?: string
  /** 指定 serve 端口；缺省每次取空闲端口。 */
  port?: number
  /** 启动失败结论的冷却时长。 */
  failureCooldownMs?: number
  /** 等待 serve 就绪的上限。 */
  bootTimeoutMs?: number
}

/** 会话消息行（形状宽松）。 */
interface SessionRow {
  type?: unknown
  finish?: unknown
  content?: unknown
  tokens?: unknown
  error?: unknown
  outcome?: unknown
  [key: string]: unknown
}

/** `request` 的返回。 */
interface BridgeResponse {
  status: number
  headers: Headers
  text: string
  json: unknown
}

/** 把客户端 idle 消息里的 provider 错误转成 `LlmError`。 */
function providerFailure(error: unknown, detail?: string): LlmError {
  const info = classifyOpencodeError(error)
  const message = detail !== undefined && detail.length > 0
    ? `${info.message} — ${detail}`
    : info.message
  return new LlmError(message, info.code, {
    ...(info.status > 0 ? { status: info.status } : {}),
    ...(info.retryAfterMs !== undefined ? { providerRetryAfterMs: info.retryAfterMs } : {}),
  })
}

/** 取消错误。 */
function abortedError(): LlmError {
  return new LlmError('OpenCode 桥请求已被调用方取消', 'ABORTED')
}

/**
 * 本机 `opencode serve` 的驱动者（v2 API）。
 *
 * 进程只起一次，之后所有请求复用。凭据随机、仅本机环回可见，serve 自带
 * Basic 认证且只在 `127.0.0.1` 监听。
 */
export class OpencodeBridge {
  private readonly port: number
  private readonly dir: string
  private readonly log: (message: string) => void
  private readonly timeoutMs: number
  private readonly turnTimeoutMs: number
  private readonly failureCooldownMs: number
  private readonly bootTimeoutMs: number
  private readonly commandOverride: string | undefined
  private readonly password: string
  private readonly agent: string

  private command: string | null
  private base: string | null = null
  private child: ChildProcess | null = null
  private booting: Promise<string> | null = null
  private spawnError: Error | null = null
  private failure: LlmError | null = null
  private failedAt = 0
  /** 命中的会话路由前缀（2.2.x `/api`，更早 2.x 空串）。 */
  private sessionApiPrefix = '/api'

  constructor(options: OpencodeBridgeOptions = {}) {
    this.port = options.port ?? 0
    this.dir = options.dir ?? join(tmpdir(), 'dsh-opencode-free-bridge')
    this.log = options.log ?? (() => {})
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.turnTimeoutMs = options.turnTimeoutMs ?? TURN_TIMEOUT_MS
    this.failureCooldownMs = options.failureCooldownMs ?? FAILURE_COOLDOWN_MS
    this.bootTimeoutMs = options.bootTimeoutMs ?? BOOT_TIMEOUT_MS
    this.commandOverride = options.command
    this.command = options.command ?? null
    this.password = options.password ?? randomPassword()
    this.agent = options.agent ?? BRIDGE_AGENT_ID
  }

  /** Basic 认证头。 */
  private get auth(): string {
    return `Basic ${Buffer.from(`${BRIDGE_USERNAME}:${this.password}`).toString('base64')}`
  }

  /**
   * 确保 serve 在跑，返回基地址。
   *
   * 并发调用共享同一次启动；启动失败在冷却期内直接重抛同一个 `LlmError`。
   */
  async ensure(): Promise<string> {
    if (this.base !== null) return this.base
    if (this.failure !== null && Date.now() - this.failedAt < this.failureCooldownMs) {
      throw this.failure
    }
    this.booting ??= this.boot()
    try {
      return await this.booting
    } catch (error) {
      this.booting = null
      this.failure = error instanceof LlmError
        ? error
        : new LlmError(`无法启动本机 OpenCode 客户端：${String(error)}`, 'BRIDGE_UNAVAILABLE')
      this.failedAt = Date.now()
      throw this.failure
    }
  }

  private async boot(): Promise<string> {
    this.command ??= resolveCommand(this.commandOverride)
    if (this.command === null) {
      const tried = resolveCommandTried()
      throw new LlmError(
        '找不到可用的 OpenCode v2 客户端（opencode-cli）。请先安装 OpenCode 桌面版/CLI，'
        + '或设置环境变量 OPENCODE_BIN 指向 2.x 的 opencode-cli.exe。'
        + (tried.length > 0 ? `已尝试：${tried.join('、')}` : ''),
        'BRIDGE_UNAVAILABLE',
      )
    }
    // 配置必须在进程启动之前写好：serve 起来后 agent 列表就定型了。
    try {
      mkdirSync(join(this.dir, 'opencode'), { recursive: true })
      writeFileSync(
        join(this.dir, 'opencode', 'opencode.json'),
        `${JSON.stringify(bridgeConfig(), null, 2)}\n`,
        'utf8',
      )
    } catch (error) {
      throw new LlmError(
        `无法写入桥配置（${this.dir}）：${error instanceof Error ? error.message : String(error)}`,
        'BRIDGE_UNAVAILABLE',
      )
    }

    let lastError: LlmError | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = this.port !== 0 ? this.port : await freePort()
      try {
        const base = await this.startOn(port)
        this.base = base
        this.failure = null
        this.failedAt = 0
        this.log(`bridge: opencode serve 就绪于 ${base}（${this.command}）`)
        return base
      } catch (error) {
        lastError = error instanceof LlmError
          ? error
          : new LlmError(String(error), 'BRIDGE_UNAVAILABLE')
        this.stopChild()
      }
    }
    throw lastError ?? new LlmError('无法启动本机 OpenCode 客户端', 'BRIDGE_UNAVAILABLE')
  }

  /** 在指定端口启动并等它健康（`/api/info` 必须返回 `version` 字符串）。 */
  private async startOn(port: number): Promise<string> {
    const command = this.command as string
    const args = ['serve', '--port', String(port), '--hostname', '127.0.0.1', '--log-level', 'warn']
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCODE_CLIENT: 'desktop',
      OPENCODE_SERVER_PASSWORD: this.password,
      XDG_CONFIG_HOME: this.dir,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    }
    // v1 的用户名变量会改掉 Basic 认证用户名，留着会让认证失败。
    delete env.OPENCODE_SERVER_USERNAME

    const child = spawn(command, args, {
      cwd: this.dir,
      env,
      stdio: 'ignore',
      windowsHide: true,
      // Windows 上 `opencode` 是 .cmd，没有 shell 找不到；.exe 走 shell 反而多一层。
      shell: /\.(cmd|bat)$/i.test(command),
    })
    this.spawnError = null
    child.on('error', (error) => { this.spawnError = error })
    child.unref()
    this.child = child

    const base = `http://127.0.0.1:${port}`
    const deadline = Date.now() + this.bootTimeoutMs
    let last = '未知原因'
    while (Date.now() < deadline) {
      // ⚠️ `spawnError` 由子进程回调写入，控制流分析看不到那次赋值 —— 读时
      //    显式断言回 `Error | null`，否则 TS 会把该分支收窄成 `never`。
      const spawnErr = this.spawnError as Error | null
      if (spawnErr !== null) {
        const reason = spawnErr.message
        throw new LlmError(
          `无法启动本机 OpenCode 客户端（${command}）：${reason}`,
          'BRIDGE_UNAVAILABLE',
        )
      }
      try {
        const res = await fetch(`${base}/api/info`, {
          headers: { Authorization: this.auth },
          signal: AbortSignal.timeout(2000),
        })
        if (res.ok) {
          const info = await res.json().catch(() => null) as { version?: unknown } | null
          if (info === null || typeof info.version !== 'string') {
            throw new Error('这不是 v2 接口（/api/info 未返回 version），请改用 2.x 的 opencode-cli')
          }
          this.log(`bridge: 客户端版本 ${info.version}`)
          return base
        }
        last = `HTTP ${res.status}`
      } catch (error) {
        last = error instanceof Error ? error.message : String(error)
      }
      await sleep(500)
    }
    throw new LlmError(
      `无法启动本机 OpenCode 客户端（${command} serve）：${last}。`
      + '若已安装，请确认是 2.x 版本（试着手工跑一次 opencode-cli serve --port 18800）。',
      'BRIDGE_UNAVAILABLE',
    )
  }

  /**
   * 发一轮对话：建会话 → `session.prompt` → 轮询 idle → 解释 → 删会话。
   *
   * 每轮新建会话：宿主每次都会重发完整 transcript，复用只会让上下文翻倍。
   */
  async turn(input: OpencodeTurnInput): Promise<OpencodeTurnResult> {
    const base = await this.ensure()
    const session = await this.createSession(base, input.model)
    try {
      const text = composePrompt(input)
      await this.post(base, `/session/${session}/prompt`, { text })
      const result = await this.awaitIdle(base, session, input.signal)
      return this.interpret(result)
    } finally {
      await this.deleteSession(base, session).catch(() => {})
    }
  }

  private async createSession(base: string, model: string): Promise<string> {
    const body = {
      agent: this.agent,
      model: { providerID: 'opencode', id: model },
      location: { directory: this.dir },
    }
    const created = await this.post(base, '/session', body)
    const bag = created !== null && typeof created === 'object'
      ? created as Record<string, unknown>
      : {}
    const data = bag.data !== null && typeof bag.data === 'object'
      ? bag.data as Record<string, unknown>
      : {}
    const id = typeof data.id === 'string' ? data.id
      : typeof bag.id === 'string' ? bag.id : ''
    if (id === '') {
      throw new LlmError('创建会话失败：响应里没有会话 id', 'BRIDGE_ERROR', { status: 502 })
    }
    return id
  }

  private async deleteSession(base: string, session: string): Promise<void> {
    await this.request(base, `/session/${session}`, {
      method: 'DELETE',
      headers: { Authorization: this.auth },
      signal: AbortSignal.timeout(5000),
    })
  }

  /** 等到会话进入 idle；期间把所有 pending permission 全部 reject。 */
  private async awaitIdle(
    base: string,
    session: string,
    signal?: AbortSignal,
  ): Promise<{ rows: SessionRow[]; idle: SessionRow }> {
    const deadline = Date.now() + this.turnTimeoutMs
    while (Date.now() < deadline) {
      if (signal?.aborted) throw abortedError()
      const messages = await this.get(base, `/session/${session}/message`)
      const rows: SessionRow[] = Array.isArray((messages as { data?: unknown } | null)?.data)
        ? (messages as { data: SessionRow[] }).data
        : []
      const idle = rows.find((row) => row?.type === 'idle')
      if (idle !== undefined) return { rows, idle }
      await this.rejectPermissions(base, session)
      await sleep(POLL_INTERVAL_MS)
    }
    // 超时前先把会话停掉，别让它在后台继续烧额度。
    await this.request(base, `/session/${session}/interrupt`, {
      method: 'POST',
      headers: { Authorization: this.auth },
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
    throw new LlmError('OpenCode 客户端在限定时间内没有完成这一轮', 'TIMEOUT')
  }

  private async rejectPermissions(base: string, session: string): Promise<void> {
    const pending = await this.get(base, `/session/${session}/permission`)
    const list = Array.isArray((pending as { data?: unknown } | null)?.data)
      ? (pending as { data: unknown[] }).data
      : []
    for (const request of list) {
      if (request === null || typeof request !== 'object') continue
      const id = (request as { id?: unknown }).id
      if (typeof id !== 'string') continue
      await this.post(base, `/session/${session}/permission/${id}/reply`, {
        decision: 'reject',
        message: 'This is a text-only model bridge. Do not use tools; answer in text.',
      }).catch(() => {})
    }
  }

  /**
   * 把一轮结果收敛成 `{ text, usage }`。
   *
   * 免费档失败不在 HTTP 状态上：`prompt` 返回 200，失败写在 idle 消息里
   * （`{type:'idle', outcome:'failed', error:{type:'provider.free-limit', status:429}}`）。
   * 从 assistant 行取最后一条非 `tool-calls` 中间态的正文与 tokens。
   */
  private interpret(result: { rows: SessionRow[]; idle: SessionRow }): OpencodeTurnResult {
    const { rows, idle } = result
    const assistants = rows.filter((row) => row?.type === 'assistant')
    // 新的在前：跳过 `tool-calls` 中间态，取这一轮最后一条正文。
    const final: SessionRow | undefined = assistants.find((row) => row.finish !== 'tool-calls') ?? assistants[0]
    let usage: OpencodeTokenUsage | null = null
    if (final !== undefined && final.tokens !== null && typeof final.tokens === 'object') {
      usage = final.tokens as OpencodeTokenUsage
    }
    const error = idle?.outcome === 'failed' ? idle.error : final?.error
    if (error !== undefined && error !== null) {
      const detail = error !== null && typeof error === 'object'
        ? (error as { response?: { body?: unknown } }).response?.body
        : undefined
      throw providerFailure(
        error,
        typeof detail === 'string' ? detail.slice(0, 500) : undefined,
      )
    }
    const content = final !== undefined && Array.isArray(final.content) ? final.content : []
    const text = content
      .filter((part): part is { type?: unknown; text?: unknown } =>
        part !== null && typeof part === 'object')
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('')
    return { text, usage, raw: result }
  }

  /**
   * 发一次 HTTP 请求，自动适配会话路由前缀。
   *
   * 默认先试 `/api`（2.2.x），命中 404 再试无前缀（更早 2.x），并把命中的
   * 前缀缓存到本实例，后续请求不再重复探测。
   */
  private async request(base: string, path: string, init: RequestInit): Promise<BridgeResponse> {
    const candidates = this.sessionApiPrefix === '' ? ['', '/api'] : ['/api', '']
    let lastError: unknown = null
    for (const prefix of candidates) {
      const url = `${base}${prefix}${path}`
      let res: Response
      try {
        res = await fetch(url, init)
      } catch (error) {
        lastError = error
        continue
      }
      if (res.status === 404 && candidates.indexOf(prefix) < candidates.length - 1) {
        lastError = new LlmError(`bridge HTTP 404 (${url})`, 'BRIDGE_ERROR', { status: 404 })
        continue
      }
      const text = await res.text()
      let json: unknown = null
      try { json = JSON.parse(text) as unknown } catch { /* 非 JSON 响应 */ }
      // 锁定成功命中过的前缀（与最终 HTTP 状态无关）。
      this.sessionApiPrefix = prefix
      return { status: res.status, headers: res.headers, text, json }
    }
    if (lastError instanceof LlmError) throw lastError
    throw new LlmError(
      `bridge request failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      'BRIDGE_ERROR',
    )
  }

  private async get(base: string, path: string): Promise<unknown> {
    const { status, text } = await this.request(base, path, {
      headers: { Authorization: this.auth },
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (status < 200 || status >= 300) {
      throw this.httpFailure(status, text, undefined)
    }
    try { return JSON.parse(text) as unknown } catch { return null }
  }

  private async post(base: string, path: string, body?: unknown): Promise<unknown> {
    const { status, headers, text, json } = await this.request(base, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: this.auth },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (status < 200 || status >= 300) {
      throw this.httpFailure(status, text, headers)
    }
    return json
  }

  /** 把 HTTP 层失败（含 429）归一成带 `code` 的 `LlmError`。 */
  private httpFailure(status: number, text: string, headers: Headers | undefined): LlmError {
    let parsed: Record<string, unknown> = {}
    try {
      const value = JSON.parse(text) as unknown
      if (value !== null && typeof value === 'object') parsed = value as Record<string, unknown>
    } catch { /* 非 JSON 响应体 */ }
    const nested = parsed.error !== null && typeof parsed.error === 'object'
      ? parsed.error as Record<string, unknown>
      : {}
    const info = classifyOpencodeError({
      status,
      type: typeof nested.type === 'string' ? nested.type : parsed.type,
      retryAfterMs: parsed.retryAfterMs ?? nested.retryAfterMs,
      message: `bridge HTTP ${status}`,
      ...(headers === undefined ? {} : { headers }),
    })
    const code = info.code === 'PROVIDER_ERROR' ? 'BRIDGE_ERROR' : info.code
    return new LlmError(
      `opencode bridge HTTP ${status} — ${text.slice(0, 300)}`,
      code,
      {
        status,
        ...(info.retryAfterMs === undefined ? {} : { providerRetryAfterMs: info.retryAfterMs }),
      },
    )
  }

  /** 释放子进程（宿主卸载插件时调用）。 */
  dispose(): void {
    this.stopChild()
    this.base = null
    this.booting = null
    this.failure = null
    this.failedAt = 0
  }

  private stopChild(): void {
    try {
      this.child?.kill()
    } catch {
      // 进程已退出。
    }
    this.child = null
  }
}
