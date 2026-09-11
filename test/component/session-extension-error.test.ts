import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession() {
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

  return { conn, proc }
}

test('PiAcpSession: surfaces extension_error as an agent message chunk', async () => {
  const { conn, proc } = makeSession()

  proc.emit({
    type: 'extension_error',
    extensionPath: '/home/me/.pi/extensions/my-ext.ts',
    event: 'session_start',
    error: 'boom'
  } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: "Extension error in /home/me/.pi/extensions/my-ext.ts during 'session_start': boom"
    }
  })
})

test('PiAcpSession: omits the event name when extension_error has none', async () => {
  const { conn, proc } = makeSession()

  proc.emit({
    type: 'extension_error',
    extensionPath: '/home/me/.pi/extensions/my-ext.ts',
    error: 'boom'
  } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(
    (conn.updates[0]!.update as any).content.text,
    'Extension error in /home/me/.pi/extensions/my-ext.ts: boom'
  )
})

test('PiAcpSession: falls back to a generic message when extension_error has no path or error', async () => {
  const { conn, proc } = makeSession()

  proc.emit({ type: 'extension_error' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal((conn.updates[0]!.update as any).content.text, 'A pi extension failed with an unknown error.')
})
