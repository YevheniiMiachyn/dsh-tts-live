window.__ModuleLoader__.load({
  id: '@goodandready/dsh-tts',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    // Chevron comes from core UI primitives; local SVG is a fallback for
    // builds without the package. Icon always points down; open state rotates.
    let ChevronIcon = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      ChevronIcon = primitives && primitives.IconChevronDownOutline14
    } catch (noPrimitives) {
      ChevronIcon = null
    }
    const NS = 'dsh-tts'
    const PROVIDERS = [
      'openai', 'elevenlabs', 'google', 'azure', 'groq', 'deepgram', 'openrouter',
      'edge', 'piper', 'espeak',
    ]
    const CLOUD = {
      openai: 1, elevenlabs: 1, google: 1, azure: 1, groq: 1, deepgram: 1, openrouter: 1, custom: 1,
    }
    // Hints stay generic: concrete provider model IDs rot quickly.
    const MODEL_HINT = {
      openai: 'provider default',
      elevenlabs: 'provider default',
      google: 'provider default',
      azure: 'region voice name',
      groq: 'provider default',
      deepgram: 'provider default (English-only voices)',
      openrouter: 'provider/model id',
      edge: 'BCP-47 voice, e.g. ru-RU-SvetlanaNeural',
      piper: 'path to .onnx',
      espeak: 'language code, e.g. ru',
      kokoro: 'not bundled — offline neural runtime unavailable',
      f5: 'not bundled — offline neural runtime unavailable',
    }


    function createErrorBoundary() {
      if (!React || typeof React.Component !== 'function') {
        return function NoopBoundary(props) { return (props && props.children) || null }
      }
      return class ErrorBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { hasError: false, error: null }
        }
        static getDerivedStateFromError(error) {
          return { hasError: true, error }
        }
        componentDidCatch(error, errorInfo) {
          console.error('[dsh-tts] React Error:', error, errorInfo)
        }
        render() {
          if (this.state.hasError) {
            return React.createElement(
              'div',
              {
                className: 'dts-alert dts-alert-err',
                style: { margin: '12px 0', padding: '14px', borderRadius: '8px' },
              },
              React.createElement('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '⚠️ TTS UI Error:'),
              React.createElement('div', { style: { fontSize: '12px', wordBreak: 'break-all' } }, String((this.state.error && this.state.error.message) || this.state.error)),
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dts-btn',
                  style: { marginTop: '10px', fontSize: '12px', padding: '4px 10px' },
                  onClick: () => this.setState({ hasError: false, error: null }),
                },
                'Retry',
              ),
            )
          }
          return (this.props && this.props.children) || null
        }
      }
    }
    const ErrorBoundary = createErrorBoundary()
    const SNAPSHOT_READY = Object.freeze({ status: 'ready', value: {} })
    const SNAPSHOT_LOADING = Object.freeze({ status: 'loading', value: {} })

    const SET_CSS =
      '.dts-wrap{display:flex;flex-direction:column;gap:18px;padding:4px 0 24px;max-width:900px}' +
      '.dts-header{display:flex;flex-direction:column;gap:8px;padding-bottom:14px;border-bottom:1px solid var(--dsw-alias-border-l2)}' +
      '.dts-page-title{font-size:20px;font-weight:700;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:10px}' +
      '.dts-page-sub{font-size:13px;color:var(--dsw-alias-label-secondary);line-height:1.5}' +
      '.dts-block{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:12px}' +
      '.dts-h{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;justify-content:space-between}' +
      '.dts-sub{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.4}' +
      '.dts-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none}' +
      '.dts-head{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;display:flex;align-items:center;gap:12px;padding:14px 16px}' +
      '.dts-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}' +
      '.dts-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}' +
      '.dts-chev{margin-left:auto;color:var(--dsw-alias-label-secondary);flex:none;transition:transform .16s}' +
      '.dts-chevOpen{transform:rotate(180deg)}' +
      '.dts-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:12px 0}' +
      '.dts-field{display:flex;flex-direction:column;gap:6px;padding:6px 0;font-size:13px;color:var(--dsw-alias-label-primary)}' +
      '.dts-input{height:34px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:13px;box-sizing:border-box}' +
      '.dts-input:focus{outline:none;border-color:var(--dsw-alias-state-brand-primary)}' +
      '.dts-foot{border-top:1px solid var(--dsw-alias-border-l2);display:flex;justify-content:flex-end;align-items:center;gap:10px;padding:14px 0 4px}' +
      '.dts-save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:6px 16px;font-size:13px;font-weight:500;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);transition:all .15s ease}' +
      '.dts-save:hover:not(:disabled){opacity:0.88}' +
      '.dts-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 12px;font-size:13px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:500;display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:all .15s ease}' +
      '.dts-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-4, var(--dsw-alias-bg-layer-2));border-color:var(--dsw-alias-label-dimmed, var(--dsw-alias-border-l2))}' +
      '.dts-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent)}' +
      '.dts-btn-danger:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 50%, transparent)}' +
      '.dts-entry{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}' +
      '.dts-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
      '.dts-row .dts-model{flex:1;min-width:120px}' +
      '.dts-row .dts-key{flex:1;min-width:180px}' +
      '.dts-mini{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;width:28px;height:28px;cursor:pointer;flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:13px;transition:all .15s ease}' +
      '.dts-mini:hover:not(:disabled){background:var(--dsw-alias-bg-layer-4, var(--dsw-alias-bg-layer-2))}' +
      '.dts-ok{font-size:12px;color:var(--dsw-alias-state-success-primary);font-weight:500}' +
      '.dts-bad{font-size:12px;color:var(--dsw-alias-state-error-primary);font-weight:500}' +
      '.dts-badge{font-size:11px;padding:3px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap;display:inline-flex;align-items:center;gap:4px;font-weight:500}' +
      '.dts-badge-on{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent)}' +
      '.dts-badge-warn{color:var(--dsw-alias-state-warning-primary);border-color:var(--dsw-alias-state-warning-primary);background:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 8%, transparent)}' +
      '.dts-badge-bad{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent)}' +
      '.dts-link{background:none;border:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;padding:0;text-decoration:underline}' +
      '.dts-link:hover:not(:disabled){color:var(--dsw-alias-label-primary)}' +
      '.dts-alert{padding:10px 14px;border-radius:8px;font-size:13px}' +
      '.dts-alert-err{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary);border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 20%, transparent)}' +
      '.dts-alert-warn{background:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 10%, transparent);color:var(--dsw-alias-state-warning-primary);border:1px solid color-mix(in srgb, var(--dsw-alias-state-warning-primary) 20%, transparent)}' +
      '.dts-alert-ok{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);color:var(--dsw-alias-state-success-primary);border:1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 20%, transparent)}' +
      '.dts-grow{flex:1;min-width:100px}'

    const setCssId = 'dsh-tts/settings.module.css'
    if (typeof document !== 'undefined' && !document.querySelector('style[data-dsh-plugin="dsh-tts"]')) {
      const tag = document.createElement('style')
      tag.textContent = SET_CSS
      tag.setAttribute('data-dsh-plugin', 'dsh-tts')
      tag.dataset.pluginCss = setCssId
      document.head.appendChild(tag)
    }
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
      // ctx-time at which the LAST scheduled block finishes playing.
      //
      // Scheduling and playback run at very different speeds: the producer is
      // several times faster than real time, so a piece is fully handed to the
      // audio graph long before the listener has heard the end of it. `segSamples`
      // reaches 0 at the moment the last block is SCHEDULED, which is why the
      // stream's own end cannot be used to decide that playback has finished.
      // This is the only value that answers "is there still audio to hear".
      let playbackEndCtx = 0
      // Pending "playback really ended" notification, so the speaking edge is
      // emitted when the sound stops rather than when scheduling stops.
      let idleTimer = null
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
      /** Milliseconds of scheduled audio still ahead of the playhead, or 0. */
      function playingRemainingMs() {
        if (!ctx) return 0
        return Math.max(0, (playbackEndCtx - ctx.currentTime) * 1000)
      }

      /**
       * Emit `idle` when the last scheduled block has actually played.
       *
       * A timer is the only way to hear an end that has already been booked into
       * the audio graph. It is clamped so a suspended AudioContext (a paused tab,
       * an autoplay block, or our own pause) cannot leave the UI believing the
       * assistant is still speaking forever: a gate that never reopens is worse
       * than one that reopens early.
       */
      function scheduleIdle(untilCtx) {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
        // A suspended context has a FROZEN clock, so "remaining" cannot count down
        // in wall time — the audio is not playing. The host keeps streaming while
        // the listener has us paused, so this path is reached during a pause and a
        // naive timer would report the end of speech while nothing had been heard,
        // hiding the very controls needed to resume. `resume()` re-arms this.
        if (ctx && ctx.state === 'suspended') return
        const remainingMs = ctx ? Math.max(0, (untilCtx - ctx.currentTime) * 1000) : 0
        const delayMs = Math.min(remainingMs + 60, remainingMs + 3000, 120000)
        idleTimer = setTimeout(() => {
          idleTimer = null
          if (streams.size === 0) emit('idle', {})
        }, delayMs)
        if (idleTimer.unref) idleTimer.unref()
      }

      function clearIdle() {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
      }

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
        if (nextTime > playbackEndCtx) playbackEndCtx = nextTime
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
            // NOT `emit('idle')` here. Reaching this line means every byte has been
            // SCHEDULED, which for progressive PCM happens long before the listener
            // has heard it. Emitting idle now told the rest of the UI that the
            // assistant had stopped speaking while she was still audibly talking:
            // the dock's pause/stop controls vanished mid-sentence, and dsh-voice's
            // barge-in gate reopened early. Report the end when the sound ends.
            if (streams.size === 0) scheduleIdle(playbackEndCtx)
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
          // A stop silences the graph immediately, so the pending "playback ended"
          // timer is now wrong and must not fire later on top of a new utterance.
          clearIdle()
          playbackEndCtx = 0
          if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
          emit('stop', { reason: reason || '' })
        },

        /**
         * Pause / resume playback.
         *
         * Suspending the AudioContext is the only mechanism that holds back blocks
         * that are ALREADY scheduled in the future — the same reason the clamp path
         * replaces the master gain node rather than clearing buffers. Everything
         * booked into the graph resumes exactly where it left off.
         */
        async pause() {
          if (!ctx || ctx.state !== 'running') return false
          try { await ctx.suspend(); clearIdle(); return true } catch { return false }
        },

        async resume() {
          if (!ctx || ctx.state !== 'suspended') return false
          try {
            await ctx.resume()
            // Re-arm the end-of-playback notification against the resumed clock.
            if (streams.size === 0 && playbackEndCtx > 0) scheduleIdle(playbackEndCtx)
            return true
          } catch { return false }
        },

        /** Re-anchor the scheduling cursor after a silent period. */
        reset() {
          nextTime = ctx ? ctx.currentTime : 0
          currentPiece = null
        },

        get stats() { return { ...stats, active: streams.size, liveNodes: liveNodes.size, ctxState: ctx ? ctx.state : null, ctxRate, tap: tapReady, tapFailed } },
        /** Exposed for the measurement harness; not used by playback. */
        get context() { return ctx },
        /**
         * True while there is scheduled audio still ahead of the playhead — i.e.
         * while the listener can still hear something. Distinct from
         * `activeStreams`, which is true only while bytes are still arriving.
         * The dock and the barge-in gate both need THIS question answered.
         */
        get playing() {
          if (!ctx || ctx.state === 'suspended') return false
          return playingRemainingMs() > 0
        },
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
          clearIdle()
          playbackEndCtx = 0
          for (const s of streams.values()) releaseTap(s)
          try { if (ctx) ctx.close() } catch { /* already closed */ }
          ctx = null; master = null; tap = null
        },
      }
    }
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

    const en = {
      'dockLabel': 'Speech',
      'dockPause': 'Pause',
      'dockResume': 'Resume speech',
      'dockStop': 'Stop speech',
      'dockCurrent': 'Now speaking',
      'dockNone': 'Waiting for speech',
      'dockQueue': 'Queue',
      'dockClearQueue': 'Clear queue',
      'dockReplay': 'Replay',
      'dockFavorite': 'Favorite',
      'dockUnfavorite': 'Unfavorite',
      'dockFavorites': 'Favorite clips',
      'exportAudio': 'Export audio clip',
      'exportSuccess': 'Audio exported',
      'statusOnline': 'Host online',
      'recent': 'Recent',
      'recentEmpty': 'No recent speech yet',
      'retry': 'Retry',
      'advancedCollapsed': 'Advanced',
      'confirmClearCache': 'Clear the synthesis cache? This cannot be undone.',
      'confirmDeleteModel': 'Delete downloaded weights for this engine?',
      'autoplayBlocked': 'Sound is blocked until you click or tap once',
      'enableSound': 'Enable sound',
      'runtimeNotBundled': 'Neural inference runtime is not bundled',
      'runtimeNotBundledHint': 'Install weights does not enable speech. Use Edge, Piper, or eSpeak for offline TTS.',
      'testProvider': 'Test provider',
      'breakerOpen': 'Circuit open',
      'lastError': 'Last error',
      'activeProvider': 'Active provider',
      'queueLen': 'Queue',
      'sseState': 'SSE',
      'currentVoice': 'Voice',
      'statusOffline': 'Host unreachable',
      'cacheStats': 'Cache',
      'general': 'General',
      'loading': 'Loading…',
      'chainHintCard': 'Pick a provider, paste its API key, and Save (or leave the key field). The key is written to the host credentials store immediately. The browser never reads it back.',
      'speakRepliesHint': 'When on, each finished reply is synthesized on the host and played in this browser. Audio is not sent back to the model.',
      'chainHint': 'Top to bottom is the fallback order. Cloud keys are saved to the host credentials store, never into plugin settings.',
      'title': 'Speech',
      'speakReplies': 'Speak agent replies',
      'speakAsItGoes': 'Speak as it goes',
      'speakAsItGoesHint': 'Read each reply the moment it lands, sentence by sentence, instead of waiting for the whole turn.',
      'rate': 'Playback speed',
      'rateHint': '0.5 to 2. Synthesis is untouched; the browser plays faster or slower.',
      'bargeIn': 'Fall silent when you speak',
      'bargeInHint': 'Stop reading the moment the microphone opens.',
      'announce': 'Announce approvals',
      'announceHint': 'Say it out loud and play a chime when the agent stops for an approval or asks a question.',
      'approvalText': 'Approval wording',
      'approvalHint': 'Said when an approval is asked for; the tool name is appended.',
      'questionText': 'Question wording',
      'questionHint': 'Said when the agent asks a question. Empty disables it.',
      'chime': 'Chime',
      'chimeHint': 'ding, beep or none.',
      'language': 'Language',
      'languageHint': 'Hint for voices that need a locale (eSpeak, Azure SSML).',
      'piperModel': 'Piper model path',
      'piperModelHint': 'Absolute path to an ONNX model. Leave empty to skip Piper.',
      'piperBin': 'Piper binary',
      'binHint': 'Looked up in PATH unless absolute.',
      'espeakBin': 'eSpeak binary',
      'espeakHint': 'Usually espeak-ng.',
      'edgeBin': 'edge-tts binary',
      'edgeHint': 'Python CLI from the edge-tts package.',
      'azureRegion': 'Azure region',
      'azureHint': 'Required for the azure provider, e.g. eastus.',
      'openaiBaseUrl': 'OpenAI base URL',
      'openaiBaseUrlHint': 'OpenAI-compatible origin for the openai provider.',
      'mimoBaseUrl': 'MiMo base URL',
      'mimoBaseUrlHint': 'MiMo API root; synthesis uses its chat endpoint.',
      'mimoFormat': 'MiMo format',
      'mimoFormatHint': 'mp3 or wav.',
      'minimaxBin': 'MiniMax CLI',
      'minimaxBinHint': 'Looked up in PATH unless absolute; install and log in separately.',
      'advancedTitle': 'Advanced',
      'advancedHint': 'Limits and endpoint overrides. Provider API keys stay in the chain editor; credential slot names (*KeyEnv) are config-only.',
      'maxChars': 'Max characters',
      'maxCharsHint': 'Hard cap before long-reply handling; 0 disables.',
      'sentenceChars': 'Sentence chunk size',
      'sentenceCharsHint': 'Max characters per streaming sentence piece.',
      'timeoutMs': 'Provider timeout (ms)',
      'timeoutMsHint': 'Abort a provider attempt after this many milliseconds.',
      'maxQueue': 'Max queue length',
      'maxQueueHint': 'Drop oldest pending pieces beyond this count.',
      'chainTitle': 'Provider chain',
      'addProvider': 'Add provider',
      'localProvider': 'Local / CLI provider — no API key',
      'configured': 'Configured',
      'notSet': 'Not set',
      'fromEnv': 'Set in environment',
      'clear': 'Clear',
      'remove': 'Remove',
      'up': 'Up',
      'down': 'Down',
      'save': 'Save',
      'saved': 'Saved',
      'cardHint': 'Provider chain, voices and playback options.',
      'skipCode': 'Skip code blocks',
      'skipCodeHint': 'Say a short notice instead of reading code aloud.',
      'cache': 'Synthesis cache',
      'cacheHint': 'Reuse synthesized audio for repeated phrases.',
      'cacheMaxMb': 'Cache size limit, MB',
      'cacheMaxMbHint': 'Least recently used items are evicted first.',
      'clearCache': 'Clear cache',
      'pronTitle': 'Pronunciation',
      'pronHint': 'Rules run top-down. Wrap left side in /…/ for a regex; Lang filters the rule.',
      'pronFrom': 'Replace',
      'pronTo': 'With',
      'pronWhole': 'Whole word',
      'pronLang': 'Lang',
      'addRule': 'Add rule',
      'rolesTitle': 'Voice roles',
      'rolesHint': 'Empty fields inherit the main chain.',
      'roleReply': 'Reply',
      'roleApproval': 'Approval',
      'roleError': 'Error',
      'ssmlStyle': 'SSML tone style',
      'ssmlStyleHint': 'Expressive tone (e.g. cheerful, serious, empathetic).',
      'longReply': 'Long replies',
      'longReplyHint': 'truncate: cut at the limit; summarize: short retelling; full: read everything.',
      'summaryModel': 'Summary model',
      'summaryModelHint': 'provider/model, empty = conversation default.',
      'summarySentences': 'Retelling length',
      'summarySentencesHint': 'Sentences in the spoken retelling.',
      'preview': 'Preview',
      'statsTitle': 'Statistics',
      'statTotal': 'Total',
      'statHits': 'Cache hits',
      'statErrors': 'Errors',
      'statReset': 'Reset stats',
      'autoDetect': 'Auto language per piece',
      'autoDetectHint': 'Guess zh/en per spoken piece instead of the language setting.',
      'narrateQuotesOnly': 'Only quotes',
      'narrateQuotesHint': 'Read only «quoted» fragments of a reply.',
      'skipActions': 'Skip *actions*',
      'skipActionsHint': 'Drop asterisk action blocks.',
      'removeRegex': 'Remove regex',
      'removeRegexHint': 'Global regex; matches are removed before synthesis.',
      'customBaseUrl': 'Custom TTS endpoint',
      'customBaseUrlHint': 'OpenAI-compatible origin, e.g. http://localhost:8880/v1; empty = off.',
      'customKeyEnv': 'Custom key env',
      'customKeyEnvHint': 'Credential name for the custom endpoint bearer key.',
      'localEnginesTitle': 'Local Engines (Offline)',
      'localEnginesHint': 'Run speech synthesis 100% offline without API keys.',
      'enableLocalEngines': 'Enable local engines',
      'enableLocalEnginesHint': 'Use Kokoro or F5-TTS when installed.',
      'streamingEnabled': 'Instant streaming (< 300 ms)',
      'streamingEnabledHint': 'Play audio via AudioWorklet and SSE in real-time.',
      'useKokoro': 'Enable Kokoro-82M (CPU)',
      'useKokoroHint': 'Fast neural synthesis on CPU.',
      'useF5': 'Enable F5-TTS (GPU)',
      'useF5Hint': 'High-fidelity zero-shot synthesis on NVIDIA GPU.',
      'installed': 'Installed',
      'notInstalled': 'Not installed',
      'downloading': 'Downloading',
      'installKokoro': 'Install (350 MB)',
      'installF5': 'Install (2.1 GB)',
      'deleteModel': 'Delete',
      'voiceDuplexTitle': 'Voice Duplex (Voice-to-Voice)',
      'voiceDuplexHint': 'Interactive voice conversation integrated with dsh-voice.',
      'voiceNotInstalledTitle': 'Required plugin @goodandready/dsh-voice is not installed',
      'voiceInstallHint': 'To enable voice duplex, install the plugin with',
      'voiceDuplex': 'Voice-to-Voice mode',
      'voiceDuplexHintToggle': 'Automatically synthesize agent reply when finished talking.',
      'vadBargeIn': 'VAD Barge-in',
      'vadBargeInHint': 'Mute speech synthesis immediately when user voice is detected.',
      'newSubagentRole': 'Subagent name (e.g. coder, reviewer)',
      'addSubagentRole': 'Add Subagent',
      'autoDetectSubagent': 'Auto-detect subagent roles',
      'role_coder': 'Coder',
      'role_reviewer': 'Reviewer',
      'role_planner': 'Planner',
      'enableItDictionary': 'Built-in IT dictionary',
      'enableItDictionaryHint': 'Auto-correct pronunciation for SQL, Nginx, K8s, Docker, API, JSON, YAML, etc.',
      'loadItDictionary': 'Populate IT terms',
      'previewRule': 'Listen',
      'messengerIntegrationTitle': 'Messenger Integration (Telegram, Discord)',
      'messengerIntegrationHint': 'Voice replies and notes sent through @goodandready/dsh-messenger-gateway.',
      'messengerNotInstalledTitle': 'Required plugin @goodandready/dsh-messenger-gateway is not installed',
      'messengerInstallHint': 'To enable voice replies in messengers, install the plugin with',
      'messengerTtsEnabled': 'Voice replies in messengers',
      'messengerTtsEnabledHint': 'Allow the messenger gateway to deliver replies as voice notes.',
    }

    const zh = {
      'dockLabel': '语音朗读',
      'dockPause': '暂停朗读',
      'dockResume': '继续朗读',
      'dockStop': '停止朗读',
      'dockCurrent': '当前朗读',
      'dockNone': '等待语音',
      'dockQueue': '队列',
      'dockClearQueue': '清空队列',
      'dockReplay': '重新朗读',
      'dockFavorite': '收藏',
      'dockUnfavorite': '取消收藏',
      'dockFavorites': '收藏语音',
      'exportAudio': '导出语音片段',
      'exportSuccess': '音频已导出',
      'statusOnline': '服务在线',
      'recent': '最近朗读',
      'recentEmpty': '暂无朗读记录',
      'retry': '重试',
      'advancedCollapsed': '高级设置',
      'confirmClearCache': '确定清除语音合成缓存吗？此操作无法撤销。',
      'confirmDeleteModel': '确定删除该引擎已下载的模型权重吗？',
      'autoplayBlocked': '声音已受系统限制，请点击任意位置以激活音频',
      'enableSound': '开启声音',
      'runtimeNotBundled': '未捆绑神经推理运行时',
      'runtimeNotBundledHint': '仅下载权重无法直接合成。建议使用 Edge、Piper 或 eSpeak 进行离线语音合成。',
      'testProvider': '测试服务商',
      'breakerOpen': '熔断中',
      'lastError': '最近错误',
      'activeProvider': '当前服务商',
      'queueLen': '队列长度',
      'sseState': 'SSE状态',
      'currentVoice': '发音人',
      'statusOffline': '服务不可达',
      'cacheStats': '缓存统计',
      'general': '常规设置',
      'loading': '加载中…',
      'chainHintCard': '选择服务商，粘贴 API Key 并保存。密钥将直接写入服务端安全凭证库，前端不会回显。',
      'speakRepliesHint': '启用后，智能体回复将在服务端合成语音并在当前浏览器中播放。音频不会回传至模型。',
      'chainHint': '从上到下为降级候选顺序。云端密钥直接保存在服务端凭证中心，绝不存入插件公开设置中。',
      'title': '语音朗读 (TTS)',
      'speakReplies': '朗读智能体回复',
      'speakAsItGoes': '流式逐句朗读',
      'speakAsItGoesHint': '模型输出时按句子即时流式朗读，无需等待整段内容生成完毕。',
      'rate': '播放语速',
      'rateHint': '0.5 到 2.0 倍速。服务端按标准速度合成，由浏览器调整播放速率。',
      'bargeIn': '打断静音 (Barge-in)',
      'bargeInHint': '当麦克风开启或检测到说话时立即中断朗读。',
      'announce': '重要事件播报',
      'announceHint': '当智能体等待用户审批或提出问题时，播放提示音并语音播报。',
      'approvalText': '审批提示语',
      'approvalHint': '请求审批时播报的短语，会自动附带工具名称。',
      'questionText': '提问提示语',
      'questionHint': '智能体提问时播报的前导短语。留空则直接读出问题。',
      'chime': '提示音效',
      'chimeHint': '可选 ding、beep 或无。',
      'language': '语言选择',
      'languageHint': '针对需要指定语言的服务商（如 eSpeak 或 Azure SSML）。',
      'piperModel': 'Piper 模型路径',
      'piperModelHint': 'ONNX 模型的绝对路径。留空则跳过 Piper。',
      'piperBin': 'Piper 可执行文件',
      'binHint': '默认从 PATH 查找，除非指定绝对路径。',
      'espeakBin': 'eSpeak 可执行文件',
      'espeakHint': '通常为 espeak-ng。',
      'edgeBin': 'edge-tts 可执行文件',
      'edgeHint': 'Python edge-tts 命令行工具。',
      'azureRegion': 'Azure 区域',
      'azureHint': 'Azure 语音服务所在区域，例如 eastus。',
      'openaiBaseUrl': 'OpenAI API 地址',
      'openaiBaseUrlHint': '兼容 OpenAI 的 TTS 接口地址。',
      'mimoBaseUrl': 'MiMo API 地址',
      'mimoBaseUrlHint': 'MiMo 接口根地址，通过其对话接口提取语音。',
      'mimoFormat': 'MiMo 音频格式',
      'mimoFormatHint': 'mp3 或 wav。',
      'minimaxBin': 'MiniMax CLI 路径',
      'minimaxBinHint': '默认从 PATH 查找，需提前安装并登录。',
      'advancedTitle': '高级参数',
      'advancedHint': '字符上限与接口重定向。API 密钥在候选链中维护，凭证环境变量仅在后台生效。',
      'maxChars': '最大字符上限',
      'maxCharsHint': '触发长文本截断或摘要的硬性上限；0 表示无限制。',
      'sentenceChars': '单句切片大小',
      'sentenceCharsHint': '流式语音合成中单句的最大字符长度。',
      'timeoutMs': '服务商超时 (毫秒)',
      'timeoutMsHint': '单次语音合成请求超时时间，超时后自动切换下一服务商。',
      'maxQueue': '最大队列长度',
      'maxQueueHint': '超出该长度时丢弃最旧的未播放语音片段。',
      'chainTitle': '服务商降级链 (Fallback Chain)',
      'addProvider': '添加服务商',
      'localProvider': '本地 / CLI 服务商（无需 API 密钥）',
      'configured': '已配置',
      'notSet': '未设置',
      'fromEnv': '来自环境变量',
      'clear': '清空',
      'remove': '移除',
      'up': '上移',
      'down': '下移',
      'save': '保存设置',
      'saved': '已保存',
      'cardHint': '配置服务商降级顺序、发音人与朗读参数。',
      'skipCode': '跳过代码块',
      'skipCodeHint': '遇到代码块时朗读简短提示，而不逐行朗读代码字符。',
      'cache': '合成音频缓存',
      'cacheHint': '重复短语直接从本地缓存读取，无需重复合成。',
      'cacheMaxMb': '缓存上限 (MB)',
      'cacheMaxMbHint': '超出容量时优先淘汰最近最少使用 (LRU) 的音频。',
      'clearCache': '清空缓存',
      'pronTitle': '发音纠正字典',
      'pronHint': '规则自上而下匹配。左侧支持 /…/ 正则表达式；支持按语言过滤。',
      'pronFrom': '原词',
      'pronTo': '替换为',
      'pronWhole': '全词匹配',
      'pronLang': '语言',
      'addRule': '添加规则',
      'rolesTitle': '角色专属音色',
      'rolesHint': '留空项将自动继承主服务商配置。',
      'roleReply': '普通回复',
      'roleApproval': '操作审批',
      'roleError': '系统错误',
      'ssmlStyle': '情感语调 (SSML)',
      'ssmlStyleHint': '情绪语调风格（如 cheerful、serious、empathetic 等）。',
      'longReply': '长回复处理',
      'longReplyHint': 'truncate: 截断超长部分; summarize: 智能生成简述; full: 完整朗读全文。',
      'summaryModel': '摘要生成模型',
      'summaryModelHint': 'provider/model 格式，留空则跟随当前对话模型。',
      'summarySentences': '摘要句数',
      'summarySentencesHint': '语音朗读所采用的摘要句子数量。',
      'preview': '试听',
      'statsTitle': '实时统计',
      'statTotal': '总请求数',
      'statHits': '缓存命中',
      'statErrors': '合成失败',
      'statReset': '重置统计',
      'autoDetect': '按句自动识别语种',
      'autoDetectHint': '每句根据字符特征自动推测语言，而非强制使用全局设定。',
      'narrateQuotesOnly': '仅朗读引用内容',
      'narrateQuotesHint': '仅朗读正文中用引号括起来的引用短语。',
      'skipActions': '跳过 *星号动作*',
      'skipActionsHint': '自动剔除 *动作说明* 文本。',
      'removeRegex': '自定义正则过滤',
      'removeRegexHint': '在合成前由全局正则表达式匹配并剔除匹配文本。',
      'customBaseUrl': '自定义 TTS API 地址',
      'customBaseUrlHint': '兼容 OpenAI 的接口地址，如 http://localhost:8880/v1；留空禁用。',
      'customKeyEnv': '自定义接口凭据名',
      'customKeyEnvHint': '用于存储自定义接口 Bearer Token 的凭证槽位名称。',
      'localEnginesTitle': '本地离线引擎 (Offline)',
      'localEnginesHint': '在本地离线运行语音合成，无需 API 密钥与互联网。',
      'enableLocalEngines': '启用本地引擎',
      'enableLocalEnginesHint': '检测并调用本地 Kokoro 或 F5-TTS 模型。',
      'streamingEnabled': '毫秒级低延迟流式 (< 300 ms)',
      'streamingEnabledHint': '利用 AudioWorklet 和 SSE 实时输出流式音频。',
      'useKokoro': '启用 Kokoro-82M (CPU)',
      'useKokoroHint': '基于 CPU 的轻量级快速神经语音合成。',
      'useF5': '启用 F5-TTS (GPU)',
      'useF5Hint': '基于 NVIDIA GPU 的高保真零样本克隆语音合成。',
      'installed': '已就绪',
      'notInstalled': '未安装',
      'downloading': '下载中',
      'installKokoro': '安装权重 (350 MB)',
      'installF5': '安装权重 (2.1 GB)',
      'deleteModel': '删除模型',
      'voiceDuplexTitle': '双工语音对话 (Voice-to-Voice)',
      'voiceDuplexHint': '与 dsh-voice 协同提供全双工交互式对话。',
      'voiceNotInstalledTitle': '依赖插件 @goodandready/dsh-voice 尚未安装',
      'voiceInstallHint': '如需启用语音对话，请通过以下命令安装该插件：',
      'voiceDuplex': '语音双工模式',
      'voiceDuplexHintToggle': '用户语音输入结束后，自动使用语音朗读回复。',
      'vadBargeIn': 'VAD 语音打断',
      'vadBargeInHint': '检测到人类语音时立即终止智能体当前语音输出。',
      'newSubagentRole': '子智能体标识 (例如 coder, reviewer)',
      'addSubagentRole': '添加子智能体',
      'autoDetectSubagent': '自动感应会话中的子智能体角色',
      'role_coder': '编码助手 (Coder)',
      'role_reviewer': '代码评审 (Reviewer)',
      'role_planner': '架构规划 (Planner)',
      'enableItDictionary': '内置 IT 术语发音校正',
      'enableItDictionaryHint': '自动纠正 SQL、Nginx、K8s、Docker、API、JSON、YAML 等专有名词发音。',
      'loadItDictionary': '填入常用 IT 术语',
      'exportJson': '📥 导出 JSON',
      'importJson': '📤 导入 JSON',
      'invalidJsonFormat': '无效的字典 JSON 格式',
      'previewRule': '试听发音',
      'messengerIntegrationTitle': '即时通讯联动 (Telegram, Discord)',
      'messengerIntegrationHint': '通过 @goodandready/dsh-messenger-gateway 向聊天群组发送语音回复。',
      'messengerNotInstalledTitle': '依赖插件 @goodandready/dsh-messenger-gateway 尚未安装',
      'messengerInstallHint': '如需向聊天软件发送语音回复，请运行：',
      'messengerTtsEnabled': '群组语音回复',
      'messengerTtsEnabledHint': '允许网关将回复以语音便签 (Voice Note) 形式发送。',
    }
    function ChainEditor(props) {
      // Translator comes from the card: the slot passes props.t only to it.
      const t = props.t || ((key) => key)
      const rows = Array.isArray(props.value) ? props.value : []
      const change = (i, patch) => {
        const next = rows.map((r, k) => (k === i ? Object.assign({}, r, patch) : r))
        props.onChange(next)
      }
      const move = (i, delta) => {
        const j = i + delta
        if (j < 0 || j >= rows.length) return
        const next = rows.slice()
        const tmp = next[i]; next[i] = next[j]; next[j] = tmp
        props.onChange(next)
      }
      const remove = (i) => props.onChange(rows.filter((_, k) => k !== i))
      const add = () => props.onChange(rows.concat([{ provider: 'espeak', model: '', voice: '' }]))
      return React.createElement('div', { className: 'dts-block' },
        rows.map((row, i) => {
          const cloud = !!CLOUD[row.provider]
          const cred = credOf(props.credentials, row.provider)
          const draft = (props.keyDrafts && props.keyDrafts[row.provider]) || ''
          const badge = !cloud ? null
            : (!cred.writable ? t('fromEnv') : (cred.configured ? t('configured') : t('notSet')))
          return React.createElement('div', { className: 'dts-entry', key: i },
            React.createElement('div', { className: 'dts-row' },
              React.createElement('select', {
                className: 'dts-input',
                value: row.provider, disabled: !props.writable,
                onChange: (e) => change(i, { provider: e.target.value }),
              }, PROVIDERS.map((p) => React.createElement('option', { key: p, value: p }, p))),
              React.createElement('input', {
                className: 'dts-model dts-input', value: row.model || '', disabled: !props.writable,
                placeholder: MODEL_HINT[row.provider] || '', onChange: (e) => change(i, { model: e.target.value }),
              }),
              React.createElement('input', {
                className: 'dts-model dts-input', value: row.voice || '', disabled: !props.writable,
                placeholder: 'voice', onChange: (e) => change(i, { voice: e.target.value }),
              }),
              React.createElement('button', { type: 'button', className: 'dts-mini', title: t('up'), disabled: !props.writable, onClick: () => move(i, -1) }, '\u2191'),
              React.createElement('button', { type: 'button', className: 'dts-mini', title: t('down'), disabled: !props.writable, onClick: () => move(i, 1) }, '\u2193'),
              React.createElement('button', { type: 'button', className: 'dts-mini', title: t('testProvider') || t('preview'), disabled: !props.writable, onClick: () => props.onPreview(row.provider, row.model, row.voice) }, '\u25b6'),
              React.createElement('button', { type: 'button', className: 'dts-mini', title: t('remove'), disabled: !props.writable, onClick: () => remove(i) }, '\u00d7'),
            ),
            cloud ? React.createElement('div', { className: 'dts-row' },
              React.createElement('input', {
                className: 'dts-key dts-input', type: 'password', autoComplete: 'off',
                value: draft, disabled: !props.writable || !cred.writable,
                placeholder: cred.configured ? 'leave blank to keep' : 'paste API key',
                onChange: (e) => props.onDraft(row.provider, e.target.value),
                onBlur: (e) => props.onCommitKey(row.provider, e.target.value),
              }),
              React.createElement('span', { className: 'dts-badge' + (cred.configured ? ' dts-badge-on' : '') }, badge),
              cred.configured && cred.writable ? React.createElement('button', {
                type: 'button', className: 'dts-link', disabled: !props.writable,
                onClick: () => props.onClearKey(row.provider),
              }, t('clear')) : null,
            ) : React.createElement('span', { className: 'dts-sub' }, t('localProvider')),
            cloud && cred.ref ? React.createElement('span', { className: 'dts-sub' }, 'Stored as ' + cred.ref) : null,
            (() => {
              const hit = Array.isArray(props.breaker) ? props.breaker.find((b) => b && b.id === row.provider) : null
              if (!hit || (!hit.open && !hit.lastError)) return null
              return React.createElement('div', { className: 'dts-sub dts-bad' },
                (hit.open ? t('breakerOpen') + ' · ' : '') + (hit.lastError || '')
              )
            })(),
          )
        }),
        React.createElement('div', { className: 'dts-row' },
          React.createElement('button', { type: 'button', className: 'dts-mini', title: t('addProvider'), disabled: !props.writable, onClick: add }, '+'),
          React.createElement('span', { className: 'dts-sub' }, t('chainHint')),
        ),
      )
    }

    // Card strings live in the locale registry so a separate package can translate
    // them without touching this plugin. English is the source language and fallback.

    function LocalEnginesEditor(props) {
      const t = props.t || ((key) => key)
      const [models, setModels] = React.useState({})

      const loadStatus = React.useCallback(() => {
        if (typeof fetch === 'undefined') return
        fetch('/dsh-tts/models/status')
          .then((r) => r.json())
          .then((d) => { if (d && d.ok && d.models) setModels(d.models) })
          .catch(() => {}) // status poll best-effort
      }, [])

      React.useEffect(() => {
        loadStatus()
        const timer = setInterval(loadStatus, 5000)
        return () => clearInterval(timer)
      }, [loadStatus])

      const remove = (engine) => {
        if (typeof window !== 'undefined' && window.confirm) {
          if (!window.confirm(t('confirmDeleteModel'))) return
        }
        fetch('/dsh-tts/models/delete', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ engine }),
        }).then(() => loadStatus()).catch(() => {})
      }

      const kokoro = models.kokoro || { installed: false, downloading: false, progress: 0 }
      const f5 = models.f5 || { installed: false, downloading: false, progress: 0 }

      const engineRow = (label, state) => React.createElement('div', { className: 'dts-entry' },
        React.createElement('div', { className: 'dts-row' },
          React.createElement('span', { className: 'dts-h', style: { minWidth: '150px' } }, label),
          React.createElement('span', {
            className: 'dts-badge dts-badge-warn',
          }, t('runtimeNotBundled')),
          state.installed ? React.createElement('button', {
            type: 'button', className: 'dts-link', disabled: !props.writable,
            onClick: () => remove(label.toLowerCase().includes('kokoro') ? 'kokoro' : 'f5'),
          }, t('deleteModel')) : null,
        ),
        React.createElement('div', { className: 'dts-sub' }, t('runtimeNotBundledHint')),
      )

      return React.createElement('div', { className: 'dts-block' },
        React.createElement('div', { className: 'dts-h' }, t('localEnginesTitle')),
        React.createElement('div', { className: 'dts-sub' }, t('localEnginesHint')),
        React.createElement('div', { className: 'dts-alert-warn dts-sub' }, t('runtimeNotBundledHint')),
        props.boolField('streamingEnabled', t('streamingEnabled'), t('streamingEnabledHint')),
        engineRow('Kokoro-82M (CPU)', kokoro),
        engineRow('F5-TTS (GPU)', f5),
      )
    }

    const CLIENT_IT_TERMS = []

    // Pronunciation dictionary editor: rules apply top-down.
    function PronEditor(props) {
      const t = props.t || ((key) => key)
      const rows = Array.isArray(props.value) ? props.value : []
      const fileInputRef = React.useRef(null)

      const change = (i, patch) => {
        props.onChange(rows.map((r, k) => (k === i ? Object.assign({}, r, patch) : r)))
      }
      const remove = (i) => props.onChange(rows.filter((_, k) => k !== i))
      const add = () => props.onChange(rows.concat([{ from: '', to: '', whole: false, lang: '' }]))
      const loadIt = () => {
        const existing = new Set(rows.map((r) => String(r.from).toLowerCase()))
        const toAdd = CLIENT_IT_TERMS.filter((r) => !existing.has(String(r.from).toLowerCase()))
        props.onChange(rows.concat(toAdd))
      }

      const exportJson = () => {
        const data = JSON.stringify(rows, null, 2)
        const blob = new Blob([data], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'pronunciation-dictionary.json'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => { try { URL.revokeObjectURL(url) } catch (alreadyRevoked) { /* already revoked */ } }, 1000)
      }

      const triggerImport = () => {
        if (fileInputRef.current) fileInputRef.current.click()
      }

      const handleImportFile = (e) => {
        const file = e.target.files && e.target.files[0]
        if (!file) return
        const reader = new FileReader()
        reader.onload = (event) => {
          try {
            const parsed = JSON.parse(event.target.result)
            if (!Array.isArray(parsed)) {
              if (typeof window !== 'undefined' && window.alert) window.alert(t('invalidJsonFormat'))
              return
            }
            const importedRules = parsed.map((item) => ({
              from: String(item.from || ''),
              to: String(item.to || ''),
              whole: !!item.whole,
              lang: String(item.lang || ''),
            })).filter((r) => r.from || r.to)

            const existingKeys = new Set(rows.map((r) => String(r.from).toLowerCase()))
            const newItems = importedRules.filter((r) => !existingKeys.has(String(r.from).toLowerCase()))
            props.onChange(rows.concat(newItems))
          } catch (err) {
            if (typeof window !== 'undefined' && window.alert) window.alert(t('invalidJsonFormat'))
          }
          e.target.value = ''
        }
        reader.readAsText(file)
      }

      return React.createElement('div', { className: 'dts-wrap-in' },
        React.createElement('input', {
          type: 'file',
          ref: fileInputRef,
          accept: '.json',
          style: { display: 'none' },
          onChange: handleImportFile,
        }),
        rows.map((rule, i) => React.createElement('div', { className: 'dts-row', key: i },
          React.createElement('input', {
            className: 'dts-input dts-grow', placeholder: t('pronFrom'),
            value: rule.from || '', disabled: !props.writable,
            onChange: (e) => change(i, { from: e.target.value }),
          }),
          React.createElement('input', {
            className: 'dts-input dts-grow', placeholder: t('pronTo'),
            value: rule.to || '', disabled: !props.writable,
            onChange: (e) => change(i, { to: e.target.value }),
          }),
          React.createElement('label', { className: 'dts-sub', title: t('pronWhole') },
            React.createElement('input', {
              type: 'checkbox', checked: !!rule.whole, disabled: !props.writable,
              onChange: (e) => change(i, { whole: e.target.checked }),
            }),
          ),
          React.createElement('input', {
            className: 'dts-input', style: { maxWidth: '70px' }, placeholder: t('pronLang'),
            value: rule.lang || '', disabled: !props.writable,
            onChange: (e) => change(i, { lang: e.target.value }),
          }),
          React.createElement('button', {
            type: 'button', className: 'dts-mini', title: t('previewRule'), disabled: !props.writable,
            onClick: () => {
              if (props.onPreviewPhrase) props.onPreviewPhrase(rule.to || rule.from)
            },
          }, '\u25b6'),
          React.createElement('button', { type: 'button', className: 'dts-mini', disabled: !props.writable, onClick: () => remove(i) }, '\u00d7'),
        )),
        React.createElement('div', { className: 'dts-row' },
          React.createElement('button', { type: 'button', className: 'dts-mini', disabled: !props.writable, onClick: add }, '+'),
          React.createElement('button', { type: 'button', className: 'dts-link', disabled: !props.writable, onClick: loadIt }, t('loadItDictionary')),
          React.createElement('button', { type: 'button', className: 'dts-link', disabled: !props.writable, onClick: exportJson }, t('exportJson')),
          React.createElement('button', { type: 'button', className: 'dts-link', disabled: !props.writable, onClick: triggerImport }, t('importJson')),
          React.createElement('span', { className: 'dts-sub' }, t('pronHint')),
        ),
      )
    }

    function RolesEditor(props) {
      const t = props.t || ((key) => key)
      const value = props.value || {}
      const [newRole, setNewRole] = React.useState('')
      const set = (r, patch) => props.onChange(Object.assign({}, value, { [r]: Object.assign({}, value[r] || {}, patch) }))
      const removeRole = (r) => {
        const next = Object.assign({}, value)
        delete next[r]
        props.onChange(next)
      }

      const standardKeys = ['reply', 'approval', 'error']
      const customKeys = Object.keys(value).filter((k) => !standardKeys.includes(k))
      const allKeys = [...standardKeys, ...customKeys]

      const addCustom = () => {
        const name = newRole.trim().toLowerCase()
        if (!name || value[name]) return
        set(name, { provider: '', model: '', voice: '', chime: '', ssmlStyle: '' })
        setNewRole('')
      }

      return React.createElement('div', { className: 'dts-block' },
        React.createElement('span', { className: 'dts-sub' }, t('rolesHint')),
        allKeys.map((r) => React.createElement('div', { className: 'dts-row', key: r },
          React.createElement('span', { className: 'dts-sub', style: { minWidth: '110px' } }, t('role_' + r) !== ('role_' + r) ? t('role_' + r) : `👤 ${r}`),
          React.createElement('select', {
            className: 'dts-input', value: (value[r] && value[r].provider) || '', disabled: !props.writable,
            onChange: (e) => set(r, { provider: e.target.value }),
          },
            React.createElement('option', { value: '' }, '—'),
            PROVIDERS.map((p) => React.createElement('option', { key: p, value: p }, p)),
          ),
          React.createElement('input', {
            className: 'dts-input dts-grow', placeholder: 'model',
            value: (value[r] && value[r].model) || '', disabled: !props.writable,
            onChange: (e) => set(r, { model: e.target.value }),
          }),
          React.createElement('input', {
            className: 'dts-input dts-grow', placeholder: 'voice',
            value: (value[r] && value[r].voice) || '', disabled: !props.writable,
            onChange: (e) => set(r, { voice: e.target.value }),
          }),
          React.createElement('input', {
            className: 'dts-input', style: { maxWidth: '90px' }, placeholder: t('chime'),
            value: (value[r] && value[r].chime) || '', disabled: !props.writable,
            onChange: (e) => set(r, { chime: e.target.value }),
          }),
          React.createElement('input', {
            className: 'dts-input dts-grow', placeholder: t('ssmlStyle') || 'ssml',
            title: t('ssmlStyleHint') || 'SSML tone style',
            value: (value[r] && value[r].ssmlStyle) || '', disabled: !props.writable,
            onChange: (e) => set(r, { ssmlStyle: e.target.value }),
          }),
          React.createElement('button', { type: 'button', className: 'dts-mini', disabled: !props.writable, onClick: () => props.onPreview((value[r] && value[r].provider) || '', (value[r] && value[r].model) || '', (value[r] && value[r].voice) || '') }, '\u25b6'),
          !standardKeys.includes(r) ? React.createElement('button', { type: 'button', className: 'dts-mini', title: t('remove'), disabled: !props.writable, onClick: () => removeRole(r) }, '\u00d7') : null,
        )),
        React.createElement('div', { className: 'dts-row' },
          React.createElement('input', {
            className: 'dts-input', style: { maxWidth: '180px' }, placeholder: t('newSubagentRole'),
            value: newRole, disabled: !props.writable,
            onChange: (e) => setNewRole(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') addCustom() },
          }),
          React.createElement('button', { type: 'button', className: 'dts-save', disabled: !props.writable || !newRole.trim(), onClick: addCustom }, t('addSubagentRole')),
        ),
      )
    }

    function VoiceDuplexEditor(props) {
      const t = props.t || ((key) => key)
      const installed = !!props.installed

      return React.createElement('div', { className: 'dts-block' },
        React.createElement('div', { className: 'dts-h' }, t('voiceDuplexTitle')),
        React.createElement('div', { className: 'dts-sub' }, t('voiceDuplexHint')),
        !installed ? React.createElement('div', {
          style: {
            padding: '10px 14px',
            borderRadius: '8px',
            border: '1px solid var(--dsw-alias-state-warning-primary)',
            background: 'var(--dsw-alias-bg-layer-2)',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            fontSize: '13px',
          },
        },
          React.createElement('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-state-warning-primary)' } },
            '⚠️ ' + t('voiceNotInstalledTitle')
          ),
          React.createElement('span', { className: 'dts-sub' },
            t('voiceInstallHint') + ': '
          ),
          React.createElement('code', {
            style: {
              fontFamily: 'monospace',
              fontSize: '12px',
              padding: '2px 6px',
              borderRadius: '4px',
              background: 'var(--dsw-alias-bg-layer-3)',
              color: 'var(--dsw-alias-label-primary)',
              width: 'fit-content',
            },
          }, 'dsh plugin --profile web add @goodandready/dsh-voice')
        ) : null,
        props.boolField('voiceDuplexEnabled', t('voiceDuplex'), t('voiceDuplexHintToggle'), !installed),
        props.boolField('vadBargeIn', t('vadBargeIn'), t('vadBargeInHint'), !installed),
      )
    }

    function MessengerIntegrationEditor(props) {
      const t = props.t || ((key) => key)
      const installed = !!props.installed

      return React.createElement('div', { className: 'dts-block' },
        React.createElement('div', { className: 'dts-h' }, t('messengerIntegrationTitle')),
        React.createElement('div', { className: 'dts-sub' }, t('messengerIntegrationHint')),
        !installed ? React.createElement('div', {
          style: {
            padding: '10px 14px',
            borderRadius: '8px',
            border: '1px solid var(--dsw-alias-state-warning-primary)',
            background: 'var(--dsw-alias-bg-layer-2)',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            fontSize: '13px',
          },
        },
          React.createElement('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-state-warning-primary)' } },
            '⚠️ ' + t('messengerNotInstalledTitle')
          ),
          React.createElement('span', { className: 'dts-sub' },
            t('messengerInstallHint') + ': '
          ),
          React.createElement('code', {
            style: {
              fontFamily: 'monospace',
              fontSize: '12px',
              padding: '2px 6px',
              borderRadius: '4px',
              background: 'var(--dsw-alias-bg-layer-3)',
              color: 'var(--dsw-alias-label-primary)',
              width: 'fit-content',
            },
          }, 'dsh plugin --profile web add @goodandready/dsh-messenger-gateway')
        ) : null,
        props.boolField('messengerTtsEnabled', t('messengerTtsEnabled'), t('messengerTtsEnabledHint'), !installed),
      )
    }

    // Synthesis stats panel: live host counters.
    function StatsPanel(props) {
      const t = props.t || ((key) => key)
      const [data, setData] = React.useState(null)
      const loadStats = () => {
        fetch('/dsh-tts/stats', { cache: 'no-store' }).then((r) => r.json()).then(setData).catch(() => {})
      }
      React.useEffect(() => { loadStats() }, [])
      const reset = () => {
        fetch('/dsh-tts/stats', { method: 'DELETE' }).then(loadStats).catch(() => {})
      }
      return React.createElement('div', { className: 'dts-block' },
        React.createElement('span', { className: 'dts-sub' }, data
          ? t('statTotal') + ': ' + data.total + ' · ' + t('statHits') + ': ' + data.cacheHits + ' · ' + t('statErrors') + ': ' + data.errors
          : t('loading')),
        data && Object.keys(data.providers || {}).map((p) => React.createElement('span', { className: 'dts-sub', key: p },
          p + ': ' + data.providers[p].n + ' / ' + data.providers[p].ms + 'ms')),
        React.createElement('button', { type: 'button', className: 'dts-link', onClick: reset }, t('statReset')),
      )
    }

    // Plugin-settings tab card follows the shared card pattern: li in the core list,
    // theme-reset header, body with a divider. Chevron is ours; core does not provide it.
    function TtsSection(props) {
      // Translator comes from the slot because its registration sets locale.
      const t = (props && props.t) || ((key) => key)
      const [draft, setDraft] = React.useState(null)
      const [credentials, setCredentials] = React.useState({})
      const [keyDrafts, setKeyDrafts] = React.useState({})
      const [saved, setSaved] = React.useState(false)
      const [err, setErr] = React.useState('')
      const [integrations, setIntegrations] = React.useState({ voice: { installed: false }, messenger: { installed: false } })
      const [telemetry, setTelemetry] = React.useState({ online: true, cacheHits: 0, sseOk: true, total: 0, sseClients: 0, breaker: [], provider: '', queue: 0 })
      const [advancedOpen, setAdvancedOpen] = React.useState(() => {
        try { return localStorage.getItem('dsh-tts/advancedOpen') === '1' } catch { /* localStorage unavailable */ return false }
      })
      const autoplay = useAutoplayGate()

      const ctx = props && props.ctx
      const scope = React.useMemo(() => {
        const s = (ctx && ctx.get && ctx.get('lanSettings')) || (ctx && ctx.settingsScope)
        if (!s || !s.bind) return null
        try {
          return s.bind({ namespace: NS })
        } catch (_) { /* settings scope binding failed */ 
          return null
        }
      }, [ctx])

      const subscribe = React.useMemo(() => {
        return (cb) => {
          if (!scope || !scope.subscribe) return () => {}
          try {
            return scope.subscribe(cb) || (() => {})
          } catch (_) { /* settings scope binding failed */ 
            return () => {}
          }
        }
      }, [scope])

      const getSnapshot = React.useCallback(() => {
        if (!scope || !scope.getSnapshot) return SNAPSHOT_LOADING
        try {
          return scope.getSnapshot() || SNAPSHOT_LOADING
        } catch (_) { /* settings scope binding failed */ 
          return SNAPSHOT_LOADING
        }
      }, [scope])

      const snap = (React.useSyncExternalStore
        ? React.useSyncExternalStore(subscribe, getSnapshot, React.useCallback(() => SNAPSHOT_LOADING, []))
        : null) || (scope && scope.getSnapshot ? scope.getSnapshot() : SNAPSHOT_LOADING)

    // Snapshot status matters more than the value:
    //   loading     — host has not answered yet;
    //   unavailable — host answered but the settings namespace is not ready;
    //   ready       — values are present.
    // On unavailable, writable defaults true; without a status check the card
    // looks like a working empty form.
      const ready = !scope || (!!snap && snap.status === 'ready')
      const writable = !scope ? true : (ready && snap.writable !== false)

      const applyPayload = (data) => {
        const cfg = data && data.config ? data.config : {}
        setDraft(JSON.parse(JSON.stringify(cfg)))
        setCredentials(data && data.credentials ? data.credentials : {})
        player.enabled = !!cfg.speakReplies
      }

      React.useEffect(() => {
        let alive = true
        fetch('/dsh-tts/config', { cache: 'no-store' }).then((res) => res.json()).then((data) => {
          if (!alive) return
          applyPayload(data)
        }).catch((e) => { if (alive) setErr(String(e && e.message ? e.message : e)) })

        fetch('/dsh-tts/integrations', { cache: 'no-store' }).then((res) => res.json()).then((data) => {
          if (!alive) return
          if (data && data.ok) setIntegrations(data)
        }).catch(() => {})

        const loadTelemetry = () => {
          fetch('/dsh-tts/stats', { cache: 'no-store' }).then((res) => res.json()).then((st) => {
            if (!alive || !st) return
            setTelemetry((prev) => Object.assign({}, prev, {
              cacheHits: st.cacheHits || 0,
              total: st.total || 0,
              online: true,
              breaker: st.breaker || prev.breaker || [],
            }))
          }).catch(() => {
            if (alive) setTelemetry((prev) => Object.assign({}, prev, { online: false }))
          })
          fetch('/dsh-tts/status', { cache: 'no-store' }).then((res) => res.json()).then((st) => {
            if (!alive || !st) return
            setTelemetry((prev) => Object.assign({}, prev, {
              sseClients: st.sseClients || 0,
              sseOk: (st.sseClients || 0) >= 0,
              provider: (player.audio && player.provider) || (player.queue[0] && player.queue[0].provider) || '',
              queue: player.queue.length,
            }))
          }).catch(() => {})
        }
        loadTelemetry()
        const telTimer = setInterval(loadTelemetry, 3000)
        // interval cleaned by effect return below

        return () => { alive = false; clearInterval(telTimer) }
      }, [])

      if (!draft) return React.createElement('div', { className: 'dts-wrap' }, t('loading'))

      const setTop = (key, v) => setDraft((d) => Object.assign({}, d || {}, { [key]: v }))
      const setDraftKey = (provider, value) => setKeyDrafts((d) => Object.assign({}, d, { [provider]: value }))

      const commitKey = async (provider, raw) => {
        const value = String(raw != null ? raw : ((keyDrafts && keyDrafts[provider]) || '')).trim()
        if (!value) return
        setErr('')
        const res = await fetch('/dsh-tts/credential', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: provider, value: value }),
        })
        const data = await res.json().catch(() => ({ /* parse error */ }))
        if (!res.ok) throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status))
        if (data && data.credentials) setCredentials(data.credentials)
        setKeyDrafts((d) => Object.assign({}, d, { [provider]: '' }))
      }

      const clearKey = async (provider) => {
        setErr('')
        try {
          const res = await fetch('/dsh-tts/credential', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: provider }),
          })
          const data = await res.json().catch(() => ({ /* parse error */ }))
          if (!res.ok) throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status))
          if (data && data.credentials) setCredentials(data.credentials)
          setKeyDrafts((d) => Object.assign({}, d, { [provider]: '' }))
        } catch (e) { setErr(String(e && e.message ? e.message : e)) }
      }

      const save = async () => {
        setErr(''); setSaved(false)
        if (!draft) return
        try {
          const keys = {}
          Object.keys(keyDrafts || {}).forEach((p) => {
            const v = String(keyDrafts[p] || '').trim()
            if (v) keys[p] = v
          })
          const res = await fetch('/dsh-tts/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({}, draft, { keys: keys })),
          })
          const data = await res.json().catch(() => ({ /* parse error */ }))
          if (!res.ok) throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status))
          applyPayload(data)
          setKeyDrafts({})
          setSaved(true); setTimeout(() => setSaved(false), 2000)
        } catch (e) { setErr(String(e && e.message ? e.message : e)) }
      }

      const onCommitKey = (provider, raw) => {
        commitKey(provider, raw).catch((e) => setErr(String(e && e.message ? e.message : e)))
      }

      const clearCacheNow = async () => {
        setErr('')
        const res = await fetch('/dsh-tts/cache', { method: 'DELETE' })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        setSaved(true); setTimeout(() => setSaved(false), 2000)
      }
      const onClearCache = () => {
        if (typeof window !== 'undefined' && window.confirm) {
          if (!window.confirm(t('confirmClearCache'))) return
        }
        clearCacheNow().catch((e) => setErr(String(e && e.message ? e.message : e)))
      }

      const onPreview = (provider, model, voice, text) => {
        fetch('/dsh-tts/preview', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, model, voice, text }),
        })
          .then((r) => r.json())
          .then((d) => {
            if (!d.ok) throw new Error((d.error && d.error.message) || 'HTTP error')
            new Audio('data:' + d.mime + ';base64,' + d.audioBase64).play().catch(() => { /* autoplay blocked */ })
          })
          .catch((e) => setErr(String(e && e.message ? e.message : e)))
      }

      const onPreviewPhrase = (phrase) => {
        if (!phrase) return
        const first = draft && draft.chain && draft.chain[0]
        onPreview((first && first.provider) || 'kokoro', (first && first.model) || '', (first && first.voice) || '', phrase)
      }

      const boolField = (key, label, hint) => React.createElement('label', { className: 'dts-field' }, label,
        React.createElement('input', {
          type: 'checkbox', checked: !!(draft && draft[key]), disabled: !writable,
          onChange: (e) => setTop(key, e.target.checked),
        }),
        React.createElement('span', { className: 'dts-sub' }, hint))

      const numberField = (key, label, hint, step) => React.createElement('label', { className: 'dts-field' }, label,
        React.createElement('input', {
          type: 'number', step: step || 1,
          className: 'dts-input',
          value: draft && draft[key] !== undefined ? draft[key] : '', disabled: !writable,
          onChange: (e) => setTop(key, Number(e.target.value)),
        }),
        React.createElement('span', { className: 'dts-sub' }, hint))

      const textField = (key, label, hint) => React.createElement('label', { className: 'dts-field' }, label,
        React.createElement('input', {
          className: 'dts-input',
          value: draft && draft[key] !== undefined ? draft[key] : '', disabled: !writable,
          onChange: (e) => setTop(key, e.target.value),
        }),
        React.createElement('span', { className: 'dts-sub' }, hint))

      const autoplayBanner = autoplay.blocked
        ? React.createElement('div', { className: 'dts-unlock' },
            React.createElement('span', null, t('autoplayBlocked')),
            React.createElement('button', {
              type: 'button', className: 'dts-unlock-btn',
              onClick: () => player.unlockAudio && player.unlockAudio(),
            }, t('enableSound')),
          )
        : null
      const breakerBadges = (telemetry.breaker || []).filter((b) => b && b.open).slice(0, 2)
        .map((b) => React.createElement('span', { key: b.id, className: 'dts-badge dts-badge-bad' }, t('breakerOpen') + ': ' + b.id))
      const telemetryBadges = React.createElement('div', { className: 'dts-row', style: { marginBottom: '8px' }, 'data-dsh-tts-telemetry': '1' },
        React.createElement('span', {
          className: 'dts-badge ' + (telemetry.online ? 'dts-badge-on' : 'dts-badge-bad'),
        }, telemetry.online ? t('statusOnline') : t('statusOffline')),
        React.createElement('span', {
          className: 'dts-badge ' + (telemetry.sseClients > 0 ? 'dts-badge-on' : ''),
        }, t('sseState') + ': ' + (telemetry.sseClients || 0)),
        React.createElement('span', { className: 'dts-badge' },
          t('queueLen') + ': ' + (telemetry.queue || player.queue.length || 0)),
        telemetry.provider ? React.createElement('span', { className: 'dts-badge' },
          t('activeProvider') + ': ' + telemetry.provider) : null,
        React.createElement('span', { className: 'dts-badge' },
          t('cacheStats') + ': ' + telemetry.cacheHits + ' / ' + telemetry.total),
        ...breakerBadges,
      )
      const titleLine = props && props.compact ? null : React.createElement('div', { className: 'dts-header' },
        React.createElement('div', { className: 'dts-page-title' }, '🔊 ' + t('title')),
        React.createElement('div', { className: 'dts-page-sub' }, t('subtitle')),
        telemetryBadges,
      )
      return React.createElement('div', { className: 'dts-wrap' },
        autoplayBanner,
        React.createElement('div', { className: 'dts-block' },
          titleLine,
          React.createElement('label', { className: 'dts-row' },
            React.createElement('input', {
              type: 'checkbox', checked: !!(draft && draft.speakReplies), disabled: !writable,
              onChange: (e) => setTop('speakReplies', e.target.checked),
            }),
            React.createElement('span', null, t('speakReplies')),
          ),
          React.createElement('div', { className: 'dts-sub' },
            t('speakRepliesHint')),
        ),
        React.createElement(LocalEnginesEditor, {
          t: t, writable: writable, draft: draft,
          boolField: boolField, setTop: setTop,
        }),
        React.createElement(VoiceDuplexEditor, {
          t: t, writable: writable, draft: draft,
          boolField: boolField, setTop: setTop,
          installed: !!(integrations && integrations.voice && integrations.voice.installed),
        }),
        React.createElement(MessengerIntegrationEditor, {
          t: t, writable: writable, draft: draft,
          boolField: boolField, setTop: setTop,
          installed: !!(integrations && integrations.messenger && integrations.messenger.installed),
        }),
        React.createElement('div', { className: 'dts-block' },
          React.createElement('div', { className: 'dts-h' }, t('pronTitle')),
          boolField('enableItDictionary', t('enableItDictionary'), t('enableItDictionaryHint')),
          React.createElement(PronEditor, {
            t: t, writable: writable,
            value: draft && draft.pronunciation ? draft.pronunciation : [],
            onChange: (v) => setTop('pronunciation', v),
            onPreviewPhrase: onPreviewPhrase,
          }),
        ),
        React.createElement('div', { className: 'dts-block' },
          React.createElement('div', { className: 'dts-h' }, t('rolesTitle')),
          boolField('autoDetectSubagent', t('autoDetectSubagent'), t('autoDetectSubagent')),
          React.createElement(RolesEditor, {
            t: t, writable: writable, onPreview: onPreview,
            value: draft && draft.roles ? draft.roles : {},
            onChange: (v) => setTop('roles', v),
          }),
        ),
        React.createElement('div', { className: 'dts-block' },
          React.createElement('div', { className: 'dts-h' }, t('statsTitle')),
          React.createElement(StatsPanel, { t: t }),
        ),
        React.createElement('div', { className: 'dts-block' },
          React.createElement('div', { className: 'dts-h' }, t('chainTitle')),
          React.createElement('div', { className: 'dts-sub' },
            t('chainHintCard')),
          React.createElement(ChainEditor, {
            breaker: telemetry.breaker,
            t: t,
            value: draft && draft.chain ? draft.chain : [], writable: writable,
            credentials: credentials, keyDrafts: keyDrafts,
            onChange: (v) => setTop('chain', v),
            onDraft: setDraftKey,
            onCommitKey: onCommitKey,
            onClearKey: clearKey,
            onPreview: onPreview,
          }),
        ),
        React.createElement('div', { className: 'dts-block' },
          React.createElement('div', { className: 'dts-h' }, t('general')),
          boolField('speakAsItGoes', t('speakAsItGoes'),
            t('speakAsItGoesHint')),
          numberField('rate', t('rate'), t('rateHint'), 0.1),
          boolField('bargeIn', t('bargeIn'),
            t('bargeInHint')),
          boolField('announceApproval', t('announce'),
            t('announceHint')),
          boolField('skipCode', t('skipCode'),
            t('skipCodeHint')),
          boolField('cache', t('cache'),
            t('cacheHint')),
          numberField('cacheMaxMb', t('cacheMaxMb'), t('cacheMaxMbHint'), 10),
          React.createElement('label', { className: 'dts-field' }, t('longReply'),
            React.createElement('select', {
              className: 'dts-input', value: (draft && draft.longReply) || 'truncate', disabled: !writable,
              onChange: (e) => setTop('longReply', e.target.value),
            }, ['truncate', 'summarize', 'full'].map((mode) => React.createElement('option', { key: mode, value: mode }, mode))),
            React.createElement('span', { className: 'dts-sub' }, t('longReplyHint'))),
          textField('summaryModel', t('summaryModel'), t('summaryModelHint')),
          numberField('summarySentences', t('summarySentences'), t('summarySentencesHint'), 1),
          boolField('autoDetect', t('autoDetect'), t('autoDetectHint')),
          boolField('narrateQuotesOnly', t('narrateQuotesOnly'), t('narrateQuotesHint')),
          boolField('skipActions', t('skipActions'), t('skipActionsHint')),
          textField('removeRegex', t('removeRegex'), t('removeRegexHint')),
          textField('customBaseUrl', t('customBaseUrl'), t('customBaseUrlHint')),
          textField('customKeyEnv', t('customKeyEnv'), t('customKeyEnvHint')),
          textField('approvalText', t('approvalText'), t('approvalHint')),
          textField('questionText', t('questionText'), t('questionHint')),
          textField('chime', t('chime'), t('chimeHint')),
          textField('language', t('language'), t('languageHint')),
          textField('piperModel', t('piperModel'), t('piperModelHint')),
          textField('piperBin', t('piperBin'), t('binHint')),
          textField('espeakBin', t('espeakBin'), t('espeakHint')),
          textField('edgeBin', t('edgeBin'), t('edgeHint')),
          textField('azureRegion', t('azureRegion'), t('azureHint')),
        ),
        React.createElement('div', { className: 'dts-block' },
          React.createElement('button', {
            type: 'button',
            className: 'dts-head',
            'aria-expanded': advancedOpen,
            onClick: () => {
              setAdvancedOpen((v) => {
                const next = !v
                try { localStorage.setItem('dsh-tts/advancedOpen', next ? '1' : '0') } catch { /* private mode */ }
                return next
              })
            },
          },
            React.createElement('div', { className: 'dts-headText' },
              React.createElement('div', { className: 'dts-title' }, t('advancedTitle')),
              React.createElement('div', { className: 'dts-sub' }, t('advancedHint')),
            ),
          ),
          advancedOpen ? React.createElement('div', { className: 'dts-body' },
            numberField('maxChars', t('maxChars'), t('maxCharsHint'), 100),
            numberField('sentenceChars', t('sentenceChars'), t('sentenceCharsHint'), 20),
            numberField('timeoutMs', t('timeoutMs'), t('timeoutMsHint'), 1000),
            numberField('maxQueue', t('maxQueue'), t('maxQueueHint'), 1),
            textField('openaiBaseUrl', t('openaiBaseUrl'), t('openaiBaseUrlHint')),
            textField('mimoBaseUrl', t('mimoBaseUrl'), t('mimoBaseUrlHint')),
            textField('mimoFormat', t('mimoFormat'), t('mimoFormatHint')),
            textField('minimaxBin', t('minimaxBin'), t('minimaxBinHint')),
          ) : null,
        ),
        React.createElement('div', { className: 'dts-foot' },
          React.createElement('button', { type: 'button', className: 'dts-link', disabled: !writable, onClick: onClearCache }, t('clearCache')),
          React.createElement('button', { type: 'button', className: 'dts-save', disabled: !writable, onClick: save }, t('save')),
          saved ? React.createElement('span', { className: 'dts-ok' }, t('saved')) : null,
          err ? React.createElement('span', { className: 'dts-bad' }, err) : null,
        ),
      )
    }


    function TtsCard(props) {
      const t = (props && props.t) || ((key) => key)
      const [open, setOpen] = React.useState(false)
      return React.createElement('li', { className: 'dts-card' },
        React.createElement('button', {
          type: 'button',
          className: 'dts-head',
          onClick: () => setOpen(!open),
          'aria-expanded': open,
        },
          React.createElement('div', { className: 'dts-headText' },
            React.createElement('div', { className: 'dts-title' }, t('title')),
            React.createElement('div', { className: 'dts-sub' }, t('cardHint')),
          ),
          ChevronIcon
            ? React.createElement(ChevronIcon, { className: 'dts-chev' + (open ? ' dts-chevOpen' : '') })
            : React.createElement('svg', {
                className: 'dts-chev' + (open ? ' dts-chevOpen' : ''),
                width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
              },
                React.createElement('path', {
                  d: 'M4 6l4 4 4-4', stroke: 'currentColor', 'stroke-width': 1.5,
                  'stroke-linecap': 'round', 'stroke-linejoin': 'round',
                }),
              ),
        ),
        open ? React.createElement('div', { className: 'dts-body' },
          React.createElement(ErrorBoundary, null,
            React.createElement(TtsSection, Object.assign({}, props, { compact: true, ctx: props && props.ctx })),
          ),
        ) : null,
      )
    }

    // Input-dock button: shows what is playing, stop control, and recents for replay.
    function SpeakerControl(props) {
    // A slot with `locale` injects translations into props; the fallback is the
    // binder created at registration, in case the slot drops translations.
      const t = (props && props.t) || fallbackDockText
      const p = usePlayer()
      const [showList, setShowList] = React.useState(false)
      // "Is she speaking right now" has to cover BOTH playback paths.
      //
      // `audio` and `queue` are the WAV path's evidence: an <audio> element and a
      // queue of pending blobs. Progressive PCM has neither — its blocks are handed
      // straight to the AudioContext as they arrive and no <audio> element is ever
      // created — so with only those three terms the dock rendered `null` for the
      // whole of every PCM reply and the pause/stop controls disappeared from the
      // UI. That was a real regression: the transport was promoted without the dock
      // being taught about the second path.
      //
      // `speaking` is the transport-independent flag the plugin already maintains
      // (and that dsh-voice's barge-in gate reads), so it is the honest term to add.
      // `pcmPlaying` covers the tail where the bytes have all been scheduled but the
      // sound has not finished, which is when the controls are most wanted.
      const active = !!p.audio || p.queue.length > 0 || p.busy || !!p.speaking || !!p.pcmPlaying
      const [, force] = React.useReducer((n) => n + 1, 0)
      if (!active && !showList) return null
      const lists = recent.list()
      const row = (text, starred) => React.createElement('div', { className: 'dts-row', key: text.slice(0, 24) + starred },
        React.createElement('button', {
          type: 'button', className: 'dts-link', style: { flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          title: text,
          onClick: () => playStandalone(text), title: text,
        }, text.slice(0, 80)),
        React.createElement('button', {
          type: 'button', className: 'dts-link', title: '★',
          onClick: () => { recent.toggleFav(text); force() },
        }, starred ? '★' : '☆'),
        React.createElement('button', {
          type: 'button', className: 'dts-link', title: t('exportAudio') || 'Export',
          onClick: () => exportAudioClip(text),
        }, '⤓'),
      )
      return React.createElement('div', { style: { position: 'relative', display: 'inline-flex', gap: '4px', alignItems: 'center' } },
        React.createElement('button', {
          type: 'button', className: 'dts-link', title: t('recent') || 'Recent',
          onClick: () => setShowList((v) => !v),
        }, '☰'),
        showList ? React.createElement('div', {
          className: 'dts-wrap',
          style: { position: 'absolute', bottom: '36px', right: 0, zIndex: 30, maxHeight: '320px', overflowY: 'auto', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '12px', padding: '10px 12px', minWidth: '260px', flexDirection: 'column', gap: '6px', display: 'flex' },
        },
          lists.favs.length ? React.createElement('div', { className: 'dts-h' }, '★') : null,
          lists.favs.map((text) => row(text, true)),
          React.createElement('div', { className: 'dts-h' }, '⟳'),
          lists.items.filter((x) => !lists.favs.includes(x)).map((text) => row(text, false)),
          !lists.items.length ? React.createElement('span', { className: 'dts-sub' }, t('recentEmpty') || 'No recent speech yet') : null,
        ) : null,
        React.createElement('button', {
          type: 'button',
          className: 'dts-link',
          title: p.paused ? t('dockResume') : t('dockPause'),
          onClick: togglePause,
        }, p.paused ? '▶' : '❚❚'),
        React.createElement('button', {
          type: 'button',
          className: 'dts-link',
          title: t('dockStop'),
          onClick: stopPlayback,
        }, '■'),
        React.createElement('button', {
          type: 'button',
          className: 'dts-link',
          title: t('exportAudio') || 'Export clip',
          onClick: () => exportAudioClip(player.lastText),
        }, '⤓'),
      )
    }

    /**
     * Fallback translator for the dock.
     *
     * Bound at registration for the page lifetime. The core draws the slot label;
     * props.t never reaches it, so the binder is the only way to give it a language.
     */
    let fallbackDockText = (key) => key

    function registerSpeaker(ctx) {
    // `locale` in the slot descriptor is how core injects translations into props.
    // Without it the dock would show raw keys only.
      fallbackDockText = ctx.locale.bind(NS)
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
        {
          name: 'conversation.input.dock',
          id: '@goodandready/dsh-tts',
          locale: NS,
          order: 5,
          label: () => fallbackDockText('dockLabel'),
        },
        SpeakerControl,
      ))
    }

    function registerSettings(ctx) {
    // Dictionary packages may also register languages for other namespaces.
    // Core throws on duplicate namespace+language; an unguarded call used to
    // take down the whole plugin ("Failed to load plugins"). Register each
    // language separately: skip if taken; English still lands.
      const addLocale = (locale, dictionary) => {
        try {
          return ctx.locale.register(NS, locale, dictionary)
        } catch (alreadyTaken) {
          return () => {}
        }
      }
      ctx.effect(() => {
        const undo = [addLocale('en', en), addLocale('zh', zh)]
        return () => { for (const off of undo) off() }
      }, 'dsh-tts: locales')
    // The sidebar draws the section label, not our component: props.t never
    // reaches it, so bind the translator to the namespace ourselves.
      const t = ctx.locale.bind(NS)
    // Primary settings home is the plugin-settings tab card. The tab looks up
    // a slot by entryKey equal to the namespace name: key must equal NS or
    // the card never appears, with no log error.
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
        {
          name: 'settings.plugin.item',
          key: NS,
          locale: NS,
          inject: () => ({ ctx: ctx }),
        },
        TtsCard,
      ))
    }

    exports.inject = ['slots', 'settingsScope', 'locale']
    exports.apply = function apply(ctx) {
      registerSettings(ctx)
      registerSpeaker(ctx)
      ctx.effect(() => listenForVoice(), 'dsh-tts: barge-in on user speech')
      ctx.effect(() => {
        if (typeof window === 'undefined') return () => {}
        const onKey = (e) => {
          if (e.ctrlKey && e.key === 'Escape') { togglePause(); e.preventDefault() }
          else if (e.altKey && (e.code === 'KeyS' || e.key === 's' || e.key === 'S')) { stopPlayback(); e.preventDefault() }
          else if (e.altKey && e.key === 'ArrowRight') { skipCurrent(); e.preventDefault() }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, 'dsh-tts: hotkeys')
      ctx.effect(() => {
        if (typeof window === 'undefined' || typeof EventSource === 'undefined') return () => {}
        let es = null
        let closed = false
        let attempt = 0
        let retryTimer = null
        const onItem = (e) => {
          try {
            const item = JSON.parse(e.data)
            if (!item || !item.id) return
            if (seenIds.has(item.id)) return
            seenIds.add(item.id)
            if (seenIds.size > 500) {
              const first = seenIds.values().next().value
              seenIds.delete(first)
            }
            player.queue.push(item)
            drainQueue()
          } catch { /* ignore malformed SSE frame */ }
        }
        const connect = () => {
          if (closed) return
          try {
            es = new EventSource('/dsh-tts/stream')
            es.addEventListener('open', () => { attempt = 0 })
            es.addEventListener('utterance', onItem)
            es.addEventListener('chime', onItem)
            es.onerror = () => {
              try { es.close() } catch { /* already closed */ }
              if (closed) return
              attempt += 1
              const delay = Math.min(15000, 500 * Math.pow(2, Math.min(attempt, 5)))
              retryTimer = setTimeout(connect, delay)
            }
          } catch { /* EventSource constructor failed — poll remains */ }
        }
        connect()
        return () => {
          closed = true
          if (retryTimer) clearTimeout(retryTimer)
          if (es) { try { es.close() } catch { /* already closed */ } }
        }
      }, 'dsh-tts: SSE audio stream')
      // LOCAL FORK: self-rescheduling poll instead of a fixed 1000 ms interval.
      // The delay is read after every poll, so live sentence streaming can lower
      // it (default 150 ms) as soon as the first /status answer arrives, and the
      // upstream 1000 ms remains the default otherwise.
      ctx.effect(() => {
        let timer = null
        let closed = false
        const tick = async () => {
          if (closed) return
          try { await pollPending() } catch { /* host restarting */ }
          if (closed) return
          const delay = typeof player.pollMs === 'number' && player.pollMs > 0 ? player.pollMs : 1000
          timer = setTimeout(tick, delay)
        }
        timer = setTimeout(tick, 250)
        return () => { closed = true; if (timer) clearTimeout(timer) }
      }, 'dsh-tts: poll pending audio')
    }
    return module.exports
  },
})

// ModelManager UI placeholder - manual install buttons for Kokoro/F5
// Actual implementation would show download progress and status

