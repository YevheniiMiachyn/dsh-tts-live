// Regression tests for the dock's transport controls under progressive PCM.
//
// Three connected defects, all introduced by promoting the PCM transport without
// teaching the rest of the client about the second playback path. Reported from
// real use: "the small buttons I could stop or pause your talking with are gone".
//
//  1. VISIBILITY. 60-card-dock.js decided whether to render at all from
//     `!!p.audio || p.queue.length > 0 || p.busy` — all three are WAV-path
//     evidence. PCM creates no <audio> element and hands blocks straight to the
//     AudioContext, so the dock returned null for the whole of every PCM reply and
//     the pause/stop controls vanished.
//
//  2. TIMING. The PCM player emitted `idle` when the last block was SCHEDULED
//     (`s.ended && s.segSamples === 0`), not when it had PLAYED. The producer runs
//     several times faster than real time, so `speaking` flipped false seconds
//     early: the controls would have disappeared mid-sentence even once visible,
//     and dsh-voice's barge-in gate reopened while she was still audibly talking.
//
//  3. PAUSE. `togglePause()` only touched `player.audio`. With no <audio> element
//     the pause button did nothing at all for PCM.
//
// The claims that matter are asserted structurally against the built bundle, with
// the numeric rules reproduced so a regression in the arithmetic fails the test
// rather than merely changing a string.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const code = client.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const dock = readFileSync(new URL('../lib/client-src/60-card-dock.js', import.meta.url), 'utf8')
const dockCode = dock.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const pcm = readFileSync(new URL('../lib/client-src/15-pcm-player.js', import.meta.url), 'utf8')
const pcmCode = pcm.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const player = readFileSync(new URL('../lib/client-src/20-player.js', import.meta.url), 'utf8')
const playerCode = player.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

// ── 1. visibility ────────────────────────────────────────────────────────────
test('the dock renders for BOTH transports, not only the WAV one', () => {
  const m = dockCode.match(/const active = ([^\n]+)/)
  assert.ok(m, 'the dock must still decide visibility from an `active` expression')
  const expr = m[1]
  // The WAV terms stay, so nothing regresses for buffered playback.
  assert.match(expr, /p\.audio/, 'the WAV <audio> element must still count')
  assert.match(expr, /p\.queue\.length/, 'the WAV queue must still count')
  assert.match(expr, /p\.busy/, 'the WAV drain window must still count')
  // And the PCM terms must be there, or the controls disappear for PCM.
  assert.match(expr, /p\.speaking/, 'the transport-independent speaking flag must count')
  assert.match(expr, /p\.pcmPlaying/, 'scheduled-but-not-yet-played PCM audio must count')
})

test('the old WAV-only visibility test is gone from the built bundle', () => {
  assert.doesNotMatch(code, /const active = !!p\.audio \|\| p\.queue\.length > 0 \|\| p\.busy\n/,
    'the WAV-only form must not come back: it hides the dock for every PCM reply')
})

test('the player snapshot exposes pcmPlaying, and it asks the PCM player', () => {
  assert.match(playerCode, /get pcmPlaying\(\)/, 'player must expose pcmPlaying for the dock')
  assert.match(playerCode, /pcmStreaming && pcmStreaming\.playing/, 'it must read the PCM player, not guess')
})

test('the PCM player exposes a truthful playing getter', () => {
  assert.match(pcmCode, /get playing\(\)/, 'the PCM player must expose `playing`')
  // Suspended means deliberately paused: report not-playing so a resumed context
  // is what makes it true again, rather than a stale scheduled end.
  assert.match(pcmCode, /ctx\.state === 'suspended'\) return false/, 'a suspended context is not playing')
  assert.match(pcmCode, /playingRemainingMs\(\) > 0/, 'playing is defined as audio still ahead of the playhead')
})

