/**
 * Tests for how markdown code reaches the synthesizer (0.4.16-local.5).
 *
 * Upstream deleted every inline `` `span` `` before speaking. That is correct for a
 * fenced block and wrong for an identifier inside a sentence: the words around it
 * survive and the span becomes a hole, so a reply heard aloud says "the installed
 * plugin is , and it works". These cases use the real sentence that was observed
 * being spoken that way, and they assert the invariant that matters — no hole —
 * rather than only the presence of the missing text.
 *
 * Run: node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { stripForSpeech, speechPhrases, splitSentences } from '../lib/text.js'

const PHRASES = speechPhrases('en')
const speak = (raw, over = {}) => stripForSpeech(raw, 0, { skipCode: true, phrases: PHRASES, ...over })

// The sentence exactly as it was written, and as it was heard (the version and the
// setting name were both missing from the audio).
const REAL = 'Everything the restart needed to pick up is live: `bargeIn` now reads **True** '
  + '(it was false before), the installed plugin is `0.4.16-local.4`, and the Akeno voice re-registered.'

test('an inline span is spoken, not dropped', () => {
  const out = speak('the installed plugin is `0.4.16-local.4`, and it works')
  assert.match(out, /0\.4\.16-local\.4/)
  assert.ok(!/is\s+,/.test(out), `the sentence must not have a hole: ${JSON.stringify(out)}`)
})

test('the real reply no longer loses its version or its setting name', () => {
  const out = speak(REAL)
  assert.match(out, /bargeIn/, 'the setting name survives')
  assert.match(out, /0\.4\.16-local\.4/, 'the version survives')
  assert.match(out, /the installed plugin is 0\.4\.16-local\.4, and the Akeno voice re-registered\./)
  assert.ok(!/is\s+,/.test(out), `no hole before the comma: ${JSON.stringify(out)}`)
})

test('markdown emphasis around a span still resolves', () => {
  const out = speak('reads **True** now')
  assert.equal(out, 'reads True now')
})

test('a fenced block is still replaced by its spoken notice, never read out', () => {
  const out = speak('Here it is:\n\n```js\nconst secret = 1\nconsole.log(secret)\n```\n\nThat is all.')
  // The info string line and the closing fence are not content: two lines.
  assert.match(out, /code block, 2 lines/)
  assert.doesNotMatch(out, /console\.log/, 'the listing must not be spoken')
  assert.doesNotMatch(out, /secret/)
})

test('several spans in one sentence all survive', () => {
  const out = speak('copy `a.txt` then `b.txt` into `C:/tmp`, then stop')
  assert.equal(out, 'copy a.txt then b.txt into C:/tmp, then stop')
})

test('skipCode false leaves the markup exactly as written', () => {
  const out = stripForSpeech('keep `this` and\n\n```\nthat\n```', 0, {
    skipCode: false,
    phrases: PHRASES,
  })
  assert.match(out, /`this`/)
  assert.match(out, /```/)
})

test('an unwrapped version is not split across spoken pieces', () => {
  // protectAbbreviations has to see the version inside the piece the cutter builds,
  // otherwise the trailing ".4" becomes its own sentence.
  const pieces = splitSentences(speak('the installed plugin is `0.4.16-local.4`, and it works'), 320)
  assert.equal(pieces.length, 1, `one sentence expected, got ${JSON.stringify(pieces)}`)
  assert.match(pieces[0], /0\.4\.16-local\.4/)
})

test('a span at the very start or end of a sentence is kept', () => {
  assert.equal(speak('`pnpm` builds it'), 'pnpm builds it')
  assert.equal(speak('run `pnpm`'), 'run pnpm')
})
