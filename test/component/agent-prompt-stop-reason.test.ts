import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  maybeGet(_id: string) {
    return this.session
  }
  get(_id: string) {
    return this.session
  }
}

test('PiAcpAgent: maps a failed pi turn to stopReason refusal', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = {
    sessionId: 's1',
    proc,
    wasCancelRequested: () => false,
    prompt: async () => 'error'
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(session) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: 'hello' }]
  } as any)

  assert.equal(res.stopReason, 'refusal')
})

test('PiAcpAgent: still maps cancelled turns to stopReason cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = {
    sessionId: 's1',
    proc,
    wasCancelRequested: () => true,
    prompt: async () => 'error'
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(session) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: 'hello' }]
  } as any)

  assert.equal(res.stopReason, 'cancelled')
})

test('PiAcpAgent: normal turns keep stopReason end_turn', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = {
    sessionId: 's1',
    proc,
    wasCancelRequested: () => false,
    prompt: async () => 'end_turn'
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(session) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: 'hello' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
})
