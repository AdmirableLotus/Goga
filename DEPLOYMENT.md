# Goga Deployment Guide

## Runtime Dependencies

### Electron app (bundled)
All Node.js/Electron dependencies are bundled by the build. No separate Node installation required on the target machine.

### Kokoro TTS (local neural TTS)
Kokoro runs inside the Electron process via `kokoro-js`. No external runtime needed. The model (~600MB) is downloaded on first use via Settings → TTS provider → Kokoro → Download.

---

## Whisper STT (optional, offline GPU speech recognition)

Whisper STT requires a separate Python runtime and packages. **A development-machine `pip install` does not carry over to another PC.** Each target machine needs the following installed.

### 1. Python 3.9–3.14

Download from https://python.org. During install, check **"Add Python to PATH"**.

Verify:
```
python --version
```

### 2. Python packages

```
pip install faster-whisper sounddevice
```

| Package | Purpose |
|---|---|
| `faster-whisper` | CTranslate2-based Whisper inference |
| `sounddevice` | Microphone capture (PortAudio wrapper) |

These are **not bundled** with Goga. They must be installed on every machine that will use Whisper STT.

### 3. Whisper model (downloaded on first use)

The model is **not bundled** with Goga. On first use after selecting Whisper in Settings, Goga will:

1. Show a pre-download disclosure in the log:
   - Model name and approximate size
   - Source: `https://huggingface.co/Systran/faster-whisper-<model>`
   - Cache destination: `~/.cache/huggingface/hub/models--Systran--faster-whisper-<model>`
2. Emit a `whisper:download-required` event to the UI
3. Download the model automatically when recognition is first triggered

**Approximate download sizes:**

| Model | Size | Notes |
|---|---|---|
| tiny | ~75 MB | Fastest, lowest accuracy |
| base | ~145 MB | Recommended default |
| small | ~480 MB | Better accuracy |
| medium | ~1.5 GB | High accuracy |
| large-v2/v3 | ~3.1 GB | Best accuracy |

The model is cached permanently in `~/.cache/huggingface/hub/`. Subsequent launches load from cache with no network access.

**Recognition will never trigger a network download without first logging the disclosure.** The `whisper:preflight` IPC call returns disclosure info without starting any process or network activity.

### 4. CUDA (optional, for GPU acceleration)

If an NVIDIA GPU with CUDA is present, `faster-whisper` uses it automatically (`device=cuda`, `compute_type=float16`). If CUDA is unavailable, the Python script falls back to CPU (`device=cpu`, `compute_type=int8`) and logs:

```
WhisperSTT: model=base device=cpu compute_type=int8 (requested cuda, fell back to cpu)
```

The log always states the **actual** device used, not the requested one. Do not describe it as GPU operation if the log shows `device=cpu`.

CUDA toolkit: https://developer.nvidia.com/cuda-downloads  
cuDNN: https://developer.nvidia.com/cudnn

### 5. Microphone

A working default microphone is required. `sounddevice` uses the system default audio input device. If no microphone is available, the Python script will emit `ERROR` and Goga falls back to Windows STT automatically.

---

## Fallback chain

Goga selects the STT provider in this order at startup:

1. **ElevenLabs** — if `ELEVENLABS_API_KEY` is set and the key has `speech_to_text` permission
2. **Whisper** — if `sttProvider = 'whisper'` in settings AND `scripts/whisper_stt.py` exists on disk
3. **Windows Speech** — always available, no dependencies, offline

If Python is missing, `faster-whisper` is not installed, the model fails to load, CUDA is unavailable, or the microphone fails, Goga falls back to Windows Speech automatically. The fallback is logged.

---

## Audio privacy

- All microphone audio is held in numpy arrays **in process memory only**
- No audio is written to disk at any point
- Audio memory is released immediately after transcription, on ABORT, CONTINUOUS_STOP, or QUIT
- The Python process is terminated on app shutdown via `QUIT` + `kill()`

---

## Packaging checklist

When distributing Goga to another machine:

- [ ] Python 3.9+ installed and on PATH
- [ ] `pip install faster-whisper sounddevice` run on that machine
- [ ] User informed that first Whisper use downloads ~145MB (base model) from HuggingFace
- [ ] CUDA toolkit installed if GPU acceleration is desired
- [ ] Windows Speech Recognition configured as fallback (built-in, no install needed)
