import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: passes zedTerminalFallback=false when client advertises terminal support', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }
  } as any)

  let captured: any = null
  const fakeSession = {
    sessionId: 's1',
    proc: new FakePiRpcProcess(),
    setStartupInfo: () => {},
    sendStartupInfoIfPending: () => {}
  }
  ;(agent as any).sessions.create = async (params: any) => {
    captured = params
    return fakeSession
  }
  // Skip the "close sibling sessions" policy for this test.
  ;(agent as any).sessions.closeAllExcept = () => {}

  await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

  assert.equal(captured.zedTerminalFallback, false)
})

test('PiAcpAgent: keeps zedTerminalFallback=true for clients without terminal support', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
  } as any)

  let captured: any = null
  const fakeSession = {
    sessionId: 's1',
    proc: new FakePiRpcProcess(),
    setStartupInfo: () => {},
    sendStartupInfoIfPending: () => {}
  }
  ;(agent as any).sessions.create = async (params: any) => {
    captured = params
    return fakeSession
  }
  ;(agent as any).sessions.closeAllExcept = () => {}

  await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

  assert.equal(captured.zedTerminalFallback, true)
})
