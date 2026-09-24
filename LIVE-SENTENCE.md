# Live sentence-level TTS flush

Local-fork feature. `/dsh-tts` upstream speaks **settled** `assistant/message`
events; this adds an opt-in path that speaks each sentence the moment the model
finishes producing it.

## Why the upstream path is not live

Traced in dsh 0.1.5-rc.2 and dsh-tts 0.4.16:

```
LLM chunk stream
  └─ dsh-agent-loop: for await (chunk of preparedCall.stream(request))
       └─ AssistantStreamAttempt.push(chunk)
            ├─ durable accumulator + BlockAssembler   (settles later)
            └─ emit('agent/assistant-stream', { frame })   ← live, per delta
  ...
  └─ settle('assistant/message')  → session log event 'assistant/message'
       └─ dsh-tts: ctx.on('session/event')  → cleanText → splitSentences → speakPiece
```

`speakAsItGoes` is therefore **message-level, not token-level**: it speaks each
*message* as it lands, split into sentence pieces. Every step of every turn is
one message, so with a local model the first audible piece waits for the whole
assistant message — including, on step 1, an entire thinking pass.

The only true token-level hook is the process-local
**`agent/assistant-stream`** event: the loop emits a `chunk` frame for every
`StreamChunk` as it arrives from the adapter, before any durable settlement, and
each frame carries `turn`, `step` and an attempt id.

## Architecture

```
agent/assistant-stream (chunk frame, text-delta)
        ↓
LiveCursor (per session|turn|step)
        │  raw visible text, cut offset, spoken text, piece count
        ↓
drainPieces(cursor, opts)
        │  sentence boundaries only; abbreviation/decimal/filename protection;
        │  fenced-code and inline-backtick awareness; min-fragment policy
        ↓
cleanText()  ← the existing scrub/narration/pronunciation pipeline
        ↓
splitSentences() → speakPiece(sid, piece, cfg, role, signal)
        ↓
existing pending queue (reserved slot → settle in place) → browser poll
```

Nothing new is invented for synthesis, caching, queueing, playback and
barge-in: the live path feeds the same `speakPiece` the durable path uses, so
`chain`, `roles`, `customBaseUrl`, the WAV patch, the synthesis cache and the
browser player all behave exactly as before.

Ordering is free: `speakPiece` reserves its queue slot **synchronously** before
awaiting synthesis, so the order of `speakPiece` calls is the order of playback
even when synthesis finishes out of order.

## State and ownership

