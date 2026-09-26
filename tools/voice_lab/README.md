# Shannon Voice Lab

## Mac browser tuner

Start the loopback-only browser UI with a saved Realtime WAV:

```sh
python3 tools/voice_lab/web_lab.py \
  --source /path/to/realtime-voice.wav
```

It compiles the vendored Signalsmith wrapper once, serves the UI only on
`127.0.0.1:8787`, and processes PCM16 WAV data in memory. Dragging Pitch or
Formant and releasing the pointer generates a fresh A/B result. Nothing is
uploaded or persisted. Use `--no-open` when a caller will open the URL itself.

Launch the isolated iPhone comparison screen by adding `-ShannonVoiceLab` to
the `ShannonApp` Debug scheme arguments. The production default remains the
ordinary Shannon conversation root.

See `docs/voice-lab/README.md` for architecture, presets, measurements, and the
Debug GPT-Live handoff. To reproduce the saved-WAV benchmark on macOS:

```sh
python3 tools/voice_lab/benchmark_dsp.py input-48k-pcm16.wav output-directory
```

## RVC adapter

`rvc_server.py` binds to loopback and adapts the Voice Lab's raw-WAV HTTP
request to either MLX-RVC on Apple silicon (the default) or the official RVC
project's `infer/cli.py`. It accepts one conversion at a time and returns `429`
instead of allowing an unbounded queue.

Prepare an MLX-RVC environment, then provide only a model trained from
explicitly consented material or carrying a license that expressly permits the
intended use:

```sh
python3 tools/voice_lab/rvc_server.py \
  --backend mlx \
  --mlx-rvc-cli /path/to/mlx-rvc \
  --model /path/to/shannon-consented-v1.pth \
  --index /path/to/added_shannon.index
```

For the official RVC WebUI CLI, add `--backend official`, `--python`, and
`--rvc-root` instead. A permissive code license on an RVC checkpoint does not
by itself prove that the training speaker consented to voice cloning.

The iPhone cannot reach the Mac's `127.0.0.1`; for a physical-device run, bind
to the Mac's private LAN address deliberately, use that address in the Lab,
and stop the adapter after the measurement. Do not expose this unauthenticated
debug adapter to a public network.

For a transport-only smoke test that does not claim neural conversion:

```sh
python3 tools/voice_lab/rvc_server.py --passthrough
```
