/**
 * The provider breaker must ignore cancellations (0.4.16-local.7).
 *
 * The defect, observed live: three in-flight syntheses were aborted — silent mode
 * runs the same hard stop as a barge-in — and each abort was recorded by the
 * provider breaker as a provider *failure*. Three of them opened the circuit for
 * a 60 s cooldown, so the stack went mute immediately after the user interrupted
 * it (or muted it), and `speak_text` answered "all providers failed (custom:
 * circuit open (cooldown))" while the TTS server was perfectly healthy.
 *
 * The distinction that matters: cancelling our own work is not the provider
 * failing. A real error or a timeout still is, and still must open the breaker —
 * both controls below fail if that protection is lost.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'

import { apply } from '../lib/index.js'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tts-breaker-'))

function makeCtx() {
  const listeners = new Map()
  const routes = new Map()
  const tools = new Map()
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    credentials: {
      resolve: async () => ({ value: 'local' }),
      describe: async () => ({ configured: true, writable: true }),
      set: async () => {},
      unset: async () => {},
    },
    llm: { stream: async function* () {} },
    tools: { register: (t) => { tools.set(t.name, t) } },
    webServer: { register: (r) => { routes.set(r.path, r); return () => {} } },
    on: (e, cb) => { const a = listeners.get(e) || []; a.push(cb); listeners.set(e, a); return () => {} },
    effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
    inject: (deps, cb) => {
      if (deps.includes('settings')) cb({ settings: { register: () => ({ get: () => undefined }) }, effect: ctx.effect })
      return () => {}
    },
  }
  return { ctx, listeners, routes, tools }
}

function makeRes() {
  return {
    statusCode: 0, headers: {}, body: '',
    writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}) },
    setHeader(k, v) { this.headers[k] = v },
    end(chunk) { if (chunk !== undefined) this.body += chunk },
  }
}

function makeReq(method, url, body) {
  const req = new EventEmitter()
  req.method = method; req.url = url
  req.headers = { host: '127.0.0.1:3080' }
  req.socket = { remoteAddress: '127.0.0.1' }
  req.destroy = () => {}
  process.nextTick(() => { if (body !== undefined) req.emit('data', Buffer.from(body)); req.emit('end') })
  return req
}

async function call(route, req) { const res = makeRes(); await route.handler(req, res); return res }
async function stats(routes) { return JSON.parse((await call(routes.get('/dsh-tts/stats'), makeReq('GET', '/dsh-tts/stats'))).body) }
async function pending(routes) { return JSON.parse((await call(routes.get('/dsh-tts/pending'), makeReq('GET', '/dsh-tts/pending'))).body) }
const breakerOf = (s) => (s.breaker || []).find((b) => b.id === 'custom') || { open: false, failCount: 0 }

const WAV_BYTES = Buffer.from('RIFF....WAVEfmt ')
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms))
const SESSION = 'sess-breaker'
const agent = { session: { id: SESSION } }
const framePayload = (frame) => ({ agent, frame })

/** One turn whose pieces all start synthesizing and never finish on their own. */
async function startTurn(listeners, text, attemptId = 'attempt-1', turn = 1) {
  const onFrame = listeners.get('agent/assistant-stream')[0]
  onFrame(framePayload({ type: 'start', attemptId, revision: 1, turn, step: 1 }))
  onFrame(framePayload({
    type: 'chunk', attemptId, revision: 2, index: 0, time: 0,
    chunk: { type: 'text-delta', index: 0, text },
  }))
  onFrame(framePayload({
    type: 'chunk', attemptId, revision: 3, index: 1, time: 0,
    chunk: { type: 'finish', reason: { kind: 'stop' } },
  }))
  await tick()
}

/**
 * fetch stub that honours the abort signal the way undici does — it rejects with
 * the signal's reason — and otherwise stays in flight forever. Without the abort
 * handling the plugin would never see a rejection and the defect could not show.
 */
function stubFetchHeldAbortable() {
  const calls = []
  globalThis.fetch = (url, init) => {
    const rec = { url: String(url), aborted: false, abortedWith: null }
    calls.push(rec)
    return new Promise((resolve, reject) => {
      const signal = init && init.signal
      const onAbort = () => {
        rec.aborted = true
        const reason = signal && signal.reason
        rec.abortedWith = reason instanceof Error ? reason.message : String(reason)
        reject(reason instanceof Error ? reason : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
      }
      if (!signal) return
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  return calls
}

/** fetch stub that resolves with real WAV bytes. */
function stubFetchOk() {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : undefined })
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => WAV_BYTES.buffer.slice(WAV_BYTES.byteOffset, WAV_BYTES.byteOffset + WAV_BYTES.length),
    }
  }
  return calls
}

