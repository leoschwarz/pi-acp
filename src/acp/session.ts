import type {
  AgentSideConnection,
  ContentBlock,
  McpServer,
  PermissionOption,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { PiRpcProcess, PiRpcSpawnError, type PiRpcEvent } from '../pi-rpc/process.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { attachFsDelegate, resolveFsDelegateExtensionPath, type FsDelegateConfig } from './fs-delegate.js'
import { getSessionConfiguration } from './session-config.js'
import { SessionStore } from './session-store.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import {
  bashCommand,
  bashExitCode,
  bashOutputDelta,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import { toolResultToText } from './translate/pi-tools.js'
import {
  promptUsageFromSessionStats,
  usageUpdateFromSessionStats,
  type AcpUsage,
  type AcpUsageUpdatePayload
} from './translate/usage.js'

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  additionalDirectories?: string[]
  conn: AgentSideConnection
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  piCommand?: string
  /** Emit Zed-only display-terminal content/_meta for bash tool calls. Defaults to true. */
  zedTerminalFallback?: boolean
  /** Client advertised form elicitation: extension input/editor map to elicitation/create. */
  supportsFormElicitation?: boolean
  /** Client fs capabilities: delegate read/write/edit through the ACP client. */
  fsDelegate?: FsDelegateConfig
}

export type StopReason = 'end_turn' | 'cancelled' | 'error'

type PendingTurn = {
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type QueuedTurn = {
  message: string
  images: unknown[]
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type PermissionResponse = Awaited<ReturnType<AgentSideConnection['requestPermission']>>

const CONFIRM_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
  { optionId: 'no', name: 'No', kind: 'reject_once' }
]
const EXTENSION_UI_RAW_INPUT_KEYS = ['title', 'message', 'options', 'placeholder', 'prefill'] as const
const CHOICE_OPTION_PREFIX = 'choice-'

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

function getToolPath(args: unknown): string | undefined {
  const record = args as { path?: unknown; file_path?: unknown } | null | undefined
  if (typeof record?.path === 'string') return record.path
  if (typeof record?.file_path === 'string') return record.file_path
  return undefined
}

/**
 * Before/after info emitted by the bundled fs-delegate extension for delegated
 * write/edit tool results (details.fsDelegated === true).
 */
function extractDelegatedDiff(result: unknown): { path: string; oldText: string | null; newText: string } | null {
  const details = (result as any)?.details
  if (details?.fsDelegated !== true) return null
  if (typeof details?.path !== 'string' || typeof details?.newText !== 'string') return null
  return {
    path: details.path,
    oldText: typeof details.oldText === 'string' ? details.oldText : null,
    newText: details.newText
  }
}

// Match pi's current edit schema: { path, edits: [{ oldText, newText }] }, with
// legacy top-level oldText/newText still accepted. Pi also normalizes stringified edits.
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts
function getParsedEdits(args: unknown): Array<{ oldText: string; newText: string }> {
  const record = args as { oldText?: unknown; newText?: unknown; edits?: unknown } | null | undefined
  const parsed: Array<{ oldText: string; newText: string }> = []

  if (typeof record?.oldText === 'string' && typeof record?.newText === 'string') {
    parsed.push({ oldText: record.oldText, newText: record.newText })
  }

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const item = edit as { oldText?: unknown; newText?: unknown } | null | undefined
      if (typeof item?.oldText === 'string' && typeof item?.newText === 'string') {
        parsed.push({ oldText: item.oldText, newText: item.newText })
      }
    }
  }

  return parsed
}

function getEditOldTexts(args: unknown): string[] {
  const record = args as { oldText?: unknown; edits?: unknown } | null | undefined
  const oldTexts = getParsedEdits(args).map(edit => edit.oldText)

  if (typeof record?.oldText === 'string' && !oldTexts.includes(record.oldText)) oldTexts.push(record.oldText)

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const oldText = (edit as { oldText?: unknown } | null | undefined)?.oldText
      if (typeof oldText === 'string' && !oldTexts.includes(oldText)) oldTexts.push(oldText)
    }
  }

  return oldTexts
}

