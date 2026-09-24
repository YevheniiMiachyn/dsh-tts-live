import { DEFAULT_MODELS, DEFAULT_VOICES, OPENAI_COMPATIBLE } from "./constants.js"

function pick(map, models, key) {
  const chosen = models && typeof models[key] === "string" ? models[key].trim() : ""
  return chosen || map[key]
}

function asBuffer(body) {
  if (Buffer.isBuffer(body)) return body
  return Buffer.from(body)
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// LOCAL FORK (0.4.16-local.8): per-request sampler overrides for endpoints that
// accept them.
//
// qwentts.cpp — the local server this profile speaks through — takes temperature,
// top_k, top_p and repetition_penalty, a SECOND sampler for the sub-talker that
// draws the acoustic codes (where timbre lives), and an explicit seed. Upstream
// sent none of them, so the sampler was whatever the endpoint defaulted to
// (0.9 / 50 / 1.0 on both stacks) with a fresh random seed per request.
//
// Two rules make this safe to ship:
//
//   - only providers named in `samplingProviders` receive the fields. The default
//     is an empty list, so every request body stays byte-identical to upstream and
//     no cloud vendor is handed a field it would reject with a 400.
//   - a field that is not configured, or that falls outside the range the server
//     accepts, is omitted rather than sent. A negative number is the "unset"
//     sentinel. temperature 0 IS sent, because greedy decoding is a legitimate
//     request — but on qwentts.cpp greedy on the TALKER runs away to
//     max_new_tokens (163.84 s for 2048 tokens at the 80 ms codec hop) and the
//     voice measurably changes, so it is worth knowing before asking for it.
const SAMPLING_FIELDS = [
  ['temperature', 'samplingTemperature', (v) => v >= 0],
  ['top_k', 'samplingTopK', (v) => Number.isInteger(v) && v >= 0],
  ['top_p', 'samplingTopP', (v) => v > 0 && v <= 1],
  ['repetition_penalty', 'samplingRepetitionPenalty', (v) => v > 0],
  ['subtalker_temperature', 'samplingSubtalkerTemperature', (v) => v >= 0],
  ['subtalker_top_k', 'samplingSubtalkerTopK', (v) => Number.isInteger(v) && v >= 0],
  ['subtalker_top_p', 'samplingSubtalkerTopP', (v) => v > 0 && v <= 1],
  ['seed', 'samplingSeed', (v) => Number.isInteger(v) && v >= 0],
]

/** The wire fields this provider should receive. Empty unless it is named. */
export function samplingFieldsFor(cfg, key) {
  const list = cfg && Array.isArray(cfg.samplingProviders) ? cfg.samplingProviders : []
  if (!list.includes(key)) return {}
  const out = {}
  for (const [wire, configKey, inRange] of SAMPLING_FIELDS) {
    const value = cfg[configKey]
    if (typeof value === 'number' && Number.isFinite(value) && inRange(value)) out[wire] = value
  }
  return out
}

/**
 * The sampler is part of what produced the audio, so it belongs in the synthesis
 * cache key and in the in-flight key; without it a take synthesized at one
 * temperature would be served for another. Returns '' while nothing is
 * configured, which keeps both keys byte-identical to upstream by default.
 */
export function samplingSignature(cfg) {
  const list = cfg && Array.isArray(cfg.samplingProviders) ? [...cfg.samplingProviders].sort() : []
  if (!list.length) return ''
  return JSON.stringify([list, ...SAMPLING_FIELDS.map(([, configKey]) => cfg[configKey] ?? null)])
}

export function makeCloudProviders(deps, req, withCloudTimeout) {
  const { resolveKey, fetchImpl, cfg } = deps
  const { text, lang, models, voices, role } = req

  async function openai() {
    const key = await resolveKey(cfg.openaiKeyEnv)
    if (!key) return { ok: false, provider: 'openai', reason: `no ${cfg.openaiKeyEnv}` }
    const { signal, cleanup } = withCloudTimeout()
    try {
      const res = await fetchImpl((cfg.openaiBaseUrl || 'https://api.openai.com/v1') + '/audio/speech', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: pick(DEFAULT_MODELS, models, 'openai'),
        input: text,
        voice: pick(DEFAULT_VOICES, voices, 'openai'),
        // LOCAL FORK (production patch #4a): upstream asked for mp3 here.
        response_format: 'wav',
      }),
      signal,
    })
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`)
    const audio = asBuffer(Buffer.from(await res.arrayBuffer()))
    // LOCAL FORK (production patch #4a): matching audio/wav mime.
    return { ok: audio.length > 0, provider: 'openai', audio, mime: 'audio/wav', reason: audio.length ? '' : 'empty audio' }
    } finally {
      cleanup()
    }
  }
  function openaiCompatible(key) {
    const spec = OPENAI_COMPATIBLE[key]
    return async function speak() {
      const keyEnv = (cfg[key + 'KeyEnv'] || spec.keyEnv)
      const token = await resolveKey(keyEnv)
      if (!token) return { ok: false, provider: key, reason: `no ${keyEnv}` }
      const base = cfg[key + 'BaseUrl'] || spec.baseUrl
      if (!base) return { ok: false, provider: key, reason: 'no base url configured' }
      const { signal, cleanup } = withCloudTimeout()
      try {
        const res = await fetchImpl(base + '/audio/speech', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: pick(DEFAULT_MODELS, models, key),
          input: text,
          voice: pick(DEFAULT_VOICES, voices, key),
          // LOCAL FORK (production patch #4b): the local qwentts.cpp server returns
          // WAV on /v1/audio/speech, so the `custom` provider must ask for wav.
          response_format: key === 'custom' ? 'wav' : 'mp3',
          // LOCAL FORK (0.4.16-local.8): empty unless this provider is named in
          // `samplingProviders`, so by default this body is unchanged.
          ...samplingFieldsFor(cfg, key),
        }),
        signal,
      })
      if (!res.ok) throw new Error(`${key} HTTP ${res.status}`)
      const audio = asBuffer(Buffer.from(await res.arrayBuffer()))
      // LOCAL FORK (production patch #4b): matching audio/wav mime for `custom`.
      return { ok: audio.length > 0, provider: key, audio, mime: key === 'custom' ? 'audio/wav' : 'audio/mpeg', reason: audio.length ? '' : 'empty audio' }
      } finally {
        cleanup()
      }
    }
  }
  async function mimo() {
    const key = await resolveKey(cfg.mimoKeyEnv)
    if (!key) return { ok: false, provider: 'mimo', reason: `no ${cfg.mimoKeyEnv}` }
    const base = (cfg.mimoBaseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '')
    const format = cfg.mimoFormat === 'wav' ? 'wav' : 'mp3'
    const { signal, cleanup } = withCloudTimeout()
    try {
      const res = await fetchImpl(base + '/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        model: pick(DEFAULT_MODELS, models, 'mimo'),
        messages: [{ role: 'assistant', content: text }],
        audio: { format, voice: pick(DEFAULT_VOICES, voices, 'mimo') },
        stream: false,
      }),
      signal,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const detail = data && data.error && data.error.message
      throw new Error(`MiMo HTTP ${res.status}${detail ? ': ' + detail : ''}`)
    }
    const encoded = data && data.choices && data.choices[0]
      && data.choices[0].message && data.choices[0].message.audio
      && data.choices[0].message.audio.data
    if (typeof encoded !== 'string' || !encoded) {
      return { ok: false, provider: 'mimo', reason: 'response missing choices[0].message.audio.data' }
    }
    const audio = Buffer.from(encoded, 'base64')
    return {
      ok: audio.length > 0,
      provider: 'mimo',
      audio,
      mime: format === 'wav' ? 'audio/wav' : 'audio/mpeg',
      reason: audio.length ? '' : 'empty audio',
    }
    } finally {
      cleanup()
    }
  }
  async function elevenlabs() {
    const key = await resolveKey(cfg.elevenlabsKeyEnv)
    if (!key) return { ok: false, provider: 'elevenlabs', reason: `no ${cfg.elevenlabsKeyEnv}` }
    const voice = pick(DEFAULT_VOICES, voices, 'elevenlabs')
    const { signal, cleanup } = withCloudTimeout()
    try {
      const res = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: pick(DEFAULT_MODELS, models, 'elevenlabs'),
      }),
      signal,
    })
    if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}`)
    const audio = asBuffer(Buffer.from(await res.arrayBuffer()))
    return { ok: audio.length > 0, provider: 'elevenlabs', audio, mime: 'audio/mpeg', reason: audio.length ? '' : 'empty audio' }
    } finally {
      cleanup()
    }
  }
  async function google() {
    const key = await resolveKey(cfg.googleKeyEnv)
    if (!key) return { ok: false, provider: 'google', reason: `no ${cfg.googleKeyEnv}` }
    const model = pick(DEFAULT_MODELS, models, 'google')
    const voiceName = pick(DEFAULT_VOICES, voices, 'google')
    const { signal, cleanup } = withCloudTimeout()
    try {
      const res = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
          },
        }),
        signal,
      },
    )
    if (!res.ok) throw new Error(`Google HTTP ${res.status}`)
    const data = await res.json()
    const b64 = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data
    if (!b64) return { ok: false, provider: 'google', reason: 'no inline audio' }
    const audio = Buffer.from(b64, 'base64')
    return { ok: audio.length > 0, provider: 'google', audio, mime: 'audio/wav', reason: audio.length ? '' : 'empty audio' }
    } finally {
      cleanup()
    }
  }
  async function azure() {
    const key = await resolveKey(cfg.azureKeyEnv)
    if (!key) return { ok: false, provider: 'azure', reason: `no ${cfg.azureKeyEnv}` }
    const region = (cfg.azureRegion || '').trim()
    if (!region) return { ok: false, provider: 'azure', reason: 'azureRegion is empty' }
    const voice = pick(DEFAULT_VOICES, voices, 'azure')
    const roleCfg = req.role && cfg.roles && cfg.roles[req.role]
    const style = roleCfg && roleCfg.ssmlStyle
    const safeStyle = style ? String(style).replace(/["<>&]/g, '') : ''
    const inner = safeStyle
      ? `<mstts:express-as style="${safeStyle}">${escapeXml(text)}</mstts:express-as>`
      : escapeXml(text)
    const ssml = `<speak version="1.0" xml:lang="${lang || 'en-US'}">`
      + `<voice xml:lang="${lang || 'en-US'}" name="${voice}">`
      + `${inner}</voice></speak>`
    const { signal, cleanup } = withCloudTimeout()
    try {
      const res = await fetchImpl(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
      },
      body: ssml,
      signal,
    })
    if (!res.ok) throw new Error(`Azure HTTP ${res.status}`)
    const audio = asBuffer(Buffer.from(await res.arrayBuffer()))
    return { ok: audio.length > 0, provider: 'azure', audio, mime: 'audio/mpeg', reason: audio.length ? '' : 'empty audio' }
    } finally {
      cleanup()
    }
  }
  async function groq() {
    const key = await resolveKey(cfg.groqKeyEnv)
    if (!key) return { ok: false, provider: 'groq', reason: `no ${cfg.groqKeyEnv}` }
    const { signal, cleanup } = withCloudTimeout()
    try {
      const res = await fetchImpl('https://api.groq.com/openai/v1/audio/speech', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: pick(DEFAULT_MODELS, models, 'groq'),
        input: text,
        voice: pick(DEFAULT_VOICES, voices, 'groq'),
        response_format: 'mp3',
      }),
      signal,
    })
    if (!res.ok) throw new Error(`Groq HTTP ${res.status}`)
    const audio = asBuffer(Buffer.from(await res.arrayBuffer()))
    return { ok: audio.length > 0, provider: 'groq', audio, mime: 'audio/mpeg', reason: audio.length ? '' : 'empty audio' }
    } finally {
      cleanup()
    }
  }
  async function deepgram() {
    const key = await resolveKey(cfg.deepgramKeyEnv)
    if (!key) return { ok: false, provider: 'deepgram', reason: `no ${cfg.deepgramKeyEnv}` }
    const model = pick(DEFAULT_MODELS, models, 'deepgram')
    const { signal, cleanup } = withCloudTimeout()
    try {
      const res = await fetchImpl(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}`, {
      method: 'POST',
      headers: { authorization: `Token ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    })
    if (!res.ok) throw new Error(`Deepgram HTTP ${res.status}`)
    const audio = asBuffer(Buffer.from(await res.arrayBuffer()))
    return { ok: audio.length > 0, provider: 'deepgram', audio, mime: 'audio/mpeg', reason: audio.length ? '' : 'empty audio' }
    } finally {
      cleanup()
    }
  }
  async function openrouter() {
    const key = await resolveKey(cfg.openrouterKeyEnv)
    if (!key) return { ok: false, provider: 'openrouter', reason: `no ${cfg.openrouterKeyEnv}` }
    const { signal, cleanup } = withCloudTimeout()
    try {
      const res = await fetchImpl('https://openrouter.ai/api/v1/audio/speech', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: pick(DEFAULT_MODELS, models, 'openrouter'),
        input: text,
        voice: pick(DEFAULT_VOICES, voices, 'openrouter'),
        response_format: 'mp3',
      }),
      signal,
    })
    if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`)
    const audio = asBuffer(Buffer.from(await res.arrayBuffer()))
    return { ok: audio.length > 0, provider: 'openrouter', audio, mime: 'audio/mpeg', reason: audio.length ? '' : 'empty audio' }
    } finally {
      cleanup()
    }
  }

  const compatible = {}
  for (const key of Object.keys(OPENAI_COMPATIBLE)) {
    compatible[key] = openaiCompatible(key)
  }

  return { openai, elevenlabs, google, azure, groq, deepgram, openrouter, mimo, ...compatible }
}

