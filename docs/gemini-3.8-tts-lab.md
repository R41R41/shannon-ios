# Gemini 3.8 TTS listening lab

Status: listening harness plus opt-in iPhone turn-based production experiment; not the default voice provider

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

## Cost comparison baseline

Provider list prices used by the UI estimate are valid through 2026-12-31:

| Item | Current list price | Example |
| --- | ---: | ---: |
| Gemini 3.8 Flash-Lite TTS output | $0.0015 / 10 s | $0.009 / output minute |
| Gemini 3.8 Flash TTS output | $0.00225 / 10 s | $0.0135 / output minute |
| OpenAI `gpt-transcribe` input | $0.0045 / input minute | $0.00225 / 30 s input |
| OpenAI GPT-Live active session | $0.05 / active minute | $0.05 / conversation minute, plus backend/tool calls |

For a one-minute turn cycle with 30 seconds of user speech and 30 seconds of Shannon
speech, the Flash-Lite speech transport estimate is about $0.00675: $0.00225 for
transcription plus $0.0045 for Gemini audio output. Ordinary Shannon text-model and
tool costs remain additional. Gemini TTS prices double on 2027-01-01, so the server's
configurable 10-second estimate must be updated before then.

## Official references

- [Gemini API text-to-speech guide](https://ai.google.dev/gemini-api/docs/speech-generation)
- [Gemini 3.8 Flash TTS model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts)
- [Voice design](https://ai.google.dev/gemini-api/docs/voice-design)
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)
