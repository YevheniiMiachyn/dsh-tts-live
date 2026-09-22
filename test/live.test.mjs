/**
 * Inference-free tests for live sentence-level TTS flush.
 *
 * Every case drives `createLiveEngine` with synthetic `agent/assistant-stream`
 * frames and a fake `speakPiece`, so nothing here needs a model, a network, or
 * audio. The real text pipeline (`stripForSpeech`) is used for markdown/code
 * safety, because the point of those cases is the interaction between the
 * accumulator and the existing scrubber.
 *
 * Run: node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createLiveEngine,
  drainPieces,
  createLiveCursor,
  liveOptions,
  reconcileRemainder,
  scanSafeCuts,
  hasOpenFence,
  stripOpenFence,
} from '../lib/live.js'
import { stripForSpeech, speechPhrases } from '../lib/text.js'

const SESSION = 'sess-1'

/** A resolved dsh-tts config with live mode on and short thresholds. */
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

/** Build an engine plus observation arrays. */
function makeEngine(config = baseConfig()) {
  const spoken = []
  const dropped = []
  const logs = []
  const engine = createLiveEngine({
    live: () => config,
    cleanText,
    speakPiece: (sid, text, cfg, kind, signal) => { spoken.push({ sid, text, kind, signal }) },
    dropPendingForSession: (sid) => { dropped.push(sid) },
    log: (level, message) => { logs.push({ level, message }) },
  })
  return { engine, spoken, dropped, logs, config }
}

const agent = { session: { id: SESSION } }
const payload = (frame) => ({ agent, frame })

let attemptSeq = 0
function start(turn = 1, step = 1) {
  const attemptId = `a${++attemptSeq}`
  return { attemptId, frames: [{ type: 'start', attemptId, revision: 1, turn, step }] }
}

function textFrames(attemptId, text, turn = 1, step = 1) {
  return [{ type: 'chunk', attemptId, revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text } }]
}

function push(engine, frames) {
  for (const frame of frames) engine.onFrame(payload(frame))
}

/** Feed a list of text deltas as one attempt and settle it. */
function runText(engine, deltas, { turn = 1, step = 1 } = {}) {
  const { attemptId } = start(turn, step)
  push(engine, [{ type: 'start', attemptId, revision: 1, turn, step }])
  for (const delta of deltas) push(engine, textFrames(attemptId, delta, turn, step))
  // The adapter always ends with a terminal finish chunk, then the end frame.
  push(engine, [{ type: 'chunk', attemptId, revision: 99, index: 99, time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }])
  push(engine, [{ type: 'end', attemptId, revision: 100, index: 100, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } }])
  return attemptId
}

const texts = (spoken) => spoken.map((piece) => piece.text)

test('liveOptions: defaults, maxChars resolution, and enable gating', () => {
  const off = liveOptions({ sentenceChars: 320 })
  assert.equal(off.enabled, false)
  assert.equal(off.minCharsFirst, 12)
  assert.equal(off.minChars, 48)
  assert.equal(off.maxChars, 320, 'liveMaxChars 0 reuses sentenceChars')
  assert.equal(off.pollMs, 150)

  const on = liveOptions({ liveSentenceStreaming: true, liveMinChars: 7, liveMaxChars: 90, sentenceChars: 320 })
  assert.equal(on.enabled, true)
  assert.equal(on.minChars, 7)
  assert.equal(on.maxChars, 90)
})

test('disabled mode is inert: frames produce no speech', () => {
  const { engine, spoken } = makeEngine(baseConfig({ liveSentenceStreaming: false }))
  runText(engine, ['Hello there. This is a test.'])
  assert.deepEqual(spoken, [])
})

// 1. normal 3-sentence stream ------------------------------------------------
test('1. normal three-sentence stream keeps order and does not fragment', () => {
  const { engine, spoken } = makeEngine()
  runText(engine, ['Hello there. This is a second sentence. And a third one here.'])
  assert.deepEqual(texts(spoken), [
    'Hello there.',
    'This is a second sentence. And a third one here.',
  ])
  assert.deepEqual([...spoken.map((p) => p.sid)], [SESSION, SESSION])
})

