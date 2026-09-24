// LOCAL FORK (PCM stage): progressive PCM transport for the low-latency voice path.
//
// WHAT THIS IS
//
// A framed, cancellable PCM stream from the TTS server, through DSH, to the
// browser. It exists because every step of the WAV path requires the complete
// utterance before the next step may begin (see PHASE1-WAV-PATH-TRACE.md): the
// server will not emit a byte until synthesis finishes, DSH buffers the whole
// body, base64s it whole, and the browser needs a complete Blob before an
// <audio> element can play. That is an unavoidable ~500 ms floor for a normal
// sentence, and it grows with the length of the utterance.
//
// WHAT THIS IS NOT
//
// It is not a second synthesis path and not a change to segmentation. The text
// this streams was cut by the already-validated adaptive first-piece cutter in
// live.js, exactly as before; this module only moves the bytes of one piece.
//
// FRAMING
//
// Four SSE events on the existing /dsh-tts/stream channel, which is already a
// push channel and already carries a `piece`-ordered contract:
//
//   pcm-start  { streamId, id, piece, sessionId, sampleRate, channels, format, t0Wall }
//   pcm-chunk  { streamId, seq, data }        data = base64 of raw s16le bytes
//   pcm-end    { streamId, seq, bytes }
//   pcm-abort  { streamId, reason, started }
//
// Format metadata is sent ONCE, at stream start, because sample rate, channel
// count and sample encoding are constant for the life of a stream; repeating
// them per chunk would be pure overhead on the latency-critical path.
//
// `t0Wall` is the host's wall clock (Date.now()) at the instant the TTS request
// began. The browser runs on the same machine, so it can subtract its OWN
// Date.now() from it and express its marks on the host's timeline — which is
// what makes P0 -> P7 a single end-to-end number instead of two incomparable
// per-process ones.
//
// `seq` is a per-stream counter starting at 0 and increasing by exactly 1. The
// browser rejects anything else rather than guessing at a gap, because a
// silently reordered chunk is a click in the middle of a word.
//
// CANCELLATION
//
// A stream is cancelled by aborting the fetch signal. That closes the TCP
// connection, and the TTS server notices: its chunked content provider's write
// fails, which flips `client_gone` and aborts generation on the GPU
// (src/tts-server.h:394-399) instead of finishing an utterance nobody will hear.
// The matching `pcm-abort` is broadcast so a browser that missed the news cannot
// keep waiting for a stream that will never end.
//
// TELEMETRY
//
// Records carry no speech text — only a character count — so a debug dump cannot
// leak what was said. Reused as a bounded ring.

import { OPENAI_COMPATIBLE } from './providers/constants.js'

/** Monotonic millisecond clock, for stage-to-stage deltas within this process. */
const mono = () => Number(process.hrtime.bigint() / 1000n) / 1000

export const PCM_START = 'pcm-start'
export const PCM_CHUNK = 'pcm-chunk'
export const PCM_END = 'pcm-end'
export const PCM_ABORT = 'pcm-abort'

/**
 * The provider that would carry PCM for this configuration, or null.
 *
 * Only the FIRST entry of the chain is considered: switching the chain order to
 * find a PCM-capable provider would change which voice speaks, and that is not
 * this stage's business. If the configured provider cannot stream PCM, the piece
 * simply takes the WAV path it takes today.
 */
export function pcmProviderFor(cfg) {
  if (!cfg || cfg.pcmStreamingExperimental !== true) return null
  const chain = Array.isArray(cfg.chain) ? cfg.chain : []
  for (const entry of chain) {
    if (!entry || !entry.provider) continue
    if (Object.prototype.hasOwnProperty.call(OPENAI_COMPATIBLE, entry.provider)) return entry.provider
    return null   // first usable entry is not PCM-capable; do not reorder the chain
  }
  return null
}

/**
 * The PCM transport: owns stream framing, per-stream marks and the telemetry ring.
 *
 * @param {object} deps
 * @param {(type:string, item:object)=>void} deps.broadcast  SSE fan-out
 * @param {(level:string,message:string)=>void} [deps.log]
 * @param {number} [deps.limit]  telemetry ring size
 */
