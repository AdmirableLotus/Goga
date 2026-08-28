import { spawn, ChildProcess } from 'child_process'
import type { ISttProvider, ITtsProvider, SpeechRecognitionResult } from './ISpeechProvider'

// ── STT ───────────────────────────────────────────────────────────────────────
//
// Two modes:
//   recognize()        — one-shot, used for explicit mic-button presses
//   startContinuous()  — persistent background loop using RecognizeAsync,
//                        calls onResult for each utterance, no repeated PS startup cost
//
// The continuous script keeps the engine alive and writes each result to stdout
// as a line, so we parse line-by-line instead of waiting for process exit.

const ONE_SHOT_SCRIPT = (timeoutSec: number) => `
Add-Type -AssemblyName System.Speech
$r = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$r.SetInputToDefaultAudioDevice()
$r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$r.BabbleTimeout = [TimeSpan]::FromSeconds(2)
$r.InitialSilenceTimeout = [TimeSpan]::FromSeconds(6)
$result = $r.Recognize([TimeSpan]::FromSeconds(${timeoutSec}))
if ($result -and $result.Text) { Write-Output $result.Text } else { Write-Output "__NO_SPEECH__" }
$r.Dispose()
`

// Continuous script: writes each recognized utterance as a line to stdout.
// Writes "__READY__" when engine is initialized.
// Runs until process is killed.
const CONTINUOUS_SCRIPT = `
Add-Type -AssemblyName System.Speech
$r = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$r.SetInputToDefaultAudioDevice()
$r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$r.BabbleTimeout = [TimeSpan]::FromSeconds(1)
$r.InitialSilenceTimeout = [TimeSpan]::FromSeconds(30)
$r.EndSilenceTimeout = [TimeSpan]::FromSeconds(0.8)
$r.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromSeconds(0.5)
Register-ObjectEvent -InputObject $r -EventName SpeechRecognized -Action {
  $text = $Event.SourceEventArgs.Result.Text
  if ($text) { [Console]::WriteLine($text) }
} | Out-Null
Register-ObjectEvent -InputObject $r -EventName RecognizeCompleted -Action {
  [Console]::WriteLine("__COMPLETED__")
} | Out-Null
$r.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
[Console]::WriteLine("__READY__")
while ($true) { Start-Sleep -Milliseconds 200 }
`

export class WindowsSttProvider implements ISttProvider {
  readonly name = 'WindowsSpeech'
  private proc: ChildProcess | null = null
  private contProc: ChildProcess | null = null
  private contCallback: ((r: SpeechRecognitionResult) => void) | null = null
  private contError: ((e: Error) => void) | null = null

  async recognize(timeoutMs = 12000): Promise<SpeechRecognitionResult> {
    this.abort()
    const timeoutSec = Math.ceil(timeoutMs / 1000)
    return new Promise(resolve => {
      let out = ''
      this.proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ONE_SHOT_SCRIPT(timeoutSec)])
      this.proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
      this.proc.on('close', () => {
        this.proc = null
        const text = out.trim().split('\n').pop()?.trim() ?? ''
        resolve({ transcript: text === '__NO_SPEECH__' ? '' : text })
      })
      this.proc.on('error', () => { this.proc = null; resolve({ transcript: '' }) })
    })
  }

  startContinuous(onResult: (r: SpeechRecognitionResult) => void, onError?: (e: Error) => void): void {
    this.stopContinuous()
    this.contCallback = onResult
    this.contError = onError ?? null

    this.contProc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', CONTINUOUS_SCRIPT])

    let buf = ''
    this.contProc.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const text = line.trim()
        if (!text || text === '__READY__' || text === '__COMPLETED__') continue
        this.contCallback?.({ transcript: text })
      }
    })

    this.contProc.on('error', (e) => {
      this.contProc = null
      this.contError?.(e)
    })

    this.contProc.on('close', () => {
      this.contProc = null
    })
  }

  stopContinuous(): void {
    if (this.contProc) {
      try { this.contProc.kill() } catch { }
      this.contProc = null
    }
    this.contCallback = null
    this.contError = null
  }

  abort() {
    if (this.proc) { try { this.proc.kill() } catch { } this.proc = null }
    this.stopContinuous()
  }
}

// ── TTS ───────────────────────────────────────────────────────────────────────