/** fetch stub that fails the way an unreachable server does. */
function stubFetchFails(message = 'connect ECONNREFUSED 127.0.0.1:18080') {
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push({ url: String(url) })
    throw new Error(message)
  }
  return calls
}

/** fetch stub that hangs until the plugin's own timeout aborts it. */
function stubFetchHangs() {
  const calls = []
  globalThis.fetch = (url, init) => {
    const rec = { url: String(url), abortedWith: null }
    calls.push(rec)
    return new Promise((resolve, reject) => {
      const signal = init && init.signal
      if (!signal) return
      signal.addEventListener('abort', () => {
        const reason = signal.reason
        rec.abortedWith = reason instanceof Error ? reason.message : String(reason)
        reject(reason instanceof Error ? reason : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
      }, { once: true })
    })
  }
  return calls
}

const config = (over = {}) => ({
  speakReplies: true,
  liveSentenceStreaming: true,
  liveMinCharsFirst: 5,
  liveMinChars: 5,
  liveMaxChars: 0,
  livePollMs: 150,
  liveFlushOnToolCall: false,
  cache: false,
  streamingEnabled: false,
  skipCode: true,
  language: 'en',
  sentenceChars: 320,
  timeoutMs: 5000,
  customBaseUrl: 'http://127.0.0.1:18080/v1',
  customKeyEnv: 'CUSTOM_TTS_API_KEY',
  chain: [{ provider: 'custom', model: 'qwen3-tts-akeno', voice: 'akeno' }],
  pronunciation: [],
  enableItDictionary: false,
  ...over,
})

const setMuted = (tools, muted) => tools.get('set_speech_output').execute({ muted }, {})

test('cancelling in-flight synthesis does not trip the breaker (the live defect)', async () => {
  const { ctx, listeners, routes, tools } = makeCtx()
  const calls = stubFetchHeldAbortable()
  apply(ctx, config())

  await startTurn(listeners, 'Alpha is here. Beta is here. Gamma is here.')
  assert.ok(calls.length >= 3, `at least ${3} pieces must be in flight to reproduce, saw ${calls.length}`)
  assert.equal((await breakerOf(await stats(routes))).failCount, 0, 'nothing has failed yet')

  // Exactly what silent mode does, and what a barge-in does.
  await setMuted(tools, true)
  await tick()

  assert.equal(calls.filter((c) => c.aborted).length, calls.length, 'every in-flight piece was cancelled')
  const b = breakerOf(await stats(routes))
  assert.equal(b.failCount, 0, `cancellations must not be counted as provider failures (lastError: ${b.lastError})`)
  assert.equal(b.open, false, 'the circuit must stay closed: the provider was never at fault')

  // …and the very next request must go straight through. Note the new turn
  // number: the interrupted turn stays silenced on purpose (that is the barge-in
  // contract), so "speech works again" means the *following* reply.
  await setMuted(tools, false)
  const ok = stubFetchOk()
  await startTurn(listeners, 'Delta is here. Epsilon is here.', 'attempt-2', 2)
  assert.ok(ok.length >= 1, 'speech works immediately after a cancellation')
  const after = (await pending(routes)).items.filter((i) => i.kind === 'speech' && i.audioBase64)
  assert.ok(after.length >= 1, 'and the audio reached the queue')
})

test('control: real provider failures still open the breaker', async () => {
  const { ctx, listeners, routes } = makeCtx()
  const calls = stubFetchFails()
  apply(ctx, config())
  await startTurn(listeners, 'Alpha is here. Beta is here. Gamma is here.')
  await tick()
  assert.ok(calls.length >= 3)
  const b = breakerOf(await stats(routes))
  assert.equal(b.open, true, 'three genuine failures must still trip it')
  assert.ok(b.failCount >= 3)
  assert.match(b.lastError, /ECONNREFUSED/)
})

test('control: a provider timeout still opens the breaker', async () => {
  const { ctx, listeners, routes } = makeCtx()
  const calls = stubFetchHangs()
  apply(ctx, config({ timeoutMs: 120 }))
  await startTurn(listeners, 'Alpha is here. Beta is here. Gamma is here.')
  await tick(700)
  assert.ok(calls.length >= 3)
  assert.ok(calls.every((c) => c.abortedWith), 'the plugin aborted every hung request')
  assert.doesNotMatch(calls[0].abortedWith, /turn cancelled/, 'a timeout is not a turn cancellation')
  const b = breakerOf(await stats(routes))
  assert.equal(b.open, true, 'a hung provider must still trip the breaker')
})
