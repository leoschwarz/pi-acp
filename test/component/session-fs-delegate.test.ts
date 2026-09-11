import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession(opts: { fsDelegateEnabled: boolean }) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    fsDelegateEnabled: opts.fsDelegateEnabled
  })

  return { conn, proc }
}

test('fs-delegated write: emits a diff from the tool result details (no disk snapshot)', async () => {
  const { conn, proc } = makeSession({ fsDelegateEnabled: true })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'write',
    args: { path: '/tmp/x.txt', content: 'new content' }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'Successfully wrote 11 bytes to /tmp/x.txt' }],
      details: { fsDelegated: true, path: '/tmp/x.txt', oldText: null, newText: 'new content' }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 2)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')

  const end = conn.updates[1]!.update as any
  assert.equal(end.sessionUpdate, 'tool_call_update')
  assert.equal(end.status, 'completed')
  assert.deepEqual(end.content, [{ type: 'diff', path: '/tmp/x.txt', oldText: null, newText: 'new content' }])
})

test('fs-delegated edit: diff uses oldText/newText from details', async () => {
  const { conn, proc } = makeSession({ fsDelegateEnabled: true })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't2',
    toolName: 'edit',
    args: { path: '/tmp/y.txt', edits: [{ oldText: 'old', newText: 'new' }] }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't2',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in /tmp/y.txt.' }],
      details: {
        fsDelegated: true,
        path: '/tmp/y.txt',
        oldText: 'old line\n',
        newText: 'new line\n',
        diff: '-1 old line\n+1 new line\n'
      }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates[1]!.update as any
  assert.deepEqual(end.content, [{ type: 'diff', path: '/tmp/y.txt', oldText: 'old line\n', newText: 'new line\n' }])
})

test('fs-delegated write failure: falls back to text content (no bogus diff)', async () => {
  const { conn, proc } = makeSession({ fsDelegateEnabled: true })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't3',
    toolName: 'write',
    args: { path: '/tmp/z.txt', content: 'x' }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't3',
    isError: true,
    result: {
      content: [{ type: 'text', text: 'fs delegate write failed: permission denied' }],
      details: undefined
    }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates[1]!.update as any
  assert.equal(end.status, 'failed')
  assert.deepEqual(end.content, [
    { type: 'content', content: { type: 'text', text: 'fs delegate write failed: permission denied' } }
  ])
})

test('fs-delegated results without fsDelegated details fall back to text', async () => {
  const { conn, proc } = makeSession({ fsDelegateEnabled: true })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't4',
    toolName: 'read',
    args: { path: '/tmp/plain.txt' }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't4',
    isError: false,
    result: { content: [{ type: 'text', text: 'file body' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates[1]!.update as any
  assert.deepEqual(end.content, [{ type: 'content', content: { type: 'text', text: 'file body' } }])
})

test('without delegation the disk-snapshot diff path still applies', async () => {
  const { conn, proc } = makeSession({ fsDelegateEnabled: false })
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')

  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-snap-'))
  const file = join(dir, 'snap.txt')
  writeFileSync(file, 'before')

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't5',
    toolName: 'write',
    args: { path: file, content: 'after' }
  })
  // Simulate the local write happening between start and end (pi's built-in tool).
  writeFileSync(file, 'after')
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't5',
    isError: false,
    result: { content: [{ type: 'text', text: 'ok' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates[1]!.update as any
  assert.deepEqual(end.content, [{ type: 'diff', path: file, oldText: 'before', newText: 'after' }])
})
