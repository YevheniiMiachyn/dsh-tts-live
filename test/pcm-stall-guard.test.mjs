// Regression tests for the PCM stall guard.
//
// The defect these cover was found by the real-use soak, not by any earlier
// suite. In v0.4.16-local.11 the guard was:
//
//   if (t - (s.tFirstChunk || s.tStart) > 5000) { ...declare stalled... }
//
// a single deadline measured from a fixed origin, which abandoned two kinds of
// perfectly healthy stream:
//
//   1. a stream that had not produced its first chunk yet, because pcm-start is
//      broadcast when the REQUEST is issued (pcm-stream.js `open`, before any
//      audio exists) and the TTS server has one synthesis slot. Four simultaneous
//      requests get their first bytes at 75, 1978, 3746 and 5706 ms, so anything
//      past 5 s was killed before it produced a sample and every chunk that
//      followed was then discarded as late.
//   2. a long stream that was delivering steadily, because the deadline ran from
//      the FIRST chunk and was never renewed. Measured: a piece that began playing
//      at 3739 ms was cut off at 5103 ms — its first chunk (87 ms) plus 5000 —
//      while its last byte was still 515 ms away.
//
// Both cases are reproduced numerically below against the rule as written, so the
// test fails if the rule regresses rather than merely if a string changes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
// Comments are stripped for the structural assertions: the explanation above the
// guard quotes the old expression, so a naive search would match the comment.
const code = client.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const src = readFileSync(new URL('../lib/client-src/15-pcm-player.js', import.meta.url), 'utf8')
const srcCode = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const constOf = (name, text) => {
  const m = text.match(new RegExp(`const ${name}\\s*=\\s*(\\d+)`))
  assert.ok(m, `${name} must be defined as a numeric literal`)
  return Number(m[1])
}

const STALL_MS = constOf('STALL_MS', srcCode)
const STALL_START_MS = constOf('STALL_START_MS', srcCode)

/** The guard's decision, transcribed from the sweep. */
const stalled = ({ now, tStart, tFirstChunk, tLastEvent }) =>
  tFirstChunk === null ? now - tStart > STALL_START_MS : now - tLastEvent > STALL_MS

/** The v0.4.16-local.11 rule, kept here as the thing that must stay fixed. */
const stalledOld = ({ now, tStart, tFirstChunk }) => now - (tFirstChunk ?? tStart) > 5000

test('the two stall budgets are what the fix intends', () => {
  assert.equal(STALL_MS, 5000, 'a flowing stream that goes quiet for 5 s is dead')
  // The host's own provider timeout is 60 s (settings `timeoutMs`), and it answers
  // with pcm-abort. The client budget must be longer than that, or the client
  // would keep deciding before the host and the host would never get to speak.
  assert.ok(STALL_START_MS > 60000, `STALL_START_MS (${STALL_START_MS}) must exceed the host's 60 s provider timeout`)
})

test('mode 1: a slow first byte is not a stall (the soak lost whole pieces here)', () => {
  // Measured in the soak: pieces 34-37 waited 6148-6414 ms for their first byte
  // and pieces 47-50 waited 27622-28240 ms. All eight were abandoned before a
  // single chunk arrived, then every chunk was discarded as late.
  for (const p1 of [6148, 6321, 6414, 27622, 28180, 28240]) {
    const s = { now: p1, tStart: 0, tFirstChunk: null, tLastEvent: 0 }
    assert.equal(stalledOld(s), true, `sanity: the old rule abandoned a ${p1} ms first byte`)
    assert.equal(stalled(s), false, `a ${p1} ms first byte must not be treated as a stall`)
  }
})

test('mode 1: a host that really vanished is still caught, just later', () => {
  const gone = { now: STALL_START_MS + 1, tStart: 0, tFirstChunk: null, tLastEvent: 0 }
  assert.equal(stalled(gone), true, 'a stream with no first chunk forever must still be released')
  const justUnder = { now: STALL_START_MS - 1, tStart: 0, tFirstChunk: null, tLastEvent: 0 }
  assert.equal(stalled(justUnder), false, 'and not one millisecond early')
})