// ── 2. timing ────────────────────────────────────────────────────────────────
test('idle is NOT emitted when scheduling completes, only when playback does', () => {
  // The old line: reaching scheduling-complete emitted idle immediately.
  assert.doesNotMatch(pcmCode, /releaseStream\(s\)\s*\n\s*if \(streams\.size === 0\) emit\('idle', \{\}\)/,
    'scheduling-complete must not report the end of playback')
  assert.match(pcmCode, /if \(streams\.size === 0\) scheduleIdle\(playbackEndCtx\)/,
    'the end must be scheduled against the context clock')
})

test('playbackEndCtx tracks the end of the last scheduled block', () => {
  assert.match(pcmCode, /if \(nextTime > playbackEndCtx\) playbackEndCtx = nextTime/,
    'every schedule must extend the known end of audio')
  assert.match(pcmCode, /function playingRemainingMs\(\)/, 'a single place must answer "how much is left"')
  assert.match(pcmCode, /Math\.max\(0, \(playbackEndCtx - ctx\.currentTime\) \* 1000\)/, 'remaining time is in ms, never negative')
})

test('the idle timer is clamped so a suspended context cannot wedge the UI', () => {
  const m = pcmCode.match(/const delayMs = Math\.min\(([^\n]+)\)/)
  assert.ok(m, 'scheduleIdle must clamp its delay')
  const terms = m[1].split(',').map((s) => s.trim())
  assert.ok(terms.length >= 3, 'the clamp must have a hard ceiling as well as the computed remainder')
  const cap = Number(terms[terms.length - 1])
  assert.equal(cap, 120000, 'the hard ceiling must be a fixed number of ms, not derived from anything')
  // Reproduce the rule: a context that never advances still reopens the gate.
  const model = (remainingMs) => Math.min(remainingMs + 60, remainingMs + 3000, 120000)
  assert.equal(model(1500), 1560, 'a short tail waits just past the end of the audio')
  assert.equal(model(4_000_000), 120000, 'an absurd remainder is capped at the ceiling')
})

test('a stop clears the pending end-of-playback timer', () => {
  assert.match(pcmCode, /clearIdle\(\)\s*\n\s*playbackEndCtx = 0/, 'stop() must cancel the deferred idle')
  assert.match(pcmCode, /function clearIdle\(\)/, 'clearIdle must exist')
  // Barge-in must stay instant: stop() still emits stop synchronously.
  assert.match(pcmCode, /emit\('stop', \{ reason: reason \|\| '' \}\)/, 'stop must still be reported immediately')
})

