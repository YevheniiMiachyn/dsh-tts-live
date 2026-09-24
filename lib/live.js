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

/** Closing punctuation that may follow a sentence end. */
const CLOSERS = '"\'»”’)]}）】」』'
/** Text starting a fenced code block. */
const FENCE = '```'
/**
 * Punctuation that ends a CLAUSE rather than a sentence: a point the voice is
 * already going to pause at, so starting the first piece there does not invent a
 * break the ear would call wrong.
 */
const CLAUSE_PUNCT = ';:,—–'
/**
 * Opening context that stops a comma from being a clause boundary. `1,234`,
 * `1, 2, 3` and `2,4-dinitrophenol` are not places to start speaking.
 */
const GROUPING_OPENERS = '0123456789([{'
/** List/markdown punctuation: a comma that closes an enumerated run is structural. */
const STRUCTURAL_PUNCT = '*_`|#>-'
/**
 * LOCAL FORK: first-piece fallback thresholds, in characters.
 *
 * The first piece has one job — start audio — but the cutter could previously
 * only cut at a sentence terminator, so `minCharsFirst: 12` bought nothing on a
 * reply that opens with a 200-character sentence: 12 characters passed almost
 * immediately and then the cutter waited another ~9 s of generation for the
 * full stop. These two thresholds are what let the FIRST piece start at a
 * smaller, still-natural boundary:
 *
 *  - `firstClauseChars` (48): once this much text is buffered, a clause
 *    boundary is good enough to start speaking. Deliberately equal to
 *    `LIVE_DEFAULTS.minChars`, because that is already the project's own
 *    "a piece shorter than this is not worth starting" line, so no new knob and
 *    no new semantic is introduced.
 *  - `firstWordChars` (72): if even a clause boundary has not arrived by now,
 *    cut at a word boundary. A safety valve for openings with no punctuation
 *    inside the first sentence; still whole words, and still longer than the
 *    clause threshold so it can never pre-empt a cleaner break.
 *
 * Not config: an independent number here would only make the two live minimums
 * mean something other than what they are named, and the measured behaviour
 * across 484 real reply openings puts the first sentence boundary at p50 = 63
 * characters — the fallbacks exist for the tail, not as the normal path.
 */
const firstClauseChars = () => LIVE_DEFAULTS.minChars
const firstWordChars = 72
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

/** True when `ch` is punctuation that closes a clause. */
function isClausePunct(ch) {
  return CLAUSE_PUNCT.includes(ch)
}

/**
 * True when the clause punctuation at `i` may end a piece.
 *
 * A cut is only a cut if the speaker would already be pausing: the next
 * character must be whitespace. That single requirement rejects a decimal
 * (`3,14`), a thousands separator (`1,234`) and a hyphenated compound
 * (`state-of-the-art`) without any of them needing their own rule.
 *
 * @param text - protected text window.
 * @param i - offset of the punctuation.
 * @returns {boolean} whether the position ends a clause.
 */
function isClauseBoundary(text, i) {
  if (text[i + 1] !== ' ') return false
  // A comma directly after a digit is grouping or an enumeration unless the model
  // wrote a space after it, which the check above already accepted (`1, 2, 3` is
  // a legitimate pause). `1,234` is the case with no space, already rejected.
  // Opening brackets and markdown punctuation mean the comma is structural.
  let j = i - 1
  while (j >= 0 && isSpace(text[j])) j--
  const before = j >= 0 ? text[j] : ''
  if (before && STRUCTURAL_PUNCT.includes(before)) return false
  if (before && GROUPING_OPENERS.includes(before) && /\d/.test(text[i + 2] || '')) return false
  return true
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
 * The same walk as `scanSafeCuts`, returning both boundary classes at once.
 *
 * LOCAL FORK: the first piece is allowed to start at a clause boundary, so the
 * cutter needs to know where every candidate is *and what kind it is* — a
 * sentence end outranks a clause, and a clause outranks a bare word break. Both
 * lists come from one pass so the two scanners can never disagree about fence
 * state or backtick balance, and every offset is inside the window both
 * functions were handed.
 *
 * Fenced code and unbalanced inline backticks suppress cuts in both classes on
 * purpose: inside code a comma is syntax, not prosody.
 *
 * @param text - protected text window (abbreviation dots already masked).
 * @returns {{sentences: number[], clauses: number[]}} ascending cut offsets.
 */
export function scanBoundaries(text) {
  const sentences = []
  const clauses = []
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
    if (fence) {
      i++
      continue
    }
    if (isEnder(ch)) {
      let j = i + 1
      while (j < text.length && isCloser(text[j])) j++
      if (j < text.length && isSpace(text[j]) && ticks % 2 === 0) sentences.push(j)
      i = j
      continue
    }
    if (isClausePunct(ch) && ticks % 2 === 0 && isClauseBoundary(text, i)) {
      // The NEXT word starting the following piece is what is being cut around;
      // the boundary itself is the punctuation, exactly as with a sentence end.
      clauses.push(i + 1)
    }
    i++
  }
  return { sentences, clauses }
}

