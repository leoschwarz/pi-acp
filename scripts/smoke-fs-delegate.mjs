import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// End-to-end check for client-side fs delegation:
// 1. Start the real adapter (dist/index.js).
// 2. Speak ACP like Zed: advertise fs.readTextFile/fs.writeTextFile.
// 3. The adapter must spawn pi with the bundled fs-delegate extension.
// 4. Ask the model to create a file; the `write` tool call must round-trip to
//    us as `fs/write_text_file` (which is what makes Zed show reviewable edits)
//    instead of pi writing to disk directly.

const cwd = process.cwd()

await new Promise((resolve, reject) => {
  const p = spawn('npm', ['run', 'build'], { stdio: 'inherit', cwd })
  p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`build failed: ${code}`))))
})

const workDir = mkdtempSync(join(tmpdir(), 'pi-acp-fs-smoke-'))
const targetPath = join(workDir, 'hello-delegate.txt')
const expectedContent = 'hello from the editor\n'

const child = spawn('node', ['dist/index.js'], {
  cwd,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env
})

let buffer = ''
const pending = new Map()
const fsWrites = []
let sessionId = null
let promptId = null
let finished = false

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n')
}

function request(id, method, params) {
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

function fail(message) {
  console.error(`FAIL: ${message}`)
  if (!finished) {
    finished = true
    child.kill('SIGTERM')
    process.exit(1)
  }
}

child.stdout.setEncoding('utf8')
child.stdout.on('data', async chunk => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''

  for (const line of lines) {
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }

    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${msg.error.message ?? JSON.stringify(msg.error)}`))
      else p.resolve(msg.result)
      continue
    }

    // Agent → client requests (fs delegation etc.)

    if (msg.method === 'fs/write_text_file') {
      const { path, content } = msg.params ?? {}
      fsWrites.push({ path, content })
      // Act like Zed: perform the write on the "editor" side.
      try {
        const { writeFileSync, mkdirSync } = await import('node:fs')
        mkdirSync(require_dirname(path), { recursive: true })
        writeFileSync(path, content)
      } catch (err) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(err) } })
        continue
      }
      send({ jsonrpc: '2.0', id: msg.id, result: null })
      continue
    }

    if (msg.method === 'fs/read_text_file') {
      try {
        const content = readFileSync(msg.params.path, 'utf8')
        send({ jsonrpc: '2.0', id: msg.id, result: { content } })
      } catch (err) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(err) } })
      }
      continue
    }

    if (msg.method === 'session/update' && msg.params?.sessionId === sessionId) {
      const update = msg.params.update
      if (update?.sessionUpdate === 'tool_call_update' && Array.isArray(update?.content)) {
        for (const c of update.content) {
          if (c?.type === 'diff') {
            console.log(`diff card emitted for ${c.path} (oldText ${c.oldText === null ? '<new file>' : 'present'})`)
          }
        }
      }
      continue
    }
  }
})

function require_dirname(p) {
  // small inline helper to avoid a top-level import rename
  return p.split('/').slice(0, -1).join('/') || '/'
}

try {
  const init = await request(1, 'initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
  })
  console.log(`initialized: ${init?.agentInfo?.name ?? 'agent'}`)

  const newSession = await request(2, 'session/new', { cwd: workDir, mcpServers: [] })
  sessionId = newSession.sessionId
  console.log(`session: ${sessionId}`)

  promptId = 3
  const promptPromise = request(promptId, 'session/prompt', {
    sessionId,
    prompt: [
      {
        type: 'text',
        text:
          `Use the write tool to create the file ${targetPath} with exactly this content (and nothing else): ` +
          JSON.stringify(expectedContent)
      }
    ]
  })

  const timeout = setTimeout(() => {
    fail('prompt timed out after 120s')
  }, 120_000)

  await promptPromise
  clearTimeout(timeout)

  if (fsWrites.length === 0) {
    fail('the model never went through fs/write_text_file — fs delegation did not happen')
  } else if (!existsSync(targetPath)) {
    fail('fs/write_text_file was used but the file does not exist afterwards')
  } else {
    const disk = readFileSync(targetPath, 'utf8')
    const contentOk = disk.trim() === expectedContent.trim()
    console.log(`fs/write_text_file requests: ${fsWrites.length}`)
    console.log(`file content matches: ${contentOk}`)
    if (!contentOk) fail(`content mismatch: ${JSON.stringify(disk)}`)
    else {
      console.log('PASS: fs delegation round-trip works end to end')
    }
  }
} catch (err) {
  fail(String(err?.message ?? err))
} finally {
  if (!finished) {
    finished = true
    setTimeout(() => child.kill('SIGTERM'), 50)
  }
}
