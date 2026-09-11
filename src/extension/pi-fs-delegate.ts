/**
 * pi extension: delegate read/write/edit file tools to the ACP client.
 *
 * Loaded into pi via `pi --mode rpc -e <this file>` (pi-acp spawns pi with the
 * matching env vars). The extension registers tools with the SAME names as pi's
 * built-in `read`, `write`, and `edit` tools; pi's tool registry stores
 * extension tools after built-ins, so a same-name registration overrides the
 * built-in while keeping the tool name (and therefore the model's habits and
 * pi's own session log) unchanged.
 *
 * Tool executions round-trip through the pi-acp adapter, which forwards them to
 * the ACP client (`fs/read_text_file` / `fs/write_text_file`). Clients like Zed
 * route these writes through their own buffer machinery, which makes every edit
 * visible and reviewable in the editor's "edited files" review UI and lets
 * reads see unsaved editor state.
 *
 * This file is bundled standalone (typebox + diff inlined) so it has no
 * dependency-resolution requirements beyond Node built-ins when pi loads it.
 */
import * as net from 'node:net'
import * as fs from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'
import { diffLines } from 'diff'
import { Type } from 'typebox'

export const FS_DELEGATE_ENV_SOCKET = 'PI_ACP_DELEGATE_SOCKET'
export const FS_DELEGATE_ENV_TOKEN = 'PI_ACP_DELEGATE_TOKEN'
export const FS_DELEGATE_ENV_READ = 'PI_ACP_DELEGATE_READ'
export const FS_DELEGATE_ENV_WRITE = 'PI_ACP_DELEGATE_WRITE'

const DEFAULT_MAX_LINES = 2000
const DEFAULT_MAX_BYTES = 50 * 1024 // 50KB

type ToolResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  details?: Record<string, unknown> | undefined
}

interface PiLike {
  registerTool(tool: Record<string, unknown>): void
}

// ---------------------------------------------------------------------------
// Connection to the pi-acp adapter
// ---------------------------------------------------------------------------

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  signal: AbortSignal | undefined
  onAbort: () => void
}

class DelegateClient {
  private socket: net.Socket | null = null
  private connecting: Promise<net.Socket> | null = null
  private nextId = 0
  private readonly pending = new Map<string, PendingRequest>()

  constructor(
    private readonly socketPath: string,
    private readonly token: string
  ) {}

  async request<T = unknown>(op: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error('Operation aborted')
    const socket = await this.ensureConnected()

    const id = String(++this.nextId)
    const promise = new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id)
        this.send(socket, { type: 'cancel', id })
        reject(new Error('Operation aborted'))
      }
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, signal, onAbort })
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
    })

    if (!this.send(socket, { id, op, ...payload })) {
      const p = this.pending.get(id)
      if (p) {
        this.pending.delete(id)
        signal?.removeEventListener('abort', p.onAbort)
        p.reject(new Error('fs delegate connection lost'))
      }
    }

    return promise
  }

  private send(socket: net.Socket, msg: Record<string, unknown>): boolean {
    if (socket.destroyed) return false
    socket.write(JSON.stringify(msg) + '\n')
    return true
  }

  private settle(id: string, msg: any): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    p.signal?.removeEventListener('abort', p.onAbort)
    if (msg?.ok) p.resolve(msg)
    else p.reject(new Error(String(msg?.error ?? 'fs delegate request failed')))
  }

  private rejectAll(err: Error): void {
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id)
      p.signal?.removeEventListener('abort', p.onAbort)
      p.reject(err)
    }
  }

  private ensureConnected(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket)
    if (this.connecting) return this.connecting

    const promise = new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect(this.socketPath)
      // Per-connection state: a fresh connection starts with a fresh buffer.
      let buffer = ''
      let helloAcked = false
      let settled = false

      const reset = () => {
        if (this.socket === socket) this.socket = null
        if (this.connecting === promise) this.connecting = null
      }

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        for (;;) {
          const nl = buffer.indexOf('\n')
          if (nl === -1) return
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          if (!line.trim()) continue

          let msg: any
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }

          if (!helloAcked) {
            helloAcked = Boolean(msg?.ok && msg?.hello)
            if (!helloAcked) socket.destroy()
            else if (!settled) {
              settled = true
              this.socket = socket
              this.connecting = null
              resolve(socket)
            }
            continue
          }

          const id = typeof msg?.id === 'string' ? msg.id : ''
          if (id) this.settle(id, msg)
        }
      }

      const onError = () => {
        if (!settled) {
          settled = true
          reset()
          reject(new Error('fs delegate connection failed'))
        }
        socket.destroy()
      }

      const onClose = () => {
        if (!settled) {
          settled = true
          reset()
          reject(new Error('fs delegate connection failed'))
          return
        }
        reset()
        this.rejectAll(new Error('fs delegate connection lost'))
      }

      socket.on('error', onError)
      socket.on('data', onData)
      socket.on('close', onClose)

      socket.write(JSON.stringify({ v: 1, token: this.token }) + '\n')
    })

    this.connecting = promise
    return promise
  }
}

