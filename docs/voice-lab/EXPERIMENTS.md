# Voice Lab experiment log

Baseline commit: `53f64fc78045553f6326d13495d2041fd2bbeb5c`  
Run date: 2026-09-17  
Host: Apple silicon Mac

## Realtime source

The earlier Apple synthetic source remains useful only for deterministic DSP
performance tests. It is not used for the voice-quality decision below.

The comparison source was captured from the same configuration used by the app:

- model: `gpt-realtime-2.1-mini`
- voice: `marin`
- transport used for capture: Realtime WebSocket (the app uses WebRTC)
- format: 24 kHz, mono PCM16
- duration: 4.850 seconds
- exact transcript: `こんにちは、シャノンです。今日も一緒に、ゆっくり考えていきましょう。`

## Realtime-source DSP benchmark

Seven whole-file iterations were run with the vendored Signalsmith wrapper in
an optimized local dylib.

| Preset | Median | p95 | Median realtime factor | Reported DSP latency |
|---|---:|---:|---:|---:|
| Formant +1.4 | 9.42 ms | 17.55 ms | 0.00194× | 100.0 ms |
| Pitch +100 / Formant +1.2 | 11.70 ms | 13.22 ms | 0.00241× | 100.0 ms |

Both transforms are fast offline. The declared 100 ms latency still requires a
persistent overlap/add stream and physical-device measurement before enabling
either transform in a call.

## Actual RVC run

The loopback adapter invoked MLX-RVC with a licensed validation checkpoint. This
was neural conversion, not pass-through.

- target checkpoint: `zunzunpj/zundamon_RVC`
- required credit: `VOICEVOX:ずんだもん`
- parameters: RMVPE, +3 semitones, FAISS index rate 0.5
- output: 48 kHz mono PCM16, 4.840 seconds
- adapter processing time: 15,953 ms (about 3.30× realtime)
- post-conversion Japanese ASR: exact text match

The evaluated MLX port omitted the reference RVC pipeline's 2× ContentVec frame
upsampling, initially producing a half-duration file. The local evaluation copy
was corrected to repeat the 50 Hz features onto RVC's 100 Hz timeline before
index retrieval and synthesis. Only the corrected equal-duration output is
included in the deliverables.

The Zundamon sample demonstrates RVC's audible identity shift and failure modes.
It is not a candidate Shannon identity. A production evaluation still requires
a Shannon-specific target speaker who explicitly consented, plus a streaming
implementation that runs below realtime with acceptable chunk latency.

## Functional verification

| Item | Result |
|---|---|
| Realtime model/voice capture | passed; exact requested transcript |
| Independent formant A/B | passed and exported from Realtime source |
| RVC loopback health/upload/response | passed |
| Actual RVC conversion | passed; equal duration and exact ASR |
| RVC realtime performance | failed; 15.95 s for 4.84 s output |
| GPT-Live Apple TimePitch PCM boundary | compiled; physical-device call pending |
| GPT-Live formant / RVC streaming | disabled pending streaming implementation |
| Swift unit tests / generic iOS Debug build | passed before this Python-only adapter update |
| Physical iPhone speaker/Bluetooth test | not run in this experiment |

## Current decision

1. Use Realtime output, not Apple synthetic speech, for every listening decision.
2. Keep Apple TimePitch as the lowest-risk live experiment.
3. Treat Signalsmith pitch/formant as an offline listening candidate until its
   100 ms algorithm latency is measured end-to-end.
4. Treat RVC as an offline identity prototype only. Do not ship the validation
   character model, and do not claim realtime readiness.
