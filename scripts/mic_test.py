import sounddevice as sd
import numpy as np

print("Recording 3s on device 1 (fifine)... speak now")
data = sd.rec(int(3*16000), samplerate=16000, channels=1, dtype='int16', device=1)
sd.wait()
rms = float(np.sqrt(np.mean(data.astype(np.float32)**2)))
peak = int(np.max(np.abs(data)))
print(f"RMS={rms:.1f}  peak={peak}  (max=32767)")
print(f"RMS fraction: {rms/32768*100:.2f}%")
print(f"VAD threshold at 0.008: {0.008*32768:.0f} counts")
print(f"Speech detected: {rms > 0.008*32768}")
