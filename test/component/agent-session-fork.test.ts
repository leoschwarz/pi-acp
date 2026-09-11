import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession, SessionManager } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// We mock PiRpcProcess.spawn so forkSession never actually spawns `pi`.
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

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

/** Inject a real PiAcpSession into a real SessionManager so release/getOrCreate behave. */
function installLiveSession(
  agent: PiAcpAgent,
  conn: FakeAgentSideConnection,
  sessionId: string,
  proc: FakePiRpcProcess
): PiAcpSession {
  const sessions = new SessionManager()
  ;(agent as any).sessions = sessions

  const session = new PiAcpSession({
    sessionId,
    cwd: '/tmp/project',
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: proc as any,
    fileCommands: []
  })

  ;(sessions as any).sessions.set(sessionId, session)
  return session
}

test('initialize advertises the session/fork capability', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const res = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)

  assert.deepEqual((res.agentCapabilities as any).sessionCapabilities?.fork, {})
})

test('unstable_forkSession clones a live session and transfers the subprocess', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const sourceProc = new FakePiRpcProcess()
  sourceProc.sessionStats = { contextUsage: { tokens: 42, contextWindow: 100 } }
  sourceProc.stateAfterClone = {
    sessionId: 'sess-fork',
    sessionFile: '/tmp/project/branch.jsonl',
    thinkingLevel: 'medium'
  }

  installLiveSession(agent, conn, 'sess-src', sourceProc)
  stubStore(agent, [{ sessionId: 'sess-src', cwd: '/tmp/project', sessionFile: '/tmp/project/src.jsonl' }])

  const res = await agent.unstable_forkSession({
    sessionId: 'sess-src',
    cwd: '/tmp/project',
    mcpServers: [],
    _meta: null
  } as any)

  assert.equal(sourceProc.cloneCount, 1)
  assert.equal(res.sessionId, 'sess-fork')
  assert.equal(res.modes?.currentModeId, 'medium')

  // The source mapping is gone; the fork owns the same pi subprocess.
  const sessions = (agent as any).sessions as SessionManager
  assert.equal(sessions.maybeGet('sess-src'), undefined)
  const forkSession = sessions.maybeGet('sess-fork')
  assert.ok(forkSession)
  assert.equal((forkSession as any).proc, sourceProc)

  // Usage is published for the fork before the first prompt.
  const usageUpdate = conn.updates.find(
    u => (u as any).sessionId === 'sess-fork' && (u as any).update.sessionUpdate === 'usage_update'
  ) as any
  assert.ok(usageUpdate)
  assert.equal(usageUpdate.update.used, 42)

  // Slash commands are advertised shortly after the response.
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(
    conn.updates.some(
      u => (u as any).sessionId === 'sess-fork' && (u as any).update.sessionUpdate === 'available_commands_update'
    )
  )
})

test('unstable_forkSession stores the forked session and keeps the source restorable', async () => {
  const { root, sessionFile } = createStoredSessionFixture()
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const upserts = stubStore(agent, [{ sessionId: 'sess-src', cwd: '/tmp/project', sessionFile }])

  const spawnCalls: Array<{ cwd?: string; sessionPath?: string }> = []
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push({ cwd: params.cwd, sessionPath: params.sessionPath })
    let cloned = false
    return {
      onEvent: () => () => {},
      getAvailableModels: async () => ({ models: [{ provider: 'test', id: 'model', name: 'model' }] }),
      getState: async () =>
        cloned
          ? { sessionId: 'sess-fork', sessionFile: '/tmp/project/branch.jsonl', thinkingLevel: 'medium' }
          : { sessionId: 'sess-src', sessionFile, thinkingLevel: 'medium' },
      getAvailableThinkingLevels: async () => ['off', 'low', 'medium', 'high'],
      cloneSession: async () => {
        cloned = true
        return { cancelled: false }
      },
      getSessionStats: async () => ({ contextUsage: { tokens: 7, contextWindow: 100 } }),
      getMessages: async () => ({ messages: [] }),
      getCommands: async () => ({ commands: [] })
    } as any
  }

  try {
    const res = await agent.unstable_forkSession({
      sessionId: 'sess-src',
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: null
    } as any)

    assert.equal(res.sessionId, 'sess-fork')
    assert.equal(spawnCalls.length, 1)

    const branched = upserts.find(u => u.sessionId === 'sess-fork')
    assert.ok(branched)
    assert.equal(branched?.sessionFile, '/tmp/project/branch.jsonl')
    assert.equal(branched?.cwd, '/tmp/project')

    // The fork is live; the source is not, and re-attaching respawns pi against
    // the source's original session file.
    const sessions = (agent as any).sessions as SessionManager
    assert.equal(sessions.maybeGet('sess-src'), undefined)
    assert.ok(sessions.maybeGet('sess-fork'))

    await agent.resumeSession({ sessionId: 'sess-src', cwd: '/tmp/project', mcpServers: [], _meta: null } as any)
    assert.equal(spawnCalls.length, 2)
    assert.equal(spawnCalls[1]?.sessionPath, sessionFile)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('unstable_forkSession rejects a busy session', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const proc = new FakePiRpcProcess()
  const session = installLiveSession(agent, conn, 'sess-src', proc)
  stubStore(agent, [{ sessionId: 'sess-src', cwd: '/tmp/project', sessionFile: '/tmp/project/src.jsonl' }])

  const turnPromise = session.prompt('busy turn')
  assert.ok(session.hasActiveWork())

  await assert.rejects(
    agent.unstable_forkSession({ sessionId: 'sess-src', cwd: '/tmp/project', mcpServers: [], _meta: null } as any),
    (e: any) => {
      assert.equal(e.code, -32600)
      assert.match(e.message, /turn is running or queued/)
      return true
    }
  )

  assert.equal(proc.cloneCount, 0)

  // Let the dangling turn finish.
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turnPromise, 'end_turn')
})