// 2. tokens with leading spaces ---------------------------------------------
test('2. tokens with leading spaces do not create empty or split pieces', () => {
  const { engine, spoken } = makeEngine()
  runText(engine, ['Hello wor', 'ld. How are you', ' today? Fine.'])
  assert.deepEqual(texts(spoken), ['Hello world.', 'How are you today? Fine.'])
  for (const piece of texts(spoken)) assert.equal(piece, piece.trim())
})

// 3. punctuation at the end of a token --------------------------------------
test('3. punctuation at the end of a token plus abbreviation/filename protection', () => {
  const { engine, spoken } = makeEngine()
  runText(engine, ['The config is package', '.json here. It works', ' now.'])
  assert.deepEqual(texts(spoken), ['The config is package.json here.', 'It works now.'])
})

test('3b. scanSafeCuts ignores decimals, versions and a bare trailing dot', () => {
  assert.deepEqual(scanSafeCuts('Pi is 3.14 exactly. Next.'), [19])
  assert.deepEqual(scanSafeCuts('Use v0.4.6 for this. Then.'), [20])
  assert.deepEqual(scanSafeCuts('A sentence with no trailing space.'), [], 'a dot at buffer end is not a cut yet')
})

// 4. multiple sentences in one delta ---------------------------------------
test('4. several sentences inside one delta are cut separately, in order', () => {
  const { engine, spoken } = makeEngine()
  runText(engine, ['One. Two. Three. Four. Five.'])
  assert.deepEqual(texts(spoken), ['One. Two. Three.', 'Four. Five.'])
})

// 5. one sentence split across many deltas ---------------------------------
test('5. one sentence arriving in many deltas flushes exactly once', () => {
  const { engine, spoken } = makeEngine()
  runText(engine, ['A', ' long', ' sentence', ' that', ' ends', ' here', '.', ' And', ' another', ' one', ' follows', '.'])
  assert.deepEqual(texts(spoken), ['A long sentence that ends here.', 'And another one follows.'])
})

// 6. final remainder without punctuation -----------------------------------
test('6. a final remainder without punctuation flushes once at settlement', () => {
  const { engine, spoken } = makeEngine()
  runText(engine, ['No punctuation at the end'])
  assert.deepEqual(texts(spoken), ['No punctuation at the end'])
})

// 7. reasoning before visible text -----------------------------------------
test('7. reasoning deltas are never spoken', () => {
  const { engine, spoken } = makeEngine()
  const { attemptId } = start(1, 1)
  push(engine, [{ type: 'start', attemptId, revision: 1, turn: 1, step: 1 }])
  push(engine, [{ type: 'chunk', attemptId, revision: 2, index: 0, time: 0, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } }])
  push(engine, [{ type: 'chunk', attemptId, revision: 3, index: 1, time: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'The user wants X. Let me think about Y. ' } }])
  push(engine, [{ type: 'chunk', attemptId, revision: 4, index: 2, time: 0, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'The user wants X. Let me think about Y. ' } } }])
  push(engine, textFrames(attemptId, 'Here is the answer. It is short.'))
  push(engine, [{ type: 'chunk', attemptId, revision: 9, index: 9, time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }])
  assert.deepEqual(texts(spoken), ['Here is the answer.', 'It is short.'])
})

// 8. tool-call-only generation ---------------------------------------------
test('8. a tool-call-only generation speaks nothing and never speaks JSON', () => {
  const { engine, spoken } = makeEngine()
  const { attemptId } = start(1, 1)
  push(engine, [{ type: 'start', attemptId, revision: 1, turn: 1, step: 1 }])
  push(engine, [{ type: 'chunk', attemptId, revision: 2, index: 0, time: 0, chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } }])
  push(engine, [{ type: 'chunk', attemptId, revision: 3, index: 1, time: 0, chunk: { type: 'tool-call-delta', index: 0, id: 'c1', name: 'read_file', argumentsDelta: '{"path":"C:/secret/notes.md","limit":' } }])
  push(engine, [{ type: 'chunk', attemptId, revision: 4, index: 2, time: 0, chunk: { type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: '50}' } }])
  push(engine, [{ type: 'chunk', attemptId, revision: 9, index: 9, time: 0, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } }])
  assert.deepEqual(spoken, [], 'no text means no synthesis: never synthesize silence or JSON')
  const settled = engine.onSettledMessage({ sid: SESSION, turn: 1, step: 1, text: '' })
  assert.equal(settled.mode, 'fallback')
})

