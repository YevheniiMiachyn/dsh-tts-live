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
    _tools: [],
    logger: { warn() {}, info() {}, error() {} },
    credentials: {
      resolve: async () => ({ value: 'local' }),
      describe: async () => ({ configured: true, writable: true }),
      set: async () => {},
      unset: async () => {},
    },
    llm: { stream: async function* () {} },
    tools: { register: (tool) => { ctx._tool = tool; ctx._tools.push(tool) } },
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
  // 0.4.16-local.6 adds a second tool (silent-mode control), so "the last tool
  // registered" is no longer the interesting assertion — both are.
  assert.deepEqual(ctx._tools.map((t) => t.name).sort(), ['set_speech_output', 'speak_text'],
    'both tools register')
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

// --- piece ownership metadata (0.4.16-local.2) --------------------------------
// A queue consumer must be able to attribute a piece to the generation that
// produced it. CONTROL speaks at turn/end and its synthesis lags a whole turn
// behind, so arrival-time inference is wrong by construction.

/** fetch stub whose response is held open until `release()`. */
function stubFetchHeld() {
  const gates = []
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : undefined })
    await new Promise((resolve) => gates.push(resolve))
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => WAV_BYTES.buffer.slice(WAV_BYTES.byteOffset, WAV_BYTES.byteOffset + WAV_BYTES.length),
    }
  }
  return { calls, release: () => { while (gates.length) gates.shift()() } }
}

/** GET /dsh-tts/pending?after=<id> */
async function pendingAfter(routes, id) {
  const res = await call(routes.get('/dsh-tts/pending'), makeReq('GET', `/dsh-tts/pending?after=${encodeURIComponent(id)}`))
  return JSON.parse(res.body).items
}

test('a live piece carries the exact turn and step that produced it', async () => {
  const { ctx, listeners, routes } = makeCtx()
  stubFetch()
  apply(ctx, config())
  const onFrame = listeners.get('agent/assistant-stream')[0]
  const attemptId = 'attempt-meta-live'
  onFrame(framePayload({ type: 'start', attemptId, revision: 1, turn: 4, step: 2 }))
  onFrame(framePayload({ type: 'chunk', attemptId, revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: 'Ownership travels with me. ' } }))
  await tick()
  const items = (await pending(routes)).items
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'speech')
  assert.equal(items[0].turn, 4, 'live piece knows its turn')
  assert.equal(items[0].step, 2, 'live piece knows its step')
  assert.equal(items[0].sessionId, SESSION)
})

test('ownership survives the reserved -> settled transition', async () => {
  const { ctx, listeners, routes } = makeCtx()
  const held = stubFetchHeld()
  apply(ctx, config())
  const onFrame = listeners.get('agent/assistant-stream')[0]
  const attemptId = 'attempt-meta-reserved'
  onFrame(framePayload({ type: 'start', attemptId, revision: 1, turn: 7, step: 3 }))
  onFrame(framePayload({ type: 'chunk', attemptId, revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: 'Reserved first, settled later. ' } }))
  await tick()
  assert.equal(held.calls.length, 1, 'synthesis is in flight')

  const early = (await pending(routes)).items
  assert.equal(early.length, 1)
  assert.equal(early[0].kind, 'reserved', 'observed while synthesis is still running')
  assert.equal(early[0].turn, 7, 'the reservation already records the owner')
  assert.equal(early[0].step, 3)
  assert.equal(early[0].text, undefined, 'a reserved slot carries no text yet')

  held.release()
  await tick()
  const late = (await pending(routes)).items
  assert.equal(late[0].kind, 'speech')
  assert.equal(late[0].id, early[0].id, 'the id is stable across the transition')
  assert.equal(late[0].turn, 7, 'settlement inherits the reservation owner')
  assert.equal(late[0].step, 3)
})

test('CONTROL pieces are owned by the exact turn and step that produced them', async () => {
  // `speakAsItGoes: true` is what BOTH benchmark arms actually run, so CONTROL
  // speaks each assistant/message as it lands — it is message-level, not
  // turn-level, and every piece therefore knows its own step.
  const { ctx, listeners, routes } = makeCtx()
  stubFetch()
  apply(ctx, config({ liveSentenceStreaming: false, speakAsItGoes: true }))
  const onSession = listeners.get('session/event')[0]
  const msg = (turn, step, text) => onSession(
    { id: SESSION },
    { type: 'assistant/message', data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] } } },
  )

  msg(5, 1, 'First control sentence.')
  await tick()
  msg(6, 1, 'Second control sentence.')
  await tick()

  const items = (await pending(routes)).items
  assert.equal(items.length, 2)
  assert.equal(items[0].turn, 5, 'the first piece is owned by turn 5')
  assert.equal(items[0].step, 1)
  assert.equal(items[1].turn, 6, 'the next piece is owned by turn 6, not by arrival order')
  assert.equal(items[1].step, 1)
})

