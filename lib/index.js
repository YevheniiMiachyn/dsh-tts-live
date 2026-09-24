import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { runChain } from './chain.js'
import { makeProviders, makePcmStreamersFor, PROVIDER_KEYS, DEFAULT_MODELS, DEFAULT_VOICES } from './providers.js'
// LOCAL FORK (0.4.16-local.8): the sampler settings participate in the cache key.
import { samplingSignature } from './providers/cloud.js'
import { applyNarrationFilters, applyPronunciation, assistantText, detectLang, speechPhrases, splitSentences, stripForSpeech } from './text.js'
import { createLiveEngine, liveOptions } from './live.js'
import { cacheKey, createSpeechCache } from './cache.js'
import os from 'node:os'
import path from 'node:path'
import { createModelManager } from './engines/manager.js'
import { registerHttpRoutes } from './routes.js'
import { broadcastStream, clearStreamSubscribers } from './stream-hub.js'
import { createPcmTransport, pcmProviderFor } from './pcm-stream.js'
import { writeJson } from './http-util.js'
import { createProviderBreaker, isCancellation, TIMEOUT_REASON } from './breaker.js'
import {
  CLOUD_PROVIDERS,
  assertCredentialRef,
  keyEnvName,
  needsApiKey,
  pendingKeyWrites,
  publicConfig,
  stripSecretsFromConfig,
} from './keys.js'

// Scoped identity matching package.json and cordis.patch.yml
export const name = '@goodandready/dsh-tts'
export const inject = ['tools', 'credentials', 'llm', 'webServer', 'settings']

const NS = 'dsh-tts'

const ChainEntry = z.object({
  provider: z.string().default('espeak')
    .description(`Provider key. One of: ${PROVIDER_KEYS.join(', ')}.`),
  model: z.string().default('')
    .description('Model override. Empty means the provider default.'),
  voice: z.string().default('')
    .description('Voice override. Empty means the provider default.'),
})

const RoleOverride = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  voice: z.string().default(''),
  chime: z.string().default(''),
  ssmlStyle: z.string().default(''),
})

