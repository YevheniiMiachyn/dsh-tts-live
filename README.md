# 📦 @goodandready/dsh-tts

<div align="center">

<h3>Multi-Provider Text-to-Speech Voice Synthesis with Local Neural Engines, Sub-300ms Streaming, IT Dictionary & Messenger Integration for DeepSeek Harness</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/@goodandready/dsh-tts"><img src="https://img.shields.io/npm/v/@goodandready/dsh-tts.svg?style=for-the-badge&color=6366f1&labelColor=1e1b4b" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-10b981.svg?style=for-the-badge&color=10b981&labelColor=064e3b" alt="license"></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/DSH-Plugin-8b5cf6.svg?style=for-the-badge&labelColor=2e1065" alt="DSH Plugin"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node-20%2B-f59e0b.svg?style=for-the-badge&labelColor=451a03" alt="Node version"></a>
</p>

<p align="center">
  <a href="https://goodandready.app/"><img src="https://img.shields.io/badge/All_Author_Projects-goodandready.app-ff4500.svg?style=for-the-badge&logo=rocket&logoColor=white&labelColor=1a1a2e" alt="All Author Projects"></a>
</p>

<p align="center">
  <a href="README.md"><b>🇬🇧 English</b></a> •
  <a href="README.ru.md"><b>🇷🇺 Русский</b></a> •
  <a href="README.zh.md"><b>🇨🇳 中文说明</b></a>
</p>

<table align="center">
  <tr>
    <td align="center">
      ⭐ <strong>If you like this plugin, please star it on GitHub</strong> — it shows me that the plugin is useful to you and motivates me to keep developing it.
      <br><br>
      🐛 <strong>If you find a bug or would like to request a feature</strong>, open a GitHub issue in any language — I will review your proposal and implement useful suggestions in a future plugin version.
    </td>
  </tr>
</table>

</div>

---

## 🍴 This is a fork of `@goodandready/dsh-tts`

