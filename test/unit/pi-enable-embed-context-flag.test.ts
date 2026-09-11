import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

beforeEach(() => {
  delete process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT
})

afterEach(() => {
  delete process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT
})

async function initializeWithEmbeddedContext(value?: string) {
  if (value != null) process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT = value

  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const res = await agent.initialize({ protocolVersion: 1 } as any)

  assert.ok(res.agentCapabilities)
  assert.ok(res.agentCapabilities.promptCapabilities)
  return res.agentCapabilities.promptCapabilities.embeddedContext
}

test('PI_ACP_ENABLE_EMBEDDED_CONTEXT: defaults embeddedContext to true when undefined', async () => {
  assert.equal(await initializeWithEmbeddedContext(), true)
})

test("PI_ACP_ENABLE_EMBEDDED_CONTEXT: 'false' opts out of embeddedContext", async () => {
  assert.equal(await initializeWithEmbeddedContext('false'), false)
})

test("PI_ACP_ENABLE_EMBEDDED_CONTEXT: 'true' keeps embeddedContext enabled", async () => {
  assert.equal(await initializeWithEmbeddedContext('true'), true)
})
