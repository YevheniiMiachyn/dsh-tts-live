/**
 * Inference-free tests for barge-in silence (0.4.16-local.4).
 *
 * Aborting in-flight synthesis and dropping the queued slots stops speech *now*.
 * It does not stop it *resuming*: the agent loop keeps emitting frames for the same
 * turn, and every sentence completed after the interruption was synthesized and
 * spoken. These cases drive that exact window — text that arrives after the
 * barge-in — and assert that the turn is silenced while its text is still claimed,
 * because the claim is what keeps the durable settlement from reading the remainder
 * aloud afterwards.
 *
 * Run: node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createLiveEngine } from '../lib/live.js'
import { stripForSpeech, speechPhrases } from '../lib/text.js'

const SESSION = 'sess-1'
const OTHER = 'sess-2'

const OPENING = 'This is the opening sentence and it is comfortably long enough to be spoken. '
const LATER = 'This second sentence arrives after the interruption and must never be heard. '
const THIRD = 'And this closing sentence is a third piece that must stay silent as well. '

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

/** Real scrub pipeline, exactly as index.js composes it. */
function cleanText(raw, cfg) {
  return stripForSpeech(raw, cfg.maxChars, {
    skipCode: cfg.skipCode !== false,
    phrases: speechPhrases(cfg.language),
  })
}

function makeEngine(config = baseConfig()) {
  const spoken = []
  const dropped = []
  const engine = createLiveEngine({
    live: () => config,
    cleanText,
    speakPiece: (sid, text, cfg, kind, signal, meta) => { spoken.push({ sid, text, kind, meta }) },
    dropPendingForSession: (sid) => { dropped.push(sid) },
    log: () => {},
  })
  return { engine, spoken, dropped, config }
}

let attemptSeq = 0

/** One live start frame, as dsh-agent-loop emits at attempt begin. */
function startFrame(turn, step = 1) {
  return { type: 'start', attemptId: `a${++attemptSeq}`, revision: 1, turn, step }
}

/** One visible-text chunk frame for a started attempt. */
function textFrame(attemptId, text) {
  return { type: 'chunk', attemptId, revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text } }
}

/** Feed one frame to the engine as one session's stream frame. */
function send(engine, sid, frame) {
  engine.onFrame({ agent: { session: { id: sid } }, frame })
}

/** Start a step and stream `text` into it; returns the attemptId. */
function stream(engine, sid, turn, step, text) {
  const frame = startFrame(turn, step)
  send(engine, sid, frame)
  send(engine, sid, textFrame(frame.attemptId, text))
  return frame.attemptId
}

/** The cursor the engine keeps for one step, for claim bookkeeping assertions. */
function cursorFor(engine, sid, turn, step) {
  return engine._state.steps.get(`${sid}|${turn}|${step}`)
}

test('text that arrives after a barge-in is claimed but never spoken', () => {
  const { engine, spoken, dropped } = makeEngine()

  const attemptId = stream(engine, SESSION, 2, 1, OPENING)
  assert.equal(spoken.length, 1, 'the sentence completed before the interruption is heard')
  assert.match(spoken[0].text, /opening sentence/)

  engine.abortAll(SESSION)
  assert.deepEqual(dropped, [SESSION], 'the host queue drop is requested')

  // The model keeps generating the same turn after the interruption.
  send(engine, SESSION, textFrame(attemptId, LATER))
  send(engine, SESSION, textFrame(attemptId, THIRD))

  assert.equal(spoken.length, 1, 'nothing after the barge-in is spoken')
  const cursor = cursorFor(engine, SESSION, 2, 1)
  assert.equal(cursor.pieces, 3, 'all three sentences were still claimed by the cutter')
  assert.ok(cursor.claimedEnd > OPENING.length, 'the silenced text advanced the claim, so settlement cannot replay it')
})

test('the settlement of a silenced turn speaks no remainder', () => {
  const { engine, spoken } = makeEngine()

  const attemptId = stream(engine, SESSION, 2, 1, OPENING)
  engine.abortAll(SESSION)
  send(engine, SESSION, textFrame(attemptId, LATER))

  const settled = engine.onSettledMessage({ sid: SESSION, turn: 2, step: 1, text: OPENING + LATER + THIRD })
  assert.equal(settled.mode, 'remainder')
  assert.equal(settled.remainder, '', 'a silenced turn owes the durable path nothing')
  assert.equal(spoken.length, 1)
})

test('a barge-in before the first sentence silences the whole message', () => {
  const { engine, spoken } = makeEngine()

  const frame = startFrame(4, 1)
  send(engine, SESSION, frame)
  // Below `liveMinCharsFirst`: the cutter has handed out no piece yet, so the cursor
  // holds zero pieces when the barge-in lands. This is the case that would otherwise
  // fall through to the "nothing was spoken, speak the whole message" fallback.
  send(engine, SESSION, textFrame(frame.attemptId, 'Hello'))
  engine.abortAll(SESSION)

  assert.equal(spoken.length, 0, 'nothing had been flushed yet')
  const settled = engine.onSettledMessage({ sid: SESSION, turn: 4, step: 1, text: 'Hello there, this is the full reply.' })
  assert.deepEqual(settled, { mode: 'remainder', remainder: '' }, 'the pieces === 0 fallback must not fire')
  assert.equal(spoken.length, 0)
})

