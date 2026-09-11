import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession(opts: { zedTerminalFallback: boolean }) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    zedTerminalFallback: opts.zedTerminalFallback
  })

  return { conn, proc }
}

test('PiAcpSession: bash tool calls use plain text content when the Zed terminal fallback is off', async () => {
  const { conn, proc } = makeSession({ zedTerminalFallback: false })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 't1',
    partialResult: { details: { stdout: 'partial' } }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { details: { stdout: 'partial\nfull output' } }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 3)

  // tool_call: no fake terminal content, no Zed _meta.
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.equal((conn.updates[0]!.update as any).content, undefined)
  assert.equal((conn.updates[0]!.update as any)._meta, undefined)

  // tool_call_update (in_progress): full accumulated output as text content (content replaces).
  assert.equal(conn.updates[1]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[1]!.update as any).status, 'in_progress')
  assert.deepEqual((conn.updates[1]!.update as any).content, [
    { type: 'content', content: { type: 'text', text: 'partial' } }
  ])
  assert.equal((conn.updates[1]!.update as any)._meta, undefined)

  // tool_call_update (completed): full output as text content, no terminal meta.
  assert.equal(conn.updates[2]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[2]!.update as any).status, 'completed')
  assert.deepEqual((conn.updates[2]!.update as any).content, [
    { type: 'content', content: { type: 'text', text: 'partial\nfull output' } }
  ])
  assert.equal((conn.updates[2]!.update as any)._meta, undefined)
})

test('PiAcpSession: bash tool calls keep the Zed terminal fallback by default', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual((conn.updates[0]!.update as any).content, [{ type: 'terminal', terminalId: 't1' }])
  assert.deepEqual((conn.updates[0]!.update as any)._meta, {
    terminal_info: { terminal_id: 't1', cwd: process.cwd() }
  })
})
