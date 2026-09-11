import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyEditsToNormalizedContent,
  default as piFsDelegate,
  detectSupportedImageMimeType,
  generateDiffString,
  normalizeForFuzzyMatch,
  truncateHead
} from '../../src/extension/pi-fs-delegate.js'
import {
  FS_DELEGATE_ENV_READ,
  FS_DELEGATE_ENV_SOCKET,
  FS_DELEGATE_ENV_TOKEN,
  FS_DELEGATE_ENV_WRITE
} from '../../src/pi-rpc/delegate-server.js'

// ---------------------------------------------------------------------------
// Edit engine (ported from pi's built-in edit tool)
// ---------------------------------------------------------------------------

test('applyEditsToNormalizedContent: exact single replacement', () => {
  const { baseContent, newContent } = applyEditsToNormalizedContent(
    'hello world\nsecond line\n',
    [{ oldText: 'world', newText: 'there' }],
    'f.txt'
  )
  assert.equal(baseContent, 'hello world\nsecond line\n')
  assert.equal(newContent, 'hello there\nsecond line\n')
})

test('applyEditsToNormalizedContent: multiple disjoint edits', () => {
  const { newContent } = applyEditsToNormalizedContent(
    'aaa\nbbb\nccc\n',
    [
      { oldText: 'aaa', newText: 'AAA' },
      { oldText: 'ccc', newText: 'CCC' }
    ],
    'f.txt'
  )
  assert.equal(newContent, 'AAA\nbbb\nCCC\n')
})

test('applyEditsToNormalizedContent: CRLF is normalized in, restored out by caller', () => {
  // The tool executes on LF-normalized content; CRLF restore is done by the caller.
  const { newContent } = applyEditsToNormalizedContent(
    'a\r\nb\r\n'.replace(/\r\n/g, '\n'),
    [{ oldText: 'b', newText: 'B' }],
    'f.txt'
  )
  assert.equal(newContent, 'a\nB\n')
})

test('applyEditsToNormalizedContent: fuzzy match (trailing whitespace)', () => {
  const content = 'keep  this\nchange me  \nkeep that\n'
  const { newContent } = applyEditsToNormalizedContent(content, [{ oldText: 'change me', newText: 'CHANGED' }], 'f.txt')
  // Only the matched span is replaced; unchanged bytes (including the original
  // line's trailing whitespace) are preserved — same as pi's built-in edit.
  assert.equal(newContent, 'keep  this\nCHANGED  \nkeep that\n')
})

test('applyEditsToNormalizedContent: not found throws with pi error text', () => {
  assert.throws(
    () => applyEditsToNormalizedContent('abc', [{ oldText: 'nope', newText: 'x' }], 'f.txt'),
    /Could not find the exact text in f\.txt/
  )
})

test('applyEditsToNormalizedContent: duplicate oldText throws', () => {
  assert.throws(
    () => applyEditsToNormalizedContent('dup\ndup', [{ oldText: 'dup', newText: 'x' }], 'f.txt'),
    /Found 2 occurrences/
  )
})

test('applyEditsToNormalizedContent: empty oldText throws', () => {
  assert.throws(
    () => applyEditsToNormalizedContent('abc', [{ oldText: '', newText: 'x' }], 'f.txt'),
    /oldText must not be empty in f\.txt/
  )
})

test('applyEditsToNormalizedContent: no-op replacement throws', () => {
  assert.throws(
    () => applyEditsToNormalizedContent('abc', [{ oldText: 'abc', newText: 'abc' }], 'f.txt'),
    /No changes made to f\.txt/
  )
})

test('applyEditsToNormalizedContent: overlapping edits throw', () => {
  assert.throws(
    () =>
      applyEditsToNormalizedContent(
        'abcdef',
        [
          { oldText: 'abcd', newText: '1' },
          { oldText: 'cdef', newText: '2' }
        ],
        'f.txt'
      ),
    /overlap in f\.txt/
  )
})

test('normalizeForFuzzyMatch: smart quotes, dashes, spaces, trailing whitespace', () => {
  assert.equal(normalizeForFuzzyMatch('“x” — a\u00A0b  \n'), '"x" - a b\n')
})

// ---------------------------------------------------------------------------
// Diff + truncation
// ---------------------------------------------------------------------------

test('generateDiffString: numbered +/- lines', () => {
  const diff = generateDiffString('a\nb\nc\n', 'a\nB\nc\n')
  assert.ok(diff.includes('-2 b'))
  assert.ok(diff.includes('+2 B'))
})

test('truncateHead: no truncation below limits', () => {
  const res = truncateHead('one\ntwo\n')
  assert.equal(res.truncated, false)
  assert.equal(res.totalLines, 2)
  assert.equal(res.content, 'one\ntwo\n')
})

