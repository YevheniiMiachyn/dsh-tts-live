/**
 * Host-wiring integration test for live sentence-level TTS flush.
 *
 * Loads the real plugin (`apply` from lib/index.js) under a fake Cordis context,
 * drives one live assistant generation through the registered
 * `agent/assistant-stream` listener, and reads the audio back out of the real
 * HTTP route handlers. Still inference-free: `globalThis.fetch` is stubbed, so
 * no TTS server and no model are involved.
 *
 * What this catches that test/live.test.mjs cannot: the actual wiring — config
 * schema defaults, listener registration, queue reservation/settlement, the
 * durable `assistant/message` dedup, and cancel/barge-in through the queue.
 *
 * Synthesis is asynchronous (credential lookup, then the provider chain), so
 * every assertion about `calls` waits a tick first.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'

import { apply, name } from '../lib/index.js'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tts-wiring-'))

/** Minimal Cordis context capturing registrations. */
function makeCtx() {
  const listeners = new Map()
  const routes = new Map()
  const ctx = {
    _tool: null,
    logger: { warn() {}, info() {}, error() {} },
    credentials: {
      resolve: async () => ({ value: 'local' }),
      describe: async () => ({ configured: true, writable: true }),
      set: async () => {},
      unset: async () => {},
    },
    llm: { stream: async function* () {} },
    tools: { register: (tool) => { ctx._tool = tool } },
    webServer: { register: (route) => { routes.set(route.path, route); return () => {} } },
    on: (event, cb) => {
      const arr = listeners.get(event) || []
      arr.push(cb)
      listeners.set(event, arr)
      return () => {}
    },
    effect: (fn) => { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
    inject: (deps, cb) => {
      if (deps.includes('settings')) {
        cb({
          settings: { register: () => ({ get: () => undefined }) },
          effect: ctx.effect,
        })
      }
      return () => {}
    },
  }
  return { ctx, listeners, routes }
}

/** Minimal response stub for writeJson. */
function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}) },
    setHeader(k, v) { this.headers[k] = v },
    end(chunk) { if (chunk !== undefined) this.body += chunk },
  }
}

/** Request stub with a real event stream, because readBody() listens for data/end. */
function makeReq(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:3080' }
  req.socket = { remoteAddress: '127.0.0.1' }
  req.destroy = () => {}
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

const WAV_BYTES = Buffer.from('RIFF....WAVEfmt ')

function stubFetch() {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      body: init && init.body ? JSON.parse(init.body) : undefined,
      headers: init && init.headers,
      signal: init && init.signal,
    })
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => WAV_BYTES.buffer.slice(WAV_BYTES.byteOffset, WAV_BYTES.byteOffset + WAV_BYTES.length),
    }
  }
  return calls
}

const config = (over = {}) => ({
  speakReplies: true,
  liveSentenceStreaming: true,
  liveMinCharsFirst: 12,
  liveMinChars: 48,
  livePollMs: 150,
  cache: false,
  streamingEnabled: false,
  skipCode: true,
  language: 'en',
  sentenceChars: 320,
  timeoutMs: 2000,
  customBaseUrl: 'http://127.0.0.1:18080/v1',
  customKeyEnv: 'CUSTOM_TTS_API_KEY',
  chain: [{ provider: 'custom', model: 'qwen3-tts-akeno', voice: 'akeno' }],
  pronunciation: [],
  enableItDictionary: false,
  ...over,
})

const SESSION = 'sess-wiring'
const agent = { session: { id: SESSION } }
const framePayload = (frame) => ({ agent, frame })

