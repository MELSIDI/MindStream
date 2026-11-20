#!/usr/bin/env python3
"""Persistent local Kokoro-82M JSON-line TTS worker for MindStream.

Loads a single shared KModel (`hexgrad/Kokoro-82M`) and lazily creates
language-specific KPipelines (`'f'` for French, `'a'` for US English, `'b'` for UK English)
so switching between French and English takes milliseconds with minimal RAM.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import sys
import time
import warnings
import wave
from pathlib import Path

# Silence HuggingFace/library progress output on stdout and ignore stale local HF tokens
# for the public hexgrad/Kokoro-82M repository so expired OAuth caches never trigger 401.
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.pop("HF_TOKEN", None)
os.environ.pop("HUGGING_FACE_HUB_TOKEN", None)
warnings.filterwarnings("ignore")

PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr

DEFAULT_REPO_ID = "hexgrad/Kokoro-82M"
SAMPLE_RATE = 24000
DEFAULT_VOICES = {
    "f": "ff_siwis",
    "a": "af_heart",
    "b": "bf_emma",
}


def emit(payload: dict) -> None:
    line = json.dumps(payload, ensure_ascii=False)
    PROTOCOL_OUT.write(line + "\n")
    PROTOCOL_OUT.flush()


def bootstrap_espeak() -> None:
    """Configure bundled espeakng-loader binaries/data on Windows/POSIX before importing misaki/kokoro."""
    try:
        import espeakng_loader  # type: ignore

        if hasattr(espeakng_loader, "make_library_available"):
            try:
                espeakng_loader.make_library_available()
            except Exception:
                pass

        lib_path = (
            espeakng_loader.get_library_path()
            if hasattr(espeakng_loader, "get_library_path")
            else None
        )
        data_path = (
            espeakng_loader.get_data_path()
            if hasattr(espeakng_loader, "get_data_path")
            else None
        )

        if data_path and os.path.isdir(data_path):
            os.environ.setdefault("ESPEAK_DATA_PATH", data_path)
        if lib_path and os.path.isfile(lib_path):
            os.environ.setdefault("PHONEMIZER_ESPEAK_LIBRARY", lib_path)

        try:
            from phonemizer.backend.espeak.wrapper import EspeakWrapper  # type: ignore

            if lib_path and hasattr(EspeakWrapper, "set_library"):
                EspeakWrapper.set_library(lib_path)
            if data_path and hasattr(EspeakWrapper, "set_data_path"):
                EspeakWrapper.set_data_path(data_path)
        except Exception:
            pass
    except Exception:
        pass

    # Secondary fallback for Windows system-wide eSpeak NG installation.
    if os.name == "nt" and not os.environ.get("ESPEAK_DATA_PATH"):
        for candidate in (
            r"C:\Program Files\eSpeak NG\espeak-ng-data",
            r"C:\Program Files (x86)\eSpeak NG\espeak-ng-data",
        ):
            if os.path.isdir(candidate):
                os.environ["ESPEAK_DATA_PATH"] = candidate
                break


def clean_speech_text(text: str) -> str:
    cleaned = text.replace("`", "")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def resolve_lang_and_voice(lang: str | None, voice: str | None) -> tuple[str, str]:
    normalized_lang = (lang or "fr").strip().lower()
    raw_voice = (voice or "").strip()

    if normalized_lang.startswith("fr") or normalized_lang == "f":
        resolved_voice = raw_voice if raw_voice.startswith(("ff_", "fm_")) else DEFAULT_VOICES["f"]
        return "f", resolved_voice

    if raw_voice.startswith(("bf_", "bm_")) or normalized_lang in ("en-gb", "en_gb", "b"):
        resolved_voice = raw_voice if raw_voice.startswith(("bf_", "bm_")) else DEFAULT_VOICES["b"]
        return "b", resolved_voice

    resolved_voice = raw_voice if raw_voice.startswith(("af_", "am_")) else DEFAULT_VOICES["a"]
    return "a", resolved_voice


def choose_device(requested: str) -> str:
    req = (requested or "auto").strip().lower()
    if req in ("cpu", "cuda", "mps"):
        return req
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def audio_to_pcm16_bytes(chunks: list) -> tuple[bytes, int]:
    import numpy as np  # type: ignore

    arrays = []
    for chunk in chunks:
        if chunk is None:
            continue
        if hasattr(chunk, "detach"):
            arr = chunk.detach().cpu().numpy()
        else:
            arr = np.asarray(chunk)
        arr = np.asarray(arr, dtype=np.float32).reshape(-1)
        if arr.size > 0:
            arrays.append(arr)

    if not arrays:
        return b"", 0

    merged = np.concatenate(arrays)
    merged = np.clip(merged, -1.0, 1.0)
    pcm16 = (merged * 32767.0).astype("<i2")
    duration_ms = int(round((pcm16.size / SAMPLE_RATE) * 1000.0))
    return pcm16.tobytes(), duration_ms


def write_wav_bytes(pcm_bytes: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm_bytes)
    return buf.getvalue()


class KokoroEngine:
    def __init__(self, device: str, repo_id: str) -> None:
        from kokoro import KModel, KPipeline  # type: ignore

        self._KPipeline = KPipeline
        self.device = choose_device(device)
        self.repo_id = repo_id
        self.model = KModel(repo_id=repo_id).to(self.device).eval()
        self.pipelines: dict[str, object] = {}

    def get_pipeline(self, lang_code: str):
        pipe = self.pipelines.get(lang_code)
        if pipe is None:
            pipe = self._KPipeline(
                lang_code=lang_code,
                repo_id=self.repo_id,
                model=self.model,
                device=self.device,
            )
            self.pipelines[lang_code] = pipe
        return pipe

    def synthesize(
        self,
        text: str,
        lang: str | None,
        voice: str | None,
        speed: float,
        out_path: str | None,
    ) -> dict:
        lang_code, resolved_voice = resolve_lang_and_voice(lang, voice)
        cleaned = clean_speech_text(text)
        if not cleaned:
            return {
                "durationMs": 0,
                "lang": "fr" if lang_code == "f" else "en",
                "langCode": lang_code,
                "voice": resolved_voice,
                "path": out_path,
            }

        clamped_speed = max(0.5, min(2.2, float(speed or 1.0)))
        pipe = self.get_pipeline(lang_code)

        audio_chunks = []
        for _gs, _ps, audio in pipe(
            cleaned,
            voice=resolved_voice,
            speed=clamped_speed,
            split_pattern=r"\n+",
        ):
            if audio is not None:
                audio_chunks.append(audio)

        pcm_bytes, duration_ms = audio_to_pcm16_bytes(audio_chunks)
        wav_bytes = write_wav_bytes(pcm_bytes)

        result = {
            "durationMs": duration_ms,
            "lang": "fr" if lang_code == "f" else "en",
            "langCode": lang_code,
            "voice": resolved_voice,
        }

        if out_path:
            out_file = Path(out_path)
            out_file.parent.mkdir(parents=True, exist_ok=True)
            out_file.write_bytes(wav_bytes)
            result["path"] = str(out_file)
        else:
            result["base64"] = base64.b64encode(wav_bytes).decode("ascii")

        return result


def run_check() -> int:
    try:
        bootstrap_espeak()
        import kokoro  # type: ignore # noqa: F401
        import numpy  # type: ignore # noqa: F401

        emit({"ok": True, "repoId": DEFAULT_REPO_ID})
        return 0
    except Exception as exc:
        emit({"ok": False, "error": str(exc)})
        return 1


def run_warmup(device: str, repo_id: str) -> int:
    t0 = time.time()
    bootstrap_espeak()
    engine = KokoroEngine(device=device, repo_id=repo_id)
    fr_res = engine.synthesize(
        "Bonjour, Kokoro est prêt pour le pair-programming.",
        lang="fr",
        voice="ff_siwis",
        speed=1.0,
        out_path=None,
    )
    en_res = engine.synthesize(
        "Hello, Kokoro local speech is ready.",
        lang="en",
        voice="af_heart",
        speed=1.0,
        out_path=None,
    )
    emit(
        {
            "ok": True,
            "device": engine.device,
            "repoId": repo_id,
            "elapsedMs": int((time.time() - t0) * 1000),
            "frDurationMs": fr_res["durationMs"],
            "enDurationMs": en_res["durationMs"],
        }
    )
    return 0


def serve(device: str, repo_id: str) -> int:
    bootstrap_espeak()
    try:
        engine = KokoroEngine(device=device, repo_id=repo_id)
    except Exception as exc:
        emit({"type": "fatal", "error": f"Failed to initialize Kokoro-82M: {exc}"})
        return 1

    emit(
        {
            "type": "ready",
            "device": engine.device,
            "repoId": repo_id,
            "voices": ["ff_siwis", "af_heart", "af_bella", "am_michael", "am_fenrir", "bf_emma", "bm_george"],
        }
    )

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except Exception as exc:
            emit({"type": "error", "error": f"Invalid JSON request: {exc}"})
            continue

        cmd_type = cmd.get("type")
        req_id = cmd.get("id")

        if cmd_type == "quit":
            emit({"type": "bye", "id": req_id})
            break

        if cmd_type == "ping":
            emit({"type": "pong", "id": req_id})
            continue

        if cmd_type == "synth":
            try:
                res = engine.synthesize(
                    text=str(cmd.get("text", "")),
                    lang=cmd.get("lang"),
                    voice=cmd.get("voice"),
                    speed=float(cmd.get("speed", 1.0)),
                    out_path=cmd.get("outPath"),
                )
                emit({"type": "audio", "id": req_id, **res})
            except Exception as exc:
                emit({"type": "error", "id": req_id, "error": str(exc)})
            continue

        emit({"type": "error", "id": req_id, "error": f"Unknown command: {cmd_type}"})

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="MindStream Kokoro-82M TTS Worker")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda", "mps"])
    parser.add_argument("--repo-id", default=DEFAULT_REPO_ID)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--warmup", action="store_true")
    args = parser.parse_args()

    if args.check:
        return run_check()
    if args.warmup:
        return run_warmup(device=args.device, repo_id=args.repo_id)
    return serve(device=args.device, repo_id=args.repo_id)


if __name__ == "__main__":
    raise SystemExit(main())
