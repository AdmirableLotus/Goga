"""
Goga Whisper STT server
-----------------------
Persistent process: loads faster-whisper once, then accepts commands on stdin.

Commands (one per line, stdin):
  LISTEN <seconds>       — record up to <seconds>, transcribe, emit result
  CONTINUOUS_START       — start continuous VAD loop
  CONTINUOUS_STOP        — stop continuous loop
  ABORT                  — cancel any in-progress recording/transcription
  QUIT                   — exit cleanly

Stdout protocol (newline-delimited, flushed immediately):
  DEVICE_INFO <json>     — actual device/compute used (before READY)
  READY                  — model loaded, accepting commands
  TRANSCRIPT <text>      — transcription result
  ERROR <message>        — non-fatal error (process stays alive)
  DONE                   — LISTEN completed (with or without transcript)

Stderr: all diagnostic/timing logs (never mixed into stdout).

Audio privacy:
  Audio is held in numpy arrays in memory only.
  No audio is written to disk at any point.
  Arrays are deleted immediately after transcription or on abort.
"""

import sys
import os
import json
import threading
import time
import numpy as np

# ── Flush helpers ─────────────────────────────────────────────────────────────
def emit(line: str) -> None:
    """Write a protocol line to stdout, flushed immediately."""
    sys.stdout.write(line + "\n")
    sys.stdout.flush()

def diag(msg: str) -> None:
    """Write a diagnostic line to stderr with a timestamp."""
    ts = time.strftime("%H:%M:%S")
    sys.stderr.write(f"[{ts}] {msg}\n")
    sys.stderr.flush()

# ── Model config ──────────────────────────────────────────────────────────────
MODEL_SIZE   = os.environ.get("WHISPER_MODEL",   "base")
DEVICE       = os.environ.get("WHISPER_DEVICE",  "cuda")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "float16")
LANGUAGE     = os.environ.get("WHISPER_LANG",    None)

SAMPLE_RATE      = 16000
VAD_THRESHOLD    = 0.008   # RMS fraction of int16 max for voice activity
VAD_SILENCE_SECS = 1.8     # trailing silence before ending utterance
PRE_SPEECH_TIMEOUT_SECS = 8.0  # give up if no speech starts within this window
INPUT_GAIN       = float(os.environ.get("WHISPER_GAIN", "8.0"))  # software gain multiplier

# ── Load model ────────────────────────────────────────────────────────────────
_actual_device  = DEVICE
_actual_compute = COMPUTE_TYPE

diag(f"Loading model={MODEL_SIZE} device={DEVICE} compute_type={COMPUTE_TYPE}")
try:
    from faster_whisper import WhisperModel
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
    diag(f"Model loaded on {DEVICE}")
except Exception as e_cuda:
    diag(f"Primary load failed ({e_cuda}), falling back to cpu/int8")
    try:
        from faster_whisper import WhisperModel
        _actual_device  = "cpu"
        _actual_compute = "int8"
        model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
        diag("Model loaded on cpu/int8")
    except Exception as e2:
        emit(f"ERROR Failed to load model: {e2}")
        sys.exit(1)

emit("DEVICE_INFO " + json.dumps({
    "model":            MODEL_SIZE,
    "device":           _actual_device,
    "compute_type":     _actual_compute,
    "requested_device": DEVICE,
}))
emit("READY")
diag("READY emitted")

# ── Shared abort/stop events ──────────────────────────────────────────────────
# abort_event: set by ABORT or QUIT to cancel any in-progress work immediately.
# continuous_stop: set by CONTINUOUS_STOP to end the continuous loop cleanly.
abort_event     = threading.Event()
continuous_stop = threading.Event()

# ── Audio recording via persistent InputStream ───────────────────────────────
# We use a persistent sounddevice.InputStream so the audio driver is opened
# once and chunks are pulled from a queue. This avoids the per-chunk open/close
# overhead of sd.rec() and keeps the recording interruptible.

import queue as _queue

_audio_queue: "_queue.Queue[np.ndarray | None]" = _queue.Queue()
_stream_lock  = threading.Lock()
_active_stream = None  # type: ignore