export const Config = z.object({
  speakReplies: z.boolean().default(false)
    .description('When on, speak each finished agent reply in the Web UI.'),
  enableLocalEngines: z.boolean().default(false)
    .description('Enable offline local TTS engines (Kokoro / F5).'),
  kokoroEnabled: z.boolean().default(false)
    .description('Use local Kokoro-82M on CPU when installed.'),
  f5Enabled: z.boolean().default(false)
    .description('Use local F5-TTS on GPU when installed.'),
  streamingEnabled: z.boolean().default(true)
    .description('Stream audio in real-time using AudioWorklet and SSE for sub-300ms latency.'),
  skipCode: z.boolean().default(true)
    .description('Replace fenced code blocks with a short spoken notice instead of reading them aloud.'),
  cache: z.boolean().default(true)
    .description('Reuse synthesized audio for repeated phrases instead of paying and waiting again.'),
  cacheMaxMb: z.number().default(100)
    .description('Disk limit for the synthesis cache; least recently used items are evicted first.'),
  narrateQuotesOnly: z.boolean().default(false)
    .description('Speak only quoted fragments.'),
  skipActions: z.boolean().default(false)
    .description('Drop *asterisk action* blocks instead of reading them.'),
  removeRegex: z.string().default('')
    .description('Custom global regex whose matches are removed before synthesis.'),
  autoDetect: z.boolean().default(false)
    .description('Guess ru/en per spoken piece instead of using the language setting.'),
  customBaseUrl: z.string().default('')
    .description('Origin of an OpenAI-compatible /audio/speech endpoint; empty skips it.'),
  customKeyEnv: z.string().default('CUSTOM_TTS_API_KEY'),
  pronunciation: z.array(z.object({
    from: z.string().default(''),
    to: z.string().default(''),
    whole: z.boolean().default(false),
    lang: z.string().default(''),
  })).default([])
    .description('Say this instead of that. Applied top-down; /regex/ form allowed in from.'),
  enableItDictionary: z.boolean().default(true)
    .description('Auto-correct common IT terminology pronunciation (SQL, Nginx, K8s, etc.).'),
  longReply: z.string().default('truncate')
    .description('What to do when a reply exceeds the length limit.'),
  summaryModel: z.string().default('')
    .description('provider/model for the spoken retelling; empty uses the conversation default.'),
  summarySentences: z.number().default(3)
    .description('Sentences in the spoken retelling.'),
  roles: z.dict(RoleOverride).default({
    reply: { provider: '', model: '', voice: '', chime: '', ssmlStyle: '' },
    approval: { provider: '', model: '', voice: '', chime: '', ssmlStyle: '' },
    error: { provider: '', model: '', voice: '', chime: '', ssmlStyle: '' },
  })
    .description('Per-role and subagent overrides; empty fields inherit the main chain.'),
  voiceDuplexEnabled: z.boolean().default(false)
    .description('Full-duplex voice conversation with dsh-voice.'),
  vadBargeIn: z.boolean().default(true)
    .description('Mute speech synthesis immediately when voice activity is detected.'),
  messengerTtsEnabled: z.boolean().default(false)
    .description('Send synthesized voice notes to messengers via @goodandready/dsh-messenger-gateway.'),
  autoDetectSubagent: z.boolean().default(true)
    .description('Auto-detect subagent roles in multi-agent sessions and route to dedicated voice profiles.'),
  language: z.string().default('ru'),
  speakAsItGoes: z
    .boolean()
    .description('Speak each reply as it lands instead of waiting for the whole turn to finish. '
      + 'Long answers start sounding almost at once because they are synthesized sentence by sentence.')
    .default(true),
  sentenceChars: z
    .number()
    .description('Upper bound of one spoken piece when speaking as it goes.')
    .default(320),
  // LOCAL FORK: live sentence-level flush. Off (the default) leaves upstream
  // message-level behaviour byte-for-byte intact; see LIVE-SENTENCE.md.
  liveSentenceStreaming: z
    .boolean()
    .description('Speak each sentence the moment the model finishes it, from the live assistant token '
      + 'stream, instead of waiting for the whole assistant message to settle.')
    .default(false),
  liveMinCharsFirst: z
    .number()
    .description('Minimum characters for the FIRST spoken piece of a reply. Lower starts audio sooner; '
      + 'raise it to swallow very short openers like "Sure.".')
    .default(12),
  liveMinChars: z
    .number()
    .description('Minimum characters for every later piece; a short sentence joins the next one so '
      + 'speech stays fluid.')
    .default(48),
  liveMaxChars: z
    .number()
    .description('Hard cap for one live piece. 0 reuses sentenceChars.')
    .default(0),
  livePollMs: z
    .number()
    .description('How often the browser asks for new audio while live sentence streaming is on. '
      + 'The audio path is a poll, so this value is on the first-audio critical path.')
    .default(150),
  liveFlushOnToolCall: z
    .boolean()
    .description('Flush the visible text already streamed when the model starts a tool call.')
    .default(true),
  rate: z
    .number()
    .description('Playback speed, 0.5 to 2. Synthesis is untouched; the browser plays faster or slower.')
    .default(1),
  bargeIn: z
    .boolean()
    .description('Fall silent the moment the microphone opens. Listening to a reply and talking over it '
      + 'at the same time does not work, and the reply would be recorded along with the voice.')
    .default(true),
  announceApproval: z
    .boolean()
    .description('Say out loud when the agent stops and waits for an approval, and play a short chime. '
      + 'Useful when you walk away from a long run.')
    .default(true),
  approvalText: z
    .string()
    .description('What to say when an approval is asked for. The tool name is appended.')
    .default('Approval required'),
  questionText: z
    .string()
    .description('What to say when the agent asks a question. Empty disables it.')
    .default('Agent asked a question'),
  chime: z
    .string()
    .description('Short sound before an announcement: ding, beep or none.')
    .default('ding'),
  maxChars: z.number().default(4000)
    .description('Longer replies are truncated before synthesis.'),
  chain: z.array(ChainEntry)
    .default([
      { provider: 'edge', model: '', voice: 'ru-RU-SvetlanaNeural' },
      { provider: 'piper', model: '', voice: '' },
      { provider: 'espeak', model: '', voice: 'ru' },
    ])
    .description('Fallback chain. Order is the order of attempts. A provider without a key is skipped.'),
  openaiKeyEnv: z.string().default('OPENAI_API_KEY'),
  openaiBaseUrl: z.string().default('https://api.openai.com/v1'),
  elevenlabsKeyEnv: z.string().default('ELEVENLABS_API_KEY'),
  googleKeyEnv: z.string().default('GEMINI_API_KEY'),
  azureKeyEnv: z.string().default('AZURE_SPEECH_KEY'),
  azureRegion: z.string().default('')
    .description('Azure Speech region, e.g. eastus. Required for the azure provider.'),
  mimoKeyEnv: z.string().description('Credential holding the Xiaomi MiMo key.').default('MIMO_API_KEY'),
  mimoBaseUrl: z.string().description('MiMo API root. Synthesis goes through its chat endpoint.').default('https://api.xiaomimimo.com/v1'),
  mimoFormat: z.string().description('MiMo output format: mp3 or wav.').default('mp3'),
  minimaxBin: z.string()
    .description('MiniMax CLI, looked up in PATH unless absolute. Install and log in separately; '
      + 'without it the provider declines and the chain moves on.')
    .default('mmx'),
  siliconflowKeyEnv: z.string().description('Credential holding the SiliconFlow key.').default('SILICONFLOW_API_KEY'),
  deepinfraKeyEnv: z.string().description('Credential holding the DeepInfra key.').default('DEEPINFRA_API_KEY'),
  fireworksKeyEnv: z.string().description('Credential holding the Fireworks key.').default('FIREWORKS_API_KEY'),
  groqKeyEnv: z.string().default('GROQ_API_KEY'),
  deepgramKeyEnv: z.string().default('DEEPGRAM_API_KEY'),
  openrouterKeyEnv: z.string().default('OPENROUTER_API_KEY'),
  edgeBin: z.string().default('edge-tts')
    .description('edge-tts CLI. Looked up in PATH unless an absolute path is given.'),
  piperBin: z.string().default('piper'),
  piperModel: z.string().default('')
    .description('Path to a Piper ONNX model. The piper provider is skipped while this is empty.'),
  espeakBin: z.string().default('espeak-ng'),
  timeoutMs: z.number().default(60000),
  maxQueue: z.number().default(8),

  // ── LOCAL FORK (0.4.16-local.8): per-request sampler overrides ──────────────
  //
  // Sent only by the providers named in `samplingProviders`; see
  // providers/cloud.js for the wire mapping and the range checks. An empty list
  // (the default) sends nothing at all, so every request body stays byte-identical
  // to upstream and no cloud vendor receives a field it would reject.
  //
  // -1 means "not configured" and is omitted rather than sent. The endpoint's own
  // default for the seed is already -1, so omitting it reproduces upstream
  // behaviour exactly.
  //
  // CORRECTED 2026-09-24: an earlier draft of this comment claimed a fixed seed
  // bought reproducibility. It does not. The same text with seed 4242 sent twice
  // came back 4.16 s and 3.68 s from qwentts.cpp, because the server advances an
  // RNG sub-sequence per request. The seed measurably influences generation, but
  // it does not pin it, and nothing may rely on identical audio from it.
  samplingProviders: z.array(z.string()).default([])
    .description('Providers that receive the sampler fields below. Empty (default) sends nothing.'),
  samplingTemperature: z.number().default(-1)
    .description('Talker temperature. -1 keeps the endpoint default. 0 is greedy: on qwentts.cpp the talker runs away to 163.84 s and the voice changes.'),
  samplingTopK: z.number().default(-1)
    .description('Talker top-k. -1 keeps the endpoint default; 0 disables the cutoff.'),
  samplingTopP: z.number().default(-1)
    .description('Talker nucleus top-p, within (0, 1]. -1 keeps the endpoint default.'),
  samplingRepetitionPenalty: z.number().default(-1)
    .description('Talker repetition penalty, greater than 0. -1 keeps the endpoint default.'),
  samplingSubtalkerTemperature: z.number().default(-1)
    .description('Sub-talker temperature. It draws the acoustic codes, so it is the knob that steadies timbre. -1 keeps the endpoint default.'),
  samplingSubtalkerTopK: z.number().default(-1)
    .description('Sub-talker top-k. -1 keeps the endpoint default; 0 disables the cutoff.'),
  samplingSubtalkerTopP: z.number().default(-1)
    .description('Sub-talker nucleus top-p, within (0, 1]. -1 keeps the endpoint default.'),
  samplingSeed: z.number().default(-1)
    .description('Sampler seed. -1 draws a random seed per request, as upstream did. A non-negative value influences the draw but does NOT make the same text reproducible: the server advances an RNG sub-sequence per request (measured 2026-09-24).'),

  // ── LOCAL FORK (PCM stage): progressive PCM transport ──────────────────────
  //
  // Off by default. When on, a piece whose first chain entry is an
  // OpenAI-compatible provider is requested as a streaming `pcm` body instead of
  // a complete WAV file, forwarded to the browser in framed chunks over SSE, and
  // played from a small startup buffer while the rest of the utterance is still
  // being generated.
  //
  // WAV is NOT removed: any failure that happens before the first audio chunk
  // reaches the browser falls back to the ordinary WAV path for that piece, and
  // a failure after that point ends the piece rather than restarting it in
  // another format (see runPiece).
  pcmStreamingExperimental: z.boolean().default(false)
    .description('Stream TTS audio to the browser progressively instead of buffering a complete WAV. '
      + 'Experimental; the WAV path is the fallback and remains the default.'),
  pcmStartupMs: z.number().default(120)
    .description('Milliseconds of PCM the browser buffers before it starts playback. Larger is safer '
      + 'under load, smaller starts sooner. The first arriving chunk can already exceed this.'),
  pcmTelemetry: z.boolean().default(true)
    .description('Let the browser report its half of the P0..P7 latency markers back to DSH. '
      + 'Carries timings and byte counts only, never speech text.'),
})