function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path = getToolPath(args)
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>()
  private readonly store = new SessionStore()

  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll(): void {
    for (const [id] of this.sessions) this.close(id)
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      s.proc.dispose?.()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
  }

  /** Close all sessions except the one with `keepSessionId`. */
  closeAllExcept(keepSessionId: string): void {
    for (const [id] of this.sessions) {
      if (id === keepSessionId) continue
      this.close(id)
    }
  }

  /**
   * Detach a session and remove it from the manager WITHOUT disposing its pi process.
   * Used by session/fork: the subprocess is handed over to the forked session, while
   * the source session stays restorable from its session file.
   */
  release(sessionId: string): void {
    this.sessions.get(sessionId)?.detach()
    this.sessions.delete(sessionId)
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    const delegateConfig = params.fsDelegate?.enabled ? params.fsDelegate : null
    const delegateExtensionPath = delegateConfig ? resolveFsDelegateExtensionPath() : null

    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand,
        ...(delegateConfig && delegateExtensionPath
          ? {
              fsDelegateExtensionPath: delegateExtensionPath,
              fsDelegateCaps: { read: delegateConfig.read, write: delegateConfig.write }
            }
          : {})
      })
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }

    let state: any = null
    try {
      state = (await proc.getState()) as any
    } catch {
      state = null
    }

    const sessionId = typeof state?.sessionId === 'string' ? state.sessionId : crypto.randomUUID()
    const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
    const fsDelegateEnabled = Boolean(delegateConfig && delegateExtensionPath && proc.getFsDelegate())

    if (fsDelegateEnabled) attachFsDelegate(proc, sessionId, params.conn)

    if (sessionFile) {
      this.store.upsert({
        sessionId,
        cwd: params.cwd,
        sessionFile,
        additionalDirectories: params.additionalDirectories
      })
    }

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      additionalDirectories: params.additionalDirectories,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      fsDelegateEnabled
    })

    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): PiAcpSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return s
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(sessionId: string, params: SessionCreateParams & { proc: PiRpcProcess }): PiAcpSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    // Fork ownership transfer: the subprocess already carries a delegate server
    // (spawned for the source session); rebind its handler to the new session id.
    if (params.fsDelegate?.enabled && params.proc.getFsDelegate()) {
      attachFsDelegate(params.proc, sessionId, params.conn)
    }

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      additionalDirectories: params.additionalDirectories,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      fsDelegateEnabled: Boolean(params.fsDelegate?.enabled && params.proc.getFsDelegate())
    })

    this.sessions.set(sessionId, session)
    return session
  }
}