// ---------------------------------------------------------------------------
// Path/text helpers (ports of pi's built-in tool helpers)
// ---------------------------------------------------------------------------

function resolveToCwd(filePath: string, cwd: string): string {
  return resolvePath(cwd, filePath)
}

function splitBom(content: string): { bom: string; text: string } {
  return content.startsWith('\uFEFF') ? { bom: '\uFEFF', text: content.slice(1) } : { bom: '', text: content }
}

function detectLineEnding(content: string): string {
  const crlfIdx = content.indexOf('\r\n')
  const lfIdx = content.indexOf('\n')
  if (lfIdx === -1) return '\n'
  if (crlfIdx === -1) return '\n'
  return crlfIdx < lfIdx ? '\r\n' : '\n'
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function restoreLineEndings(text: string, ending: string): string {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text
}

/**
 * Normalize text for fuzzy matching (port of pi's normalizeForFuzzyMatch):
 * NFKC, trailing-whitespace trim per line, smart quotes/dashes/spaces to ASCII.
 */
export function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize('NFKC')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')
}

type MatchResult = {
  found: boolean
  index: number
  matchLength: number
  usedFuzzyMatch: boolean
}

function fuzzyFindText(content: string, oldText: string): MatchResult {
  const exactIndex = content.indexOf(oldText)
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false }
  }

  const fuzzyContent = normalizeForFuzzyMatch(content)
  const fuzzyOldText = normalizeForFuzzyMatch(oldText)
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText)
  if (fuzzyIndex === -1) {
    return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false }
  }
  return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true }
}

function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content)
  const fuzzyOldText = normalizeForFuzzyMatch(oldText)
  return fuzzyContent.split(fuzzyOldText).length - 1
}

type Replacement = { editIndex: number; matchIndex: number; matchLength: number; newText: string }

function applyReplacements(content: string, replacements: Replacement[], offset = 0): string {
  let result = content
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i]
    const matchIndex = replacement.matchIndex - offset
    result =
      result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength)
  }
  return result
}

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? []
}

function getLineSpans(content: string): Array<{ start: number; end: number }> {
  let offset = 0
  return splitLinesWithEndings(content).map(line => {
    const span = { start: offset, end: offset + line.length }
    offset = span.end
    return span
  })
}

function getReplacementLineRange(
  lines: Array<{ start: number; end: number }>,
  replacement: Replacement
): { startLine: number; endLine: number } {
  const replacementStart = replacement.matchIndex
  const replacementEnd = replacement.matchIndex + replacement.matchLength
  let startLine = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (replacementStart >= line.start && replacementStart < line.end) {
      startLine = i
      break
    }
  }
  if (startLine === -1) {
    throw new Error('Replacement range is outside the base content.')
  }
  let endLine = startLine
  while (endLine < lines.length && lines[endLine].end < replacementEnd) {
    endLine++
  }
  if (endLine >= lines.length) {
    throw new Error('Replacement range is outside the base content.')
  }
  return { startLine, endLine: endLine + 1 }
}

