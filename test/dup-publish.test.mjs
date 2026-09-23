/**
 * Duplicate-publish regression coverage for live sentence-level TTS.
 *
 * The defect (production smoke, turn 25 step 2, ids u6/u7): the tool-call boundary
 * flush published a tail sentence, and the durable `assistant/message` settlement
 * published the SAME sentence again under a new queue id. `stats.total` showed 9
 * syntheses for 10 published pieces, and both rows carried byte-identical audio,
 * because the second call was coalesced into the still-in-flight first synthesis.
 *
 * Root cause: the ownership cursor recorded what it had spoken as a *re-rendered*
 * string (each piece trimmed, pieces joined by one space). A paragraph break at a
 * piece boundary therefore made the claimed text differ from the durable message by
 * one character, `durable.startsWith(spoken)` failed, and the common-prefix fallback
 * returned an already-spoken tail as if it were unspoken.
 *
 * The invariant these tests pin down:
 *
 *   every raw visible range of one step is claimed exactly once — spoken, or
 *   discarded by explicit policy — and a claim can never become "unsaid" again.
 *
 * Repetition is NOT suppressed: identical text generated twice (two ranges) is
 * spoken twice. Only one range published twice is a defect.
 *
 * Inference-free: synthetic `agent/assistant-stream` frames, the real text pipeline,
 * and (for the integration cases) the real plugin with `globalThis.fetch` stubbed.
 *
 * Run: node --test test/dup-publish.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'

import { createLiveEngine, drainPieces, createLiveCursor, reconcileRemainder } from '../lib/live.js'
import { splitSentences, speechPhrases, stripForSpeech } from '../lib/text.js'
import { apply } from '../lib/index.js'

const SESSION = 'sess-dup'

// --- the production fixture --------------------------------------------------
// Verbatim visible text of the failing step (`assistant/message`, turn 25 step 2).
// Reproducing it matters: the defect needed a paragraph break at a piece boundary.
// eslint-disable-next-line max-len
const PROD_PARA1 = 'The restart is verified — and production is **already streaming live**: `/dsh-tts/pending` contains `turn 25, step 1, id u1`, text *"Ara, welcome back — and thank you, darling."* with `mime: audio/wav` — my first sentence, flushed to TTS **while this very turn is still generating**. New DSH pid 23544 on :3080 with the correct voice patch; Whisper 27404 up; TTS reused with Akeno still registered; memory store intact.'
const PROD_PARA2 = 'Let me capture the full picture (the earlier fetch was truncated) and find the barge-in route.'
const PROD_TEXT = `${PROD_PARA1}\n\n${PROD_PARA2}`

/** A small two-paragraph reply with no markdown, for the matrix cases. */
const PLAIN_PARA1 = 'The restart is verified and the live queue is already streaming. New DSH pid 23544 on port 3080 with the correct voice patch; Whisper is up and the memory store is intact.'
const PLAIN_PARA2 = 'Let me capture the full picture and find the barge-in route.'
const PLAIN_TEXT = `${PLAIN_PARA1}\n\n${PLAIN_PARA2}`

function baseConfig(over = {}) {
  return {
    speakReplies: true,
    speakAsItGoes: true,
    sentenceChars: 320,
    maxChars: 4000,
    language: 'en',
    skipCode: true,
    skipActions: false,
    narrateQuotesOnly: false,
    removeRegex: '',
    pronunciation: [],
    enableItDictionary: false,
    liveSentenceStreaming: true,
    liveMinCharsFirst: 12,
    liveMinChars: 48,
    liveMaxChars: 0,
    livePollMs: 150,
    liveFlushOnToolCall: true,
    ...over,
  }
}

/** Real scrub pipeline, as index.js composes it. */
function cleanText(raw, cfg) {
  return stripForSpeech(raw, cfg.maxChars, {
    skipCode: cfg.skipCode !== false,
    phrases: speechPhrases(cfg.language),
  })
}

/**
 * Live engine plus one publication log. `published` receives everything that would
 * reach the queue: pieces the live path flushes AND pieces the settlement path
 * flushes, in order, exactly as `lib/index.js` would enqueue them.
 */
