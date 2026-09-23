/**
 * LOCAL FORK: passive latency-instrumentation seam.
 *
 * The `dsh-latency` companion plugin publishes a narrow global bus
 * (`globalThis.__AKENO_LATENCY__`). This module is the *only* place the fork
 * talks to it, so the instrumentation surface in the TTS code is one import
 * plus one call site per mark.
 *
 * Every function degrades to a no-op when the bus is absent: with the plugin
 * not installed, the fork behaves byte-for-byte as it did before, and the extra
 * work is one property read on `globalThis` per call.
 *
 * Nothing here changes timing, ordering, text, audio, or configuration - it
 * only records instants.
 *
 * @module dsh-tts-local/latency
 */

/**
 * The live bus, or null when the instrumentation plugin is not mounted.
 * @returns {object|null} the bus.
 */
function bus() {
  const candidate = globalThis.__AKENO_LATENCY__
  return candidate && candidate.enabled === true ? candidate : null
}

/**
 * Trace id owning one agent turn, or null when this turn is untraced.
 * @param {string} sessionId - session id.
 * @param {number} turn - turn number.
 * @returns {string|null} the trace id.
 */
export function traceIdFor(sessionId, turn) {
  const b = bus()
  if (!b) return null
  try { return b.traceForTurn(sessionId, turn) } catch { return null }
}

/**
 * Allocate the next 1-based piece number for a turn.
 * @param {string} sessionId - session id.
 * @param {number} turn - turn number.
 * @returns {number|null} the piece number, or null when untraced.
 */
export function nextPieceNo(sessionId, turn) {
  const b = bus()
  if (!b) return null
  try { return b.nextPieceNo(sessionId, turn) } catch { return null }
}

/**
 * Mark one instant on a turn (L3 = the first complete flushable sentence).
 * @param {string} sessionId - session id.
 * @param {number} turn - turn number.
 * @param {string} key - mark name.
 * @param {object} [extra] - extra facts.
 * @returns {boolean} whether the mark landed.
 */
export function markTurn(sessionId, turn, key, extra) {
  const b = bus()
  if (!b) return false
  try { return b.markTurn(sessionId, turn, key, extra) === true } catch { return false }
}

/**
 * Mark one instant on a synthesis piece (T0 reserve, T1 request, T2 audio,
 * T3 available to the browser).
 * @param {string|null} traceId - owning trace.
 * @param {number|null} pieceNo - 1-based piece number.
 * @param {string} key - mark name.
 * @param {object} [extra] - piece facts (`id`, `chars`, `provider`, `error`).
 * @returns {boolean} whether the mark landed.
 */
export function markPiece(traceId, pieceNo, key, extra) {
  if (!traceId || !pieceNo) return false
  const b = bus()
  if (!b) return false
  try { return b.markPiece(traceId, pieceNo, key, extra) === true } catch { return false }
}

/** Whether the instrumentation is mounted at all (used to skip extra work). */
export function enabled() {
  return bus() !== null
}