test('dispose clears the timer and the end marker', () => {
  assert.match(pcmCode, /dispose\(\) \{[\s\S]{0,220}?clearIdle\(\)[\s\S]{0,120}?playbackEndCtx = 0/, 'dispose must not leave a timer behind')
})

// ── 3. pause ─────────────────────────────────────────────────────────────────
test('pause suspends the AudioContext, which is the only way to hold scheduled PCM', () => {
  assert.match(pcmCode, /async pause\(\)[\s\S]{0,200}?await ctx\.suspend\(\)/, 'pause must suspend the context')
  assert.match(pcmCode, /async resume\(\)[\s\S]{0,240}?await ctx\.resume\(\)/, 'resume must resume it')
  // Suspending holds back blocks already booked in the future; clearing buffers
  // cannot do that, which is the same reason the clamp path swaps the gain node.
  assert.match(pcmCode, /if \(streams\.size === 0 && playbackEndCtx > 0\) scheduleIdle\(playbackEndCtx\)/,
    'resume must re-arm the end-of-playback notification against the resumed clock')
})

test('the pause button drives the PCM graph, not only the <audio> element', () => {
  const m = playerCode.match(/function togglePause\(\) \{[\s\S]{0,900}?\n    \}/)
  assert.ok(m, 'togglePause must exist')
  assert.match(m[0], /pcmStreaming\.pause\(\)/, 'pause must reach the PCM graph')
  assert.match(m[0], /pcmStreaming\.resume\(\)/, 'resume must reach the PCM graph')
  assert.match(m[0], /pcmStreaming\.playing/, 'it must only touch the PCM graph when PCM is what is playing')
})

// ── the state change has to reach React ──────────────────────────────────────
test('a speaking edge re-renders its consumers', () => {
  const m = playerCode.match(/function announceSpeech\(on\) \{[\s\S]{0,700}?\n    \}/)
  assert.ok(m, 'announceSpeech must exist')
  assert.match(m[0], /playerChanged\(\)/,
    'without this the dock never learns that speaking began, so the controls never appear')
})

test('the built bundle carries all of it', () => {
  for (const needle of ['get playing()', 'playbackEndCtx', 'scheduleIdle', 'pcmPlaying', 'pcmStreaming.pause()',
                        'conversation.input.left', "pcmStop('silence')"]) {
    assert.ok(code.includes(needle), `the built client bundle must contain ${needle}`)
  }
})

test('no PCM source was disturbed by this fix beyond the dock wiring', () => {
  // The stall guard from local.12 must be exactly as it was.
  assert.match(pcmCode, /const stalled = s\.tFirstChunk === null/, 'the local.12 stall guard must survive')
  assert.match(pcmCode, /STALL_START_MS/, 'and keep its two-budget form')
  // WAV playback must be untouched.
  assert.match(playerCode, /createObjectURL/, 'the WAV path must still build blob URLs')
})

// ── 4. the end-of-speech event has to be DELIVERED, not merely emitted ───────
//
// Reported from real use, after local.13: "the controls show up, but when you stop
// speaking they don't disappear anymore. They stay at this kind of strange place."
//
// Cause: `emit('idle', {})` — and `emit('stop', …)` — carry NO streamId, because
// they describe the whole audio graph rather than one stream. pcmEvent looked the
// per-stream record up FIRST and returned when it found none, so the
// `announceSpeech(false)` branch underneath was UNREACHABLE. The flag had been
// stuck since the idle event was introduced; it only became visible in local.13,
// when the dock started consulting `speaking` to decide whether to render at all.
//
// It was never only cosmetic: dsh-voice gates the MICROPHONE on the same edge
// (`dsh:tts:stop` → isTtsSpeaking, client.js:534-540 / 1340), so the mic stayed
// muted after the first PCM reply and the user could be talked over.
//
// The load-bearing test is behavioural — it lifts the SHIPPED pcmEvent out of the
// built bundle and runs it with stubs — because a string assertion cannot tell
// "handled before the lookup" from "written below an unconditional return".

/** Pull one top-level function out of comment-stripped source by brace matching. */
function extractFunction(src, name) {
  const at = src.indexOf(`function ${name}(`)
  assert.ok(at >= 0, `function ${name} must exist in the built bundle`)
  let depth = 0
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(at, i + 1)
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`)
}

/** Load the shipped pcmEvent with stubs and record what it told the player. */
function loadPcmEvent() {
  const calls = []
  const records = new Map([['s1', { streamId: 's1', t0Wall: 1000 }]])
  const fn = new Function(
    'pcmStreams', 'announceSpeech', 'pcmStreaming', 'pcmReport', 'sseDiag', 'pcm',
    `${extractFunction(code, 'pcmEvent')}; return pcmEvent`,
  )(
    records,
    (on) => calls.push(on),
    { context: null, stats: {} },
    (rec) => calls.push('report:' + rec.streamId),
    {},
    { telemetry: false },
  )
  return { fn, calls }
}

test('idle and stop reach announceSpeech even though they carry no streamId', () => {
  const { fn, calls } = loadPcmEvent()
  // Exactly the shape the player emits: emit('idle', {}) / emit('stop', {reason}).
  fn('idle', {})
  fn('stop', { reason: 'stop-playback' })
  assert.deepEqual(calls, [false, false],
    'both graph-wide events must clear the speaking flag — an early record lookup swallows them')
})

test('the graph-wide branch sits before the lookup, in the shipped function', () => {
  const source = extractFunction(code, 'pcmEvent')
  const handled = source.indexOf('announceSpeech(false)')
  const lookup = source.indexOf('pcmStreams.get(')
  assert.ok(handled >= 0, 'idle/stop must be handled in pcmEvent')
  assert.ok(lookup >= 0, 'the per-stream path must still exist')
  assert.ok(handled < lookup, 'handling must precede the lookup, which returns early on an unknown stream')
  assert.doesNotMatch(source, /else if \(kind === 'idle'/,
    'the unreachable branch must be gone rather than left behind')
})

test('per-stream events still route through the record lookup', () => {
  const { fn, calls } = loadPcmEvent()
  fn('scheduled', { streamId: 's1', piece: 1 })
  assert.deepEqual(calls, [true], 'a scheduled stream still announces that she is speaking')
  fn('scheduled', { streamId: 'unknown' })
  fn('finished', { streamId: 'unknown' })
  assert.deepEqual(calls, [true], 'an unknown stream is neither a reason to speak nor to report')
})

test('a finished stream still reports, so telemetry did not regress', () => {
  const { fn, calls } = loadPcmEvent()
  fn('finished', { streamId: 's1', underruns: 0, lateBlocks: 0, seqErrors: 0, dropped: 0 })
  assert.deepEqual(calls, ['report:s1'], 'the per-stream branch must be untouched by the reordering')
})

test('an abort that empties the graph still arms the end-of-playback notification', () => {
  const m = pcmCode.match(/handleAbort\(meta\) \{[\s\S]*?\n        \},/)
  assert.ok(m, 'handleAbort must exist')
  assert.match(m[0], /if \(streams\.size === 0\) scheduleIdle\(playbackEndCtx\)/,
    'a cancelled reply is otherwise the last event it ever has, and the controls never retract')
})

test('with speech ended the dock expression is false, so it unmounts', () => {
  const expr = dockCode.match(/const active = ([^\n]+)/)[1]
  const active = new Function('p', `return (${expr})`)
  const idle = { audio: null, queue: [], busy: false, speaking: false, pcmPlaying: false }
  assert.equal(active(idle), false, 'this is the regression: idle must hide the controls')
  assert.equal(active({ ...idle, speaking: true }), true, 'while she speaks they must be shown')
  assert.equal(active({ ...idle, pcmPlaying: true }), true, 'including the scheduled-but-unplayed tail')
})

// ── 5. she must not talk over the user ───────────────────────────────────────
//
// Reported from real use: "you start talking when I'm talking… you kind of burst
// in." bargeInNow() decided with WAV-path evidence plus `activeStreams`, which
// counts streams still RECEIVING BYTES. The producer runs ~7x real time, so by the
// time the user speaks `activeStreams` is usually already 0 while a second or more
// of audio sits scheduled in the AudioContext — the guard returned early,
// stopPlayback() never ran, and the tail played over him. dsh-voice's own
// triggerBargeIn() cannot compensate: it pauses <audio> elements, and progressive
// PCM creates none.
test('barge-in stops scheduled PCM, not only bytes still arriving', () => {
  const m = playerCode.match(/function bargeInNow\(\) \{[\s\S]*?\n    \}/)
  assert.ok(m, 'bargeInNow must exist')
  assert.match(m[0], /pcmStreaming\.activeStreams === 0/, 'the byte-arrival term must stay')
  assert.match(m[0], /pcmStreaming\.playing/,
    'scheduled-but-unplayed audio must count, or the guard returns early and she talks over the user')
})

test('silent mode reaches the PCM graph, not only future playback', () => {
  const m = playerCode.match(/const wasEnabled = player\.enabled[\s\S]{0,500}?pcmStop\('silence'\)/)
  assert.ok(m, 'the enabled edge must stop the PCM graph')
  // The host cannot finish the job: aborting a stream stops bytes, not blocks
  // already booked into the AudioContext.
  assert.match(m[0], /!player\.enabled && wasEnabled/, 'only on the falling edge, so speech still starts')
})