/**
 * Last word boundary at or before `at`.
 *
 * The cut is the space itself, so the piece is `text.slice(0, cut)` and the next
 * piece starts at the following word — the same convention as a sentence cut,
 * which is what keeps every character claimed exactly once.
 *
 * @param text - protected text window.
 * @param at - the offset the piece may not pass.
 * @returns {number} offset of a boundary, or -1 when the window has no space yet.
 */
function wordBoundaryBefore(text, at) {
  for (let i = Math.min(at, text.length - 1); i > 0; i--) {
    if (isSpace(text[i]) && !isSpace(text[i - 1])) return i
  }
  return -1
}

/**
 * Choose the cut offset for the piece being built right now.
 *
 * The first piece of a step has its own policy, because it is the only piece
 * whose length is paid for in time-to-first-audio rather than in batching:
 *
 *  1. a sentence end at or beyond `minFirst` — unchanged, still preferred;
 *  2. else a clause end at or beyond `minClause`, once it arrives;
 *  3. else a word boundary at or before `minWord` — a safety valve, so an
 *     opening with no punctuation inside its first sentence cannot hold audio
 *     for the whole sentence.
 *
 * Every later piece keeps the original sentence-only policy. Cutting a later
 * piece mid-sentence buys nothing (playback already overlaps generation) and
 * costs prosody, so the adaptive rule is deliberately first-piece-only.
 *
 * Boundaries 1 and 2 must be *at or beyond* their minimum, because the cut only
 * exists where the model put the punctuation — a comma typed at 30 characters is
 * not a reason to speak 30 characters, so the piece keeps growing until the
 * minimum is met. The word fallback is the other way round: it may land *at or
 * before* its threshold, because the whole point is to stop the piece from
 * growing — it takes the last whole word that still fits.
 *
 * @param cursor - cursor being drained.
 * @param window - protected text window, at least `maxChars` long.
 * @param opts - `{ minCharsFirst, minChars, maxChars }`.
 * @returns {number} cut offset, or -1 when no piece is ready.
 */
