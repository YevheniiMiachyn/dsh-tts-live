/**
 * Tests for per-request sampler overrides (0.4.16-local.8).
 *
 * qwentts.cpp — the local server this profile speaks through — accepts
 * temperature, top_k, top_p and repetition_penalty, a second sampler for the
 * sub-talker that draws the acoustic codes, and an explicit seed. Upstream sent
 * none of them, so every sentence was a fresh draw at the endpoint's defaults
 * (0.9 / 50 / 1.0 on both stacks, random seed).
 *
 * The invariant that matters is NOT "the fields are sent". It is:
 *
 *   - nothing is sent unless a provider is named, so the request bodies stay
 *     byte-identical to upstream and an OpenAI-compatible cloud vendor is never
 *     handed a field it would reject with a 400;
 *   - a value the server would refuse is dropped rather than sent, because a 4xx
 *     here fails the provider and, with one provider in the chain, silences her.
 *
 * Run: node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeCloudProviders, samplingFieldsFor, samplingSignature } from '../lib/providers/cloud.js'

const TEXT = 'Mm, this is the sentence being synthesized.'
const UPSTREAM_BODY = {
  model: 'qwen3-tts-akeno',
  input: TEXT,
  voice: 'akeno',
  response_format: 'wav',
}

/** Drive the real provider with a stubbed fetch and hand back the raw body. */
async function bodyFor(key, cfg) {
  let raw = null
  const deps = {
    resolveKey: async () => 'local',
    fetchImpl: async (url, init) => {
      raw = init.body
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }
    },
    cfg: {
      customBaseUrl: 'http://127.0.0.1:18080/v1',
      customKeyEnv: 'CUSTOM_TTS_API_KEY',
      ...cfg,
    },
  }
  const providers = makeCloudProviders(
    deps,
    { text: TEXT, lang: 'en', models: { custom: 'qwen3-tts-akeno' }, voices: { custom: 'akeno' }, role: 'reply' },
    () => ({ signal: undefined, cleanup: () => {} }),
  )
  const out = await providers[key]()
  assert.ok(out && out.ok, `${key} should have synthesized: ${JSON.stringify(out)}`)
  return { raw, body: JSON.parse(raw) }
}

test('with nothing configured the body is byte-identical to upstream', async () => {
  const { raw, body } = await bodyFor('custom', {})
  assert.equal(raw, JSON.stringify(UPSTREAM_BODY))
  assert.deepEqual(Object.keys(body), ['model', 'input', 'voice', 'response_format'])
})

test('a named provider receives the fields on the wire names qwentts.cpp parses', async () => {
  const { body } = await bodyFor('custom', {
    samplingProviders: ['custom'],
    samplingTemperature: 0.8,
    samplingTopK: 30,
    samplingTopP: 0.95,
    samplingRepetitionPenalty: 1.05,
    samplingSubtalkerTemperature: 0.7,
    samplingSubtalkerTopK: 20,
    samplingSubtalkerTopP: 0.9,
    samplingSeed: 4242,
  })
  assert.deepEqual(body, {
    ...UPSTREAM_BODY,
    temperature: 0.8,
    top_k: 30,
    top_p: 0.95,
    repetition_penalty: 1.05,
    subtalker_temperature: 0.7,
    subtalker_top_k: 20,
    subtalker_top_p: 0.9,
    seed: 4242,
  })
})

test('unconfigured fields are omitted, never sent as the -1 sentinel', async () => {
  const { raw, body } = await bodyFor('custom', { samplingProviders: ['custom'] })
  assert.equal(raw, JSON.stringify(UPSTREAM_BODY))
  assert.deepEqual(Object.keys(body), ['model', 'input', 'voice', 'response_format'])
})

test('a value the server would refuse is dropped instead of sent', async () => {
  const { body } = await bodyFor('custom', {
    samplingProviders: ['custom'],
    samplingTemperature: 0,       // legitimate: greedy decoding
    samplingTopK: -1,             // unset
    samplingTopP: 0,              // outside the server's (0, 1] range
    samplingRepetitionPenalty: 0, // must be strictly positive
    samplingSubtalkerTopP: 1.5,   // outside the range
    samplingSeed: 12.5,           // not an integer
  })
  assert.equal(body.temperature, 0, 'greedy is a legitimate request and must survive')
  for (const dropped of ['top_k', 'top_p', 'repetition_penalty', 'subtalker_top_p', 'seed']) {
    assert.ok(!(dropped in body), `${dropped} must be dropped, body was ${JSON.stringify(body)}`)
  }
})

test('a cloud provider that is not named keeps its body exactly as it was', async () => {
  const { raw } = await bodyFor('siliconflow', {
    samplingProviders: ['custom'],
    samplingTemperature: 0.5,
    samplingSubtalkerTopK: 10,
  })
  assert.ok(!/temperature|top_k|top_p|subtalker|seed|repetition/.test(raw), `nothing may leak: ${raw}`)
})

test('samplingFieldsFor answers for one provider at a time', () => {
  assert.deepEqual(samplingFieldsFor({ samplingTemperature: 0.5 }, 'custom'), {}, 'no list means no fields')
  assert.deepEqual(samplingFieldsFor({ samplingProviders: ['custom'], samplingTemperature: 0.5 }, 'openai'), {})
  assert.deepEqual(samplingFieldsFor({ samplingProviders: ['custom'], samplingTemperature: 0.5 }, 'custom'), {
    temperature: 0.5,
  })
})

test('the cache signature is empty until sampling is configured', () => {
  assert.equal(samplingSignature({}), '')
  assert.equal(samplingSignature({ samplingProviders: [] }), '')
  assert.equal(samplingSignature({ samplingTemperature: 0.8 }), '', 'fields alone change nothing')
})

test('the cache signature is order independent and covers every field', () => {
  const a = samplingSignature({ samplingProviders: ['siliconflow', 'custom'], samplingTemperature: 0.8 })
  const b = samplingSignature({ samplingProviders: ['custom', 'siliconflow'], samplingTemperature: 0.8 })
  assert.equal(a, b, 'the same configuration must sign the same')
  assert.notEqual(a, samplingSignature({ samplingProviders: ['custom', 'siliconflow'], samplingTemperature: 0.7 }))
  assert.notEqual(a, samplingSignature({ samplingProviders: ['custom', 'siliconflow'], samplingSeed: 1 }))
})