def _stream_callback(indata: np.ndarray, frames: int, time_info, status) -> None:
    """Called by sounddevice on each audio block. Copies data into the queue."""
    if status:
        diag(f"sounddevice status: {status}")
    _audio_queue.put(indata[:, 0].copy())  # mono, copy before buffer is reused

def _open_stream() -> None:
    global _active_stream
    import sounddevice as sd
    with _stream_lock:
        if _active_stream is not None:
            return
        diag("Opening audio input stream")
        _active_stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="int16",
            blocksize=int(SAMPLE_RATE * 0.1),  # 100ms blocks
            callback=_stream_callback,
        )
        _active_stream.start()
        diag("Audio stream started")

def _close_stream() -> None:
    global _active_stream
    with _stream_lock:
        if _active_stream is None:
            return
        diag("Closing audio input stream")
        try:
            _active_stream.stop()
            _active_stream.close()
        except Exception as e:
            diag(f"Stream close error: {e}")
        _active_stream = None
        # Drain the queue so stale audio doesn't bleed into the next recording
        while not _audio_queue.empty():
            try: _audio_queue.get_nowait()
            except: break
        diag("Audio stream closed")

def record_audio(max_secs: float) -> np.ndarray:
    """
    Record audio from the persistent stream until:
      - trailing silence after speech (VAD_SILENCE_SECS)
      - no speech within PRE_SPEECH_TIMEOUT_SECS
      - max_secs elapsed
      - abort_event is set
    Returns float32 array at SAMPLE_RATE. Never writes to disk.
    """
    _open_stream()

    # Drain any stale audio that accumulated before this call
    while not _audio_queue.empty():
        try: _audio_queue.get_nowait()
        except: break

    chunks: list[np.ndarray] = []
    silence_chunks   = 0
    pre_speech_chunks = 0
    speech_started   = False
    block_secs       = 0.1
    max_blocks       = int(max_secs / block_secs)
    max_silence      = int(VAD_SILENCE_SECS / block_secs)
    max_pre_speech   = int(PRE_SPEECH_TIMEOUT_SECS / block_secs)
    vad_thresh       = VAD_THRESHOLD * 32768

    diag(f"Recording started (max={max_secs}s, pre_speech_timeout={PRE_SPEECH_TIMEOUT_SECS}s, gain={INPUT_GAIN}x)")

    for i in range(max_blocks):
        if abort_event.is_set():
            diag("Recording aborted by abort_event")
            break

        try:
            chunk = _audio_queue.get(timeout=0.2)
        except _queue.Empty:
            if abort_event.is_set():
                break
            continue

        chunks.append(chunk)
        # Apply software gain for VAD level check (compensates for low mic volume)
        level = float(np.sqrt(np.mean(chunk.astype(np.float32) ** 2))) * INPUT_GAIN

        if level > vad_thresh:
            if not speech_started:
                diag(f"Speech detected at chunk {i} (rms={level:.0f})")
            speech_started  = True
            silence_chunks  = 0
            pre_speech_chunks = 0
        elif speech_started:
            silence_chunks += 1
            if silence_chunks >= max_silence:
                diag(f"Trailing silence at chunk {i}, ending recording")
                break
        else:
            pre_speech_chunks += 1
            if pre_speech_chunks >= max_pre_speech:
                diag(f"No speech within {PRE_SPEECH_TIMEOUT_SECS}s, giving up")
                break

    if not chunks:
        diag("Recording produced no audio")
        return np.array([], dtype=np.float32)

    audio = np.concatenate(chunks).astype(np.float32) / 32768.0
    # Apply software gain and clip to [-1, 1] to avoid distortion
    audio = np.clip(audio * INPUT_GAIN, -1.0, 1.0)
    chunks.clear()
    diag(f"Recording stopped: {len(audio)/SAMPLE_RATE:.2f}s ({len(audio)} samples)")
    return audio


def transcribe(audio: np.ndarray) -> str:
    if len(audio) < SAMPLE_RATE * 0.3:
        diag("Audio too short, skipping transcription")
        return ""
    diag(f"Transcription started ({len(audio)/SAMPLE_RATE:.2f}s audio)")
    kwargs: dict = {"beam_size": 5, "vad_filter": True}
    if LANGUAGE:
        kwargs["language"] = LANGUAGE
    try:
        segments, info = model.transcribe(audio, **kwargs)
        result = " ".join(s.text.strip() for s in segments).strip()
        diag(f"Transcription completed: '{result[:60]}'" + ("..." if len(result) > 60 else ""))
        return result
    finally:
        del audio


