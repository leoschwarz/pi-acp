import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { PiRpcEvent } from '../../src/pi-rpc/process.js'

type SessionUpdateMsg = Parameters<AgentSideConnection['sessionUpdate']>[0]

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []
  readonly permissionRequests: unknown[] = []
  readonly elicitationRequests: unknown[] = []
  nextPermissionResponse: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } = {
    outcome: { outcome: 'selected', optionId: 'allow' }
  }
  nextElicitationResponse: unknown = { action: 'accept', content: { value: 'typed text' } }
  elicitationError: Error | null = null

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg)
  }

  async unstable_createElicitation(params: unknown): Promise<unknown> {
    if (this.elicitationError) throw this.elicitationError
    this.elicitationRequests.push(params)
    return this.nextElicitationResponse
  }

  async requestPermission(
    params: unknown
  ): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    this.permissionRequests.push(params)
    return this.nextPermissionResponse
  }
}

export class FakePiRpcProcess {
  private handlers: Array<(ev: PiRpcEvent) => void> = []

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  readonly followUps: Array<{ message: string; images: unknown[] }> = []
  readonly steers: Array<{ message: string; images: unknown[] }> = []
  readonly extensionUiResponses: unknown[] = []
  abortCount = 0
  cloneCount = 0
  clearQueueCount = 0
  followUpError: Error | null = null

  /** Value returned by getState(); stateAfterClone is swapped in by cloneSession(). */
  state: any = {}

  /** Value returned by getSessionStats(); null means pi reports nothing. */
  sessionStats: unknown = null

  /** Result of cloneSession(); swap in a branched state when set. */
  cloneResponse: { cancelled: boolean } = { cancelled: false }
  cloneError: Error | null = null
  stateAfterClone: any = null

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  onExit(_handler: () => void): () => void {
    return () => {}
  }

  getFsDelegate(): null {
    return null
  }

  emit(ev: PiRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  async prompt(message: string, attachments: unknown[] = []): Promise<void> {
    this.prompts.push({ message, attachments })
  }

  async followUp(message: string, images: unknown[] = []): Promise<void> {
    if (this.followUpError) throw this.followUpError
    this.followUps.push({ message, images })
  }

  async steer(message: string, images: unknown[] = []): Promise<void> {
    this.steers.push({ message, images })
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    this.clearQueueCount += 1
    return { steering: [], followUp: [] }
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }

  async sendExtensionUiResponse(response: unknown): Promise<void> {
    this.extensionUiResponses.push(response)
  }

  async getState(): Promise<any> {
    return this.state
  }

  async cloneSession(): Promise<{ cancelled: boolean }> {
    this.cloneCount += 1
    if (this.cloneError) throw this.cloneError
    if (this.stateAfterClone) this.state = this.stateAfterClone
    return this.cloneResponse
  }

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  async getAvailableThinkingLevels(): Promise<string[]> {
    return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  }

  async getMessages(): Promise<any> {
    return { messages: [] }
  }

  async getSessionStats(): Promise<any> {
    return this.sessionStats
  }

  async getCommands(): Promise<any> {
    return { commands: [] }
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AgentSideConnection {
  // We only implement the method(s) used by PiAcpSession in tests.
  return conn as unknown as AgentSideConnection
}
