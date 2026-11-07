/**
 * 精简版公共类型。
 *
 * 只保留仍被运行时模块引用的形状：网关控制面的错误快照，以及管理 RPC
 * 的通用信封。各渠道的请求/响应类型定义在各自模块内，避免本文件再次
 * 膨胀成全渠道类型表。
 */

/** 本机 OpenAI 兼容网关最近一次错误（`openai-gateway/runtime.ts` 使用）。 */
export interface RpcGatewayLastError {
  /** 失败时刻（毫秒）。必需：dispose 用它判定是否为上一轮的旧痕迹。 */
  at: number
  kind?: string
  reason?: string
  message?: string
  code?: string
  status?: number
  [key: string]: unknown
}

/** 通用 RPC 成功/失败信封。失败必须保留原始错误码，不得包成 `ok:true`。 */
export interface RpcResult<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}
