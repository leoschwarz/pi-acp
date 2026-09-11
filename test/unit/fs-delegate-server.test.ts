import test from 'node:test'
import assert from 'node:assert/strict'
import * as net from 'node:net'
import { once } from 'node:events'
import { FS_DELEGATE_PROTOCOL_VERSION, FsDelegateServer } from '../../src/pi-rpc/delegate-server.js'

type TestServer = {
  server: FsDelegateServer
  close: () => void
}

async function startServer(): Promise<TestServer> {
  const server = await FsDelegateServer.create()
  return { server, close: () => server.dispose() }
}

/**
 * Continuous line reader for a socket: buffers all incoming data so reading
 * several responses never loses bytes between reads.
 */
function lineReader(socket: net.Socket): () => Promise<any> {
  let buffer = ''
  const pending: Array<{ resolve: (v: any) => void; reject: (err: Error) => void }> = []
  const lines: string[] = []

  const pump = () => {
    while (lines.length && pending.length) {
      const p = pending.shift()!
      p.resolve(JSON.parse(lines.shift()!))
    }
  }

  socket.on('data', chunk => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const nl = buffer.indexOf('\n')
      if (nl === -1) break
      lines.push(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
    }
    pump()
  })
  socket.on('error', err => {
    for (const p of pending.splice(0)) p.reject(err)
  })

  return () =>
    new Promise((resolve, reject) => {
      pending.push({ resolve, reject })
      pump()
    })
}

async function connect(
  token: string,
  socketPath: string
): Promise<{ socket: net.Socket; readLine: () => Promise<any> }> {
  const socket = net.connect(socketPath)
  await once(socket, 'connect')
  const readLine = lineReader(socket)
  socket.write(JSON.stringify({ v: FS_DELEGATE_PROTOCOL_VERSION, token }) + '\n')
  return { socket, readLine }
}

test('FsDelegateServer: ping round-trip with token auth', async () => {
  const { server, close } = await startServer()
  try {
    server.setHandler(async req => ({ id: req.id, ok: true }))

    const { socket, readLine } = await connect(server.token, server.socketPath)
    const ack = await readLine()
    assert.deepEqual(ack, { ok: true, hello: true })

    socket.write(JSON.stringify({ id: 'r1', op: 'ping' }) + '\n')
    const res = await readLine()
    assert.deepEqual(res, { id: 'r1', ok: true })

    socket.destroy()
  } finally {
    close()
  }
})

test('FsDelegateServer: rejects wrong token and bad protocol version', async () => {
  const { server, close } = await startServer()
  try {
    const badToken = net.connect(server.socketPath)
    try {
      await once(badToken, 'connect')
      badToken.write(JSON.stringify({ v: FS_DELEGATE_PROTOCOL_VERSION, token: 'wrong' }) + '\n')
      const closed = once(badToken, 'close')
      const gotData = await Promise.race([lineReader(badToken)().then(() => true), closed.then(() => false)])
      assert.equal(gotData, false)
    } finally {
      badToken.destroy()
    }

    const badVersion = net.connect(server.socketPath)
    try {
      await once(badVersion, 'connect')
      badVersion.write(JSON.stringify({ v: 99, token: server.token }) + '\n')
      const closed2 = once(badVersion, 'close')
      const gotData2 = await Promise.race([lineReader(badVersion)().then(() => true), closed2.then(() => false)])
      assert.equal(gotData2, false)
    } finally {
      badVersion.destroy()
    }
  } finally {
    close()
  }
})

test('FsDelegateServer: error response when no handler attached', async () => {
  const { server, close } = await startServer()
  try {
    const { socket, readLine } = await connect(server.token, server.socketPath)
    await readLine() // hello ack

    socket.write(JSON.stringify({ id: 'r1', op: 'read', path: '/tmp/x' }) + '\n')
    const res = await readLine()
    assert.equal(res.ok, false)
    assert.match(String(res.error), /no session attached/)
    socket.destroy()
  } finally {
    close()
  }
})

test('FsDelegateServer: forwards read/write to the handler with payload', async () => {
  const { server, close } = await startServer()
  const seen: any[] = []
  try {
    server.setHandler(async req => {
      seen.push({ ...req })
      if (req.op === 'read') return { id: req.id, ok: true, content: 'file content' }
      return { id: req.id, ok: true }
    })

    const { socket, readLine } = await connect(server.token, server.socketPath)
    await readLine()

    socket.write(JSON.stringify({ id: 'a', op: 'read', path: '/abs/a.txt' }) + '\n')
    socket.write(JSON.stringify({ id: 'b', op: 'write', path: '/abs/b.txt', content: 'hi' }) + '\n')

    const resA = await readLine()
    assert.deepEqual(resA, { id: 'a', ok: true, content: 'file content' })
    const resB = await readLine()
    assert.deepEqual(resB, { id: 'b', ok: true })

    assert.deepEqual(seen[0], { id: 'a', op: 'read', path: '/abs/a.txt' })
    assert.deepEqual(seen[1], { id: 'b', op: 'write', path: '/abs/b.txt', content: 'hi' })
    socket.destroy()
  } finally {
    close()
  }
})

test('FsDelegateServer: handler errors become ok:false responses', async () => {
  const { server, close } = await startServer()
  try {
    server.setHandler(async () => {
      throw new Error('zed exploded')
    })

    const { socket, readLine } = await connect(server.token, server.socketPath)
    await readLine()

    socket.write(JSON.stringify({ id: 'x', op: 'write', path: '/p', content: '' }) + '\n')
    const res = await readLine()
    assert.equal(res.ok, false)
    assert.match(String(res.error), /zed exploded/)
    socket.destroy()
  } finally {
    close()
  }
})

test('FsDelegateServer: cancel aborts the in-flight handler signal', async () => {
  const { server, close } = await startServer()
  try {
    let abortSignal: AbortSignal | null = null
    server.setHandler(
      (req, signal) =>
        new Promise(resolve => {
          abortSignal = signal
          signal.addEventListener('abort', () => resolve({ id: req.id, ok: false, error: 'aborted' }))
        })
    )

    const { socket, readLine } = await connect(server.token, server.socketPath)
    await readLine()

    socket.write(JSON.stringify({ id: 'slow', op: 'write', path: '/p', content: 'x' }) + '\n')
    await new Promise(r => setTimeout(r, 20))
    assert.equal(abortSignal!.aborted, false)

    socket.write(JSON.stringify({ type: 'cancel', id: 'slow' }) + '\n')
    await new Promise(r => setTimeout(r, 20))
    // The handler observed the abort; the server suppresses the superseded
    // response (the extension already rejected its own promise on cancel).
    assert.equal(abortSignal!.aborted, true)
    socket.destroy()
  } finally {
    close()
  }
})

test('FsDelegateServer: dispose closes sockets and the listener', async () => {
  const { server, close } = await startServer()
  const { socket } = await connect(server.token, server.socketPath)

  close()
  await once(socket, 'close')

  // Server no longer accepts new connections (connect fails or is reset).
  const after = net.connect(server.socketPath)
  const outcome = await new Promise<string>(resolve => {
    const cleanup = () => {
      after.off('connect', onConnect)
      after.off('error', onError)
    }
    const onConnect = () => {
      cleanup()
      resolve('connect')
    }
    const onError = () => {
      cleanup()
      resolve('error')
    }
    after.once('connect', onConnect)
    after.once('error', onError)
  })
  assert.equal(outcome, 'error')
  after.destroy()
})