test('unstable_forkSession surfaces pi clone failures', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const proc = new FakePiRpcProcess()
  proc.cloneError = new Error('Cannot clone session: no current entry selected')
  installLiveSession(agent, conn, 'sess-src', proc)
  stubStore(agent, [{ sessionId: 'sess-src', cwd: '/tmp/project', sessionFile: '/tmp/project/src.jsonl' }])

  await assert.rejects(
    agent.unstable_forkSession({ sessionId: 'sess-src', cwd: '/tmp/project', mcpServers: [], _meta: null } as any),
    (e: any) => {
      assert.equal(e.code, -32603)
      assert.match(e.message, /no current entry selected/)
      return true
    }
  )

  // Source session stays live and usable.
  const sessions = (agent as any).sessions as SessionManager
  assert.ok(sessions.maybeGet('sess-src'))
})

test('unstable_forkSession reports an extension veto as an error', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const proc = new FakePiRpcProcess()
  proc.cloneResponse = { cancelled: true }
  installLiveSession(agent, conn, 'sess-src', proc)
  stubStore(agent, [{ sessionId: 'sess-src', cwd: '/tmp/project', sessionFile: '/tmp/project/src.jsonl' }])

  await assert.rejects(
    agent.unstable_forkSession({ sessionId: 'sess-src', cwd: '/tmp/project', mcpServers: [], _meta: null } as any),
    (e: any) => {
      assert.equal(e.code, -32603)
      assert.match(e.message, /veto/)
      return true
    }
  )

  const sessions = (agent as any).sessions as SessionManager
  assert.ok(sessions.maybeGet('sess-src'))
})

test('unstable_forkSession fails cleanly when pi does not report the new session id', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const proc = new FakePiRpcProcess()
  proc.stateAfterClone = { sessionId: null, sessionFile: null }
  installLiveSession(agent, conn, 'sess-src', proc)
  stubStore(agent, [{ sessionId: 'sess-src', cwd: '/tmp/project', sessionFile: '/tmp/project/src.jsonl' }])

  await assert.rejects(
    agent.unstable_forkSession({ sessionId: 'sess-src', cwd: '/tmp/project', mcpServers: [], _meta: null } as any),
    (e: any) => {
      assert.equal(e.code, -32603)
      assert.match(e.message, /new session id/)
      return true
    }
  )

  // The ownership transfer only happens after the forked id is known.
  const sessions = (agent as any).sessions as SessionManager
  assert.ok(sessions.maybeGet('sess-src'))
})

test('unstable_forkSession rejects a relative cwd', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  stubStore(agent, [])

  await assert.rejects(
    agent.unstable_forkSession({ sessionId: 'sess-1', cwd: 'relative/path', mcpServers: [], _meta: null } as any),
    (e: any) => e?.code === -32602
  )
})

function createStoredSessionFixture(): { root: string; sessionFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-fork-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, '0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl')

  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'sess-src',
        timestamp: '2026-06-01T00:00:00.000Z',
        cwd: '/tmp/project'
      }),
      JSON.stringify({
        type: 'message',
        id: 'a1b2c3d4',
        parentId: null,
        timestamp: '2026-06-01T00:00:01.000Z',
        message: { role: 'user', content: 'Hello from source session' }
      })
    ].join('\n') + '\n',
    { encoding: 'utf8' }
  )

  return { root, sessionFile }
}
