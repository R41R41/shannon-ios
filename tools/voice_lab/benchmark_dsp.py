#!/usr/bin/env python3
"""Reproducible macOS benchmark/export for Shannon's vendored formant DSP."""

from __future__ import annotations

import argparse
import ctypes
import json
import pathlib
import shutil
import struct
import subprocess
import tempfile
import time
import wave


class Latency(ctypes.Structure):
    _fields_ = [("input", ctypes.c_int32), ("output", ctypes.c_int32)]


def build_library(repo: pathlib.Path, build_dir: pathlib.Path) -> pathlib.Path:
    output = build_dir / "libShannonVoiceDSP.dylib"
    source = repo / "apps/ios/Sources/ShannonVoiceDSP/ShannonVoiceDSP.cpp"
    include = repo / "apps/ios/Sources/ShannonVoiceDSP/include"
    vendor = repo / "apps/ios/Sources/ShannonVoiceDSP/vendor"
    subprocess.run(
        [
            "xcrun", "clang++", "-std=c++17", "-O2", "-dynamiclib",
            "-DSIGNALSMITH_USE_ACCELERATE", "-framework", "Accelerate",
            f"-I{include}", f"-I{vendor}", str(source), "-o", str(output),
        ],
        check=True,
    )
    return output


def read_pcm16(path: pathlib.Path) -> tuple[int, int, list[float]]:
    with wave.open(str(path), "rb") as source:
        if source.getsampwidth() != 2 or source.getcomptype() != "NONE":
            raise ValueError("input must be uncompressed 16-bit PCM WAV")
        channels = source.getnchannels()
        if channels not in (1, 2):
            raise ValueError("input must be mono or stereo")
        rate = source.getframerate()
        raw = source.readframes(source.getnframes())
    values = struct.unpack(f"<{len(raw) // 2}h", raw)
    return rate, channels, [value / 32768.0 for value in values]


def write_pcm16(path: pathlib.Path, rate: int, channels: int, samples: list[float]) -> None:
    quantized = [max(-32768, min(32767, round(value * 32767))) for value in samples]
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as target:
        target.setnchannels(channels)
        target.setsampwidth(2)
        target.setframerate(rate)
        target.writeframes(struct.pack(f"<{len(quantized)}h", *quantized))


def process(function, samples: list[float], rate: int, channels: int,
            pitch_cents: float, formant_semitones: float) -> tuple[list[float], Latency, float]:
    frames = len(samples) // channels
    array_type = ctypes.c_float * len(samples)
    source = array_type(*samples)
    target = array_type()
    latency = Latency()
    started = time.perf_counter_ns()
    ok = function(
        source, frames, channels, float(rate), pitch_cents / 100.0,
        formant_semitones, target, ctypes.byref(latency),
    )
    elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000
    if not ok:
        raise RuntimeError("shannon_voice_dsp_process failed")
    return list(target), latency, elapsed_ms


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=pathlib.Path)
    parser.add_argument("output_dir", type=pathlib.Path)
    parser.add_argument("--iterations", type=int, default=5)
    args = parser.parse_args()

    repo = pathlib.Path(__file__).resolve().parents[2]
    rate, channels, samples = read_pcm16(args.input)
    presets = [
        ("formant-only", 0.0, 1.4),
        ("pitch-formant", 100.0, 1.2),
    ]
    args.output_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(args.input, args.output_dir / "off.wav")
    report = {
        "input": str(args.input.resolve()),
        "sample_rate": rate,
        "channels": channels,
        "duration_seconds": len(samples) / channels / rate,
        "iterations": args.iterations,
        "presets": [],
    }
    with tempfile.TemporaryDirectory(prefix="shannon-voice-bench-") as temporary:
        library = ctypes.CDLL(str(build_library(repo, pathlib.Path(temporary))))
        function = library.shannon_voice_dsp_process
        function.argtypes = [
            ctypes.POINTER(ctypes.c_float), ctypes.c_int32, ctypes.c_int32,
            ctypes.c_double, ctypes.c_float, ctypes.c_float,
            ctypes.POINTER(ctypes.c_float), ctypes.POINTER(Latency),
        ]
        function.restype = ctypes.c_bool
        for name, pitch, formant in presets:
            timings = []
            rendered = None
            latency = None
            for _ in range(args.iterations):
                rendered, latency, elapsed = process(
                    function, samples, rate, channels, pitch, formant
                )
                timings.append(elapsed)
            assert rendered is not None and latency is not None
            write_pcm16(args.output_dir / f"{name}.wav", rate, channels, rendered)
            timings.sort()
            report["presets"].append({
                "id": name,
                "pitch_cents": pitch,
                "formant_semitones": formant,
                "median_processing_ms": timings[len(timings) // 2],
                "p95_processing_ms": timings[max(0, int(len(timings) * 0.95 + 0.999) - 1)],
                "realtime_factor_median": timings[len(timings) // 2] / 1000.0
                    / report["duration_seconds"],
                "algorithm_latency_ms": (latency.input + latency.output) / rate * 1000.0,
            })
    report_path = args.output_dir / "measurements.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(report_path)


if __name__ == "__main__":
    main()
