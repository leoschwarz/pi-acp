import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: initialize advertises the logout capability', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

  const res = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)

  assert.deepEqual(res.agentCapabilities?.auth?.logout, {})
})

test('PiAcpAgent: logout clears pi credentials and is idempotent', async t => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-acp-logout-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
  })

  const authPath = join(agentDir, 'auth.json')
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(authPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-test' } }), { mode: 0o600 })

  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const res = await agent.logout({ _meta: null } as any)
  assert.deepEqual(res, {})

  assert.equal(readFileSync(authPath, 'utf-8'), '{}\n')

  // Idempotent: no auth.json is fine too.
  writeFileSync(authPath, '{}\n', { mode: 0o600 })
  await agent.logout({ _meta: null } as any)
  assert.equal(readFileSync(authPath, 'utf-8'), '{}\n')

  // Never creates the file when it is absent.
  const missingDir = mkdtempSync(join(tmpdir(), 'pi-acp-logout-'))
  process.env.PI_CODING_AGENT_DIR = missingDir
  await agent.logout({ _meta: null } as any)
  assert.equal(existsSync(join(missingDir, 'auth.json')), false)
})
