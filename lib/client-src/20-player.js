    // Player.
    //
    // Each incoming chunk used to replace the previous one immediately; while reading
    // For full replies this was invisible; with speak-as-it-goes only the last
    // chunk would be heard. Now items queue: the next starts after the previous ends.
    const autoplay = { blocked: false, listeners: new Set() }

    function setAutoplayBlocked(next) {
      if (autoplay.blocked === next) return
      autoplay.blocked = next
      for (const l of [...autoplay.listeners]) {
        try { l() } catch { /* listener isolation */ }
      }
    }

    function unlockAudio() {
      try {
        const AC = window.AudioContext || window.webkitAudioContext
        if (AC) {
          const ctx = new AC()
          if (ctx.state === 'suspended') ctx.resume().catch(() => { /* audio context unlock failure ignored */ })
          setTimeout(() => { try { ctx.close() } catch { /* closed */ } }, 300)
        }
      } catch { /* no AudioContext */ }
      setAutoplayBlocked(false)
      drainQueue()
    }

    function useAutoplayGate() {
      const [, force] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => {
        autoplay.listeners.add(force)
        return () => { autoplay.listeners.delete(force) }
      }, [])
      return autoplay
    }

    const player = {
      audio: null,
      after: '',
      enabled: false,
      // LOCAL FORK: live sentence streaming. `pollMs` is how often the pending
      // audio queue is collected — the audio path is a poll, so this interval is
      // on the first-audio critical path. The host lowers it while live sentence
      // flush is on; the upstream 1000 ms stays the default.
      pollMs: 1000,
      liveEnabled: false,
      rate: 1,
      chime: 'ding',
      queue: [],
      bargeIn: true,
      busy: false,
      paused: false,
      // LOCAL FORK (0.4.16-local.4): true while audio is actually being played.
      speaking: false,
      listeners: new Set(),
      unlockAudio,
      useAutoplayGate,
      get autoplayBlocked() { return autoplay.blocked },
      /**
       * True while the progressive PCM graph still has audio booked ahead of the
       * playhead. The WAV path answers this through `audio`/`queue`; PCM has
       * neither, so the dock needs this term or its controls vanish for the whole
       * of every PCM reply.
       */
      get pcmPlaying() {
        try { return !!(pcmStreaming && pcmStreaming.playing) } catch { return false }
      },
    }
    const seenIds = new Set()
    let currentAudioResolve = null
    function playerChanged() {
      for (const listener of [...player.listeners]) {
        try { listener() } catch (listenerFailure) { /* foreign listener failure is not ours */ }
      }
    }

    // LOCAL FORK (0.4.16-local.4): publish playback state.
    //
    // `dsh:tts:start` / `dsh:tts:stop` were only ever *listened* for — dsh-voice uses
    // them for its turn-taking (`isTtsSpeaking`) — and nothing ever dispatched them,
    // so that state was permanently false. It now backs the voice plugin's barge-in
    // gate, so it must be true while the assistant speaks and false the moment it
    // stops. Edges only: a listener must never see two starts in a row.
    function announceSpeech(on) {
      const next = on === true
      if (player.speaking === next) return
      player.speaking = next
      // Speaking is part of the player snapshot the UI renders from, so a change to
      // it has to re-render its consumers. The dock's pause/stop controls are shown
      // while she speaks, and without this they never appeared for progressive PCM:
      // speaking flipped true but nothing told React.
      playerChanged()
      if (typeof window === 'undefined') return
      try { window.dispatchEvent(new CustomEvent(next ? 'dsh:tts:start' : 'dsh:tts:stop')) } catch { /* no CustomEvent */ }
    }

    function usePlayer() {
      const [, force] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => {
        player.listeners.add(force)
        return () => { player.listeners.delete(force) }
      }, [])
      return player
    }

    // Short chime is synthesized in-browser: no file to download, store, or configure.
    function playChime(kind) {
      return new Promise((resolve) => {
        try {
          const AC = window.AudioContext || window.webkitAudioContext
          if (!AC) { resolve(); return }
          const audioCtx = new AC()
          const gain = audioCtx.createGain()
          gain.connect(audioCtx.destination)
          const tones = kind === 'beep' ? [880, 880] : [660, 990]
          let at = audioCtx.currentTime
          for (const freq of tones) {
            const osc = audioCtx.createOscillator()
            osc.frequency.value = freq
            osc.connect(gain)
            gain.gain.setValueAtTime(0.0001, at)
            gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02)
            gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18)
            osc.start(at)
            osc.stop(at + 0.2)
            at += 0.22
          }
          setTimeout(() => { try { audioCtx.close() } catch (already) { /* already closed */ } resolve() }, 600)
        } catch { resolve() /* no AudioContext */ }
      })
    }

    // Provider failed — fall back to the browser voice. Worse quality, but silence
    // is worse: the user would not know the reply is ready.
    function speakInBrowser(text) {
      return new Promise((resolve) => {
        try {
          if (!window.speechSynthesis || !text) { resolve(); return }
          const utterance = new SpeechSynthesisUtterance(String(text))
          utterance.rate = Math.max(0.5, Math.min(2, player.rate || 1))
          utterance.onend = () => resolve()
          utterance.onerror = () => resolve()
          window.speechSynthesis.speak(utterance)
        } catch { resolve() /* no speechSynthesis */ }
      })
    }

    function prepareAudioItem(item) {
      if (!item || !item.audioBase64 || item.prepared) return item
      try {
        const bin = atob(item.audioBase64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const blob = new Blob([bytes], { type: item.mime || 'audio/mpeg' })
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        audio.preload = 'auto'
        item.prepared = { audio, url, leadInMs: wavLeadInMs(bytes, item.mime) }
        wavMarkDecoded(item)
      } catch { /* decode error — item stays unprepared */ }
      return item
    }

    function prebufferNext() {
      for (const next of player.queue) {
        if (next && next.audioBase64 && !next.prepared) {
          prepareAudioItem(next)
          break
        }
      }
    }

    function playAudio(item) {
      return new Promise((resolve) => {
        try {
          prepareAudioItem(item)
          if (!item.prepared) return resolve()
          const { audio, url } = item.prepared
          // LOCAL FORK (PCM stage): WAV-path measurement. W5 is the payload
          // arriving, W6 the decode/object-URL becoming ready, W7 the moment
          // playback actually started. Marked against the host's W0 so both arms
          // land on one timeline. Bookkeeping only — nothing here changes how the
          // audio is played.
          const wav = wavMarkStart(item)
          audio.playbackRate = Math.max(0.5, Math.min(2, player.rate || 1))
          player.audio = audio
          if (item.text) player.lastText = item.text
          playerChanged()
          prebufferNext()
          let doneCalled = false
          const done = () => {
            if (doneCalled) return
            doneCalled = true
            currentAudioResolve = null
            try { URL.revokeObjectURL(url) } catch { /* URL already revoked */ }
            item.prepared = null
            player.audio = null
            playerChanged()
            resolve()
          }
          currentAudioResolve = done
          audio.onended = done
          audio.onerror = () => { if (wav) wav.fail('audio element error'); done() }
          audio.play().then(() => {
            announceSpeech(true)
            if (wav) wav.started(audio)
          }).catch((playErr) => {
            // Autoplay without a user gesture is blocked — surface unlock UX, then stop this chunk.
            if (playErr && (playErr.name === 'NotAllowedError' || playErr.name === 'SecurityError')) {
              setAutoplayBlocked(true)
              if (wav) wav.fail('autoplay blocked', { autoBlocked: true })
            } else if (wav) {
              wav.fail(String(playErr && playErr.name || playErr))
            }
            done()
          })
        } catch { /* cannot decode — skip chunk */
          currentAudioResolve = null
          resolve()
        }
      })
    }

    // LOCAL FORK (PCM stage): the progressive player, and the SSE framing that
    // feeds it. Inert until /status reports pcm.enabled, so nothing here can
    // affect the validated WAV path.
    //
    // Ordering is preserved by two separate rules working together:
    //   * the host emits pieces in `u<n>` order and the player schedules the
    //     LOWEST piece number first (pcm-player.js pickCurrent), so a piece can
    //     never overtake one that started before it;
    //   * `isBusy` holds the first block back while the WAV queue is playing, so
    //     a chime or an announcement is never talked over by the sentence after
    //     it — the same serialisation the queue already provided.
    const pcm = { enabled: false, telemetry: false, startupMs: 120, prepared: false }
    const pcmStreams = new Map()
    // Counters that exist because a chunk CAN go missing and the reason has to be
    // visible rather than inferred: an SSE reconnect drops whatever was in flight,
    // and a chunk for a stream that has already been released is dropped too.
    const sseDiag = { connects: 0, reconnects: 0, chunkEvents: 0, parseFailures: 0 }

    const pcmStreaming = createPcmStreamPlayer({
      startupMs: () => pcm.startupMs,
      isBusy: () => !!player.busy || player.queue.length > 0 || !!player.audio,
      rate: () => player.rate || 1,
      log: (message) => { try { console.info('[dsh-tts] ' + message) } catch (noConsole) { /* ignore */ } },
      onEvent: (kind, data) => pcmEvent(kind, data),
    })

    // P7 conversion: the tap reports the CONTEXT time of the render quantum that
    // first carried audio. Both Date.now() and ctx.currentTime advance while the
    // message is in flight, so sampling both at handling time cancels the
    // postMessage delay and yields the wall clock of that quantum.
    function pcmCtxToWall(ctx, ctxTimeMs) {
      if (!ctx || typeof ctxTimeMs !== 'number') return null
      return Date.now() - (ctx.currentTime * 1000 - ctxTimeMs)
    }

    function pcmEvent(kind, data) {
      try {
        const rec = data && data.streamId ? pcmStreams.get(data.streamId) : null
        if (!rec) return
        const rel = () => Date.now() - rec.t0Wall
        if (kind === 'first-byte') rec.p4 = rel()
        else if (kind === 'threshold') { rec.p5 = rel(); rec.startupBufferedMs = data.bufferedMs }
        else if (kind === 'scheduled') {
          rec.p6 = rel()
          // dsh-voice's turn-taking reads this state; progressive playback has to
          // publish it just as the <audio> element does.
          announceSpeech(true)
        } else if (kind === 'scheduled-start') {
          const wall = pcmCtxToWall(pcmStreaming.context, data.ctxTimeMs)
          rec.p6b_firstBlockGraph = wall === null ? null : wall - rec.t0Wall
          rec.p6b_firstBlockAcoustic = wall === null ? null : (wall + (data.outputLatencyMs || 0)) - rec.t0Wall
        } else if (kind === 'audible') {
          const wall = pcmCtxToWall(pcmStreaming.context, data.ctxTimeMs)
          rec.p7Graph = wall === null ? null : wall - rec.t0Wall
          rec.p7Acoustic = wall === null ? null : (wall + (data.outputLatencyMs || 0)) - rec.t0Wall
          rec.p7Estimated = data.estimated === true
          rec.outputLatencyMs = data.outputLatencyMs
        } else if (kind === 'audible-signal') {
          // First NON-ZERO sample: the transport and playback floor, as opposed to
          // the first AUDIBLE sample. The gap between the two is near-silence the
          // synthesizer emitted, which is a synthesis property rather than a
          // transport one, so the two are never merged into one number.
          const wall = pcmCtxToWall(pcmStreaming.context, data.ctxTimeMs)
          rec.p7SignalGraph = wall === null ? null : wall - rec.t0Wall
          rec.p7SignalAcoustic = wall === null ? null : (wall + (data.outputLatencyMs || 0)) - rec.t0Wall
          rec.outputLatencyMs = data.outputLatencyMs
        } else if (kind === 'end') {
          rec.receivedBytes = data.receivedBytes
          rec.expectedBytes = data.declaredBytes
        } else if (kind === 'finished') {
          rec.finished = true
          rec.underruns = data.underruns
          rec.lateBlocks = data.lateBlocks
          rec.maxLeadMs = data.maxLeadMs
          rec.maxBufferedMs = data.maxBufferedMs
          rec.seqErrors = data.seqErrors
          rec.dropped = data.dropped
          rec.scheduledMs = data.scheduledMs
          pcmReport(rec)
        } else if (kind === 'idle' || kind === 'stop') {
          announceSpeech(false)
        } else if (kind === 'reported') {
          // A late audible mark arrived after the scheduling-time report. The host
          // replaces the whole browser half on a re-post, so this completes the
          // record instead of duplicating it.
          pcmReport(rec)
        } else if (kind === 'stall' || kind === 'error') {
          // A stream that never ends must still be reported: otherwise a lost
          // end-of-stream event silently removes the measurement rather than
          // showing up as the failure it is.
          rec.problem = kind
          rec.stopped = true
          pcmReport(rec)
        }
      } catch (telemetryFailure) { /* telemetry must never affect audio */ }
    }

    function pcmReport(rec) {
      if (!rec || !pcm.telemetry) return
      const st = pcmStreaming.stats
      const body = {
        streamId: rec.streamId,
        p0Wall: rec.t0Wall,
        p4_firstChunk: rec.p4,
        p5_threshold: rec.p5,
        p6_scheduled: rec.p6,
        p6b_firstBlockGraph: rec.p6b_firstBlockGraph,
        p6b_firstBlockAcoustic: rec.p6b_firstBlockAcoustic,
        scheduledMs: rec.scheduledMs,
        p7_audibleGraph: rec.p7Graph,
        p7_audibleAcoustic: rec.p7Acoustic,
        p7_signalGraph: rec.p7SignalGraph,
        p7_signalAcoustic: rec.p7SignalAcoustic,
        p7_estimated: rec.p7Estimated === true,
        startupBufferedMs: rec.startupBufferedMs,
        receivedBytes: rec.receivedBytes,
        expectedBytes: rec.expectedBytes,
        underruns: rec.underruns,
        lateSchedules: rec.lateBlocks,
        maxLeadMs: rec.maxLeadMs,
        maxBufferedMs: rec.maxBufferedMs,
        maxChunkGapMs: st.maxChunkGapMs,
        seqErrors: rec.seqErrors,
        droppedChunks: rec.dropped,
        outputLatencyMs: rec.outputLatencyMs,
        ctxRate: st.ctxRate,
        ctxState: st.ctxState,
        tap: st.tap,
        resumeAttempts: st.resumeAttempts,
        stopped: rec.stopped === true,
        finishedWall: Date.now(),
        // Transport-health counters. A byte-count mismatch is only actionable
        // alongside the reason for it.
        sseConnects: sseDiag.connects,
        sseReconnects: sseDiag.reconnects,
        sseChunkEvents: sseDiag.chunkEvents,
        sseParseFailures: sseDiag.parseFailures,
        lateChunks: st.lateChunks,
      }
      try {
        fetch('/dsh-tts/pcm-telemetry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).catch(() => { /* host restarting; the record stays host-side */ })
      } catch { /* fetch unavailable */ }
    }

    // ── WAV-path measurement ──────────────────────────────────────────────────
    //
    // The baseline needs the same treatment as the prototype, or the two numbers
    // are not comparable. W0 is stamped by the host when the synthesis request
    // begins and travels with the queue row as `w0Wall`; every mark below is
    // expressed against it, so both arms share one timeline.
    //
    //   w5  the payload arrived in the browser
    //   w6  decode finished and the playback object exists
    //   w7  playback started (the play() promise resolved)
    //   w7b the media clock is actually advancing
    //
    // This is bookkeeping only: it observes the existing path and changes none of
    // it. A WAV arm that fails is recorded as failing rather than silently
    // dropped, so a run of errors cannot masquerade as a fast baseline.
    const wavMarks = new Map()

    // W8: the first AUDIBLE sample of a WAV piece.
    //
    // The PCM tap cannot be attached to an <audio> element without routing it
    // through the WebAudio graph, which would change the very path being
    // measured. It does not have to be: the browser already holds the decoded
    // payload, so the lead-in silence can be measured in the bytes themselves
    // with the same -60 dBFS threshold the PCM tap uses. W8 is then
    // W7b (the media clock started advancing) plus that lead-in.
    //
    // This is exact rather than approximate: the element plays the file from
    // sample 0, so the offset of the first audible sample inside the file IS the
    // delay between playback starting and sound being heard.
    function wavLeadInMs(bytes, mime) {
      try {
        if (!bytes || bytes.length < 64) return null
        if (String(mime || '').indexOf('wav') === -1) return null
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        if (dv.getUint32(0, false) !== 0x52494646) return null      // 'RIFF'
        if (dv.getUint32(8, false) !== 0x57415645) return null      // 'WAVE'
        let off = 12
        let channels = 1
        let rate = 24000
        let bits = 16
        let dataAt = -1
        let dataLen = 0
        while (off + 8 <= dv.byteLength) {
          const id = dv.getUint32(off, false)
          const size = dv.getUint32(off + 4, true)
          const body = off + 8
          if (id === 0x666d7420) {                                  // 'fmt '
            channels = dv.getUint16(body + 2, true) || 1
            rate = dv.getUint32(body + 4, true) || 24000
            bits = dv.getUint16(body + 14, true) || 16
          } else if (id === 0x64617461) {                           // 'data'
            dataAt = body
            dataLen = Math.min(size, dv.byteLength - body)
            break
          }
          off = body + size + (size % 2)
        }
        if (dataAt < 0 || bits !== 16) return null
        const frames = Math.floor(dataLen / (channels * 2))
        const threshold = 0.001 * 32767
        for (let f = 0; f < frames; f++) {
          let peak = 0
          for (let c = 0; c < channels; c++) {
            const a = Math.abs(dv.getInt16(dataAt + (f * channels + c) * 2, true))
            if (a > peak) peak = a
          }
          if (peak > threshold) return (f / rate) * 1000
        }
        return null
      } catch { return null }
    }

    function wavMarkArrived(item) {
      if (!pcm.telemetry || !item || !item.w0Wall || !item.id) return
      if (wavMarks.has(item.id)) return
      wavMarks.set(item.id, {
        id: item.id,
        w0Wall: item.w0Wall,
        w5: Date.now() - item.w0Wall,
        w6: null,
        w7: null,
        w7b: null,
        mime: item.mime || null,
        bytes: item.audioBase64 ? item.audioBase64.length : null,
        reported: false,
      })
      if (wavMarks.size > 60) wavMarks.delete(wavMarks.keys().next().value)
    }

    function wavMarkDecoded(item) {
      const m = item && item.id ? wavMarks.get(item.id) : null
      if (!m || m.w6 !== null) return
      m.w6 = Date.now() - m.w0Wall
      // The lead-in is a property of the audio, known as soon as the payload is
      // decoded, so it is captured here and turned into W8 once playback starts.
      if (item && item.prepared && item.prepared.leadInMs != null) m.leadInMs = item.prepared.leadInMs
    }

    function wavReport(m) {
      if (!m || m.reported) return
      m.reported = true
      try {
        fetch('/dsh-tts/pcm-telemetry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: 'wav',
            id: m.id,
            p0Wall: m.w0Wall,
            w5_payloadReceived: m.w5,
            w6_decoded: m.w6,
            w7_playbackStarted: m.w7,
            w7b_clockAdvancing: m.w7b,
            leadInMs: m.leadInMs == null ? null : +m.leadInMs.toFixed(2),
            w8_firstAudible: m.w7b != null && m.leadInMs != null ? +(m.w7b + m.leadInMs).toFixed(2) : null,
            payloadBytes: m.bytes,
            mime: m.mime,
            autoBlocked: m.autoBlocked === true,
            error: m.error || null,
            finishedWall: Date.now(),
          }),
        }).catch(() => { /* host restarting */ })
      } catch { /* fetch unavailable */ }
    }

    function wavMarkStart(item) {
      const m = item && item.id ? wavMarks.get(item.id) : null
      if (!m || m.reported) return null
      wavMarkDecoded(item)
      return {
        started(audioEl) {
          m.w7 = Date.now() - m.w0Wall
          wavReport(m)
          // Playback is claimed to have started; confirm the media clock moves,
          // which is what separates "play() resolved" from "sound is coming out".
          if (audioEl) {
            const t0 = Date.now()
            const iv = setInterval(() => {
              if (!audioEl || audioEl.currentTime > 0 || Date.now() - t0 > 3000) {
                clearInterval(iv)
                if (audioEl && audioEl.currentTime > 0 && m.w7b === null) {
                  m.w7b = Date.now() - m.w0Wall
                  m.reported = false
                  wavReport(m)
                }
              }
            }, 5)
          }
        },
        fail(reason, extra) {
          m.error = String(reason)
          if (extra && extra.autoBlocked) m.autoBlocked = true
          wavReport(m)
        },
      }
    }

      if (pcm.prepared) return
    function pcmPrepare() {
      if (pcm.prepared) return
      pcm.prepared = true
      // Warm the audio context and the tap before the first stream arrives, so
      // `addModule` and the device open are not on the first-audio critical path.
      try { pcmStreaming.prepare(24000) } catch { /* best effort */ }
    }

    // ── SSE framing ───────────────────────────────────────────────────────────
    function pcmOnStart(e) {
      try {
        const item = JSON.parse(e.data)
        if (!item || !item.streamId) return
        pcmPrepare()
        pcmStreams.set(item.streamId, {
          streamId: item.streamId,
          piece: item.piece,
          t0Wall: item.t0Wall || Date.now(),
          p4: null, p5: null, p6: null, p7Graph: null, p7Acoustic: null,
        })
        if (pcmStreams.size > 50) {
          const first = pcmStreams.keys().next().value
          pcmStreams.delete(first)
        }
        pcmStreaming.handleStart(item)
      } catch (parseErr) { /* ignore malformed pcm-start */ }
    }

    function pcmOnChunk(e) {
      sseDiag.chunkEvents++
      try {
        const item = JSON.parse(e.data)
        if (item && item.streamId) pcmStreaming.handleChunk(item)
      } catch (parseErr) { sseDiag.parseFailures++ }
    }

    function pcmOnEnd(e) {
      try {
        const item = JSON.parse(e.data)
        if (item && item.streamId) pcmStreaming.handleEnd(item)
      } catch (parseErr) { /* ignore malformed pcm-end */ }
    }

    function pcmOnAbort(e) {
      try {
        const item = JSON.parse(e.data)
        if (!item || !item.streamId) return
        pcmStreaming.handleAbort(item)
        const rec = pcmStreams.get(item.streamId)
        if (rec) { rec.stopped = true; pcmReport(rec) }
      } catch (parseErr) { /* ignore malformed pcm-abort */ }
    }

    function pcmStop(reason) {
      try { pcmStreaming.stop(reason) } catch { /* graph already gone */ }
      for (const rec of pcmStreams.values()) rec.stopped = true
      pcmStreams.clear()
    }

    async function drainQueue() {
      if (player.busy) return
      player.busy = true
      playerChanged()
      try {
        while (player.queue.length) {
          if (player.paused) break
          const item = player.queue.shift()
          if (!item || item.kind === 'reserved') continue
          // LOCAL FORK (PCM stage): a pcm row is a marker, not audio. Its bytes
          // travelled over SSE and the progressive player already has them.
          if (item.kind === 'pcm') continue
          if (item.kind === 'chime') { await playChime(item.chime || player.chime); continue }
          if (item.audioBase64) await playAudio(item)
          // LOCAL FORK (production patch #1): browser SpeechSynthesis fallback is
          // BLOCKED. Falling back to the OS voice produced a wrong-voice reply that
          // masked real provider failures; the failure is logged instead.
          else if (item.error && item.text) console.error('[dsh-tts] Browser fallback BLOCKED:', item.error, item.text)
        }
      } finally {
        player.busy = false
        // Drained means nothing left to play: the edge that ends "the assistant is
        // speaking". A pause keeps the queue, so a paused player stays speaking.
        if (!player.queue.length && !player.audio) announceSpeech(false)
        playerChanged()
      }
    }

    function stopPlayback() {
      // LOCAL FORK (PCM stage): the progressive player has its own graph, so a
      // barge-in has to stop both or half the reply keeps talking.
      pcmStop('stop-playback')
      for (const item of player.queue) {
        if (item && item.prepared && item.prepared.url) {
          try { URL.revokeObjectURL(item.prepared.url) } catch { /* already revoked */ }
          item.prepared = null
        }
      }
      player.queue.length = 0
      player.paused = false
      if (player.audio) {
        try { player.audio.pause() } catch { /* already paused */ }
      }
      if (currentAudioResolve) {
        currentAudioResolve()
      }
      player.audio = null
      try { if (window.speechSynthesis) window.speechSynthesis.cancel() } catch { /* no speechSynthesis */ }
      announceSpeech(false)
      playerChanged()
    }

    function togglePause() {
      player.paused = !player.paused
      if (player.audio) {
        try { player.paused ? player.audio.pause() : player.audio.play() } catch (already) { /* ignore play/pause failure */ }
      }
      // Progressive PCM has no <audio> element: its blocks are already booked into
      // the AudioContext, so suspending the context is the only way to hold back
      // audio that has been scheduled but not yet played. Without this the pause
      // button did nothing at all for PCM playback.
      try {
        if (pcmStreaming && pcmStreaming.playing) {
          if (player.paused) pcmStreaming.pause(); else pcmStreaming.resume()
        }
      } catch { /* graph already gone */ }
      if (!player.paused) drainQueue()
      playerChanged()
    }

    function skipCurrent() {
      if (currentAudioResolve) {
        currentAudioResolve()
      } else if (player.audio) {
        try { player.audio.pause() } catch (already) { /* already stopped */ }
        player.audio = null
        playerChanged()
        if (player.queue.length) drainQueue()
      }
    }

    // User started talking — stop playback.
    //
    // The event may come from a voice-input plugin, but there is no hard dependency:
    // without that plugin the event simply never fires. We listen on window on purpose.
    //
    // LOCAL FORK (0.4.16-local.4): the hard stop now has two entry points and one
    // implementation. Emptying the local queue is only half of a barge-in — the host
    // holds pieces that are still synthesizing, and (in live sentence mode) a reply
    // that is still streaming — so every path tells the host as well.
    function bargeInNow() {
      // Not gated on live mode: the durable path has a pending queue too, and a piece
      // that is still synthesizing would otherwise settle into the queue and be
      // collected by the next poll.
      try {
        fetch('/dsh-tts/bargein', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }).catch(() => { /* host restarting */ })
      } catch { /* fetch unavailable */ }
      if (!player.audio && !player.queue.length && !player.busy && pcmStreaming.activeStreams === 0) return
      stopPlayback()
    }

    function listenForVoice() {
      if (typeof window === 'undefined') return () => {}
      const onSpeaking = (event) => {
        const phase = event && event.detail && event.detail.phase
        if (phase !== 'start') return
        if (!player.bargeIn) return
        bargeInNow()
      }
      // The explicit command from the voice plugin. It is authoritative on purpose:
      // the plugin has already decided that the user talking wins, so honouring it
      // must not depend on a second setting here.
      const onCancel = () => { bargeInNow() }
      window.addEventListener('dsh-voice:speaking', onSpeaking)
      window.addEventListener('dsh:tts:cancel', onCancel)
      return () => {
        window.removeEventListener('dsh-voice:speaking', onSpeaking)
        window.removeEventListener('dsh:tts:cancel', onCancel)
      }
    }

        // SSE Realtime Stream Connection with Exponential Backoff & Jitter
    let sseAttempt = 0
    let sseTimer = null
    let sseSource = null

    function connectSseStream() {
      if (typeof window === 'undefined' || typeof window.EventSource === 'undefined') return
      // LOCAL FORK (PCM stage): idempotent.
      //
      // pollPending() calls this on EVERY poll, and the poll runs every 150 ms
      // while live sentence streaming is on. The original implementation closed
      // and reopened the EventSource unconditionally, so the browser tore the SSE
      // connection down and rebuilt it ~7 times a second and any event in flight
      // was lost. That was invisible while this channel carried nothing but an
      // occasional chime; it is fatal for progressively streamed audio, where a
      // dropped event is a dropped 80-640 ms of speech.
      //
      // Measured before the fix: 37 and 115 connects inside two single-reply runs,
      // one stream short by 30720 bytes with a sequence gap, and one stream whose
      // pcm-end never arrived at all.
      if (sseSource && sseSource.readyState !== 2 /* EventSource.CLOSED */) return
      if (sseSource) {
        try { sseSource.close() } catch (alreadyClosed) { /* intentional cleanup */ }
        sseSource = null
      }
      try {
        sseSource = new EventSource('/dsh-tts/stream')
        sseSource.onopen = () => {
          sseDiag.connects++
          if (sseAttempt > 0) sseDiag.reconnects++
          sseAttempt = 0
        }
        sseSource.addEventListener('utterance', (e) => {
          sseAttempt = 0
          try {
            const item = JSON.parse(e.data)
            if (item && item.id) {
              player.after = item.id
              if (!seenIds.has(item.id)) {
                seenIds.add(item.id)
                if (seenIds.size > 500) {
                  const first = seenIds.values().next().value
                  seenIds.delete(first)
                }
                if (item.text) recent.add(item.text)
                wavMarkArrived(item)
                player.queue.push(item)
                drainQueue()
              }
            }
          } catch (parseErr) { /* ignore malformed SSE payload */ }
        })
        sseSource.addEventListener('chime', (e) => {
          sseAttempt = 0
          try {
            const item = JSON.parse(e.data)
            if (item) {
              player.queue.push(item)
              drainQueue()
            }
          } catch (parseErr) { /* ignore malformed chime payload */ }
        })
        // LOCAL FORK (PCM stage): the progressive audio channel.
        sseSource.addEventListener('pcm-start', (e) => { sseAttempt = 0; pcmOnStart(e) })
        sseSource.addEventListener('pcm-chunk', (e) => { sseAttempt = 0; pcmOnChunk(e) })
        sseSource.addEventListener('pcm-end', (e) => { sseAttempt = 0; pcmOnEnd(e) })
        sseSource.addEventListener('pcm-abort', (e) => { sseAttempt = 0; pcmOnAbort(e) })
        sseSource.onerror = () => {
          if (sseSource) {
            try { sseSource.close() } catch (alreadyClosed) { /* intentional cleanup */ }
            sseSource = null
          }
          sseAttempt++
          const baseDelay = Math.min(10000, 500 * Math.pow(2, sseAttempt - 1))
          const jitter = baseDelay * (Math.random() * 0.6 - 0.3)
          const delay = Math.max(200, Math.floor(baseDelay + jitter))
          if (sseTimer) clearTimeout(sseTimer)
          sseTimer = setTimeout(() => {
            connectSseStream()
          }, delay)
        }
      } catch (esErr) { /* EventSource failed */ }
    }