/** Let the async synthesis chain (credential -> provider -> fetch) run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 40))

async function call(route, req, res = makeRes()) {
  await route.handler(req, res)
  return res
}

async function pending(routes) {
  const res = await call(routes.get('/dsh-tts/pending'), makeReq('GET', '/dsh-tts/pending'))
  return JSON.parse(res.body)
}

async function bargeIn(routes, body = '{}') {
  const res = await call(routes.get('/dsh-tts/bargein'), makeReq('POST', '/dsh-tts/bargein', body))
  return { status: res.statusCode, json: JSON.parse(res.body) }
}

test('plugin registers the live routes, the stream listener, and the tool', () => {
  const { ctx, listeners, routes } = makeCtx()
  apply(ctx, config())
  assert.equal(name, '@goodandready/dsh-tts')
  for (const p of ['/dsh-tts/status', '/dsh-tts/pending', '/dsh-tts/speak', '/dsh-tts/bargein']) {
    assert.ok(routes.has(p), `missing route ${p}`)
  }
  assert.ok(listeners.has('agent/assistant-stream'), 'live stream listener is registered')
  assert.ok(listeners.has('session/event'), 'durable listener is registered')
  assert.ok(ctx._tool && ctx._tool.name === 'speak_text', 'speak_text tool still registers')
})

test('/status advertises live options so the browser can shorten its poll', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx, config())
  const res = await call(routes.get('/dsh-tts/status'), makeReq('GET', '/dsh-tts/status'))
  const json = JSON.parse(res.body)
  assert.equal(json.live.enabled, true)
  assert.equal(json.live.pollMs, 150)
  assert.equal(json.streamingEnabled, false, 'live mode does not need audio SSE streaming')
})

test('a live sentence reaches the pending queue while the model is still generating', async () => {
  const { ctx, listeners, routes } = makeCtx()
  const calls = stubFetch()
  apply(ctx, config())
  const onFrame = listeners.get('agent/assistant-stream')[0]

  const attemptId = 'attempt-1'
  onFrame(framePayload({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 }))
  onFrame(framePayload({ type: 'chunk', attemptId, revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: 'First sentence is ready. Second one' } }))

  await tick()
  assert.equal(calls.length, 1, 'synthesis starts on the first complete sentence')
  assert.equal(calls[0].body.response_format, 'wav', 'production WAV patch is still in force')
  assert.equal(calls[0].body.input, 'First sentence is ready.')
  assert.equal(calls[0].body.voice, 'akeno')

  const items = (await pending(routes)).items.filter((i) => i.kind === 'speech')
  assert.equal(items.length, 1)
  assert.equal(items[0].text, 'First sentence is ready.')
  assert.equal(items[0].mime, 'audio/wav')
  assert.ok(items[0].audioBase64.length > 0)
  assert.equal(items[0].sessionId, SESSION)
})

test('the settled assistant message never re-speaks what the stream already spoke', async () => {
  const { ctx, listeners, routes } = makeCtx()
  const calls = stubFetch()
  apply(ctx, config())
  const onFrame = listeners.get('agent/assistant-stream')[0]
  const onSession = listeners.get('session/event')[0]

  const attemptId = 'attempt-dup'
  const full = 'Alpha sentence here. Beta sentence here.'
  onFrame(framePayload({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 }))
  onFrame(framePayload({ type: 'chunk', attemptId, revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: full } }))
  onFrame(framePayload({ type: 'chunk', attemptId, revision: 3, index: 1, time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }))
  await tick()
  const afterStream = calls.length
  assert.equal(afterStream, 2, 'both sentences were synthesized from the live stream')

  onSession(
    { id: SESSION },
    {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: full }] } },
    },
  )
  await tick()
  assert.equal(calls.length, afterStream, 'durable settlement adds no synthesis: nothing is replayed')
})

test('text that arrives after the last cut is spoken exactly once as the remainder', async () => {
  const { ctx, listeners } = makeCtx()
  const calls = stubFetch()
  apply(ctx, config())
  const onFrame = listeners.get('agent/assistant-stream')[0]
  const onSession = listeners.get('session/event')[0]

  const attemptId = 'attempt-tail'
  const full = 'Flushed immediately here. And the remaining tail'
  onFrame(framePayload({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 }))
  onFrame(framePayload({ type: 'chunk', attemptId, revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: full } }))
  await tick()
  assert.deepEqual(calls.map((c) => c.body.input), ['Flushed immediately here.'])

  onSession(
    { id: SESSION },
    {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: full }] } },
    },
  )
  await tick()
  assert.deepEqual(calls.map((c) => c.body.input), ['Flushed immediately here.', 'And the remaining tail'])
})

test('a turn that never streamed still speaks through the durable path', async () => {
  const { ctx, listeners } = makeCtx()
  const calls = stubFetch()
  apply(ctx, config())
  const onSession = listeners.get('session/event')[0]
  onSession(
    { id: SESSION },
    {
      type: 'assistant/message',
      data: { turn: 9, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Fallback path still speaks this.' }] } },
    },
  )
  await tick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].body.input, 'Fallback path still speaks this.')
})

test('live mode off reproduces upstream message-level behaviour', async () => {
  const { ctx, listeners } = makeCtx()
  const calls = stubFetch()
  apply(ctx, config({ liveSentenceStreaming: false }))
  const onFrame = listeners.get('agent/assistant-stream')[0]
  const onSession = listeners.get('session/event')[0]

  const attemptId = 'attempt-off'
  onFrame(framePayload({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 }))
  onFrame(framePayload({ type: 'chunk', attemptId, revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: 'Nothing should stream here. At all.' } }))
  await tick()
  assert.equal(calls.length, 0, 'no synthesis before settlement')

  onSession(
    { id: SESSION },
    {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Nothing should stream here. At all.' }] } },
    },
  )
  await tick()
  assert.equal(calls.length, 1, 'the durable path speaks the whole message')
  assert.equal(calls[0].body.input, 'Nothing should stream here. At all.')
})

test('an aborted live generation is cancelled and cannot speak after the cancel', async () => {
  const { ctx, listeners, routes } = makeCtx()
  const calls = stubFetch()
  apply(ctx, config())
  const onFrame = listeners.get('agent/assistant-stream')[0]

  const attemptId = 'attempt-abort'
  onFrame(framePayload({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 }))
  onFrame(framePayload({ type: 'chunk', attemptId, revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: 'This sentence is long enough. ' } }))
  await tick()
  assert.equal(calls.length, 1)

  onFrame(framePayload({ type: 'end', attemptId, revision: 9, index: 9, outcome: { kind: 'abandoned' } }))
  await tick()
  const items = (await pending(routes)).items.filter((i) => i.kind === 'speech')
  assert.equal(items.length, 0, 'the cancelled piece never becomes speakable')
})

test('barge-in empties the pending queue and reports it', async () => {
  const { ctx, listeners, routes } = makeCtx()
  stubFetch()
  apply(ctx, config())
  const onFrame = listeners.get('agent/assistant-stream')[0]
  const attemptId = 'attempt-barge'
  onFrame(framePayload({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 }))
  onFrame(framePayload({ type: 'chunk', attemptId, revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: 'Please stop talking now. ' } }))
  await tick()
  assert.equal((await pending(routes)).items.length, 1)

  const result = await bargeIn(routes)
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal((await pending(routes)).items.length, 0)
})

test('the synthesis cache is inert for live pieces, so repeats are not skipped as duplicates', async () => {
  const { ctx, listeners } = makeCtx()
  const calls = stubFetch()
  apply(ctx, config({ cache: true }))
  const onFrame = listeners.get('agent/assistant-stream')[0]
  const attemptId = 'attempt-cache'
  onFrame(framePayload({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 }))
  onFrame(framePayload({ type: 'chunk', attemptId, revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: 'Repeat me please. ' } }))
  await tick()
  assert.equal(calls.length, 1)
})
