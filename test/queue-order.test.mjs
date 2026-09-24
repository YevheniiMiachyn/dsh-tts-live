/**
 * Pending-queue ordering, eviction and loss (0.4.16-local.9).
 *
 * The live engine promises that the order pieces are handed to the queue is the
 * order they are spoken in — live.js:505, "the order of these calls is the order of
 * playback ... even when synthesis finishes out of order". Upstream's window cap
 * could break that promise: on overflow it evicted the oldest row, and when every
 * row was still `reserved` it took a RESERVED slot instead — the one thing the
 * promise depends on. The evicted row's synthesis then settled into the
 * missing-row path, which appended it at the tail.
 *
 * Measured live on 2026-09-23: 15 rows left the window inside ~2 s during one long
 * reply with the synthesis error counter unchanged — nothing aborted, nothing
 * failed — and the reply was heard as its first sentence followed by an unrelated
 * later part.
 *
 * The reproduction therefore needs the burst the live path really produces: one
 * streamed step carrying many sentences, so every piece is reserved before any
 * synthesis has finished. That is what a tool-call flush does to a long step, and
 * the harness below makes it deterministic by holding every response open and
 * settling them by hand.
 *
 * Run: node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'

import { apply } from '../lib/index.js'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tts-qorder-'))

/** Minimal Cordis context that keeps every registration addressable by name. */
function makeCtx() {
  const listeners = new Map()
  const routes = new Map()
  const tools = new Map()
  const warnings = []
  const ctx = {
    logger: { warn: (m) => warnings.push(String(m)), info() {}, error() {} },
    credentials: {
      resolve: async () => ({ value: 'local' }),
      describe: async () => ({ configured: true, writable: true }),
      set: async () => {},
      unset: async () => {},
    },
    llm: { stream: async function* () {} },
    tools: { register: (tool) => { tools.set(tool.name, tool) } },
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
        cb({ settings: { register: () => ({ get: () => undefined }) }, effect: ctx.effect })
      }
      return () => {}
    },
  }
  return { ctx, listeners, routes, tools, warnings }
}

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

function makeReq(method, url) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:3080' }
  req.socket = { remoteAddress: '127.0.0.1' }
  req.destroy = () => {}
  process.nextTick(() => req.emit('end'))
  return req
}

const WAV_BYTES = Buffer.from('RIFF....WAVEfmt ')

/**
 * A fetch stub whose responses are resolved BY HAND, so the harness owns the
 * order in which synthesis completes — which is the whole point of the test.
 */
function deferredFetch() {
  const inflight = []
  globalThis.fetch = (url, init) => new Promise((resolve) => {
    inflight.push({
      url: String(url),
      body: init && init.body ? JSON.parse(init.body) : undefined,
      resolve: () => resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => WAV_BYTES.buffer.slice(WAV_BYTES.byteOffset, WAV_BYTES.byteOffset + WAV_BYTES.length),
      }),
    })
  })
  return inflight
}

const config = (over = {}) => ({
  speakReplies: true,
  liveSentenceStreaming: true,
  liveMinCharsFirst: 5,
  liveMinChars: 5,
  liveMaxChars: 0,
  livePollMs: 150,
  liveFlushOnToolCall: true,
  skipCode: true,
  language: 'en',
  sentenceChars: 320,
  timeoutMs: 2000,
  cache: false,
  streamingEnabled: false,
  pronunciation: [],
  enableItDictionary: false,
  customBaseUrl: 'http://127.0.0.1:18080/v1',
  customKeyEnv: 'CUSTOM_TTS_API_KEY',
  chain: [{ provider: 'custom', model: 'qwen3-tts-akeno', voice: 'akeno' }],
  ...over,
})

const SESSION = 'sess-order'
const agent = { session: { id: SESSION } }
const framePayload = (frame) => ({ agent, frame })
const tick = () => new Promise((resolve) => setTimeout(resolve, 50))

// Eight sentences, each comfortably over liveMinChars, delivered in ONE delta and
// then flushed: eight reserves before a single synthesis can finish.
const EIGHT = 'Alpha one. Bravo two. Charlie three. Delta four. '
  + 'Echo five. Foxtrot six. Golf seven. Hotel eight.'

function driveBurst(listeners, { attemptId = 'a1', text = EIGHT, turn = 1, step = 1 } = {}) {
  const onFrame = listeners.get('agent/assistant-stream')[0]
  onFrame(framePayload({ type: 'start', attemptId, revision: 1, turn, step }))
  onFrame(framePayload({
    type: 'chunk', attemptId, revision: 2, index: 0, time: 0,
    chunk: { type: 'text-delta', index: 0, text },
  }))
  // Stream end: the engine flushes the unterminated tail, so the last sentence
  // becomes a piece too. Still the same synchronous burst.
  onFrame(framePayload({
    type: 'chunk', attemptId, revision: 3, index: 1, time: 0,
    chunk: { type: 'finish', reason: { kind: 'stop' } },
  }))
}

