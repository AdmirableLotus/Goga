/**
 * ElevenLabsTtsProvider — M4
 *
 * Streams audio from ElevenLabs HTTP TTS endpoint into a temp file,
 * then plays it via Windows-native player (PowerShell MediaPlayer).
 *
 * Timeouts:
 *   - HTTP response: 10s
 *   - Playback start: 8s after file is ready
 *   - Overall playback: dynamic (1.5x estimated duration from file size, min 15s, ceiling 120s)
 *
 * Security:
 *   - API key read from process.env in main process only
 *   - Never exposed through IPC, logs, renderer, or errors
 */

import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as https from 'https'
import type { IncomingMessage } from 'http'
import type { ITtsProvider } from './ISpeechProvider'
import { LogService } from '../logs'

const HTTP_TIMEOUT_MS = 10_000
const PLAYBACK_START_TIMEOUT_MS = 8_000
// Dynamic playback timeout computed per-file; this is the absolute ceiling
const PLAYBACK_ABSOLUTE_CEILING_MS = 120_000

export class ElevenLabsTtsProvider implements ITtsProvider {
  readonly name = 'ElevenLabs'

  private log = LogService.getInstance()
  private currentReq: ReturnType<typeof https.request> | null = null
  private playbackProc: ChildProcess | null = null
  private tempFilePath: string | null = null
  private stopped = false
  private playbackStarted = false

  onPlaybackStart?: () => void
  onAmplitude?: (amp: number) => void