# ── Worker thread for LISTEN (keeps stdin loop responsive) ───────────────────
# LISTEN runs on a worker thread so ABORT commands on stdin are processed
# immediately even while recording or transcribing.

_listen_thread: threading.Thread | None = None
_listen_done   = threading.Event()

def _listen_worker(max_secs: float) -> None:
    try:
        audio = record_audio(max_secs)
        if abort_event.is_set():
            diag("LISTEN aborted after recording")
            emit("DONE")
            return
        if len(audio) >= SAMPLE_RATE * 0.3:
            text = transcribe(audio)
            if abort_event.is_set():
                diag("LISTEN aborted after transcription")
                emit("DONE")
                return
            if text:
                diag(f"Emitting TRANSCRIPT: '{text[:60]}'")
                emit(f"TRANSCRIPT {text}")
        emit("DONE")
    except Exception as e:
        diag(f"LISTEN worker error: {e}")
        emit(f"ERROR {e}")
        emit("DONE")
    finally:
        _listen_done.set()


def _start_listen(max_secs: float) -> None:
    global _listen_thread
    _listen_done.clear()
    abort_event.clear()
    _listen_thread = threading.Thread(
        target=_listen_worker, args=(max_secs,), daemon=True, name="listen-worker"
    )
    _listen_thread.start()
    diag(f"LISTEN worker started (max={max_secs}s)")


# ── Continuous loop ───────────────────────────────────────────────────────────

_continuous_thread: threading.Thread | None = None

def _continuous_loop() -> None:
    diag("Continuous loop started")
    while not continuous_stop.is_set() and not abort_event.is_set():
        try:
            audio = record_audio(30.0)
            if continuous_stop.is_set() or abort_event.is_set():
                break
            if len(audio) < SAMPLE_RATE * 0.3:
                continue
            text = transcribe(audio)
            if continuous_stop.is_set() or abort_event.is_set():
                break
            if text:
                diag(f"Continuous TRANSCRIPT: '{text[:60]}'")
                emit(f"TRANSCRIPT {text}")
        except Exception as e:
            diag(f"Continuous loop error: {e}")
            emit(f"ERROR {e}")
            time.sleep(0.5)
    diag("Continuous loop exited")


# ── Stdin command loop ────────────────────────────────────────────────────────

diag("Entering command loop")

for raw_line in sys.stdin:
    cmd = raw_line.strip()
    if not cmd:
        continue
    diag(f"Command received: {cmd}")

    if cmd == "ABORT":
        abort_event.set()
        continuous_stop.set()
        # Wait briefly for the listen worker to finish, then reset
        if _listen_thread and _listen_thread.is_alive():
            _listen_thread.join(timeout=0.5)
        _close_stream()
        # Reset events for next use (continuous_stop stays set until CONTINUOUS_START)
        abort_event.clear()
        diag("ABORT handled")

    elif cmd.startswith("LISTEN"):
        # If a previous LISTEN is still running, abort it first
        if _listen_thread and _listen_thread.is_alive():
            diag("Previous LISTEN still running, aborting it")
            abort_event.set()
            _listen_thread.join(timeout=1.0)
            abort_event.clear()

        parts = cmd.split(maxsplit=1)
        secs  = float(parts[1]) if len(parts) > 1 else 12.0
        _start_listen(secs)

    elif cmd == "CONTINUOUS_START":
        abort_event.clear()
        continuous_stop.clear()
        if _continuous_thread and _continuous_thread.is_alive():
            diag("Continuous loop already running")
        else:
            _continuous_thread = threading.Thread(
                target=_continuous_loop, daemon=True, name="continuous-loop"
            )
            _continuous_thread.start()

    elif cmd == "CONTINUOUS_STOP":
        continuous_stop.set()
        abort_event.set()
        _close_stream()
        abort_event.clear()
        diag("CONTINUOUS_STOP handled")

    elif cmd == "QUIT":
        diag("QUIT received, shutting down")
        abort_event.set()
        continuous_stop.set()
        _close_stream()
        break

diag("Command loop exited, process terminating")
