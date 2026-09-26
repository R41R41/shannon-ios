# Voice Lab third-party inventory

## Signalsmith Stretch

- Source: <https://github.com/Signalsmith-Audio/signalsmith-stretch>
- Pinned audit commit: `57b93f4e9206a089a45387eaa39bdc9f310d3308`
- License: MIT, copyright 2022 Geraint Luff
- Vendored files: `signalsmith-stretch.h`
- Local modification: none; Shannon adds a small C ABI wrapper and selects the
  cheaper preset, deterministic seed, Accelerate backend, pitch factor, and
  independent formant factor.

## Signalsmith Linear

- Source: <https://github.com/Signalsmith-Audio/linear>
- Pinned audit commit/tag: `5668673560146a9cfe38c25315071e3fd68c8317`
  (`0.3.1`)
- License: MIT, copyright 2025 Signalsmith Audio
- Vendored files: the headers required by Stretch's Accelerate backend.
- Local modification: none.

## Retrieval-based Voice Conversion WebUI

- Source: <https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI>
- Pinned audit commit: `81eed5e8f68b6bed1789f682fe78cdd324495afc`
- License: MIT
- Distribution: no RVC code or model is vendored. The local adapter invokes the
  official repository's `infer/cli.py` in a separately prepared environment.
- Model policy: only a Shannon-specific model trained from explicit consented
  material may be used. No public-person or third-party voice model is bundled.

## MLX-RVC evaluation runtime

- Source: <https://github.com/lextoumbourou/mlx-rvc>
- Evaluated commit: `f26633539f1aa935337d8ca5e96c78784698bd7a`
- License: MIT
- Distribution: not vendored. The adapter can invoke an independently prepared
  `mlx-rvc` CLI on Apple silicon.
- Evaluation model: `zunzunpj/zundamon_RVC` was used only for the documented
  technical listening sample and is not bundled or approved as Shannon's voice.
  Its model card points to the Zundamon audio terms, which require attribution;
  the sample is credited `VOICEVOX:ずんだもん`.

## RTCAudioDevice reference

- Source: <https://github.com/mstyura/RTCAudioDevice>
- Audited commit: `f39535c665bc8fa229a31523c67dbf4e0898102d`
- License: MIT, copyright 2022 Yury Yaroshevich
- Use: architectural reference for WebRTC M152's injectable audio device,
  Int16 conversion, and Voice Processing I/O. Shannon's implementation is
  reduced to the app's Debug playout experiment and keeps its existing session
  observers and state machine.

The complete MIT notices for vendored or adapted sources are preserved in
`docs/voice-lab/licenses`. This inventory must be updated before changing a
pinned revision or shipping any of these components in a Release build.
