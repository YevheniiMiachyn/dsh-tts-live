/**
 * Wiring tests for the browser side of barge-in (0.4.16-local.4).
 *
 * The player is a build artifact (`lib/client.js`, built from `lib/client-src/*.js`),
 * and the two halves of barge-in live in different plugins: dsh-voice announces that
 * the user started talking, dsh-tts decides what silence means. These assertions read
 * the built bundle so a rebase or a fragment rename cannot quietly drop the link, and
 * they read comment-stripped source so a comment *about* a line can never satisfy —
 * or break — a match.
 *
 * Run: node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const raw = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
// Comments are preserved by the fragment build, so strip them: every assertion below
// is about executable code.
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

/** The body of one top-level function declaration, for anchored assertions. */
function bodyOf(name) {
  const start = code.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `lib/client.js must declare ${name}`)
  const next = code.indexOf('\n    function ', start + 1)
  return code.slice(start, next === -1 ? undefined : next)
}

const count = (needle) => code.split(needle).length - 1

test('the player publishes playback state on both edges', () => {
  assert.equal(count('announceSpeech(true)'), 1, 'exactly one place starts playback')
  assert.equal(count('announceSpeech(false)'), 2, 'stopPlayback and the drained queue both end it')
  // The declaration itself matches `function announceSpeech(on)`, so the call counts
  // above cannot be satisfied by it.
  assert.match(code, /function announceSpeech\(on\)/)
  assert.match(
    code,
    /window\.dispatchEvent\(new CustomEvent\(next \? 'dsh:tts:start' : 'dsh:tts:stop'\)\)/,
    'both events are dispatched, so a voice plugin listener sees real transitions',
  )
  assert.match(code, /if \(player\.speaking === next\) return/, 'edges only: no duplicate starts')
  assert.match(code, /speaking: false/, 'the state starts false')
})

test('the player listens for the explicit cancel command', () => {
  assert.match(code, /window\.addEventListener\('dsh:tts:cancel', onCancel\)/)
  assert.match(code, /window\.removeEventListener\('dsh:tts:cancel', onCancel\)/, 'and unsubscribes')
  assert.match(code, /window\.addEventListener\('dsh-voice:speaking', onSpeaking\)/, 'the implicit signal stays')
})

test('a barge-in tells the host, and not only in live mode', () => {
  const body = bodyOf('bargeInNow')
  assert.match(body, /fetch\('\/dsh-tts\/bargein'/, 'the host abort is requested')
  assert.doesNotMatch(
    body,
    /liveEnabled/,
    'the durable path has a pending queue too: the host call must not be gated on live mode',
  )
  assert.match(body, /stopPlayback\(\)/, 'and the local queue is emptied')
})

test('the implicit barge-in path still honours the TTS barge-in setting', () => {
  const body = bodyOf('listenForVoice')
  assert.match(body, /if \(!player\.bargeIn\) return/, 'the TTS-side setting still vetoes the implicit path')
  // The explicit command must not be double-gated: the voice plugin already decided.
  const cancelPart = body.slice(body.indexOf('onCancel'))
  assert.doesNotMatch(cancelPart.slice(0, 200), /bargeIn\) return/)
})