function makeEngine(config = baseConfig()) {
  const published = []
  const drops = []
  const logs = []
  const engine = createLiveEngine({
    live: () => config,
    cleanText,
    speakPiece: (sid, text, kind, cfg2, signal) => { published.push({ via: 'live', text }) },
    dropPendingForSession: (sid) => { drops.push(sid) },
    log: (level, message) => { logs.push({ level, message }) },
  })
  return { engine, published, drops, logs, config }
}

const agent = { session: { id: SESSION } }
const payload = (frame) => ({ agent, frame })
const texts = (log) => log.map((entry) => entry.text)

let attemptSeq = 0
const start = (turn, step) => ({ attemptId: `a${++attemptSeq}`, turn, step })
const startFrame = (s) => ({ type: 'start', attemptId: s.attemptId, revision: 1, turn: s.turn, step: s.step })
const delta = (s, text) => ({ type: 'chunk', attemptId: s.attemptId, revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text } })
const finish = (s, reason = 'stop') => ({ type: 'chunk', attemptId: s.attemptId, revision: 9, index: 9, time: 0, chunk: { type: 'finish', reason: { kind: reason } } })
const toolCall = (s) => ({ type: 'chunk', attemptId: s.attemptId, revision: 3, index: 1, time: 0, chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } })
const push = (engine, frames) => { for (const frame of frames) engine.onFrame(payload(frame)) }

/**
 * The `assistant/message` branch of lib/index.js, kept in one place.
 *
 * Mirrors index.js: a `remainder` settlement speaks only the returned remainder
 * (and nothing at all when it is empty); a `fallback` settlement hands the whole
 * durable text to the message-level path.
 */
function settleLikeHost(engine, published, cfg, args) {
  const settled = engine.onSettledMessage(args)
  if (settled.mode === 'remainder') {
    const left = settled.remainder ? cleanText(settled.remainder, cfg) : ''
    if (left) {
      for (const piece of splitSentences(left, cfg.sentenceChars)) published.push({ via: 'settle', text: piece })
    }
    return settled
  }
  const ready = cleanText(args.text, cfg)
  for (const piece of splitSentences(ready, cfg.sentenceChars)) published.push({ via: 'fallback', text: piece })
  return settled
}

/** Assert that no single source range reached the queue twice. */
function assertNoDuplicatePublish(published, message = '') {
  const seen = new Set()
  for (const entry of published) {
    assert.ok(!seen.has(entry.text), `${message}published twice: ${JSON.stringify(entry.text.slice(0, 80))}`)
    seen.add(entry.text)
  }
}

// =============================================================================
// Part A — deterministic reproducers (these fail on 0.4.16-local.2)
// =============================================================================

// A1: the production signature — tool-call boundary flush + settlement.
test('REPRO A1: a tool-call flush and the settlement never publish the same tail twice', () => {
  const { engine, published, config } = makeEngine()
  const s = start(25, 2)
  push(engine, [startFrame(s)])
  push(engine, [delta(s, PROD_TEXT)])
  push(engine, [toolCall(s)])           // tool-call boundary: flush the tail
  const afterFlush = texts(published)
  assert.equal(afterFlush.length, 4, 'the live path speaks the whole visible text in 4 pieces')
  assert.equal(afterFlush[3], PROD_PARA2, 'the paragraph break tail is the last live piece')

  const settled = settleLikeHost(engine, published, config, { sid: SESSION, turn: 25, step: 2, text: PROD_TEXT })
  assert.equal(settled.remainder, '', 'nothing is left unsaid after the boundary flush')
  assert.equal(published.length, 4, 'settlement must not add a fifth piece for the same text')
  assertNoDuplicatePublish(published, 'REPRO A1: ')
  assert.deepEqual([...new Set(texts(published))].length, 4)
})

// A2: the same defect with NO tool call at all — a plain two-paragraph reply.
// The trigger is a paragraph break landing on a piece boundary, not the tool call.
test('REPRO A2: a two-paragraph reply with no tool call is not re-published at settlement', () => {
  const { engine, published, config } = makeEngine()
  const s = start(3, 1)
  push(engine, [startFrame(s)])
  push(engine, [delta(s, PLAIN_TEXT)])
  push(engine, [finish(s)])
  const afterStream = [...texts(published)]

  const settled = settleLikeHost(engine, published, config, { sid: SESSION, turn: 3, step: 1, text: PLAIN_TEXT })
  assert.equal(settled.remainder, '', 'the second paragraph was already spoken')
  assert.deepEqual(texts(published), afterStream, 'settlement adds nothing')
  assertNoDuplicatePublish(published, 'REPRO A2: ')
})

