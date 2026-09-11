import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession(overrides: Partial<FakePiRpcProcess> = {}) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  Object.assign(proc, overrides)

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

async function settle() {
  // Config option refreshes resolve through real RPC calls on the fake, so give
  // the event loop a few ticks before asserting.
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
}

test('PiAcpSession: maps session_info_changed to session_info_update with title', async () => {
  const { conn, proc } = makeSession()

  proc.emit({ type: 'session_info_changed', name: 'My Session' } as any)
  await settle()

  assert.equal(conn.updates.length, 1)
  const update = conn.updates[0]!.update as any
  assert.equal(update.sessionUpdate, 'session_info_update')
  assert.equal(update.title, 'My Session')
  assert.match(update.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('PiAcpSession: session_info_changed without a name clears the title via null', async () => {
  const { conn, proc } = makeSession()

  proc.emit({ type: 'session_info_changed' } as any)
  await settle()

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'session_info_update',
    title: null,
    updatedAt: (conn.updates[0]!.update as any).updatedAt
  })
})

test('PiAcpSession: maps thinking_level_changed to current_mode_update and refreshes config options', async () => {
  const { conn, proc } = makeSession({
    getState: async () => ({
      thinkingLevel: 'high',
      model: { provider: 'test', id: 'model' }
    })
  })

  proc.emit({ type: 'thinking_level_changed', level: 'high' } as any)
  await settle()

  assert.equal(conn.updates.length, 2)

  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'current_mode_update',
    currentModeId: 'high'
  })

  const configUpdate = conn.updates[1]!.update as any
  assert.equal(configUpdate.sessionUpdate, 'config_option_update')
  const thoughtLevel = configUpdate.configOptions.find((o: any) => o.id === 'thought_level')
  const model = configUpdate.configOptions.find((o: any) => o.id === 'model')
  assert.equal(thoughtLevel.currentValue, 'high')
  assert.equal(model.currentValue, 'test/model')
})

test('PiAcpSession: thinking_level_changed without a level emits nothing', async () => {
  const { conn, proc } = makeSession()

  proc.emit({ type: 'thinking_level_changed' } as any)
  await settle()

  assert.equal(conn.updates.length, 0)
})

test('PiAcpSession: maps entry_appended to config_option_update with the entry in _meta', async () => {
  const { conn, proc } = makeSession()

  const entry = {
    type: 'custom',
    id: 'e1',
    parentId: null,
    timestamp: '2026-09-04T00:00:00.000Z',
    customType: 'my-extension/state',
    data: { phase: 'review' }
  }
  proc.emit({ type: 'entry_appended', entry } as any)
  await settle()

  assert.equal(conn.updates.length, 1)
  const update = conn.updates[0]!.update as any
  assert.equal(update.sessionUpdate, 'config_option_update')
  assert.deepEqual(update._meta, { piAcp: { entryAppended: entry } })

  const ids = update.configOptions.map((o: any) => o.id)
  assert.ok(ids.includes('thought_level'))
  assert.ok(ids.includes('model'))
})

test('PiAcpSession: entry_appended without an entry payload emits nothing', async () => {
  const { conn, proc } = makeSession()

  proc.emit({ type: 'entry_appended' } as any)
  proc.emit({ type: 'entry_appended', entry: 'not-an-object' } as any)
  await settle()

  assert.equal(conn.updates.length, 0)
})

test('PiAcpSession: maps extension setTitle UI request to session_info_update', async () => {
  const { conn, proc } = makeSession()

  proc.emit({ type: 'extension_ui_request', id: 'ui1', method: 'setTitle', title: 'Reviewing diff' } as any)
  await settle()

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'session_info_update',
    title: 'Reviewing diff',
    updatedAt: (conn.updates[0]!.update as any).updatedAt
  })
})

test('PiAcpSession: setTitle without a title clears the title via null', async () => {
  const { conn, proc } = makeSession()

  proc.emit({ type: 'extension_ui_request', id: 'ui2', method: 'setTitle' } as any)
  await settle()

  assert.equal(conn.updates.length, 1)
  assert.equal((conn.updates[0]!.update as any).title, null)
})