function chooseCut(cursor, window, opts) {
  const first = cursor.pieces === 0
  const cuts = scanBoundaries(window)

  if (!first) {
    const min = Number(opts.minChars) || 0
    for (const c of cuts.sentences) if (c >= min) return c
    return -1
  }

  const minFirst = Number(opts.minCharsFirst) || 0
  for (const c of cuts.sentences) if (c >= minFirst) return c

  const minClause = Math.max(minFirst, firstClauseChars())
  for (const c of cuts.clauses) if (c >= minClause) return c

  const minWord = Math.max(minClause, firstWordChars)
  if (window.length > minWord) {
    const w = wordBoundaryBefore(window, minWord)
    // The floor is `minFirst`, not `minWord`: a long word can push the last
    // boundary under the fallback, and a piece of `minFirst`…`minWord`
    // characters is still a piece that starts audio long before the sentence
    // terminator. Below `minFirst` there is nothing worth speaking, so the
    // piece keeps growing.
    if (w >= minFirst) return w
  }
  return -1
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
 * Pass 1 emits a piece at each boundary the policy accepts: the FIRST piece of a
 * step may start at a clause or word boundary (see `chooseCut`) so audio is not
 * held for a long opening sentence, and every later piece still waits for a
 * sentence end. A single over-long sentence is additionally force-cut at a word
 * boundary so a paragraph without punctuation can never stall the stream. Pass 2
 * runs only at settlement and emits the remaining tail once (minus an
 * unterminated fence).
 *
 * The cut decision itself lives in `chooseCut`; this function only owns the
 * claim bookkeeping, so the exactly-once property below holds for every class of
 * boundary identically.
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
    const min = cursor.pieces === 0 ? Number(opts.minCharsFirst) || 0 : Number(opts.minChars) || 0

    let cut = chooseCut(cursor, prot, opts)
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
  // LOCAL FORK (0.4.16-local.4): `${sid}|${turn}` of every turn a barge-in has
  // silenced, oldest first.
  //
  // A barge-in can only abort what has already been handed to synthesis. The model
  // keeps generating, so without this record the remaining sentences of the same
  // reply are flushed and spoken one by one a moment later — the agent talking over
  // the very user it just fell silent for. Mutating the cursor is not enough: the
  // cursor's whole purpose is to keep claiming text, and `speak` is the only place
  // where claiming turns into audible output.
  const mutedTurns = new Map()
  // sid -> turn currently streaming. A barge-in can land before the first sentence
  // was ever flushed (or between two steps of a multi-step turn), when there is no
  // cursor to mute yet but the turn is about to speak.
  const currentTurn = new Map()
  // One live session needs one entry; the cap only bounds a long-lived process
  // accumulating mutes for turns whose session never streams again.
  const MUTE_CAP = 64

  const stepKeyOf = (sid, turn, step) => `${sid}|${turn}|${step}`
  const turnKeyOf = (sid, turn) => `${sid}|${turn}`

  function fail(message) {
    try { log('warn', `live-sentence: ${message}`) } catch { /* logging must never break speech */ }
  }

  /** True while one turn a barge-in silenced is still being claimed. */
  function isMutedTurn(sid, turn) {
    if (turn === undefined || turn === null) return false
    return mutedTurns.has(turnKeyOf(sid, turn))
  }

  /**
   * Silence the rest of one turn. Nothing of it may speak again.
   *
   * Deliberately not pruned by turn order. A settlement can arrive after the next
   * turn has already started streaming — the ordering a fast follow-up produces — and
   * clearing the mute there would read the silenced remainder aloud over the new
   * reply. Turn numbers only ever increase for a session, so a stale entry can never
   * silence a later turn; the map is bounded by MUTE_CAP instead, and the settlement
   * of the muted turn consumes its entry.
   */
  function muteTurn(sid, turn) {
    if (!sid || turn === undefined || turn === null) return
    const key = turnKeyOf(sid, turn)
    if (mutedTurns.has(key)) return
    mutedTurns.set(key, sid)
    while (mutedTurns.size > MUTE_CAP) mutedTurns.delete(mutedTurns.keys().next().value)
  }

  function speak(sid, cursor, rawPiece, cfg, role) {
    // A muted turn claims its text but says none of it. The claim itself already
    // happened in drainPieces, before this call: that is what stops the settlement
    // reconcile from reading the silenced remainder aloud afterwards.
    if (isMutedTurn(sid, cursor.turn)) return
    const text = cleanText(rawPiece, cfg)
    if (!text) return
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
      // The turn a barge-in would silence, recorded before any text exists for it.
      currentTurn.set(sid, frame.turn)
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
    // LOCAL FORK (0.4.16-local.4): a silenced turn owes the durable path nothing.
    // This check must come first. The cursor may hold zero pieces when the barge-in
    // beat the first sentence, and the `pieces === 0` fallback below would then hand
    // the *entire* message back to be spoken — the loudest possible version of the
    // talk-over a barge-in exists to prevent.
    if (isMutedTurn(args.sid, args.turn)) {
      const muted = steps.get(stepKeyOf(args.sid, args.turn, args.step))
      // Keep the claim record and mark it settled, exactly as a normal settlement
      // does: a duplicate settlement event must not fall through to the durable path.
      if (muted) muted.settled = true
      // The muted turn has now been reconciled as far as it ever will be, so the
      // entry that silenced it has done its job.
      mutedTurns.delete(turnKeyOf(args.sid, args.turn))
      return { mode: 'remainder', remainder: '' }
    }
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
    // Nothing is streaming for this session any more, so a barge-in can no longer
    // be aimed at "the turn in progress". The mutes themselves are deliberately
    // kept: a settlement that lands after the boundary is still silenced, and the
    // muted turn consumes its own entry when it settles.
    currentTurn.delete(sid)
  }

  /**
   * Hard stop: abort everything in flight, drop queued slots, and silence the rest
   * of the turn (barge-in).
   *
   * Aborting in flight and dropping the queue is what stops speech *now*. Muting the
   * turn is what stops it *resuming*: the agent loop keeps producing frames for the
   * same turn after this call, and each completed sentence would otherwise be
   * synthesized and spoken. `sid` is optional — without it every session is
   * silenced, which is what the browser's barge-in POST asks for.
   */
  function abortAll(sid) {
    // One queue drop for the whole call: dropping per cursor would repeat it.
    for (const [, cursor] of steps) {
      if (sid && cursor.sid !== sid) continue
      abortControllers(cursor)
      muteTurn(cursor.sid, cursor.turn)
    }
    // Covers the barge-in that beat the first flushed sentence, and the one that
    // lands between two steps of a multi-step turn.
    for (const [owner, turn] of currentTurn) {
      if (sid && owner !== sid) continue
      muteTurn(owner, turn)
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
    _state: { steps, attempts, mutedTurns, currentTurn },
  }
}