function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: Replacement[]
): string {
  const originalLines = splitLinesWithEndings(originalContent)
  const baseLines = getLineSpans(baseContent)
  if (originalLines.length !== baseLines.length) {
    throw new Error('Cannot preserve unchanged lines because the base content has a different line count.')
  }
  const groups: Array<{ startLine: number; endLine: number; replacements: Replacement[] }> = []
  const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)
  for (const replacement of sortedReplacements) {
    const range = getReplacementLineRange(baseLines, replacement)
    const current = groups[groups.length - 1]
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine)
      current.replacements.push(replacement)
      continue
    }
    groups.push({ ...range, replacements: [replacement] })
  }
  let originalLineIndex = 0
  let result = ''
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join('')
    const groupStartOffset = baseLines[group.startLine].start
    const groupEndOffset = baseLines[group.endLine - 1].end
    result += applyReplacements(
      baseContent.slice(groupStartOffset, groupEndOffset),
      group.replacements,
      groupStartOffset
    )
    originalLineIndex = group.endLine
  }
  result += originalLines.slice(originalLineIndex).join('')
  return result
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
    )
  }
  return new Error(
    `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`
  )
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
    )
  }
  return new Error(
    `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`
  )
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(`oldText must not be empty in ${path}.`)
  }
  return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`)
}

function getNoChangeError(path: string, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
    )
  }
  return new Error(`No changes made to ${path}. The replacements produced identical content.`)
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 * Faithful port of pi's applyEditsToNormalizedContent (fuzzy matching included).
 */
export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: Array<{ oldText: string; newText: string }>,
  path: string
): { baseContent: string; newContent: string } {
  const normalizedEdits = edits.map(edit => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText)
  }))
  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      throw getEmptyOldTextError(path, i, normalizedEdits.length)
    }
  }
  const initialMatches = normalizedEdits.map(edit => fuzzyFindText(normalizedContent, edit.oldText))
  const usedFuzzyMatch = initialMatches.some(match => match.usedFuzzyMatch)
  const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent
  const matchedEdits: Replacement[] = []
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i]
    const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText)
    if (!matchResult.found) {
      throw getNotFoundError(path, i, normalizedEdits.length)
    }
    const occurrences = countOccurrences(replacementBaseContent, edit.oldText)
    if (occurrences > 1) {
      throw getDuplicateError(path, i, normalizedEdits.length, occurrences)
    }
    matchedEdits.push({
      editIndex: i,
      matchIndex: matchResult.index,
      matchLength: matchResult.matchLength,
      newText: edit.newText
    })
  }
  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex)
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1]
    const current = matchedEdits[i]
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`
      )
    }
  }
  const baseContent = normalizedContent
  const newContent = usedFuzzyMatch
    ? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
    : applyReplacements(replacementBaseContent, matchedEdits)
  if (baseContent === newContent) {
    throw getNoChangeError(path, normalizedEdits.length)
  }
  return { baseContent, newContent }
}

// ---------------------------------------------------------------------------
// Diff + truncation (ports of pi's edit-diff/truncate helpers)
// ---------------------------------------------------------------------------

/** Line-numbered change list in the same shape pi's edit tool reports. */
export function generateDiffString(oldContent: string, newContent: string, contextLines = 4): string {
  const parts = diffLines(oldContent, newContent)
  const output: string[] = []
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')
  const maxLineNum = Math.max(oldLines.length, newLines.length)
  const lineNumWidth = String(maxLineNum).length
  let oldLineNum = 1
  let newLineNum = 1
  let lastWasChange = false
  let firstChangedLine: number | undefined
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const raw = part.value.split('\n')
    if (raw[raw.length - 1] === '') {
      raw.pop()
    }
    if (part.added || part.removed) {
      if (firstChangedLine === undefined) {
        firstChangedLine = newLineNum
      }
      for (const line of raw) {
        if (part.added) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, ' ')
          output.push(`+${lineNum} ${line}`)
          newLineNum++
        } else {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ')
          output.push(`-${lineNum} ${line}`)
          oldLineNum++
        }
      }
      lastWasChange = true
    } else {
      const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed)
      const hasLeadingChange = lastWasChange
      const hasTrailingChange = nextPartIsChange
      if (hasLeadingChange && hasTrailingChange) {
        if (raw.length <= contextLines * 2) {
          for (const line of raw) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ')
            output.push(` ${lineNum} ${line}`)
            oldLineNum++
            newLineNum++
          }
        } else {
          for (let j = 0; j < contextLines; j++) {
            const line = raw[j]
            const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ')
            output.push(` ${lineNum} ${line}`)
            oldLineNum++
            newLineNum++
          }
          output.push('...')
          const skipped = raw.length - contextLines
          oldLineNum += skipped
          newLineNum += skipped
        }
      } else if (hasLeadingChange) {
        for (let j = 0; j < Math.min(contextLines, raw.length); j++) {
          const line = raw[j]
          const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ')
          output.push(` ${lineNum} ${line}`)
          oldLineNum++
          newLineNum++
        }
      } else if (hasTrailingChange) {
        const start = Math.max(0, raw.length - contextLines)
        oldLineNum += start
        newLineNum += start
        for (let j = start; j < raw.length; j++) {
          const line = raw[j]
          const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ')
          output.push(` ${lineNum} ${line}`)
          oldLineNum++
          newLineNum++
        }
      } else {
        oldLineNum += raw.length
        newLineNum += raw.length
      }
      lastWasChange = false
    }
  }
  return output.join('\n')
}

