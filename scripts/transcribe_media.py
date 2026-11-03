#!/usr/bin/env python
"""
transcribe_media.py — transcribe a long audio OR video file to a text transcript.

Usage: python transcribe_media.py <media_path> <output_txt_path>

faster-whisper decodes the audio stream of a video (mp4/mkv/…) directly through
PyAV, so no separate ffmpeg step is needed. Segments are written to the output
file as they are produced, and progress is printed so Goga can report it:

    PROGRESS <seconds_done> <total_seconds>   (repeated)
    DONE <characters_written>
    ERROR <message>                           (on failure)

Model/device/compute come from the same env vars as whisper_stt.py
(WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE, WHISPER_LANG).
"""
import os
import sys


def emit(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def diag(msg: str) -> None:
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def register_cuda_dlls() -> None:
    # cuBLAS/cuDNN installed via pip aren't on PATH; add their bin dirs (as whisper_stt.py does).
    if os.name != "nt":
        return
    try:
        import nvidia
        for root in nvidia.__path__:
            for pkg in os.listdir(root):
                b = os.path.join(root, pkg, "bin")
                if os.path.isdir(b):
                    os.add_dll_directory(b)
                    os.environ["PATH"] = b + os.pathsep + os.environ.get("PATH", "")
    except Exception:
        pass


def main() -> int:
    if len(sys.argv) < 3:
        emit("ERROR usage: transcribe_media.py <media> <output>")
        return 2
    media, out_path = sys.argv[1], sys.argv[2]
    if not os.path.isfile(media):
        emit(f"ERROR file not found: {media}")
        return 2

    model_size = os.environ.get("WHISPER_MODEL", "base")
    device = os.environ.get("WHISPER_DEVICE", "cuda")
    compute = os.environ.get("WHISPER_COMPUTE", "int8_float16" if device != "cpu" else "int8")
    lang = os.environ.get("WHISPER_LANG") or None
    fast_model = os.environ.get("MEDIA_FAST_MODEL", "small")
    fast_over = float(os.environ.get("MEDIA_FAST_OVER_SECS", "2400"))  # 40 minutes

    # Probe the duration cheaply (reads the container header, no decode). A long recording
    # transcribes far faster with a smaller model, so switch for anything over the threshold —
    # an accurate big model would otherwise take hours on a six-hour video.
    duration = 0.0
    try:
        import av
        with av.open(media) as _c:
            if _c.duration:
                duration = float(_c.duration) / 1_000_000.0
    except Exception as e:
        diag(f"duration probe failed: {e}")
    if duration > fast_over and fast_model and fast_model != model_size:
        diag(f"long media ({duration:.0f}s) -> faster model {fast_model} (was {model_size})")
        model_size = fast_model
    emit(f"MODEL {model_size}")

    if device != "cpu":
        register_cuda_dlls()

    from faster_whisper import WhisperModel

    def load(dev: str, comp: str):
        diag(f"loading model={model_size} device={dev} compute={comp}")
        return WhisperModel(model_size, device=dev, compute_type=comp)

    try:
        model = load(device, compute)
    except Exception as e:
        diag(f"GPU load failed ({e}); falling back to CPU")
        device, compute = "cpu", "int8"
        try:
            model = load(device, compute)
        except Exception as e2:
            emit(f"ERROR could not load the speech model: {e2}")
            return 1

    try:
        # vad_filter drops long silences — cheaper, and it avoids whisper repeating itself
        # over quiet gaps common in recorded lectures.
        segments, info = model.transcribe(media, vad_filter=True, language=lang)
    except Exception as e:
        emit(f"ERROR could not read that media file: {e}")
        return 1

    total = float(getattr(info, "duration", 0.0) or 0.0)
    chars = 0
    last_report = -1.0
    try:
        with open(out_path, "w", encoding="utf-8") as f:
            for seg in segments:
                text = (seg.text or "").strip()
                if text:
                    f.write(text + "\n")
                    f.flush()
                    chars += len(text) + 1
                end = float(getattr(seg, "end", 0.0) or 0.0)
                # Report at most every ~15 s of audio covered, to keep stdout quiet.
                if end - last_report >= 15.0:
                    emit(f"PROGRESS {end:.0f} {total:.0f}")
                    last_report = end
    except Exception as e:
        emit(f"ERROR transcription stopped: {e}")
        return 1

    emit(f"DONE {chars}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
