import struct, math, os, subprocess, tempfile

# Generate a 1-second 440Hz sine wave WAV
sample_rate = 22050
duration = 1.0
freq = 440.0
samples = [int(32767 * math.sin(2 * math.pi * freq * i / sample_rate)) for i in range(int(sample_rate * duration))]

wav = tempfile.mktemp(suffix='.wav')
with open(wav, 'wb') as f:
    n = len(samples)
    f.write(b'RIFF')
    f.write(struct.pack('<I', 36 + n * 2))
    f.write(b'WAVEfmt ')
    f.write(struct.pack('<IHHIIHH', 16, 1, 1, sample_rate, sample_rate * 2, 2, 16))
    f.write(b'data')
    f.write(struct.pack('<I', n * 2))
    for s in samples:
        f.write(struct.pack('<h', s))

print(f"WAV written: {wav}")

script = f"""
Add-Type -AssemblyName System.Windows.Forms
$player = New-Object System.Media.SoundPlayer('{wav}')
$player.Load()
Write-Host 'PLAYING'
$player.PlaySync()
Write-Host 'DONE'
"""

result = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
                        capture_output=True, text=True, timeout=10)
print("stdout:", result.stdout.strip())
print("stderr:", result.stderr.strip()[:200] if result.stderr else "")
print("exit:", result.returncode)
os.unlink(wav)
