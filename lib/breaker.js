// Soft circuit breaker for provider fallback (runtime state only).
// Tracks consecutive failures per chain id and skips a provider during cooldown.

const DEFAULT_THRESHOLD = 3
const DEFAULT_COOLDOWN_MS = 60000

// LOCAL FORK (0.4.16-local.7): the abort reason our own synthesis timeout uses.
// Deliberately not a cancellation: a provider that accepts a request and then
// never answers IS a provider failure and must still be counted.
export const TIMEOUT_REASON = 'tts: provider timeout'

const CANCEL_PATTERN = /abort|cancel/i

/**
 * Whether an error means "the provider failed" or "we cancelled our own work".
 *
 * Cancelling is not failing. The live engine aborts in-flight synthesis when a
 * turn is superseded — barge-in, silent mode, a retried attempt — and the
 * caller's signal aborts it when the agent turn itself is cancelled. Counting
 * those as provider failures opened the circuit after three of them and muted
 * the stack for a cooldown immediately after the user interrupted it, while the
 * TTS server was healthy the whole time.
 *
 * A real provider error and our own timeout both stay failures; `TIMEOUT_REASON`
 * is worded so it cannot match {@link CANCEL_PATTERN}.
 */
export function isCancellation(error) {
  if (error === undefined || error === null || error === false) return false
  if (typeof error === 'string') return CANCEL_PATTERN.test(error)
  const name = error.name || (error.reason && error.reason.name) || ''
  if (name === 'AbortError') return true
  const message = String(error.message || (error.reason && error.reason.message) || error || '')
  return CANCEL_PATTERN.test(message)
}

export function createProviderBreaker(options = {}) {
  const threshold = options.threshold || DEFAULT_THRESHOLD
  const cooldownMs = options.cooldownMs || DEFAULT_COOLDOWN_MS
  const now = options.now || (() => Date.now())
  const state = new Map()

  function slot(id) {
    let s = state.get(id)
    if (!s) {
      s = { failCount: 0, okCount: 0, lastError: '', lastFailAt: 0, openUntil: 0 }
      state.set(id, s)
    }
    return s
  }

  function isOpen(id) {
    const s = slot(id)
    return s.openUntil > now()
  }

  function recordFailure(id, error) {
    const s = slot(id)
    s.failCount += 1
    s.lastError = String((error && error.message) || error || 'failure').slice(0, 240)
    s.lastFailAt = now()
    if (s.failCount >= threshold) {
      s.openUntil = now() + cooldownMs
    }
  }

  function recordSuccess(id) {
    const s = slot(id)
    s.okCount += 1
    s.failCount = 0
    s.openUntil = 0
  }

  function snapshot(ids) {
    const list = Array.isArray(ids) ? ids : [...state.keys()]
    return list.map((id) => {
      const s = slot(id)
      return {
        id,
        failCount: s.failCount,
        okCount: s.okCount,
        lastError: s.lastError,
        open: isOpen(id),
        openUntil: s.openUntil || 0,
      }
    })
  }

  function reset() {
    state.clear()
  }

  return { isOpen, recordFailure, recordSuccess, snapshot, reset, threshold, cooldownMs }
}