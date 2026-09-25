# Gemini 3.8 TTS listening lab

Status: listening harness plus opt-in iPhone turn-based and native-audio Live experiments; not the default voice provider

## Purpose

Evaluate whether Gemini 3.8 Flash TTS or Gemini 3.8 Flash-Lite TTS can become
Shannon's Japanese speaking voice without changing the current OpenAI Live /
Realtime WebRTC path before its replacement has passed the same interaction gates.

The lab deliberately separates four questions:

1. Is the Japanese voice natural, intelligible, and recognizably Shannon?
2. Does it pronounce product names, English abbreviations, long vowels, and pauses well?
3. Is first-audio and total generation latency suitable for a conversational cascade?
4. Can a new cascade preserve interruption, route change, microphone, persistence, and
   tool-delegation behavior currently owned by the live session?

File generation answers only the first two questions and measures a server request's
total elapsed time. It does not prove first-audio latency or live-session suitability.

## Setup

Put a Gemini API key in the ignored repository-root `.env` file:

```sh
GEMINI_API_KEY=...
```

The key stays server/development-side. It must never be added to the iOS or macOS
bundle, copied into logs, or committed.

## Open the private browser lab

The quickest listening loop is the private browser workbench. Its production
process runs on Azure loopback and has no public URL. From the trusted Mac:

```sh
pnpm voice:gemini:web
```

This opens an SSH local-forward to `http://127.0.0.1:4322` and launches the
default browser. Keep the terminal open while testing; closing it removes access.
The permanent Gemini key remains in Azure's mode-0600 environment file.

Use the three areas in order:

1. **声を比較** — choose one Japanese emotion script and a short turn-level acting
   direction, then generate Flash and Flash-Lite either once or three times each.
   The in-memory A/B tray keeps up to eight samples with model, repetition, request
   time, audio duration, and estimated cost, so identity stability is visible rather
   than inferred from one lucky take.
2. **声をデザイン** — create a persistent Voice ID only after acknowledging its
   one-year storage, quota, and cost. Eight editable original-character presets
   cover translucent emotional Shannon, frank sunny energy, confident prickly
   warmth, refined clarity, tender devotion, digital idol, reserved lower register,
   and formal emotion that gradually opens. Each preset provides Japanese / English
   and short / detailed design text for matched prompt-language experiments. Multiple
   candidates remain visible in the current tab; deletion requires retyping each
   exact ID.
3. **Liveで会話確認** — optionally verify conversational cadence, server VAD,
   interruption, and native-audio character with the voice selected in step 1 or
   the stored Voice ID created in step 2.

The lab intentionally does not make Live a prerequisite for voice selection.
Matched TTS is faster, cheaper, and makes voice differences easier to hear. Live is
useful after narrowing candidates because native audio can pace and color the same
voice differently from TTS. The browser synchronizes the step-1 selection into the
Live selector and adds a newly designed `voice_...` identity to both selectors.
An actual `gemini-3.8-live` setup handshake was verified for an Extended Voice
Library ID and a temporary prompted Voice ID on 2026-09-25; the temporary voice was
deleted after its TTS and Live compatibility checks passed.

The browser sends neither the API key nor ordinary TTS text/audio to Shannon's
database. Samples use in-memory object URLs; Live uses a single-use token and browser
echo cancellation, sends 16 kHz mono PCM, and plays 24 kHz PCM. No audio, transcript,
message, token, or credential is logged or persisted by the lab.

All four prompt variants for all eight built-in designs were verified against the
real Voices API on 2026-09-25. Every successful smoke-test Voice ID was deleted
immediately. Numeric
minor-age wording and negative phrases about imitating known voices were rejected by
the safety filter, so the shipped presets express the same intended age impression
through register, tempo, pitch movement, diction, and emotional delivery without
sending those trigger phrases. A custom edit is labeled unverified. The billable
smoke command is intentionally excluded from deterministic checks:

```sh
node scripts/gemini-voice-preset-smoke.mjs --confirm-billable --delete-successes --all-variants
```

## Discover Japanese voices

```sh
pnpm voice:gemini -- voices
```

The default filter requests Japanese, female-presenting, high/medium-pitch,
conversational, prebuilt voices. Filters can be changed without editing code:

```sh
pnpm voice:gemini -- voices --pitch high --search warm --limit 100
```

## Generate one sample

```sh
pnpm voice:gemini -- sample \
  --model lite \
  --voice Leda \
  --script identity \
  --style-preset plain
```

Use `flash` for the quality-first model and `lite` for the latency/cost-first model.
Available script presets are `identity`, `pronunciation`, `emotion`, and `long`.
Available style presets are `plain`, `warm`, `bright`, and `calm`.

Start with `plain`. Google recommends using short turn-level style directions only
when necessary and putting persistent identity traits in Voice design.

## Generate a matched matrix

```sh
pnpm voice:gemini -- matrix \
  --models flash,lite \
  --voices Zephyr,Leda,Aoede,Achernar \
  --script identity \
  --styles plain,bright
```

Outputs are written under the ignored `artifacts/gemini-tts/` directory. Every run
includes a `manifest.json` with model, voice, exact transcript and style, WAV format,
duration, request time, real-time factor, byte count, and SHA-256. The matrix writes
the manifest after every successful sample so a partial run remains auditable.

To compare all fixed scripts, pass `--script all`. This increases API calls by four.

## Measure streaming latency

```sh
pnpm voice:gemini -- stream \
  --model lite \
  --voice Leda \
  --script identity \
  --style-preset plain
```

