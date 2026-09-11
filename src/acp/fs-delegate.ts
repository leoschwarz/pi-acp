import type { AgentSideConnection, ClientCapabilities } from '@agentclientprotocol/sdk'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { PiRpcProcess } from '../pi-rpc/process.js'
import type { FsDelegateRequest, FsDelegateResponse } from '../pi-rpc/delegate-server.js'

/**
 * Client-side fs delegation (ACP `fs/read_text_file` / `fs/write_text_file`).
 *
 * When the client advertises the fs capabilities, pi is spawned with the
 * bundled pi-fs-delegate extension. The extension overrides pi's built-in
 * `read`/`write`/`edit` tools and round-trips their executions through the
 * adapter so the CLIENT performs the actual file operations. Clients like Zed
 * route those writes through their own buffer machinery, which makes agent
 * edits visible and reviewable in the editor and lets the agent read unsaved
 * editor state.
 *
 * Deletions and directories are not part of the ACP fs surface: mkdir is done
 * locally by the extension (invisible to review), and `rm`-style operations
 * remain bash territory (untracked), consistent with D3.
 */

export type FsDelegateConfig = {
  /** Adapter spawns pi with the extension (socket server + `-e` arg). */
  enabled: boolean
  /** Client advertised `fs.readTextFile` → extension overrides `read`. */
  read: boolean
  /** Client advertised `fs.writeTextFile` → extension overrides `write`/`edit`. */
  write: boolean
}

const OPT_OUT_VALUES = new Set(['false', '0', 'off', 'no'])

export function fsDelegateConfig(clientCapabilities: ClientCapabilities | undefined): FsDelegateConfig {
  const optOut = OPT_OUT_VALUES.has(
    String(process.env.PI_ACP_FS_DELEGATE ?? '')
      .trim()
      .toLowerCase()
  )
  const read = clientCapabilities?.fs?.readTextFile === true
  const write = clientCapabilities?.fs?.writeTextFile === true
  return { enabled: !optOut && (read || write), read, write }
}

/**
 * Resolve the bundled extension entry point. `PI_ACP_FS_DELEGATE_EXTENSION`
 * overrides the location (dev/tests). Returns null when the file is missing —
 * delegation silently falls back to pi's local tools in that case.
 *
 * Candidates cover the bundled layout (extension sits next to dist/index.js)
 * and an unbundled dist/acp/ layout.
 */
export function resolveFsDelegateExtensionPath(): string | null {
  const override = process.env.PI_ACP_FS_DELEGATE_EXTENSION
  if (override) return existsSync(override) ? override : null

  for (const candidate of ['../pi-fs-delegate.js', './pi-fs-delegate.js']) {
    const path = fileURLToPath(new URL(candidate, import.meta.url))
    if (existsSync(path)) return path
  }

  return null
}

/**
 * Bind the subprocess's delegate server to an ACP session id. Called after the
 * session id is known (pi reports it via get_state); also re-called when pi
 * rebinds the subprocess to a forked session.
 */
export function attachFsDelegate(proc: PiRpcProcess, sessionId: string, conn: AgentSideConnection): void {
  const server = proc.getFsDelegate()
  if (!server) return

  server.setHandler(req => handleFsDelegateRequest(conn, sessionId, req))
}

async function handleFsDelegateRequest(
  conn: AgentSideConnection,
  sessionId: string,
  req: FsDelegateRequest
): Promise<FsDelegateResponse> {
  if (req.op === 'ping') {
    return { id: req.id, ok: true }
  }

  if (typeof req.path !== 'string' || req.path.length === 0) {
    return { id: req.id, ok: false, error: 'fs delegate request is missing a path' }
  }

  try {
    if (req.op === 'read') {
      // Full content: the extension slices offset/limit and formats truncation
      // notices itself to keep pi's exact built-in read semantics.
      const res = await conn.readTextFile({ sessionId, path: req.path })
      return { id: req.id, ok: true, content: res.content }
    }

    if (req.op === 'write') {
      if (typeof req.content !== 'string') {
        return { id: req.id, ok: false, error: 'fs delegate write request is missing content' }
      }
      await conn.writeTextFile({ sessionId, path: req.path, content: req.content })
      return { id: req.id, ok: true }
    }

    return { id: req.id, ok: false, error: `Unknown fs delegate op: ${String(req.op)}` }
  } catch (err) {
    return { id: req.id, ok: false, error: String((err as Error)?.message ?? err) }
  }
}
