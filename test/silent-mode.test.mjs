/**
 * Silent mode (0.4.16-local.6) — host-wiring tests.
 *
 * The promise being tested is narrow and absolute: while silent mode is on, no
 * request reaches the TTS provider. Not "no audio is played", not "the reply is
 * quieter" — nothing is synthesized at all, because the speech model shares the
 * one GPU with the primary model and speaking into an empty room is wasted
 * inference.
 *
 * The harness is the same shape as test/wiring.test.mjs: the real plugin under a
 * fake Cordis context, `globalThis.fetch` stubbed, so `calls` is an exact record
 * of every synthesis attempt and no server or model is involved.
 *
 * Every muted assertion is paired with an unmuted control that drives the same
 * turn, so a gate that accidentally blocked everything (or a harness that never
 * reached the synthesizer in the first place) fails instead of passing quietly.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'

import { apply, name, Config } from '../lib/index.js'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tts-silent-'))

/** Minimal Cordis context that keeps every registration addressable by name. */
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
  return { ctx, listeners, routes, tools }
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
  announceApproval: true,
  approvalText: 'Approval required',
  chime: 'ding',
  customBaseUrl: 'http://127.0.0.1:18080/v1',
  customKeyEnv: 'CUSTOM_TTS_API_KEY',
  chain: [{ provider: 'custom', model: 'qwen3-tts-akeno', voice: 'akeno' }],
  pronunciation: [],
  enableItDictionary: false,
  ...over,
})

const SESSION = 'sess-silent'
const agent = { session: { id: SESSION } }
const framePayload = (frame) => ({ agent, frame })
const tick = () => new Promise((resolve) => setTimeout(resolve, 40))

async function call(route, req, res = makeRes()) {
  await route.handler(req, res)
  return res
}

async function pending(routes) {
  const res = await call(routes.get('/dsh-tts/pending'), makeReq('GET', '/dsh-tts/pending'))
  return JSON.parse(res.body)
}

async function status(routes) {
  const res = await call(routes.get('/dsh-tts/status'), makeReq('GET', '/dsh-tts/status'))
  return JSON.parse(res.body)
}

/** Drive one full live turn: start, streamed text, finish. */
function streamTurn(listeners, { attemptId, text, turn = 1, step = 1 }) {
  const onFrame = listeners.get('agent/assistant-stream')[0]
  onFrame(framePayload({ type: 'start', attemptId, revision: 1, turn, step }))
  onFrame(framePayload({
    type: 'chunk', attemptId, revision: 2, index: 0, time: 0,
    chunk: { type: 'text-delta', index: 0, text },
  }))
  onFrame(framePayload({
    type: 'chunk', attemptId, revision: 3, index: 1, time: 0,
    chunk: { type: 'finish', reason: { kind: 'stop' } },
  }))
  return onFrame
}

/** The durable message that follows every turn. */
function settle(listeners, { text, turn = 1, step = 1 }) {
  listeners.get('session/event')[0](
    { id: SESSION },
    { type: 'assistant/message', data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] } } },
  )
}

// The real registry validates arguments as lossless JSON before `execute` runs,
// so an explicit `undefined` is a test bug rather than a plugin one: optional
// arguments are omitted, exactly as the model omits them.
const setMuted = (tools, muted, reason) => {
  const args = { muted }
  if (reason !== undefined) args.reason = reason
  return tools.get('set_speech_output').execute(args, {})
}

test('the plugin still registers both tools, and silent mode is not a setting', () => {
  const { ctx, tools, routes } = makeCtx()
  apply(ctx, config())
  assert.equal(name, '@goodandready/dsh-tts')
  assert.ok(tools.has('speak_text'), 'speak_text still registers')
  assert.ok(tools.has('set_speech_output'), 'silent-mode control registers')
  assert.ok(routes.has('/dsh-tts/silence'), 'silent-mode route registers')
  // The state is runtime-only on purpose: it must never become a stored setting
  // that a restart could carry over, or a forgotten mute could silence the stack
  // permanently. A declared schema field would appear here with its default.
  assert.equal('speechMuted' in Config({}), false,
    'speechMuted must not be part of the settings schema')
})

test('unmuted control: a live turn does reach the synthesizer', async () => {
  const { ctx, listeners, routes } = makeCtx()
  const calls = stubFetch()
  apply(ctx, config())
  streamTurn(listeners, { attemptId: 'ctl', text: 'First sentence is ready. Second one' })
  await tick()
  // The finish frame flushes the un-cut tail, so a two-sentence reply is spoken
  // as two pieces: one cut live, one flushed at the end of the attempt.
  assert.equal(calls.length, 2, 'control arm synthesizes — so a muted pass means something')
  assert.equal((await pending(routes)).items.filter((i) => i.kind === 'speech').length, 2)
})

test('muted: no request reaches the TTS provider, and nothing is queued', async () => {
  const { ctx, listeners, routes, tools } = makeCtx()
  const calls = stubFetch()
  apply(ctx, config())
  const out = await setMuted(tools, true, 'test')
  assert.equal(out.ok, true)
  assert.equal(out.muted, true)
  assert.equal(out.changed, true)

  streamTurn(listeners, { attemptId: 'mute', text: 'First sentence is ready. Second one follows.' })
  settle(listeners, { text: 'First sentence is ready. Second one follows.' })
  await tick()

  assert.equal(calls.length, 0, 'no synthesis request at all while muted')
  assert.equal((await pending(routes)).items.length, 0, 'not even a reserved queue slot')
})