export type TruncationResult = {
  content: string
  truncated: boolean
  truncatedBy: 'lines' | 'bytes' | null
  totalLines: number
  totalBytes: number
  outputLines: number
  outputBytes: number
  firstLineExceedsLimit: boolean
  maxLines: number
  maxBytes: number
}

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return []
  const lines = content.split('\n')
  if (content.endsWith('\n')) lines.pop()
  return lines
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export function truncateHead(content: string, options?: { maxLines?: number; maxBytes?: number }): TruncationResult {
  const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES
  const totalBytes = Buffer.byteLength(content, 'utf-8')
  const lines = splitLinesForCounting(content)
  const totalLines = lines.length

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes
    }
  }

  const firstLineBytes = Buffer.byteLength(lines[0], 'utf-8')
  if (firstLineBytes > maxBytes) {
    return {
      content: '',
      truncated: true,
      truncatedBy: 'bytes',
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes
    }
  }

  const outputLinesArr: string[] = []
  let outputBytesCount = 0
  let truncatedBy: 'lines' | 'bytes' = 'lines'
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i]
    const lineBytes = Buffer.byteLength(line, 'utf-8') + (i > 0 ? 1 : 0)
    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = 'bytes'
      break
    }
    outputLinesArr.push(line)
    outputBytesCount += lineBytes
  }
  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = 'lines'
  }
  const outputContent = outputLinesArr.join('\n')
  const finalOutputBytes = Buffer.byteLength(outputContent, 'utf-8')
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: finalOutputBytes,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes
  }
}

// ---------------------------------------------------------------------------
// Image sniffing (delegated reads are text-only; images stay local)
// ---------------------------------------------------------------------------

const IMAGE_SNIFF_BYTES = 4100
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false
  return bytes.every((byte, i) => buffer[i] === byte)
}

function startsWithAscii(buffer: Buffer, offset: number, text: string): boolean {
  if (buffer.length < offset + text.length) return false
  return text.split('').every((ch, i) => buffer[offset + i] === ch.charCodeAt(0))
}

/** Port of pi's supported-image sniffing (jpeg/png/gif/webp/bmp). */
export function detectSupportedImageMimeType(buffer: Buffer): string | null {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return buffer[3] === 0xf7 ? null : 'image/jpeg'
  if (startsWith(buffer, PNG_SIGNATURE)) return 'image/png'
  if (startsWithAscii(buffer, 0, 'GIF')) return 'image/gif'
  if (startsWithAscii(buffer, 0, 'RIFF') && startsWithAscii(buffer, 8, 'WEBP')) return 'image/webp'
  if (startsWithAscii(buffer, 0, 'BM')) return 'image/bmp'
  return null
}

// ---------------------------------------------------------------------------
// Per-path mutation queue (port of pi's withFileMutationQueue, simplified)
// ---------------------------------------------------------------------------

class FileMutationQueue {
  private queues = new Map<string, Promise<unknown>>()

  run<T>(absolutePath: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(absolutePath) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(fn)
    this.queues.set(absolutePath, next)
    void next.finally(() => {
      if (this.queues.get(absolutePath) === next) this.queues.delete(absolutePath)
    })
    return next
  }
}

// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------