function psEscape(text: string) {
  return text.replace(/'/g, "''").replace(/[^\x20-\x7E\n]/g, '')
}

export class WindowsTtsProvider implements ITtsProvider {
  readonly name = 'WindowsSpeech'
  private proc: ChildProcess | null = null
  onAmplitude?: (amp: number) => void
  onPlaybackStart?: () => void

  speak(text: string, rate: number, volume: number, voiceName: string): Promise<void> {
    this.stop()
    const rateVal  = Math.round((rate - 1) * 5)
    const volVal   = Math.round(volume * 100)
    const voiceLine = voiceName ? `$s.SelectVoice('${psEscape(voiceName)}')` : ''
    const escaped  = psEscape(text)

    // Write WAV to temp file, play it back with SoundPlayer, stream RMS amplitude
    // chunks to stdout as "AMP:<0.0-1.0>" lines during playback.
    const script = `
Add-Type -AssemblyName System.Speech
Add-Type -AssemblyName System.Windows.Forms
$tmp = [System.IO.Path]::GetTempFileName() + '.wav'
try {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  ${voiceLine}
  $s.Rate = ${rateVal}
  $s.Volume = ${volVal}
  $s.SetOutputToWaveFile($tmp)
  $s.Speak('${escaped}')
  $s.SetOutputToDefaultAudioDevice()
  $s.Dispose()

  if (-not (Test-Path $tmp)) { exit 0 }
  $bytes = [System.IO.File]::ReadAllBytes($tmp)
  $dataStart = 44
  $dataLen = $bytes.Length - $dataStart
  if ($dataLen -le 0) { exit 0 }

  # Parse actual sample rate from WAV header (bytes 24-27, little-endian)
  $sampleRate = [int]$bytes[24] -bor ([int]$bytes[25] -shl 8) -bor ([int]$bytes[26] -shl 16) -bor ([int]$bytes[27] -shl 24)
  if ($sampleRate -le 0) { $sampleRate = 22050 }
  $bytesPerSec = $sampleRate * 2  # 16-bit mono
  $chunksPerSec = 30
  $chunkBytes = [Math]::Max(2, [int]($bytesPerSec / $chunksPerSec))
  $totalChunks = [int]($dataLen / $chunkBytes)
  $msPerChunk = [int](1000.0 / $chunksPerSec)

  # Start playback in background job
  $player = New-Object System.Media.SoundPlayer($tmp)
  $player.Play()

  # Stream amplitude synchronized with playback
  for ($c = 0; $c -lt $totalChunks; $c++) {
    $start = $dataStart + $c * $chunkBytes
    $end = [Math]::Min($start + $chunkBytes, $bytes.Length - 1)
    $sumSq = 0.0; $n = 0
    for ($b = $start; $b -lt $end; $b += 2) {
      $lo = [int]$bytes[$b]; $hi = [int]$bytes[$b + 1]
      $sample = [int16]($lo -bor ($hi -shl 8))
      $norm = [double]$sample / 32768.0
      $sumSq += $norm * $norm; $n++
    }
    $rms = if ($n -gt 0) { [Math]::Sqrt($sumSq / $n) } else { 0.0 }
    [Console]::WriteLine('AMP:' + $rms.ToString('F4'))
    Start-Sleep -Milliseconds $msPerChunk
  }
  [Console]::WriteLine('AMP:0.0000')
  $player.Stop()
  $player.Dispose()
} finally {
  Start-Sleep -Milliseconds 200
  try { Remove-Item $tmp -Force -ErrorAction SilentlyContinue } catch {}
}
`
    return new Promise((resolve, reject) => {
      this.proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
      let buf = ''
      let playbackFired = false
      this.proc.stdout?.on('data', (d: Buffer) => {
        buf += d.toString()
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const t = line.trim()
          if (t.startsWith('AMP:')) {
            if (!playbackFired) { playbackFired = true; this.onPlaybackStart?.() }
            const v = parseFloat(t.slice(4))
            if (!isNaN(v)) this.onAmplitude?.(Math.min(1, v * 3.5)) // boost for visibility
          }
        }
      })
      this.proc.on('close', code => {
        this.proc = null
        this.onAmplitude?.(0)
        code === 0 ? resolve() : reject(new Error(`TTS exit ${code}`))
      })
      this.proc.on('error', err => { this.proc = null; this.onAmplitude?.(0); reject(err) })
    })
  }

  stop() {
    if (this.proc) { try { this.proc.kill() } catch { } this.proc = null }
    this.onAmplitude?.(0)
  }

  isPlaying(): boolean {
    return this.proc !== null
  }

  async stopAndWait(): Promise<void> {
    const proc = this.proc
    if (proc) {
      await new Promise<void>((resolve) => {
        let done = false
        const finish = () => { if (!done) { done = true; resolve() } }
        proc.once('close', finish)
        proc.once('exit', finish)
        try { proc.kill() } catch { finish() }
        setTimeout(finish, 1500)
      })
      this.proc = null
    }
    this.onAmplitude?.(0)
  }

  getVoices(): Promise<string[]> {
    return new Promise(resolve => {
      const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }; $s.Dispose()`
      const p = spawn('powershell', ['-NoProfile', '-Command', script], { windowsHide: true })
      let out = ''
      p.stdout?.on('data', (d: Buffer) => { out += d.toString() })
      p.on('close', () => resolve(out.split('\n').map(v => v.trim()).filter(Boolean)))
      p.on('error', () => resolve([]))
    })
  }
}