// 9. acknowledgement + tool call -------------------------------------------
test('9. an acknowledgement before a tool call is spoken, then the tool JSON is not', () => {
  const { engine, spoken } = makeEngine()
  const { attemptId } = start(1, 1)
  push(engine, [{ type: 'start', attemptId, revision: 1, turn: 1, step: 1 }])
  push(engine, textFrames(attemptId, 'Sure, let me check that file.'))
  push(engine, [{ type: 'chunk', attemptId, revision: 3, index: 1, time: 0, chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } }])
  push(engine, [{ type: 'chunk', attemptId, revision: 4, index: 2, time: 0, chunk: { type: 'tool-call-delta', index: 1, id: 'c1', name: 'read_file', argumentsDelta: '{"path":"a.md"}' } }])
  assert.deepEqual(texts(spoken), ['Sure, let me check that file.'])
})

test('9b. flushOnToolCall=false defers the visible tail to settlement', () => {
  const { engine, spoken } = makeEngine(baseConfig({ liveFlushOnToolCall: false }))
  const { attemptId } = start(1, 1)
  push(engine, [{ type: 'start', attemptId, revision: 1, turn: 1, step: 1 }])
  push(engine, textFrames(attemptId, 'Checking now please wait.'))
  push(engine, [{ type: 'chunk', attemptId, revision: 3, index: 1, time: 0, chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } }])
  assert.deepEqual(spoken, [], 'deferred: nothing spoken at the tool-call boundary')
})

// 10. multi-step state -------------------------------------------------------
test('10. steps do not share an accumulator and reset per assistant generation', () => {
  const { engine, spoken } = makeEngine()
  // step 1: acknowledgement + tool call
  const s1 = start(1, 1)
  push(engine, [{ type: 'start', attemptId: s1.attemptId, revision: 1, turn: 1, step: 1 }])
  push(engine, textFrames(s1.attemptId, 'Let me check that now.'))
  push(engine, [{ type: 'chunk', attemptId: s1.attemptId, revision: 9, index: 9, time: 0, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } }])
  const settled1 = engine.onSettledMessage({ sid: SESSION, turn: 1, step: 1, text: 'Let me check that now.' })
  assert.equal(settled1.mode, 'remainder')
  assert.equal(settled1.remainder, '')

  // step 2: the final answer, a new attempt id
  runText(engine, ['The file contains three secrets. I removed them.'], { turn: 1, step: 2 })
  assert.deepEqual(texts(spoken), ['Let me check that now.', 'The file contains three secrets.', 'I removed them.'])
  const settled2 = engine.onSettledMessage({ sid: SESSION, turn: 1, step: 2, text: 'The file contains three secrets. I removed them.' })
  assert.equal(settled2.mode, 'remainder')
  assert.equal(settled2.remainder, '')
})

// 11. code block -------------------------------------------------------------
test('11. fenced code is never cut in half and is replaced by the spoken notice', () => {
  const { engine, spoken } = makeEngine()
  runText(engine, ['Here is the code: ```js\nconst a = 1\n``` and that is it.'])
  const all = texts(spoken).join(' ')
  assert.match(all, /code block/)
  assert.doesNotMatch(all, /const a/, 'code must not be read aloud')
})

test('11b. an unterminated fence at settlement is dropped, not spoken', () => {
  const { engine, spoken } = makeEngine()
  runText(engine, ['Here is the code: ```js\nconst a = 1\nconsole.log(a)'])
  const all = texts(spoken).join(' ')
  assert.doesNotMatch(all, /const a/)
  assert.match(all, /Here is the code/)
})

