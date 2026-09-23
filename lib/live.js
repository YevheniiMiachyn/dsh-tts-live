/**
 * Live sentence-level TTS flush.
 *
 * Upstream dsh-tts speaks settled `assistant/message` events. That is
 * message-level, not stream-level: nothing is synthesized until the model has
 * finished the whole assistant message, so the first audible piece waits for
 * the entire reply (and, with a local model, for the whole thinking pass).
 *
 * This module adds a second, opt-in path: consume the agent loop's live
 * `agent/assistant-stream` chunk frames (real token-level deltas — the loop
 * publishes each `StreamChunk` as it arrives), accumulate *visible* text, cut
 * on sentence boundaries, and hand each finished sentence to the existing
 * synthesis queue (`speakPiece`) while the model keeps generating.
 *
 * Hard constraints (see LIVE-SENTENCE.md):
 *  - reasoning deltas and tool-call JSON are never spoken;
 *  - markdown/code fragments are never cut in half — a fragment that cannot be
 *    judged yet waits for more text instead of being spoken malformed;
 *  - output order is preserved by the existing queue's reserved-slot protocol
 *    (speakPiece reserves the slot synchronously, synthesis settles in place);
 *  - a durable `assistant/message` never replays text the live path spoke.
 *
 * The module is deliberately free of I/O and of dsh-tts internals: everything
 * it needs from the host arrives through `deps`, so the whole decision surface
 * is testable without a model, a network, or audio.
 *
 * @module dsh-tts-local/live
 */

import { protectAbbreviations, restoreAbbreviations, splitSentences } from './text.js'
// LOCAL FORK: passive latency instrumentation seam (no-op without the plugin).
import { markTurn } from './latency.js'

/** Closing punctuation that may follow a sentence end. */
const CLOSERS = '"\'»”’)]}）】」』'
/** Text starting a fenced code block. */
const FENCE = '```'
/** Default live-mode knobs; a profile may override each of them. */
export const LIVE_DEFAULTS = Object.freeze({
  /** Master switch. Off = upstream message-level behaviour, untouched. */
  enabled: false,
  /** Minimum characters for the FIRST piece of an attempt (latency priority). */
  minCharsFirst: 12,
  /** Minimum characters for every later piece (batching priority). */
  minChars: 48,
  /** Hard cap for one piece; 0 means "reuse sentenceChars". */
  maxChars: 0,
  /** Client pending-poll interval while live mode is on, in ms. */
  pollMs: 150,
  /** Flush the visible tail when the model starts a tool call. */
  flushOnToolCall: true,
})

/**
 * Normalize the resolved dsh-tts config into live-mode options.
 * @param cfg - the live plugin config (`live()` result).
 * @returns {object} live options with `maxChars` already resolved.
 */
export function liveOptions(cfg) {
  const c = cfg || {}
  const sentenceChars = Number(c.sentenceChars) > 0 ? Number(c.sentenceChars) : 320
  const maxChars = Number(c.liveMaxChars) > 0 ? Number(c.liveMaxChars) : sentenceChars
  return {
    enabled: c.liveSentenceStreaming === true,
    minCharsFirst: Number.isFinite(Number(c.liveMinCharsFirst)) ? Math.max(0, Number(c.liveMinCharsFirst)) : LIVE_DEFAULTS.minCharsFirst,
    minChars: Number.isFinite(Number(c.liveMinChars)) ? Math.max(0, Number(c.liveMinChars)) : LIVE_DEFAULTS.minChars,
    maxChars,
    pollMs: Number.isFinite(Number(c.livePollMs)) ? Math.max(0, Number(c.livePollMs)) : LIVE_DEFAULTS.pollMs,
    flushOnToolCall: c.liveFlushOnToolCall !== false,
  }
}

function isEnder(ch) {
  return ch === '.' || ch === '!' || ch === '?' || ch === '…' ||
    ch === '\u3002' || ch === '\uFF01' || ch === '\uFF1F'
}

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

