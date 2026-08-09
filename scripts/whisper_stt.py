"""
Goga Whisper STT server
-----------------------
Persistent process: loads faster-whisper once, then accepts commands on stdin.

Commands (one per line):
  LISTEN <seconds>       — record for up to <seconds> and transcribe once
  CONTINUOUS_START       — start continuous VAD-based recording loop
  CONTINUOUS_STOP        — stop continuous loop
  QUIT                   — exit

Output lines:
  READY                  — model loaded, ready for commands
  TRANSCRIPT <text>      — transcription result
  ERROR <message>        — error
  DONE                   — one-shot LISTEN completed (even if empty)
"""

import sys
import os
import threading
import tempfile
import time
import numpy as np

# ── Model config from env (set by WhisperSttProvider.ts) ─────────────────────
MODEL_SIZE   = os.environ.get("WHISPER_MODEL", "base")
DEVICE       = os.environ.get("WHISPER_DEVICE", "cuda")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "float16")
LANGUAGE     = os.environ.get("WHISPER_LANG", None)  # None = auto-detect

SAMPLE_RATE  = 16000   # Whisper expects 16kHz
CHUNK_SECS   = 0.1     # recording chunk size
VAD_SILENCE_SECS = 1.2 # seconds of silence before ending an utterance
VAD_THRESHOLD    = 0.01 # RMS threshold for voice activity

def emit(line: str):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()

def rms(data: np.ndarray) -> float:
    return float(np.sqrt(np.mean(data.astype(np.float32) ** 2)))

# ── Load model ────────────────────────────────────────────────────────────────
try:
    from faster_whisper import WhisperModel
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
    emit("READY")
except Exception as e:
    # CUDA may not be available — fall back to CPU
    try:
        from faster_whisper import WhisperModel
        model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
        emit("READY")
    except Exception as e2:
        emit(f"ERROR Failed to load model: {e2}")
        sys.exit(1)

# ── Audio recording ───────────────────────────────────────────────────────────
def record_audio(max_secs: float, stop_event: threading.Event | None = None) -> np.ndarray:
    """Record audio until silence or max_secs. Returns float32 numpy array at 16kHz."""
    import sounddevice as sd

    chunks = []
    silence_chunks = 0
    max_silence = int(VAD_SILENCE_SECS / CHUNK_SECS)
    max_chunks   = int(max_secs / CHUNK_SECS)
    speech_started = False

    for _ in range(max_chunks):
        if stop_event and stop_event.is_set():
            break
        chunk = sd.rec(int(CHUNK_SECS * SAMPLE_RATE), samplerate=SAMPLE_RATE,
                       channels=1, dtype='int16', blocking=True)
        arr = chunk.flatten()
        chunks.append(arr)

        if rms(arr) > VAD_THRESHOLD * 32768:
            speech_started = True
            silence_chunks = 0
        elif speech_started:
            silence_chunks += 1
            if silence_chunks >= max_silence:
                break

    if not chunks:
        return np.array([], dtype=np.float32)
    audio = np.concatenate(chunks).astype(np.float32) / 32768.0
    return audio

def transcribe(audio: np.ndarray) -> str:
    if len(audio) < SAMPLE_RATE * 0.3:  # less than 0.3s — skip
        return ""
    kwargs = {"beam_size": 5, "vad_filter": True}
    if LANGUAGE:
        kwargs["language"] = LANGUAGE
    segments, _ = model.transcribe(audio, **kwargs)
    return " ".join(s.text.strip() for s in segments).strip()

# ── Command loop ──────────────────────────────────────────────────────────────
continuous_stop = threading.Event()
continuous_thread: threading.Thread | None = None

def continuous_loop():
    import sounddevice as sd
    while not continuous_stop.is_set():
        try:
            audio = record_audio(30.0, continuous_stop)
            if continuous_stop.is_set():
                break
            if len(audio) < SAMPLE_RATE * 0.3:
                continue
            text = transcribe(audio)
            if text:
                emit(f"TRANSCRIPT {text}")
        except Exception as e:
            emit(f"ERROR {e}")
            time.sleep(0.5)

for line in sys.stdin:
    cmd = line.strip()
    if not cmd:
        continue

    if cmd.startswith("LISTEN"):
        parts = cmd.split(maxsplit=1)
        secs = float(parts[1]) if len(parts) > 1 else 12.0
        try:
            audio = record_audio(secs)
            text = transcribe(audio)
            if text:
                emit(f"TRANSCRIPT {text}")
            emit("DONE")
        except Exception as e:
            emit(f"ERROR {e}")
            emit("DONE")

    elif cmd == "CONTINUOUS_START":
        if continuous_thread and continuous_thread.is_alive():
            pass  # already running
        else:
            continuous_stop.clear()
            continuous_thread = threading.Thread(target=continuous_loop, daemon=True)
            continuous_thread.start()

    elif cmd == "CONTINUOUS_STOP":
        continuous_stop.set()

    elif cmd == "QUIT":
        continuous_stop.set()
        break