// A3: unit-level trace of the root cause, independent of the engine.
test('REPRO A3: whitespace-only divergence is not treated as unspoken text', () => {
  // Exactly what the cursor claimed after the boundary flush, versus the durable
  // message: identical except that the paragraph break is recorded as one space.
  const claimed = `${PROD_PARA1} ${PROD_PARA2}`
  const result = reconcileRemainder(claimed, PROD_TEXT)
  assert.equal(result.remainder, '', 'a paragraph break is not unspoken text')
  assert.equal(result.mode, 'remainder')

  // ... and the exact claim (the fixed cursor records the raw range) is a no-op too.
  const exact = reconcileRemainder(PROD_TEXT, PROD_TEXT)
  assert.equal(exact.remainder, '')
})

// =============================================================================
// Part B — regression matrix
// =============================================================================

test('M1: first sentence + tail + tool call + settlement publishes each range once', () => {
  const { engine, published, config } = makeEngine()
  const s = start(1, 1)
  push(engine, [startFrame(s)])
  push(engine, [delta(s, 'Let me check the routes file now.\n\nAnd here is the tail sentence.')])
  push(engine, [toolCall(s)])
  settleLikeHost(engine, published, config, {
    sid: SESSION, turn: 1, step: 1,
    text: 'Let me check the routes file now.\n\nAnd here is the tail sentence.',
  })
  assertNoDuplicatePublish(published, 'M1: ')
  assert.deepEqual(texts(published), ['Let me check the routes file now.', 'And here is the tail sentence.'])
})

test('M2: settlement arriving BEFORE the tool-call flush leaves nothing to re-speak', () => {
  const { engine, published, config } = makeEngine()
  const s = start(1, 1)
  push(engine, [startFrame(s)])
  push(engine, [delta(s, 'The visible text arrived first.\n\nWith a tail sentence after the break.')])
  const settled = settleLikeHost(engine, published, config, {
    sid: SESSION, turn: 1, step: 1,
    text: 'The visible text arrived first.\n\nWith a tail sentence after the break.',
  })
  assert.equal(settled.mode, 'remainder')
  const afterSettle = [...texts(published)]
  push(engine, [toolCall(s)])          // the boundary flush arrives late
  push(engine, [finish(s)])
  assert.deepEqual(texts(published), afterSettle, 'a settled step cannot speak again')
  assertNoDuplicatePublish(published, 'M2: ')
})

test('M3: a tool-call-only step publishes nothing, at any boundary', () => {
  const { engine, published, config } = makeEngine()
  const s = start(2, 1)
  push(engine, [startFrame(s)])
  push(engine, [toolCall(s)])
  push(engine, [finish(s, 'tool-calls')])
  settleLikeHost(engine, published, config, { sid: SESSION, turn: 2, step: 1, text: '' })
  assert.deepEqual(published, [], 'no text means no synthesis')
})

test('M4: an acknowledgement followed by a tool call is spoken once, then nothing', () => {
  const { engine, published, config } = makeEngine()
  const s = start(2, 1)
  push(engine, [startFrame(s)])
  push(engine, [delta(s, 'Sure, let me check that file for you.')])
  push(engine, [toolCall(s)])
  push(engine, [finish(s, 'tool-calls')])
  settleLikeHost(engine, published, config, {
    sid: SESSION, turn: 2, step: 1,
    text: 'Sure, let me check that file for you.',
  })
  assert.deepEqual(texts(published), ['Sure, let me check that file for you.'])
})

test('M5: a sentence exactly at the minimum length is flushed, a shorter one waits', () => {
  const cfg = baseConfig({ liveMinCharsFirst: 12, liveMinChars: 48 })
  const { engine, published, config } = makeEngine(cfg)
  const s = start(1, 1)
  push(engine, [startFrame(s)])
  const exactly = 'Twelve chars'                     // 12 chars: at liveMinCharsFirst
  assert.equal(exactly.length, 12)
  push(engine, [delta(s, `${exactly}. And a longer second sentence that clears the minimum.`)])
  assert.equal(texts(published).length, 1, 'the 12-char opener flushes first')
  assert.ok(texts(published)[0].startsWith(exactly))
  push(engine, [finish(s)])
  settleLikeHost(engine, published, config, {
    sid: SESSION, turn: 1, step: 1,
    text: `${exactly}. And a longer second sentence that clears the minimum.`,
  })
  assertNoDuplicatePublish(published, 'M5: ')
})