function isCloser(ch) {
  return CLOSERS.includes(ch)
}

/**
 * Scan one text window for cut positions that end a sentence.
 *
 * A cut is safe when the character before it is sentence-ending punctuation
 * (optionally followed by closing punctuation such as `."` or `?)`), the
 * character at it is whitespace, the position is outside a fenced code block,
 * and inline backticks are balanced up to that point. The whitespace
 * requirement is what keeps a delta boundary from splitting a token: a trailing
 * `3.` at the end of the buffer is *not* a cut, because the next delta may
 * still continue it (`14`).
 *
 * A bare `period` at the end of the buffer is therefore never cut; the final
 * remainder pass handles an unterminated last sentence.
 *
 * @param text - protected text window (abbreviation dots already masked).
 * @returns {number[]} ascending cut offsets; `text.slice(0, cut)` is a piece.
 */
export function scanSafeCuts(text) {
  const cuts = []
  let fence = false
  let ticks = 0
  let i = 0
  while (i < text.length) {
    if (text.startsWith(FENCE, i)) {
      fence = !fence
      ticks = 0
      i += FENCE.length
      continue
    }
    const ch = text[i]
    if (ch === '`') {
      ticks++
      i++
      continue
    }
    if (!fence && isEnder(ch)) {
      let j = i + 1
      while (j < text.length && isCloser(text[j])) j++
      if (j < text.length && isSpace(text[j]) && ticks % 2 === 0) cuts.push(j)
      i = j
      continue
    }
    i++
  }
  return cuts
}

/**
 * True when `text` opens a fenced block that never closes.
 * @param text - raw text.
 * @returns {boolean} whether the fence count is odd.
 */
export function hasOpenFence(text) {
  let fence = false
  let i = 0
  while (i < text.length) {
    if (text.startsWith(FENCE, i)) {
      fence = !fence
      i += FENCE.length
      continue
    }
    i++
  }
  return fence
}

/**
 * Drop an unterminated fenced block and everything after it.
 *
 * Speaking half a code fence is worse than not speaking it: the tail cannot be
 * scrubbed by `stripForSpeech` (its regex needs the closing fence), so it would
 * be read aloud. An unterminated fence is therefore dropped, not spoken.
 *
 * @param text - raw text.
 * @returns {string} text with any open fence removed from its opening marker on.
 */
export function stripOpenFence(text) {
  if (!hasOpenFence(text)) return text
  let fence = false
  let i = 0
  while (i < text.length) {
    if (text.startsWith(FENCE, i)) {
      if (!fence) return text.slice(0, i)
      fence = false
      i += FENCE.length
      continue
    }
    i++
  }
  return text
}

/**
 * Create the per-step streaming cursor for one assistant generation.
 *
 * The cursor owns an exact raw range, not a re-rendered copy of it: `claimedEnd`
 * is the offset of the first character no piece has claimed yet, and `spokenRaw`
 * is always `raw.slice(0, claimedEnd)`. A range is claimed as soon as the cutter
 * hands it out — spoken, or discarded by policy when it scrubs to nothing — so the
 * settlement reconcile can only ever see genuinely unsaid text. (0.4.16-local.2
 * recorded the pieces joined by a single space instead, which made a paragraph
 * break at a piece boundary look like unspoken text and published the tail twice.)
 *
 * The cursor survives an attempt: a retried step (same turn/step, new attemptId)
 * keeps the claim, drops the abandoned attempt's unspoken tail, and filters the
 * retry's echo of already-claimed text (see appendText).
 *
 * @returns {object} a fresh cursor.
 */
export function createLiveCursor() {
  return {
    /** Everything visible received so far, raw. */
    raw: '',
    /** Offset into `raw` of the first character not yet handed to the cutter. */
    cursor: 0,
    /** Offset into `raw` of the first character not yet claimed by a piece. */
    claimedEnd: 0,
    /** `raw.slice(0, claimedEnd)`: exactly what this step has claimed so far. */
    spokenRaw: '',
    /** Number of pieces handed to synthesis. */
    pieces: 0,
    /** AbortControllers of in-flight synthesis for this step. */
    controllers: new Set(),
    /** Echo filter for a retried attempt: `{ at, remaining }` or null. */
    echo: null,
    /** True once a durable message settled this step. */
    settled: false,
  }
}

