import type { Usage as AcpUsage, UsageUpdate as AcpUsageUpdatePayload } from '@agentclientprotocol/sdk'

export type { AcpUsage, AcpUsageUpdatePayload }

/**
 * Pi session stats shape (`get_session_stats`) that the mappers rely on.
 * Everything is optional/unknown so payload drift degrades to `null` instead of guessing.
 */
export type PiSessionStats = {
  tokens?: {
    input?: unknown
    output?: unknown
    cacheRead?: unknown
    cacheWrite?: unknown
    total?: unknown
  }
  cost?: unknown
  contextUsage?: {
    tokens?: unknown
    contextWindow?: unknown
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Map pi session stats to the unstable `usage` field of the ACP `session/prompt` response
 * (cumulative token totals). Returns null when pi reports no usable token totals.
 */
export function promptUsageFromSessionStats(stats: unknown): AcpUsage | null {
  const tokens = (stats as PiSessionStats | null | undefined)?.tokens
  if (!tokens || typeof tokens !== 'object') return null

  const input = isFiniteNumber(tokens.input) ? tokens.input : null
  const output = isFiniteNumber(tokens.output) ? tokens.output : null
  if (input === null || output === null) return null

  const cacheRead = isFiniteNumber(tokens.cacheRead) ? tokens.cacheRead : 0
  const cacheWrite = isFiniteNumber(tokens.cacheWrite) ? tokens.cacheWrite : 0
  const total = isFiniteNumber(tokens.total) ? tokens.total : input + output + cacheRead + cacheWrite

  return {
    totalTokens: total,
    inputTokens: input,
    outputTokens: output,
    cachedReadTokens: isFiniteNumber(tokens.cacheRead) ? tokens.cacheRead : null,
    cachedWriteTokens: isFiniteNumber(tokens.cacheWrite) ? tokens.cacheWrite : null
  }
}

/**
 * Map pi session stats to an ACP `usage_update` payload (context usage + cumulative cost,
 * which pi prices in USD). Returns null when the context window size is unknown, since
 * `used`/`size` are required by the protocol.
 */
export function usageUpdateFromSessionStats(stats: unknown): AcpUsageUpdatePayload | null {
  const record = stats as PiSessionStats | null | undefined
  const contextUsage = record?.contextUsage
  if (!contextUsage || typeof contextUsage !== 'object') return null

  const used = contextUsage.tokens
  const size = contextUsage.contextWindow
  if (!isFiniteNumber(used) || !isFiniteNumber(size) || size <= 0 || used < 0) return null

  const cost = isFiniteNumber(record?.cost) ? { amount: record.cost, currency: 'USD' } : undefined

  return { used, size, ...(cost ? { cost } : {}) }
}
