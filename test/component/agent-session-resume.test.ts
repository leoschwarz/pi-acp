import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// We mock PiRpcProcess.spawn so resumeSession doesn't actually spawn `pi`.
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

function createStoredSessionFixture(): { root: string; sessionFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-resume-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, '0000_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jsonl')

  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'sess-resume',
        timestamp: '2026-06-01T00:00:00.000Z',
        cwd: '/tmp/project'
      }),
      JSON.stringify({
        type: 'message',
        id: 'a1b2c3d4',
        parentId: null,
        timestamp: '2026-06-01T00:00:01.000Z',
        message: { role: 'user', content: 'Hello from history' }
      }),
      JSON.stringify({
        type: 'message',
        id: 'b2c3d4e5',
        parentId: 'a1b2c3d4',
        timestamp: '2026-06-01T00:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Historic answer' }] }
      })
    ].join('\n') + '\n',
    { encoding: 'utf8' }
  )

  return { root, sessionFile }
}

function stubStore(agent: PiAcpAgent, entries: Array<{ sessionId: string; cwd: string; sessionFile: string }>) {
  const map = new Map(entries.map(e => [e.sessionId, e]))
  const upserts: Array<{ sessionId: string; cwd: string; sessionFile: string }> = []
  ;(agent as any).store = {
    get: (sessionId: string) => map.get(sessionId) ?? null,
    upsert: (entry: { sessionId: string; cwd: string; sessionFile: string }) => {
      upserts.push(entry)
    }
  }
  return upserts
}

test('PiAcpAgent: resumeSession restores context without replaying history', async () => {
  const { root, sessionFile } = createStoredSessionFixture()
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const getMessagesCalls: number[] = []

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    assert.equal(params.cwd, '/tmp/project')
    assert.equal(params.sessionPath, sessionFile)

    return {
      onEvent: () => () => {},
      getAvailableModels: async () => ({ models: [{ provider: 'test', id: 'model', name: 'model' }] }),
      getState: async () => ({ thinkingLevel: 'medium' }),
      getSessionStats: async () => ({
        contextUsage: { tokens: 1_000, contextWindow: 200_000 },
        cost: 0.25
      }),
      getMessages: async () => {
        getMessagesCalls.push(1)
        return { messages: [] }
      },
      getCommands: async () => ({ commands: [] })
    } as any
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(conn))
    stubStore(agent, [{ sessionId: 'sess-resume', cwd: '/tmp/project', sessionFile }])

    const res = await agent.resumeSession({
      sessionId: 'sess-resume',
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: null
    } as any)

    // Resume responds with session configuration but no message replay.
    assert.equal(getMessagesCalls.length, 0)
    assert.equal(res.modes?.currentModeId, 'medium')
    assert.ok(res.configOptions?.some(o => o.id === 'model'))
    assert.ok(res.configOptions?.some(o => o.id === 'thought_level'))

    const kinds = conn.updates.map(u => (u as any).update.sessionUpdate)
    assert.ok(!kinds.includes('user_message_chunk'))
    assert.ok(!kinds.includes('agent_message_chunk'))

    // Context usage + cost are published before the first prompt.
    const usageUpdate = conn.updates.find(u => (u as any).update.sessionUpdate === 'usage_update') as any
    assert.ok(usageUpdate)
    assert.deepEqual(usageUpdate.update, {
      sessionUpdate: 'usage_update',
      used: 1_000,
      size: 200_000,
      cost: { amount: 0.25, currency: 'USD' }
    })

    // Slash commands are advertised shortly after the response.
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(conn.updates.some(u => (u as any).update.sessionUpdate === 'available_commands_update'))
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: resumeSession reuses a live session without respawning pi', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const liveProc = new FakePiRpcProcess()
  liveProc.sessionStats = { contextUsage: { tokens: 10, contextWindow: 100 } }
  const liveSession = { sessionId: 'sess-live', cwd: '/tmp/project', proc: liveProc }

  ;(agent as any).sessions = {
    maybeGet(id: string) {
      return id === 'sess-live' ? liveSession : undefined
    }
  }
  stubStore(agent, [{ sessionId: 'sess-live', cwd: '/tmp/project', sessionFile: '/tmp/project/s.jsonl' }])

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    throw new Error('resumeSession must not respawn a live session')
  }

  try {
    const res = await agent.resumeSession({
      sessionId: 'sess-live',
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: null
    } as any)

    assert.equal(res.modes?.currentModeId, 'medium')
    assert.ok((res.configOptions?.length ?? 0) >= 1)

    const usageUpdate = conn.updates.find(u => (u as any).update.sessionUpdate === 'usage_update') as any
    assert.ok(usageUpdate)
    assert.equal(usageUpdate.update.used, 10)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: resumeSession rejects relative cwd and unknown sessions', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  stubStore(agent, [])

  // Point session discovery at an empty dir so the unknown-session case
  // can't accidentally resolve against the developer's real pi sessions.
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-resume-empty-'))

  try {
    await assert.rejects(
      agent.resumeSession({ sessionId: 'sess-1', cwd: 'relative/path', mcpServers: [], _meta: null } as any),
      (e: any) => e?.code === -32602
    )

    await assert.rejects(
      agent.resumeSession({ sessionId: 'missing-session', cwd: '/tmp/project', mcpServers: [], _meta: null } as any),
      (e: any) => e?.code === -32602
    )
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})