/**
 * Record that everything before `end` is owned: either spoken, or discarded by
 * explicit policy (text that scrubs to nothing, an unterminated fence).
 *
 * Claiming is monotonic and happens before synthesis is ever enqueued, so a crash
 * or a cancel between claim and settle loses speech but can never duplicate it.
 *
 * @param cursor - cursor mutated in place.
 * @param end - exclusive raw offset now owned.
 */
function claim(cursor, end) {
  if (end > cursor.claimedEnd) cursor.claimedEnd = end
  cursor.spokenRaw = cursor.raw.slice(0, cursor.claimedEnd)
}

/**
 * Append streamed visible text, filtering the echo of a retried attempt.
 *
 * A retry regenerates from the same prompt, so its opening text repeats what this
 * step already claimed. That echo is dropped instead of buffered: `raw` must stay
 * "claimed text + genuinely new text", otherwise the settlement comparison would
 * see a buffer longer than the durable message and fall back to re-speaking text
 * that has already been heard.
 *
 * @param cursor - cursor mutated in place.
 * @param text - visible text from one `text-delta` chunk.
 */
function appendText(cursor, text) {
  const echo = cursor.echo
  if (echo && echo.remaining > 0) {
    let i = 0
    while (echo.remaining > 0 && i < text.length && text[i] === cursor.raw[echo.at]) {
      echo.at++
      echo.remaining--
      i++
    }
    // Exhausted echo, or the retry diverged from the abandoned attempt: either way
    // the rest of this chunk is new text.
    if (echo.remaining === 0 || i < text.length) cursor.echo = null
    text = text.slice(i)
  }
  if (text) cursor.raw += text
}

/**
 * Cut every piece that is ready right now.
 *
 * Pass 1 emits complete sentences, honouring the minimum-fragment policy, and
 * force-cuts a single over-long sentence at a word boundary so a paragraph
 * without punctuation can never stall the stream. Pass 2 runs only at
 * settlement and emits the remaining tail once (minus an unterminated fence).
 *
 * Every range this function walks past is claimed, whether or not it ends up
 * speakable, so the claim is what "this step is done with that text" means. The
 * tool-call boundary flush and the settlement remainder therefore split the step's
 * text into disjoint, exactly-once ranges.
 *
 * @param cursor - cursor mutated in place.
 * @param opts - `{ minCharsFirst, minChars, maxChars, final }`.
 * @returns {string[]} raw pieces to speak, in output order.
 */
export function drainPieces(cursor, opts) {
  const out = []
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : 320
  const final = opts.final === true

  for (;;) {
    const rest = cursor.raw.slice(cursor.cursor)
    if (!rest) break
    const window = rest.slice(0, maxChars * 2 + 64)
    // protectAbbreviations maps every '.' to a same-width placeholder, so
    // offsets stay valid across the protected and raw representations.
    const prot = protectAbbreviations(window)
    const cuts = scanSafeCuts(prot)
    const min = cursor.pieces === 0 ? Number(opts.minCharsFirst) || 0 : Number(opts.minChars) || 0

    let cut = -1
    for (const c of cuts) {
      if (c >= min) { cut = c; break }
    }
    if (cut < 0) {
      // A single sentence longer than the cap must still make progress.
      if (!final && window.length >= maxChars) {
        let cutAt = window.lastIndexOf(' ', maxChars)
        if (cutAt < min) cutAt = maxChars
        cut = cutAt
      } else {
        break
      }
    }

    const piece = restoreAbbreviations(prot.slice(0, cut)).trim()
    cursor.cursor += cut
    // Claimed before anything is enqueued: the range is now owned by this step,
    // including the case where it scrubs to nothing and is dropped by policy.
    claim(cursor, cursor.cursor)
    if (!piece) continue
    cursor.pieces++
    out.push(piece)
  }

  if (final) {
    const tailStart = cursor.cursor
    const tail = cursor.raw.slice(tailStart)
    cursor.cursor = cursor.raw.length
    if (tail) {
      const safe = stripOpenFence(tail)
      const piece = restoreAbbreviations(protectAbbreviations(safe)).trim()
      // Claim exactly the examined tail, without trailing whitespace. An open fence
      // that was stripped is still claimed: it is dropped by policy, and claiming it
      // is what stops settlement from reading it aloud afterwards.
      let end = tailStart + safe.length
      while (end > tailStart && isSpace(cursor.raw[end - 1])) end--
      claim(cursor, end)
      if (piece) {
        cursor.pieces++
        out.push(piece)
      }
    }
  }

  return out
}

