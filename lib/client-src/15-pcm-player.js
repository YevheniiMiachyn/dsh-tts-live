    // ── PCM streaming player (EXPERIMENTAL) ─────────────────────────────────
    //
    // LOCAL FORK (PCM stage): progressive PCM playback for the low-latency voice
    // path. Everything here is inert unless the host reports
    // `pcmStreamingExperimental` in /status, so the validated WAV path is
    // untouched by its presence.
    //
    // WHY AN <audio> ELEMENT CANNOT DO THIS
    //
    // The WAV path plays a Blob URL through `new Audio(url)` (20-player.js:143),
    // which requires the complete utterance to exist before a single sample can
    // be heard. Streaming needs a player that accepts samples as they arrive, so
    // this is a second, parallel player: WebAudio with one
    // AudioBufferSourceNode per arriving chunk, chained on a single future-time
    // cursor.
    //
    // WHY NOT AudioWorklet + ring buffer
    //
    // Measured need says scheduled buffers are enough. The TTS server's on_chunk
    // cadence is one codec frame for the first chunk (1920 samples = 80 ms,
    // measured) and its production is several times faster than real time, so a
    // producer that outruns the consumer this far does not need the
    // sample-accurate continuity guarantees a ring buffer buys, and it does need
    // to not ship a worklet for every user. Candidate A was chosen; the ring
    // buffer stays available if measurement ever shows scheduled buffers cannot
    // hold a continuous stream.
    //
    // WHY THE CONTEXT RUNS AT THE STREAM'S OWN RATE
    //
    // 24000 Hz source into a 48000 Hz context would make Chrome resample EACH
    // AudioBuffer independently, and an independent resample has its own filter
    // edges: that is exactly the "click between PCM chunks" failure. Creating the
    // AudioContext at 24000 Hz means the chunk buffers need no resampling at all,
    // and the single resample to the device rate happens once, continuously, on
    // the final mix. Falls back to per-buffer resampling if the browser refuses
    // the requested rate.
    //
    // TIMING MARKS (P4..P7 of the stage's marker set)
    //
    //   P4  first PCM data received in the browser        (this file, handleChunk #1)
    //   P5  startup buffer threshold reached              (this file, pump → started)
    //   P6  browser playback scheduled                    (this file, first source.start)
    //   P7  first actually audible PCM sample             (tap worklet, this file)
    //
    // P7 is measured, not assumed: a sink worklet on the master bus reports the
    // render quantum in which the first non-silent sample is produced, and
    // `ctx.outputLatency` is added to estimate the acoustic instant. If the
    // worklet cannot be installed the player still plays, and P7 is reported as
    // the scheduling cursor instead, flagged `estimated: true`.
    function createPcmStreamPlayer(hooks) {
      const h = hooks || {}
      const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

      const cfgStartupMs = () => {
        const v = typeof h.startupMs === 'function' ? h.startupMs() : h.startupMs
        return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 120
      }
      const queueBusy = () => { try { return h.isBusy ? !!h.isBusy() : false } catch { return false } }
      const emit = (kind, data) => { try { if (h.onEvent) h.onEvent(kind, data) } catch { /* telemetry must never break audio */ } }
      const note = (msg) => { try { if (h.log) h.log(msg) } catch { /* logging must never break audio */ } }

      // 30 ms of headroom before the first block. Below this the scheduler is
      // racing the render thread; above it, latency is being handed away for
      // nothing. Both ends of this are measured in the startup-buffer sweep.
      const MIN_LEAD_S = 0.03
      const SWEEP_MS = 25

      // A stream that STOPS ARRIVING would otherwise sit in the queue forever and
      // block every later piece, so it has to be timed out. The timeout has to
      // measure idleness, though, and the first version measured elapsed time
      // from a fixed origin instead — which abandoned two kinds of healthy stream:
      //
      //   * a stream whose first byte was slow, because pcm-start is broadcast
      //     when the REQUEST is issued, before any audio exists (pcm-stream.js
      //     `open`), so the budget was being spent waiting for the TTS server
      //     rather than watching for a dead stream. With the server's single
      //     synthesis slot, a request queued behind a few pieces waits seconds;
      //     measured, 4 simultaneous requests get their first bytes at 75, 1978,
      //     3746 and 5706 ms. Anything past 5 s was abandoned before it produced
      //     a single sample, and every chunk that then arrived was discarded as
      //     late — the host reported success while the listener heard nothing.
      //   * a long stream that was delivering perfectly, because the deadline ran
      //     from the FIRST chunk and was never renewed. Measured in the soak: a
      //     13.8 s piece began playing at 3739 ms and was cut off at 5103 ms,
      //     which is exactly its first chunk plus 5 s, while its chunks were still
      //     arriving (last byte at 5618 ms). A neighbouring piece survived only
      //     because its first byte was late enough (4033 ms) to push the same
      //     deadline past its own last byte (7898 ms).
      //
      // So: once a stream is flowing, 5 s of silence means it is dead. Before the
      // first chunk arrives the host owns the decision — it has its own provider
      // timeout and sends pcm-abort — and this is only a backstop for a host that
      // vanished without one, so it waits far longer than that timeout.
      const STALL_MS = 5000           // no event for this long, once flowing
      const STALL_START_MS = 90000    // no first chunk at all (host timeout is 60 s)

      const TAP_SRC = `
class DshPcmTap extends AudioWorkletProcessor {
  constructor () {
    super()
    this.blocks = 0
    // One armed WINDOW per stream, not one flag per processor.
    //
    // The processor lives as long as the AudioContext, so a single boolean
    // "already reported" would measure the first stream of a page and nothing
    // after it — measured: streams 2 and 3 of a reply came back with no audible
    // mark at all. A window carries the context time at which its stream was
    // scheduled to start, so a block can be attributed to the stream it belongs
    // to even though several windows are open at once.
    this.windows = []
    this.port.onmessage = (e) => {
      const d = e.data || {}
      if (d.type === 'arm') {
        // Close the previous window exactly where this one opens: the streams are
        // scheduled end to end on one cursor, so that boundary is unambiguous.
        const prev = this.windows[this.windows.length - 1]
        if (prev && prev.to === null) prev.to = d.from
        this.windows.push({ id: d.id, from: d.from, to: null, signalled: false, reported: false })
        if (this.windows.length > 8) this.windows.shift()
      } else if (d.type === 'disarm') {
        this.windows = this.windows.filter((w) => w.id !== d.id)
      }
    }
    this.port.postMessage({ type: 'init' })
  }
  process (inputs, outputs) {
    const inp = inputs[0]
    const out = outputs[0]
    if (inp && inp.length && out && out.length) {
      for (let ch = 0; ch < out.length; ch++) {
        const src = inp[ch] || inp[0]
        if (src) out[ch].set(src)
      }
    }
    this.blocks++
    if (this.blocks === 1) {
      this.port.postMessage({ type: 'firstblock', currentTime, currentFrame, inChannels: inp ? inp.length : 0, outChannels: out ? out.length : 0 })
    }
    if (!inp || !inp.length) return true
    let peak = 0
    for (let ch = 0; ch < inp.length; ch++) {
      const d = inp[ch]
      if (!d) continue
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a }
    }
    if (peak <= 0) return true
    // TWO thresholds, because they answer two different questions.
    //
    // 'first-signal' fires on any non-zero sample: the moment the transport and
    // the audio graph have actually put a sample on the wire, which is the
    // transport/playback number.
    //
    // 'first-audio' fires above 0.001 (-60 dBFS): the moment something is
    // AUDIBLE. qwentts.cpp sometimes emits 400-500 ms of near-silence before
    // speech starts (measured envelope 4-8 of 32767, about -78 dBFS), so the two
    // events can be half a second apart and only the second is what a listener
    // would call "she started talking".
    for (const w of this.windows) {
      if (w.to !== null && currentTime >= w.to) continue
      // currentTime is the START of this render quantum, which can precede the
      // scheduled start by up to one quantum. A quantum of tolerance is exact,
      // not a fudge: no sample of this stream can be rendered before its start.
      if (currentTime + 128 / sampleRate < w.from) continue
      if (!w.signalled) {
        w.signalled = true
        this.port.postMessage({ type: 'first-signal', id: w.id, currentTime, currentFrame, peak, blocks: this.blocks })
      }
      if (!w.reported && peak > 0.001) {
        w.reported = true
        this.port.postMessage({ type: 'first-audio', id: w.id, currentTime, currentFrame, peak, blocks: this.blocks })
      }
    }
    return true
  }
}
registerProcessor('dsh-pcm-tap', DshPcmTap)
`

      let ctx = null
      let master = null
      let tap = null
      let tapReady = false
      let tapFailed = false
      let ctxRate = 0
      let tapInit = false
      let tapFirstBlock = null
      const tapMessages = []
      let nextTime = 0            // ctx-time cursor for the stream being scheduled
      let currentPiece = null     // piece number currently scheduling
      let sweeping = false
      let sweepTimer = null
      let disposed = false
      let lastActivity = 0

      const streams = new Map()        // streamId -> state
      const liveByPiece = new Map()    // piece number -> streamId (not yet finished)
      const cancelledPieces = new Set()
      const cancelledOrder = []
      // Every source that has been started and has not yet ended. Holding the
      // reference is both a lifetime guarantee (a source is not the graph's only
      // reason to keep a node alive once start() has been called and the caller
      // let go of it) and the bookkeeping that makes "stop everything" and
      // "how many nodes are outstanding" possible at all.
      const liveNodes = new Set()

      const stats = {
        streams: 0,
        chunks: 0,
        blocks: 0,
        underruns: 0,
        lateSchedules: 0,
        droppedChunks: 0,
        lateChunks: 0,
        seqErrors: 0,
        stops: 0,
        errors: 0,
        maxLeadMs: 0,
        maxBufferedMs: 0,
        maxChunkGapMs: 0,
        lastChunkGapMs: 0,
        tapFailures: 0,
        resumeAttempts: 0,
      }

      // A real page's AudioContext needs a user gesture. Attaching this once at
      // construction means the resume happens on the first click anywhere — which
      // in this UI is usually the composer — rather than depending on the user
      // happening to press play first.
      if (typeof window !== 'undefined' && window.addEventListener) {
        const unlock = () => {
          try { if (ctx && ctx.state === 'suspended') ctx.resume() } catch { /* ignore */ }
        }
        for (const ev of ['pointerdown', 'keydown', 'click']) {
          try { window.addEventListener(ev, unlock, { passive: true }) } catch { /* ignore */ }
        }
      }

      function markCancelled(piece) {
        if (piece == null) return
        cancelledPieces.add(piece)
        cancelledOrder.push(piece)
        while (cancelledOrder.length > 200) cancelledPieces.delete(cancelledOrder.shift())
      }

      // ── audio graph ───────────────────────────────────────────────────────
      async function ensureContext(sampleRate) {
        if (ctx && ctx.state !== 'closed') return ctx
        const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext)
        if (!AC) { stats.errors++; return null }
        const wanted = sampleRate || 24000
        try {
          ctx = new AC({ latencyHint: 'interactive', sampleRate: wanted })
        } catch {
          try { ctx = new AC({ latencyHint: 'interactive' }) } catch { stats.errors++; return null }
        }
        if (ctx.state === 'suspended') { try { await ctx.resume() } catch { /* autoplay policy */ } }
        ctxRate = ctx.sampleRate
        master = ctx.createGain()
        master.gain.value = 1

        // Tap first, so the very first block is already observed. A failure here
        // costs telemetry only, never audio.
        try {
          const blob = new Blob([TAP_SRC], { type: 'application/javascript' })
          const url = URL.createObjectURL(blob)
          await ctx.audioWorklet.addModule(url)
          URL.revokeObjectURL(url)
          tap = new AudioWorkletNode(ctx, 'dsh-pcm-tap', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
          })
          master.connect(tap)
          tap.connect(ctx.destination)
          tapReady = true
          // Liveness of the tap itself: 'init' proves the processor loaded,
          // 'firstblock' proves process() is being pulled by the graph. Without
          // both, a silent tap cannot be told apart from a dead one.
          try {
            tap.port.addEventListener('message', (ev) => {
              const d = (ev && ev.data) || {}
              tapMessages.push(d)
              if (tapMessages.length > 50) tapMessages.shift()
              if (d.type === 'init') tapInit = true
              if (d.type === 'firstblock') tapFirstBlock = d
            })
            // REQUIRED. A MessagePort only begins dispatching when onmessage is
            // assigned or start() is called; with addEventListener alone the
            // listener exists and no message is ever delivered, which looks
            // exactly like "no audio came out".
            tap.port.start()
          } catch { /* diagnostic only */ }
        } catch (e) {
          stats.tapFailures++
          tapFailed = true
          tap = null
          try { master.connect(ctx.destination) } catch { /* already connected */ }
          note('pcm: tap worklet unavailable, P7 will be estimated: ' + (e && e.message || e))
        }
        return ctx
      }

      // ── stream bookkeeping ────────────────────────────────────────────────
      function newStream(meta) {
        const s = {
          streamId: meta.streamId,
          piece: meta.piece == null ? null : Number(meta.piece),
          sr: Number(meta.sampleRate) || 24000,
          ch: Number(meta.channels) || 1,
          segs: [],
          segSamples: 0,
          receivedBytes: 0,
          receivedSamples: 0,
          lastSeq: -1,
          ended: false,
          finalBytes: null,
          started: false,
          finished: false,
          startCtxTime: 0,
          scheduledSamples: 0,
          scheduledEndCtx: 0,
          tapTimer: null,
          pendingCarry: null,
          tStart: now(),
          tFirstChunk: null,
          // Renewed on every chunk. The stall guard reads this, not tFirstChunk or
          // tStart: a long piece that is delivering steadily is not stalled.
          tLastEvent: now(),
          tThreshold: null,
          tScheduled: null,
          tSignal: null,
          tAudible: null,
          tEnd: null,
          startupBufferedMs: null,
          gaps: 0,
          worstGapMs: 0,
          lateBlocks: 0,
          maxLeadMs: 0,
          maxBufferedMs: 0,
          seqErrors: 0,
          dropped: 0,
          tapArmed: false,
          tapHandler: null,
        }
        streams.set(s.streamId, s)
        if (s.piece != null) liveByPiece.set(s.piece, s.streamId)
        stats.streams++
        return s
      }

      function releaseStream(s) {
        if (s.piece != null && liveByPiece.get(s.piece) === s.streamId) liveByPiece.delete(s.piece)
        streams.delete(s.streamId)
        s.segs.length = 0
        s.pendingCarry = null

        // The tap window must OUTLIVE the scheduling.
        //
        // Scheduling finishes when the last chunk has been handed to the graph,
        // but the producer runs several times faster than real time, so the audio
        // is scheduled SECONDS before it is rendered. Tearing the window down here
        // removed the measurement for exactly those streams: measured, only the
        // first piece of a page was ever reported, while pieces 2 and 3 came back
        // with p4/p5/p6 and no audible mark at all.
        //
        // So the window is kept until the stream's audio has actually played, and
        // released by a timer sized from the graph clock.
        const stillWaiting = tapReady && s.started && (s.tSignal === null || s.tAudible === null)
        if (stillWaiting && ctx && ctx.state !== 'closed') {
          const remainingMs = Math.max(0, (s.scheduledEndCtx - ctx.currentTime) * 1000) + 2500
          s.tapTimer = setTimeout(() => releaseTap(s), remainingMs)
          if (s.tapTimer.unref) s.tapTimer.unref()
          return
        }
        releaseTap(s)
      }

      /** Drop one stream's tap window and its message listener. */
      function releaseTap(s) {
        if (s.tapTimer) { clearTimeout(s.tapTimer); s.tapTimer = null }
        if (s.tapHandler && tap) { try { tap.port.removeEventListener('message', s.tapHandler) } catch { /* gone */ } }
        if (s.tapArmed && tap) { try { tap.port.postMessage({ type: 'disarm', id: s.streamId }) } catch { /* gone */ } }
        s.tapHandler = null
      }

      function bufferedMs(s) {
        return (s.segSamples / Math.max(1, s.sr)) * 1000
      }

      // ── scheduling ────────────────────────────────────────────────────────
      /**
       * The stream that may schedule right now: the live stream with the lowest
       * piece number. Lowest-first — not arrival-first — is what preserves
       * "piece N before N+1" no matter which synthesis finished first, and it is
       * the same rule the host applies in insertInOrder() (index.js:648).
       */
      function pickCurrent() {
        if (currentPiece != null) {
          const id = liveByPiece.get(currentPiece)
          if (id && streams.has(id)) return streams.get(id)
          currentPiece = null
        }
        let best = null
        for (const s of streams.values()) {
          if (s.finished) continue
          if (s.piece == null) continue
          if (best === null || s.piece < best.piece) best = s
        }
        return best
      }

      function scheduleSegment(s, samples, sampleCount) {
        if (!ctx || sampleCount <= 0) return
        const buf = ctx.createBuffer(1, sampleCount, s.sr)
        buf.copyToChannel(samples.subarray(0, sampleCount), 0)
        const node = ctx.createBufferSource()
        node.buffer = buf
        if (h.rate) { try { node.playbackRate.value = Math.max(0.5, Math.min(2, h.rate() || 1)) } catch { /* rate is cosmetic */ } }
        node.connect(master)
        liveNodes.add(node)
        const rate = (h.rate && h.rate()) || 1
        const durSec = (sampleCount / s.sr) / (rate > 0 ? rate : 1)

        const lead = nextTime - ctx.currentTime
        if (lead < MIN_LEAD_S) {
          // Anchoring the cursor before the stream has started is not a defect:
          // nextTime begins at 0 and the context has been running for a while.
          // Only a shortfall AFTER playback began is real starvation.
          if (s.started) {
            const late = MIN_LEAD_S - lead
            stats.underruns++
            stats.lateSchedules++
            s.gaps++
            const gapMs = late * 1000
            if (gapMs > s.worstGapMs) s.worstGapMs = gapMs
            emit('underrun', { streamId: s.streamId, piece: s.piece, gapMs: +gapMs.toFixed(2), atBufferedMs: +bufferedMs(s).toFixed(2) })
            s.lateBlocks++
          }
          nextTime = ctx.currentTime + MIN_LEAD_S
        }
        const when = nextTime
        node.onended = () => {
          liveNodes.delete(node)
          try { node.buffer = null } catch { /* already released */ }
          try { node.disconnect() } catch { /* already gone */ }
        }
        try {
          node.start(when)
        } catch (e) {
          stats.errors++
          liveNodes.delete(node)
          emit('error', { streamId: s.streamId, message: 'start failed: ' + (e && e.message || e) })
          try { node.disconnect() } catch { /* gone */ }
          return
        }
        nextTime = when + durSec
        s.scheduledSamples += sampleCount
        s.scheduledEndCtx = nextTime
        stats.blocks++

        const leadMs = (nextTime - ctx.currentTime) * 1000
        if (leadMs > stats.maxLeadMs) stats.maxLeadMs = leadMs
        if (leadMs > s.maxLeadMs) s.maxLeadMs = leadMs

        if (!s.started) {
          s.started = true
          s.startCtxTime = when
          s.tScheduled = now()
          // The SCHEDULED start, on the host's timeline. This is what proves piece
          // ordering: the audible mark depends on how much near-silence each piece
          // begins with, so two pieces can look overlapped when they are not. The
          // scheduled starts cannot lie — each one is placed on the same cursor as
          // the previous piece's end.
          emit('scheduled-start', {
            streamId: s.streamId,
            piece: s.piece,
            ctxTimeMs: when * 1000,
            outputLatencyMs: ctx && ctx.outputLatency != null ? ctx.outputLatency * 1000 : null,
          })
          if (tapReady) {
            // Arm a measurement window that opens exactly at this stream's
            // scheduled start, so a still-playing previous stream cannot be
            // mistaken for this one's first sample.
            try { tap.port.postMessage({ type: 'arm', id: s.streamId, from: when }) } catch { /* telemetry only */ }
            s.tapArmed = true
            s.tapHandler = (ev) => {
              const d = ev.data || {}
              if (d.id !== s.streamId) return
              const ctxMs = d.currentTime != null ? d.currentTime * 1000 : null
              const outLat = ctx && ctx.outputLatency != null ? ctx.outputLatency * 1000 : null
              const common = {
                streamId: s.streamId,
                piece: s.piece,
                ctxTimeMs: ctxMs,
                outputLatencyMs: outLat,
                acousticEstimateMs: ctxMs != null && outLat != null ? +(ctxMs + outLat).toFixed(3) : null,
                peak: d.peak,
                estimated: false,
              }
              if (d.type === 'first-signal') {
                if (s.tSignal === null) {
                  s.tSignal = now()
                  emit('audible-signal', common)
                  // The final report usually goes out when scheduling completes,
                  // which happens BEFORE this sample is rendered. Re-report so the
                  // measurement is not left half-filled.
                  emit('reported', { streamId: s.streamId })
                }
                return
              }
              if (d.type === 'first-audio' && s.tAudible === null) {
                s.tAudible = now()
                emit('audible', common)
                emit('reported', { streamId: s.streamId })
              }
            }
            try { tap.port.addEventListener('message', s.tapHandler) } catch { /* telemetry only */ }
          }
          emit('scheduled', {
            streamId: s.streamId,
            piece: s.piece,
            startupBufferedMs: s.startupBufferedMs,
            leadMs: +((when - ctx.currentTime) * 1000).toFixed(3),
            tap: tapReady,
          })
        }
      }

      function pump() {
        if (disposed || !ctx || ctx.state === 'closed') return
        // A context created before the first user gesture starts suspended, and a
        // suspended context renders nothing — so the scheduling looks perfect and
        // no sound ever comes out. Nudge it here; the gesture listener installed
        // at construction is what makes the nudge succeed in a real page.
        if (ctx.state === 'suspended') {
          try { ctx.resume() } catch { /* policy will decide */ }
          stats.resumeAttempts++
          if (stats.resumeAttempts > 200) return   // stop churning; report instead
          return
        }
        if (queueBusy()) return   // keep chime / announcement ordering via the WAV queue
        for (let guard = 0; guard < 500; guard++) {
          const s = pickCurrent()
          if (!s) break
          if (!s.started) {
            const have = bufferedMs(s)
            const threshold = cfgStartupMs()
            if (!s.ended && have < threshold) break       // still filling the startup buffer
            if (s.segSamples <= 0 && !s.ended) break
            s.startupBufferedMs = +have.toFixed(2)
            s.tThreshold = now()
            currentPiece = s.piece
            emit('threshold', { streamId: s.streamId, piece: s.piece, bufferedMs: s.startupBufferedMs, ended: s.ended })
          }
          // Consume whole arriving segments: they are frame aligned, and one node
          // per arriving chunk keeps node count at ~10 per utterance.
          while (s.segs.length) {
            const seg = s.segs.shift()
            scheduleSegment(s, seg, seg.length)
            s.segSamples -= seg.length
          }
          const haveNow = bufferedMs(s)
          if (haveNow > stats.maxBufferedMs) stats.maxBufferedMs = haveNow
          if (haveNow > s.maxBufferedMs) s.maxBufferedMs = haveNow
          if (s.ended && s.segSamples === 0) {
            s.finished = true
            s.tEnd = now()
            currentPiece = null
            emit('finished', {
              streamId: s.streamId,
              piece: s.piece,
              scheduledMs: +((s.scheduledSamples / Math.max(1, s.sr)) * 1000).toFixed(2),
              underruns: s.gaps,
              worstGapMs: +s.worstGapMs.toFixed(2),
              lateBlocks: s.lateBlocks,
              maxLeadMs: +s.maxLeadMs.toFixed(2),
              maxBufferedMs: +s.maxBufferedMs.toFixed(2),
              receivedBytes: s.receivedBytes,
              receivedSamples: s.receivedSamples,
              seqErrors: s.seqErrors,
              dropped: s.dropped,
              started: s.started,
            })
            releaseStream(s)
            if (streams.size === 0) emit('idle', {})
            continue
          }
          break
        }
        armSweep()
      }

      function armSweep() {
        if (disposed) return
        const active = streams.size > 0
        if (!active) {
          if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
          return
        }
        if (sweepTimer) return
        sweepTimer = setInterval(() => {
          if (disposed) return
          if (!streams.size) { clearInterval(sweepTimer); sweepTimer = null; return }
          // A stream that stopped arriving without an end event would otherwise
          // sit in the queue forever and block every later piece.
          const t = now()
          for (const s of [...streams.values()]) {
            if (s.ended || s.finished) continue
            // Two different failures need two different budgets. A stream that has
            // been delivering and then goes quiet is dead, and 5 s is generous. A
            // stream that has not produced its first chunk yet is almost always
            // waiting on the TTS server's admission queue, not dead, so the host's
            // own timeout decides and this only catches a host that vanished.
            const stalled = s.tFirstChunk === null
              ? (t - s.tStart) > STALL_START_MS
              : (t - s.tLastEvent) > STALL_MS
            if (stalled) {
              stats.errors++
              emit('stall', { streamId: s.streamId, piece: s.piece })
              s.ended = true
              pump()
            }
          }
          pump()
        }, SWEEP_MS)
        if (sweepTimer.unref) sweepTimer.unref()
      }

      // ── public surface ────────────────────────────────────────────────────
      return {
        /** Warm the audio context + tap so the first stream does not pay for it. */
        async prepare(sampleRate) {
          try { await ensureContext(sampleRate || 24000) } catch { /* graph is best effort */ }
          return !!(ctx && ctx.state !== 'closed')
        },

        async handleStart(meta) {
          if (disposed || !meta || !meta.streamId) return
          if (meta.piece != null && cancelledPieces.has(Number(meta.piece))) {
            stats.lateChunks++
            return
          }
          // The stream is created FIRST, synchronously, and only then is the audio
          // context awaited.
          //
          // Preparing the context is genuinely asynchronous (device open, then
          // audioWorklet.addModule), and the first PCM chunk arrives ~45 ms after
          // the host's request begins — comfortably inside that window. Creating
          // the stream afterwards meant every chunk of the first utterance of a
          // page arrived for a stream that did not exist yet and was counted as
          // late and discarded. Measured: 2 of 3 pieces in one arm produced no
          // browser-side measurement at all, with the third (context already
          // warm) complete.
          const s = newStream(meta)
          emit('start', { streamId: s.streamId, piece: s.piece, sampleRate: s.sr, channels: s.ch, ctxRate })
          await ensureContext(meta.sampleRate)
          if (!ctx) return
          pump()
        },

        handleChunk(meta) {
          if (disposed || !meta || !meta.streamId) return
          const s = streams.get(meta.streamId)
          if (!s) { stats.lateChunks++; return }          // a cancelled or unknown stream
          // Renew the stall budget on arrival, before any validation: this chunk is
          // proof the stream is alive even if its framing turns out to be bad.
          s.tLastEvent = now()
          const seq = Number(meta.seq)
          if (Number.isFinite(seq)) {
            if (seq !== s.lastSeq + 1) {
              // Out-of-order or duplicated framing. Counted, never guessed at.
              stats.seqErrors++
              s.seqErrors++
              if (seq <= s.lastSeq) { stats.droppedChunks++; s.dropped++; return }
            }
            s.lastSeq = seq
          }
          let bytes
          try {
            const bin = atob(meta.data || '')
            bytes = new Uint8Array(bin.length)
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          } catch { stats.errors++; return }

          const t = now()
          if (s.tFirstChunk === null) {
            s.tFirstChunk = t
            s.startupThresholdMs = cfgStartupMs()
            emit('first-byte', { streamId: s.streamId, piece: s.piece, bytes: bytes.length })
          } else {
            const gap = t - (s.tLastChunk || t)
            s.lastChunkGapMs = gap
            if (gap > stats.maxChunkGapMs) stats.maxChunkGapMs = gap
          }
          s.tLastChunk = t

          // Sample alignment: carry an odd trailing byte rather than dropping or
          // misaligning every following sample.
          let view = bytes
          if (s.pendingCarry) {
            const joined = new Uint8Array(bytes.length + 1)
            joined[0] = s.pendingCarry
            joined.set(bytes, 1)
            view = joined
            s.pendingCarry = null
          }
          const usable = view.length - (view.length % 2)
          if (usable < view.length) s.pendingCarry = view[view.length - 1]
          if (usable > 0) {
            const samples = new Float32Array(usable / 2)
            const dv = new DataView(view.buffer, view.byteOffset, usable)
            for (let i = 0; i < samples.length; i++) samples[i] = dv.getInt16(i * 2, true) / 32768
            s.segs.push(samples)
            s.segSamples += samples.length
            s.receivedSamples += samples.length
          }
          s.receivedBytes += bytes.length
          stats.chunks++
          const ms = bufferedMs(s)
          if (ms > stats.maxBufferedMs) stats.maxBufferedMs = ms
          lastActivity = t
          pump()
        },

        handleEnd(meta) {
          if (disposed || !meta || !meta.streamId) return
          const s = streams.get(meta.streamId)
          if (!s) { stats.lateChunks++; return }
          s.tLastEvent = now()
          s.ended = true
          s.finalBytes = meta.bytes == null ? null : Number(meta.bytes)
          emit('end', {
            streamId: s.streamId,
            piece: s.piece,
            receivedBytes: s.receivedBytes,
            declaredBytes: s.finalBytes,
            matched: s.finalBytes == null ? null : s.finalBytes === s.receivedBytes,
          })
          if (s.pendingCarry) s.pendingCarry = null
          pump()
        },

        handleAbort(meta) {
          if (disposed || !meta || !meta.streamId) return
          const s = streams.get(meta.streamId)
          if (!s) return
          emit('abort', { streamId: s.streamId, piece: s.piece, reason: meta.reason || '' })
          s.ended = true
          s.finished = true
          if (s.piece != null) markCancelled(s.piece)
          releaseTap(s)
          releaseStream(s)
          if (currentPiece === s.piece) currentPiece = null
          pump()
        },

        /**
         * Hard stop. Mirrors stopPlayback() for the WAV queue: nothing scheduled
         * survives, nothing buffered is kept, and every piece that was in flight
         * is remembered as cancelled so a late chunk cannot be spoken afterwards.
         */
        stop(reason) {
          stats.stops++
          for (const s of streams.values()) {
            if (s.piece != null) markCancelled(s.piece)
            if (s.segs) s.segs.length = 0
            releaseTap(s)
          }
          // Cancel every scheduled source. A source waiting on a future start
          // time cannot be silenced by dropping buffers: it holds its own copy.
          for (const node of [...liveNodes]) {
            try { node.onended = null } catch { /* gone */ }
            try { node.stop(0) } catch { /* never started or already stopped */ }
            try { node.buffer = null } catch { /* gone */ }
            try { node.disconnect() } catch { /* gone */ }
            liveNodes.delete(node)
          }
          if (ctx && master) {
            try {
              // Replacing the gain node is the only reliable way to silence nodes
              // that are already scheduled in the future and therefore cannot be
              // stopped by clearing a buffer.
              const old = master
              master = ctx.createGain()
              master.gain.value = 1
              if (tap) { master.connect(tap) } else { master.connect(ctx.destination) }
              try { old.disconnect() } catch { /* already gone */ }
            } catch { /* graph already torn down */ }
          }
          for (const s of [...streams.values()]) releaseStream(s)
          streams.clear()
          liveByPiece.clear()
          nextTime = 0
          currentPiece = null
          if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
          emit('stop', { reason: reason || '' })
        },

        /** Re-anchor the scheduling cursor after a silent period. */
        reset() {
          nextTime = ctx ? ctx.currentTime : 0
          currentPiece = null
        },

        get stats() { return { ...stats, active: streams.size, liveNodes: liveNodes.size, ctxState: ctx ? ctx.state : null, ctxRate, tap: tapReady, tapFailed } },
        /** Exposed for the measurement harness; not used by playback. */
        get context() { return ctx },
        get nextScheduledTime() { return nextTime },
        get debug() {
          return {
            tapReady, tapFailed, tapInit, tapFirstBlock,
            tapMessages: tapMessages.slice(-10),
            liveNodes: liveNodes.size,
            streams: [...streams.values()].map((s) => ({
              streamId: s.streamId, piece: s.piece, started: s.started, ended: s.ended,
              finished: s.finished, segSamples: s.segSamples, receivedSamples: s.receivedSamples,
              scheduledSamples: s.scheduledSamples, lastSeq: s.lastSeq,
            })),
            ctxTime: ctx ? +ctx.currentTime.toFixed(4) : null,
            nextTime: +nextTime.toFixed(4),
          }
        },
        get prepared() { return !!(ctx && ctx.state !== 'closed') },
        get activeStreams() { return streams.size },
        dispose() {
          disposed = true
          if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
          for (const s of streams.values()) releaseTap(s)
          try { if (ctx) ctx.close() } catch { /* already closed */ }
          ctx = null; master = null; tap = null
        },
      }
    }
