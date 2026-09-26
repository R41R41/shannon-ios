from __future__ import annotations

import io
import math
import pathlib
import struct
import unittest
import wave

from tools.voice_lab.web_lab import (
    VoiceLabProcessor,
    parse_tuning,
    read_pcm16_bytes,
    write_pcm16_bytes,
)


def sine_wave(duration: float = 0.5, rate: int = 24_000) -> bytes:
    samples = [math.sin(2 * math.pi * 220 * frame / rate) * 0.25 for frame in range(round(duration * rate))]
    target = io.BytesIO()
    with wave.open(target, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(struct.pack(f"<{len(samples)}h", *[round(value * 32767) for value in samples]))
    return target.getvalue()


class VoiceLabWebTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.repository = pathlib.Path(__file__).resolve().parents[2]
        cls.processor = VoiceLabProcessor(cls.repository)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.processor.close()

    def test_pcm16_round_trip_keeps_shape(self) -> None:
        rate, channels, samples = read_pcm16_bytes(sine_wave())
        output = write_pcm16_bytes(rate, channels, samples)
        output_rate, output_channels, output_samples = read_pcm16_bytes(output)
        self.assertEqual((output_rate, output_channels), (rate, channels))
        self.assertEqual(len(output_samples), len(samples))

    def test_tuning_is_bounded(self) -> None:
        self.assertEqual(parse_tuning("/api/process?pitch=135&formant=1.3"), (135, 1.3))
        with self.assertRaises(ValueError):
            parse_tuning("/api/process?pitch=500&formant=0")
        with self.assertRaises(ValueError):
            parse_tuning("/api/process?pitch=0&formant=nan")

    def test_processor_preserves_duration_and_reports_latency(self) -> None:
        source = sine_wave()
        output, elapsed, latency = self.processor.render(source, 100, 1.2)
        _, _, source_samples = read_pcm16_bytes(source)
        _, _, output_samples = read_pcm16_bytes(output)
        self.assertEqual(len(output_samples), len(source_samples))
        self.assertGreater(elapsed, 0)
        self.assertGreater(latency, 0)


if __name__ == "__main__":
    unittest.main()