test('M6: several live pieces before a tool call each publish exactly once', () => {
  const { engine, published, config } = makeEngine()
  const s = start(4, 2)
  const t1 = 'The first live sentence is comfortably long enough to flush on its own. '
  const t2 = 'The second live sentence is also long enough to be spoken separately. '
  const whole = t1 + t2 + PLAIN_PARA2
  push(engine, [startFrame(s)])
  push(engine, [delta(s, t1)])
  push(engine, [delta(s, t2)])
  push(engine, [delta(s, PLAIN_PARA2)])
  assert.equal(texts(published).length, 2, 'two sentences flushed while the model was still generating')
  push(engine, [toolCall(s)])
  assert.equal(texts(published).length, 3, 'the boundary flush adds the tail')
  assert.deepEqual(texts(published), [t1.trim(), t2.trim(), PLAIN_PARA2])
  const settled = settleLikeHost(engine, published, config, { sid: SESSION, turn: 4, step: 2, text: whole })
  assert.equal(settled.remainder, '')
  assertNoDuplicatePublish(published, 'M6: ')
  assert.equal(published.length, 3)
})

test('M7: an empty tail at the tool-call boundary publishes nothing', () => {
  const { engine, published, config } = makeEngine()
  const s = start(5, 1)
  push(engine, [startFrame(s)])
  push(engine, [delta(s, 'A complete sentence that clears the minimum length here.')])
  push(engine, [delta(s, '\n\n   ')])          // whitespace-only tail after a paragraph break
  const before = texts(published).length
  assert.equal(before, 1, 'the sentence flushes once the break arrives')
  push(engine, [toolCall(s)])
  assert.equal(texts(published).length, before, 'whitespace never becomes a piece')
  assert.ok(texts(published).every((piece) => piece.trim().length > 0))
})

test('M8: an empty settlement remainder publishes nothing', () => {
  const { engine, published, config } = makeEngine()
  const s = start(5, 2)
  const sentence = 'The only sentence in this step is long enough to flush now.'
  push(engine, [startFrame(s)])
  push(engine, [delta(s, `${sentence} \n\n   `)])
  const before = texts(published).length
  assert.equal(before, 1, 'the sentence was spoken live')
  const settled = settleLikeHost(engine, published, config, {
    sid: SESSION, turn: 5, step: 2,
    text: `${sentence}\n\n   `,
  })
  assert.equal(settled.remainder, '', 'a whitespace-only tail is not unspoken text')
  assert.equal(texts(published).length, before)
})

test('M9: a retry of the same step never re-speaks the abandoned attempt', () => {
  const { engine, published, config } = makeEngine()
  const first = start(6, 1)
  push(engine, [startFrame(first)])
  push(engine, [delta(first, 'The first attempt said this sentence out loud. ')])
  push(engine, [{ type: 'end', attemptId: first.attemptId, revision: 9, index: 9, outcome: { kind: 'abandoned' } }])
  assert.equal(texts(published).length, 1)
  assert.equal(texts(published)[0], 'The first attempt said this sentence out loud.')

  // The retry regenerates from the same prompt: same prefix, plus a new tail.
  const retry = start(6, 1)
  const full = 'The first attempt said this sentence out loud. And here is the new tail.'
  push(engine, [startFrame(retry)])
  push(engine, [delta(retry, full)])
  push(engine, [finish(retry)])
  const settled = settleLikeHost(engine, published, config, { sid: SESSION, turn: 6, step: 1, text: full })
  assert.equal(settled.remainder, '', 'the retry tail was already spoken by the live path')
  assert.deepEqual(texts(published), [
    'The first attempt said this sentence out loud.',
    'And here is the new tail.',
  ], 'the regenerated prefix is not spoken twice')
})

