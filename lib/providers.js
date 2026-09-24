import { PROVIDER_KEYS, OPENAI_COMPATIBLE, DEFAULT_MODELS, DEFAULT_VOICES } from "./providers/constants.js"
import { makeCloudProviders, makePcmStreamers } from "./providers/cloud.js"
import { makeLocalProviders } from "./providers/local.js"

export { PROVIDER_KEYS, OPENAI_COMPATIBLE, DEFAULT_MODELS, DEFAULT_VOICES }

/**
 * LOCAL FORK (production patch #2): upstream default is 10000 ms; the local Qwen
 * TTS server needs up to ~120 s on a cold model load, so a 10 s cap aborted a
 * synthesis that would have succeeded.
 */
export function cloudTimeoutMs(cfg) {
  return Number(cfg.cloudTimeoutMs) > 0 ? Number(cfg.cloudTimeoutMs) : 120000
}

/**
 * Per-request abort wrapper: a timeout plus the parent (turn) signal.
 *
 * Factored out of makeProviders so the PCM streaming path uses the identical
 * cancellation semantics rather than a second, subtly different copy of them.
 */
export function makeTimeoutWrapper(cfg, parentSignal) {
  const limit = cloudTimeoutMs(cfg)
  return function withCloudTimeout() {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new Error())
    }, limit)
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort(parentSignal.reason)
      // LOCAL FORK (production patch #3): upstream referenced a bare `abort`
      // identifier here, which threw a ReferenceError — so the listener was never
      // attached and parent cancellation did not propagate to in-flight synthesis.
      else parentSignal.addEventListener('abort', () => controller.abort(parentSignal.reason), { once: true })
    }
    return {
      signal: controller.signal,
      cleanup: () => clearTimeout(timer),
    }
  }
}

export function makeProviders(deps, req) {
  const { cfg } = deps
  const withCloudTimeout = makeTimeoutWrapper(cfg, req.signal)
  const cloud = makeCloudProviders(deps, req, withCloudTimeout)
  const local = makeLocalProviders(deps, req)

  return Object.assign({}, cloud, local)
}

/**
 * LOCAL FORK (PCM stage): the progressive twins of the OpenAI-compatible
 * providers, for the streaming transport.
 *
 * Returned separately rather than merged into the map makeProviders builds, so
 * nothing that walks the provider map — the fallback chain, the settings UI, the
 * parity check — can mistake a streaming entry for a buffered one.
 */
export function makePcmStreamersFor(deps, req) {
  const withCloudTimeout = makeTimeoutWrapper(deps.cfg, req.signal)
  return makePcmStreamers(deps, req, withCloudTimeout)
}
