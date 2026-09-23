# DEV BRANCH — latency instrumentation (NOT a release)

Branch: `dev/latency-instrumentation`
Version marker: `0.4.17-latency-dev.1`
Tag: **none — deliberately.** This branch is unreleased development code.

## What this branch is

A **passive latency-instrumentation seam** added on top of the released
`0.4.16-local.3` source. It records *instants* on the TTS path so the end-to-end
voice latency can be decomposed per turn. It changes no timing, no ordering, no
text, no audio and no configuration.

The version in `package.json` was deliberately bumped away from `0.4.16-local.3`
so this branch can never be mistaken for — or accidentally packed as — the
released artifact. `master` still carries `0.4.16-local.3`.

## Where it actually runs

| profile | how TTS is installed | has this instrumentation? |
|---|---|---|
| production (`web`) | packed tarball `dsh-tts-0.4.16-local.3.tgz` | **no** |
| scratch (`voicelive`) | `link:../../../dsh-tts-local` (junction) | **yes** |

So the instrumentation is live **only in the scratch profile**. Production is
unaffected and keeps running the released tarball.

## What it adds

One new module, `lib/latency.js`, plus one import and a handful of call sites in
three existing files.

`lib/latency.js` is the *only* place the fork talks to the companion
`dsh-latency` plugin, through a narrow global bus
(`globalThis.__AKENO_LATENCY__`). **Every function degrades to a no-op when the
bus is absent** — with the instrumentation plugin not mounted, the cost is one
property read on `globalThis` per call and behaviour is unchanged.

The marks:

| mark | meaning | recorded in |
|---|---|---|
| `L3` | the first complete flushable sentence existed and was handed to synthesis | `lib/live.js` (`speak`), with a fallback in `lib/index.js` for paths that do not stream |
| `T0` | the utterance's queue slot was reserved | `lib/index.js` (`speakText`) |
| `T1` | the real synthesis HTTP request was issued | `lib/providers/cloud.js` |
| `T2` | the audio was fully in memory and playable | `lib/providers/cloud.js` |
| `T3` | the piece became visible to the browser's `/dsh-tts/pending` poll | `lib/index.js` (`settle`) |

L3 is recorded first-write-wins per turn, so a later piece, a later step or a
retry cannot move it.

## Deliberate compatibility property

`pieceMeta()` only adds `traceId`/`piece` to a queue row **when a trace actually
owns the piece**. With the instrumentation plugin absent, the row shape is
byte-identical to `0.4.16-local.3`. That is why this can sit on top of the
released source without perturbing the production code path it shares.

## Relationship to `master`

`master` is the released stable source (`v0.4.16-live.1`, package version
`0.4.16-local.3`, published on GitHub as `dsh-tts-live`). This branch is a
descendant of it.

If the instrumentation is ever promoted, it should be re-based onto `master`
with a proper version and tag rather than merged blindly, and the pile-up of
instrumentation call sites should be reviewed for whether it is still wanted in
production at all.

## Tests

```powershell
node --test test/live.test.mjs test/wiring.test.mjs test/dup-publish.test.mjs
```

`npm test` runs a `pretest` that needs `scripts/build-client.mjs`; run the files
directly if that script is unavailable.
