import { spawn, ChildProcess } from 'child_process'
import type { ISttProvider, ITtsProvider, SpeechRecognitionResult } from './ISpeechProvider'

// ── STT ───────────────────────────────────────────────────────────────────────

const STT_SCRIPT = (timeoutSec: number) => `
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

export class WindowsSttProvider implements ISttProvider {
  readonly name = 'WindowsSpeech'
  private proc: ChildProcess | null = null

  async recognize(timeoutMs = 12000): Promise<SpeechRecognitionResult> {
    this.abort()
    const timeoutSec = Math.ceil(timeoutMs / 1000)
    return new Promise(resolve => {
      let out = ''
      this.proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', STT_SCRIPT(timeoutSec)])
      this.proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
      this.proc.on('close', () => {
        this.proc = null
        const text = out.trim().split('\n').pop()?.trim() ?? ''
        resolve({ transcript: text === '__NO_SPEECH__' ? '' : text })
      })
      this.proc.on('error', () => { this.proc = null; resolve({ transcript: '' }) })
    })
  }

  abort() {
    if (this.proc) { try { this.proc.kill() } catch { } this.proc = null }
  }
}

// ── TTS ───────────────────────────────────────────────────────────────────────

function psEscape(text: string) {
  return text.replace(/'/g, "''").replace(/[^\x20-\x7E\n]/g, '')
}

export class WindowsTtsProvider implements ITtsProvider {
  readonly name = 'WindowsSpeech'
  private proc: ChildProcess | null = null

  speak(text: string, rate: number, volume: number, voiceName: string): Promise<void> {
    this.stop()
    const rateVal = Math.round((rate - 1) * 5)
    const volVal  = Math.round(volume * 100)
    const voiceLine = voiceName ? `$s.SelectVoice('${psEscape(voiceName)}')` : ''
    const script = [
      `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer`,
      voiceLine,
      `$s.Rate = ${rateVal}`,
      `$s.Volume = ${volVal}`,
      `$s.Speak('${psEscape(text)}')`,
      `$s.Dispose()`
    ].filter(Boolean).join('; ')

    return new Promise((resolve, reject) => {
      this.proc = spawn('powershell', ['-NoProfile', '-Command', script], { windowsHide: true })
      this.proc.on('close', code => { this.proc = null; code === 0 ? resolve() : reject(new Error(`TTS exit ${code}`)) })
      this.proc.on('error', err => { this.proc = null; reject(err) })
    })
  }

  stop() {
    if (this.proc) { try { this.proc.kill() } catch { } this.proc = null }
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
