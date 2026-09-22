# Local fork provenance and patch ledger

Fork of **`@goodandready/dsh-tts` 0.4.16** maintained by/for the Jenya AI (Akeno) stack.

## Commit 1 — upstream verbatim

`upstream: @goodandready/dsh-tts 0.4.16 (npm tarball shasum 0516c0c9613efe5ca666738179ba34570802b92e)`

Obtained with `npm pack @goodandready/dsh-tts@0.4.16`; the tarball was extracted
into this repository unmodified, so commit 1 is byte-identical to the published
package. Upstream project: <https://github.com/GooDAnDReaDY/dsh-tts> (MIT).

## Commit 2 — production patch layer (parity with the running install)

The production install at
`C:\Users\Jenya\.dsh\profiles\web\node_modules\@goodandready\dsh-tts`
carried five hand edits that exist in no published release. They are reproduced
here so the fork *is* the running system plus new work, never a behaviour change.

Verified at this commit: with comment lines removed, `lib/client.js`,
`lib/providers.js` and `lib/providers/cloud.js` in this fork are
**byte-identical** to the production files.

After the live-sentence commit the client bundle legitimately diverges (live
mode shortens the pending poll and posts a barge-in), so parity is maintained
from then on by `node scripts/verify-parity.mjs`, which checks every patch as a
content invariant and additionally requires comment-normalized equality with the
running install for the two host files the feature does not touch.

| # | File | Upstream | Production / this fork | Why |
|---|------|----------|------------------------|-----|
| 1 | `lib/client-src/20-player.js` (+ regenerated `lib/client.js`) | `else if (item.error && item.text) await speakInBrowser(item.text)` | `console.error('[dsh-tts] Browser fallback BLOCKED:', item.error, item.text)` | The browser `SpeechSynthesis` fallback spoke provider failures in the wrong (OS) voice, masking real failures. Fork improvement: upstream's edit existed **only** in the built `lib/client.js`, so `npm run build:client` would silently drop it. Here it lives in `client-src` (source of truth) and the bundle is regenerated from it. |
| 2 | `lib/providers.js` | `… : 10000` | `… : 120000` | Local Qwen TTS cold-start synthesis can exceed 10 s; the cap aborted work that would have succeeded. |
| 3 | `lib/providers.js` | `parentSignal.addEventListener(abort, …)` | `parentSignal.addEventListener('abort', …)` | `abort` was a bare identifier — `ReferenceError`, so the listener was never attached and caller cancellation never reached in-flight synthesis. |
| 4a | `lib/providers/cloud.js` (`openai`) | `response_format: 'mp3'`, mime `audio/mpeg` | `response_format: 'wav'`, mime `audio/wav` | Local stack serves WAV. |
| 4b | `lib/providers/cloud.js` (`openaiCompatible`) | `response_format: 'mp3'`, mime `audio/mpeg` | `response_format: key === 'custom' ? 'wav' : 'mp3'`, mime `key === 'custom' ? 'audio/wav' : 'audio/mpeg'` | The `custom` provider is the local qwentts.cpp server, which returns WAV on `/v1/audio/speech`. |

Patch 4b also appended a trailing blank line to `lib/providers/cloud.js`; it is
reproduced verbatim (including its stray CR) so the parity check is exact.

### Production settings this fork must keep working with

```yaml
dsh-tts:
  customBaseUrl: http://127.0.0.1:18080/v1   # qwentts.cpp, voice "akeno", 24 kHz mono WAV
  chain: [{ provider: custom, model: qwen3-tts-akeno, voice: akeno }]
  streamingEnabled: false
  speakAsItGoes: true
  sentenceChars: 320
  timeoutMs: 60000
```

## Commit 3 — live sentence-level TTS flush (new work)

See `LIVE-SENTENCE.md`.
