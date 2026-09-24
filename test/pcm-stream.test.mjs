/**
 * PCM streaming transport tests (PCM stage).
 *
 * Two kinds of assertion live here, and the difference matters:
 *
 *   * the HOST framing is tested against the real module — `createPcmTransport`
 *     and `pcmProviderFor` are imported and driven, so sequence numbers, byte
 *     accounting, cancellation and the end-to-end arithmetic are exercised rather
 *     than described;
 *   * the BROWSER side is read out of the built bundle (`lib/client.js`), because
 *     it has no Node-testable surface — it is a module-loader fragment. Those
 *     assertions are anchored to the executable text with comments stripped, so a
 *     comment ABOUT a line can never satisfy one.
 *
 * Run: node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPcmTransport, pcmProviderFor, endToEnd } from '../lib/pcm-stream.js'

const CHAIN = (provider) => [{ provider, model: 'qwen3-tts-akeno', voice: 'akeno' }]

function collect() {
  const events = []
  const transport = createPcmTransport({
    broadcast: (type, item) => events.push({ type, item }),
    log: () => {},
    limit: 50,
  })
  return { transport, events }
}

// ── the feature switch ────────────────────────────────────────────────────────

test('PCM is off unless the experimental flag is explicitly on', () => {
  assert.equal(pcmProviderFor({ chain: CHAIN('custom') }), null, 'no flag means no PCM')
  assert.equal(pcmProviderFor({ chain: CHAIN('custom'), pcmStreamingExperimental: false }), null)
  assert.equal(pcmProviderFor({ chain: CHAIN('custom'), pcmStreamingExperimental: true }), 'custom')
})

test('only the FIRST usable chain entry can carry PCM', () => {
  // A later entry would change which provider — and therefore which voice — speaks,
  // so the transport must not go looking for a capable provider further down.
  assert.equal(
    pcmProviderFor({ pcmStreamingExperimental: true, chain: [{ provider: 'espeak' }, { provider: 'custom' }] }),
    null,
    'a non-streaming first entry keeps the whole piece on the WAV path',
  )
  assert.equal(
    pcmProviderFor({ pcmStreamingExperimental: true, chain: [{ provider: 'custom' }, { provider: 'espeak' }] }),
    'custom',
  )
  assert.equal(pcmProviderFor({ pcmStreamingExperimental: true, chain: [] }), null, 'an empty chain has nothing to stream')
})

// ── framing ───────────────────────────────────────────────────────────────────

test('a stream is framed start -> chunks -> end, in order and with exact bytes', () => {
  const { transport, events } = collect()
  const s = transport.open({ id: 'u7', sessionId: 'sess', role: 'reply', text: 'hello' })

  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'pcm-start')
  assert.equal(events[0].item.streamId, s.streamId)
  assert.equal(events[0].item.piece, 7, 'the piece number travels with the stream so the browser can order it')
  assert.equal(events[0].item.sampleRate, 24000)
  assert.equal(events[0].item.channels, 1)
  assert.equal(events[0].item.format, 's16le')
  assert.equal(typeof events[0].item.t0Wall, 'number', 'the host clock lets the browser place its marks on one timeline')

  // Format metadata must NOT be repeated per chunk: it is constant for the life of
  // a stream and every extra field is latency on the critical path.
  const a = Buffer.alloc(3840, 1)
  const b = Buffer.alloc(7680, 2)
  s.push(a)
  s.push(b)
  const chunks = events.filter((e) => e.type === 'pcm-chunk')
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].item.seq, 0)
  assert.equal(chunks[1].item.seq, 1, 'sequence increases by exactly one')
  assert.equal(chunks[0].item.data, a.toString('base64'))
  assert.equal(chunks[1].item.data, b.toString('base64'))
  for (const c of chunks) {
    assert.equal(c.item.sampleRate, undefined, 'no per-chunk format metadata')
    assert.equal(c.item.format, undefined)
  }

  s.end()
  const end = events.filter((e) => e.type === 'pcm-end')
  assert.equal(end.length, 1)
  assert.equal(end[0].item.bytes, 3840 + 7680, 'the end frame declares what the host actually sent')
  assert.equal(end[0].item.seq, 2, 'the end frame continues the sequence')
  assert.equal(s.record.ok, true)
})

test('the first byte into DSH is what the transport observed, not what it hoped', () => {
  const { transport } = collect()
  const s = transport.open({ id: 'u1', sessionId: 'x', role: 'reply', text: 'a' })
  assert.equal(s.record.host.p1_firstTtsByte, null, 'nothing is claimed before a byte exists')
  s.push(Buffer.alloc(16))
  assert.equal(typeof s.record.host.p1_firstTtsByte, 'number')
  assert.equal(s.record.host.p2_firstByteIntoDsh, s.record.host.p1_firstTtsByte)
  assert.equal(typeof s.record.host.p3_firstByteOutToBrowser, 'number')
  assert.equal(s.record.started, true)
})

test('abort is framed, carries whether audio had started, and is not an ok stream', () => {
  const { transport, events } = collect()
  const s = transport.open({ id: 'u2', sessionId: 'x', role: 'reply', text: 'b' })
  s.push(Buffer.alloc(16))
  s.abort('cancelled', { cancelled: true })
  const abort = events.filter((e) => e.type === 'pcm-abort')
  assert.equal(abort.length, 1)
  assert.equal(abort[0].item.started, true, 'the browser is told a fallback is no longer possible')
  assert.equal(s.record.cancelled, true)
  assert.equal(s.record.ok, false)
})

test('an abort before any audio reports started=false, which is what permits a WAV fallback', () => {
  const { transport, events } = collect()
  const s = transport.open({ id: 'u3', sessionId: 'x', role: 'reply', text: 'c' })
  s.abort('provider refused')
  const abort = events.filter((e) => e.type === 'pcm-abort')
  assert.equal(abort[0].item.started, false)
  assert.equal(s.started, false)
})

// ── telemetry arithmetic ──────────────────────────────────────────────────────

test('a MISSING mark stays missing: null is never coerced to zero', () => {
  // Number(null) === 0, so a naive coercion turns "the tap never fired" into
  // "audio started at 0 ms" — which reads as instant and flatters every summary.
  const { transport } = collect()
  const s = transport.open({ id: 'u4', sessionId: 'x', role: 'reply', text: 'd' })
  s.push(Buffer.alloc(8))
  s.end()
  transport.mergeBrowser(s.streamId, {
    p4_firstChunk: 40,
    p6_scheduled: 70,
    p7_signalGraph: null,
    p7_audibleGraph: null,
    receivedBytes: 8,
    expectedBytes: 8,
  })
  const rec = transport.snapshot().find((r) => r.streamId === s.streamId)
  assert.equal(rec.browser.p7_audibleGraph, null)
  assert.equal(rec.browser.p7_signalGraph, null)
  const e2e = endToEnd(rec)
  assert.equal(e2e.p0_to_p7_signal, null, 'a null mark produces a null end-to-end figure, not a fast one')
  assert.equal(e2e.p0_to_p7_audible, null)
})

test('end-to-end arithmetic is P0 -> P7 and decomposes the browser half', () => {
  const { transport } = collect()
  const s = transport.open({ id: 'u5', sessionId: 'x', role: 'reply', text: 'e' })
  s.push(Buffer.alloc(8))
  s.end()
  transport.mergeBrowser(s.streamId, {
    p4_firstChunk: 44,
    p5_threshold: 68,
    p6_scheduled: 68,
    p7_signalGraph: 92,
    p7_audibleGraph: 180,
    p7_audibleAcoustic: 220,
    receivedBytes: 8,
    expectedBytes: 8,
    underruns: 0,
  })
  const rec = transport.snapshot().find((r) => r.streamId === s.streamId)
  const e2e = endToEnd(rec)
  assert.equal(e2e.p0_to_p7_signal, 92, 'the transport figure uses the first non-zero sample')
  assert.equal(e2e.p0_to_p7_audible, 180, 'the audible figure uses the above-threshold sample')
  assert.equal(e2e.p0_to_p7_acoustic, 220, 'and the acoustic estimate adds the output latency')
  assert.equal(e2e.p0_to_p4, 44)
  assert.deepEqual(e2e.browserBlocks, { p4_to_p5: 24, p5_to_p6: 0, p6_to_p7: 24 })
  assert.equal(e2e.integrity.bytesMatch, true)
})

test('a byte-count mismatch is visible rather than swallowed', () => {
  const { transport } = collect()
  const s = transport.open({ id: 'u6', sessionId: 'x', role: 'reply', text: 'f' })
  s.push(Buffer.alloc(100))
  s.end()
  transport.mergeBrowser(s.streamId, { p4_firstChunk: 10, receivedBytes: 60, expectedBytes: 100 })
  const e2e = endToEnd(transport.snapshot().find((r) => r.streamId === s.streamId))
  assert.equal(e2e.integrity.bytesMatch, false)
})

test('a report for an unknown stream is refused, not silently merged', () => {
  const { transport } = collect()
  assert.equal(transport.mergeBrowser('pcm-does-not-exist', { p4_firstChunk: 1 }), false)
})

test('the telemetry ring is bounded and clearable', () => {
  const { transport } = collect()
  for (let i = 0; i < 80; i++) transport.open({ id: `u${i}`, sessionId: 'x', role: 'reply', text: 'g' })
  assert.ok(transport.size <= 50, 'the ring never grows without bound')
  assert.ok(transport.clear() > 0)
  assert.equal(transport.size, 0)
})

// ── the WAV baseline is measured in the same store ────────────────────────────

test('the WAV arm is measured through the same store and clock', () => {
  const { transport } = collect()
  const w = transport.openWav({ id: 'u9', sessionId: 'x', role: 'reply', text: 'h' })
  assert.equal(w.record.kind, 'wav')
  assert.equal(w.record.format, 'wav')
  assert.equal(typeof w.record.t0Wall, 'number')
  w.complete(1234)
  assert.equal(w.record.host.w3_wavComplete !== null, true)
  assert.equal(w.record.bytes, 1234)
  transport.markWavPublished(w.streamId)
  const rec = transport.snapshot().find((r) => r.streamId === w.streamId)
  assert.ok(rec.host.w4_published >= 0 && rec.host.w4_published < 60000, `w4 must be a small delta, got ${rec.host.w4_published}`)
  assert.equal(transport.mergeWavBrowser({ id: 'u9', w5_payloadReceived: 500, w7_playbackStarted: 700, w8_firstAudible: 710 }), true)
  const merged = transport.snapshot().find((r) => r.streamId === w.streamId)
  assert.equal(merged.browser.w8_firstAudible, 710)
})

// ── the browser half, read out of the shipped bundle ─────────────────────────

const raw = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
const count = (needle) => code.split(needle).length - 1

test('the browser refuses a chunk that is out of sequence or belongs to nobody', () => {
  assert.match(code, /if \(seq !== s\.lastSeq \+ 1\)/, 'sequence gaps are detected')
  assert.match(code, /if \(seq <= s\.lastSeq\) \{ stats\.droppedChunks\+\+; s\.dropped\+\+; return \}/, 'a duplicate or reordered chunk is dropped, not guessed at')
  assert.match(code, /const s = streams\.get\(meta\.streamId\)\s*\n\s*if \(!s\) \{ stats\.lateChunks\+\+; return \}/, 'a chunk for an unknown (cancelled) stream is rejected')
})

test('the browser orders streams by piece number, not by arrival', () => {
  assert.match(code, /if \(best === null \|\| s\.piece < best\.piece\) best = s/, 'lowest piece number schedules first')
})

test('a cancelled piece cannot be spoken by a late chunk', () => {
  assert.match(code, /markCancelled\(/, 'pieces are remembered as cancelled')
  assert.match(code, /if \(meta\.piece != null && cancelledPieces\.has\(Number\(meta\.piece\)\)\)/, 'a start for a cancelled piece is refused')
})

test('the PCM player is stopped by the same paths that stop the WAV queue', () => {
  assert.match(code, /function stopPlayback\(\) \{[\s\S]{0,200}pcmStop\('stop-playback'\)/, 'stopPlayback stops both players')
  assert.match(code, /function bargeInNow\(\)[\s\S]{0,600}pcmStreaming\.activeStreams === 0/, 'a barge-in is not skipped when only PCM is playing')
})

test('the browser reports its half of the measurement without any speech text', () => {
  assert.match(code, /fetch\('\/dsh-tts\/pcm-telemetry'/)
  // A telemetry payload may carry timings and byte counts, never words.
  const body = code.slice(code.indexOf("fetch('/dsh-tts/pcm-telemetry'"), code.indexOf("fetch('/dsh-tts/pcm-telemetry'") + 1400)
  assert.doesNotMatch(body, /\btext\s*:/, 'no text field is sent')
  assert.doesNotMatch(body, /rec\.text\b/, 'the spoken text is not referenced')
})

test('the SSE channel is subscribed once, not reopened on every poll', () => {
  // The original code closed and reopened the EventSource on every poll, ~7 times
  // a second, dropping whatever was in flight — fatal for chunked audio.
  assert.match(code, /if \(sseSource && sseSource\.readyState !== 2\s*\) return/)
})

test('PCM stays inert until the host reports it enabled', () => {
  assert.match(code, /pcm\.enabled = meta\.pcm\.enabled === true/)
  assert.match(code, /if \(pcm\.enabled\) pcmPrepare\(\)/)
})

test('a pcm queue row is never played as if it were a blob', () => {
  assert.match(code, /if \(item\.kind === 'pcm'\) continue/, 'drainQueue skips it')
  assert.match(code, /wavMarkArrived\(item\)\s*\n\s*player\.queue\.push\(item\)/, 'and the pending poll advances past it')
})

// ── the WAV fallback contract, read out of the host ─────────────────────────

const hostSource = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

test('a PCM failure before any audio falls back to WAV; one after does not', () => {
  assert.match(hostSource, /if \(attempt\.committed\) \{/, 'the committed case is handled separately')
  assert.match(hostSource, /Restarting the piece in WAV\s*\n\s*\/\/ would speak the beginning twice in a different format|pcmAborted: true/)
  assert.match(hostSource, /PCM stream for \$\{id\} failed before any audio; using WAV/, 'the uncommitted case falls through to the WAV path')
})

test('cancellation reaches the bytes already on the wire, not just the queue', () => {
  assert.match(hostSource, /for \(const \[id, stream\] of \[\.\.\.activePcm\]\)/, 'open streams are aborted with the queue rows')
  assert.match(hostSource, /stream\.abortFetch\('barge-in'\)/, 'and the fetch is actually closed')
})

test('the validated segmentation parameters are untouched', () => {
  // The PCM stage sits BELOW the piece cutter. If this ever fails, the stage has
  // reached into text segmentation and the measurement basis is gone.
  for (const param of ['liveMinCharsFirst', 'liveMinChars', 'liveMaxChars']) {
    assert.match(hostSource, new RegExp(`${param}: z\\s*\\n\\s*\\.number\\(\\)`), `${param} is still a plain number setting`)
  }
  assert.match(hostSource, /liveMinCharsFirst: z[\s\S]{0,200}\.default\(12\)/)
  assert.match(hostSource, /liveMinChars: z[\s\S]{0,200}\.default\(48\)/)
  assert.match(hostSource, /liveMaxChars: z[\s\S]{0,200}\.default\(0\)/)
})