test('truncateHead: line limit', () => {
  const res = truncateHead(Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n'), { maxLines: 10 })
  assert.equal(res.truncated, true)
  assert.equal(res.truncatedBy, 'lines')
  assert.equal(res.outputLines, 10)
})

test('truncateHead: byte limit and first-line overflow', () => {
  const res = truncateHead('x'.repeat(100) + '\nsmall\n', { maxBytes: 10 })
  assert.equal(res.truncated, true)
  assert.equal(res.truncatedBy, 'bytes')
  assert.equal(res.outputLines, 0)

  const res2 = truncateHead('ok\n' + 'y'.repeat(100), { maxBytes: 20 })
  assert.equal(res2.truncated, true)
  assert.equal(res2.content, 'ok')
})

// ---------------------------------------------------------------------------
// Image sniffing
// ---------------------------------------------------------------------------

test('detectSupportedImageMimeType: magic bytes', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  assert.equal(detectSupportedImageMimeType(png), 'image/png')

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  assert.equal(detectSupportedImageMimeType(jpeg), 'image/jpeg')

  const gif = Buffer.from('GIF89a', 'ascii')
  assert.equal(detectSupportedImageMimeType(gif), 'image/gif')

  const webp = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii')])
  assert.equal(detectSupportedImageMimeType(webp), 'image/webp')

  assert.equal(detectSupportedImageMimeType(Buffer.from('just text')), null)
})

// ---------------------------------------------------------------------------
// Extension registration (default export)
// ---------------------------------------------------------------------------

type RegisteredTool = { name: string }

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {}
  for (const key of Object.keys(vars)) saved[key] = process.env[key]
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('piFsDelegate: registers nothing without env vars', () => {
  const registered: RegisteredTool[] = []
  withEnv(
    {
      [FS_DELEGATE_ENV_SOCKET]: undefined,
      [FS_DELEGATE_ENV_TOKEN]: undefined
    },
    () => {
      piFsDelegate({ registerTool: tool => registered.push(tool as RegisteredTool) })
    }
  )
  assert.deepEqual(registered, [])
})

test('piFsDelegate: registers read+write+edit with both capabilities', () => {
  const registered: RegisteredTool[] = []
  withEnv(
    {
      [FS_DELEGATE_ENV_SOCKET]: '/tmp/s.sock',
      [FS_DELEGATE_ENV_TOKEN]: 'tok',
      [FS_DELEGATE_ENV_READ]: '1',
      [FS_DELEGATE_ENV_WRITE]: '1'
    },
    () => {
      piFsDelegate({ registerTool: tool => registered.push(tool as RegisteredTool) })
    }
  )
  assert.deepEqual(registered.map(t => t.name).sort(), ['edit', 'read', 'write'])
})

test('piFsDelegate: registers only write/edit without read capability', () => {
  const registered: RegisteredTool[] = []
  withEnv(
    {
      [FS_DELEGATE_ENV_SOCKET]: '/tmp/s.sock',
      [FS_DELEGATE_ENV_TOKEN]: 'tok',
      [FS_DELEGATE_ENV_READ]: '0',
      [FS_DELEGATE_ENV_WRITE]: '1'
    },
    () => {
      piFsDelegate({ registerTool: tool => registered.push(tool as RegisteredTool) })
    }
  )
  assert.deepEqual(registered.map(t => t.name).sort(), ['edit', 'write'])
})

test('piFsDelegate: registers nothing without any capability', () => {
  const registered: RegisteredTool[] = []
  withEnv(
    {
      [FS_DELEGATE_ENV_SOCKET]: '/tmp/s.sock',
      [FS_DELEGATE_ENV_TOKEN]: 'tok',
      [FS_DELEGATE_ENV_READ]: '0',
      [FS_DELEGATE_ENV_WRITE]: '0'
    },
    () => {
      piFsDelegate({ registerTool: tool => registered.push(tool as RegisteredTool) })
    }
  )
  assert.deepEqual(registered, [])
})

test('piFsDelegate: write tool delegates via the socket and reports fsDelegated details', async () => {
  const registered: RegisteredTool[] = []
  withEnv(
    {
      [FS_DELEGATE_ENV_SOCKET]: '/tmp/definitely-missing.sock',
      [FS_DELEGATE_ENV_TOKEN]: 'tok',
      [FS_DELEGATE_ENV_READ]: '1',
      [FS_DELEGATE_ENV_WRITE]: '1'
    },
    () => {
      piFsDelegate({ registerTool: tool => registered.push(tool as RegisteredTool) })
    }
  )

  const write = registered.find(t => t.name === 'write') as any
  assert.ok(write, 'write tool registered')
  // Schema sanity: same shape as pi's built-in write.
  assert.deepEqual(Object.keys(write.parameters.properties ?? {}), ['path', 'content'])
})