/**
 * Length of the longest common prefix of two strings.
 * @param a - one string.
 * @param b - the other.
 * @returns {number} shared leading character count.
 */
export function commonPrefixLength(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

/**
 * Collapse whitespace runs and trim, for alignment only.
 * @param text - any text.
 * @returns {string} the whitespace-normalized form.
 */
function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

/**
 * Offset in `text` just past the first `n` characters of its normalized form.
 *
 * Lets an alignment found on whitespace-normalized text be translated back into a
 * cut position in the original string: `text.slice(offset)` starts at the first
 * character the normalized prefix did not cover.
 *
 * @param text - the original text.
 * @param n - number of normalized characters consumed.
 * @returns {number} index into `text`.
 */
export function normalizedOffset(text, n) {
  const s = String(text || '')
  if (n <= 0) return 0
  let i = 0
  let seen = 0
  let inSpace = true // normalization trims leading whitespace
  while (i < s.length && seen < n) {
    const space = isSpace(s[i])
    if (!space || !inSpace) seen++
    inSpace = space
    i++
  }
  return i
}

/**
 * Decide what a settled assistant message still owes the speaker.
 *
 * The live path may have claimed a prefix of the message already. When the durable
 * text starts with exactly what was claimed, the remainder is exact. When it does
 * not, the two are aligned with whitespace runs collapsed first: the live path
 * claims whole pieces, so a paragraph break that lands on a piece boundary is
 * recorded as a single space, and treating that rendering difference as unspoken
 * text is what used to publish a tail twice. Only a difference that survives
 * normalization is a real divergence; even then the shared prefix is used rather
 * than replaying the whole message — the durable rule is "never replay what was
 * already claimed".
 *
 * @param spokenRaw - raw text the live path already claimed.
 * @param durableText - visible text of the settled `assistant/message`.
 * @returns {{mode: 'fallback'|'remainder', remainder: string, overlap: number}}
 *   `fallback` means the caller speaks the whole message through the upstream
 *   path; `remainder` means it speaks only `remainder`.
 */
export function reconcileRemainder(spokenRaw, durableText) {
  const spoken = String(spokenRaw || '')
  const durable = String(durableText || '')
  if (!spoken) return { mode: 'fallback', remainder: durable, overlap: 0 }
  if (durable.startsWith(spoken)) {
    return { mode: 'remainder', remainder: durable.slice(spoken.length).trim(), overlap: spoken.length }
  }
  const spokenN = normalizeWhitespace(spoken)
  const durableN = normalizeWhitespace(durable)
  if (spokenN && durableN.startsWith(spokenN)) {
    const at = normalizedOffset(durable, spokenN.length)
    return { mode: 'remainder', remainder: durable.slice(at).trim(), overlap: spoken.length }
  }
  const lcp = commonPrefixLength(spoken, durable)
  const lcpN = commonPrefixLength(spokenN, durableN)
  if (lcpN > lcp) {
    const at = normalizedOffset(durable, lcpN)
    return { mode: 'remainder', remainder: durable.slice(at).trim(), overlap: lcpN }
  }
  return { mode: lcp > 0 ? 'remainder' : 'fallback', remainder: lcp > 0 ? durable.slice(lcp).trim() : durable, overlap: lcp }
}

/**
 * Build the live-flush engine.
 *
 * @param deps - host bindings, kept explicit so tests can drive the engine
 *   without a running harness:
 *   - `live()` → resolved dsh-tts config;
 *   - `cleanText(raw, cfg)` → upstream scrub/narration/pronunciation pipeline;
 *   - `speakPiece(sid, text, cfg, kind, signal)` → upstream queue entry;
 *   - `dropPiece(id)` / `dropPendingForSession(sid)` → queue surgery for cancel;
 *   - `log(level, message)` → diagnostic sink.
 * @returns {object} the engine.
 */
export function createLiveEngine(deps) {
  const { live, cleanText, speakPiece, dropPendingForSession, log } = deps
  // step key -> cursor (survives retries of the same step)
  const steps = new Map()
  // attemptId -> step key
  const attempts = new Map()

  const stepKeyOf = (sid, turn, step) => `${sid}|${turn}|${step}`

  function fail(message) {
    try { log('warn', `live-sentence: ${message}`) } catch { /* logging must never break speech */ }
  }

  function speak(sid, cursor, rawPiece, cfg, role) {
    const text = cleanText(rawPiece, cfg)
    if (!text) return
    // LOCAL FORK: latency instrumentation. L3 is "the first complete flushable
    // sentence existed and was handed to synthesis" - measured here because this
    // is the instant after the cutter accepted a sentence and before any
    // synthesis work starts. The trace store keeps the first write per turn, so
    // a later piece, a later step, or a retry cannot move it.
    if (cursor.l3 !== true) {
      cursor.l3 = true
      markTurn(sid, cursor.turn, 'L3', { step: cursor.step })
    }
    const pieces = splitSentences(text, cfg.sentenceChars)
    for (const piece of pieces) {
      const controller = new AbortController()
      cursor.controllers.add(controller)
      // speakPiece reserves the queue slot synchronously, so the order of these
      // calls is the order of playback even when synthesis finishes out of order.
      // LOCAL FORK (0.4.16-local.2): the cursor knows the exact turn/step this
      // sentence came from; pass it through so the queue item is attributable.
      speakPiece(sid, piece, cfg, role, controller.signal, { turn: cursor.turn, step: cursor.step })
    }
  }

  /** Consume one live frame. */
  function onFrame(payload) {
    const cfg = live()
    const opts = liveOptions(cfg)
    if (!opts.enabled || !cfg.speakReplies) return
    const frame = payload && payload.frame
    const agent = payload && payload.agent
    if (!frame || !agent) return
    const sid = agent.session && agent.session.id
    if (!sid) return

    if (frame.type === 'start') {
      const key = stepKeyOf(sid, frame.turn, frame.step)
      let cursor = steps.get(key)
      if (!cursor) {
        cursor = createLiveCursor()
        cursor.sid = sid
        cursor.turn = frame.turn
        cursor.step = frame.step
        steps.set(key, cursor)
      } else {
        // A retry (or a new attempt) of a step that already streamed: drop the
        // previous attempt's unclaimed tail — the new attempt regenerates it — and
        // arm the echo filter so the text this step already claimed is not spoken
        // a second time. Nothing is claimed for the dropped tail, so the retry owns
        // it and speaks it once.
        cursor.raw = cursor.raw.slice(0, cursor.claimedEnd)
        cursor.cursor = cursor.claimedEnd
        if (cursor.claimedEnd > 0) cursor.echo = { at: 0, remaining: cursor.claimedEnd }
        cursor.settled = false
      }
      attempts.set(frame.attemptId, key)
      return
    }

    if (frame.type === 'end') {
      const key = attempts.get(frame.attemptId)
      if (!key) return
      attempts.delete(frame.attemptId)
      const cursor = steps.get(key)
      if (!cursor) return
      if (frame.outcome && frame.outcome.kind === 'abandoned') {
        // Cancelled or failed attempt: stop in-flight synthesis for this step and
        // drop its reserved queue slots so nothing speaks after the cancel.
        abortCursor(cursor, sid)
      }
      return
    }

    if (frame.type !== 'chunk') return
    const key = attempts.get(frame.attemptId)
    if (!key) return
    const cursor = steps.get(key)
    if (!cursor) return
    // Once the durable message for this step settled, the step is over: a late frame
    // belongs to nothing and must not speak into the next step.
    if (cursor.settled) return
    const chunk = frame.chunk
    if (!chunk) return

    if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
      appendText(cursor, chunk.text)
      for (const piece of drainPieces(cursor, { ...opts, final: false })) speak(sid, cursor, piece, cfg, 'reply')
      return
    }

    if (opts.flushOnToolCall && (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call'))) {
      // The visible-text phase of this attempt is over; flush what is complete.
      for (const piece of drainPieces(cursor, { ...opts, final: true })) speak(sid, cursor, piece, cfg, 'reply')
      return
    }

    if (chunk.type === 'finish') {
      // Stream end without an end frame yet: flush the tail now rather than wait.
      for (const piece of drainPieces(cursor, { ...opts, final: true })) speak(sid, cursor, piece, cfg, 'reply')
    }
  }

  function abortControllers(cursor) {
    for (const controller of cursor.controllers) {
      try { controller.abort(new Error('live-sentence: turn cancelled')) } catch { /* already aborted */ }
    }
    cursor.controllers.clear()
  }

  function abortCursor(cursor, sid) {
    abortControllers(cursor)
    if (typeof dropPendingForSession === 'function') dropPendingForSession(sid)
  }

  /**
   * Reconcile a settled assistant message against what the live path claimed.
   *
   * The claim record is kept (and marked settled) rather than deleted: a step
   * settles once, and if a settlement ever arrives twice, the live path already owns
   * the step's text — falling back to the durable path would speak the whole message
   * again. The record is released with the rest of the session at turn end.
   *
   * @param args - `{ sid, turn, step, text }`.
   * @returns {{mode: 'fallback'|'remainder', remainder: string}}
   */
  function onSettledMessage(args) {
    const key = stepKeyOf(args.sid, args.turn, args.step)
    const cursor = steps.get(key)
    if (!cursor) return { mode: 'fallback', remainder: args.text || '' }
    if (cursor.settled) return { mode: 'remainder', remainder: '' }
    cursor.settled = true
    if (cursor.pieces === 0) return { mode: 'fallback', remainder: args.text || '' }
    const result = reconcileRemainder(cursor.spokenRaw, args.text)
    if (result.mode === 'remainder' && result.overlap < cursor.spokenRaw.length) {
      fail(`durable text diverged from the live stream at ${result.overlap}/${cursor.spokenRaw.length} chars; speaking the unsaid tail only`)
    }
    return { mode: result.mode, remainder: result.remainder }
  }

  /** Forget one step (durable settlement consumed, or the step never streamed). */
  function releaseStep(sid, turn, step) {
    steps.delete(stepKeyOf(sid, turn, step))
  }

  /** Drop every step of one session (turn boundary, cancel, disposal). */
  function releaseSession(sid) {
    for (const [key, cursor] of steps) {
      if (cursor.sid === sid) steps.delete(key)
    }
    for (const [attemptId, key] of attempts) {
      if (key.startsWith(`${sid}|`)) attempts.delete(attemptId)
    }
  }

  /** Hard stop: abort everything in flight, drop queued slots (barge-in). */
  function abortAll(sid) {
    // One queue drop for the whole call: dropping per cursor would repeat it.
    for (const [, cursor] of steps) {
      if (sid && cursor.sid !== sid) continue
      abortControllers(cursor)
    }
    if (typeof dropPendingForSession === 'function') dropPendingForSession(sid)
  }

  return {
    onFrame,
    onSettledMessage,
    releaseStep,
    releaseSession,
    abortAll,
    /** Test/diagnostic introspection. */
    _state: { steps, attempts },
  }
}
