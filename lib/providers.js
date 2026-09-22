import { PROVIDER_KEYS, OPENAI_COMPATIBLE, DEFAULT_MODELS, DEFAULT_VOICES } from "./providers/constants.js"
import { makeCloudProviders } from "./providers/cloud.js"
import { makeLocalProviders } from "./providers/local.js"

export { PROVIDER_KEYS, OPENAI_COMPATIBLE, DEFAULT_MODELS, DEFAULT_VOICES }

export function makeProviders(deps, req) {
  const { cfg } = deps
  const { signal: parentSignal } = req
  // LOCAL FORK (production patch #2): upstream default is 10000 ms; the local Qwen
  // TTS server needs up to ~120 s on a cold model load, so a 10 s cap aborted a
  // synthesis that would have succeeded.
  const cloudTimeoutMs = Number(cfg.cloudTimeoutMs) > 0 ? Number(cfg.cloudTimeoutMs) : 120000

  function withCloudTimeout() {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error())
    }, cloudTimeoutMs)
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

  const cloud = makeCloudProviders(deps, req, withCloudTimeout)
  const local = makeLocalProviders(deps, req)

  return Object.assign({}, cloud, local)
}