test('11c. helpers: fence detection and stripping', () => {
  assert.equal(hasOpenFence('a ```js\nb'), true)
  assert.equal(hasOpenFence('a ```js\nb\n``` c'), false)
  assert.equal(stripOpenFence('keep this ```js\ndrop this'), 'keep this ')
  assert.equal(stripOpenFence('keep ```x\n``` tail'), 'keep ```x\n``` tail')
})

test('11d. inline code spanning a delta boundary is not cut mid-tick', () => {
  const { engine, spoken } = makeEngine()
  runText(engine, ['Run `npm test', '` before you ship. It matters.'])
  const all = texts(spoken).join(' ')
  assert.match(all, /Run/, 'the sentence is still spoken')
  assert.doesNotMatch(all, /`/, 'no stray backtick reaches synthesis')
})

// 12. barge-in ---------------------------------------------------------------
test('12. barge-in aborts in-flight synthesis for the current step', () => {
  const { engine, spoken, dropped } = makeEngine()
  const { attemptId } = start(1, 1)
  push(engine, [{ type: 'start', attemptId, revision: 1, turn: 1, step: 1 }])
  push(engine, textFrames(attemptId, 'This sentence is long enough to flush. '))
  assert.equal(spoken.length, 1)
  assert.equal(spoken[0].signal.aborted, false)
  engine.abortAll(SESSION)
  assert.equal(spoken[0].signal.aborted, true, 'in-flight synthesis is cancelled')
  assert.deepEqual(dropped, [SESSION], 'host pending queue is dropped')
})

// 13. aborted stream ---------------------------------------------------------
test('13. an abandoned attempt cancels its own pieces without touching a later step', () => {
  const { engine, spoken, dropped } = makeEngine()
  const { attemptId } = start(2, 1)
  push(engine, [{ type: 'start', attemptId, revision: 1, turn: 2, step: 1 }])
  push(engine, textFrames(attemptId, 'A cancelled partial sentence here. ', 2, 1))
  push(engine, [{ type: 'end', attemptId, revision: 9, index: 9, outcome: { kind: 'abandoned' } }])
  assert.equal(spoken[0].signal.aborted, true)
  assert.deepEqual(dropped, [SESSION])

  // A later turn must start clean.
  const before = spoken.length
  runText(engine, ['A brand new turn speaks fine.'], { turn: 3, step: 1 })
  assert.equal(spoken.length, before + 1)
  assert.equal(spoken[before].signal.aborted, false)
})

// 14. duplication prevention -------------------------------------------------
test('14. the settled message never replays text the live stream already spoke', () => {
  const { engine, spoken } = makeEngine()
  const full = 'First sentence is here. Second sentence arrives later.'
  runText(engine, [full])
  assert.deepEqual(texts(spoken), ['First sentence is here.', 'Second sentence arrives later.'])
  const settled = engine.onSettledMessage({ sid: SESSION, turn: 1, step: 1, text: full })
  assert.equal(settled.mode, 'remainder')
  assert.equal(settled.remainder, '', 'nothing is left to speak')
})

test('14b. text that arrives after the last cut is spoken once, as the remainder', () => {
  const { engine, spoken } = makeEngine()
  const { attemptId } = start(1, 1)
  push(engine, [{ type: 'start', attemptId, revision: 1, turn: 1, step: 1 }])
  push(engine, textFrames(attemptId, 'This piece flushes immediately. And the tail'))
  // No finish frame: the durable message settles first (interrupted turn).
  const settled = engine.onSettledMessage({
    sid: SESSION, turn: 1, step: 1,
    text: 'This piece flushes immediately. And the tail',
  })
  assert.deepEqual(texts(spoken), ['This piece flushes immediately.'])
  assert.equal(settled.mode, 'remainder')
  assert.equal(settled.remainder, 'And the tail')
})

test('14c. divergent durable text speaks only the unsaid tail (never a replay)', () => {
  const result = reconcileRemainder('Hello there. Second part spoken.', 'Hello there. Second part spoken differently.')
  assert.equal(result.mode, 'remainder')
  assert.equal(result.remainder, 'differently.')
  assert.ok(result.overlap > 0)
})

test('14d. a retry of the same step never re-speaks the first attempt', () => {
  const { engine, spoken } = makeEngine()
  const first = start(1, 1)
  push(engine, [{ type: 'start', attemptId: first.attemptId, revision: 1, turn: 1, step: 1 }])
  push(engine, textFrames(first.attemptId, 'The first attempt said this. '))
  push(engine, [{ type: 'end', attemptId: first.attemptId, revision: 9, index: 9, outcome: { kind: 'abandoned' } }])
  assert.equal(spoken.length, 1)

  // Retry: same turn and step, new attempt id, same prefix plus a new tail.
  const retry = start(1, 1)
  push(engine, [{ type: 'start', attemptId: retry.attemptId, revision: 1, turn: 1, step: 1 }])
  push(engine, textFrames(retry.attemptId, 'The first attempt said this. And then more.'))
  const settled = engine.onSettledMessage({
    sid: SESSION, turn: 1, step: 1,
    text: 'The first attempt said this. And then more.',
  })
  assert.equal(settled.mode, 'remainder')
  assert.equal(settled.remainder, 'And then more.', 'the shared prefix is not repeated')
})

// 15. fallback ---------------------------------------------------------------
test('15. no live text means the durable path keeps full ownership', () => {
  const { engine } = makeEngine()
  const settled = engine.onSettledMessage({ sid: SESSION, turn: 1, step: 1, text: 'Never streamed at all.' })
  assert.equal(settled.mode, 'fallback')
  assert.equal(settled.remainder, 'Never streamed at all.')
})

// minimum-fragment policy ----------------------------------------------------
test('min-fragment: a short opener joins the next sentence, and the knob can change that', () => {
  const patient = makeEngine()
  runText(patient.engine, ['Sure. Here is a much longer explanation of what happened.'])
  assert.deepEqual(texts(patient.spoken), ['Sure. Here is a much longer explanation of what happened.'])

  const eager = makeEngine(baseConfig({ liveMinCharsFirst: 3 }))
  runText(eager.engine, ['Sure. Here is a much longer explanation of what happened.'])
  assert.deepEqual(texts(eager.spoken), ['Sure.', 'Here is a much longer explanation of what happened.'])
})

test('over-long sentences are force-cut at a word boundary instead of stalling', () => {
  const cursor = createLiveCursor()
  const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ')
  cursor.raw = words
  // One drain call consumes everything available; over-long text is cut at word
  // boundaries so a paragraph with no punctuation can never stall the stream.
  const pieces = drainPieces(cursor, { minCharsFirst: 12, minChars: 48, maxChars: 90, final: false })
  assert.ok(pieces.length > 1, 'a wall of text is split, not held')
  for (const piece of pieces) {
    assert.ok(piece.length <= 90, `piece too long: ${piece.length}`)
    assert.equal(piece, piece.trim())
  }
  // The last incomplete stretch waits for more text (or settlement) rather than
  // being force-cut below the cap; the final pass then flushes it once.
  const tail = drainPieces(cursor, { minCharsFirst: 12, minChars: 48, maxChars: 90, final: true })
  assert.equal(tail.length, 1, 'the tail flushes once at settlement')
  assert.equal(tail[0].endsWith('word119'), true)
  const all = [...pieces, ...tail].join(' ')
  assert.equal(all.split(/\s+/).length, 120, 'no text is lost')
  assert.deepEqual(drainPieces(cursor, { minCharsFirst: 12, minChars: 48, maxChars: 90, final: true }), [], 'idempotent')
})

test('turn boundary forgets state so a later turn cannot inherit ownership', () => {
  const { engine, spoken } = makeEngine()
  const { attemptId } = start(1, 1)
  push(engine, [{ type: 'start', attemptId, revision: 1, turn: 1, step: 1 }])
  push(engine, textFrames(attemptId, 'A sentence that flushed right away. '))
  assert.equal(spoken.length, 1)
  engine.releaseSession(SESSION)
  const settled = engine.onSettledMessage({ sid: SESSION, turn: 1, step: 1, text: 'A sentence that flushed right away.' })
  assert.equal(settled.mode, 'fallback', 'the released step falls back to the durable path')
})