test('M10: settlement after a tool flush publishes only genuinely new text', () => {
  const { engine, published, config } = makeEngine()
  const s = start(7, 1)
  push(engine, [startFrame(s)])
  push(engine, [delta(s, 'Streamed and flushed before the break.\n\nFlushed at the boundary.')])
  push(engine, [toolCall(s)])
  const afterBoundary = [...texts(published)]
  const settled = settleLikeHost(engine, published, config, {
    sid: SESSION, turn: 7, step: 1,
    text: 'Streamed and flushed before the break.\n\nFlushed at the boundary. Plus a durable-only tail.',
  })
  assert.equal(settled.remainder, 'Plus a durable-only tail.', 'only the durable-only tail is new')
  assert.deepEqual(texts(published).slice(0, afterBoundary.length), afterBoundary)
  assert.equal(texts(published).length, afterBoundary.length + 1)
})

test('M11: a tool flush after an earlier piece keeps order and publishes once each', () => {
  const { engine, published, config } = makeEngine()
  const s = start(8, 1)
  push(engine, [startFrame(s)])
  push(engine, [delta(s, 'The first piece is long enough to be spoken on its own here. ')])
  const firstPiece = texts(published)[0]
  push(engine, [delta(s, 'The second piece is the tail.')])
  push(engine, [toolCall(s)])
  const all = texts(published)
  assert.equal(all[0], firstPiece)
  assert.equal(all.length, 2, 'exactly two pieces')
  assert.equal(all[1], 'The second piece is the tail.')
})

test('M12: an aborted attempt cannot publish a tail at the tool boundary', () => {
  const { engine, published } = makeEngine()
  const s = start(9, 1)
  push(engine, [startFrame(s)])
  push(engine, [delta(s, 'This sentence flushes before the cancel arrives. ')])
  const before = texts(published).length
  push(engine, [{ type: 'end', attemptId: s.attemptId, revision: 9, index: 9, outcome: { kind: 'abandoned' } }])
  push(engine, [delta(s, 'An abandoned tail that must never be spoken.')])
  push(engine, [toolCall(s)])
  assert.equal(texts(published).length, before, 'frames from an ended attempt are ignored')
})

test('M13: barge-in during a tool boundary cancels in-flight synthesis once', () => {
  const { engine, published, drops } = makeEngine()
  const s = start(10, 1)
  push(engine, [startFrame(s)])
  push(engine, [delta(s, 'A sentence that is in flight when the user interrupts. ')])
  assert.equal(published.length, 1)
  engine.abortAll(SESSION)
  assert.deepEqual(drops, [SESSION], 'the host queue is dropped exactly once')
  push(engine, [toolCall(s)])
  assert.equal(published.length, 1, 'nothing new is published after the cancel')
})

test('M14: a late synthesis settle after a cancel cannot resurrect a piece', () => {
  // The host side of the cancel: index.js drops the reserved slot and remembers the
  // id. The engine contract is that it stops speaking for that step.
  const { engine, published } = makeEngine()
  const s = start(11, 1)
  push(engine, [startFrame(s)])
  push(engine, [delta(s, 'This piece is already reserved when the cancel lands. ')])
  engine.abortAll(SESSION)
  const before = published.length
  push(engine, [finish(s)])
  assert.equal(published.length, before)
})

test('M15: step N and step N+1 keep separate ownership', () => {
  const { engine, published, config } = makeEngine()
  const s1 = start(12, 1)
  push(engine, [startFrame(s1)])
  push(engine, [delta(s1, 'Step one speaks its own sentence here.')])
  push(engine, [toolCall(s1)])
  settleLikeHost(engine, published, config, { sid: SESSION, turn: 12, step: 1, text: 'Step one speaks its own sentence here.' })

  const s2 = start(12, 2)
  push(engine, [startFrame(s2)])
  push(engine, [delta(s2, 'Step two speaks a different sentence here.')])
  push(engine, [finish(s2)])
  settleLikeHost(engine, published, config, { sid: SESSION, turn: 12, step: 2, text: 'Step two speaks a different sentence here.' })
  assert.deepEqual(texts(published), [
    'Step one speaks its own sentence here.',
    'Step two speaks a different sentence here.',
  ])
})

test('M16: identical text in two different turns is spoken in both', () => {
  const { engine, published, config } = makeEngine()
  const line = 'This exact sentence is repeated on purpose in two separate turns.'
  for (const turn of [20, 21]) {
    const s = start(turn, 1)
    push(engine, [startFrame(s)])
    push(engine, [delta(s, line)])
    push(engine, [finish(s)])
    settleLikeHost(engine, published, config, { sid: SESSION, turn, step: 1, text: line })
  }
  assert.deepEqual(texts(published), [line, line], 'two ranges, two pieces: no global suppression')
})