export function createPcmTransport({ broadcast, log, limit = 200 }) {
  let streamSeq = 0
  const records = []
  const byId = new Map()

  function note(level, message) {
    try { if (log) log(level, message) } catch { /* logging must never break audio */ }
  }

  function record(rec) {
    records.push(rec)
    if (records.length > limit) {
      const dropped = records.shift()
      byId.delete(dropped.streamId)
    }
  }

  /**
   * Open a stream. Emits pcm-start immediately — before any audio exists — so the
   * browser can allocate the stream and start its own P-clock at the right
   * instant rather than at first byte.
   */
  function open({ id, sessionId, role, text, sampleRate = 24000, channels = 1 }) {
    const streamId = `pcm${++streamSeq}`
    const t0Mono = mono()
    const rec = {
      streamId,
      id,
      piece: Number(String(id).replace(/^u/, '')) || null,
      sessionId: sessionId || null,
      role: role || 'reply',
      sampleRate,
      channels,
      format: 's16le',
      textChars: text ? String(text).length : 0,
      started: false,
      cancelled: false,
      ok: null,
      error: null,
      chunks: 0,
      bytes: 0,
      chunkBytes: [],
      // Host side of the marker set.
      t0Wall: Date.now(),
      host: {
        p0_requestStart: 0,
        p1_firstTtsByte: null,
        p2_firstByteIntoDsh: null,
        p3_firstByteOutToBrowser: null,
        pend_lastByte: null,
        ttsTotalMs: null,
        firstChunkAfterMs: null,
      },
      browser: null,
      underrunsAtEnd: null,
    }
    byId.set(streamId, rec)
    record(rec)
    broadcast(PCM_START, {
      streamId,
      id,
      piece: rec.piece,
      sessionId: rec.sessionId,
      sampleRate,
      channels,
      format: 's16le',
      t0Wall: rec.t0Wall,
    })
    return {
      streamId,
      get started() { return rec.started },
      get bytes() { return rec.bytes },
      get record() { return rec },

      /** One network chunk straight from the TTS server. */
      push(bytes) {
        const atMono = mono()
        if (!rec.started) {
          rec.started = true
          rec.host.p1_firstTtsByte = +(atMono - t0Mono).toFixed(3)
          rec.host.p2_firstByteIntoDsh = rec.host.p1_firstTtsByte
          rec.host.firstChunkAfterMs = rec.host.p1_firstTtsByte
        }
        rec.chunks++
        rec.bytes += bytes.length
        if (rec.chunkBytes.length < 64) rec.chunkBytes.push(bytes.length)
        const seq = rec.chunks - 1
        broadcast(PCM_CHUNK, { streamId, seq, data: Buffer.from(bytes).toString('base64') })
        if (rec.host.p3_firstByteOutToBrowser === null) {
          rec.host.p3_firstByteOutToBrowser = +(mono() - t0Mono).toFixed(3)
        }
      },

      /** Synthesis finished cleanly. */
      end() {
        rec.host.pend_lastByte = +(mono() - t0Mono).toFixed(3)
        rec.host.ttsTotalMs = rec.host.pend_lastByte
        rec.ok = true
        broadcast(PCM_END, { streamId, seq: rec.chunks, bytes: rec.bytes })
      },

      /**
       * The stream failed or was cancelled. `started` tells the caller whether a
       * fallback is still possible: nothing has been played until a first chunk
       * has crossed to the browser.
       */
      abort(reason, { cancelled = false } = {}) {
        rec.cancelled = cancelled
        rec.error = rec.ok === true ? null : String(reason || 'aborted')
        rec.ok = false
        if (!rec.host.pend_lastByte) rec.host.pend_lastByte = +(mono() - t0Mono).toFixed(3)
        broadcast(PCM_ABORT, { streamId, reason: String(reason || ''), started: rec.started })
      },
    }
  }

  /** Merge the browser's half of a PCM measurement into the matching record. */
  function mergeBrowser(streamId, payload) {
    const rec = byId.get(streamId)
    if (!rec || !payload || typeof payload !== 'object') return false
    rec.browser = {
      p4_firstChunk: num(payload.p4_firstChunk),
      p5_threshold: num(payload.p5_threshold),
      p6_scheduled: num(payload.p6_scheduled),
      p6b_firstBlockGraph: num(payload.p6b_firstBlockGraph),
      p6b_firstBlockAcoustic: num(payload.p6b_firstBlockAcoustic),
      scheduledMs: num(payload.scheduledMs),
      // Two audible markers, deliberately:
      //   p7_signal  — the graph produced its first NON-ZERO sample. This is the
      //                transport/playback number.
      //   p7_audible — the graph produced its first sample above -60 dBFS, i.e.
      //                the first thing a listener would call sound.
      // They differ by however much near-silence the synthesizer emitted first,
      // which is a synthesis property, not a transport one, so conflating them
      // would hide which side a delay came from.
      p7_signalGraph: num(payload.p7_signalGraph),
      p7_signalAcoustic: num(payload.p7_signalAcoustic),
      p7_audibleGraph: num(payload.p7_audibleGraph),
      p7_audibleAcoustic: num(payload.p7_audibleAcoustic),
      p7_estimated: payload.p7_estimated === true,
      startupBufferedMs: num(payload.startupBufferedMs),
      receivedBytes: num(payload.receivedBytes),
      expectedBytes: num(payload.expectedBytes),
      underruns: num(payload.underruns) || 0,
      lateSchedules: num(payload.lateSchedules) || 0,
      maxLeadMs: num(payload.maxLeadMs),
      maxBufferedMs: num(payload.maxBufferedMs),
      maxChunkGapMs: num(payload.maxChunkGapMs),
      seqErrors: num(payload.seqErrors) || 0,
      droppedChunks: num(payload.droppedChunks) || 0,
      outputLatencyMs: num(payload.outputLatencyMs),
      ctxRate: num(payload.ctxRate),
      ctxState: typeof payload.ctxState === 'string' ? payload.ctxState : null,
      resumeAttempts: num(payload.resumeAttempts),
      tap: payload.tap === true,
      stopped: payload.stopped === true,
      finishedWall: num(payload.finishedWall),
      p0Wall: num(payload.p0Wall),
      // Transport-health counters: a byte-count mismatch is only diagnosable
      // alongside the reason for it.
      sseConnects: num(payload.sseConnects),
      sseReconnects: num(payload.sseReconnects),
      sseChunkEvents: num(payload.sseChunkEvents),
      sseParseFailures: num(payload.sseParseFailures),
      lateChunks: num(payload.lateChunks),
    }
    if (rec.browser.underruns != null) rec.underrunsAtEnd = rec.browser.underruns
    return true
  }

  function snapshot() {
    return records.map((r) => ({ ...r }))
  }

  function clear() {
    const n = records.length
    records.length = 0
    byId.clear()
    return n
  }

  function activeCount() {
    return records.filter((r) => r.ok === null && r.kind !== 'wav').length
  }

  // ── WAV-path measurement ───────────────────────────────────────────────────
  //
  // The baseline has to be measured in the same store, with the same clock, or
  // the comparison is two unrelated experiments. These records carry no PCM
  // framing: the WAV path has one indivisible payload, so there is nothing to
  // sequence. They are keyed by piece id instead of streamId.
  //
  //   w0  request begins                      (host)
  //   w3  the complete WAV exists in DSH      (host)
  //   w4  the piece is published for polling  (host)
  //   w5  the browser received the payload    (client)
  //   w6  decode + object URL ready           (client)
  //   w7  playback started                    (client)
  function openWav({ id, sessionId, role, text }) {
    const t0Mono = mono()
    const rec = {
      streamId: `wav${++streamSeq}`,
      kind: 'wav',
      id,
      piece: Number(String(id).replace(/^u/, '')) || null,
      sessionId: sessionId || null,
      role: role || 'reply',
      textChars: text ? String(text).length : 0,
      sampleRate: 24000,
      channels: 1,
      format: 'wav',
      ok: null,
      cancelled: false,
      error: null,
      chunks: 1,
      bytes: 0,
      t0Wall: Date.now(),
      host: { w0_requestStart: 0, w3_wavComplete: null, w4_published: null, w1_firstAudio: null, w2_synthDone: null, ttsTotalMs: null },
      browser: null,
    }
    byId.set(rec.streamId, rec)
    record(rec)
    return {
      streamId: rec.streamId,
      get record() { return rec },
      complete(bytes) {
        rec.host.w3_wavComplete = +(mono() - t0Mono).toFixed(3)
        rec.host.w2_synthDone = rec.host.w3_wavComplete
        rec.t3Mono = mono()
        rec.bytes = num(bytes) || 0
        rec.ok = true
      },
      /**
       * The request failed or was cancelled before any audio existed. Recorded so
       * a WAV arm full of failures cannot look like a fast WAV arm.
       */
      fail(reason, { cancelled = false } = {}) {
        rec.cancelled = cancelled
        rec.error = String(reason || 'failed')
        rec.ok = false
      },
    }
  }

  function markWavPublished(streamId) {
    const rec = byId.get(streamId)
    if (!rec) return false
    // Measured from the absolute mark taken in complete(), not from the relative
    // w3 value — subtracting a duration from a clock reading produced a nonsense
    // 80,602,261 ms in the first pass.
    rec.host.w4_published = rec.t3Mono ? +(mono() - rec.t3Mono).toFixed(3) : null
    delete rec.t3Mono
    return true
  }

  /** Merge the browser's half of a WAV measurement, keyed by piece id. */
  function mergeWavBrowser(payload) {
    if (!payload || !payload.id) return false
    for (let i = records.length - 1; i >= 0; i--) {
      const rec = records[i]
      if (rec.kind !== 'wav' || rec.id !== payload.id) continue
      rec.browser = {
        w5_payloadReceived: num(payload.w5_payloadReceived),
        w6_decoded: num(payload.w6_decoded),
        w7_playbackStarted: num(payload.w7_playbackStarted),
        w7b_clockAdvancing: num(payload.w7b_clockAdvancing),
        leadInMs: num(payload.leadInMs),
        w8_firstAudible: num(payload.w8_firstAudible),
        pollWaitMs: num(payload.pollWaitMs),
        payloadBytes: num(payload.payloadBytes),
        mime: payload.mime || null,
        autoBlocked: payload.autoBlocked === true,
        error: payload.error || null,
        finishedWall: num(payload.finishedWall),
        p0Wall: num(payload.p0Wall),
      }
      return true
    }
    return false
  }

  return {
    open,
    openWav,
    markWavPublished,
    mergeBrowser,
    mergeWavBrowser,
    snapshot,
    clear,
    activeCount,
    get size() { return records.length },
  }
}

