import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: initialize advertises session resume and close capabilities', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

  const res = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)

  assert.deepEqual(res.agentCapabilities?.sessionCapabilities?.resume, {})
  assert.deepEqual(res.agentCapabilities?.sessionCapabilities?.close, {})
})

test('PiAcpAgent: closeSession cancels ongoing work, then frees the pi subprocess', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const calls: string[] = []
  const fakeSession = {
    sessionId: 'sess-1',
    async cancel() {
      calls.push('cancel')
    }
  }
  ;(agent as any).sessions = {
    maybeGet(id: string) {
      return id === 'sess-1' ? fakeSession : undefined
    },
    close(id: string) {
      calls.push('close')
      assert.equal(id, 'sess-1')
    }
  }

  const res = await agent.closeSession({ sessionId: 'sess-1', _meta: null } as any)

  assert.deepEqual(res, {})
  assert.deepEqual(calls, ['cancel', 'close'])
})

test('PiAcpAgent: closeSession is idempotent for sessions that are not live', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const res = await agent.closeSession({ sessionId: 'not-live', _meta: null } as any)

  assert.deepEqual(res, {})
})

test('PiAcpAgent: closeSession still frees the subprocess when cancel fails', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  let closed = false
  ;(agent as any).sessions = {
    maybeGet: () => ({
      sessionId: 'sess-1',
      async cancel() {
        throw new Error('pi abort failed')
      }
    }),
    close: () => {
      closed = true
    }
  }

  const res = await agent.closeSession({ sessionId: 'sess-1', _meta: null } as any)

  assert.deepEqual(res, {})
  assert.equal(closed, true)
})

test('PiAcpAgent: closeSession disposes the subprocess when cancel never settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  let closed = false
  ;(agent as any).sessions = {
    maybeGet: () => ({
      sessionId: 'sess-1',
      cancel(): Promise<void> {
        return new Promise(() => {})
      }
    }),
    close: () => {
      closed = true
    }
  }

  const pending = agent.closeSession({ sessionId: 'sess-1', _meta: null } as any)

  // Past the bounded cancel wait, the close must resolve via the timeout branch.
  t.mock.timers.tick(10_000)

  const res = await pending

  assert.deepEqual(res, {})
  assert.equal(closed, true)
})
