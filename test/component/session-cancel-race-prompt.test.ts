import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpSession: prompt racing an in-flight cancel runs as a fresh turn, not cancelled', async () => {
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

  const first = session.prompt('one')
  assert.equal(proc.prompts.length, 1)

  // Zed force-submit sequence: cancel the running turn, then immediately
  // submit the new prompt (the cancel notification is processed first).
  await session.cancel()
  const second = session.prompt('two')

  // Must NOT be forwarded to pi's follow-up queue: pi discards queued
  // messages when the aborted run settles, which would lose the prompt.
  assert.equal(proc.followUps.length, 0)
  assert.equal(proc.abortCount, 1)

  // Settle the aborted first turn; the parked prompt must start afterwards.
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await first, 'cancelled')

  // Give the settle handler a tick to start the parked turn.
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(proc.prompts.length, 2)
  assert.equal(proc.prompts[1].message, 'two')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await second, 'end_turn')
})

test('PiAcpSession: follow_up racing an in-flight cancel resolves cancelled', async () => {
  class DeferredFollowUpProc extends FakePiRpcProcess {
    releaseFollowUp: (() => void) | null = null
    override async followUp(message: string, images: unknown[] = []): Promise<void> {
      this.followUps.push({ message, images })
      await new Promise<void>(resolve => {
        this.releaseFollowUp = resolve
      })
    }
  }

  const conn = new FakeAgentSideConnection()
  const proc = new DeferredFollowUpProc()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const first = session.prompt('one')
  assert.equal(proc.prompts.length, 1)

  // Prompt submitted while no cancel is in flight: forwarded to pi's queue,
  // but the follow_up RPC is still unresolved when the cancel arrives.
  const second = session.prompt('two')
  assert.equal(proc.followUps.length, 1)

  // The client cancelled after submitting: the in-flight prompt is cancelled
  // and purged from pi's queue (same semantics as an already-forwarded prompt).
  const cancelled = session.cancel()
  proc.releaseFollowUp?.()
  await cancelled
  assert.equal(await second, 'cancelled')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await first, 'cancelled')

  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(proc.prompts.length, 1)
})