let utteranceSeq = 0

/** Numbers only reach a telemetry record; anything else becomes null. */
function numOrNull(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function apply(ctx, config) {
  const providerBreaker = createProviderBreaker()

  let getConfig = () => config
  const live = () => Config(structuredClone(getConfig() ?? {})) ?? config

  let settingsApi
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(NS, Config, { base: config })
    settingsApi = scope
    getConfig = () => scope.get() ?? config
    sctx.effect(() => () => {
      settingsApi = undefined
      getConfig = () => config
    })
  })

  // LOCAL FORK (0.4.16-local.6): silent mode.
  //
  // A RUNTIME flag, deliberately not a setting. It answers "is anybody listening
  // right now", which is a property of this stretch of time rather than of the
  // configuration — so it is not written to settings.yaml, it does not survive a
  // restart, and it cannot leave the stack permanently mute because somebody
  // forgot to turn it back on. Every start begins with speech enabled and the
  // profile's own `speakReplies` deciding whether replies are spoken at all.
  //
  // While on, no path reaches the synthesizer: reply playback, the live sentence
  // flush, approval/question announcements and their chimes, and the speak_text
  // tool all stop before a request is made. The point is the *request*, not the
  // playback — the TTS model shares the one GPU with the primary model here, so
  // speaking into an empty room costs real inference time.
  let speechMuted = false

  const pending = []
  const collectors = new Map()
  // Live-sentence support: a queue slot dropped by a cancel must never be
  // re-enqueued by a late synthesis settle().
  const droppedIds = new Set()

  const modelManager = createModelManager({
    root: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  })

  async function resolveKey(ref) {
    try {
      const resolved = await ctx.credentials.resolve(credentialRef(ref))
      if (resolved && resolved.value) return resolved.value
    } catch { /* fall through to env */ }
    return process.env[ref] || ''
  }

  async function describeProvider(provider) {
    const ref = keyEnvName(live(), provider)
    const base = { provider, ref, configured: false, writable: true }
    if (!ref) return base
    try {
      if (typeof ctx.credentials.describe === 'function') {
        const d = await ctx.credentials.describe(credentialRef(ref))
        return {
          provider,
          ref,
          configured: !!(d && d.configured),
          writable: d && d.writable === false ? false : true,
        }
      }
      const resolved = await ctx.credentials.resolve(credentialRef(ref))
      return { provider, ref, configured: !!(resolved && resolved.value), writable: true }
    } catch {
      return base
    }
  }

  async function credentialsView() {
    const out = {}
    for (const provider of CLOUD_PROVIDERS) {
      out[provider] = await describeProvider(provider)
    }
    return out
  }

  async function storeProviderKey(provider, value) {
    if (!needsApiKey(provider)) {
      throw new Error(`${provider} does not take an API key`)
    }
    const trimmed = String(value || '').trim()
    if (!trimmed) {
      throw new Error('an empty key cannot be stored')
    }
    if (typeof ctx.credentials.set !== 'function') {
      throw new Error('no credentials service is mounted')
    }
    const ref = assertCredentialRef(keyEnvName(live(), provider))
    await ctx.credentials.set(credentialRef(ref), trimmed)
    return ref
  }

  async function clearProviderKey(provider) {
    if (!needsApiKey(provider)) {
      throw new Error(`${provider} does not take an API key`)
    }
    if (typeof ctx.credentials.unset !== 'function') {
      throw new Error('no credentials service is mounted')
    }
    const ref = assertCredentialRef(keyEnvName(live(), provider))
    await ctx.credentials.unset(credentialRef(ref))
    return ref
  }

  async function configResponse() {
    return {
      ok: true,
      config: publicConfig(live()),
      credentials: await credentialsView(),
    }
  }

  const llm = ctx.llm

  // In-memory synthesis counters; reset on restart or DELETE /stats.
  const stats = { total: 0, cacheHits: 0, errors: 0, providers: {} }

  // In-flight synthesis deduplication (cache-stampede protection)
  const inFlightSyntheses = new Map()

  // LOCAL FORK (PCM stage): the progressive transport, plus the streams that are
  // currently open. `activePcm` is what makes cancellation reach the bytes that
  // are already on the wire rather than only the queue rows they belong to.
  const pcmTransport = createPcmTransport({
    broadcast: broadcastStream,
    log: (level, message) => {
      try {
        if (level === 'warn') ctx.logger.warn(message)
        else ctx.logger.info(message)
      } catch { /* logging must never break audio */ }
    },
  })
  const activePcm = new Map()   // piece id -> stream handle

  // Synthesis cache lives next to other harness data.
  const speechCache = createSpeechCache({
    root: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    maxBytes: () => {
      const mb = Number(live().cacheMaxMb)
      return mb > 0 ? mb * 1024 * 1024 : 100 * 1024 * 1024
    },
  })
  // Cache only short repeatable phrases; long unique streaming chunks skip the cache.
  // Otherwise the cache fills with garbage that never repeats.
  const CACHE_MAX_TEXT = 200

  // Text-cleaning options are read per call because config is live.
  function cleanOpts(cfg) {
    return { skipCode: cfg.skipCode !== false, phrases: speechPhrases(cfg.language) }
  }
  function cleanText(raw, cfg) {
    return applyPronunciation(
      applyNarrationFilters(stripForSpeech(raw, cfg.maxChars, cleanOpts(cfg)), cfg),
      cfg.pronunciation,
      cfg.language,
      cfg.enableItDictionary !== false,
    )
  }

  // Fast-model summary. Any failure returns an empty string and the caller
  // silently falls back to truncation.
  async function summarizeReply(text, cfg, signal) {
    const sentences = Number(cfg.summarySentences) > 0 ? Number(cfg.summarySentences) : 3
    if (!llm || typeof llm.stream !== 'function') return ''
    const opts = {
      messages: [{ role: 'user', content: 'Summarize the text in ' + sentences + ' sentences in the same language as the text. Summary only, no preamble:\n\n' + text }],
      signal,
    }
    const m = String(cfg.summaryModel || '')
    if (m) {
      const slash = m.indexOf('/')
      if (slash > 0) { opts.provider = m.slice(0, slash); opts.model = m.slice(slash + 1) }
      else opts.model = m
    }
    const parts = []
    for await (const chunk of llm.stream(opts)) {
      const piece = chunk && (chunk.text || (chunk.delta && chunk.delta.text)) || ''
      if (piece) parts.push(piece)
    }
    return parts.join('').trim()
  }

  // LOCAL FORK (PCM stage): the chain plan — attempt order, per-provider model and
  // voice — factored out of synthesize() so the streaming path builds byte-identical
  // requests instead of a second, drifting copy of the same rules.
  function chainPlan(cfg, role) {
    const models = {}
    const voices = {}
    const order = []
    for (const entry of Array.isArray(cfg.chain) ? cfg.chain : []) {
      if (!PROVIDER_KEYS.includes(entry.provider)) continue
      order.push(entry.provider)
      models[entry.provider] = entry.model || DEFAULT_MODELS[entry.provider]
      voices[entry.provider] = entry.voice || DEFAULT_VOICES[entry.provider]
    }
    // Role overrides: empty fields inherit the main chain.
    const ov = (cfg.roles && cfg.roles[role]) || {}
    if (ov.provider && PROVIDER_KEYS.includes(ov.provider)) order.unshift(ov.provider)
    if (order.length) {
      if (ov.model) models[order[0]] = ov.model
      if (ov.voice) voices[order[0]] = ov.voice
    }
    return { order, models, voices, ov }
  }

  async function synthesize(rawText, cfg, signal, role = 'reply') {
    let text = cleanText(rawText, cfg)
    if (!text) throw new Error('nothing to speak')
    const maxChars = Number(cfg.maxChars) > 0 ? Number(cfg.maxChars) : 0
    const overLimit = maxChars > 0 && text.length > maxChars
    if (overLimit && cfg.longReply !== 'full') {
      let cut = text.slice(0, maxChars)
      if (cfg.longReply === 'summarize') {
        try {
          const retold = await summarizeReply(text.slice(0, 8000), cfg, signal)
          if (retold) cut = speechPhrases(cfg.language).summaryIntro + ' ' + retold
        } catch (llmDown) { /* quiet fallback to truncation */ }
      }
      text = cut
    }
    const { order, models, voices, ov } = chainPlan(cfg, role)
    // LOCAL FORK (0.4.16-local.8): the sampler is part of what produced the audio,
    // so it belongs in the cache key and in the in-flight key. `keyFor` appends it
    // only when sampling is configured, which keeps both keys byte-identical to
    // upstream in the default configuration.
    const samplingSig = samplingSignature(cfg)
    const keyFor = (parts) => cacheKey(samplingSig ? [...parts, samplingSig] : parts)

    // Playback rate is browser-side only and is not part of the cache key.
    // It does not affect synthesis.
    const cacheAllowed = cfg.cache !== false && text.length <= CACHE_MAX_TEXT
    if (cacheAllowed) {
      for (const provider of order) {
        const hit = await speechCache.get(keyFor([text, provider, models[provider], voices[provider], role, ov.ssmlStyle]))
        if (hit) {
          stats.total++
          stats.cacheHits++
          const ps = stats.providers[provider] || (stats.providers[provider] = { n: 0, e: 0, ms: 0 })
          ps.n++
          return { provider, mime: hit.mime, audio: hit.audio, tookMs: 0, cached: true }
        }
      }
    }
    const flightKey = keyFor([text, order.join(','), JSON.stringify(models), JSON.stringify(voices), role, ov.ssmlStyle])
    if (inFlightSyntheses.has(flightKey)) {
      return inFlightSyntheses.get(flightKey)
    }

    const synthPromise = (async () => {
      try {
        const baseProviders = makeProviders(
          { resolveKey, fetchImpl: fetch, cfg, modelManager },
          { text, lang: cfg.autoDetect ? detectLang(text) : cfg.language, signal, models, voices, role },
        )
        const providers = {}
        for (const key of Object.keys(baseProviders)) {
          const fn = baseProviders[key]
          providers[key] = async () => {
            if (providerBreaker.isOpen(key)) {
              return { ok: false, provider: key, reason: 'circuit open (cooldown)' }
            }
            try {
              const out = await fn()
              if (out && out.ok) providerBreaker.recordSuccess(key)
              // LOCAL FORK (0.4.16-local.7): cancelling our own synthesis is not a
              // provider failure. See isCancellation() in breaker.js.
              else if (!isCancellation(out && out.reason)) providerBreaker.recordFailure(key, out && out.reason)
              return out
            } catch (err) {
              if (!isCancellation(err)) providerBreaker.recordFailure(key, err)
              throw err
            }
          }
        }
        const out = await runChain(order, providers)
        stats.total++
        const ps = stats.providers[out.provider] || (stats.providers[out.provider] = { n: 0, e: 0, ms: 0 })
        ps.n++
        ps.ms += out.tookMs || 0
        if (cacheAllowed) {
          const p = out.provider
          speechCache.put(keyFor([text, p, models[p], voices[p], role, ov.ssmlStyle]), out.mime, out.audio).catch(() => {})
        }
        return out
      } finally {
        inFlightSyntheses.delete(flightKey)
      }
    })()

    inFlightSyntheses.set(flightKey, synthPromise)
    return synthPromise
  }

  // Synthesize one phrase with queue reservation. The id is issued immediately,
  // not when the provider answers, so short phrases cannot overtake long ones.
  // LOCAL FORK: `extSignal` lets the live sentence path tie a piece to the turn
  // that produced it, so a cancelled turn stops its own synthesis.
  // LOCAL FORK (0.4.16-local.2): `meta` carries the owning turn (and step when
  // the path knows one), so a consumer can attribute a queue item to the
  // generation that produced it instead of inferring it from arrival time —
  // CONTROL synthesis lags one or more whole turns behind generation.
  /**
   * LOCAL FORK (PCM stage): stream one piece to the browser.
   *
   * `committed` in the result is the whole point of the contract: it becomes true
   * the moment the first audio byte is handed to the transport, and from then on
   * the piece can no longer be silently restarted in another format.
   */
  async function pcmStreamPiece({ id, sid, text, cfg, role, signal, plan, pcmKey, cancel }) {
    const stream = pcmTransport.open({ id, sessionId: sid, role, text })
    // Lets a barge-in close the fetch even when this piece has no parent signal of
    // its own (the settled and announcement paths start a piece without one).
    stream.abortFetch = cancel
    activePcm.set(id, stream)
    let committed = false
    try {
      const streamers = makePcmStreamersFor(
        { resolveKey, fetchImpl: fetch, cfg, modelManager },
        {
          text,
          lang: cfg.autoDetect ? detectLang(text) : cfg.language,
          signal,
          models: plan.models,
          voices: plan.voices,
          role,
        },
      )
      const fn = streamers[pcmKey]
      if (typeof fn !== 'function') throw new Error(`no PCM streamer for ${pcmKey}`)
      const out = await fn((bytes) => {
        committed = true
        stream.push(bytes)
        return true
      })
      if (!out || !out.ok) throw new Error((out && out.reason) || `${pcmKey} produced no audio`)
      stream.end()
      return { ok: true, committed: true, bytes: out.bytes, chunks: out.chunks, stream }
    } catch (error) {
      // A cancelled turn is not a provider failure — the same distinction the
      // breaker makes (0.4.16-local.7). It is reported, not counted as an error.
      const cancelled = signal.aborted || isCancellation(error)
      stream.abort(cancelled ? 'cancelled' : String(error && error.message || error), { cancelled })
      return { ok: false, committed, cancelled, error, stream }
    } finally {
      if (activePcm.get(id) === stream) activePcm.delete(id)
    }
  }

  /**
   * One piece, from text to a settled queue row.
   *
   * PCM is attempted only when the feature is on AND the first chain entry is the
   * PCM-capable provider — trying a later entry would change which voice speaks.
   * A failure before any audio has crossed to the browser falls back to the
   * validated WAV path for this piece; a failure after that point ends the piece
   * instead of restarting it.
   */
  async function runPiece({ id, sid, text, cfg, kind, role, signal, cancel }) {
    const pcmKey = pcmProviderFor(cfg)
    if (pcmKey) {
      const plan = chainPlan(cfg, role)
      if (plan.order.length && plan.order[0] === pcmKey) {
        const attempt = await pcmStreamPiece({ id, sid, text, cfg, role, signal, plan, pcmKey, cancel })
        if (attempt.ok) {
          settle(id, {
            id,
            sessionId: sid,
            kind: 'pcm',
            role,
            text,
            streamId: attempt.stream.streamId,
            provider: pcmKey,
            mime: 'audio/pcm',
            sampleRate: attempt.stream.record.sampleRate,
            channels: attempt.stream.record.channels,
            streamedBytes: attempt.bytes,
            tookMs: attempt.stream.record.host.ttsTotalMs,
          })
          return
        }
        if (attempt.committed) {
          stats.errors++
          settle(id, {
            id,
            sessionId: sid,
            kind: 'error',
            role,
            text,
            streamId: attempt.stream.streamId,
            error: attempt.cancelled ? 'cancelled' : String(attempt.error && attempt.error.message || attempt.error),
            pcmAborted: true,
          })
          return
        }
        try {
          ctx.logger.info(
            `dsh-tts: PCM stream for ${id} failed before any audio; using WAV `
            + `(${String(attempt.error && attempt.error.message || attempt.error)})`,
          )
        } catch { /* logging must never break speech */ }
      }
    }

    // LOCAL FORK (PCM stage): the WAV baseline is measured through the same store
    // and the same clock as the PCM arm, or the two numbers are not comparable.
    // This adds bookkeeping only — no call in the validated path is changed.
    const wavMark = cfg.pcmTelemetry === false ? null : pcmTransport.openWav({ id, sessionId: sid, role, text })
    let out
    try {
      out = await synthesize(text, cfg, signal, role)
    } catch (err) {
      if (wavMark) wavMark.fail(err && err.message || err, { cancelled: isCancellation(err) || signal.aborted })
      throw err
    }
    if (wavMark) {
      wavMark.record.host.ttsTotalMs = numOrNull(out.tookMs)
      wavMark.complete(out.audio ? out.audio.length : 0)
    }
    settle(id, {
      id,
      sessionId: sid,
      kind: (kind === 'notice' || kind === 'error') ? kind : 'speech',
      role,
      text,
      provider: out.provider,
      mime: out.mime,
      audioBase64: Buffer.from(out.audio).toString('base64'),
      tookMs: out.tookMs,
      // The browser needs W0 on the host's clock to place its own marks on the
      // same timeline; without it W5..W8 would be relative to nothing.
      ...(wavMark ? { w0Wall: wavMark.record.t0Wall, wavId: wavMark.streamId } : {}),
    })
    if (wavMark) pcmTransport.markWavPublished(wavMark.streamId)
  }

  function speakPiece(sid, text, cfg, kind, extSignal, meta) {
    if (!text) return
    // LOCAL FORK (0.4.16-local.6): silent mode. This is the single choke point
    // every automatic path funnels through (live sentence flush, speak-as-it-goes,
    // the settled remainder, turn-end pieces, and announcements), and the return
    // happens before a queue slot is reserved or the provider chain is entered —
    // so "muted" means no synthesis request was made, not merely no audio heard.
    // Callers keep their own bookkeeping, so unmuting mid-reply speaks only what
    // has not been spoken yet instead of replaying the reply from the start.
    if (speechMuted) return
    const role = kind === 'notice' ? 'approval' : kind === 'error' ? 'error' : (kind && kind !== 'speech' ? kind : 'reply')
    const id = `u${++utteranceSeq}`
    const controller = new AbortController()
    // LOCAL FORK (0.4.16-local.7): a timeout carries its own reason so the
    // breaker can still tell a hung provider from a cancelled turn.
    const timer = setTimeout(() => controller.abort(new Error(TIMEOUT_REASON)), cfg.timeoutMs)
    let detach = null
    if (extSignal) {
      if (extSignal.aborted) controller.abort(extSignal.reason)
      else {
        const onAbort = () => controller.abort(extSignal.reason)
        extSignal.addEventListener('abort', onAbort, { once: true })
        detach = () => extSignal.removeEventListener('abort', onAbort)
      }
    }
    reserve(id, sid, meta)
    // LOCAL FORK (PCM stage): the piece body moved into runPiece so the streaming
    // and buffered transports share one entry point, one reservation and one
    // settle. The queue slot is still reserved before anything is synthesized, so
    // a short piece cannot overtake a long one.
    runPiece({ id, sid, text, cfg, kind, role, signal: controller.signal, cancel: (why) => { try { controller.abort(new Error(why || 'cancelled')) } catch { /* already aborted */ } } })
      .catch((err) => {
        stats.errors++
        settle(id, { id, sessionId: sid, kind: 'error', text, error: String(err && err.message || err) })
      })
      .finally(() => { clearTimeout(timer); if (detach) detach() })
  }

  // Announcement: short chime then phrase. The chime is drawn by the browser,
  // so nothing is downloaded or stored.
  function roleChime(cfg, role) {
    const ov = (cfg.roles && cfg.roles[role]) || {}
    return ov.chime || cfg.chime
  }

  function announce(sid, text, cfg) {
    // LOCAL FORK (0.4.16-local.6): silent mode also drops the chime. The chime is
    // drawn by the browser rather than synthesized, but an announcement exists to
    // attract attention, and silent mode means there is nobody to attract.
    if (speechMuted) return
    const chime = roleChime(cfg, 'approval')
    if (chime && chime !== 'none') {
      enqueue({ id: `u${++utteranceSeq}`, sessionId: sid, kind: 'chime', chime })
    }
    speakPiece(sid, text, cfg, 'notice')
  }

  // LOCAL FORK (0.4.16-local.9): eviction must never take a `reserved` slot.
  //
  // A reserved row is a promise the engine has already made: this piece exists, it
  // is being synthesized, and it will be spoken in this position (live.js:505 —
  // "the order of these calls is the order of playback"). The upstream fallback,
  // `pending.shift()` when every row is still reserved, broke exactly that promise,
  // and the loser of the race then re-entered through settle()'s missing-row path,
  // which appended it at the TAIL.
  //
  // Measured live, 2026-09-23: 15 rows left the window inside ~2 s during one long
  // reply, with the synthesis error counter unchanged — nothing was aborted, nothing
  // failed — and the reply was heard as its first sentence followed by an unrelated
  // later part.
  //
  // So: evict the oldest SETTLED row, and when there is none, let the window grow.
  // Growth is bounded by in-flight synthesis, because every reserved row settles or
  // times out within timeoutMs; that is strictly better than destroying a promise.
  // Evictions are counted and logged so a lost sentence is never invisible.
  function enqueue(item) {
    pending.push(item)
    const max = live().maxQueue || 32
    while (pending.length > max) {
      const dropIndex = pending.findIndex((x) => x && x.kind !== 'reserved')
      if (dropIndex < 0) break
      stats.queueEvictions = (stats.queueEvictions || 0) + 1
      if (stats.queueEvictions === 1 || stats.queueEvictions % 25 === 0) {
        try {
          ctx.logger.warn(`dsh-tts: pending window over ${max}, evicted ${pending[dropIndex].id} (${stats.queueEvictions} evictions total)`)
        } catch { /* logging must never break speech */ }
      }
      pending.splice(dropIndex, 1)
    }
    if (live().streamingEnabled && item.kind === 'chime') {
      broadcastStream('chime', item)
    }
  }

  /** Queue position from a `u<seq>` id, or null when the id is not that shape. */
  function idOrder(id) {
    const n = Number(String(id).replace(/^u/, ''))
    return Number.isFinite(n) ? n : null
  }

  /**
   * LOCAL FORK (0.4.16-local.9): insert a row at its id's position, never at the tail.
   *
   * The window cap is deliberately not applied here. This row was already counted
   * in the window before it went missing, so putting it back restores the previous
   * size instead of growing it — and running the cap here could evict the very row
   * being restored.
   */
  function insertInOrder(item) {
    const n = idOrder(item.id)
    if (n === null) { pending.push(item); return }
    const at = pending.findIndex((row) => {
      const m = idOrder(row && row.id)
      return m !== null && m > n
    })
    if (at === -1) pending.push(item)
    else pending.splice(at, 0, item)
  }

  // Reserve the queue slot before synthesis so phrase order matches
  // speech order, not arrival race.
  // LOCAL FORK (0.4.16-local.2): normalized piece-ownership metadata. Every row
  // has the same shape; null means "this path does not know".
  function pieceMeta(meta) {
    const m = meta || {}
    return {
      turn: Number.isInteger(m.turn) ? m.turn : null,
      step: Number.isInteger(m.step) ? m.step : null,
      steps: Array.isArray(m.steps) && m.steps.length ? [...m.steps] : null,
    }
  }

  function reserve(id, sid, meta) {
    enqueue({ id, kind: 'reserved', sessionId: sid, ...pieceMeta(meta) })
  }

  function settle(id, item) {
    // LOCAL FORK: the slot was dropped by a cancel/barge-in; do not resurrect it.
    if (droppedIds.has(id)) { droppedIds.delete(id); return }
    const at = pending.findIndex((row) => row.id === id)
    if (at === -1) {
      // LOCAL FORK (0.4.16-local.9): put it back WHERE IT BELONGS. Appending sent a
      // late-settling sentence to the end of the reply's speech instead of into its
      // place, which the ear hears as a jump (see the enqueue comment above).
      insertInOrder({ ...item, ...pieceMeta(item) })
      return
    }
    // LOCAL FORK (0.4.16-local.2): ownership is recorded at reservation time and
    // inherited here, so the reserved -> settled transition preserves it even
    // when the synthesis promise resolves long after its turn finished. A
    // caller-supplied value, if any, still wins.
    const owner = pieceMeta(pending[at])
    pending[at] = { ...owner, ...item }
    if (live().streamingEnabled && item.audioBase64) {
      broadcastStream('utterance', item)
    }
  }

  // LOCAL FORK: cancel support for the live sentence path. Dropping the
  // reserved slot is what stops a cancelled turn from speaking into the next
  // one; a settled slot is dropped too on a full barge-in.
  function dropPendingForSession(sid) {
    // LOCAL FORK (PCM stage): drop the open streams as well as the queue rows.
    // Dropping a row stops the NEXT piece; it does nothing about the bytes already
    // in flight for the piece being heard, so a barge-in has to reach them too.
    // Aborting the fetch closes the connection, which is also how the TTS server
    // learns to stop generating (src/tts-server.h client_gone).
    for (const [id, stream] of [...activePcm]) {
      const rec = stream.record
      if (sid && rec && rec.sessionId !== sid) continue
      if (typeof stream.abortFetch === 'function') stream.abortFetch('barge-in')
      stream.abort('cancelled', { cancelled: true })
      activePcm.delete(id)
    }
    for (let i = pending.length - 1; i >= 0; i--) {
      const item = pending[i]
      if (!item) continue
      if (sid && item.sessionId !== sid) continue
      if (item.kind === 'reserved') droppedIds.add(item.id)
      pending.splice(i, 1)
    }
  }

  // LOCAL FORK: live sentence-level flush.
  //
  // The agent loop publishes every raw StreamChunk as a process-local frame
  // while the model is still generating (`agent/assistant-stream`, emitted by
  // dsh-agent-loop's AssistantStreamAttempt.push), which is the only true
  // token-level hook in the harness. The engine accumulates visible text, cuts
  // on sentence boundaries, and hands each finished sentence to the queue
  // above. It is inert unless `liveSentenceStreaming` is on, so non-live
  // behaviour is exactly upstream's.
  const liveEngine = createLiveEngine({
    live,
    cleanText,
    speakPiece,
    dropPendingForSession,
    log: (level, message) => {
      try {
        if (level === 'warn') ctx.logger.warn(message)
        else ctx.logger.info(message)
      } catch { /* logging must never break speech */ }
    },
  })

  ctx.effect(() => ctx.on('agent/assistant-stream', (payload) => {
    try {
      liveEngine.onFrame(payload)
    } catch (error) {
      try { ctx.logger.warn(`dsh-tts: live sentence flush failed: ${error && error.message || error}`) } catch { /* ignore */ }
    }
  }), 'dsh-tts: live sentence flush')

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const cfg = live()
    if (!cfg.speakReplies) return
    const sid = session && session.id
    if (!sid) return
    // The agent is waiting for human approval — worth speaking aloud
    // so the user notices without watching the screen.
    if (event.type === 'approval/asked') {
      if (!cfg.announceApproval) return
      const tool = event.data && event.data.toolName
      announce(sid, cfg.approvalText + (tool ? ': ' + tool : ''), cfg)
      return
    }
    if (event.type === 'question/requested') {
      if (!cfg.announceApproval || !cfg.questionText) return
      announce(sid, cfg.questionText, cfg)
      return
    }

    if (event.type === 'assistant/message') {
      const text = assistantText(event.data && event.data.message)
      const agentName = (event.data && (
        event.data.subagent ||
        event.data.agent ||
        (event.data.message && (event.data.message.subagent || event.data.message.agent || event.data.message.sender || (event.data.message.author && event.data.message.author.name)))
      )) || (session && (session.subagent || session.agent)) || ''
      const activeRole = (agentName && cfg.roles && cfg.roles[agentName] && (cfg.roles[agentName].provider || cfg.roles[agentName].voice)) ? agentName : 'reply'

      // LOCAL FORK: live sentence streaming owns this step when it already spoke
      // part of it. In that case speak only the remainder — a piece that was
      // heard from the live stream is never replayed from the settled message.
      // When nothing was flushed live (no usable streamed text, or the feature
      // was just switched on), this falls through to the upstream path below.
      if (liveOptions(cfg).enabled) {
        const settled = liveEngine.onSettledMessage({
          sid,
          turn: event.data && event.data.turn,
          step: event.data && event.data.step,
          text,
        })
        if (settled.mode === 'remainder') {
          // Only genuinely unsaid text is spoken here, and an empty remainder owns
          // nothing at all: no queue slot is reserved for silence.
          const left = settled.remainder ? cleanText(settled.remainder, cfg) : ''
          if (left) {
            for (const piece of splitSentences(left, cfg.sentenceChars)) speakPiece(sid, piece, cfg, activeRole, undefined, { turn: event.data && event.data.turn, step: event.data && event.data.step })
          }
          return
        }
      }

      // Speak as it goes: each incoming chunk is spoken immediately
      // in sentence pieces; waiting for turn end means silence while the agent works.
      
      if (cfg.speakAsItGoes) {
        const ready = cleanText(text, cfg)
        for (const piece of splitSentences(ready, cfg.sentenceChars)) speakPiece(sid, piece, cfg, activeRole, undefined, { turn: event.data && event.data.turn, step: event.data && event.data.step })
        return
      }
      const cur = collectors.get(sid) || { parts: [], role: activeRole, steps: [] }
      cur.parts.push(text)
      cur.role = activeRole
      // LOCAL FORK (0.4.16-local.2): remember which steps contributed text, so
      // the turn-level pieces spoken at turn/end carry their provenance.
      const step = event.data && event.data.step
      if (Number.isInteger(step) && !cur.steps.includes(step)) cur.steps.push(step)
      collectors.set(sid, cur)
      return
    }
    if (event.type !== 'turn/end') return
    // LOCAL FORK: a turn boundary ends every live cursor of this session, so a
    // later turn can never inherit text or ownership from this one.
    liveEngine.releaseSession(sid)
    // With speak-as-it-goes everything was already spoken by turn end.
    if (cfg.speakAsItGoes) { collectors.delete(sid); return }
    const cur = collectors.get(sid)
    collectors.delete(sid)
    const raw = cur && Array.isArray(cur.parts) ? cur.parts.join('\n') : ''
    const text = cleanText(raw, cfg)
    if (!text) return
    const pieces = splitSentences(text, cfg.sentenceChars)
    const activeRole = (cur && cur.role) || 'reply'
    // LOCAL FORK (0.4.16-local.2): CONTROL speaks a whole turn at turn/end, so
    // the owner is the turn. `step` stays null on purpose — several steps' text
    // is joined and split as one body, so a per-piece step would be invented
    // precision; the contributing steps travel in `steps` instead.
    const turn = event.data && event.data.turn
    for (const piece of pieces) {
      speakPiece(sid, piece, cfg, activeRole, undefined, { turn, step: null, steps: cur && cur.steps })
    }
  }), 'dsh-tts: speak finished replies')


  registerHttpRoutes(ctx, {
    breakerSnapshot: () => providerBreaker.snapshot(),

    live,
    modelManager,
    stats,
    speechCache,
    cleanText,
    synthesize,
    credentialsView,
    configResponse,
    storeProviderKey,
    clearProviderKey,
    pending,
    getSettingsApi: () => settingsApi,
    validateConfig: (obj) => Config(obj),
    // LOCAL FORK: live sentence-level flush (status reporting + barge-in cancel).
    liveEngine,
    dropPendingForSession,
    // LOCAL FORK (0.4.16-local.6): silent mode, so the status route can report it
    // and a caller outside the agent can toggle it.
    isSpeechMuted: () => speechMuted,
    setSpeechMuted,
    // LOCAL FORK (0.4.16-local.2): live queue state, so a consumer can wait for
    // the queue to drain instead of sleeping an arbitrary amount and hoping.
    queueSnapshot: () => {
      const rows = Array.isArray(pending) ? pending : []
      return {
        total: rows.length,
        reserved: rows.filter((r) => r && r.kind === 'reserved').length,
        settled: rows.filter((r) => r && r.kind !== 'reserved').length,
        inFlight: inFlightSyntheses.size,
      }
    },
    // LOCAL FORK (PCM stage): progressive transport, for /status and for the
    // marker-collection route the browser reports its half of P0..P7 to.
    pcmTransport,
    pcmConfig: () => {
      const cfg = live()
      return {
        experimental: cfg.pcmStreamingExperimental === true,
        startupMs: Number(cfg.pcmStartupMs) >= 0 ? Number(cfg.pcmStartupMs) : 120,
        telemetry: cfg.pcmTelemetry !== false,
        provider: pcmProviderFor(cfg),
      }
    },
  })

  ctx.effect(() => () => {
    clearStreamSubscribers()
  }, 'dsh-tts: cleanup stream subscribers')

  ctx.tools.register(
    defineTool({
      name: 'speak_text',
      description:
        'Synthesize speech from text using the dsh-tts provider fallback chain. '
        + 'Returns audio as base64 plus the provider that succeeded. '
        + 'Use when the user asks to hear text; do not dump the audio into the model context.',
      parameters: {
        text: { type: 'string', required: true, description: 'Text to speak.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            muted: { type: 'boolean' },
            provider: { type: 'string' },
            mime: { type: 'string' },
            bytes: { type: 'number' },
            tookMs: { type: 'number' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value && value.ok
            ? `Spoken with ${value.provider} (${value.mime}, ${value.bytes || 0} bytes).`
            : value && value.muted
              ? `Not spoken: silent mode is on. ${value.error || ''}`.trim()
              : `TTS failed: ${value && value.error ? value.error : 'unknown'}`,
        }],
      },
      execute: async (args, exec) => {
        const cfg = live()
        // LOCAL FORK (0.4.16-local.6): silent mode declines here rather than
        // synthesizing and discarding the audio, so "muted" really does mean no
        // request reached the TTS provider. The caller is told why, so the model
        // can unmute deliberately instead of quietly failing to be heard.
        if (speechMuted) {
          return {
            ok: false,
            muted: true,
            error: 'Silent mode is on: speech output is muted. Call set_speech_output with muted=false '
              + 'first if the user has asked to hear something.',
          }
        }
        try {
          const out = await synthesize(String(args.text || ''), cfg, exec.signal)
          return {
            ok: true,
            provider: out.provider,
            mime: out.mime,
            bytes: out.audio.length,
            tookMs: out.tookMs,
          }
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) }
        }
      },
    }),
  )

  // LOCAL FORK (0.4.16-local.6): stop speech that is already on its way. Turning
  // silent mode on mid-reply must be audible *now* — the reply in flight would
  // otherwise finish playing, and every remaining sentence of it would still be
  // synthesized into a queue nobody will collect. This is the same hard stop the
  // browser's barge-in uses, so it inherits that path's tested behaviour.
  function silenceNow() {
    try {
      if (liveEngine && typeof liveEngine.abortAll === 'function') liveEngine.abortAll()
      else if (typeof dropPendingForSession === 'function') dropPendingForSession()
    } catch (error) {
      try { ctx.logger.warn(`dsh-tts: silent-mode stop failed: ${error && error.message || error}`) } catch { /* logging must never break muting */ }
    }
  }

  // LOCAL FORK (0.4.16-local.6): the one place silent mode changes, so the agent
  // tool and the HTTP route cannot drift apart. Turning it ON also stops speech
  // that is already on its way, because "nobody is listening" has to be true of
  // the sentence being read right now, not only of the next one.
  function setSpeechMuted(next, reason) {
    const want = !!next
    const changed = want !== speechMuted
    speechMuted = want
    if (changed && want) silenceNow()
    if (changed) {
      try {
        ctx.logger.info(`dsh-tts: silent mode ${want ? 'on' : 'off'}${reason ? ` (${reason})` : ''}`)
      } catch { /* logging must never break muting */ }
    }
    return { muted: speechMuted, changed }
  }

  // LOCAL FORK (0.4.16-local.6): silent-mode control, so the agent can honour
  // "I am going out, don't talk" the moment it is said — no restart, no settings
  // edit, no UI click — and undo it when the user is back. The state lives in
  // memory only: a restart returns to the profile's normal speaking behaviour,
  // which is the safe direction for a flag whose whole meaning is "for now".
  ctx.tools.register(
    defineTool({
      name: 'set_speech_output',
      description:
        'Turn spoken output (silent mode) on or off for the whole harness. Pass muted=true when the '
        + 'user says he is leaving, will be away, or wants quiet, so that no further speech is '
        + 'synthesized; pass muted=false when he is back or asks to hear something. Called with no '
        + 'argument it only reports the current state. Speech is synthesized on the same GPU as the '
        + 'model, so muting while nobody is present saves real inference time. The state is not '
        + 'persisted: every restart begins with speech enabled.',
      parameters: {
        muted: {
          type: 'boolean',
          description: 'true silences all automatic speech; false restores it. Omit to read the current state only.',
        },
        reason: {
          type: 'string',
          description: 'Short note recorded in the host log, e.g. "user away until the evening".',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            muted: { type: 'boolean' },
            changed: { type: 'boolean' },
            speakReplies: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value && value.ok
            ? (value.muted
              ? `Silent mode is ${value.changed ? 'now ON' : 'ON'}: no speech will be synthesized.`
              : `Speech output is ${value.changed ? 'back ON' : 'ON'}.`)
            : `Could not change speech output: ${value && value.error ? value.error : 'unknown'}`,
        }],
      },
      execute: async (args) => {
        try {
          if (typeof args.muted !== 'boolean') {
            return { ok: true, muted: speechMuted, changed: false, speakReplies: !!live().speakReplies }
          }
          const res = setSpeechMuted(args.muted, args.reason)
          return { ok: true, muted: res.muted, changed: res.changed, speakReplies: !!live().speakReplies }
        } catch (e) {
          return { ok: false, muted: speechMuted, changed: false, speakReplies: !!live().speakReplies, error: String(e && e.message || e) }
        }
      },
    }),
  )
}
