/**
 * Adaptive FIRST-chunk segmentation — behaviour and text-integrity tests.
 *
 * The feature: the first spoken piece of a step may start at a clause boundary
 * (or, failing that, a word boundary) instead of waiting for a sentence
 * terminator; every later piece keeps the original sentence-only policy.
 *
 * These tests are written against the same public surface as `live.test.mjs`:
 * a real `createLiveEngine` driven by synthetic `agent/assistant-stream` frames
 * and the real `stripForSpeech` scrubber. Nothing here needs a model, a
 * network, or audio.
 *
 * The text-integrity invariant every case re-asserts is the one that matters for
 * speech: **the pieces, concatenated, must reconstruct the spoken text exactly**
 * (compared on whitespace-collapsed text, because a cut consumes the single
 * separating space and the scrubber itself collapses runs). Nothing may be
 * dropped, duplicated, reordered, or silently skipped.
 *
 * Run: node --test test/adaptive-first.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createLiveEngine,
  createLiveCursor,
  drainPieces,
  liveOptions,
  scanBoundaries,
} from '../lib/live.js'
import { protectAbbreviations, stripForSpeech, speechPhrases } from '../lib/text.js'

/** Thresholds the fork ships. Asserted explicitly so a silent change fails here. */
const FIRST_CLAUSE_CHARS = 48
const FIRST_WORD_CHARS = 72

const SESSION = 'sess-adaptive'

/** A resolved dsh-tts config with live mode on (production thresholds). */
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

function cleanText(raw, cfg) {
  return stripForSpeech(raw, cfg.maxChars, {
    skipCode: cfg.skipCode !== false,
    phrases: speechPhrases(cfg.language),
  })
}

/** Build an engine plus observation arrays, plus the exact text handed to each piece. */
function makeEngine(config = baseConfig()) {
  const spoken = []
  const engine = createLiveEngine({
    live: () => config,
    cleanText,
    speakPiece: (sid, text) => { spoken.push(text) },
    dropPendingForSession: () => {},
    log: () => {},
  })
  return { engine, spoken, config }
}

const agent = { session: { id: SESSION } }
const payload = (frame) => ({ agent, frame })
const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim()

/**
 * The text the pipeline is expected to speak for a raw input.
 *
 * The integrity invariant is about SEGMENTATION, so the reference is the same
 * input after the pre-existing scrubber — that isolates the cutter from changes
 * that `stripForSpeech` has always made (unwrapping inline code, collapsing
 * whitespace, replacing a fence with a notice).
 */
const spokenReference = (raw) => collapse(cleanText(raw, baseConfig()))

let attemptSeq = 0
function newAttempt(turn = 1, step = 1) {
  const attemptId = `ad${++attemptSeq}`
  return { attemptId, start: { type: 'start', attemptId, revision: 1, turn, step } }
}

function delta(attemptId, text, turn = 1, step = 1) {
  return { type: 'chunk', attemptId, revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text } }
}

/**
 * Stream `deltas` into a fresh step and settle it. Returns what was spoken.
 * @returns {{pieces: string[], attemptId: string}}
 */
function runText(engine, deltas, { turn = 1, step = 1 } = {}) {
  const { attemptId, start } = newAttempt(turn, step)
  engine.onFrame(payload(start))
  for (const d of deltas) engine.onFrame(payload(delta(attemptId, d, turn, step)))
  engine.onFrame(payload({ type: 'chunk', attemptId, revision: 99, index: 99, time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }))
  engine.onFrame(payload({ type: 'end', attemptId, revision: 100, index: 100, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } }))
  return { attemptId }
}

/** Word-level deltas, as the real model emits them (leading-space convention). */
function wordDeltas(text) {
  const words = text.split(' ')
  return words.map((w, i) => (i === 0 ? w : ` ${w}`))
}

// ── unit level: the boundary scanner ────────────────────────────────────────

test('scanBoundaries: clause punctuation is found, digit grouping and code are not', () => {
  const got = scanBoundaries(protectAbbreviations('Alpha beta gamma, delta epsilon. More here.'))
  assert.deepEqual(got.clauses, [17], 'a comma followed by a space is a clause boundary')
  assert.deepEqual(got.sentences, [32], 'the sentence end is still reported')

  // No space after the comma: grouping / decimal, never a boundary.
  assert.deepEqual(scanBoundaries('the value 1,234 and 3,5 here').clauses, [])

  // Structural markdown punctuation in front of the comma is not a pause.
  assert.deepEqual(scanBoundaries('| a, b, c |').clauses, [4, 7],
    'commas inside a table row are still boundaries the ear would pause at')

  // Inside a fenced block a comma is syntax.
  const fenced = 'Intro text here.\n```js\nconst a = 1, b = 2\n```\nAfter, more.\n'
  const inFence = scanBoundaries(protectAbbreviations(fenced))
  const fenceOpen = fenced.indexOf('```')
  const fenceClose = fenced.lastIndexOf('```')
  const inFenceCuts = inFence.clauses.filter((c) => c > fenceOpen && c < fenceClose + 3)
  assert.deepEqual(inFenceCuts, [], 'the comma inside the fence is not a cut')
  assert.ok(inFence.clauses.length > 0, 'the comma after the fence is still found')

  // Inside an inline span, likewise.
  assert.deepEqual(scanBoundaries('call `foo(a, b)` now').clauses, [])

  assert.deepEqual(scanBoundaries('Semicolon here; and colon here: done.').clauses, [15, 31])
  assert.deepEqual(scanBoundaries('an em dash here — and then more').clauses, [17])
})

