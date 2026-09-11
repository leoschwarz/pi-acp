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

test('PiAcpSession: emits agent_message_chunk for compaction_start with threshold reason', async () => {
  const { conn, proc } = makeSession()

  proc.emit({ type: 'compaction_start', reason: 'threshold' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Context nearing limit, running automatic compaction...' }
  })
})

test('PiAcpSession: emits agent_message_chunk for compaction_start with overflow reason', async () => {
  const { conn, proc } = makeSession()

  proc.emit({ type: 'compaction_start', reason: 'overflow' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: "Context exceeded the model's limit, running emergency compaction..."
    }
  })
})

test('PiAcpSession: emits agent_message_chunk for compaction_start with manual reason', async () => {
  const { conn, proc } = makeSession()

  proc.emit({ type: 'compaction_start', reason: 'manual' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Compacting session context...' }
  })
})

test('PiAcpSession: falls back to a generic compaction_start message when reason is missing', async () => {
  const { conn, proc } = makeSession()

  proc.emit({ type: 'compaction_start' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Compacting session context...' }
  })
})

test('PiAcpSession: emits agent_message_chunk for successful compaction_end', async () => {
  const { conn, proc } = makeSession()

  proc.emit({ type: 'compaction_end', reason: 'threshold', aborted: false } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Compaction finished; context was summarized to continue the session.' }
  })
})

test('PiAcpSession: reports aborted compaction_end', async () => {
  const { conn, proc } = makeSession()

  proc.emit({ type: 'compaction_end', reason: 'manual', aborted: true } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Compaction was cancelled; continuing without a summary.' }
  })
})

test('PiAcpSession: reports compaction_end error message', async () => {
  const { conn, proc } = makeSession()

  proc.emit({
    type: 'compaction_end',
    reason: 'threshold',
    aborted: false,
    errorMessage: 'model unavailable'
  } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Compaction failed: model unavailable' }
  })
})
