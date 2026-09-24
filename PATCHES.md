# Local fork provenance and patch ledger

Fork of **`@goodandready/dsh-tts` 0.4.16** (upstream:
<https://github.com/GooDAnDReaDY/dsh-tts>, MIT), maintained for a private local
DSH voice stack that speaks through a local Qwen TTS backend.

## Commit 1 — upstream verbatim

`upstream: @goodandready/dsh-tts 0.4.16 (npm tarball shasum 0516c0c9613efe5ca666738179ba34570802b92e)`

Obtained with `npm pack @goodandready/dsh-tts@0.4.16`; the tarball was extracted
into this repository unmodified, so commit 1 is byte-identical to the published
package. Upstream project: <https://github.com/GooDAnDReaDY/dsh-tts> (MIT).

## Commit 2 — production patch layer (parity with the running install)

The production install — the plugin directory inside a DSH profile, i.e.
`<dsh-profile>/node_modules/@goodandready/dsh-tts` — carried five hand edits that
exist in no published release. They are reproduced
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

## Commit 4 — duplicate live-tail publish fix (0.4.16-local.3)

`lib/live.js`: the ownership cursor now claims an exact raw range (`claimedEnd` /
`spokenRaw = raw.slice(0, claimedEnd)`) instead of a re-rendered "pieces joined by
one space" string; `reconcileRemainder` aligns on whitespace-normalized text before
the raw common-prefix fallback; a settled step keeps its claim record and returns an
empty remainder on a repeat settlement; a retried attempt drops the abandoned
attempt's unclaimed tail and filters its echo of already-claimed text out of `raw`.

`lib/index.js`: an empty settlement remainder never reserves a queue slot.

Found by the production promotion smoke (`u6`/`u7`: one synthesis, two publications);
see the defect log in `LIVE-SENTENCE.md`. Regression coverage:
`test/dup-publish.test.mjs` (24 tests, including two integration reproducers that
drive the real plugin with a held-open `fetch`, and a publication-accounting check
against `/dsh-tts/stats`).

## Commit 5 — barge-in silences the rest of the turn (0.4.16-local.4)

### The defect

The user talks over the assistant by pressing the microphone, expecting it to stop.
It stopped *sometimes*: reliably for a reply that had already finished streaming, and
not for a longer one still being generated.

Aborting in-flight synthesis and dropping the queued slots stops speech **now**. It
does not stop speech **resuming**. The agent loop keeps emitting frames for the same
turn after the barge-in, and every sentence completed afterwards was flushed, claimed
and synthesized as usual — the reply picked up again a moment later, mid-thought.

Three separate holes fed the same symptom:

| hole | effect |
|---|---|
| `abortAll` aborted controllers and dropped the queue but left the cursor alive | the next completed sentence of the same turn was spoken |
| nothing ever dispatched `dsh:tts:start` / `dsh:tts:stop` | dsh-voice *listened* for both and nothing sent them, so its `isTtsSpeaking` was permanently false and its own barge-in path was dead code |
| the host barge-in POST was gated on `player.liveEnabled` | with live sentence streaming off, a piece still synthesizing settled into the queue and was collected by the next poll |

### `lib/live.js` — per-turn silence

`abortAll(sid)` now also records `${sid}|${turn}` in `mutedTurns`, for every live
cursor (via `cursor.turn`) **and** for the turn currently streaming (tracked in
`currentTurn` from each `start` frame). The second source matters: a barge-in can land
before the first sentence was ever flushed, or between two steps of a multi-step turn,
when there is no piece to abort yet but the turn is about to speak.

`speak()` returns early for a muted turn. This is the whole mechanism, and it is safe
precisely because `drainPieces` **claims** `raw` before returning pieces: a silenced
sentence is still owned by the step, so the settlement reconcile can never read it as
unsaid text and speak it from the durable path afterwards. The claim advances; only
the audio is suppressed.

`onSettledMessage()` checks the mute **first**. The cursor can hold zero pieces when
the barge-in beat the first sentence, and the existing `pieces === 0` fallback would
have handed the *entire* message back to be spoken — the loudest possible version of
the talk-over. A silenced settlement marks its cursor settled (so a duplicate
settlement event still cannot fall through) and releases its own mute entry.

Mutes are **not** pruned by turn order. A settlement can arrive after the next turn
has already started streaming — the ordering a fast follow-up produces — and clearing
the mute there would read the silenced remainder aloud over the new reply. Turn numbers
only increase for a session, so a stale entry can never silence a later turn; the map
is bounded by `MUTE_CAP = 64` instead.

### `lib/client-src/20-player.js` — playback state and one barge-in path

- `announceSpeech(on)` dispatches `dsh:tts:start` / `dsh:tts:stop` on edges only.
  Started from a successful `audio.play()`, ended when the queue drains and nothing is
  playing, and on `stopPlayback()`. dsh-voice's `isTtsSpeaking` is now truthful.
- `bargeInNow()` holds the single hard-stop implementation, and the `/dsh-tts/bargein`
  POST is no longer gated on live mode: the durable path has a pending queue too.
- `dsh:tts:cancel` is now **listened** for as well as dispatched. It is authoritative —
  the voice plugin has already decided that the user talking wins, so it is not
  re-gated on the TTS-side `bargeIn` setting, which still governs the implicit
  `dsh-voice:speaking` path.

### Deployment requirement

`isTtsSpeaking` being truthful activates dsh-voice's turn-taking gate. With the plugin
defaults (`bargeIn: false`, `gatedTurnTaking: true`) pressing the microphone during
speech now refuses with *Assistant speaking (gated mode)* instead of barging in. The
profile therefore sets `bargeIn: true`; `micHoldMs: 0` remains the way to release the
device immediately.

### Regression coverage

`test/bargein.test.mjs` (12 tests) drives the engine with the exact window this defect
lived in — text arriving after the barge-in — and asserts the piece that was already
audible stays audible, later text is claimed but never spoken in both the `pieces > 0`
and `pieces === 0` shapes, later steps and later frames of the interrupted turn stay
silent, a duplicate settlement cannot resurrect it, a *following* turn speaks again,
and the mute map stays capped. `test/bargein-wiring.test.mjs` (4 tests) reads the
**built** `lib/client.js` for the client half so a rebase cannot quietly drop it; every
assertion was negative-controlled against the pre-patch bundle (6 of 7 checks fail
there, 7 of 7 pass here).

## Commit 6 — inline code is spoken, not deleted (0.4.16-local.5)

### The defect

`stripForSpeech` replaced every inline `` `span` `` with a single space, so a reply
containing identifiers was spoken with holes in it. Heard live, from a real reply:

> Everything the restart needed to pick up is live: **now reads True** (it was false
> before), the installed plugin **is ,** and the Akeno voice re-registered.

Three things vanished from the audio — a setting name, a version, and the words that
connected them — and the result still sounded like a sentence, which is why it read as
a glitch rather than a bug. Deleting a fenced block is right; deleting an identifier
inside prose is not.

### `lib/text.js`

- Inline spans are **unwrapped** (`` `x` `` → `x`) instead of deleted. `skipCode: false`
  still leaves all markup untouched, and fenced blocks still become
  *"code block, N lines"*.
- `protectAbbreviations` gained one rule: a dot preceded by a letter or digit and
  followed by a digit. The existing rule only covered digits-dot-digits, so it stopped
  at `0.4.16` and left the last dot of `0.4.16-local.4` — the sentence cutter then
  broke the identifier in two and spoke *"0.4.16-local. 4"*. No sentence boundary has a
  digit immediately after the dot without a space, so this cannot swallow one.

Both changes are on the shared `cleanText` path, so live sentence flush and the durable
settlement cannot disagree about what a sentence says.

### Regression coverage

`test/spoken-code.test.mjs` (8 tests) asserts the invariant that matters — *no hole in
the sentence* (`!/is\s+,/`) — rather than only the presence of the missing text, and it
uses the real sentence that was heard garbled. It also pins the fenced-block notice
line count, `skipCode: false`, several spans in one sentence, spans at sentence edges,
and that an unwrapped version survives sentence splitting as one piece.

Negative-controlled against `git show HEAD:lib/text.js`: the pre-patch module speaks the
garbled sentence above and fails three of four checks; the patched module passes all
four.

`lib/client.js` is byte-identical to local.4 in this commit — the browser half is
untouched, so the recorded client hash stays valid across both versions and only the
host half changes.

## Commit 7 — silent mode (0.4.16-local.6)

### What it is for

The stack speaks every reply. That is right when somebody is at the machine and wrong
when nobody is: the TTS model is loaded beside the primary model on the same single
GPU, so every spoken sentence is inference spent talking to an empty room.

Silent mode is the switch that says *nobody is listening right now*. It is turned on by
the agent when the user says he is going out or wants quiet, and off again when he is
back.

### Why it is a runtime flag and not a setting

It was first written as a `speechMuted` field in the plugin config, persisted to
`settings.yaml`. That was wrong, and the correction is the point of this commit:

| | persisted setting | runtime flag (shipped) |
|---|---|---|
| meaning | how the stack is configured to behave | who is in the room for the next hour |
| after a restart | silently still mute — the stack looks broken | speech is enabled; the profile decides |
| failure mode | a forgotten mute outlives the reason for it | cannot outlive the process |

So the state lives in one closure variable inside `apply()`, is never written to
`settings.yaml`, and cannot be stored, restored or inherited. Every start begins with
speech enabled and the profile's own `speakReplies` deciding whether replies are spoken
at all. (It is deliberately *not* the same switch as `speakReplies`: that one is the
standing preference, this one is a moment in time.)

### The gate

`lib/index.js`, one predicate consulted at three points:

- **`speakPiece()`** — the single choke point every automatic path funnels through: the
  live sentence flush, speak-as-it-goes, the settled remainder, turn-end pieces and
  announcements. The return sits before the queue slot is reserved and before the
  provider chain is entered, so *muted* means **no request reached the TTS provider**,
  not merely *no audio came out*. Callers keep their own bookkeeping, which is why
  unmuting mid-reply speaks only what has not been said yet instead of replaying the
  reply from the start.
- **`announce()`** — approval and question announcements, including their chimes. An
  announcement exists to attract attention; silent mode means there is nobody to attract.
- **the `speak_text` tool** — declines with `muted: true` rather than synthesizing and
  discarding the audio, and says why, so a caller unmutes deliberately instead of
  quietly failing to be heard.

### Control surface

- **`set_speech_output`** — the agent-facing tool (`{ muted, reason }`; called with no
  argument it only reports). Turning silent mode **on** also calls the barge-in path
  (`liveEngine.abortAll()`), because *nobody is listening* has to be true of the
  sentence being read right now, not only of the next one.
- **`POST /dsh-tts/silence`** (`{ muted }`, `GET` reports) — for a script, a shortcut or
  a future UI button, so the switch does not depend on an agent being in the loop.
- **`/dsh-tts/status`** — `speechMuted` (the runtime state) and `speechSuppressed`
  (`speechMuted || !speakReplies`), so "silent because nobody is here" and "reply speech
  is configured off" cannot be mistaken for each other.

One setter (`setSpeechMuted`) backs the tool and the route, so they cannot drift apart.

### Client

`lib/client-src/20-player.js`, one line: `player.enabled` now also requires
`!meta.speechMuted`. The muted browser therefore behaves exactly as it already does
when reply speech is unchecked — no `/dsh-tts/pending` poll and no playback — instead of
introducing a new client state to reason about. No new UI: the switch is the agent's and
the route's, and the standing preference stays where it was.

### Regression coverage

`test/silent-mode.test.mjs` (10 tests) drives the real plugin under a fake Cordis
context with `fetch` stubbed, so `calls` is an exact record of every synthesis attempt.
Every muted assertion has an unmuted control driving the same turn, because a gate that
blocked everything — or a harness that never reached the synthesizer — must fail rather
than pass quietly. It also asserts the schema does **not** contain `speechMuted` (the
runtime-only invariant) and that two `apply()` calls get independent state.

`test/wiring.test.mjs` needed one update: it asserted that the *last* registered tool was
`speak_text`, which a second tool invalidates. It now asserts both tools by name.

`verify-parity.mjs`: all production patches intact.

## Commit 8 — a cancellation is not a provider failure (0.4.16-local.7)

### The defect, found while validating silent mode

Live, on the production stack, a minute after muting: `speak_text` answered

> TTS failed: all providers failed (custom: circuit open (cooldown))

while the TTS server was demonstrably healthy — the `akeno` voice registered, and a direct
request to `127.0.0.1:18080` returned a 96 KB WAV. The breaker snapshot held the explanation:

| field | value |
|---|---|
| `failCount` | 3 |
| `lastError` | `live-sentence: turn cancelled` |
| `open` | true, ~60 s cooldown |

Silent mode runs the same hard stop as a barge-in (`liveEngine.abortAll()`), so the in-flight
synthesis of the reply before it — three pieces — was aborted. Each abort rejected *inside the
provider wrapper*, which recorded it as a provider **failure**. Three of them reached the
threshold and opened the circuit.

User-visible consequence: **interrupting Akeno, or muting her, could silence her for a minute**,
and during that minute nothing could be spoken at all. `stats.errors` counted them too — 7
"errors" against 4 successes in the measured window, which reads as a failing provider rather
than a working one.

Correction to the record: the local.3 promotion notes stated "`stats.errors` counts barge-in
cancellations; the breaker correctly ignores them (`failCount` stays 0)". It did not. Nothing in
the code distinguished a cancellation from a failure; that claim was never true of this path.

### The fix

- **`lib/breaker.js`** — new `isCancellation(error)` (recognizes an `AbortError` name, or an
  `abort`/`cancel` message, including a signal *reason*), and an exported `TIMEOUT_REASON`.
- **`lib/index.js`**, **`lib/routes.js`** — our own synthesis timeout now aborts with
  `new Error(TIMEOUT_REASON)`. That is what keeps the distinction decidable: an abort-family
  error that is not the timeout is a cancellation, while a provider that accepts a request and
  never answers is still a failure.
- **The provider wrapper** records a failure only when `isCancellation()` says no — for thrown
  errors *and* for `{ ok: false, reason }` results.

### Regression coverage

`test/breaker-cancel.test.mjs` (3 tests). The first drives three in-flight syntheses, mutes (the
production trigger), and asserts `failCount 0` / circuit closed / the next turn synthesizes
immediately. Negative-controlled: on the pre-fix code it fails with exactly the live signature —
`failCount 3`, `lastError live-sentence: turn cancelled` — and the harness's held-open `fetch`
stub honours the abort signal the way undici does, so the rejection is real.

The two controls exist precisely because the fix makes failures *skip*: a genuine provider error
(`ECONNREFUSED`) and a hung provider past `timeoutMs` must still open the circuit. Both do.


## `0.4.16-local.8` — per-request sampler overrides

Upstream sent no sampler parameters at all: the OpenAI-compatible body carried only `model`,
`input`, `voice` and `response_format`, so how each sentence was drawn was left entirely to the
endpoint. The local qwentts.cpp server defaults to temperature 0.9, top_k 50, top_p 1.0 and a
**fresh random seed per request** on both the talker and the sub-talker — and the sub-talker is
what draws the acoustic codes, i.e. timbre.

### The change

- **`lib/index.js`** — nine config keys: `samplingProviders` (default `[]`) plus eight values, each
  defaulting to the `-1` "unset" sentinel.
- **`lib/providers/cloud.js`** — `samplingFieldsFor(cfg, key)` maps config onto the wire names the
  server parses and enforces its accepted ranges; the spread lands in the OpenAI-compatible body.
  `samplingSignature(cfg)` is its cache-key counterpart.
- **`lib/index.js`** — the signature joins the synthesis cache key and the in-flight key, via a
  `keyFor()` that appends it only when sampling is configured. Both keys stay byte-identical to
  upstream in the default configuration.

### Why it ships inert

Identity was measured with the repo's own speaker encoder rather than by ear: at default sampling
the x-vector is 0.98 to the Akeno reference and 0.99 take-to-take, so there was no identity drift
for a sampler change to fix. Tightening the sub-talker therefore buys nothing and is left off. The
one setting that *does* move identity is greedy on the talker, which is catastrophic rather than
subtle: 163.84 s runaways and 0.84 similarity. Details and the full measurement table: `SAMPLING.md`.

### Regression coverage

`test/sampling.test.mjs` (8 tests). The invariants asserted are the ones that matter operationally:
byte-identical bodies with nothing configured, wire names when a provider is named, sentinels
omitted rather than sent as `-1`, out-of-range values dropped instead of sent (a 4xx would fail the
provider and, with one chain entry, silence her), no leakage into an unnamed provider, and
signature emptiness/stability. `lib/client.js` is byte-identical to local.7 — this is a host-only
release.