export default function piFsDelegate(pi: PiLike): void {
  const socketPath = process.env[FS_DELEGATE_ENV_SOCKET]
  const token = process.env[FS_DELEGATE_ENV_TOKEN]
  if (!socketPath || !token) return

  const allowRead = process.env[FS_DELEGATE_ENV_READ] === '1'
  const allowWrite = process.env[FS_DELEGATE_ENV_WRITE] === '1'
  if (!allowRead && !allowWrite) return

  const client = new DelegateClient(socketPath, token)
  const mutationQueue = new FileMutationQueue()

  async function delegateRead(absolutePath: string, signal?: AbortSignal): Promise<string> {
    const res = await client.request<{ ok: boolean; content?: string; error?: string }>(
      'read',
      { path: absolutePath },
      signal
    )
    if (!res.ok) throw new Error(String(res.error ?? 'fs delegate read failed'))
    return typeof res.content === 'string' ? res.content : ''
  }

  async function delegateWrite(absolutePath: string, content: string, signal?: AbortSignal): Promise<void> {
    const res = await client.request<{ ok: boolean; error?: string }>('write', { path: absolutePath, content }, signal)
    if (!res.ok) throw new Error(String(res.error ?? 'fs delegate write failed'))
  }

  if (allowRead) {
    pi.registerTool({
      name: 'read',
      label: 'read',
      description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete. Reads go through the editor, so unsaved changes in open buffers are visible.`,
      promptSnippet: 'Read file contents',
      promptGuidelines: ['Use read to examine files instead of cat or sed.'],
      parameters: Type.Object({
        path: Type.String({ description: 'Path to the file to read (relative or absolute)' }),
        offset: Type.Optional(Type.Number({ description: 'Line number to start reading from (1-indexed)' })),
        limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read' }))
      }),
      async execute(
        _toolCallId: string,
        args: { path: string; offset?: number; limit?: number },
        signal?: AbortSignal,
        _onUpdate?: unknown,
        ctx?: { cwd?: string }
      ): Promise<ToolResult> {
        const { path, offset, limit } = args
        const absolutePath = resolveToCwd(path, ctx?.cwd ?? process.cwd())

        // Images cannot round-trip through fs/read_text_file (text-only); read
        // them locally so image support keeps working in delegated mode.
        try {
          const sniffHandle = await fs.open(absolutePath, 'r')
          try {
            const sniff = Buffer.alloc(IMAGE_SNIFF_BYTES)
            const { bytesRead } = await sniffHandle.read(sniff, 0, IMAGE_SNIFF_BYTES, 0)
            const mimeType = detectSupportedImageMimeType(sniff.subarray(0, bytesRead))
            if (mimeType) {
              const buffer = await fs.readFile(absolutePath)
              return {
                content: [
                  {
                    type: 'text',
                    text: `Read image file [${mimeType}] (read locally; editor delegation is text-only)`
                  },
                  { type: 'image', data: buffer.toString('base64'), mimeType }
                ]
              }
            }
          } finally {
            await sniffHandle.close()
          }
        } catch (err) {
          if (signal?.aborted) throw new Error('Operation aborted')
          throw new Error(`Could not read file: ${path}. ${(err as Error)?.message ?? String(err)}`)
        }

        let content: string
        try {
          content = await delegateRead(absolutePath, signal)
        } catch (err) {
          if (signal?.aborted) throw new Error('Operation aborted')
          throw new Error(`Could not read file: ${path}. ${(err as Error)?.message ?? String(err)}`)
        }

        const allLines = content.split('\n')
        const totalFileLines = allLines.length
        const startLine = offset ? Math.max(0, offset - 1) : 0
        const startLineDisplay = startLine + 1

        if (startLine >= allLines.length) {
          throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`)
        }

        let selectedContent: string
        let userLimitedLines: number | undefined
        if (limit !== undefined) {
          const endLine = Math.min(startLine + limit, allLines.length)
          selectedContent = allLines.slice(startLine, endLine).join('\n')
          userLimitedLines = endLine - startLine
        } else {
          selectedContent = allLines.slice(startLine).join('\n')
        }

        const truncation = truncateHead(selectedContent)
        let outputText: string
        if (truncation.firstLineExceedsLimit) {
          const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], 'utf-8'))
          outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`
        } else if (truncation.truncated) {
          const endLineDisplay = startLineDisplay + truncation.outputLines - 1
          const nextOffset = endLineDisplay + 1
          outputText = truncation.content
          if (truncation.truncatedBy === 'lines') {
            outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
          } else {
            outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`
          }
        } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
          const remaining = allLines.length - (startLine + userLimitedLines)
          const nextOffset = startLine + userLimitedLines + 1
          outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`
        } else {
          outputText = truncation.content
        }

        return { content: [{ type: 'text', text: outputText }] }
      }
    })
  }

  if (allowWrite) {
    pi.registerTool({
      name: 'write',
      label: 'write',
      description:
        "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories. Writes go through the editor, so the change becomes reviewable there.",
      promptSnippet: 'Create or overwrite files',
      promptGuidelines: ['Use write only for new files or complete rewrites.'],
      parameters: Type.Object({
        path: Type.String({ description: 'Path to the file to write (relative or absolute)' }),
        content: Type.String({ description: 'Content to write to the file' })
      }),
      async execute(
        _toolCallId: string,
        args: { path: string; content: string },
        signal?: AbortSignal,
        _onUpdate?: unknown,
        ctx?: { cwd?: string }
      ): Promise<ToolResult> {
        const { path, content } = args
        const absolutePath = resolveToCwd(path, ctx?.cwd ?? process.cwd())
        return mutationQueue.run(absolutePath, async () => {
          if (signal?.aborted) throw new Error('Operation aborted')

          // Read through the editor first (captures unsaved buffer state and
          // tells us whether this is a creation or an update).
          let oldText: string | null = null
          try {
            oldText = await delegateRead(absolutePath, signal)
          } catch {
            oldText = null
          }

          if (signal?.aborted) throw new Error('Operation aborted')

          // ACP write_text_file only guarantees file creation, not parent
          // directories; create them locally (invisible to review, like mkdir).
          try {
            await fs.mkdir(dirname(absolutePath), { recursive: true })
          } catch {
            // The delegated write reports its own error if this mattered.
          }

          await delegateWrite(absolutePath, content, signal)

          return {
            content: [{ type: 'text', text: `Successfully wrote ${content.length} bytes to ${path}` }],
            details: { fsDelegated: true, path, oldText, newText: content }
          }
        })
      }
    })

    pi.registerTool({
      name: 'edit',
      label: 'edit',
      description:
        'Edit a file using exact text replacement. The edits[].oldText is matched against the current editor buffer state (including unsaved changes).',
      promptSnippet:
        'Make precise file edits with exact text replacement, including multiple disjoint edits in one call',
      promptGuidelines: [
        'Use edit for precise changes (edits[].oldText must match exactly)',
        'When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls',
        'Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.',
        'Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.'
      ],
      parameters: Type.Object({
        path: Type.String({ description: 'Path to the file to edit (relative or absolute)' }),
        edits: Type.Array(
          Type.Object({
            oldText: Type.String({
              description:
                'Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.'
            }),
            newText: Type.String({ description: 'Replacement text for this targeted edit.' })
          }),
          {
            description:
              'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.'
          }
        )
      }),
      prepareArguments(args: unknown): unknown {
        // Port of pi's compat shim: models sometimes send `edits` as a JSON
        // string or a single edit object instead of a one-element array.
        if (!args || typeof args !== 'object') return args
        const record = args as { edits?: unknown }
        let edits = record.edits
        if (typeof edits === 'string') {
          try {
            edits = JSON.parse(edits)
          } catch {
            return args
          }
        }
        if (edits && typeof edits === 'object' && !Array.isArray(edits)) {
          const single = edits as { oldText?: unknown; newText?: unknown }
          if (typeof single.oldText === 'string' && typeof single.newText === 'string') {
            record.edits = [single]
          }
          return args
        }
        return args
      },
      async execute(
        _toolCallId: string,
        args: { path: string; edits: Array<{ oldText: string; newText: string }> },
        signal?: AbortSignal,
        _onUpdate?: unknown,
        ctx?: { cwd?: string }
      ): Promise<ToolResult> {
        const { path, edits } = args
        if (!Array.isArray(edits) || edits.length === 0) {
          throw new Error(`edits must be a non-empty array in ${path}.`)
        }
        const absolutePath = resolveToCwd(path, ctx?.cwd ?? process.cwd())

        return mutationQueue.run(absolutePath, async () => {
          if (signal?.aborted) throw new Error('Operation aborted')

          let rawContent: string
          try {
            rawContent = await delegateRead(absolutePath, signal)
          } catch (err) {
            if (signal?.aborted) throw new Error('Operation aborted')
            throw new Error(`Could not edit file: ${path}. ${(err as Error)?.message ?? String(err)}.`)
          }

          if (signal?.aborted) throw new Error('Operation aborted')

          const { bom, text: content } = splitBom(rawContent)
          const originalEnding = detectLineEnding(content)
          const normalizedContent = normalizeToLF(content)
          const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path)
          if (signal?.aborted) throw new Error('Operation aborted')

          const finalContent = bom + restoreLineEndings(newContent, originalEnding)
          await delegateWrite(absolutePath, finalContent, signal)

          const diffResult = generateDiffString(baseContent, newContent)
          return {
            content: [{ type: 'text', text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
            details: {
              fsDelegated: true,
              path,
              oldText: baseContent,
              newText: newContent,
              diff: diffResult
            }
          }
        })
      }
    })
  }
}
