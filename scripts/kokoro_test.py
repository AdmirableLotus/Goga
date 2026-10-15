import subprocess, os, sys

model_dir = os.path.join(os.environ['APPDATA'], 'Goga', 'models', 'kokoro-v1.0')
out_wav = os.path.join(os.environ['TEMP'], 'goga-kokoro-test.wav')

print(f"Model dir: {model_dir}")
print(f"Output WAV: {out_wav}")

# Exact synthesis script Goga uses
script = f"""
const {{ KokoroTTS }} = require('kokoro-js')
const {{ env }} = require('@huggingface/transformers')
const modelDir = process.argv[1]
const outPath  = process.argv[2]
const text     = process.argv[3]
const speed    = parseFloat(process.argv[4]) || 1.0
env.allowRemoteModels = false
env.localModelPath    = modelDir
env.cacheDir          = modelDir
;(async () => {{
  const tts = await KokoroTTS.from_pretrained(modelDir, {{ dtype: 'q8', device: 'cpu' }})
  const audio = await tts.generate(text, {{ voice: 'af_heart', speed }})
  audio.save(outPath)
}})().then(() => process.exit(0)).catch(e => {{
  process.stderr.write(String(e.message || e))
  process.exit(1)
}})
"""

node = sys.executable.replace('python', 'node')  # fallback
# Use node from PATH
print("Synthesizing 'Hello, this is a Kokoro voice test.'...")
result = subprocess.run(
    ['node', '-e', script, '--', model_dir, out_wav, 'Hello, this is a Kokoro voice test.', '1.0'],
    capture_output=True, text=True, timeout=30,
    env={**os.environ, 'ELECTRON_RUN_AS_NODE': '1'}
)
print(f"Synthesis exit: {result.returncode}")
if result.stderr: print(f"stderr: {result.stderr[:300]}")

if result.returncode != 0 or not os.path.exists(out_wav):
    print("SYNTHESIS FAILED")
    sys.exit(1)

size = os.path.getsize(out_wav)
print(f"WAV size: {size} bytes ({size//1000}KB)")

# Play it
play_script = f"""
Add-Type -AssemblyName System.Windows.Forms
$player = New-Object System.Media.SoundPlayer($env:GOGA_WAV_PATH)
$player.Load()
Write-Host 'PLAYING'
$player.PlaySync()
Write-Host 'DONE'
"""
print("Playing...")
r2 = subprocess.run(
    ['powershell', '-NoProfile', '-NonInteractive', '-Command', play_script],
    capture_output=True, text=True, timeout=30,
    env={**os.environ, 'GOGA_WAV_PATH': out_wav}
)
print(f"Playback: {r2.stdout.strip()} (exit {r2.returncode})")
if r2.stderr: print(f"play stderr: {r2.stderr[:200]}")
os.unlink(out_wav)
