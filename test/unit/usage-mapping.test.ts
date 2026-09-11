import test from 'node:test'
import assert from 'node:assert/strict'
import { promptUsageFromSessionStats, usageUpdateFromSessionStats } from '../../src/acp/translate/usage.js'

const FULL_STATS = {
  sessionId: 's1',
  totalMessages: 4,
  tokens: { input: 100, output: 50, cacheRead: 30, cacheWrite: 20, total: 200 },
  cost: 0.0125,
  contextUsage: { tokens: 150, contextWindow: 200000, percent: 0.075 }
}

test('promptUsageFromSessionStats maps cumulative token totals', () => {
  assert.deepEqual(promptUsageFromSessionStats(FULL_STATS), {
    totalTokens: 200,
    inputTokens: 100,
    outputTokens: 50,
    cachedReadTokens: 30,
    cachedWriteTokens: 20
  })
})

test('promptUsageFromSessionStats computes total when pi omits it', () => {
  const stats = { tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 } }
  assert.deepEqual(promptUsageFromSessionStats(stats), {
    totalTokens: 18,
    inputTokens: 10,
    outputTokens: 5,
    cachedReadTokens: 2,
    cachedWriteTokens: 1
  })
})

test('promptUsageFromSessionStats omits unknown cache counters', () => {
  const stats = { tokens: { input: 10, output: 5, total: 15 } }
  assert.deepEqual(promptUsageFromSessionStats(stats), {
    totalTokens: 15,
    inputTokens: 10,
    outputTokens: 5,
    cachedReadTokens: null,
    cachedWriteTokens: null
  })
})

test('promptUsageFromSessionStats returns null without usable token totals', () => {
  assert.equal(promptUsageFromSessionStats(null), null)
  assert.equal(promptUsageFromSessionStats(undefined), null)
  assert.equal(promptUsageFromSessionStats({}), null)
  assert.equal(promptUsageFromSessionStats({ tokens: { input: 1 } }), null)
  assert.equal(promptUsageFromSessionStats({ tokens: { input: 'x', output: 2 } }), null)
  assert.equal(promptUsageFromSessionStats({ tokens: { input: NaN, output: 2 } }), null)
})

test('usageUpdateFromSessionStats maps context usage and USD cost', () => {
  assert.deepEqual(usageUpdateFromSessionStats(FULL_STATS), {
    used: 150,
    size: 200000,
    cost: { amount: 0.0125, currency: 'USD' }
  })
})

test('usageUpdateFromSessionStats omits cost when unknown', () => {
  const stats = { contextUsage: { tokens: 10, contextWindow: 1000 } }
  assert.deepEqual(usageUpdateFromSessionStats(stats), { used: 10, size: 1000 })
})

test('usageUpdateFromSessionStats reports zero cost and zero used as valid values', () => {
  const stats = { cost: 0, contextUsage: { tokens: 0, contextWindow: 1000 } }
  assert.deepEqual(usageUpdateFromSessionStats(stats), {
    used: 0,
    size: 1000,
    cost: { amount: 0, currency: 'USD' }
  })
})

test('usageUpdateFromSessionStats returns null when context size is unknown', () => {
  assert.equal(usageUpdateFromSessionStats(null), null)
  assert.equal(usageUpdateFromSessionStats({}), null)
  assert.equal(usageUpdateFromSessionStats({ contextUsage: { tokens: null, contextWindow: 1000 } }), null)
  assert.equal(usageUpdateFromSessionStats({ contextUsage: { tokens: 10, contextWindow: 0 } }), null)
  assert.equal(usageUpdateFromSessionStats({ contextUsage: { tokens: -5, contextWindow: 1000 } }), null)
})