async function get(routes, routePath) {
  const res = makeRes()
  await routes.get(routePath).handler(makeReq('GET', routePath), res)
  return JSON.parse(res.body)
}

const ids = (items) => items.map((i) => i.id)
const nums = (items) => items.map((i) => Number(String(i.id).replace(/^u/, '')))

function assertAscending(items, label) {
  const n = nums(items)
  for (let i = 1; i < n.length; i++) {
    assert.ok(n[i] > n[i - 1], `${label}: playback order must ascend, got ${ids(items).join(',')}`)
  }
}

test('a burst larger than the window loses nothing and stays in order', async () => {
  const { ctx, listeners, routes } = makeCtx()
  const inflight = deferredFetch()
  apply(ctx, config({ maxQueue: 3 }))

  driveBurst(listeners)
  await tick()

  // Eight pieces reserved against a three-row window. Nothing has settled yet, so
  // every row is reserved — the exact state that used to make the cap evict a
  // reserved slot.
  const reserved = await get(routes, '/dsh-tts/pending')
  assert.equal(reserved.items.length, 8,
    `all eight reserves must survive the burst, got ${ids(reserved.items).join(',') || 'none'}`)
  assert.ok(reserved.items.every((i) => i.kind === 'reserved'), 'the burst must still be in flight')

  // Now let synthesis finish, in flight order.
  for (const call of inflight) call.resolve()
  await tick()
  await tick()

  const after = await get(routes, '/dsh-tts/pending')
  assert.equal(after.items.length, 8,
    `every piece must still be queued after settling, got ${ids(after.items).join(',')}`)
  assert.equal(new Set(ids(after.items)).size, 8, 'no duplicates')
  assertAscending(after.items, 'burst')

  const st = await get(routes, '/dsh-tts/stats')
  assert.equal(st.queueEvictions, 0, 'a window of reserved rows must never be evicted from')
})

test('the window cap still bounds a window of settled rows', async () => {
  const { ctx, listeners, routes } = makeCtx()
  const inflight = deferredFetch()
  apply(ctx, config({ maxQueue: 3 }))

  // Six sequential turns, each settling before the next is reserved, so the
  // window fills with settled rows and the cap has something legitimate to do.
  for (let turn = 1; turn <= 6; turn++) {
    driveBurst(listeners, { attemptId: `a${turn}`, text: `Sentence number ${turn} is right here.`, turn, step: 1 })
    await tick()
    while (inflight.length) inflight.shift().resolve()
    await tick()
  }

  const after = await get(routes, '/dsh-tts/pending')
  assert.ok(after.items.length <= 3, `cap must hold, got ${after.items.length} rows`)
  assertAscending(after.items, 'bounded window')

  const st = await get(routes, '/dsh-tts/stats')
  assert.ok(st.queueEvictions > 0, 'evicting a settled row must be counted, not silent')
})

test('eviction takes a settled row, never a reserved one', async () => {
  const { ctx, listeners, routes } = makeCtx()
  const inflight = deferredFetch()
  apply(ctx, config({ maxQueue: 3 }))

  driveBurst(listeners)
  await tick()
  const burst = await get(routes, '/dsh-tts/pending')
  const settledIds = ids(burst.items).slice(0, 4)  // the four that will finish
  const reservedIds = ids(burst.items).slice(4)    // the four that stay in flight
  while (inflight.length > 4) inflight.shift().resolve()
  await tick()

  // One more piece: the window is over the cap, so something must go.
  driveBurst(listeners, { attemptId: 'a2', text: 'One more sentence arrives here.', turn: 2, step: 1 })
  await tick()
  const after = await get(routes, '/dsh-tts/pending')

  for (const id of reservedIds) {
    assert.ok(ids(after.items).includes(id), `reserved row ${id} must never be evicted`)
  }
  assertAscending(after.items, 'after an eviction')

  // The cap drains settled rows until the window is back under it, and stops the
  // moment only reserved rows remain: 4 settled + 5 reserved against a cap of 3
  // means all 4 settled rows go and the 5 reserved ones keep the window at 5.
  assert.ok(after.items.every((i) => i.kind === 'reserved'),
    `only reserved rows may survive here, got ${after.items.map((i) => i.kind).join(',')}`)
  for (const id of settledIds) {
    assert.ok(!ids(after.items).includes(id), `settled row ${id} was the eviction's rightful target`)
  }

  const st = await get(routes, '/dsh-tts/stats')
  assert.equal(st.queueEvictions, 4, 'every settled row above the cap should have gone, none of the reserved')

  // Let the last reserved rows settle. Their synthesis is stubbed to hang, and the
  // provider only clears its 120 s abort timer in a `finally` — so leaving them
  // pending holds the event loop open for two minutes after this file has passed.
  for (const call of inflight) call.resolve()
  await tick()
})