Keyed by `sessionId|turn|step` (the step's cursor) with an
`attemptId → stepKey` index:

| Field | Meaning |
|---|---|
| `raw` | the step's text: what it already claimed, followed by the current attempt's new text |
| `cursor` | offset of the first character not yet handed to the cutter |
| `claimedEnd` | offset of the first character no piece has claimed yet |
| `spokenRaw` | `raw.slice(0, claimedEnd)` — exactly what this step has claimed |
| `pieces` | how many pieces were spoken (0 ⇒ durable path keeps ownership) |
| `controllers` | abort controllers of in-flight synthesis for this step |
| `echo` | retry echo filter `{ at, remaining }`, or null |
| `settled` | the durable message for this step already reconciled |

### The ownership invariant

**Every raw visible range of one step is claimed exactly once**: spoken, or
discarded by explicit policy (text that scrubs to nothing, an unterminated fence).
A claimed range can never become "unspoken" again. The claim is recorded as an
*offset* (`claimedEnd`) before anything is enqueued, so `spokenRaw` is always the
exact substring of `raw` the step owns — never a re-rendered copy of it.

That distinction is the whole defence:

* `claimedEnd` advances where the cutter hands out a range, so a whitespace run at a
  piece boundary (a paragraph break recorded as one space) cannot make claimed text
  look unclaimed.
* reconciliation aligns the claim with the durable message on whitespace-normalized
  text before falling back to a raw common prefix, so a rendering difference alone
  can never re-emit a spoken tail.
* a step settles once; the record is kept and marked `settled`, so a repeated
  settlement for the same step returns an empty remainder instead of replaying the
  whole message, and late frames from a settled step speak nothing.

`0.4.16-local.2` recorded the claim as "trimmed pieces joined by one space". A
paragraph break at a piece boundary then made the claim differ from the durable
message by exactly one character, the common-prefix fallback treated the
already-spoken tail as unsaid, and the tail was published a second time — with a new
queue id, byte-identical audio (the second submission was coalesced into the
still-in-flight first synthesis) and a synthesis count one lower than the number of
published pieces.

The cursor survives a retry of the same step. On a new attempt the previous
attempt's unclaimed tail is dropped (the retry regenerates it) and the retry's echo
of already-claimed text is filtered out of `raw`, so the retry never re-speaks a
prefix that was already heard and `raw` stays an exact prefix of the durable text.

**Duplicate-speech policy** (the settled message must never replay the stream):

| Live state when `assistant/message` settles | Action |
|---|---|
| no cursor | **fallback** — upstream speaks the whole message |
| cursor with `pieces === 0` | **fallback** — nothing was streamed for this step |
| `durable.startsWith(spokenRaw)` | **remainder** — speak only the unsaid tail |
| equal after whitespace normalization | **remainder** — a paragraph break is not unspoken text |
| genuinely diverged (retry/other text) | **remainder via longest common prefix** (normalized first) + a warning; the claimed prefix is never repeated |
| already settled | **remainder `''`** — a step settles once |
| `turn/end` | cursors are dropped, so a later turn cannot inherit ownership |

## Sentence boundary rules

`scanSafeCuts()` accepts a cut when

* the preceding character is `.` `!` `?` `…` `。` `！` `？`, optionally followed
  by closing punctuation (`."` `?)` `»` …);
* the character *at* the cut is whitespace — a dot at the end of the buffer is
  **never** cut, because the next delta may still continue the token
  (`3.` + `14`, `nt.` + ` Next`);
* the position is outside a fenced code block; and
* inline backticks are balanced up to that point.

Before scanning, the window passes through the existing
`protectAbbreviations()`, which masks the dots in `e.g.`, `p.m.`, `3.14`,
`v0.4.6`, `package.json`, `github.com` and list numbering. Masking is
width-preserving (`.` → `․`), so offsets stay valid, and each emitted piece is
restored with `restoreAbbreviations()`.

An unterminated fence at settlement is **dropped** rather than spoken: the scrub
regex needs the closing fence, so half a fence would be read aloud. A closed
fence is scrubbed by `stripForSpeech` into the usual `code block, N lines`
notice.

## The FIRST piece may start at a clause boundary (0.4.16-local.10)

Sentence-only cutting has one blind spot that costs real time: the first piece is
the only piece whose length is paid for in **time to first audio**, and a reply
that opens with a 200-character sentence pays for all of it. `liveMinCharsFirst:
12` bought nothing there — twelve characters passed within half a second and the
cutter then waited ~9 s more for the full stop.

`scanBoundaries()` now returns two ascending lists from one walk — sentence ends
and **clause ends** (`;` `:` `,` and the em/en dash, each followed by a space,
outside fences and balanced backticks) — and `chooseCut()` applies them
differently to the first piece than to every later one:

| piece | rule |
|---|---|
| **first** of a step | a sentence end at or past `liveMinCharsFirst`; else a clause end at or past **48**; else a word boundary at or before **72** |
| every later piece | a sentence end at or past `liveMinChars`, unchanged |

A clause end must clear 48 characters because a comma typed at character 30 is
not a reason to speak 30 characters; the piece keeps growing until the floor is
met. The word fallback is the other way round — it takes the last whole word that
still fits, because its whole job is to stop the piece growing — and its floor is
`liveMinCharsFirst`, not 72, so a long word cannot push it back to the sentence
end.

48 is deliberately **`LIVE_DEFAULTS.minChars`**, the project's existing
"shorter than this is not worth starting" line, so no new knob and no new
semantic is introduced; 72 is a named constant in `lib/live.js`. Neither is
config: an independent number would make the two live minimums mean something
other than what they are named.

Measured across 484 reply openings in real production sessions, the first
sentence terminator sits at p50 = 63 and p75 = 94 characters, so this is a tail
fix rather than the normal path — which is what keeps the later pieces
sentence-shaped.

`{`/`(`/`[` and markdown punctuation in front of a comma, and any comma with no
space after it (`1,234`, `3,14`, `state-of-the-art`), are rejected as boundaries.

## Minimum-fragment policy

Two thresholds, because the first piece and later pieces have opposite costs:

* `liveMinCharsFirst` (default **12**) — the first piece's only job is to start
  audio, so it is allowed to be short. It is the floor for *every* boundary class
  the first piece may use, including the word fallback.
* `liveMinChars` (default **48**) — later pieces are already overlapped by
  playback, so batching them is free and avoids synthesis churn.

A boundary that is *earlier* than the minimum it is measured against is not a
cut: the piece keeps growing and the next boundary that clears the floor is used.
For later pieces that means a short sentence is joined with the next one; for the
first piece it means the sentence end, the clause end and the word fallback each
have their own floor (12 / 48 / 72) and the first one to arrive wins.

Measured against the existing `sentenceChars: 320`, upstream's own minimum is
`min(60, 320/3) = 60`, which makes a first piece wait for ~60 characters — wrong
for a latency feature, right for later pieces. `12 / 48` keeps the upstream
spirit while prioritising the first sound. `liveMinCharsFirst: 3` reproduces
"speak `Sure.` immediately" and drops the first piece's floors to 3, 48 and 72.

Over-long text is never held: once a window reaches `liveMaxChars`
(`0` ⇒ `sentenceChars`), it is force-cut at the last word boundary, so a
paragraph with no punctuation still starts speaking.

## The poll interval is part of the feature

The browser collects audio by polling `/dsh-tts/pending`. Upstream polls every
**1000 ms** with a fixed `setInterval`, which quantizes the first audible piece
by 0–1000 ms *after* synthesis finishes — it is on the critical path more than
synthesis is. The client now reschedules itself after every poll and reads
`live.pollMs` (default **150 ms**) from `/dsh-tts/status`, so live mode adds at
most ~150 ms of quantization. Capping at 150 ms also keeps the change clear of
`streamingEnabled`, which stays **false**: no AudioWorklet/SSE path is enabled
and no TTS streaming mode is touched.

## Barge-in and cancellation

* **Aborted attempt** (`agent/assistant-stream` end with `outcome.abandoned`):
  the step's in-flight synthesis is aborted and its reserved queue slots are
  dropped. A late `settle()` for a dropped id is suppressed, so a cancelled
  piece cannot resurrect itself.
* **Barge-in** (microphone opens): the client already stops local playback. It
  now also `POST`s `/dsh-tts/bargein`, which aborts in-flight synthesis and
  empties the host queue for that session — otherwise a piece still synthesizing
  settles later and the agent resumes talking over the user.
* **Turn boundary**: cursors for the session are released.

## Configuration (all default to upstream behaviour)

```yaml
dsh-tts:
  liveSentenceStreaming: true   # master switch, default false
  liveMinCharsFirst: 12         # first piece minimum (also the word-fallback floor)
  liveMinChars: 48              # later pieces minimum, and the first piece's clause floor
  liveMaxChars: 0               # 0 => sentenceChars
  livePollMs: 150               # browser pending-poll interval, live mode only
  liveFlushOnToolCall: true     # flush visible text when a tool call starts
```

The first piece's clause floor (48) and word fallback (72) are constants in
`lib/live.js`, not settings — see "The FIRST piece may start at a clause
boundary" above for why.

With `liveSentenceStreaming: false` the stream listener returns immediately:
no cursor, no synthesis, no behaviour change — the durable path speaks whole
messages exactly as upstream does.

## Tests

`node --test test/live.test.mjs test/wiring.test.mjs test/dup-publish.test.mjs` —
69 tests, no model, no network, no audio.

* `test/live.test.mjs` — the 15 required cases plus boundary/min-fragment units:
  leading-space tokens, end-of-token punctuation, multi-sentence deltas, one
  sentence spread over many deltas, punctuation-free remainder, reasoning
  before visible text, tool-call-only, acknowledgement + tool call, multi-step,
  code fences (closed and unterminated), inline code across a delta boundary,
  barge-in, aborted stream, duplication prevention (including a retry and
  divergent durable text), and fallback.
* `test/wiring.test.mjs` — the real plugin under a fake Cordis context: routes,
  `/status` live block, a live delta reaching `/dsh-tts/pending` with the WAV
  patch intact, no replay at settlement, remainder spoken exactly once, fallback
  with live mode off, abort, barge-in, and the cache path.
* `test/dup-publish.test.mjs` — the duplicate-publish defect: three deterministic
  reproducers (the production fixture at the tool-call boundary, the same shape
  with no tool call, and the raw-string alignment) plus a 17-case matrix
  (callback orderings, empty tails, retry, barge-in, cross-step isolation,
  legitimate repetition in two turns and in one reply) and a publication
  accounting check against `/dsh-tts/stats`
  (`publishedPieces <= synthesis results + cache hits`, exact for the held-fetch
  fixture). The integration cases drive the real plugin with `globalThis.fetch`
  held open, which is what makes the 9-syntheses/10-pieces signature
  reproducible rather than intermittent.

## Known limitations

1. **Durable-text prefix matching.** The remainder is computed by aligning the
   claimed range against the durable text — exactly first, then with whitespace
   runs collapsed, then by common prefix. A genuine rewrite (a retry that changes
   its opening, blocks re-joined with a separator the stream never sent) can still
   shorten the match; the code then speaks the unsaid tail only and logs a warning.
   It never replays the claimed prefix.
2. **A fence left open at settlement is dropped**, not summarized (the scrub
   regex cannot match it). Closed fences get the normal notice.
3. **`speakAsItGoes: false` + live mode** is a mixed state: steps the live path
   streamed are spoken live, steps it did not are still collected and spoken at
   `turn/end`. Use one or the other.
4. **GPU contention is untouched.** Live flush shortens the wait *to* synthesis;
   it does not make synthesis faster while the local model generates. Measured
   route-A first-piece was ~3975 ms under contention vs ~530–580 ms isolated —
   that is the next experiment, not this one.
5. **The clause floor is a character count, not a pause.** 48 characters of a
   dense clause can still be a short thing to hear first (`"Honestly, Jenya, I
   don't have a live view of your"`). It was chosen over a smaller floor because
   the alternative is a 1–3 word fragment, and over a larger one because the
   saving is proportional to how much sentence is skipped. Measured first-piece
   transcriptions are clean at this floor; if it ever sounds clipped the
   constant is `firstClauseChars()` in `lib/live.js`.

## Hook provenance (verified against dsh 0.1.5-rc.2)

| Fact | Evidence |
|---|---|
| one frame per raw chunk, emitted **live** | `dsh-agent-loop/lib/index.js:1031-1043` — `live.push(chunk)` runs inside `for await (const chunk of stream)` |
| a chunk frame carries the raw `StreamChunk` | `dsh-agent-loop/lib/index.js:402-416` (`AssistantStreamAttempt.push`) |
| `text-delta` is incremental, not cumulative | `dsh-llm/lib/types/assembler.js:46-52` (`partial.text += chunk.text`) |
| listener signature is one payload `{ frame, agent }` | `dsh-agent/lib/index.js:209-213` (`agentEvents` fuses `agent` into the payload); first-party root-level listeners destructure exactly it — `dsh-api-session-controller`, `dsh-headless` both do `ctx.on('agent/assistant-stream', ({ agent, frame }) => …)` |
| the event is scope-routed by `args[0].agent` | `dsh-scope/lib/invariant.js:10` |
| root-level (non-agent-scoped) listeners receive it | the two packages above, plus `dsh-tts`'s existing `session/event` listener |
| reasoning vs visible text vs tool calls are distinct chunk types | `dsh-llm/lib/types/types.d.ts:359-389` (`StreamChunk` union) |

## Scratch wiring

Profile: a dedicated scratch DSH profile (e.g. `<dsh-home>/profiles/voicelive`)
— a new profile, so the normal `web` profile and the npm copy of dsh-tts are
untouched.

```
voicelive/package.json   "@goodandready/dsh-tts": "link:../../../dsh-tts"
                          (link:, not file:, so this fork is live-editable;
                           scratch profiles only — production consumes a
                           frozen file: tarball)
voicelive/cordis.patch.yml   copied from scratch: whisper + theme (voice dictation)
settings-voicelive.yaml      own copy of the voice settings + the live keys below
ollama-voicelive.cordis.yml  --patch overlay: that settings file, port 3081, akeno preset
```

```sh
dsh --profile voicelive --patch <patch-dir>/ollama-voicelive.cordis.yml
# http://127.0.0.1:3081
curl http://127.0.0.1:3081/dsh-tts/status     # live.enabled must be true, live.pollMs 150
```

The settings file carries `liveSentenceStreaming: true` plus the six knobs and
keeps `streamingEnabled: false`, `customBaseUrl: http://127.0.0.1:18080/v1`,
`chain: [custom/qwen3-tts-akeno/akeno]`, `speakReplies: true`. Its
`agent-default-model` points at `unsloth/Qwen3.8-27B-GGUF` with
`reasoningEffort: low` (the production voice settings file still names the cloud
model, which must not be inherited by this profile).

The fork needs the harness's own `@deepseek-ai/*` packages at their real paths so
its peer imports (`defineTool`, `credentialRef`, schemastery) are the *same*
module instances the harness loaded. A `node_modules/@deepseek-ai` junction to
the installation's copy exists in the checkout for exactly that reason; it is
git-ignored and is also what lets the tests import `lib/index.js` directly.

## Defect log

### 0.4.16-local.3 — duplicate publish of a live tail (fixed)

Found by the production promotion smoke test: turn 25 step 2 published ids `u6` and
`u7` with identical text (94 chars, `b6260eaaa6e1`), identical audio
(`57104318fa3f`, 257 324 B) and identical `tookMs` (3806) — while `/dsh-tts/stats`
reported 9 syntheses for 10 published pieces, i.e. **one synthesis result was
published twice**. The client's dedupe is keyed on `item.id` alone, so both ids were
playable.

Cause, proven against the recorded session rather than inferred:

* `drainPieces` builds `spokenRaw` by trimming each piece and joining with one
  space, so a paragraph break at a piece boundary is recorded as a single space.
* the durable message keeps the `\n\n`. For turn 25 step 2 the claim was 514 chars
  against a 515-char durable text: `durable.startsWith(spoken)` was **false** and
  the longest common prefix ended at offset **419** — exactly the `\n\n`.
* `durable.slice(419).trim()` is verbatim `u7`'s text, so the settlement re-published
  the tail the tool-call boundary had already flushed.
* the second submission was coalesced into the still-in-flight first synthesis
  (`inFlightSyntheses`), which is why the audio and `tookMs` matched and why the
  synthesis count stayed one lower than the publication count.

The tool call was not the cause: the trigger is a whitespace run at a piece boundary.
A two-paragraph reply with no tool call at all reproduced it (`REPRO A2`), and the
model of the live path over the six recorded steps of that turn predicted the
duplicate exactly where production produced it and nowhere else.

The same investigation disproved the second suspected signature. The two "duplicate
EMPTY pieces" `u11`/`u12` were two `kind: 'reserved'` rows still awaiting synthesis
for step 6 — a reservation carries no `text` field, so comparing their empty text
hashes produced a false duplicate. Step 6 published exactly two non-empty pieces.

Fixed by making the claim an exact raw range (`claimedEnd`), aligning the claim with
the durable text on whitespace-normalized text before the raw common-prefix
fallback, settling a step once (`settled`), and filtering a retry's echo out of
`raw`. `test/dup-publish.test.mjs` reproduces the original signature deterministically
(no wall-clock dependence) and asserts the accounting bound
`publishedPieces <= synthesis results + cache hits`.
