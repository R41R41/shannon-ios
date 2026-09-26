#!/usr/bin/env python3
"""Loopback-only browser UI for Shannon pitch and formant tuning."""

from __future__ import annotations

import argparse
import ctypes
import io
import json
import math
import pathlib
import struct
import tempfile
import threading
import time
import wave
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

try:
    from .benchmark_dsp import Latency, build_library, process
except ImportError:
    from benchmark_dsp import Latency, build_library, process


MAX_BODY_BYTES = 20 * 1024 * 1024
STATIC_CONTENT = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
}


def read_pcm16_bytes(payload: bytes) -> tuple[int, int, list[float]]:
    with wave.open(io.BytesIO(payload), "rb") as source:
        if source.getsampwidth() != 2 or source.getcomptype() != "NONE":
            raise ValueError("16-bit PCM WAVを選んでください。")
        channels = source.getnchannels()
        if channels not in (1, 2):
            raise ValueError("monoまたはstereoのWAVを選んでください。")
        rate = source.getframerate()
        raw = source.readframes(source.getnframes())
    if not raw:
        raise ValueError("音声データが空です。")
    values = struct.unpack(f"<{len(raw) // 2}h", raw)
    return rate, channels, [value / 32768.0 for value in values]


def write_pcm16_bytes(rate: int, channels: int, samples: list[float]) -> bytes:
    quantized = [max(-32768, min(32767, round(value * 32767))) for value in samples]
    target = io.BytesIO()
    with wave.open(target, "wb") as output:
        output.setnchannels(channels)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(struct.pack(f"<{len(quantized)}h", *quantized))
    return target.getvalue()


def parse_tuning(path: str) -> tuple[float, float]:
    query = parse_qs(urlsplit(path).query)
    try:
        pitch = float(query.get("pitch", ["0"])[0])
        formant = float(query.get("formant", ["0"])[0])
    except ValueError as error:
        raise ValueError("PitchまたはFormantの値が不正です。") from error
    if not math.isfinite(pitch) or not -300 <= pitch <= 400:
        raise ValueError("Pitchは-300〜+400 centsで指定してください。")
    if not math.isfinite(formant) or not -3 <= formant <= 3:
        raise ValueError("Formantは-3.0〜+3.0半音で指定してください。")
    return pitch, formant


class VoiceLabProcessor:
    def __init__(self, repository: pathlib.Path) -> None:
        self._temporary = tempfile.TemporaryDirectory(prefix="shannon-voice-web-")
        library_path = build_library(repository, pathlib.Path(self._temporary.name))
        library = ctypes.CDLL(str(library_path))
        function = library.shannon_voice_dsp_process
        function.argtypes = [
            ctypes.POINTER(ctypes.c_float), ctypes.c_int32, ctypes.c_int32,
            ctypes.c_double, ctypes.c_float, ctypes.c_float,
            ctypes.POINTER(ctypes.c_float), ctypes.POINTER(Latency),
        ]
        function.restype = ctypes.c_bool
        self._library = library
        self._function = function
        self._lock = threading.Lock()

    def close(self) -> None:
        self._temporary.cleanup()

    def render(self, payload: bytes, pitch: float, formant: float) -> tuple[bytes, float, float]:
        rate, channels, samples = read_pcm16_bytes(payload)
        if pitch == 0 and formant == 0:
            return payload, 0.0, 0.0
        with self._lock:
            rendered, latency, elapsed_ms = process(
                self._function, samples, rate, channels, pitch, formant
            )
        latency_ms = (latency.input + latency.output) / rate * 1_000
        return write_pcm16_bytes(rate, channels, rendered), elapsed_ms, latency_ms


class VoiceLabHTTPServer(ThreadingHTTPServer):
    processor: VoiceLabProcessor
    static_root: pathlib.Path
    default_source: pathlib.Path | None
    source_dir: pathlib.Path | None


