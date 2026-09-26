# Shannon Voice Lab

## Goal and boundary

Voice Lab is a Debug-only comparison harness for making Shannon sound younger,
brighter, and cuter without changing her speaking style, text, or conversation
state. Production still starts with the unmodified WebRTC audio device and the
`OFF` preset.

The existing Realtime path is:

`RealtimeVoiceSessionModel` → `ShannonWebRTCVoiceTransport` → WebRTC M152 audio
device → `AVAudioSession(.playAndRecord, .voiceChat)`.

The data channel continues to own server VAD, transcripts, barge-in events, and
session state. Voice Lab changes only the remote playout PCM boundary:

- fixed Japanese and imported WAV: one source buffer feeds every preset;
- GPT-Live in Debug: an injected `RTCAudioDevice` feeds received Int16 PCM into
  `AVAudioEngine`, `AVAudioUnitTimePitch`, EQ, then the output node;
- microphone input still returns to WebRTC through the same custom device, with
  Voice Processing I/O enabled for echo cancellation;
- unsupported Live presets fall back to the standard device instead of silently
  claiming that formant or RVC streaming is active.

## Run

For the primary Mac workflow, launch the loopback browser tuner with a PCM16
Realtime WAV:

```sh
python3 tools/voice_lab/web_lab.py --source /path/to/realtime-voice.wav
```

The browser UI remains on `127.0.0.1`, uses this same vendored Signalsmith DSP,
and keeps the WAV in memory. Pitch and Formant have independent sliders and
number fields; releasing a slider can regenerate and replay the same PCM.

Add `-ShannonVoiceLab` to the ShannonApp Debug launch arguments. Generate the
fixed Japanese source or import a 16-bit WAV, select a preset, and replay it.
Each run records preprocessing time and algorithm-reported latency in the UI.

For a GPT-Live Apple TimePitch run, select an Apple preset in the Lab, terminate
the app, then launch the ordinary Debug app without `-ShannonVoiceLab`. The
selected preset is kept in Debug `UserDefaults`. Select `OFF` before an
unmodified baseline run. Release builds do not compile this selection path.

## Presets

| ID | Processor | Pitch | Formant | Intended comparison |
|---|---|---:|---:|---|
| `off` | bypass | 0 | 0 | identity baseline |
| `pitch-80/120/160` | Apple TimePitch | +80/+120/+160 cents | unchanged | safest Live experiment |
| `formant-only` | Signalsmith Stretch | 0 | +1.4 semitones | isolate vocal-tract shift |
| `pitch-formant` | Signalsmith Stretch | +100 cents | +1.2 semitones | balanced offline candidate |
| `rvc` | external RVC CLI (MLX or official) | model dependent | model dependent | licensed evaluation; consented Shannon model for production |
| `rvc-finish` | RVC then Apple finish | +60 cents | model dependent | small post-conversion lift |

`AVAudioUnitTimePitch` does not independently control formants. Signalsmith is
used because its API exposes pitch and formant factors separately. The C++
wrapper seeds the processor deterministically and reports its declared input
plus output latency.

## Measurements and acceptance

Use the same 48 kHz source and repeat each case at least five times. Record:

- median and p95 preprocessing time;
- algorithm latency and audio-route latency;
- glitch/dropout count during a 60-second Live call;
- Bluetooth and speaker route changes;
- interruption/resume, mute, server VAD, and barge-in behavior;
- a blind 1–5 score for naturalness, age impression, cuteness, consonant
  clarity, long vowels, geminate consonants, and proper nouns.

No preset is a production recommendation until it passes a physical iPhone
speaker/headphone test and a real GPT-Live call. A saved-WAV speed result is not
evidence of Live latency or echo-cancellation quality.

## Privacy and rollback

Use only the fixed script rendered by the configured Realtime voice, explicitly
approved recordings, or clearly licensed validation material. The Lab
does not persist conversation PCM. Temporary speech/RVC WAV files are removed
after loading. The RVC adapter has no authentication and must remain on loopback
unless a deliberate private-LAN device test is in progress.

Rollback is immediate: select `OFF`, remove the Debug launch argument, or delete
the Voice Lab files. The standard factory remains the Release implementation.