test('muted: approval announcements and their chimes stay silent too', async () => {
  const { ctx, listeners, tools } = makeCtx()
  const calls = stubFetch()
  apply(ctx, config())
  const onSession = listeners.get('session/event')[0]

  onSession({ id: SESSION }, { type: 'approval/asked', data: { toolName: 'Bash' } })
  await tick()
  assert.equal(calls.length, 1, 'control: an approval is voiced when unmuted')

  await setMuted(tools, true)
  onSession({ id: SESSION }, { type: 'approval/asked', data: { toolName: 'Bash' } })
  await tick()
  assert.equal(calls.length, 1, 'muted: the approval adds no synthesis')
})

test('muted: speak_text declines instead of synthesizing', async () => {
  const { ctx, tools } = makeCtx()
  const calls = stubFetch()
  apply(ctx, config())
  await setMuted(tools, true)
  const out = await tools.get('speak_text').execute({ text: 'Read this aloud please' }, {})
  await tick()
  assert.equal(out.ok, false)
  assert.equal(out.muted, true)
  assert.match(out.error, /silent mode is on/i)
  assert.equal(calls.length, 0, 'the tool does not reach the provider either')
})

test('turning silent mode on mid-reply stops the speech already queued', async () => {
  const { ctx, listeners, routes, tools } = makeCtx()
  const calls = stubFetch()
  apply(ctx, config())
  streamTurn(listeners, { attemptId: 'cut', text: 'First sentence is ready. Second one follows.' })
  await tick()
  const spoken = calls.length
  assert.ok(spoken >= 1, 'speech happened before the mute')
  assert.ok((await pending(routes)).items.length >= 1, 'and it is waiting in the queue')

  await setMuted(tools, true)
  assert.equal((await pending(routes)).items.length, 0, 'the queued speech is dropped')

  // The rest of the same turn must stay quiet — a mute that only silenced the
  // next turn would still talk over an empty room for as long as the turn runs.
  streamTurn(listeners, { attemptId: 'cut', text: 'Third sentence arrives later.', turn: 1, step: 2 })
  await tick()
  assert.equal(calls.length, spoken, 'no further synthesis for the rest of the muted turn')
  assert.equal((await pending(routes)).items.length, 0, 'and nothing new is queued')
})

test('unmuting restores speech, and the round trip is idempotent', async () => {
  const { ctx, listeners, routes, tools } = makeCtx()
  const calls = stubFetch()
  apply(ctx, config())
  const control = tools.get('set_speech_output')

  const report = await control.execute({})
  assert.equal(report.muted, false, 'a fresh host starts speaking')
  assert.equal(report.changed, false)

  assert.equal((await setMuted(tools, true)).changed, true)
  assert.equal((await setMuted(tools, true)).changed, false, 'setting the same value changes nothing')
  assert.equal((await status(routes)).speechMuted, true)

  assert.equal((await setMuted(tools, false)).changed, true)
  streamTurn(listeners, { attemptId: 'back', text: 'Speaking again now. And a second sentence.' })
  await tick()
  assert.ok(calls.length >= 1, 'speech resumes after unmuting')
  assert.equal((await status(routes)).speechMuted, false)
})

test('the /silence route sets and reports the same state as the tool', async () => {
  const { ctx, routes } = makeCtx()
  stubFetch()
  apply(ctx, config())
  const route = routes.get('/dsh-tts/silence')

  let res = await call(route, makeReq('GET', '/dsh-tts/silence'))
  assert.equal(JSON.parse(res.body).speechMuted, false)

  res = await call(route, makeReq('POST', '/dsh-tts/silence', JSON.stringify({ muted: true, reason: 'test' })))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true, speechMuted: true, changed: true })

  res = await call(route, makeReq('GET', '/dsh-tts/silence'))
  assert.equal(JSON.parse(res.body).speechMuted, true)

  res = await call(route, makeReq('POST', '/dsh-tts/silence', JSON.stringify({ muted: 'yes' })))
  assert.equal(res.statusCode, 400, 'a non-boolean is refused')

  res = await call(route, makeReq('DELETE', '/dsh-tts/silence'))
  assert.equal(res.statusCode, 405)
})

test('/status separates "muted" from "reply speech is configured off"', async () => {
  const { ctx, routes, tools } = makeCtx()
  stubFetch()
  apply(ctx, config())
  let json = await status(routes)
  assert.equal(json.speechMuted, false)
  assert.equal(json.speechSuppressed, false)

  await setMuted(tools, true)
  json = await status(routes)
  assert.equal(json.speechMuted, true)
  assert.equal(json.speechSuppressed, true)
  assert.equal(json.speakReplies, true, 'the standing preference is untouched by a mute')
})

test('each apply() gets its own silent-mode state', async () => {
  // Not cosmetic: a leaked module-level flag would let one profile silence
  // another, and would survive the very restart that is supposed to clear it.
  const a = makeCtx()
  const b = makeCtx()
  stubFetch()
  apply(a.ctx, config())
  apply(b.ctx, config())
  await setMuted(a.tools, true)
  assert.equal((await status(a.routes)).speechMuted, true)
  assert.equal((await status(b.routes)).speechMuted, false, 'the second instance is unaffected')
})