| | |
|---|---|
| **Upstream project** | [`GooDAnDReaDY/dsh-tts`](https://github.com/GooDAnDReaDY/dsh-tts) |
| **Upstream author** | [GooDAnDReaDY](https://github.com/GooDAnDReaDY) — npm [`@goodandready/dsh-tts`](https://www.npmjs.com/package/@goodandready/dsh-tts) |
| **Forked from** | upstream `0.4.16` (npm tarball shasum `0516c0c9613efe5ca666738179ba34570802b92e`) |
| **This fork's version** | `0.4.16-local.3` — release tag [`v0.4.16-live.1`](../../releases) |
| **License** | MIT — upstream copyright preserved verbatim, see [`LICENSE`](LICENSE) |

> [!IMPORTANT]
> **This is not the upstream project.** Anything about the base plugin — provider
> chains, the settings UI, cloud backends, localization — belongs
> [upstream](https://github.com/GooDAnDReaDY/dsh-tts/issues). Issues and pull
> requests about **live sentence streaming** belong here. This fork does **not**
> publish to npm; install it from this repository.

### Why this fork exists

Upstream speaks a reply only once the assistant message has settled, and
`speakAsItGoes` is **message-level, not token-level**: every step of a turn is one
message, so with a local model the first audible piece waits for the *entire*
assistant message — on step 1, including a whole thinking pass. On a local
GPU-resident stack that wait is the dominant part of "the voice feels slow".

This fork adds an **opt-in, sentence-level live path** that speaks each sentence
the moment the model finishes producing it, plus a small set of production fixes
for local OpenAI-compatible TTS servers.

It is deliberately conservative: the live path is **opt-in and off by default**,
the durable settlement path stays the source of truth, `streamingEnabled` remains
independent, and every upstream behaviour still works unchanged.

### What this fork adds

**Features**

* **True sentence-level TTS** driven by the process-local
  `agent/assistant-stream` event — the only genuinely token-level hook.
* **First sentence can synthesize before `assistant/message` settlement**, so
  speech starts while the model is still writing.
* **Ordered sentence queue** — one piece per sentence, published in order, with
  stable ids so the client cannot double-play or reorder audio.
* **Explicit session / turn / step ownership** on every queued and settled piece.
* **Durable-message reconciliation** — when the settled message arrives, already
  spoken text is matched against it and only the unsaid tail is published.
* **Multi-step / tool-call support** — reasoning and tool-call JSON are never
  spoken, and a step whose live audio was already played is not re-spoken.
* **Host-side barge-in cancellation** — `POST /dsh-tts/bargein` drops pending
  audio and aborts in-flight synthesis for a session.
* **Late-settle suppression** — a retried or re-settled step cannot resurrect
  audio that was already dropped by a barge-in.
* **Configurable live sentence thresholds** and **faster live pending polling**.

**Configuration keys** (all under `dsh-tts:` in `settings.yaml`)

| Key | Default | Meaning |
|---|---|---|
| `liveSentenceStreaming` | `false` | Master switch for the live sentence path |
| `liveMinCharsFirst` | `12` | Minimum characters before the **first** sentence may flush |
| `liveMinChars` | `48` | Minimum characters for subsequent flushes |
| `liveMaxChars` | `0` | Hard cap per piece; `0` falls back to `sentenceChars` |
| `livePollMs` | `150` | Pending-queue poll interval while speech is live |
| `liveFlushOnToolCall` | `true` | Flush the unspoken remainder before a tool call |

```yaml
dsh-tts:
  liveSentenceStreaming: true
  liveMinCharsFirst: 12
  liveMinChars: 48
  liveMaxChars: 0
  livePollMs: 150
  liveFlushOnToolCall: true
  streamingEnabled: false   # independent of live mode, and left false in the validated setup
```

> `streamingEnabled` (the upstream SSE/AudioWorklet path) stays **independent** —
> live sentence streaming neither requires it nor turns it on. The validated
> production configuration keeps it `false`.

**Fixes carried over from local patches**

* **Custom provider WAV request** — the `custom` provider asks for
  `response_format: 'wav'` instead of `'mp3'`.
* **`audio/wav` handling** — the returned mime type follows the requested format
  (`key === 'custom' ? 'audio/wav' : 'audio/mpeg'`).
* **Abort propagation fix** — a bare `abort` identifier meant the listener was
  never attached, so caller cancellation never reached in-flight synthesis.
* **Browser `SpeechSynthesis` fallback blocked** — the OS-voice fallback used to
  speak provider failures out loud, masking real errors.
* **Provider timeout raised to 120 s** — local TTS cold-start synthesis can
  exceed the old 10 s cap, aborting work that would have succeeded.
* **Duplicate live-tail publish fixed** — ownership now claims an exact raw text
  range (`claimedEnd`) instead of a re-rendered join, so one synthesis can never
  be published twice.

See [`PATCHES.md`](PATCHES.md) for the per-patch ledger and
[`LIVE-SENTENCE.md`](LIVE-SENTENCE.md) for the design notes and defect log.

### Known limitations

* **Shared-GPU contention.** The LLM and the local TTS engine compete for the
  same GPU. Sentence-level streaming improves *scheduling* — speech starts
  earlier — but it does not make the model or the TTS faster.
* **It does not solve model TTFT.** Time-to-first-token is a property of the
  model and hardware; live streaming only removes the wait *after* the first
  sentence exists.
* **Inline code can sound awkward.** With `skipCode: true` the sanitizer deletes
  inline code spans, so a sentence built out of them can be spoken with gaps.
  This is upstream behaviour on both the live and settled paths, but live mode
  speaks more sentences so it is heard more often.
* **Performance varies** by local model, TTS engine and GPU configuration. The
  numbers quoted in the release notes come from one specific local setup.

---

## ⚡ Overview

**`dsh-tts`** provides robust, lifelike spoken voice synthesis for assistant replies in the **DeepSeek Harness** Web UI. When **Speak agent replies** is enabled, each finished assistant turn or real-time streaming chunk is synthesized on the host and streamed directly to the browser.

API keys never reach client browsers: synthesis is executed entirely on the host backend across **independent multi-provider fallback chains**, including local system engines (Edge TTS, Piper, eSpeak). Kokoro-82M and F5-TTS weights can be downloaded for future runtime support, but neural inference is **not bundled** in this package — those providers fail honestly and the chain continues.

```mermaid
graph LR
    subgraph Input [Assistant Message]
        Reply[💬 Agent Reply Text] --> Scrub[Smart Text Scrubbing & IT Dictionary]
    end

    subgraph Stream [Low-Latency Streaming]
        Scrub --> SSE[SSE /dsh-tts/stream]
        SSE --> Worklet[AudioWorklet PCM Processor]
    end

    subgraph Cache [Performance Layer]
        Scrub --> LRU{Disk LRU Cache}
        LRU -->|Cache Hit| Play[Immediate Audio Playback]
    end

    subgraph Fallback [TTS Provider Fallback Chain]
        LRU -->|Cache Miss| Chain{Active Chain}
        Chain -->|Offline| P1[Edge TTS / Piper / eSpeak]
        Chain -.->|Cloud Neural| P2[OpenAI / ElevenLabs / Google / Azure / Groq]
        Chain -.->|OpenAI-compatible| P3[SiliconFlow / DeepInfra / Fireworks / OpenRouter]
        Chain -.->|Other| P4[MiMo / MiniMax / Custom]
    end

    subgraph Output [Delivery & Integrations]
        P1 --> Store[Save to Cache]
        P2 --> Store
        P3 --> Store
        P4 --> Store
        Store --> Play
        Store --> Msg[Telegram / Discord via dsh-messenger-gateway]
    end

    style Input fill:#1e1e2e,stroke:#89b4fa,stroke-width:2px,color:#cdd6f4
    style Stream fill:#181825,stroke:#89dceb,stroke-width:2px,color:#cdd6f4
    style Cache fill:#181825,stroke:#cba6f7,stroke-width:2px,color:#cdd6f4
    style Fallback fill:#11111b,stroke:#a6e3a1,stroke-width:2px,color:#cdd6f4
    style Output fill:#181825,stroke:#f38ba8,stroke-width:2px,color:#cdd6f4
```

---

## 🚀 Key Features

### 1. 📴 Offline system engines + optional future neural runtimes
* **Edge TTS / Piper / eSpeak**: fully offline or free local/system synthesis without cloud API keys (Edge needs the `edge-tts` CLI).
* **Kokoro-82M / F5-TTS**: weight download and status UI only. **Neural inference is not bundled** in this package — those providers fail with a clear reason and the fallback chain continues. Do not enable them expecting speech until a supported runtime is wired.
* **ModelManager UI**: Direct manual installation in settings with real-time download progress bar, SHA-256 validation, and deletion. No silent or automatic multi-gigabyte downloads.

### 2. ⚡ Real-Time Streaming Audio (< 300 ms Latency)
* **AudioWorklet (`TTSWorklet`)**: High-performance Web Audio Worklet processor playing seamless Float32Array PCM chunks at 24 kHz without audible clicks or buffer underruns.
* **Server-Sent Events (SSE)**: Dedicated `/dsh-tts/stream` route delivering synthesized chunks to connected browsers instantly.

### 3. 🎙️ Voice Duplex & VAD Barge-In (with `@goodandready/dsh-voice`)
* **Full-Duplex Conversation**: Automatic voice reply synthesis upon completion of speech dictation.
* **VAD Barge-In**: Immediately mutes assistant speech playback when user voice activity is detected.
* **Installation Guard**: If `@goodandready/dsh-voice` is not present, settings controls are disabled with an explicit instruction banner (`dsh plugin --profile web add @goodandready/dsh-voice`).

### 4. 📚 Built-in IT Terminology Pronunciation Dictionary
* **Pre-configured Lexicon**: Correct phonetic pronunciation for common technical abbreviations and developer terms:
  - `SQL` $\rightarrow$ "сиквел"
  - `Nginx` $\rightarrow$ "энджинкс"
  - `Kubernetes` / `K8s` $\rightarrow$ "кубернетис"
  - `Docker` $\rightarrow$ "докер", `API` $\rightarrow$ "апи", `JSON` $\rightarrow$ "джейсон", `YAML` $\rightarrow$ "ямл"
  - `GUI`, `CLI`, `CI/CD`, `PR`, `Regex`, `OAuth`, `HTTP`, `HTTPS`, `CPU`, `GPU`, `RAM`
* **Interactive UI Editor**: Edit rules, preview phonetic substitutions with the **▶ Listen** button, and populate standard IT terms with one click.

### 5. 👥 Multi-Agent Personas & Subagent Voice Overrides
* Assign distinct voices, providers, models, and audio chimes to individual subagents (e.g. `coder`, `reviewer`, `planner`, `tester`).
* **Subagent Auto-Detection**: With `autoDetectSubagent` enabled, incoming turns automatically match subagents by message metadata (`subagent`, `agent`, `author`, `name`) and dynamically apply voice, rate, and SSML style presets.

### 6. 💾 Audio Clip Export & Speech History
* Export any spoken utterance directly to an audio file (`.wav` / `.mp3`) via `exportAudioClip(text)`.
* Instant download buttons (`⤓`) integrated directly into the input dock speaker control and recent utterances dropdown list.

### 7. 💬 Messenger Voice Notes Integration (with `@goodandready/dsh-messenger-gateway`)
* Generates voice audio for Telegram and Discord bot replies via `POST /dsh-tts/speak`.
* Protective dependency check with installation hint when gateway plugin is missing.

### 8. 🌐 Canonical English & Chinese Localization (EN + ZH)
* Complete built-in English (`en`) and Chinese (`zh`) UI and speech template dictionaries.
* Centralized Russian localization provided via `@goodandready/dsh-russian-lang` through Gitea issue tracking.
* Smart boundary tokenizer supporting CJK full-width punctuation (`。！？`), abbreviations, file extensions, and IP/version numbers.

---

## 🛠️ Complete Supported Providers Matrix (18 Backends)

| Provider Key | Service Backend | Default Model | Default Voice | Credential Ref | Features & Notes |
|---|---|---|---|---|---|
| `kokoro` | Local Kokoro-82M ONNX | `hexgrad/Kokoro-82M` | `af_bella` | *None* | Weights downloadable; **ONNX inference not bundled** — fails honestly |
| `f5` | Local F5-TTS GPU Daemon | `F5-TTS` | Default | *None* | Daemon ping only; **GPU inference not bundled** — fails honestly |
| `elevenlabs` | ElevenLabs API | `eleven_multilingual_v2` | `Rachel` | `ELEVENLABS_API_KEY` | Ultra-realistic, emotional nuance |
| `openai` | OpenAI Audio | `gpt-4o-mini-tts` / `tts-1` | `alloy` | `OPENAI_API_KEY` | High-quality industry standard |
| `edge` | Microsoft Edge Online | `ru-RU-SvetlanaNeural` | `ru-RU-SvetlanaNeural` | *None* | **Free, high-fidelity neural TTS without API keys** |
| `siliconflow` | SiliconFlow CosyVoice | `FunAudioLLM/CosyVoice2-0.5B` | Default | `SILICONFLOW_API_KEY` | State-of-the-art CosyVoice2 neural engine |
| `deepinfra` | DeepInfra Kokoro | `hexgrad/Kokoro-82M` | Default | `DEEPINFRA_API_KEY` | Fast open-weights Kokoro synthesis |
| `fireworks` | Fireworks AI | `kokoro` | Default | `FIREWORKS_API_KEY` | Ultra-low latency Kokoro inference |
| `minimax` | MiniMax Speech | `speech-01-turbo` | Default | `MINIMAX_API_KEY` | High-expressiveness neural voice |
| `mimo` | Xiaomi MiMo Audio | `mimo-v2.5-tts` | Default | `MIMO_API_KEY` | Low-latency streaming TTS |
| `google` | Google Cloud TTS | `gemini-2.5-flash-preview-tts` | Language default | `GEMINI_API_KEY` | Multilingual Google Gemini voice synthesis |
| `azure` | Azure Cognitive Speech | `en-US-JennyNeural` | Region default | `AZURE_SPEECH_KEY` | Enterprise neural synthesis |
| `deepgram` | Deepgram Aura | `aura-asteria-en` | `asteria` | `DEEPGRAM_API_KEY` | Ultra-low latency voice output |
| `groq` | Groq TTS | `playai-tts` | `default` | `GROQ_API_KEY` | Near-instant inference speed |
| `openrouter` | OpenRouter Audio | `openai/gpt-4o-mini-tts` | `alloy` | `OPENROUTER_API_KEY` | Unified router access |
| `custom` | Custom OpenAI-compatible | Configurable | Configurable | `CUSTOM_TTS_API_KEY` | Any `/v1/audio/speech` endpoint |
| `piper` | Local Piper ONNX | Local ONNX weights | Model default | *None* | 100% offline neural engine |
| `espeak` | Local eSpeak NG | System synth | `ru` / `en` | *None* | 100% offline lightweight fallback |

---

## 🧹 Smart Text Scrubbing & Formatting Engine

Before text reaches speech synthesizers, `dsh-tts` intelligently sanitizes and filters the message so the assistant doesn't read out syntax noise:
* **Fenced Code Blocks**: Spoken as *"code block, N lines"* / *"блок кода, N строк"*.
* **Markdown Tables**: Spoken as *"table, N rows"* / *"таблица, N строк"*.
* **Summary Intros**: Spoken as *"Summary of the reply"* / *"Пересказ ответа"*.
* **Narration Filters**: Skip asterisk actions (`*smiles*`), narrate quotes only, and apply custom regex removal.

---

## 📦 Quick Installation

**This fork** — install from a checkout of this repository (a `file:` dependency
keeps the tested artifact frozen; avoid `link:` for production):

```bash
dsh plugin --profile web add file:/path/to/dsh-tts-<version>.tgz
```

**Upstream** — the published npm package, which does *not* contain the live
sentence feature described above:

```bash
dsh plugin --profile web add @goodandready/dsh-tts
```

> [!IMPORTANT]
> Restart DSH Web UI after installation (`systemctl --user restart dsh-web`) and refresh your browser tab.

---

## ⚙️ Configuration Recipes (`settings.yaml`)

```yaml
dsh-tts:
  speakReplies: true
  enableLocalEngines: true
  kokoroEnabled: true
  streamingEnabled: true
  enableItDictionary: true
  voiceDuplexEnabled: true
  vadBargeIn: true
  messengerTtsEnabled: true
  cache: true
  cacheMaxMb: 150
  autoDetect: true
  chain:
    - provider: edge
    - provider: espeak
      voice: ru-RU-SvetlanaNeural
    - provider: openai
      model: tts-1
      voice: alloy
  roles:
    coder:
      provider: openai
      voice: onyx
    reviewer:
      provider: edge
      voice: ru-RU-DmitryNeural
```

---

### Settings UI coverage

The plugin settings card (**Settings → Plugins → Plugin settings**) exposes every user-facing schema field, including an **Advanced** block for `maxChars`, `sentenceChars`, `timeoutMs`, `maxQueue`, `openaiBaseUrl`, `mimoBaseUrl`, `mimoFormat`, and `minimaxBin`.

Provider **API keys are never stored in plugin settings**. Paste them in the chain editor; values go to the DSH credential store via `PUT /dsh-tts/credential`.

Config-only (not in the card): `*KeyEnv` fields (`openaiKeyEnv`, `elevenlabsKeyEnv`, …). They only rename the credential slot the plugin looks up. Change them in `settings.yaml` if you must rebind a key name; the defaults match the usual environment variable names.


## 🤖 HTTP Endpoints Reference

* `GET /dsh-tts/stream` — Real-time Server-Sent Events (SSE) audio streaming.
* `POST /dsh-tts/speak` — `{ text, voice?, model? }` → Returns synthesized audio.
* `POST /dsh-tts/preview` — `{ provider, model, voice, text? }` → Test voice playback in UI.
* `GET /dsh-tts/models/status` — Reports Kokoro/F5 weight installation states (download only; inference not bundled).
* `POST /dsh-tts/models/install` — `{ engine: 'kokoro' | 'f5' }` → Starts HuggingFace model download.
* `DELETE /dsh-tts/models/delete` — `{ engine: 'kokoro' | 'f5' }` → Removes local model files.
* `GET /dsh-tts/integrations` — Status of sibling plugins (`dsh-voice`, `dsh-messenger-gateway`).
* `GET /dsh-tts/status` — Returns active chain state, cache statistics, and engine readiness.

---

## 📄 License

MIT © [GooDAnDReaDY](https://github.com/GooDAnDReaDY) — upstream author of
`@goodandready/dsh-tts`.

This fork preserves the upstream `LICENSE` and copyright notice verbatim. Fork
modifications (live sentence streaming and the patch ledger described in
[`PATCHES.md`](PATCHES.md)) are released under the same MIT terms. It is not
affiliated with or endorsed by the upstream author.