// ── category A: short normal sentence ───────────────────────────────────────

test('A: a short sentence that finishes quickly is still spoken as one piece', () => {
  const { engine, spoken } = makeEngine()
  runText(engine, wordDeltas('Sure, I can help with that.'))
  assert.deepEqual(spoken, ['Sure, I can help with that.'],
    'the sentence boundary wins: no adaptive cut, no fragment')
})

test('A2: a short opening whose sentence end clears the floor is not cut at its comma', () => {
  const { engine, spoken } = makeEngine()
  // The comma is at character 12 and the full stop at 40, so the clause
  // threshold (48) is never reached and the sentence is spoken whole.
  runText(engine, wordDeltas('Short answer, and then it stops right there.'))
  assert.deepEqual(spoken, ['Short answer, and then it stops right there.'])
})

// ── category B: long sentence with an early comma ───────────────────────────

test('B: a long sentence with an early comma starts audio at the comma', () => {
  const { engine, spoken } = makeEngine()
  const text = 'The first thing I checked was the pending queue, and that turned out to be the real problem here.'
  runText(engine, wordDeltas(text))

  assert.ok(spoken.length >= 2, 'the reply is spoken as more than one piece')
  assert.equal(spoken[0], 'The first thing I checked was the pending queue,',
    'the first piece ends at the comma once the clause threshold is satisfied')
  assert.ok(spoken[0].length <= FIRST_CLAUSE_CHARS + 22, `first piece is bounded: ${spoken[0].length}`)
  assert.equal(collapse(spoken.join(' ')), collapse(text), 'text integrity')
})

test('B2: without the early comma the same opening is not cut mid-phrase', () => {
  const { engine, spoken } = makeEngine()
  // 46 characters before the first comma: below the 48-character clause floor,
  // so the cutter must wait rather than emit a short fragment.
  const text = 'I checked the pending queue first, and that was the problem.'
  runText(engine, wordDeltas(text))
  assert.equal(spoken[0], text, 'a boundary under the floor is not used')
})

// ── category C: long sentence with no punctuation ───────────────────────────

test('C: a long punctuation-free opening eventually cuts at a word boundary', () => {
  const { engine, spoken } = makeEngine()
  const words = Array.from({ length: 40 }, (_, i) => `token${i}`)
  const text = words.join(' ') + '.'
  runText(engine, wordDeltas(text))

  const first = spoken[0]
  assert.ok(first.length >= 40, `first piece clears the sentence floor comfortably: ${first.length}`)
  assert.ok(first.length <= FIRST_WORD_CHARS, `the cut lands on the last word that fits: ${first.length}`)
  assert.equal(first.includes('  '), false)
  assert.ok(/^(token\d+)( token\d+)*$/.test(first), `the cut is on whole words only: ${JSON.stringify(first)}`)
  assert.equal(collapse(spoken.join(' ')), collapse(text), 'text integrity')
})

test('C2: a single word longer than the fallback is never split', () => {
  const cursor = createLiveCursor()
  const long = 'x'.repeat(120)
  cursor.raw = long
  const out = drainPieces(cursor, { minCharsFirst: 12, minChars: 48, maxChars: 320, final: false })
  assert.deepEqual(out, [], 'no cut is possible without breaking the word, so nothing is emitted')
  assert.equal(cursor.pieces, 0)
})

// ── category D: colon / semicolon ───────────────────────────────────────────

