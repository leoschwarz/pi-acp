import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// We mock PiRpcProcess.spawn so loadSession doesn't actually spawn `pi`.
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  maybeGet(_id: string) {
    return this.session
  }
  get(_id: string) {
    return this.session
  }
}

const TURN_USAGE = {
  totalTokens: 200,
  inputTokens: 100,
  outputTokens: 50,
  cachedReadTokens: 30,
  cachedWriteTokens: 20
}

async function prompt(agent: PiAcpAgent): Promise<any> {
  return agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'hello' }] } as any)
}

test('PiAcpAgent: attaches turn usage to the prompt response', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = {
    sessionId: 's1',
    proc,
    wasCancelRequested: () => false,
    prompt: async () => 'end_turn',
    lastTurnUsage: TURN_USAGE
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(session) as any

  assert.deepEqual(await prompt(agent), { stopReason: 'end_turn', usage: TURN_USAGE })
})

test('PiAcpAgent: omits usage when the session has none', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = {
    sessionId: 's1',
    proc,
    wasCancelRequested: () => false,
    prompt: async () => 'end_turn'
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(session) as any

  assert.deepEqual(await prompt(agent), { stopReason: 'end_turn' })
})

const USAGE_STATS = {
  tokens: { input: 100, output: 50, cacheRead: 30, cacheWrite: 20, total: 200 },
  cost: 0.0125,
  contextUsage: { tokens: 150, contextWindow: 200000, percent: 0.075 }
}

function writeFixtureSession(sessionFile: string) {
  mkdirSync(join(sessionFile, '..'), { recursive: true })
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'sess-usage',
        timestamp: '2026-02-11T00:00:00.000Z',
        cwd: '/tmp/project'
      }),
      JSON.stringify({
        type: 'message',
        id: 'a1b2c3d4',
        parentId: null,
        timestamp: '2026-02-11T00:00:01.000Z',
        message: { role: 'user', content: 'Hello' }
      })
    ].join('\n') + '\n',
    { encoding: 'utf8' }
  )
}

test('PiAcpAgent: loadSession publishes usage_update from pi session stats', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, '0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl')
  writeFixtureSession(sessionFile)

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const originalSpawn = PiRpcProcess.spawn

  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({ messages: [{ role: 'user', content: 'Hello' }] }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' }),
      getSessionStats: async () => USAGE_STATS
    } as any
  }

  try {
    await agent.loadSession({ sessionId: 'sess-usage', cwd: '/tmp/project', mcpServers: [], _meta: null } as any)

    const usageUpdates = conn.updates.filter(u => u.update.sessionUpdate === 'usage_update')
    assert.equal(usageUpdates.length, 1)
    assert.equal(usageUpdates[0]!.sessionId, 'sess-usage')
    assert.deepEqual(usageUpdates[0]!.update, {
      sessionUpdate: 'usage_update',
      used: 150,
      size: 200000,
      cost: { amount: 0.0125, currency: 'USD' }
    })
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: loadSession survives procs without getSessionStats', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, '0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl')
  writeFixtureSession(sessionFile)

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const originalSpawn = PiRpcProcess.spawn

  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({ messages: [] }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    await agent.loadSession({ sessionId: 'sess-usage', cwd: '/tmp/project', mcpServers: [], _meta: null } as any)
    assert.ok(!conn.updates.some(u => u.update.sessionUpdate === 'usage_update'))
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})
