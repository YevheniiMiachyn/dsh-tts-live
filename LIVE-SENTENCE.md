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
| `raw` | every visible character received for this step |
| `cursor` | offset of the first character not yet spoken or discarded |
| `spokenRaw` | text already handed to synthesis, in order |
| `pieces` | how many pieces were spoken (0 ⇒ durable path keeps ownership) |
| `controllers` | abort controllers of in-flight synthesis for this step |

The cursor survives a retry of the same step: a second attempt reuses the step's
`spokenRaw`, so a retry can never re-speak the first attempt's text.

**Duplicate-speech policy** (the settled message must never replay the stream):

| Live state when `assistant/message` settles | Action |
|---|---|
| no cursor, or `pieces === 0` | **fallback** — upstream speaks the whole message |
| `durable.startsWith(spokenRaw)` | **remainder** — speak only the unsaid tail |
| diverged (retry/other text) | **remainder via longest common prefix** + a warning; the already-spoken prefix is never repeated |
| `turn/end` | cursor is dropped, so a later turn cannot inherit ownership |

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

## Minimum-fragment policy

Two thresholds, because the first piece and later pieces have opposite costs:

* `liveMinCharsFirst` (default **12**) — the first piece's only job is to start
  audio, so it is allowed to be short.
* `liveMinChars` (default **48**) — later pieces are already overlapped by
  playback, so batching them is free and avoids synthesis churn.

A candidate piece shorter than the applicable minimum is joined with the next
sentence instead of being spoken alone. Measured against the existing
`sentenceChars: 320`, upstream's own minimum is `min(60, 320/3) = 60`, which
makes a first piece wait for ~60 characters — wrong for a latency feature, right
for later pieces. `12 / 48` keeps the upstream spirit while prioritising the
first sound. `liveMinCharsFirst: 3` reproduces "speak `Sure.` immediately".

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
  liveMinCharsFirst: 12         # first piece minimum
  liveMinChars: 48              # later pieces minimum
  liveMaxChars: 0               # 0 => sentenceChars
  livePollMs: 150               # browser pending-poll interval, live mode only
  liveFlushOnToolCall: true     # flush visible text when a tool call starts
```

With `liveSentenceStreaming: false` the stream listener returns immediately:
no cursor, no synthesis, no behaviour change — the durable path speaks whole
messages exactly as upstream does.

## Tests

`node --test test/live.test.mjs test/wiring.test.mjs` — 38 tests, no model, no
network, no audio.

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

## Known limitations

1. **Durable-text prefix matching.** The remainder is computed by prefix/LCP
   comparison of raw strings. Block re-joining (`\n` between text blocks) or a
   retry that rewrites its opening can shorten the match; the code then speaks
   the unsaid tail only and logs a warning. It never replays the prefix.
2. **A fence left open at settlement is dropped**, not summarized (the scrub
   regex cannot match it). Closed fences get the normal notice.
3. **`speakAsItGoes: false` + live mode** is a mixed state: steps the live path
   streamed are spoken live, steps it did not are still collected and spoken at
   `turn/end`. Use one or the other.
4. **GPU contention is untouched.** Live flush shortens the wait *to* synthesis;
   it does not make synthesis faster while the local model generates. Measured
   route-A first-piece was ~3975 ms under contention vs ~530–580 ms isolated —
   that is the next experiment, not this one.
5. **No mid-sentence clause cutting.** Only sentence boundaries (plus the
   over-long force-cut) start audio; a reply whose first sentence is 200
   characters long waits for it.
