import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldUseZedTerminalFallback } from '../../src/acp/translate/bash.js'

test('shouldUseZedTerminalFallback: true when client does not advertise terminal support', () => {
  assert.equal(shouldUseZedTerminalFallback(undefined), true)
  assert.equal(shouldUseZedTerminalFallback({}), true)
  assert.equal(shouldUseZedTerminalFallback({ terminal: false }), true)
  assert.equal(shouldUseZedTerminalFallback({ fs: { readTextFile: true } }), true)
})

test('shouldUseZedTerminalFallback: false when client advertises ACP terminal support', () => {
  assert.equal(shouldUseZedTerminalFallback({ terminal: true }), false)
})