function num(v) {
  // Number(null) is 0 and Number('') is 0, so a MISSING mark would otherwise be
  // recorded as a 0 ms mark — which reads as "instant" and would quietly flatter
  // every summary built on it. Measured: streams whose tap never fired came back
  // as p7_audibleGraph = 0 rather than absent.
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * P0 -> P7 for one stream, from the merged host + browser record. Returns null
 * until both halves are present.
 *
 * P7 is reported twice on purpose. `graph` is measured — the render quantum in
 * which the audio graph produced its first non-silent sample. `acoustic` adds the
 * context's outputLatency, which is the honest estimate of when that sample left
 * the audio device and became audible. Neither is a substitute for the other.
 */
export function endToEnd(rec) {
  if (!rec || !rec.browser) return null
  const b = rec.browser
  const p0 = rec.host ? rec.host.p0_requestStart : 0
  const p4 = b.p4_firstChunk
  // Two audible-side numbers, deliberately not merged:
  //   signal  — first NON-ZERO sample rendered. Transport and playback only.
  //   audible — first sample above -60 dBFS. Includes whatever near-silence the
  //             synthesizer emitted first, which is a synthesis property.
  const p7s = b.p7_signalGraph
  const p7a = b.p7_audibleGraph
  return {
    streamId: rec.streamId,
    piece: rec.piece,
    p4: p4,
    p5: b.p5_threshold,
    p6: b.p6_scheduled,
    p6b: b.p6b_firstBlockGraph,
    p7_signal: p7s,
    p7_audible: p7a,
    p0_to_p4: p4 == null ? null : +(p4 - p0).toFixed(3),
    p0_to_p6b: b.p6b_firstBlockGraph == null ? null : +(b.p6b_firstBlockGraph - p0).toFixed(3),
    p0_to_p7_signal: p7s == null ? null : +(p7s - p0).toFixed(3),
    p0_to_p7_audible: p7a == null ? null : +(p7a - p0).toFixed(3),
    p0_to_p7_acoustic: b.p7_audibleAcoustic == null ? null : +(b.p7_audibleAcoustic - p0).toFixed(3),
    hostBlocks: rec.host,
    browserBlocks: {
      p4_to_p5: p4 == null || b.p5_threshold == null ? null : +(b.p5_threshold - p4).toFixed(3),
      p5_to_p6: b.p5_threshold == null || b.p6_scheduled == null ? null : +(b.p6_scheduled - b.p5_threshold).toFixed(3),
      p6_to_p7: b.p6_scheduled == null || p7s == null ? null : +(p7s - b.p6_scheduled).toFixed(3),
    },
    buffer: {
      startupBufferedMs: b.startupBufferedMs,
      underruns: b.underruns,
      lateSchedules: b.lateSchedules,
      maxLeadMs: b.maxLeadMs,
      maxBufferedMs: b.maxBufferedMs,
      maxChunkGapMs: b.maxChunkGapMs,
      seqErrors: b.seqErrors,
      droppedChunks: b.droppedChunks,
    },
    integrity: {
      receivedBytes: b.receivedBytes,
      expectedBytes: b.expectedBytes,
      bytesMatch: b.receivedBytes != null && b.expectedBytes != null ? b.receivedBytes === b.expectedBytes : null,
    },
    tap: b.tap,
    estimated: b.p7_estimated === true,
    stopped: b.stopped === true,
  }
}
