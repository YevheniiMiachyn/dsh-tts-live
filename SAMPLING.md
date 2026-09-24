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
behaviour exactly.

**Correction (2026-09-24).** An earlier draft of this document claimed that
"repeatability is one explicit non-negative seed away". It is not, and the claim was
falsified by measurement before it could mislead anyone: the same text with
`seed: 4242` sent twice came back **4.16 s and 3.68 s**. The seed demonstrably
influences generation — a different seed gives different audio — but qwentts.cpp
advances an RNG sub-sequence per request, so identical seeds do **not** pin
identical output. Nothing may rely on byte-identical audio from a fixed seed.

The sampler also joins the synthesis cache key and the in-flight key
(`samplingSignature`), because it is part of what produced the audio — without
that a take synthesized at one temperature could be served for another. The
signature is `''` until sampling is configured, so both keys remain byte-identical
to upstream by default.

## Which knob does what — measured

Identity was never the problem, so the second question was *delivery*. Four takes
per arm, same 205-character passage, 2026-09-24:

| arm | duration spread | spectral spread | cos to reference |
|---|---|---|---|
| endpoint defaults | 25.2% | 401 | 0.98 |
| talker 0.8 / top_k 30 | 13.7% | 197 | 0.98 |
| **talker 0.6 / top_k 20** | **5.6%** | 131 | 0.98 |
| sub-talker 0.6 / 20 only | 17.9% | 116 | 0.98 |
| talker 0.6/20 + sub 0.6/20 | 14.8% | ~127 | 0.98 |

The **talker is the pacing knob** and the **sub-talker is the timbre knob**, and
neither moves the person: identity stayed at 0.98 to the reference and 0.99
take-to-take in every arm, including the defaults. That is the finding that
matters — what an ear reports as "a slightly different voice" is pacing, not a
different speaker.

Honest limit: with n=4 the last two arms are inside the noise of each other, so
their ranking is the ear's call, not this table's. Reproduce with
`pacing-probe.ps1`.

## Configuration

```yaml
dsh-tts:
  samplingProviders:
    - custom
  # Talker: the PACING knob.
  samplingTemperature: 0.6
  samplingTopK: 20
  # Sub-talker: the TIMBRE knob. It cuts spectral spread about 3x but barely
  # touches pacing, so it is the first pair to relax if she sounds flattened.
  samplingSubtalkerTemperature: 0.6
  samplingSubtalkerTopK: 20
  # NOT a reproducibility switch - see the correction above.
  samplingSeed: -1
```

## Verification

- `node --test test/sampling.test.mjs` — 8 tests: byte-identical body with nothing
  configured, wire names when named, sentinels omitted, out-of-range values
  dropped, no leakage into an unnamed provider, and signature parity/stability.
- `node scripts/verify-parity.mjs <installed plugin dir>` — production patches
  intact, and comment-normalized parity with the install for the host files.
- Probe scripts used for the measurement above:
  `C:\Users\Jenya\dsh-tts-trace\sampling-probe.ps1` and `spk-similarity.ps1`.
