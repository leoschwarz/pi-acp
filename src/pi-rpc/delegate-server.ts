import * as net from 'node:net'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Transport for the bundled pi extension that delegates file tools to the ACP
 * client. The adapter listens on a private local socket; pi (spawned with the
 * extension plus matching env vars) connects and issues read/write requests.
 *
 * Protocol: newline-delimited JSON. The first line from the extension must be
 * the hello `{ v: 1, token }`; the server answers `{ ok: true, hello: true }`.
 * Requests are `{ id, op, ... }`, responses `{ id, ok, content?, error? }`, and
 * in-flight requests can be abandoned with `{ type: 'cancel', id }`.
 */

export const FS_DELEGATE_PROTOCOL_VERSION = 1

/** Env var names shared with the bundled pi extension (see src/extension/pi-fs-delegate.ts). */
export const FS_DELEGATE_ENV_SOCKET = 'PI_ACP_DELEGATE_SOCKET'
export const FS_DELEGATE_ENV_TOKEN = 'PI_ACP_DELEGATE_TOKEN'
export const FS_DELEGATE_ENV_READ = 'PI_ACP_DELEGATE_READ'
export const FS_DELEGATE_ENV_WRITE = 'PI_ACP_DELEGATE_WRITE'

/** Build the env vars handed to the pi subprocess alongside `-e <extension>`. */
export function fsDelegateSpawnEnv(
  caps: { read: boolean; write: boolean },
  socketPath: string,
  token: string
): Record<string, string> {
  return {
    [FS_DELEGATE_ENV_SOCKET]: socketPath,
    [FS_DELEGATE_ENV_TOKEN]: token,
    [FS_DELEGATE_ENV_READ]: caps.read ? '1' : '0',
    [FS_DELEGATE_ENV_WRITE]: caps.write ? '1' : '0'
  }
}

export type FsDelegateOp = 'ping' | 'read' | 'write'

export type FsDelegateRequest = {
  id: string
  op: FsDelegateOp
  path?: string
  content?: string
}

export type FsDelegateResponse = {
  id: string
  ok: boolean
  content?: string
  error?: string
}

export type FsDelegateHandler = (req: FsDelegateRequest, signal: AbortSignal) => Promise<FsDelegateResponse>

type PendingRequest = {
  socket: net.Socket
  controller: AbortController
  settled: boolean
}

export class FsDelegateServer {
  private readonly server: net.Server
  private readonly connections = new Set<net.Socket>()
  private readonly pending = new Map<string, PendingRequest>()
  private handler: FsDelegateHandler | null = null
  private disposed = false

  private constructor(
    readonly socketPath: string,
    readonly token: string
  ) {
    this.server = net.createServer(socket => this.handleConnection(socket))
  }

  static async create(): Promise<FsDelegateServer> {
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\pi-acp-${randomUUID()}`
        : join(tmpdir(), `pi-acp-${randomUUID()}.sock`)
    const server = new FsDelegateServer(socketPath, randomUUID())
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.server.off('error', onError)
        reject(err)
      }
      server.server.once('error', onError)
      server.server.listen(socketPath, () => {
        server.server.off('error', onError)
        resolve()
      })
    })
    return server
  }

  setHandler(handler: FsDelegateHandler | null): void {
    this.handler = handler
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.setHandler(null)
    for (const [, p] of this.pending) {
      p.settled = true
      p.controller.abort()
    }
    this.pending.clear()
    for (const socket of this.connections) {
      // Graceful teardown: destroying a socket synchronously (especially with
      // unread inbound data) sends RST, which surfaces as a spurious — and
      // sometimes uncatchable — ECONNRESET on the pi side. Remove listeners,
      // drain inbound, send FIN, and destroy only after a short grace period.
      socket.removeAllListeners('data')
      socket.removeAllListeners('error')
      socket.removeAllListeners('close')
      socket.resume()
      socket.end()
      const t = setTimeout(() => {
        try {
          socket.destroy()
        } catch {
          // ignore
        }
      }, 20)
      t.unref?.()
    }
    this.connections.clear()
    try {
      this.server.close()
    } catch {
      // ignore
    }
  }

  private handleConnection(socket: net.Socket): void {
    if (this.disposed) {
      socket.destroy()
      return
    }

    this.connections.add(socket)
    let authenticated = false
    let buffer = ''

    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const nl = buffer.indexOf('\n')
        if (nl === -1) return
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (!line.trim()) continue

        if (!authenticated) {
          authenticated = this.handleHello(socket, line)
          continue
        }

        this.handleLine(socket, line)
      }
    })

    const drop = () => {
      this.connections.delete(socket)
      // Fail only this socket's in-flight requests; the extension reconnects
      // and the tool call surfaces the error to the model.
      for (const [id, p] of [...this.pending]) {
        if (p.socket !== socket) continue
        p.settled = true
        p.controller.abort()
        this.pending.delete(id)
      }
    }

    socket.on('error', drop)
    socket.on('close', drop)
  }

  private handleHello(socket: net.Socket, line: string): boolean {
    let hello: any
    try {
      hello = JSON.parse(line)
    } catch {
      socket.destroy()
      return false
    }

    if (hello?.v !== FS_DELEGATE_PROTOCOL_VERSION || hello?.token !== this.token) {
      socket.destroy()
      return false
    }

    socket.write(`${JSON.stringify({ ok: true, hello: true })}\n`)
    return true
  }

  private handleLine(socket: net.Socket, line: string): void {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }

    if (msg?.type === 'cancel') {
      const id = typeof msg.id === 'string' ? msg.id : ''
      const p = this.pending.get(id)
      if (p) {
        p.settled = true
        p.controller.abort()
        this.pending.delete(id)
      }
      return
    }

    const id = typeof msg?.id === 'string' ? msg.id : ''
    const op = msg?.op
    if (!id || (op !== 'ping' && op !== 'read' && op !== 'write')) return

    const handler = this.handler
    if (!handler) {
      this.respond(socket, { id, ok: false, error: 'fs delegate has no session attached' })
      return
    }

    const controller = new AbortController()
    const pending: PendingRequest = { socket, controller, settled: false }
    this.pending.set(id, pending)

    const request: FsDelegateRequest = {
      id,
      op,
      ...(typeof msg.path === 'string' ? { path: msg.path } : {}),
      ...(typeof msg.content === 'string' ? { content: msg.content } : {})
    }

    void (async () => {
      let response: FsDelegateResponse
      try {
        response = await handler(request, controller.signal)
      } catch (err) {
        response = { id, ok: false, error: String((err as Error)?.message ?? err) }
      }

      if (this.pending.get(id) !== pending) return
      this.pending.delete(id)
      pending.settled = true
      if (!socket.destroyed) this.respond(socket, response)
    })()
  }

  private respond(socket: net.Socket, response: FsDelegateResponse): void {
    if (!socket.destroyed) socket.write(JSON.stringify(response) + '\n')
  }
}
