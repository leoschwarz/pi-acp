import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession(opts: { supportsFormElicitation?: boolean } = {}) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    supportsFormElicitation: opts.supportsFormElicitation ?? true
  })

  return { conn, proc, session }
}

test('extension input maps to a form elicitation and resolves pi with the typed value', async () => {
  const { conn, proc } = makeSession()

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui1',
    method: 'input',
    title: 'Commit message',
    placeholder: 'Describe the change'
  } as any)
  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.elicitationRequests.length, 1)
  const req: any = conn.elicitationRequests[0]
  assert.equal(req.sessionId, 's1')
  assert.equal(req.mode, 'form')
  assert.equal(req.message, 'Commit message')
  assert.equal(req.requestedSchema.properties.value.type, 'string')
  assert.equal(req.requestedSchema.properties.value.description, 'Describe the change')
  assert.deepEqual(req.requestedSchema.required, ['value'])

  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui1', value: 'typed text' }])
  assert.equal(conn.updates.length, 0)
})

test('extension editor prefills the form default and returns the edited text', async () => {
  const { conn, proc } = makeSession()
  conn.nextElicitationResponse = { action: 'accept', content: { value: 'edited body' } }

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui2',
    method: 'editor',
    title: 'Release notes',
    prefill: 'draft text'
  } as any)
  await new Promise(r => setTimeout(r, 0))

  const req: any = conn.elicitationRequests[0]
  assert.equal(req.requestedSchema.properties.value.default, 'draft text')

  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui2', value: 'edited body' }])
})

test('decline and cancel map to the pi cancelled response', async () => {
  const { conn, proc } = makeSession()

  conn.nextElicitationResponse = { action: 'decline' }
  proc.emit({ type: 'extension_ui_request', id: 'ui3', method: 'input', title: 'Q' } as any)
  await new Promise(r => setTimeout(r, 0))

  conn.nextElicitationResponse = { action: 'cancel' }
  proc.emit({ type: 'extension_ui_request', id: 'ui4', method: 'input', title: 'Q' } as any)
  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(proc.extensionUiResponses, [
    { id: 'ui3', cancelled: true },
    { id: 'ui4', cancelled: true }
  ])
})

test('accept without content resolves pi with an empty string', async () => {
  const { conn, proc } = makeSession()
  conn.nextElicitationResponse = { action: 'accept' }

  proc.emit({ type: 'extension_ui_request', id: 'ui5', method: 'input', title: 'Q' } as any)
  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui5', value: '' }])
})

test('elicitation failure cancels the pi request instead of hanging it', async () => {
  const { conn, proc } = makeSession()
  conn.elicitationError = new Error('client gone')

  proc.emit({ type: 'extension_ui_request', id: 'ui6', method: 'input', title: 'Q' } as any)
  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui6', cancelled: true }])
})

test('without form elicitation support input stays auto-cancelled with a notice', async () => {
  const { conn, proc } = makeSession({ supportsFormElicitation: false })

  proc.emit({ type: 'extension_ui_request', id: 'ui7', method: 'input', title: 'Q' } as any)
  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.elicitationRequests.length, 0)
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui7', cancelled: true }])
  assert.equal(conn.updates.length, 1)
  assert.match((conn.updates[0]!.update as any).content.text, /not supported in ACP yet/)
})