test('muting is scoped to the turn that was interrupted', () => {
  const { engine, spoken } = makeEngine()

  const interrupted = stream(engine, SESSION, 2, 1, OPENING)
  engine.abortAll(SESSION)
  send(engine, SESSION, textFrame(interrupted, LATER))
  assert.equal(spoken.length, 1)

  const settled = engine.onSettledMessage({ sid: SESSION, turn: 2, step: 1, text: OPENING + LATER })
  assert.deepEqual(settled, { mode: 'remainder', remainder: '' })
  assert.equal(engine._state.mutedTurns.size, 0, 'the muted turn consumes its entry when it settles')

  // A new turn of the same session must be audible again.
  stream(engine, SESSION, 3, 1, OPENING)
  assert.equal(spoken.length, 2, 'the next turn speaks again')
  assert.equal(spoken[1].text, spoken[0].text)
})

test('the settlement of a silenced turn stays silent for the next turn', () => {
  const { engine, spoken } = makeEngine()

  stream(engine, SESSION, 2, 1, OPENING)
  engine.abortAll(SESSION)
  // Turn 3 starts before turn 2 settles — the ordering a fast follow-up produces.
  // Pruning at the new turn must not revive turn 2's remainder.
  stream(engine, SESSION, 3, 1, OPENING)
  assert.equal(spoken.length, 2)

  const settled = engine.onSettledMessage({ sid: SESSION, turn: 2, step: 1, text: OPENING + LATER })
  assert.deepEqual(settled, { mode: 'remainder', remainder: '' }, 'turn 2 stays silenced after its mute is pruned')
  assert.equal(spoken.length, 2)
})

test('a barge-in on one session does not silence another', () => {
  const { engine, spoken } = makeEngine()

  stream(engine, SESSION, 2, 1, OPENING)
  const otherAttempt = stream(engine, OTHER, 2, 1, OPENING)
  assert.equal(spoken.length, 2)

  engine.abortAll(SESSION)
  send(engine, OTHER, textFrame(otherAttempt, LATER))

  assert.equal(spoken.length, 3, 'the other session keeps speaking')
  assert.equal(spoken[2].sid, OTHER)
})

test('a session-wide barge-in silences every session', () => {
  const { engine, spoken, dropped } = makeEngine()

  const mineAttempt = stream(engine, SESSION, 2, 1, OPENING)
  const otherAttempt = stream(engine, OTHER, 2, 1, OPENING)
  assert.equal(spoken.length, 2)

  // What the browser actually posts: /dsh-tts/bargein with an empty body.
  engine.abortAll(undefined)
  send(engine, SESSION, textFrame(mineAttempt, LATER))
  send(engine, OTHER, textFrame(otherAttempt, LATER))

  assert.equal(spoken.length, 2, 'no session speaks after a session-wide barge-in')
  assert.deepEqual(dropped, [undefined])
})

test('a silenced turn is not resurrected by a duplicate settlement', () => {
  const { engine, spoken } = makeEngine()

  const attemptId = stream(engine, SESSION, 5, 1, OPENING)
  engine.abortAll(SESSION)
  send(engine, SESSION, textFrame(attemptId, LATER))

  const text = OPENING + LATER
  assert.deepEqual(engine.onSettledMessage({ sid: SESSION, turn: 5, step: 1, text }), { mode: 'remainder', remainder: '' })
  assert.deepEqual(engine.onSettledMessage({ sid: SESSION, turn: 5, step: 1, text }), { mode: 'remainder', remainder: '' })
  assert.equal(spoken.length, 1, 'two settlements still speak nothing')
})

test('a silenced multi-step turn stays silent across its later steps', () => {
  const { engine, spoken } = makeEngine()

  const step1 = stream(engine, SESSION, 9, 1, OPENING)
  engine.abortAll(SESSION)
  send(engine, SESSION, textFrame(step1, LATER))

  // A tool call ends step 1 and the turn continues in step 2 — the same turn, so it
  // is silenced too.
  const step2 = stream(engine, SESSION, 9, 2, OPENING)
  send(engine, SESSION, textFrame(step2, LATER))

  assert.equal(spoken.length, 1, 'later steps of the interrupted turn are silent')
  assert.deepEqual(engine.onSettledMessage({ sid: SESSION, turn: 9, step: 2, text: OPENING + LATER }), {
    mode: 'remainder',
    remainder: '',
  })
  assert.equal(spoken.length, 1)
})

test('a barge-in between steps silences the step that has not flushed yet', () => {
  const { engine, spoken } = makeEngine()

  const step1 = stream(engine, SESSION, 11, 1, OPENING)
  send(engine, SESSION, textFrame(step1, LATER))
  assert.equal(spoken.length, 2)

  // Step 2 has started but produced no piece yet when the user talks: there is no
  // cursor with pieces to find, so only the in-progress turn covers this.
  const step2 = startFrame(11, 2)
  send(engine, SESSION, step2)
  engine.abortAll(SESSION)
  send(engine, SESSION, textFrame(step2.attemptId, OPENING))

  assert.equal(spoken.length, 2, 'the unflushed step of the interrupted turn stays silent')
})

test('a barge-in while a different turn is streaming does not silence the next turn', () => {
  const { engine, spoken } = makeEngine()

  // Turn 1 was interrupted long ago; turn 2 is a fresh reply the user is waiting for.
  stream(engine, SESSION, 1, 1, OPENING)
  engine.abortAll(SESSION)
  assert.equal(spoken.length, 1)

  stream(engine, SESSION, 2, 1, OPENING)
  assert.equal(spoken.length, 2, 'over-muting would swallow a legitimate reply')
})

test('the mute bookkeeping stays bounded', () => {
  const { engine } = makeEngine()

  // A barge-in on a turn whose session never streams again must not accumulate.
  for (let turn = 0; turn < 200; turn++) {
    stream(engine, `sess-${turn}`, 1, 1, OPENING)
    engine.abortAll(`sess-${turn}`)
  }
  assert.ok(engine._state.mutedTurns.size <= 64, `mutes stay capped, saw ${engine._state.mutedTurns.size}`)
  assert.equal(engine._state.mutedTurns.size, 64)
})