test('mode 2: a long piece delivering steadily is not a stall (the soak truncated here)', () => {
  // Measured: piece 32 began playing at 3739 ms, its first chunk was at 87 ms, its
  // last byte at 5618 ms, and it was cut off at 5103 ms = 87 + 5000.
  const firstChunk = 87
  const lastByte = 5618
  const cut = firstChunk + 5000
  // The measured cut-off was 5103 ms in the record's own frame. The 16 ms gap is
  // the offset between the host's `t0Wall` clock (which the record's marks are
  // relative to) and the browser's `now()` (which the guard uses) — the piece's
  // pcm-start is delivered to the browser a little after the host stamps it. So
  // the identity to assert is the RULE, to within one delivery hop.
  assert.ok(Math.abs(cut - 5103) < 50, `sanity: the observed cut-off (5103) is firstChunk + 5000 (${cut}) up to a sub-chunk clock offset`)

  // Old rule, evaluated at the first sweep tick past the deadline. The sweep runs
  // every SWEEP_MS (25 ms), so the rule is `>` and the observed fire lands on the
  // next tick rather than exactly on the boundary.
  assert.equal(stalledOld({ now: cut, tStart: 0, tFirstChunk: firstChunk }), false, 'not yet, exactly on the boundary')
  assert.equal(stalledOld({ now: cut + 25, tStart: 0, tFirstChunk: firstChunk }), true, 'sanity: the old rule fired mid-stream on the next tick')

  // New rule, walking the same stream chunk by chunk. The piece is 13.8 s of audio
  // delivered over 5.6 s, so the longest gap between chunks is well under 5 s.
  let tLastEvent = 0
  let fired = false
  for (let now = 0; now <= lastByte + 100; now += 25) {
    if (now <= lastByte && now % 250 === 0) tLastEvent = now // a chunk lands every ~250 ms
    if (stalled({ now, tStart: 0, tFirstChunk: firstChunk, tLastEvent })) { fired = true; break }
  }
  assert.equal(fired, false, 'a stream delivering a chunk every 250 ms must never be declared stalled')
})

test('mode 2 boundary: 5 s of real silence still trips the guard', () => {
  // The guard must keep its original job. A stream that delivered and then went
  // quiet for longer than STALL_MS is dead and has to be released, or it blocks
  // every later piece forever.
  const tLastEvent = 1000
  assert.equal(stalled({ now: tLastEvent + STALL_MS - 1, tStart: 0, tFirstChunk: 100, tLastEvent }), false)
  assert.equal(stalled({ now: tLastEvent + STALL_MS + 1, tStart: 0, tFirstChunk: 100, tLastEvent }), true)
})

test('the guard selects its budget on whether the stream has started producing', () => {
  assert.match(srcCode, /const stalled = s\.tFirstChunk === null\s*\?\s*\(t - s\.tStart\) > STALL_START_MS\s*:\s*\(t - s\.tLastEvent\) > STALL_MS/,
    'the sweep must branch on tFirstChunk and read tLastEvent once flowing')
})

test('the one-shot deadline is gone from both the source and the built bundle', () => {
  const oldRule = /t - \(s\.tFirstChunk \|\| s\.tStart\) > 5000/
  assert.doesNotMatch(srcCode, oldRule, 'the fixed origin must not come back in the source')
  assert.doesNotMatch(code, oldRule, 'the fixed origin must not come back in the built client bundle')
})

test('every arrival renews the stall budget', () => {
  assert.match(srcCode, /tLastEvent: now\(\)/, 'newStream must initialise tLastEvent')
  // handleChunk must renew it before validation, so a chunk with bad framing still
  // counts as proof of life.
  assert.match(srcCode, /handleChunk\(meta\) \{[\s\S]{0,400}?s\.tLastEvent = now\(\)/, 'handleChunk must renew tLastEvent')
  assert.match(srcCode, /handleEnd\(meta\) \{[\s\S]{0,400}?s\.tLastEvent = now\(\)/, 'handleEnd must renew tLastEvent')
})

test('the guard still reports a stall the host can see', () => {
  assert.match(srcCode, /emit\('stall', \{ streamId: s\.streamId, piece: s\.piece \}\)/, 'the stall must still be emitted')
})