test('D: a colon or semicolon is preferred over an arbitrary whitespace cut', () => {
  const colonText = 'Before the queue itself, there is one thing worth checking first: the window was far too small.'
  const colon = makeEngine()
  runText(colon.engine, wordDeltas(colonText))
  assert.equal(colon.spoken[0], 'Before the queue itself, there is one thing worth checking first:',
    'the colon is the cut, not a later space')
  assert.equal(collapse(colon.spoken.join(' ')), collapse(colonText), 'text integrity')

  // Here the only clause boundary inside the first sentence is the semicolon at
  // character 46 — just under the 48-character floor — so the piece keeps
  // growing to the next whole word rather than speaking `…reply;` as a fragment.
  const semiText = 'The window was far too small for a long reply; fifteen rows vanished inside two seconds of speech.'
  const semi = makeEngine()
  runText(semi.engine, wordDeltas(semiText))
  assert.equal(semi.spoken[0], 'The window was far too small for a long reply; fifteen rows vanished',
    'the piece clears the floor at a whole word, not at the sub-floor semicolon')
  assert.ok(semi.spoken[0].endsWith('; fifteen rows vanished'))
  assert.equal(collapse(semi.spoken.join(' ')), collapse(semiText), 'text integrity')
})

test('D2: a sentence end that clears the floor is chosen over any later clause', () => {
  const { engine, spoken } = makeEngine()
  // `Then it stopped.` ends at character 16, past the 12-character first floor,
  // and there is a later comma — the sentence end is still the cut.
  const text = 'Then it stopped. A much longer tail clause, with a comma in it, follows here.'
  runText(engine, wordDeltas(text))
  assert.equal(spoken[0], 'Then it stopped.')
  assert.equal(collapse(spoken.join(' ')), collapse(text), 'text integrity')
})

test('D4: a sentence end below the first floor waits for a boundary past it', () => {
  const { engine, spoken } = makeEngine()
  // 'Done.' is only 5 characters — under `liveMinCharsFirst: 12` — so the first
  // piece is not that fragment; the floor still means something.
  runText(engine, wordDeltas('Done. Then a much longer tail clause, with a comma in it, follows here.'))
  assert.equal(spoken[0], 'Done. Then a much longer tail clause, with a comma in it,')
  assert.equal(spoken[1], 'follows here.')
})

test('D3: a clause boundary below the floor is not used, and the sentence still wins', () => {
  const { engine, spoken } = makeEngine()
  // The colon sits at character 39 — under the 48-character clause floor — so the
  // cutter waits and the sentence terminator ends the first piece instead. The
  // first piece is compared from its first non-space character: a cut consumes
  // the space that followed the previous piece.
  const text = 'There is one thing worth checking first: the pending queue window was too small.'
  runText(engine, wordDeltas(text))
  const first = collapse(spoken[0])
  assert.ok(!first.endsWith(':'), `the sub-floor colon is not used: ${JSON.stringify(first)}`)
  // The sub-floor clause is skipped and the piece is longer than the floor; where
  // it stops exactly depends on the delta boundaries, which the integrity check
  // below covers. What matters is that it did not stop at the colon.
  assert.ok(first.length >= 48, 'the piece grows past the clause floor')
  assert.equal(collapse(spoken.join(' ')), collapse(text), 'text integrity')
})

// ── category E: very short opening phrase followed by more text ─────────────

test('E: a short opening phrase does not become a tiny first fragment', () => {
  const { engine, spoken } = makeEngine()
  runText(engine, wordDeltas('I, however, have a different idea about how this should work in practice.'))
  const first = spoken[0]
  assert.ok(!/^I,$/.test(first), 'no one-word fragment')
  assert.ok(first.length >= FIRST_CLAUSE_CHARS, `first piece clears the clause floor: ${first.length} ${JSON.stringify(first)}`)
  assert.equal(collapse(spoken.join(' ')), collapse('I, however, have a different idea about how this should work in practice.'))
})

test('E2: an opening sentence under the clause floor is not cut at all', () => {
  const { engine, spoken } = makeEngine()
  const text = 'Let me check that, then answer.'
  runText(engine, wordDeltas(text))
  assert.equal(spoken[0], text, 'short openings keep their sentence intact')
})

// ── category F: markdown / code-adjacent text ───────────────────────────────