export class PiAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]
  readonly additionalDirectories: string[]

  private startupInfo: string | null = null
  private startupInfoSent = false

  readonly proc: PiRpcProcess
  private readonly conn: AgentSideConnection
  private readonly fileCommands: FileSlashCommand[]
  readonly usesZedTerminalFallback: boolean
  readonly supportsFormElicitation: boolean
  readonly fsDelegateEnabled: boolean

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false

  // Unsubscribes this session from pi events (held so detach() can release it when
  // the subprocess is handed over to a forked session).
  private detachProcEvents: (() => void) | null = null

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null
  private readonly turnQueue: QueuedTurn[] = []
  // Prompts handed to pi's own queue via follow_up (native steering/queueing).
  // They all resolve at the same final agent_settled as the running turn; the
  // local `turnQueue` above is only the fallback path (old pi, or pi refusing
  // to queue e.g. extension commands).
  private readonly forwardedTurns: QueuedTurn[] = []
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()

  // pi can emit multiple `turn_end` and `agent_end` events for a single user prompt
  // when retry, compaction, or queued continuations run. The session-level prompt
  // completes only when `agent_settled` is emitted.
  private inAgentLoop = false

  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  private fileSnapshots = new Map<string, { path: string; oldText: string | null }>()
  private fileMutationToolCallIds = new Set<string>()
  private bashToolCallIds = new Set<string>()
  private bashOutputSnapshots = new Map<string, string>()

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()

  // Cumulative usage from the most recently completed turn (unstable ACP
  // `session/prompt` `usage` field), refreshed from pi session stats at turn end.
  private turnUsage: AcpUsage | null = null

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    additionalDirectories?: string[]
    proc: PiRpcProcess
    conn: AgentSideConnection
    fileCommands?: FileSlashCommand[]
    zedTerminalFallback?: boolean
    supportsFormElicitation?: boolean
    fsDelegateEnabled?: boolean
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.additionalDirectories = opts.additionalDirectories ?? []
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []
    this.usesZedTerminalFallback = opts.zedTerminalFallback ?? true
    this.supportsFormElicitation = opts.supportsFormElicitation ?? false
    this.fsDelegateEnabled = opts.fsDelegateEnabled ?? false

    this.detachProcEvents = this.proc.onEvent(ev => this.handlePiEvent(ev))
  }

  /**
   * Usage for the unstable `usage` field of the ACP `session/prompt` response.
   * Reflects the most recently completed turn; null when unknown.
   */
  get lastTurnUsage(): AcpUsage | null {
    return this.turnUsage
  }

  setStartupInfo(text: string) {
    this.startupInfo = text
    this.startupInfoSent = false
  }

  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSent || !this.startupInfo) return
    this.startupInfoSent = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  async prompt(message: string, images: unknown[] = []): Promise<StopReason> {
    // pi RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands)

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const immediate: QueuedTurn = { message: expandedMessage, images, resolve, reject }

      // If a turn is already running, queue it — prefer pi's native follow_up
      // queue so pi runs it right after the current turn; fall back to the
      // ACP-side queue when pi can't (old pi, refused commands).
      if (this.pendingTurn) {
        const queued: QueuedTurn = { message: expandedMessage, images, resolve, reject }

        // A cancel is in flight (client interrupted the running turn — e.g. Zed
        // force-submit = session/cancel + cancelled permission outcome + new
        // session/prompt). pi discards queued messages when the aborted run
        // settles, so don't forward this prompt there; park it in the local
        // queue and the agent_settled handler starts it as a fresh turn.
        if (this.cancelRequested) {
          this.turnQueue.push(queued)
          this.emitQueueDepth()
          return
        }

        void this.proc
          .followUp(expandedMessage, images)
          .then(() => {
            if (this.cancelRequested) {
              // Cancel raced the enqueue (client sent the prompt, then cancelled):
              // purge it from pi and finish now.
              queued.resolve('cancelled')
              void this.proc.clearQueue().catch(() => {})
              return
            }
            this.forwardedTurns.push(queued)
            this.emitQueueDepth()
          })
          .catch(() => {
            this.turnQueue.push(queued)

            // Best-effort: notify client that a prompt was queued.
            // This doesn't work in Zed yet, needs to be revisited
            this.emit({
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Queued message (position ${this.turnQueue.length}).`
              }
            })
            this.emitQueueDepth()
          })
        return
      }

      // No turn is running; start immediately.
      this.startTurn(immediate)
    })

    return turnPromise
  }

  async cancel(): Promise<void> {
    // Cancel current and clear any queued prompts — both the ACP-side fallback
    // queue and whatever pi itself has queued.
    this.cancelRequested = true

    if (this.turnQueue.length || this.forwardedTurns.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      const forwarded = this.forwardedTurns.splice(0, this.forwardedTurns.length)
      for (const t of [...queued, ...forwarded]) t.resolve('cancelled')

      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Cleared queued prompts.' }
      })
      this.emitQueueDepth()
    }

    // Purge anything pi still holds in its own queue (no-op when nothing was forwarded).
    void this.proc.clearQueue().catch(() => {})

    // Abort the currently running turn (if any). If nothing is running, this is a no-op.
    await this.proc.abort()
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested
  }

  /** Publish the outstanding-prompt depth (pi queue + local fallback) via _meta. */
  private emitQueueDepth(): void {
    const depth = this.turnQueue.length + this.forwardedTurns.length
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: depth, running: depth > 0 || Boolean(this.pendingTurn) } }
    })
  }

  /** True while a turn is running or queued; the session must not be forked in this state. */
  hasActiveWork(): boolean {
    return this.pendingTurn !== null || this.turnQueue.length > 0 || this.forwardedTurns.length > 0
  }

  /**
   * Stop relaying pi events for this session WITHOUT disposing the subprocess.
   * Used by session/fork ownership transfer: the pi process is handed to the forked
   * session, so events arriving after the handover must not be emitted under this
   * session's ACP sessionId.
   */
  detach(): void {
    this.detachProcEvents?.()
    this.detachProcEvents = null
  }

  private emit(update: SessionUpdate): void {
    // Serialize update delivery.
    this.lastEmit = this.lastEmit
      .then(() =>
        this.conn.sessionUpdate({
          sessionId: this.sessionId,
          update
        })
      )
      .catch(() => {
        // Ignore notification errors (client may have gone away). We still want
        // prompt completion.
      })
  }

  private async flushEmits(): Promise<void> {
    await this.lastEmit
  }

  private refreshConfigOptions(meta?: Record<string, unknown>): void {
    void getSessionConfiguration(this.proc)
      .then(({ configOptions }) => {
        this.emit({
          sessionUpdate: 'config_option_update',
          configOptions,
          ...(meta ? { _meta: { piAcp: meta } } : {})
        })
      })
      .catch(() => {
        // Best-effort: the pi subprocess may be unavailable; config refresh is advisory.
      })
  }

  private emitBashToolCall(params: {
    sessionUpdate: 'tool_call' | 'tool_call_update'
    toolCallId: string
    toolName: string
    args: unknown
    status: 'pending' | 'in_progress'
    locations?: ToolCallLocation[]
    includeTerminal: boolean
  }): void {
    this.bashToolCallIds.add(params.toolCallId)
    this.emit({
      sessionUpdate: params.sessionUpdate,
      toolCallId: params.toolCallId,
      title: bashCommand(params.args) ?? params.toolName,
      kind: 'execute',
      status: params.status,
      locations: params.locations,
      ...(params.includeTerminal && this.usesZedTerminalFallback
        ? { content: bashTerminalContent(params.toolCallId) }
        : {}),
      ...(params.includeTerminal && this.usesZedTerminalFallback
        ? { _meta: bashTerminalInfoMeta(params.toolCallId, this.cwd) }
        : {})
    })
  }

  private emitBashOutputUpdate(params: {
    toolCallId: string
    status: 'in_progress' | 'completed' | 'failed'
    result: unknown
    isError?: boolean
  }): void {
    const text = bashResultText(params.result)
    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? ''
    const delta = bashOutputDelta(previous, text)
    this.bashOutputSnapshots.set(params.toolCallId, text)

    // Conforming ACP clients expect real terminal/create semantics; give them the
    // accumulated output as plain text content instead of the Zed-only terminal _meta.
    // Note: tool_call_update content REPLACES the collection, so send the full text.
    if (!this.usesZedTerminalFallback) {
      this.emit({
        sessionUpdate: 'tool_call_update',
        toolCallId: params.toolCallId,
        status: params.status,
        ...(text ? { content: [{ type: 'content', content: { type: 'text', text } }] } : {})
      })
      return
    }

    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: params.toolCallId,
      status: params.status,
      _meta: {
        ...(delta ? bashTerminalOutputMeta(params.toolCallId, delta) : {}),
        ...(params.status === 'completed' || params.status === 'failed'
          ? bashTerminalExitMeta(params.toolCallId, bashExitCode(params.result, Boolean(params.isError)))
          : {})
      }
    })
  }

  private cleanupToolCall(toolCallId: string): void {
    this.currentToolCalls.delete(toolCallId)
    this.fileSnapshots.delete(toolCallId)
    this.fileMutationToolCallIds.delete(toolCallId)
    this.bashToolCallIds.delete(toolCallId)
    this.bashOutputSnapshots.delete(toolCallId)
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.inAgentLoop = false
    this.turnUsage = null

    this.pendingTurn = { resolve: t.resolve, reject: t.reject }

    // Publish queue depth (0 because we're starting the turn now).
    this.emitQueueDepth()

    // Kick off pi, but completion is determined by pi events, not the RPC response.
    // The prompt RPC only acknowledges acceptance; retry, compaction, or queued
    // continuations may emit multiple `agent_end` events before `agent_settled`.
    this.proc.prompt(t.message, t.images).catch(err => {
      // If the subprocess errors before we get `agent_settled`, treat as error unless cancelled.
      // If this looks like an auth/config issue, surface AUTH_REQUIRED so clients can offer terminal login.
      const authErr = maybeAuthRequiredError(err)
      const reason: StopReason = authErr || this.cancelRequested ? 'cancelled' : 'error'

      // ACP clients otherwise render the crash as a normal end of turn; make the
      // failure visible before the prompt resolves (agent.ts maps this to `refusal`).
      if (reason === 'error') {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatTurnFailureMessage(err) } satisfies ContentBlock
        })
      }

      // Ensure we flush any already-enqueued updates (including the error chunk) first.
      void this.flushEmits().finally(() => {
        if (authErr) {
          this.pendingTurn?.reject(authErr)
        } else {
          this.pendingTurn?.resolve(reason)
        }

        this.pendingTurn = null
        this.inAgentLoop = false

        // If the prompt failed, do not automatically proceed—pi may be unhealthy.
        // But we still clear the queueDepth metadata.
        this.emitQueueDepth()
      })
    })
  }

  /**
   * Best-effort: fetch pi session stats and publish them as an ACP `usage_update`
   * (context usage + cumulative cost) plus the unstable `usage` field for the
   * prompt response. Never blocks or fails turn completion.
   */
  private async refreshUsageFromStats(): Promise<void> {
    let stats: unknown
    try {
      stats = await this.proc.getSessionStats()
    } catch {
      return
    }

    this.turnUsage = promptUsageFromSessionStats(stats) ?? this.turnUsage

    const update: AcpUsageUpdatePayload | null = usageUpdateFromSessionStats(stats)
    if (update) {
      this.emit({ sessionUpdate: 'usage_update', ...update })
    }
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? '')

    switch (type) {
      case 'message_update': {
        const ame = (ev as any).assistantMessageEvent

        // Stream assistant text.
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        // Surface tool calls ASAP so clients (e.g. Zed) can show a tool-in-use/loading UI
        // while the model is still streaming tool call args.
        if (ame?.type === 'toolcall_start' || ame?.type === 'toolcall_delta' || ame?.type === 'toolcall_end') {
          const toolCall =
            // pi sometimes includes the tool call directly on the event
            (ame as any)?.toolCall ??
            // ...and always includes it in the partial assistant message at contentIndex
            (ame as any)?.partial?.content?.[(ame as any)?.contentIndex ?? 0]

          const toolCallId = String((toolCall as any)?.id ?? '')
          const toolName = String((toolCall as any)?.name ?? 'tool')

          if (toolCallId) {
            const rawInput =
              (toolCall as any)?.arguments && typeof (toolCall as any).arguments === 'object'
                ? (toolCall as any).arguments
                : (() => {
                    const s = String((toolCall as any)?.partialArgs ?? '')
                    if (!s) return undefined
                    try {
                      return JSON.parse(s)
                    } catch {
                      return { partialArgs: s }
                    }
                  })()

            const locations = toToolCallLocations(rawInput, this.cwd)
            const existingStatus = this.currentToolCalls.get(toolCallId)
            // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
            const status = existingStatus ?? 'pending'

            if (isBashTool(toolName)) {
              if (!existingStatus) this.currentToolCalls.set(toolCallId, 'pending')
              this.emitBashToolCall({
                sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
                toolCallId,
                toolName,
                args: rawInput,
                status,
                locations,
                includeTerminal: !existingStatus
              })
            } else if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, 'pending')
              this.emit({
                sessionUpdate: 'tool_call',
                toolCallId,
                title: toolName,
                kind: toToolKind(toolName),
                status,
                locations,
                rawInput
              })
            } else {
              // Best-effort: keep rawInput updated while args are streaming.
              // Keep the existing status (pending or in_progress).
              this.emit({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status,
                locations,
                rawInput
              })
            }
          }

          break
        }

        // Ignore other delta/event types for now.
        break
      }

      case 'tool_execution_start': {
        const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID())
        const toolName = String((ev as any).toolName ?? 'tool')
        const args = (ev as any).args
        let line: number | undefined

        if (isBashTool(toolName)) {
          const locations = toToolCallLocations(args, this.cwd)
          const existingStatus = this.currentToolCalls.get(toolCallId)
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emitBashToolCall({
            sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
            toolCallId,
            toolName,
            args,
            status: 'in_progress',
            locations,
            includeTerminal: !existingStatus
          })
          break
        }

        // Capture pre-mutation file contents so we can emit a structured ACP diff.
        // With fs delegation the write goes through the client (buffer may not be
        // flushed to disk yet), so the diff comes from the tool result details
        // instead of a disk snapshot.
        const isFileMutation = toolName === 'edit' || toolName === 'write'
        let snapshotOldText: string | null | undefined
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId)
          if (!this.fsDelegateEnabled) {
            const p = getToolPath(args)
            if (p) {
              try {
                const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
                snapshotOldText = readFileSync(abs, 'utf8')
                this.fileSnapshots.set(toolCallId, { path: p, oldText: snapshotOldText })

                if (toolName === 'edit') {
                  for (const needle of getEditOldTexts(args)) {
                    line = findUniqueLineNumber(snapshotOldText, needle)
                    if (typeof line === 'number') break
                  }
                }
              } catch {
                snapshotOldText = null
                this.fileSnapshots.set(toolCallId, { path: p, oldText: null })
              }
            }
          }
        }

        const locations = toToolCallLocations(args, this.cwd, line)

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolName,
            kind: toToolKind(toolName),
            status: 'in_progress',
            locations,
            rawInput: args
          })
        } else {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'in_progress',
            locations,
            rawInput: args
          })
        }

        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const partial = (ev as any).partialResult
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({ toolCallId, status: 'in_progress', result: partial })
          break
        }

        const text = this.fileMutationToolCallIds.has(toolCallId) ? '' : toolResultToText(partial)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: text
            ? ([{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[])
            : undefined,
          ...(this.fileMutationToolCallIds.has(toolCallId) ? {} : { rawOutput: partial })
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({
            toolCallId,
            status: isError ? 'failed' : 'completed',
            result,
            isError
          })
          this.cleanupToolCall(toolCallId)
          break
        }

        const text = toolResultToText(result)

        // Delegated writes carry their own before/after in details (the file on
        // disk may not reflect the client-side write yet).
        const delegatedDiff = this.fsDelegateEnabled ? extractDelegatedDiff(result) : null

        const snapshot = this.fileSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined
        let hasStructuredDiff = false

        if (!isError && delegatedDiff) {
          hasStructuredDiff = true
          content = [
            {
              type: 'diff',
              path: delegatedDiff.path,
              oldText: delegatedDiff.oldText,
              newText: delegatedDiff.newText
            }
          ]
        } else if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            const newText = readFileSync(abs, 'utf8')
            if (snapshot.oldText === null || newText !== snapshot.oldText) {
              hasStructuredDiff = true
              content = [
                {
                  type: 'diff',
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                }
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        if (!content && !hasStructuredDiff && text) {
          content = [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]
        }

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content,
          ...(hasStructuredDiff ? {} : { rawOutput: result })
        })

        this.cleanupToolCall(toolCallId)
        break
      }

      case 'session_info_changed': {
        // Pi renamed (or cleared) the session. ACP uses title: null to clear.
        this.emit({
          sessionUpdate: 'session_info_update',
          title: stringProp(ev, 'name'),
          updatedAt: new Date().toISOString()
        })
        break
      }

      case 'thinking_level_changed': {
        const level = stringProp(ev, 'level')
        if (!level) break

        this.emit({
          sessionUpdate: 'current_mode_update',
          currentModeId: level
        })

        // Keep the advertised thought_level select's currentValue in sync.
        this.refreshConfigOptions()
        break
      }

      case 'entry_appended': {
        // Extensions persist state via custom entries. ACP has no custom-entry
        // notification; refresh the advertised config options so the client UI
        // doesn't drift, and forward the entry via _meta for clients that care.
        const entry = ev.entry
        if (!entry || typeof entry !== 'object') break

        this.refreshConfigOptions({ entryAppended: entry })
        break
      }

      case 'extension_ui_request': {
        void this.handleExtensionUiRequest(ev).catch(() => {
          const id = stringProp(ev, 'id')
          if (!id) {
            return
          }

          void this.proc.sendExtensionUiResponse({ id, cancelled: true }).catch(() => {})
        })
        break
      }

      case 'extension_error': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatExtensionErrorMessage(ev) } satisfies ContentBlock
        })
        break
      }

      case 'auto_retry_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatAutoRetryMessage(ev) } satisfies ContentBlock
        })
        break
      }

      case 'auto_retry_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Retry finished, resuming.' } satisfies ContentBlock
        })
        break
      }

      case 'compaction_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatCompactionStartMessage(ev) } satisfies ContentBlock
        })
        break
      }

      case 'compaction_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatCompactionEndMessage(ev) } satisfies ContentBlock
        })
        break
      }

      case 'agent_start': {
        this.inAgentLoop = true
        break
      }

      case 'turn_end': {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_settled`.
        break
      }

      case 'agent_end': {
        // One low-level run ended. Pi may still retry, compact, or process a queued
        // continuation, so keep the ACP turn open until `agent_settled`.
        this.inAgentLoop = false
        break
      }

      case 'queue_update': {
        // pi's own queue changed (steer/follow_up enqueues and drains). Trust
        // pi's reported depth — forwarded prompts are tracked in pi's queue now.
        const steering = Array.isArray(ev.steering) ? ev.steering.length : 0
        const followUp = Array.isArray(ev.followUp) ? ev.followUp.length : 0
        const depth = steering + followUp + this.turnQueue.length
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: depth, running: depth > 0 || Boolean(this.pendingTurn) } }
        })
        break
      }

      case 'agent_settled': {
        // Ensure all updates derived from pi events are delivered before we resolve
        // the ACP `session/prompt` request. Usage stats are fetched in between so
        // clients receive the final `usage_update` before the prompt completes.
        void this.flushEmits()
          .then(() => this.refreshUsageFromStats())
          .catch(() => {})
          .then(() => this.flushEmits())
          .finally(() => {
            const reason: StopReason = this.cancelRequested ? 'cancelled' : 'end_turn'
            this.pendingTurn?.resolve(reason)
            this.pendingTurn = null

            // Prompts queued inside pi (follow_up) all ran before this settle;
            // resolve them with the same outcome.
            const forwarded = this.forwardedTurns.splice(0, this.forwardedTurns.length)
            for (const t of forwarded) t.resolve(reason)

            this.inAgentLoop = false

            // Start next queued prompt, if any.
            const next = this.turnQueue.shift()
            if (next) {
              this.emit({
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
              })
              this.startTurn(next)
            } else {
              this.emit({
                sessionUpdate: 'session_info_update',
                _meta: { piAcp: { queueDepth: 0, running: false } }
              })
            }
          })
        break
      }

      default:
        break
    }
  }

  private async handleExtensionUiRequest(ev: PiRpcEvent): Promise<void> {
    const id = stringProp(ev, 'id')
    const method = stringProp(ev, 'method')
    if (!id) {
      return
    }

    if (method === 'select') {
      await this.handleExtensionSelect(ev, id)
      return
    }

    if (method === 'confirm') {
      await this.handleExtensionConfirm(ev, id)
      return
    }

    if (method === 'setTitle') {
      this.emit({
        sessionUpdate: 'session_info_update',
        title: stringProp(ev, 'title'),
        updatedAt: new Date().toISOString()
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    if (method === 'input' || method === 'editor') {
      if (this.supportsFormElicitation) {
        await this.elicitationForTextInput(ev, id, method)
        return
      }

      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `Pi ${method} UI request is not supported in ACP yet; cancelling it.`
        } satisfies ContentBlock
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    if (method === 'notify') {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: stringProp(ev, 'message') ?? 'Pi notification' } satisfies ContentBlock,
        _meta: { piAcp: { notify: { level: stringProp(ev, 'notifyType') ?? 'info' } } }
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, cancelled: true })
  }

  /**
   * pi's `input`/`editor` UI requests map to a single-string form elicitation.
   * Accept resolves the pi request with the submitted text; decline/cancel maps
   * to the pi `cancelled` response.
   */
  private async elicitationForTextInput(ev: PiRpcEvent, id: string, method: 'input' | 'editor'): Promise<void> {
    const title = stringProp(ev, 'title') ?? `Pi ${method}`
    const placeholder = stringProp(ev, 'placeholder')
    const prefill = stringProp(ev, 'prefill')

    const field: import('@agentclientprotocol/sdk').StringPropertySchema & { type: 'string' } = {
      type: 'string',
      title: method === 'input' ? title : 'Text',
      ...(method === 'input' && placeholder ? { description: placeholder } : {}),
      ...(method === 'editor' && prefill !== null ? { default: prefill } : {})
    }

    let response: import('@agentclientprotocol/sdk').CreateElicitationResponse
    try {
      response = await this.conn.unstable_createElicitation({
        sessionId: this.sessionId,
        mode: 'form',
        message: method === 'editor' ? `Edit text: ${title}` : title,
        requestedSchema: {
          type: 'object',
          properties: { value: field },
          required: ['value']
        }
      })
    } catch {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true }).catch(() => {})
      return
    }

    if (response.action !== 'accept') {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    const raw = (response.content as Record<string, unknown> | null | undefined)?.value
    const value = typeof raw === 'string' ? raw : ''
    await this.proc.sendExtensionUiResponse({ id, value })
  }

  private async handleExtensionSelect(ev: PiRpcEvent, id: string): Promise<void> {
    const rawOptions = ev.options
    const options = Array.isArray(rawOptions) ? rawOptions.map(option => String(option)) : []
    if (!options.length) {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    const permissionOptions: PermissionOption[] = options.map((name, index) => ({
      optionId: `${CHOICE_OPTION_PREFIX}${index}`,
      name,
      kind: 'allow_once'
    }))

    const selected = await this.requestExtensionPermission(id, ev, permissionOptions)
    if (selected === null) {
      return
    }

    const selectedOptionId = selected.outcome.outcome === 'selected' ? selected.outcome.optionId : null
    const index = selectedOptionId === null ? null : optionIndex(selectedOptionId)
    const value = index === null ? null : (options.at(index) ?? null)
    await this.proc.sendExtensionUiResponse(value === null ? { id, cancelled: true } : { id, value })
  }

  private async handleExtensionConfirm(ev: PiRpcEvent, id: string): Promise<void> {
    const selected = await this.requestExtensionPermission(id, ev, CONFIRM_PERMISSION_OPTIONS)
    if (selected === null) {
      return
    }

    if (selected.outcome.outcome === 'cancelled') {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, confirmed: selected.outcome.optionId === 'yes' })
  }

  private async requestExtensionPermission(
    id: string,
    ev: PiRpcEvent,
    options: PermissionOption[]
  ): Promise<PermissionResponse | null> {
    try {
      return await this.conn.requestPermission({
        sessionId: this.sessionId,
        toolCall: extensionUiToolCall(id, ev),
        options
      })
    } catch {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return null
    }
  }
}