class RequestHandler(BaseHTTPRequestHandler):
    server: VoiceLabHTTPServer

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path in STATIC_CONTENT:
            filename, content_type = STATIC_CONTENT[path]
            self._send_bytes(
                self.server.static_root.joinpath(filename).read_bytes(), content_type
            )
            return
        if path == "/api/health":
            self._send_json({
                "ok": True,
                "localOnly": True,
                "hasDefaultSource": self.server.default_source is not None,
                "hasEmotionSources": self.server.source_dir is not None,
            })
            return
        if path == "/api/emotions" and self.server.source_dir is not None:
            manifest = self.server.source_dir / "manifest.json"
            self._send_bytes(manifest.read_bytes(), "application/json; charset=utf-8", {
                "Cache-Control": "no-store",
            })
            return
        if path.startswith("/api/emotion/") and self.server.source_dir is not None:
            parts = path.removeprefix("/api/emotion/").split("/")
            if len(parts) == 2:
                voice, slug = parts
                source = self.server.source_dir / voice / f"{slug}.wav"
            elif len(parts) == 1:
                slug = parts[0]
                source = self.server.source_dir / f"{slug}.wav"
            else:
                self.send_error(HTTPStatus.BAD_REQUEST)
                return
            if any(not part or not part.replace("-", "").isalnum() for part in parts):
                self.send_error(HTTPStatus.BAD_REQUEST)
                return
            if not source.is_file():
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self._send_bytes(source.read_bytes(), "audio/wav", {
                "X-Shannon-Source-Name": source.name,
                "Cache-Control": "no-store",
            })
            return
        if path == "/api/default.wav" and self.server.default_source is not None:
            source = self.server.default_source
            self._send_bytes(
                source.read_bytes(),
                "audio/wav",
                {"X-Shannon-Source-Name": source.name, "Cache-Control": "no-store"},
            )
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        if urlsplit(self.path).path != "/api/process":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if self.headers.get("Content-Type", "").split(";", 1)[0] not in {
            "audio/wav", "audio/x-wav", "application/octet-stream"
        }:
            self._send_json_error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "WAVが必要です。")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 44 <= length <= MAX_BODY_BYTES:
                raise ValueError("WAVは20 MB以下にしてください。")
            pitch, formant = parse_tuning(self.path)
            payload = self.rfile.read(length)
            output, processing_ms, latency_ms = self.server.processor.render(
                payload, pitch, formant
            )
        except (ValueError, wave.Error) as error:
            self._send_json_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        except RuntimeError as error:
            self._send_json_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(error))
            return

        self._send_bytes(output, "audio/wav", {
            "X-Shannon-Processing-Ms": f"{processing_ms:.2f}",
            "X-Shannon-Algorithm-Latency-Ms": f"{latency_ms:.2f}",
            "Cache-Control": "no-store",
        })

    def _send_json(self, value: dict[str, object], status: HTTPStatus = HTTPStatus.OK) -> None:
        self._send_bytes(
            (json.dumps(value, ensure_ascii=False) + "\n").encode("utf-8"),
            "application/json; charset=utf-8",
            status=status,
        )

    def _send_json_error(self, status: HTTPStatus, message: str) -> None:
        self._send_json({"ok": False, "error": message}, status)

    def _send_bytes(
        self,
        payload: bytes,
        content_type: str,
        headers: dict[str, str] | None = None,
        status: HTTPStatus = HTTPStatus.OK,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; media-src 'self' blob:; style-src 'self'; script-src 'self'")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(payload)
        except BrokenPipeError:
            pass

    def log_message(self, format: str, *args: object) -> None:
        print(f"voice-lab-web: {self.address_string()} {format % args}")


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--source", type=pathlib.Path)
    parser.add_argument("--source-dir", type=pathlib.Path)
    parser.add_argument("--no-open", action="store_true")
    return parser.parse_args()


def main() -> None:
    arguments = parse_arguments()
    repository = pathlib.Path(__file__).resolve().parents[2]
    static_root = pathlib.Path(__file__).resolve().parent / "web"
    source = arguments.source.expanduser().resolve() if arguments.source else None
    source_dir = arguments.source_dir.expanduser().resolve() if arguments.source_dir else None
    if source is not None and not source.is_file():
        raise SystemExit(f"Default source not found: {source}")
    if source_dir is not None:
        if not source_dir.is_dir() or not source_dir.joinpath("manifest.json").is_file():
            raise SystemExit(f"Emotion source directory not found: {source_dir}")

    processor = VoiceLabProcessor(repository)
    server = VoiceLabHTTPServer(("127.0.0.1", arguments.port), RequestHandler)
    server.processor = processor
    server.static_root = static_root
    server.default_source = source
    server.source_dir = source_dir
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"voice-lab-web: {url} local-only", flush=True)
    if not arguments.no_open:
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("voice-lab-web: stopped")
    finally:
        server.server_close()
        processor.close()


if __name__ == "__main__":
    main()