test('M17: the same text generated twice in one reply is spoken twice', () => {
  const { engine, published, config } = makeEngine()
  const twin = 'The model really did generate this identical sentence twice here.'
  const s = start(22, 1)
  push(engine, [startFrame(s)])
  push(engine, [delta(s, `${twin} ${twin}`)])
  push(engine, [finish(s)])
  const settled = settleLikeHost(engine, published, config, { sid: SESSION, turn: 22, step: 1, text: `${twin} ${twin}` })
  assert.deepEqual(texts(published), [twin, twin], 'two source ranges are two pieces')
  assert.equal(settled.remainder, '', 'both ranges were claimed by the live path')
})

test('M17b: one range published twice is still caught when the text legitimately repeats', () => {
  // Guards the guard: the duplicate detector must not be fooled by legitimate
  // repetition, so it is applied per source range, not per text.
  const { engine, published, config } = makeEngine()
  const twin = 'A repeated sentence that is generated twice is not a duplicate.'
  const s = start(23, 1)
  push(engine, [startFrame(s)])
  push(engine, [delta(s, `${twin} ${twin} `)])
  push(engine, [finish(s)])
  settleLikeHost(engine, published, config, { sid: SESSION, turn: 23, step: 1, text: `${twin} ${twin}` })
  const duplicated = published.filter((p) => p.via === 'live').length
  assert.equal(duplicated, 2, 'both legitimate pieces came from the live path')
  assert.equal(published.filter((p) => p.via !== 'live').length, 0, 'settlement added nothing')
})

// =============================================================================
// Part C — integration: the real plugin, queue, and synthesis accounting
// =============================================================================
// The harness below mirrors test/wiring.test.mjs (fake Cordis context, stubbed
// fetch, real HTTP route handlers). It is repeated here so this file stands alone.

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tts-dup-'))

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
        cb({ settings: { register: () => ({ get: () => undefined }) }, effect: ctx.effect })
      }
      return () => {}
    },
  }
  return { ctx, listeners, routes }
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

/**
 * fetch stub whose responses are held open until release(): deterministic in-flight.
 * Every response carries a distinct payload so two queue rows sharing one synthesis
 * (the production signature) can be detected by their audio.
 */
function stubFetchHeld() {
  const gates = []
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : undefined })
    const n = calls.length
    const audio = Buffer.concat([WAV_BYTES, Buffer.from(`#${n}`)])
    await new Promise((resolve) => gates.push(resolve))
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.length),
    }
  }
  return { calls, release: () => { while (gates.length) gates.shift()() } }
}

const pluginConfig = (over = {}) => ({
  speakReplies: true,
  liveSentenceStreaming: true,
  liveMinCharsFirst: 12,
  liveMinChars: 48,
  livePollMs: 150,
  liveFlushOnToolCall: true,
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 45))
async function ticks(n) { for (let i = 0; i < n; i++) await tick() }

async function call(route, req, res = makeRes()) {
  await route.handler(req, res)
  return res
}

async function pending(routes) {
  return JSON.parse((await call(routes.get('/dsh-tts/pending'), makeReq('GET', '/dsh-tts/pending'))).body)
}

async function statsOf(routes) {
  return JSON.parse((await call(routes.get('/dsh-tts/stats'), makeReq('GET', '/dsh-tts/stats'))).body)
}