  static isConfigured(): boolean {
    return !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID)
  }

  async speak(text: string, rate: number, volume: number, _voiceName: string): Promise<void> {
    this.stopped = false
    this.playbackStarted = false
    const apiKey = process.env.ELEVENLABS_API_KEY
    const voiceId = process.env.ELEVENLABS_VOICE_ID

    if (!apiKey || !voiceId) {
      throw new Error('ElevenLabs not configured')
    }

    const tmpFile = path.join(os.tmpdir(), `goga-el-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`)
    this.tempFilePath = tmpFile
    this.log.info('TTS:ElevenLabs: request started')

    try {
      await this.streamToFile(text, apiKey, voiceId, tmpFile)

      if (this.stopped) { this.cleanup(); return }

      this.log.info('TTS:ElevenLabs: audio ready, starting playback')
      await this.playFile(tmpFile, volume)
      this.log.info('TTS:ElevenLabs: playback ended')
    } finally {
      this.cleanup()
      this.log.info('TTS:ElevenLabs: cleanup completed')
    }
  }

  stop(): void {
    this.stopped = true
    if (this.currentReq) {
      try { this.currentReq.destroy() } catch { }
      this.currentReq = null
    }
    if (this.playbackProc) {
      try { this.playbackProc.kill() } catch { }
      this.playbackProc = null
    }
    this.onAmplitude?.(0)
    this.cleanup()
    this.log.info('TTS:ElevenLabs: stopped/cancelled')
  }

  async getVoices(): Promise<string[]> {
    return ['ElevenLabs (configured via ELEVENLABS_VOICE_ID)']
  }

  // ── Stream from ElevenLabs to temp file with HTTP timeout ─────────────────

  private streamToFile(text: string, apiKey: string, voiceId: string, filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) { resolve(); return }

      const body = JSON.stringify({
        text: text.slice(0, 5000),
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })

      const options = {
        hostname: 'api.elevenlabs.io',
        path: `/v1/text-to-speech/${voiceId}/stream`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
          'Accept': 'audio/mpeg'
        },
        timeout: HTTP_TIMEOUT_MS
      }

      const writeStream = fs.createWriteStream(filePath)
      let settled = false
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn() } }

      const req = https.request(options, (res: IncomingMessage) => {
        if (this.stopped) { writeStream.destroy(); settle(() => resolve()); return }

        this.log.info(`TTS:ElevenLabs: response status ${res.statusCode}`)

        if (res.statusCode && res.statusCode >= 400) {
          // Drain body but don't log it (may contain key echoes)
          res.resume()
          res.on('end', () => {
            writeStream.destroy()
            const sanitized = res.statusCode === 401
              ? 'ElevenLabs: authentication failed'
              : res.statusCode === 429
                ? 'ElevenLabs: quota exceeded'
                : `ElevenLabs: HTTP ${res.statusCode}`
            settle(() => reject(new Error(sanitized)))
          })
          return
        }

        res.pipe(writeStream)
        res.on('error', () => { writeStream.destroy(); if (!this.stopped) settle(() => reject(new Error('ElevenLabs: stream error'))) ; else settle(() => resolve()) })
        writeStream.on('finish', () => settle(() => resolve()))
        writeStream.on('error', () => { if (!this.stopped) settle(() => reject(new Error('ElevenLabs: file write error'))); else settle(() => resolve()) })
      })

      req.on('timeout', () => {
        req.destroy()
        writeStream.destroy()
        this.log.info('TTS:ElevenLabs: HTTP timeout')
        settle(() => reject(new Error('ElevenLabs: request timeout')))
      })

      req.on('error', (err: Error & { code?: string }) => {
        writeStream.destroy()
        if (this.stopped || err.code === 'ABORT_ERR' || err.message.includes('socket hang up')) {
          settle(() => resolve())
        } else {
          this.log.info('TTS:ElevenLabs: network error')
          settle(() => reject(new Error('ElevenLabs: network error')))
        }
      })

      this.currentReq = req
      req.write(body)
      req.end()
    })
  }

  // ── Play MP3 with playback-start and dynamic overall timeouts ──────────────

  private playFile(filePath: string, volume: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) { resolve(); return }

      const volPercent = Math.round(volume * 100)
      const escapedPath = filePath.replace(/\\/g, '\\\\')

      // Estimate duration from file size: ElevenLabs mp3 stream is ~32kbps
      let estimatedDurationMs = 30_000 // fallback
      try {
        const fileBytes = fs.statSync(filePath).size
        estimatedDurationMs = Math.max(3000, (fileBytes / 4000) * 1000) // ~32kbps = 4000 bytes/s
      } catch { }

      // Dynamic timeout: 1.5x estimated duration, minimum 15s, capped at ceiling
      const dynamicTimeoutMs = Math.min(
        PLAYBACK_ABSOLUTE_CEILING_MS,
        Math.max(15_000, Math.round(estimatedDurationMs * 1.5))
      )

      this.log.info(`TTS:ElevenLabs: playFile estimated ${Math.round(estimatedDurationMs / 1000)}s, timeout ${Math.round(dynamicTimeoutMs / 1000)}s`)

      // PS script: uses position tracking, reports STALL_ERROR if position stalls
      // before reaching 80% of NaturalDuration (or 80% of estimated)
      const script = `
Add-Type -AssemblyName presentationCore
$player = New-Object System.Windows.Media.MediaPlayer
$player.Open([Uri]::new('${escapedPath}'))
$player.Volume = ${volPercent / 100}
Start-Sleep -Milliseconds 500
$player.Play()
[Console]::WriteLine("PLAYBACK_STARTED")
$estDur = ${Math.round(estimatedDurationMs)}
$maxWait = ${dynamicTimeoutMs}
$elapsed = 0
$lastPos = -1
$stuckCount = 0
while ($elapsed -lt $maxWait) {
  Start-Sleep -Milliseconds 100
  $elapsed += 100
  $pos = 0; $dur = 0
  try {
    $pos = [int]$player.Position.TotalMilliseconds
    if ($player.NaturalDuration.HasTimeSpan) { $dur = [int]$player.NaturalDuration.TimeSpan.TotalMilliseconds }
  } catch {}
  $effectiveDur = if ($dur -gt 0) { $dur } else { $estDur }
  # Natural completion: position reached end
  if ($dur -gt 0 -and $pos -ge ($dur - 200)) { break }
  # Stall detection
  if ($pos -eq $lastPos) { $stuckCount++ } else { $stuckCount = 0 }
  if ($stuckCount -gt 15) {
    # Stall near end (>=80% of expected) = normal completion
    if ($pos -ge ($effectiveDur * 0.8)) { break }
    # Stall early = error
    [Console]::WriteLine("STALL_ERROR:" + $pos + "/" + $effectiveDur)
    break
  }
  $lastPos = $pos
  if ($elapsed % 200 -lt 100) {
    $amp = if ($effectiveDur -gt 0) { [Math]::Sin(($pos / $effectiveDur) * [Math]::PI) * 0.55 + 0.1 } else { 0.35 }
    [Console]::WriteLine('AMP:' + ([Math]::Round($amp, 4)).ToString('F4'))
  }
}
[Console]::WriteLine('AMP:0.0000')
try { $player.Stop() } catch {}
try { $player.Close() } catch {}
`

      let settled = false
      let playbackTotalTimer: ReturnType<typeof setTimeout> | null = null

      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true
          clearTimeout(startTimer)
          if (playbackTotalTimer) clearTimeout(playbackTotalTimer)
          fn()
        }
      }

      this.playbackProc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })

      // Timeout: playback must start within PLAYBACK_START_TIMEOUT_MS
      const startTimer = setTimeout(() => {
        if (!this.playbackStarted && !this.stopped) {
          this.log.info('TTS:ElevenLabs: playback-start timeout')
          this.killPlayback()
          settle(() => reject(new Error('ElevenLabs: playback start timeout')))
        }
      }, PLAYBACK_START_TIMEOUT_MS)

      let buf = ''
      let stallError = false

      this.playbackProc.stdout?.on('data', (d: Buffer) => {
        buf += d.toString()
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const t = line.trim()
          if (t === 'PLAYBACK_STARTED' && !this.playbackStarted) {
            this.playbackStarted = true
            clearTimeout(startTimer)
            this.log.info('TTS:ElevenLabs: playback started')
            this.onPlaybackStart?.()
            // Start dynamic playback timeout NOW (after playback begins)
            playbackTotalTimer = setTimeout(() => {
              if (!this.stopped && !settled) {
                this.log.info('TTS:ElevenLabs: playback total timeout')
                this.killPlayback()
                settle(() => reject(new Error('ElevenLabs: playback timeout')))
              }
            }, dynamicTimeoutMs)
          } else if (t.startsWith('STALL_ERROR:')) {
            stallError = true
            this.log.info(`TTS:ElevenLabs: early stall detected (${t})`)
          } else if (t.startsWith('AMP:')) {
            const v = parseFloat(t.slice(4))
            if (!isNaN(v)) this.onAmplitude?.(Math.min(1, v * 2.5))
          }
        }
      })

      this.playbackProc.stderr?.on('data', () => { /* suppress */ })

      this.playbackProc.on('close', (code) => {
        this.playbackProc = null
        this.onAmplitude?.(0)
        if (this.stopped) { settle(() => resolve()); return }
        if (stallError) {
          settle(() => reject(new Error('ElevenLabs: playback stalled')))
        } else {
          settle(() => code === 0 ? resolve() : reject(new Error('ElevenLabs: playback failed')))
        }
      })

      this.playbackProc.on('error', () => {
        this.playbackProc = null
        this.onAmplitude?.(0)
        if (this.stopped) { settle(() => resolve()); return }
        settle(() => reject(new Error('ElevenLabs: playback process error')))
      })
    })
  }

  private killPlayback(): void {
    if (this.playbackProc) {
      try { this.playbackProc.kill() } catch { }
      this.playbackProc = null
    }
  }

  private cleanup(): void {
    if (this.tempFilePath) {
      const f = this.tempFilePath
      this.tempFilePath = null
      setTimeout(() => { try { fs.unlinkSync(f) } catch { } }, 500)
    }
  }
}
