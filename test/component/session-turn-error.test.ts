import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  return { conn, proc, session }
}

function chunks(conn: FakeAgentSideConnection) {
  return conn.updates.filter(u => u.update.sessionUpdate === 'agent_message_chunk').map(u => u.update)
}

test('PiAcpSession: emits an error chunk when the pi prompt RPC fails', async () => {
  const { conn, proc, session } = makeSession()

  proc.prompt = async () => {
    throw new Error('provider boom')
  }

  const reason = await session.prompt('hello')

  await new Promise(r => setTimeout(r, 0))

  assert.equal(reason, 'error')
  assert.deepEqual(chunks(conn), [
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Turn failed: provider boom' } }
  ])
})

test('PiAcpSession: delivers the error chunk before the prompt promise resolves', async () => {
  const { conn, proc, session } = makeSession()

  proc.prompt = async () => {
    throw new Error('boom')
  }

  await session.prompt('hello')

  assert.deepEqual(chunks(conn), [
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Turn failed: boom' } }
  ])
})

test('PiAcpSession: does not emit an error chunk when cancel was requested mid-turn', async () => {
  const { conn, proc, session } = makeSession()

  let rejectPrompt: (err: Error) => void = () => {}
  proc.prompt = () =>
    new Promise((_resolve, reject) => {
      rejectPrompt = reject
    })

  const p = session.prompt('hello')
  await session.cancel()
  rejectPrompt(new Error('aborted'))

  const reason = await p
  await new Promise(r => setTimeout(r, 0))

  assert.equal(reason, 'cancelled')
  assert.deepEqual(chunks(conn), [])
})

test('PiAcpSession: auth failures reject without a generic error chunk', async () => {
  const { conn, proc, session } = makeSession()

  proc.prompt = async () => {
    throw new Error('Missing API key for provider')
  }

  await assert.rejects(() => session.prompt('hello'))
  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(chunks(conn), [])
})