The streaming command consumes Gemini's headerless 24 kHz mono 16-bit PCM chunks,
wraps them in a WAV for listening, and records first-audio latency, total elapsed
time, chunk count, chunk-byte p50/p95, inter-chunk p50/p95, audio duration, and
real-time factor. It is a server-side transport measurement, not an iPhone
speaker/AEC/barge-in result.

## Design a Shannon-specific voice

Voice design creates a `voice_...` resource stored in the Google project for up to
one year and counts toward the project's custom-voice quota. The command therefore
requires an explicit `--store` confirmation:

```sh
pnpm voice:gemini -- design --store --preset shannon-bright
pnpm voice:gemini -- design --store --preset shannon-warm
pnpm voice:gemini -- design --store --preset shannon-calm
```

The returned voice ID and preview WAV are saved locally. Use the exact ID with
`sample --voice voice_...` to compare the same identity on both TTS models.
The creation request deliberately omits `voice.model`; Gemini selects the current
default supported Voice Design model and returns the actual creation model with the
new voice. The resulting Voice ID is independent of the TTS model used later.

Delete a discarded stored design only by repeating its exact ID:

```sh
pnpm voice:gemini -- delete --id voice_EXACT_ID --confirm voice_EXACT_ID
```

## Listening scorecard

Use the same source text for every candidate and score each item from 1–5:

| Dimension | What to listen for |
| --- | --- |
| Natural Japanese | Mora timing, particles, phrase endings, breath, conversational cadence |
| Shannon identity | Warmth, intelligence, femininity, charm, consistency without infantilization |
| Pronunciation | Aether, Voyager, Syzygy, API, SwiftUI, numbers, long vowels, sokuon |
| Emotional range | Reassurance, delight, seriousness, quiet pauses without theatrical drift |
| Clarity | Consonants remain clear at normal device volume and with a headset |
| Stability | Same apparent speaker, pitch, loudness, and room tone across repeated turns |

Do not choose a production identity from ASR agreement or generation time alone.

## Integration decision after listening

Gemini 3.8 TTS is text-to-audio, while Shannon's current voice path is a full-duplex
audio-to-audio WebRTC session. A production migration is therefore a provider-neutral
cascade, not a model-name swap:

```text
microphone -> streaming STT -> Shannon text turn/tool lane
           -> Gemini Flash-Lite TTS stream -> 24 kHz mono PCM player
```

Keep Flash TTS as a quality fallback for difficult pronunciation or explicitly
expressive/long-form turns only if evaluation shows the extra latency is worthwhile.
Before rollout, measure first-audio p50/p95 and verify barge-in, cancellation,
speaker/headset/Bluetooth routes, interruptions, AEC, transcript persistence, guest
boundaries, camera commentary, and backend tool delegation on a physical device.

The first production experiment intentionally stops short of that full cascade. From
the iPhone waveform menu, the owner may choose `Gemini 3.8 Flash-Lite · 試験版`.
Each turn records one bounded M4A, uses the existing OpenAI transcription endpoint,
sends the transcript through the ordinary Shannon text/history/tool lane, requests a
24 kHz WAV from Gemini on Azure, and plays the result locally. The existing OpenAI
Live path remains available and unchanged. The Gemini key never enters the app, and
neither source audio nor generated WAV is persisted by Shannon.

The second experiment uses `Gemini 3.8 Live` rather than a TTS model. It sends
16 kHz mono PCM from iPhone directly to Google's Live WebSocket and receives native
24 kHz audio, input/output transcription, interruption, tool calls, and session
resumption on the same connection. Azure authenticates the paired owner and mints a
one-use ephemeral token whose field mask fixes `gemini-3.8-live` and AUDIO output;
the permanent key remains in its mode-0600 secret file. The client retains local
control of the selected Aoede voice, Shannon instruction, tool declaration, context
compression, and resumption handle. Completed transcript pairs are persisted to the
same Talk thread, while raw PCM is not retained.

## Cost comparison baseline

Provider list prices used by the UI estimate are valid through 2026-12-31:

| Item | Current list price | Example |
| --- | ---: | ---: |
| Gemini 3.8 Flash-Lite TTS output | $0.0015 / 10 s | $0.009 / output minute |
| Gemini 3.8 Flash TTS output | $0.00225 / 10 s | $0.0135 / output minute |
| OpenAI `gpt-transcribe` input | $0.0045 / input minute | $0.00225 / 30 s input |
| OpenAI GPT-Live active session | $0.05 / active minute | $0.05 / conversation minute, plus backend/tool calls |
| Gemini 3.8 Live input audio | $0.005 / input minute | $0.0025 / 30 s input |
| Gemini 3.8 Live output audio | $0.018 / output minute | $0.009 / 30 s output |

For a one-minute turn cycle with 30 seconds of user speech and 30 seconds of Shannon
speech, the Flash-Lite speech transport estimate is about $0.00675: $0.00225 for
transcription plus $0.0045 for Gemini audio output. Ordinary Shannon text-model and
tool costs remain additional. Gemini TTS prices double on 2027-01-01, so the server's
configurable 10-second estimate must be updated before then.

For the same 30-second input plus 30-second output cycle, Gemini 3.8 Live is about
$0.0115 before Shannon backend/tool calls. Unlike the Flash-Lite cascade, its native
audio model performs the live conversation itself, so the cost and behavior are not
directly interchangeable with transcription + ordinary Shannon text inference + TTS.

## Official references

- [Gemini API text-to-speech guide](https://ai.google.dev/gemini-api/docs/speech-generation)
- [Gemini 3.8 Flash TTS model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts)
- [Voice design](https://ai.google.dev/gemini-api/docs/voice-design)
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini 3.8 Live](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live)
- [Live API ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens)
