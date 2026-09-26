#!/usr/bin/env python3
"""Small, local-only HTTP adapter for Shannon Voice Lab and RVC's official CLI."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import tempfile
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


MAX_BODY_BYTES = 10 * 1024 * 1024


class Configuration:
    def __init__(self, arguments: argparse.Namespace) -> None:
        self.backend = arguments.backend
        python_path = shutil.which(arguments.python) or arguments.python
        self.python = Path(python_path).expanduser().resolve()
        self.rvc_root = Path(arguments.rvc_root).expanduser().resolve()
        mlx_rvc_path = shutil.which(arguments.mlx_rvc_cli) or arguments.mlx_rvc_cli
        self.mlx_rvc_cli = Path(mlx_rvc_path).expanduser().resolve()
        self.model_id = arguments.model_id
        self.model = Path(arguments.model).expanduser().resolve() if arguments.model else None
        self.index = Path(arguments.index).expanduser().resolve() if arguments.index else None
        self.passthrough = arguments.passthrough
        self.slot = threading.BoundedSemaphore(1)

    def validate(self) -> None:
        if self.passthrough:
            return
        if self.backend == "official":
            cli = self.rvc_root / "infer" / "cli.py"
            if not self.python.is_file():
                raise ValueError(f"Python runtime not found: {self.python}")
            if not cli.is_file():
                raise ValueError(f"RVC infer/cli.py not found: {cli}")
        elif not self.mlx_rvc_cli.is_file():
            raise ValueError(f"mlx-rvc CLI not found: {self.mlx_rvc_cli}")
        if self.model is None or not self.model.is_file():
            raise ValueError("--model must be a consented or explicitly licensed .pth model")
        if self.model.suffix.lower() != ".pth":
            raise ValueError("--model must point to an RVC .pth model")
        if self.index is not None and not self.index.is_file():
            raise ValueError(f"RVC index not found: {self.index}")


class VoiceLabServer(ThreadingHTTPServer):
    configuration: Configuration


class RequestHandler(BaseHTTPRequestHandler):
    server: VoiceLabServer

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        configuration = self.server.configuration
        mode = "passthrough" if configuration.passthrough else "rvc"
        self.wfile.write(
            (f'{{"ok":true,"mode":"{mode}","backend":"{configuration.backend}"}}').encode("utf-8")
        )

    def do_POST(self) -> None:
        if self.path != "/v1/convert":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        configuration = self.server.configuration
        if self.headers.get("Content-Type", "").split(";", 1)[0] != "audio/wav":
            self.send_error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "audio/wav required")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return
        if not 44 <= length <= MAX_BODY_BYTES:
            self.send_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "WAV size out of range")
            return
        if self.headers.get("X-Shannon-RVC-Model") != configuration.model_id:
            self.send_error(HTTPStatus.BAD_REQUEST, "unknown or unapproved model ID")
            return
        if not configuration.slot.acquire(blocking=False):
            self.send_error(HTTPStatus.TOO_MANY_REQUESTS, "converter busy")
            return

        try:
            source = self.rfile.read(length)
            started = time.perf_counter()
            output = source if configuration.passthrough else self._convert(source)
            elapsed_ms = (time.perf_counter() - started) * 1_000
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(output)))
            self.send_header("X-Shannon-RVC-Processing-Ms", f"{elapsed_ms:.1f}")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(output)
        except subprocess.CalledProcessError as error:
            detail = (error.stderr or "RVC inference failed")[-1_000:]
            self.send_error(HTTPStatus.BAD_GATEWAY, detail)
        finally:
            configuration.slot.release()

    def _convert(self, source: bytes) -> bytes:
        configuration = self.server.configuration
        f0_method = self.headers.get("X-Shannon-RVC-F0", "rmvpe")
        if f0_method not in {"rmvpe", "harvest", "pm"}:
            raise subprocess.CalledProcessError(2, "infer/cli.py", stderr="Unsupported F0 method")
        pitch = float(self.headers.get("X-Shannon-RVC-Pitch", "0"))
        index_rate = float(self.headers.get("X-Shannon-RVC-Index-Rate", "0.5"))
        if not -24 <= pitch <= 24 or not 0 <= index_rate <= 1:
            raise subprocess.CalledProcessError(2, "infer/cli.py", stderr="RVC values out of range")

        with tempfile.TemporaryDirectory(prefix="shannon-rvc-") as directory:
            input_path = Path(directory) / "input.wav"
            output_path = Path(directory) / "output.wav"
            input_path.write_bytes(source)
            if configuration.backend == "mlx":
                command = [
                    str(configuration.mlx_rvc_cli),
                    "convert",
                    str(input_path),
                    str(output_path),
                    "--model",
                    str(configuration.model),
                    "--pitch",
                    str(round(pitch)),
                    "--f0-method",
                    "harvest" if f0_method == "pm" else f0_method,
                    "--index-rate",
                    str(index_rate),
                ]
                if configuration.index is not None:
                    command.extend(["--index", str(configuration.index)])
            else:
                command = [
                    str(configuration.python),
                    str(configuration.rvc_root / "infer" / "cli.py"),
                    "--model",
                    str(configuration.model),
                    "--input",
                    str(input_path),
                    "--output",
                    str(output_path),
                    "--pitch",
                    str(round(pitch)),
                    "--f0-method",
                    f0_method,
                    "--index-rate",
                    str(index_rate),
                    "--overwrite",
                ]
                if configuration.index is not None:
                    command.extend(["--index", str(configuration.index)])
            result = subprocess.run(
                command,
                cwd=configuration.rvc_root,
                check=True,
                capture_output=True,
                text=True,
                timeout=120,
                env={**os.environ, "PYTHONUNBUFFERED": "1"},
            )
            if not output_path.is_file():
                raise subprocess.CalledProcessError(
                    1, command, stderr=result.stderr or "RVC did not create output.wav"
                )
            return output_path.read_bytes()

    def log_message(self, format: str, *args: object) -> None:
        print(f"voice-lab-rvc: {self.address_string()} {format % args}")


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--python", default=os.environ.get("SHANNON_RVC_PYTHON", "python3"))
    parser.add_argument("--backend", choices=("mlx", "official"), default="mlx")
    parser.add_argument("--mlx-rvc-cli", default=os.environ.get("SHANNON_MLX_RVC_CLI", "mlx-rvc"))
    parser.add_argument("--rvc-root", default=os.environ.get("SHANNON_RVC_ROOT", "."))
    parser.add_argument("--model-id", default="shannon-consented-v1")
    parser.add_argument("--model", default=os.environ.get("SHANNON_RVC_MODEL"))
    parser.add_argument("--index", default=os.environ.get("SHANNON_RVC_INDEX"))
    parser.add_argument(
        "--passthrough",
        action="store_true",
        help="Protocol smoke test only; this does not perform RVC.",
    )
    return parser.parse_args()


def main() -> None:
    arguments = parse_arguments()
    configuration = Configuration(arguments)
    configuration.validate()
    server = VoiceLabServer((arguments.host, arguments.port), RequestHandler)
    server.configuration = configuration
    mode = "passthrough" if configuration.passthrough else "rvc"
    print(
        f"voice-lab-rvc: http://{arguments.host}:{arguments.port} "
        f"mode={mode} backend={configuration.backend}"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("voice-lab-rvc: stopped")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
