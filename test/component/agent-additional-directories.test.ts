import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession, SessionManager } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

function stubStore(
  agent: PiAcpAgent,
  entries: Array<{ sessionId: string; cwd: string; sessionFile: string; additionalDirectories?: string[] }> = []
) {
  const map = new Map(entries.map(e => [e.sessionId, { ...e }]))
  const upserts: Array<{
    sessionId: string
    cwd: string
    sessionFile: string
    additionalDirectories?: string[]
  }> = []
  ;(agent as any).store = {
    get: (sessionId: string) => map.get(sessionId) ?? null,
    upsert: (entry: { sessionId: string; cwd: string; sessionFile: string; additionalDirectories?: string[] }) => {
      upserts.push(entry)
      map.set(entry.sessionId, { ...entry })
    }
  }
  return { upserts, map }
}

/** Replace SessionManager's internal store so create() never touches disk. */
function stubSessionsStore(agent: PiAcpAgent) {
  const upserts: Array<{
    sessionId: string
    cwd: string
    sessionFile: string
    additionalDirectories?: string[]
  }> = []
  const sessions = new SessionManager()
  ;(sessions as any).store = {
    get: () => null,
    delete: () => {},
    upsert: (entry: { sessionId: string; cwd: string; sessionFile: string; additionalDirectories?: string[] }) => {
      upserts.push(entry)
    }
  }
  ;(agent as any).sessions = sessions
  return { upserts, sessions }
}

test('initialize advertises the additionalDirectories capability', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

  const res = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)

  assert.deepEqual((res.agentCapabilities as any).sessionCapabilities?.additionalDirectories, {})
})

test('newSession rejects relative additionalDirectories before spawning pi', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    throw new Error('pi must not spawn when additionalDirectories are invalid')
  }
  try {
    await assert.rejects(
      agent.newSession({
        cwd: '/tmp/project',
        mcpServers: [],
        additionalDirectories: ['relative/path'],
        _meta: null
      } as any),
      (err: any) => {
        assert.equal(err.code, -32602)
        assert.match(JSON.stringify(err.data ?? err.message), /absolute/)
        return true
      }
    )
  } finally {
    ;(PiRpcProcess as any).spawn = originalSpawn
  }
})

test('newSession forwards additionalDirectories to the session and the store', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const proc = new FakePiRpcProcess()
  proc.state = { sessionId: 'sess-dirs', sessionFile: '/tmp/project/sess.jsonl', thinkingLevel: 'medium' }
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => proc

  const { upserts } = stubSessionsStore(agent)

  try {
    await agent.newSession({
      cwd: '/tmp/project',
      mcpServers: [],
      additionalDirectories: ['/tmp/extra', '/tmp/other'],
      _meta: null
    } as any)
  } finally {
    ;(PiRpcProcess as any).spawn = originalSpawn
  }

  assert.deepEqual(upserts[0]?.additionalDirectories, ['/tmp/extra', '/tmp/other'])
  const live = (agent as any).sessions.maybeGet('sess-dirs') as PiAcpSession
  assert.deepEqual(live.additionalDirectories, ['/tmp/extra', '/tmp/other'])
})

test('listSessions reports stored additionalDirectories in SessionInfo', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-add-dirs-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    join(sessionsDir, '0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl'),
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'sess-1',
      timestamp: '2026-02-11T00:00:00.000Z',
      cwd: '/tmp/project'
    }) + '\n',
    'utf8'
  )

  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
  })

  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  stubStore(agent, [
    {
      sessionId: 'sess-1',
      cwd: '/tmp/project',
      sessionFile: join(sessionsDir, '0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl'),
      additionalDirectories: ['/tmp/extra']
    }
  ])

  const res = await agent.listSessions({ cwd: '/tmp/project', cursor: null, _meta: null } as any)

  const listed = res.sessions.find(s => s.sessionId === 'sess-1')
  assert.ok(listed)
  assert.deepEqual(listed?.additionalDirectories, ['/tmp/extra'])
})

test('loadSession replaces the stored additionalDirectories list', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const proc = new FakePiRpcProcess()
  const live = new PiAcpSession({
    sessionId: 'sess-1',
    cwd: '/tmp/project',
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: proc as any,
    fileCommands: []
  })
  const sessions = new SessionManager()
  ;(sessions as any).sessions.set('sess-1', live)
  ;(agent as any).sessions = sessions

  const { upserts } = stubStore(agent, [
    {
      sessionId: 'sess-1',
      cwd: '/tmp/project',
      sessionFile: '/tmp/project/sess.jsonl',
      additionalDirectories: ['/tmp/old']
    }
  ])

  // loadSession tears down any live session, so the restore below re-spawns:
  // stub spawn to return the fake proc instead of launching pi.
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => proc

  try {
    // Omitted additionalDirectories = empty complete list (per ACP loadSession docs).
    await agent.loadSession({
      cwd: '/tmp/project',
      mcpServers: [],
      sessionId: 'sess-1',
      _meta: null
    } as any)
  } finally {
    ;(PiRpcProcess as any).spawn = originalSpawn
  }

  assert.equal(upserts.length >= 1, true)
  for (const upsert of upserts) {
    // Empty list = cleared; the key is omitted for storage tidiness.
    assert.ok(!upsert.additionalDirectories || upsert.additionalDirectories.length === 0)
  }
  const restored = (agent as any).sessions.maybeGet('sess-1') as PiAcpSession
  assert.deepEqual(restored.additionalDirectories, [])
})
