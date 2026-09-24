# Per-request sampler overrides — `0.4.16-local.8`

Upstream sent no sampler parameters at all. Every request carried only `model`,
`input`, `voice` and `response_format`, so the endpoint's own defaults decided how
each sentence was drawn.

For the local qwentts.cpp server those defaults are (src/sampling-defaults.h):

| parameter | default |
|---|---|
| `temperature` | 0.9 |
| `top_k` | 50 |
| `top_p` | 1.0 |
| `repetition_penalty` | 1.05 |
| `subtalker_temperature` | 0.9 |
| `subtalker_top_k` | 50 |
| `subtalker_top_p` | 1.0 |
| `seed` | `-1` — a fresh random seed per request |

The talker draws the text-conditioned hidden states; the **sub-talker draws the
acoustic codes, which is where timbre lives**. With a random seed per request,
every sentence was an independent draw.

## What was measured before shipping this

Identity was checked with the repo's own speaker encoder, not by ear: for each
generated take `qwen-codec.exe --model <codec> -i take.wav --talker <talker gguf>`
writes an x-vector `.spk`, and its cosine against
`voices/akeno/akeno_ref_clean.spk` is "how much of Akeno is in this take".

| arm | cos to reference | take-to-take | pacing spread |
|---|---|---|---|
| server defaults | 0.98 | 0.99 | 0.80 s |
| sub-talker temperature 0 | 0.97 | 0.99 | 1.60 s |
| sub-talker 0.6 / top_k 20 | 0.98 | 0.99 | 4.24 s |
| **talker temperature 0** | **0.84** | 0.99 | 0.00 s |

Two conclusions, both of which shaped this release:

1. **At default sampling the voice is not drifting.** 0.98 to the reference and
   0.99 between takes. Tightening the sub-talker buys no identity, so this feature
   ships as a *capability* rather than as a new default: nothing changes until a
   provider is named in `samplingProviders`.
2. **Greedy on the talker is a trap.** All three takes ran away to **163.84 s**
   (~22 s to generate) and the voice came back measurably different (0.84).
   163.84 s is exactly `max_new_tokens` 2048 × the 80 ms codec hop: the model never
   emitted an end token. It also explains the earlier 163.8 s runaway recorded
   against a heart glyph. `temperature: 0` on the *sub-talker* is safe; on the
   talker it is not.

If audible variation remains after this, the measured candidate is **delivery**,
not identity: pacing varied up to 4 s on one sentence, and live mode synthesizes
each piece independently, so prosody restarts at every piece boundary.

## Two rules that make it safe

- **Only named providers receive the fields.** `samplingProviders` defaults to an
  empty list, so every request body stays byte-identical to upstream and no
  OpenAI-compatible cloud vendor is handed a field it would reject with a 400.
- **A value the server would refuse is dropped, not sent.** Because a 4xx here
  fails the provider and the chain has one entry, a bad field would silence her
  rather than degrade gracefully. Ranges are enforced at the wire boundary:

| wire field | config key | sent when |
|---|---|---|
| `temperature` | `samplingTemperature` | `>= 0` (0 is greedy, and IS sent) |
| `top_k` | `samplingTopK` | integer `>= 0` (0 disables the cutoff) |
| `top_p` | `samplingTopP` | `> 0` and `<= 1` |
| `repetition_penalty` | `samplingRepetitionPenalty` | `> 0` |
| `subtalker_temperature` | `samplingSubtalkerTemperature` | `>= 0` |
| `subtalker_top_k` | `samplingSubtalkerTopK` | integer `>= 0` |
| `subtalker_top_p` | `samplingSubtalkerTopP` | `> 0` and `<= 1` |
| `seed` | `samplingSeed` | integer `>= 0`; `-1` means "let the server choose" |

`-1` is the "not configured" sentinel throughout and is omitted rather than sent.
The endpoint's own seed default is already `-1`, so omitting it reproduces upstream
behaviour exactly: **repeatability is one explicit non-negative seed away.**

The sampler also joins the synthesis cache key and the in-flight key
(`samplingSignature`), because it is part of what produced the audio — without
that a take synthesized at one temperature could be served for another. The
signature is `''` until sampling is configured, so both keys remain byte-identical
to upstream by default.

## Configuration

```yaml
dsh-tts:
  samplingProviders:
    - custom
  # Talker: leave the endpoint default (or lower slightly to steady pacing).
  samplingTemperature: 0.8
  samplingTopK: 30
  # Sub-talker: this is the timbre knob.
  samplingSubtalkerTemperature: 0.7
  samplingSubtalkerTopK: 20
  # Reproducible audio for the same text when testing.
  samplingSeed: 4242
```

## Verification

- `node --test test/sampling.test.mjs` — 8 tests: byte-identical body with nothing
  configured, wire names when named, sentinels omitted, out-of-range values
  dropped, no leakage into an unnamed provider, and signature parity/stability.
- `node scripts/verify-parity.mjs <installed plugin dir>` — production patches
  intact, and comment-normalized parity with the install for the host files.
- Probe scripts used for the measurement above:
  `C:\Users\Jenya\dsh-tts-trace\sampling-probe.ps1` and `spk-similarity.ps1`.