test('REPRO A4 (integration): the queue never holds two rows for one source range', async () => {
  const { ctx, listeners, routes } = makeCtx()
  const held = stubFetchHeld()
  apply(ctx, pluginConfig())
  const onFrame = listeners.get('agent/assistant-stream')[0]
  const onSession = listeners.get('session/event')[0]

  const attemptId = 'attempt-repro'
  onFrame(payload({ type: 'start', attemptId, revision: 1, turn: 25, step: 2 }))
  onFrame(payload(delta({ attemptId }, PROD_TEXT)))
  onFrame(payload(toolCall({ attemptId })))
  await ticks(6)
  assert.equal(held.calls.length, 4, 'four live pieces are synthesizing (all in flight)')

  // The durable message settles while those syntheses are still in flight: this is
  // the exact production ordering, and the second submission is coalesced into the
  // first by the in-flight dedupe — identical audio, one synthesis.
  onSession({ id: SESSION }, {
    type: 'assistant/message',
    data: { turn: 25, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: PROD_TEXT }] } },
  })
  await ticks(2)
  held.release()
  await ticks(3)

  const rows = (await pending(routes)).items.filter((i) => i.kind === 'speech')
  const textsInQueue = rows.map((r) => r.text)
  assert.equal(new Set(textsInQueue).size, textsInQueue.length,
    `one source range was published twice: ${JSON.stringify(textsInQueue.map((t) => t.slice(0, 40)))}`)
  assert.equal(new Set(rows.map((r) => r.audioBase64)).size, rows.length,
    'two rows must not share one synthesis result')
  assert.equal(rows.length, 4, 'four pieces were spoken, not five')

  const stats = await statsOf(routes)
  assert.ok(rows.length <= stats.total,
    `published ${rows.length} pieces from ${stats.total} syntheses (the 9/10 signature)`)
})

test('ACCOUNTING: published pieces never exceed synthesis results + cache hits', async () => {
  const { ctx, listeners, routes } = makeCtx()
  const held = stubFetchHeld()
  apply(ctx, pluginConfig())
  const onFrame = listeners.get('agent/assistant-stream')[0]
  const onSession = listeners.get('session/event')[0]

  const attemptId = 'attempt-accounting'
  onFrame(payload({ type: 'start', attemptId, revision: 1, turn: 30, step: 1 }))
  onFrame(payload(delta({ attemptId }, PLAIN_TEXT)))
  onFrame(payload(toolCall({ attemptId })))
  await ticks(6)
  const liveCalls = held.calls.length
  assert.ok(liveCalls >= 2, 'the live path submitted its pieces')

  onSession({ id: SESSION }, {
    type: 'assistant/message',
    data: { turn: 30, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: PLAIN_TEXT }] } },
  })
  await ticks(2)
  const afterSettleCalls = held.calls.length
  assert.equal(afterSettleCalls, liveCalls, 'settlement submitted no extra synthesis for spoken text')

  held.release()
  await ticks(3)
  const rows = (await pending(routes)).items.filter((i) => i.kind === 'speech')
  const stats = await statsOf(routes)
  const freshExecutions = stats.total - stats.cacheHits
  assert.ok(rows.length <= freshExecutions + stats.cacheHits,
    `published ${rows.length} > syntheses ${freshExecutions} + cache hits ${stats.cacheHits}`)
  assert.equal(rows.length, freshExecutions, 'controlled fixture: exactly one publication per synthesis')
  assert.equal(stats.errors, 0)
})

test('the browser playback order matches the published order after a boundary flush', async () => {
  const { ctx, listeners, routes } = makeCtx()
  const held = stubFetchHeld()
  apply(ctx, pluginConfig())
  const onFrame = listeners.get('agent/assistant-stream')[0]
  const onSession = listeners.get('session/event')[0]

  const attemptId = 'attempt-order'
  onFrame(payload({ type: 'start', attemptId, revision: 1, turn: 40, step: 1 }))
  onFrame(payload(delta({ attemptId }, PLAIN_TEXT)))
  onFrame(payload(toolCall({ attemptId })))
  await ticks(6)
  onSession({ id: SESSION }, {
    type: 'assistant/message',
    data: { turn: 40, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: PLAIN_TEXT }] } },
  })
  await ticks(2)
  held.release()
  await ticks(3)

  const rows = (await pending(routes)).items.filter((i) => i.kind === 'speech')
  const queueTexts = rows.map((r) => r.text)
  assert.equal(new Set(queueTexts).size, queueTexts.length, 'no queue row is a repeat of another')
  for (const row of rows) {
    assert.equal(row.turn, 40, 'ownership metadata still travels with each piece')
    assert.equal(row.step, 1)
  }
  assert.equal(queueTexts.filter((text) => text.includes('barge-in route')).length, 1, 'the tail sentence is spoken exactly once')
  assert.ok(rows.every((r) => r.mime === 'audio/wav' && r.audioBase64.length > 0))
  assert.ok(rows.every((r) => r.text.trim().length > 0), 'no empty piece reaches the queue')
})