function extensionUiToolCall(id: string, ev: PiRpcEvent) {
  const method = stringProp(ev, 'method') ?? 'ui'
  const title = stringProp(ev, 'title') ?? `Pi ${method}`
  const rawInput: Record<string, unknown> = { method }

  for (const key of EXTENSION_UI_RAW_INPUT_KEYS) {
    if (Object.hasOwn(ev, key)) rawInput[key] = ev[key]
  }

  return {
    toolCallId: `pi-ui-${id}`,
    title,
    kind: 'other' as const,
    status: 'pending' as const,
    rawInput
  }
}

function stringProp(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

function optionIndex(optionId: string): number | null {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) {
    return null
  }

  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length)
  if (!rawIndex) {
    return null
  }

  const index = Number(rawIndex)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex ? index : null
}

function formatTurnFailureMessage(err: unknown): string {
  const message = String((err as any)?.message ?? err ?? '').trim()
  return message ? `Turn failed: ${message}` : 'Turn failed with an unknown error.'
}

function formatExtensionErrorMessage(ev: PiRpcEvent): string {
  const extensionPath = stringProp(ev, 'extensionPath')
  const event = stringProp(ev, 'event')
  const error = stringProp(ev, 'error')

  if (!extensionPath && !error) return 'A pi extension failed with an unknown error.'

  const where = extensionPath ? `in ${extensionPath}` : ''
  const during = event ? ` during '${event}'` : ''
  const what = error ? `: ${error}` : ''

  return `Extension error ${where}${during}${what}`.trimEnd()
}

const COMPACTION_START_MESSAGES: Record<string, string> = {
  manual: 'Compacting session context...',
  threshold: 'Context nearing limit, running automatic compaction...',
  overflow: "Context exceeded the model's limit, running emergency compaction..."
}

function formatCompactionStartMessage(ev: PiRpcEvent): string {
  const reason = stringProp(ev, 'reason')
  return (reason && COMPACTION_START_MESSAGES[reason]) || 'Compacting session context...'
}

function formatCompactionEndMessage(ev: PiRpcEvent): string {
  const errorMessage = stringProp(ev, 'errorMessage')
  if (errorMessage) return `Compaction failed: ${errorMessage}`

  const aborted = (ev as any).aborted === true
  if (aborted) return 'Compaction was cancelled; continuing without a summary.'

  return 'Compaction finished; context was summarized to continue the session.'
}

function formatAutoRetryMessage(ev: PiRpcEvent): string {
  const attempt = Number((ev as any).attempt)
  const maxAttempts = Number((ev as any).maxAttempts)
  const delayMs = Number((ev as any).delayMs)

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return 'Retrying...'
  }

  let delaySeconds = Math.round(delayMs / 1000)
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`
}

function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
      return 'execute'
    default:
      return 'other'
  }
}
