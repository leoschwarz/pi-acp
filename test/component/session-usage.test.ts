import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const STATS = {
  sessionId: 's1',
  tokens: { input: 100, output: 50, cacheRead: 30, cacheWrite: 20, total: 200 },
  cost: 0.0125,
  contextUsage: { tokens: 150, contextWindow: 200000, percent: 0.075 }
}

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

function usageUpdates(conn: FakeAgentSideConnection) {
  return conn.updates.filter(u => u.update.sessionUpdate === 'usage_update').map(u => u.update)
}

async function runTurn(session: PiAcpSession, proc: FakePiRpcProcess): Promise<string> {
  const p = session.prompt('hello')
  proc.emit({ type: 'agent_settled' })
  return p
}

test('PiAcpSession: publishes usage_update before the prompt resolves', async () => {
  const { conn, proc, session } = makeSession()
  proc.sessionStats = STATS

  let updatesAtResolve = -1
  const p = session.prompt('hello').then(reason => {
    updatesAtResolve = conn.updates.length
    return reason
  })
  proc.emit({ type: 'agent_settled' })
  const reason = await p

  assert.equal(reason, 'end_turn')
  const update = usageUpdates(conn)
  assert.deepEqual(update, [
    { sessionUpdate: 'usage_update', used: 150, size: 200000, cost: { amount: 0.0125, currency: 'USD' } }
  ])
  // The update was already delivered to the connection when the turn resolved.
  const deliveredIndex = conn.updates.findIndex(u => u.update.sessionUpdate === 'usage_update')
  assert.ok(deliveredIndex >= 0 && deliveredIndex < updatesAtResolve)
  assert.deepEqual(session.lastTurnUsage, {
    totalTokens: 200,
    inputTokens: 100,
    outputTokens: 50,
    cachedReadTokens: 30,
    cachedWriteTokens: 20
  })
})

test('PiAcpSession: no usage_update when pi reports no context usage', async () => {
  const { conn, proc, session } = makeSession()
  proc.sessionStats = { tokens: { input: 1, output: 1, total: 2 } }

  await runTurn(session, proc)

  assert.deepEqual(usageUpdates(conn), [])
  assert.deepEqual(session.lastTurnUsage, {
    totalTokens: 2,
    inputTokens: 1,
    outputTokens: 1,
    cachedReadTokens: null,
    cachedWriteTokens: null
  })
})

test('PiAcpSession: turn still completes when stats fetch fails', async () => {
  const { conn, proc, session } = makeSession()
  proc.getSessionStats = async () => {
    throw new Error('stats boom')
  }

  const reason = await runTurn(session, proc)

  assert.equal(reason, 'end_turn')
  assert.deepEqual(usageUpdates(conn), [])
  assert.equal(session.lastTurnUsage, null)
})

test('PiAcpSession: no usage events when pi reports nothing', async () => {
  const { conn, proc, session } = makeSession()

  await runTurn(session, proc)

  assert.deepEqual(usageUpdates(conn), [])
  assert.equal(session.lastTurnUsage, null)
})

test('PiAcpSession: stale usage is not leaked into a failed next turn', async () => {
  const { proc, session } = makeSession()
  proc.sessionStats = STATS

  await runTurn(session, proc)
  assert.ok(session.lastTurnUsage)

  proc.prompt = async () => {
    throw new Error('boom')
  }
  // Failed turns resolve with 'error' (mapped to refusal by the agent), they do not reject.
  const reason = await session.prompt('again')
  assert.equal(reason, 'error')
  assert.equal(session.lastTurnUsage, null)
})