test('the turn-collecting path records the turn and its contributing steps', async () => {
  // The upstream non-speak-as-it-goes mode: text accumulates and is spoken once
  // at turn end. Several steps are joined and split as one body, so a per-piece
  // step would be invented precision — the owner is the turn, and the
  // contributing steps are reported alongside it.
  const { ctx, listeners, routes } = makeCtx()
  stubFetch()
  apply(ctx, config({ liveSentenceStreaming: false, speakAsItGoes: false }))
  const onSession = listeners.get('session/event')[0]
  const msg = (turn, step, text) => onSession(
    { id: SESSION },
    { type: 'assistant/message', data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] } } },
  )

  // Upstream merges consecutive sentences until a piece reaches `min` (60 chars
  // for the 320-char limit), so realistic benchmark-length sentences are needed
  // to exercise more than one piece.
  msg(5, 1, 'The first control sentence is deliberately long enough to stand alone as its own piece.')
  msg(5, 2, 'The second control sentence is also long enough to be spoken separately by the queue.')
  assert.equal((await pending(routes)).items.length, 0, 'nothing is queued before turn end')

  onSession({ id: SESSION }, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
  await tick()
  const items = (await pending(routes)).items
  assert.equal(items.length, 2, 'the joined body is split into its two sentences')
  for (const item of items) {
    assert.equal(item.turn, 5, 'the pieces are owned by the turn')
    assert.equal(item.step, null, 'a joined multi-step body has no single step')
    assert.deepEqual(item.steps, [1, 2], 'contributing steps are reported instead')
  }
  assert.ok(items[0].text.includes('first control sentence'), 'the first step text is spoken first')
  assert.ok(items[1].text.includes('second control sentence'), 'the second step text follows')
})

test('a non-conversational notice is not attributed to any turn', async () => {
  const { ctx, listeners, routes } = makeCtx()
  stubFetch()
  apply(ctx, config({ announceApproval: true }))
  const onSession = listeners.get('session/event')[0]
  onSession({ id: SESSION }, { type: 'approval/asked', data: { toolName: 'shell' } })
  await tick()
  const notice = (await pending(routes)).items.find((i) => i.kind === 'notice')
  assert.ok(notice, 'the approval announcement is queued')
  assert.equal(notice.turn, null, 'an announcement belongs to no turn')
  assert.equal(notice.step, null)
})

test('every queue row has the same ownership shape, and polling twice does not churn it', async () => {
  const { ctx, listeners, routes } = makeCtx()
  stubFetch()
  apply(ctx, config())
  const onFrame = listeners.get('agent/assistant-stream')[0]
  const attemptId = 'attempt-shape'
  onFrame(framePayload({ type: 'start', attemptId, revision: 1, turn: 2, step: 1 }))
  onFrame(framePayload({ type: 'chunk', attemptId, revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: 'Shape check sentence. ' } }))
  await tick()

  const first = (await pending(routes)).items
  for (const row of first) {
    for (const key of ['turn', 'step', 'steps']) {
      assert.ok(key in row, `row is missing ${key}`)
    }
  }
  const second = (await pending(routes)).items
  assert.deepEqual(second, first, 'a duplicate poll returns the identical row, not a new observation')
  assert.deepEqual(await pendingAfter(routes, first[first.length - 1].id), [], 'after= advances past the settled tail')
  assert.deepEqual(
    (await pendingAfter(routes, 'u0')).map((i) => i.id),
    first.map((i) => i.id),
    'an unknown cursor does not skip rows',
  )
})

test('/status exposes queue state for a drain barrier', async () => {
  const { ctx, listeners, routes } = makeCtx()
  const held = stubFetchHeld()
  apply(ctx, config())
  const onFrame = listeners.get('agent/assistant-stream')[0]
  const attemptId = 'attempt-queue'
  onFrame(framePayload({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 }))
  onFrame(framePayload({ type: 'chunk', attemptId, revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: 'Draining takes real state. ' } }))
  await tick()

  const during = JSON.parse((await call(routes.get('/dsh-tts/status'), makeReq('GET', '/dsh-tts/status'))).body).queue
  assert.equal(during.reserved, 1, 'one slot is reserved while synthesis runs')
  assert.equal(during.inFlight, 1, 'in-flight synthesis is reported')

  held.release()
  await tick()
  const after = JSON.parse((await call(routes.get('/dsh-tts/status'), makeReq('GET', '/dsh-tts/status'))).body).queue
  assert.equal(after.reserved, 0, 'nothing stays reserved once synthesis settles')
  assert.equal(after.inFlight, 0, 'in-flight count returns to zero')
  assert.equal(after.settled, 1)
})