async function pollPending() {
        connectSseStream()
      try {
        const st = await fetch('/dsh-tts/status', { cache: 'no-store' })
        if (!st.ok) return
        const meta = await st.json()
        // LOCAL FORK (0.4.16-local.6): silent mode silences the browser exactly the
        // way turning reply speech off does — no pending poll, no playback — so the
        // muted state reuses a path that is already exercised whenever the user
        // unchecks "Speak agent replies".
        player.enabled = !!(meta && meta.speakReplies) && !(meta && meta.speechMuted)
        if (meta && typeof meta.rate === 'number') player.rate = meta.rate
        if (meta && meta.chime) player.chime = meta.chime
          if (meta && meta.roles) player.roles = meta.roles
        if (meta && typeof meta.bargeIn === 'boolean') player.bargeIn = meta.bargeIn
        // LOCAL FORK: live sentence streaming lowers the pending-poll interval.
        // Only while replies are actually spoken — otherwise the shorter interval
        // would hammer /status with nothing to collect.
        const liveOn = !!(player.enabled && meta && meta.live && meta.live.enabled === true)
        player.liveEnabled = liveOn
        if (liveOn && typeof meta.live.pollMs === 'number' && meta.live.pollMs > 0) {
          player.pollMs = Math.max(60, Math.min(5000, meta.live.pollMs))
        } else if (!liveOn && player.pollMs !== 1000) {
          player.pollMs = 1000
        }
        // LOCAL FORK (PCM stage): the progressive transport's own switch. The
        // SSE channel that carries its framing is the one connectSseStream()
        // above already opened, so enabling PCM needs no second connection.
        if (meta && meta.pcm && typeof meta.pcm === 'object') {
          const wasOn = pcm.enabled
          pcm.experimental = meta.pcm.experimental === true
          pcm.enabled = meta.pcm.enabled === true
          pcm.telemetry = meta.pcm.telemetry === true
          if (typeof meta.pcm.startupMs === 'number' && meta.pcm.startupMs >= 0) pcm.startupMs = meta.pcm.startupMs
          if (pcm.enabled) pcmPrepare()
          if (pcm.enabled !== wasOn) {
            console.info('[dsh-tts] PCM streaming ' + (pcm.enabled ? 'ON' : 'OFF') + ' (startup ' + pcm.startupMs + ' ms)')
            if (!pcm.enabled) pcmStop('mode-off')
          }
        }
        if (!player.enabled) return
        const res = await fetch('/dsh-tts/pending?after=' + encodeURIComponent(player.after || ''), { cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json()
        const items = data && Array.isArray(data.items) ? data.items : []
        for (const item of items) {
    // Queue slot reserved but synthesis still running — wait for the next poll
    // or phrase order would break.
          if (item.kind === 'reserved') break
          player.after = item.id
          if (seenIds.has(item.id)) continue
          seenIds.add(item.id)
          if (seenIds.size > 500) {
            const first = seenIds.values().next().value
            seenIds.delete(first)
          }
          if (item.text) recent.add(item.text)
          // LOCAL FORK (PCM stage): a pcm row marks that the piece exists and is
          // being streamed; its audio is arriving over SSE, so it must not be
          // queued as if it were a blob. The cursor still advances past it, which
          // is what keeps piece order correct.
          if (item.kind === 'pcm') continue
          wavMarkArrived(item)
          player.queue.push(item)
        }
        if (player.queue.length) drainQueue()
      } catch (hostRestarting) { /* host restarting */ }
    }

    // Recent utterances: last reply texts and favorites (localStorage).
    function recentStore() {
      const KEY = 'dsh-tts/recent'
      let st
      try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null
        st = JSON.parse(raw) || { items: [], favs: [] }
      } catch (broken) { st = { items: [], favs: [] } }
      const persist = () => { try { if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(st)) } catch (full) { /* private mode / quota */ } }
      return {
        add(text) {
          if (!text || text.length < 2) return
          st.items = [text, ...st.items.filter((x) => x !== text)].slice(0, 30)
          persist()
        },
        toggleFav(text) {
          st.favs = st.favs.includes(text)
            ? st.favs.filter((x) => x !== text)
            : [text, ...st.favs].slice(0, 20)
          persist()
        },
        list() { return { items: st.items, favs: st.favs } },
      }
    }
    const recent = recentStore()

    // One-shot playback outside the queue: replay from recents.
    function playStandalone(text) {
      fetch('/dsh-tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (!d || !d.ok) return
          const audio = new Audio('data:' + (d.mime || 'audio/mpeg') + ';base64,' + d.audioBase64)
          audio.play().catch(() => { /* chime autoplay blocked or interrupted */ })
        })
        .catch(() => { /* chime fetch failed or not found */ })
    }

    function exportAudioClip(text) {
      let phrase = text || player.lastText
      if (!phrase) {
        const list = recent.list()
        if (list && list.items && list.items.length) phrase = list.items[0]
      }
      if (!phrase) return
      fetch('/dsh-tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: phrase }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (!d || !d.ok || !d.audioBase64) return
          const bin = atob(d.audioBase64)
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          const mime = d.mime || 'audio/mpeg'
          const blob = new Blob([bytes], { type: mime })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = 'dsh-tts-' + Date.now() + (mime.indexOf('wav') !== -1 ? '.wav' : '.mp3')
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          setTimeout(() => { try { URL.revokeObjectURL(url) } catch (alreadyRevoked) { /* already revoked */ } }, 2000)
        })
        .catch(() => {})
    }

    function credOf(map, provider) {
      return (map && map[provider]) || { configured: false, writable: true, ref: '' }
    }