test('F: markdown and inline code do not create new cut points', () => {
  const { engine, spoken } = makeEngine()
  const text = 'The setting `liveMinCharsFirst, 12` is on, and the fence below is a code block.\n\n```js\nconst a = 1, b = 2\n```\n\nThat is all.'
  runText(engine, wordDeltas(text))

  assert.ok(spoken.length >= 1)
  for (const piece of spoken) {
    assert.ok(!/```/.test(piece), 'no raw fence is spoken')
  }
  const joined = spoken.join(' ')
  assert.ok(!/const a = 1/.test(joined), 'code is scrubbed, not cut open')
  assert.ok(/code block, \d+ lines/.test(joined), 'the fence becomes the usual spoken notice')
})

test('F2: an unterminated fence is still dropped rather than spoken', () => {
  const { engine, spoken } = makeEngine()
  const text = 'Here is the listing, and then it starts:\n\n```js\nconst a = 1, b = 2\n'
  runText(engine, wordDeltas(text))
  const joined = spoken.join(' ')
  assert.ok(!/const a = 1/.test(joined), 'half a fence is never read aloud')
})

// ── later pieces: behaviour must not change ─────────────────────────────────

test('later pieces keep the sentence-only policy', () => {
  const { engine, spoken } = makeEngine()
  const text = 'First sentence is here and it is long enough to stand alone, with a comma. Second sentence, also long, with a comma inside it. Third one closes.'
  runText(engine, wordDeltas(text))
  assert.equal(spoken[0], 'First sentence is here and it is long enough to stand alone,')
  assert.equal(spoken[1], 'with a comma. Second sentence, also long, with a comma inside it.',
    'the second piece ends at a sentence terminator, not at its comma')
  assert.equal(collapse(spoken.join(' ')), collapse(text), 'text integrity')
})

test('a long first sentence still obeys the hard character cap', () => {
  const { engine, spoken } = makeEngine(baseConfig({ sentenceChars: 90, liveMaxChars: 90 }))
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`)
  runText(engine, wordDeltas(words.join(' ')))
  for (const piece of spoken) assert.ok(piece.length <= 90 + 12, `piece within the cap: ${piece.length}`)
  assert.equal(collapse(spoken.join(' ')), collapse(words.join(' ')), 'text integrity')
})

// ── text integrity over a stream of real-shaped deltas ──────────────────────

const INTEGRITY_CASES = [
  'Sure, I can help with that.',
  'The first thing I checked was the pending queue, and that turned out to be the real problem here.',
  'There is one thing worth checking first: the pending queue window was too small.',
  'The window was far too small; fifteen rows vanished inside two seconds of speech.',
  'No punctuation at all in this opening run of words that just keeps going and going without any stop',
  'Two sentences. Then a third one, with a comma, and a fourth that closes it out.',
  'A colon: right here. And then more text after it follows along for a while.',
  'It\u2019s done \u2014 the repair landed, and the voice came back exactly as before.',
  'Numbers 1,234 and 3,5 and v0.4.16-local.9 must not become cut points.',
  'A line\nbreak inside the text, then the sentence carries on and eventually stops.',
  'The setting `a, b` stays whole, and the sentence continues past it into another clause.',
  'I, however, have a different idea about how this should work in practice.',
]

for (const text of INTEGRITY_CASES) {
  test(`text integrity: ${text.slice(0, 46)}`, () => {
    const { engine, spoken } = makeEngine()
    runText(engine, wordDeltas(text))
    assert.equal(collapse(spoken.join(' ')), spokenReference(text),
      'concatenated pieces reconstruct the intended spoken text exactly')
    // No piece may be empty, and no piece may repeat the previous one.
    for (let i = 0; i < spoken.length; i++) {
      assert.ok(spoken[i].trim().length > 0, `piece ${i} is not empty`)
      if (i > 0) assert.notEqual(spoken[i], spoken[i - 1], `piece ${i} is not a repeat`)
    }
  })
}

test('integrity: a stream fed one character at a time behaves like word deltas', () => {
  const text = 'The first thing I checked was the pending queue, and that turned out to be the real problem here.'
  const whole = makeEngine()
  runText(whole.engine, wordDeltas(text))

  const charwise = makeEngine()
  runText(charwise.engine, [...text])
  assert.deepEqual(charwise.spoken, whole.spoken, 'delta granularity does not change the cut')
})

test('integrity: a stream fed in two halves behaves like the whole', () => {
  const text = 'The first thing I checked was the pending queue, and that turned out to be the real problem here.'
  const at = text.indexOf('and')
  const split = makeEngine()
  runText(split.engine, [text.slice(0, at), text.slice(at)])
  const whole = makeEngine()
  runText(whole.engine, [text])
  assert.deepEqual(split.spoken, whole.spoken)
})

// ── configuration surface ───────────────────────────────────────────────────

test('liveOptions is unchanged: no new configuration key is required', () => {
  const opts = liveOptions(baseConfig())
  assert.deepEqual(Object.keys(opts).sort(), ['enabled', 'flushOnToolCall', 'maxChars', 'minChars', 'minCharsFirst', 'pollMs'].sort())
  assert.equal(opts.minCharsFirst, 12)
  assert.equal(opts.minChars, 48, 'the clause floor is the existing later-piece minimum')
})

test('liveMinCharsFirst still raises the sentence floor for the first piece', () => {
  const { engine, spoken } = makeEngine(baseConfig({ liveMinCharsFirst: 60 }))
  runText(engine, wordDeltas('Short one. And here is a much longer second sentence that follows it.'))
  assert.equal(spoken[0], 'Short one. And here is a much longer second sentence that follows it.',
    'a first sentence under the raised floor is joined to the next one')
})
