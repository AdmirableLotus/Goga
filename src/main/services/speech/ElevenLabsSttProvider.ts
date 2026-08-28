/**
 * ElevenLabsSttProvider — M4.1
 *
 * Realtime Speech-to-Text via ElevenLabs WebSocket (scribe_v2_realtime).
 *   - Audio: mono PCM 16 kHz 16-bit, captured in the MAIN process via a
 *     WaveIn P/Invoke PowerShell helper (mic never touches the renderer).
 *   - Commit strategy: VAD. Only `committed_transcript` is treated as the
 *     user's request. Partial transcripts are surfaced for display only.
 *   - API key read from process.env.ELEVENLABS_API_KEY in the main process
 *     only. Sent via the xi-api-key WebSocket header. Never exposed to the
 *     renderer, IPC, logs, or errors.
 *
 * Availability: isAvailable() probes the single-use-token endpoint to confirm
 * the key carries the `speech_to_text` permission. If the key is missing,
 * unauthorized, rate-limited, or offline, the orchestrator falls back to
 * Windows STT.
 */

import { spawn, ChildProcess } from 'child_process'
import * as https from 'https'
import WebSocket from 'ws'
import type { ISttProvider, SpeechRecognitionResult } from './ISpeechProvider'
import { LogService } from '../logs'

const STT_WS_URL =
  'wss://api.elevenlabs.io/v1/speech-to-text/realtime' +
  '?model_id=scribe_v2_realtime&language_code=en&commit_strategy=vad'

const SESSION_TIMEOUT_MS = 8_000     // must receive session_started within this
const NO_ACTIVITY_TIMEOUT_MS = 15_000 // overall recognize() ceiling

// Inline PowerShell: capture mono PCM 16 kHz 16-bit from the default mic via
// WaveIn P/Invoke, write raw bytes to stdout. Runs for $Seconds then exits.
const PCM_CAPTURE_SCRIPT = (seconds: number) => `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public class MicCap {
  [DllImport("winmm.dll")] static extern int waveInGetNumDevs();
  [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr h, uint dev, ref WFX fmt, IntPtr cb, IntPtr inst, uint flags);
  [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr h, ref WHDR hdr, uint size);
  [DllImport("winmm.dll")] static extern int waveInUnprepareHeader(IntPtr h, ref WHDR hdr, uint size);
  [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr h, ref WHDR hdr, uint size);
  [DllImport("winmm.dll")] static extern int waveInStart(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInStop(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInReset(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInClose(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] struct WFX { public ushort t; public ushort ch; public uint sps; public uint abps; public ushort ba; public ushort bps; public ushort cb; }
  [StructLayout(LayoutKind.Sequential)] struct WHDR { public IntPtr data; public uint len; public uint rec; public IntPtr usr; public uint flags; public uint loops; public IntPtr next; public IntPtr res; }
  public static void Run(int seconds) {
    if (waveInGetNumDevs() == 0) { Console.Error.WriteLine("NO_MIC"); return; }
    WFX fmt = new WFX(); fmt.t=1; fmt.ch=1; fmt.sps=16000; fmt.bps=16; fmt.ba=2; fmt.abps=32000; fmt.cb=0;
    IntPtr h;
    if (waveInOpen(out h, 0xFFFFFFFF, ref fmt, IntPtr.Zero, IntPtr.Zero, 0) != 0) { Console.Error.WriteLine("OPEN_FAIL"); return; }
    int n=8, sz=1600; WHDR[] hd=new WHDR[n]; IntPtr[] bf=new IntPtr[n];
    for (int i=0;i<n;i++){ bf[i]=Marshal.AllocHGlobal(sz); hd[i]=new WHDR(); hd[i].data=bf[i]; hd[i].len=(uint)sz; waveInPrepareHeader(h, ref hd[i], (uint)Marshal.SizeOf(hd[i])); waveInAddBuffer(h, ref hd[i], (uint)Marshal.SizeOf(hd[i])); }
    var so = Console.OpenStandardOutput();
    Console.Error.WriteLine("READY");
    waveInStart(h);
    long end = DateTime.Now.Ticks + (long)seconds * 10000000;
    while (DateTime.Now.Ticks < end) {
      for (int i=0;i<n;i++){ if ((hd[i].flags & 1) != 0) { byte[] d=new byte[hd[i].rec]; Marshal.Copy(hd[i].data, d, 0, (int)hd[i].rec); so.Write(d,0,d.Length); so.Flush(); waveInUnprepareHeader(h, ref hd[i], (uint)Marshal.SizeOf(hd[i])); waveInPrepareHeader(h, ref hd[i], (uint)Marshal.SizeOf(hd[i])); waveInAddBuffer(h, ref hd[i], (uint)Marshal.SizeOf(hd[i])); } }
      Thread.Sleep(5);
    }
    waveInStop(h); waveInReset(h);
    for (int i=0;i<n;i++){ waveInUnprepareHeader(h, ref hd[i], (uint)Marshal.SizeOf(hd[i])); Marshal.FreeHGlobal(bf[i]); }
    waveInClose(h);
    Console.Error.WriteLine("DONE");
  }
}
"@
[MicCap]::Run(${seconds})
`

export class ElevenLabsSttProvider implements ISttProvider {
  readonly name = 'ElevenLabsSTT'

  private log = LogService.getInstance()
  private ws: WebSocket | null = null
  private captureProc: ChildProcess | null = null
  private contCallback: ((r: SpeechRecognitionResult) => void) | null = null
  private contError: ((e: Error) => void) | null = null
  private aborted = false

  // ── Session lifecycle ──────────────────────────────────────────────────────
  // Every listening turn gets a monotonically increasing session ID. Only
  // callbacks whose captured ID equals `activeSessionId` are honored; late
  // callbacks from a superseded or handled session are ignored. This guarantees
  // exactly-one submitted request per turn.
  private activeSessionId = 0

  /** Callback for partial transcripts (display only — never submitted). */
  onPartial?: (text: string) => void

  /** Allocate a new session ID, invalidating any previous session. */
  private newSession(): number {
    this.activeSessionId += 1
    return this.activeSessionId
  }

  private isActive(sessionId: number): boolean {
    return sessionId === this.activeSessionId
  }

  static isConfigured(): boolean {
    return !!process.env.ELEVENLABS_API_KEY
  }

  /**
   * Confirm the key has speech_to_text permission and the service is reachable.
   * Returns false on missing key, unauthorized, rate-limit, or network error.
   */
  static async isAvailable(): Promise<boolean> {
    const key = process.env.ELEVENLABS_API_KEY
    if (!key) return false
    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname: 'api.elevenlabs.io',
          path: '/v1/single-use-token/realtime_scribe',
          method: 'POST',
          headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
          timeout: 5_000
        },
        (res) => {
          res.resume()
          // 200/201 → permission present. 401/403 → missing permission. 429 → rate-limited.
          resolve(res.statusCode === 200 || res.statusCode === 201)
        }
      )
      req.on('timeout', () => { req.destroy(); resolve(false) })
      req.on('error', () => resolve(false))
      req.write('{}')
      req.end()
    })
  }

  // ── One-shot recognition ────────────────────────────────────────────────

  async recognize(timeoutMs = NO_ACTIVITY_TIMEOUT_MS): Promise<SpeechRecognitionResult> {
    this.aborted = false
    const key = process.env.ELEVENLABS_API_KEY
    if (!key) throw new Error('ElevenLabs STT not configured')

    // Allocate this turn's session. Any previous session is now invalidated.
    const sessionId = this.newSession()
    this.log.info(`STT:ElevenLabs: session #${sessionId} recognize start (provider=${this.name})`)

    return new Promise<SpeechRecognitionResult>((resolve, reject) => {
      let settled = false
      let sessionStarted = false

      const cleanup = () => {
        clearTimeout(sessionTimer)
        clearTimeout(overallTimer)
        this.onPartial?.('')          // clear partial-transcript display
        this.stopCapture()
        this.closeSocket()
      }
      // Atomically mark handled BEFORE any async work; ignore repeat calls.
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        cleanup()
        fn()
      }

      const ws = new WebSocket(STT_WS_URL, { headers: { 'xi-api-key': key } })
      this.ws = ws

      const sessionTimer = setTimeout(() => {
        if (!sessionStarted && this.isActive(sessionId)) {
          this.log.info(`STT:ElevenLabs: session #${sessionId} session-start timeout`)
          settle(() => reject(new Error('ElevenLabs STT: session timeout')))
        }
      }, SESSION_TIMEOUT_MS)

      const overallTimer = setTimeout(() => {
        this.log.info(`STT:ElevenLabs: session #${sessionId} overall timeout`)
        settle(() => resolve({ transcript: '' }))
      }, timeoutMs)

      ws.on('open', () => {
        this.log.info(`STT:ElevenLabs: session #${sessionId} WS open`)
      })

      ws.on('message', (data: WebSocket.RawData) => {
        // Ignore any callback that no longer belongs to the active session,
        // or that arrives after this turn was already handled.
        if (settled || !this.isActive(sessionId)) {
          this.log.info(`STT:ElevenLabs: session #${sessionId} event ignored (handled/superseded)`)
          return
        }

        let msg: Record<string, unknown>
        try { msg = JSON.parse(data.toString()) } catch { return }
        const type = (msg.message_type || msg.type) as string

        if (type === 'session_started') {
          sessionStarted = true
          clearTimeout(sessionTimer)
          this.log.info(`STT:ElevenLabs: session #${sessionId} started, event=session_started accepted`)
          this.startCapture(ws, sessionId)
        } else if (type === 'partial_transcript') {
          // Display only — replaces the previous partial, never submitted.
          const text = String(msg.text ?? '')
          if (text) this.onPartial?.(text)
        } else if (type === 'committed_transcript') {
          const text = String(msg.text ?? '').trim()
          if (text) {
            // FIRST committed transcript wins. Submit exactly this segment —
            // never concatenate later segments. Mark handled atomically.
            this.log.info(`STT:ElevenLabs: session #${sessionId} event=committed_transcript accepted (submitting once)`)
            settle(() => resolve({ transcript: text }))
          }
        } else if (type && (type.includes('error') || type === 'auth_error')) {
          this.log.info(`STT:ElevenLabs: session #${sessionId} event=${type} accepted (error)`)
          settle(() => reject(new Error(`ElevenLabs STT: ${type}`)))
        }
      })

      ws.on('error', () => {
        if (!this.isActive(sessionId)) return
        this.log.info(`STT:ElevenLabs: session #${sessionId} WS error`)
        settle(() => reject(new Error('ElevenLabs STT: socket error')))
      })

      ws.on('close', () => {
        // Only the active, unhandled session resolves empty on close.
        if (!this.isActive(sessionId)) return
        settle(() => resolve({ transcript: '' }))
      })
    })
  }

  // ── Continuous recognition (wake loop) ────────────────────────────────────

  startContinuous(onResult: (r: SpeechRecognitionResult) => void, onError?: (e: Error) => void): void {
    this.stopContinuous()
    this.aborted = false
    this.contCallback = onResult
    this.contError = onError ?? null

    const key = process.env.ELEVENLABS_API_KEY
    if (!key) { this.contError?.(new Error('ElevenLabs STT not configured')); return }

    const sessionId = this.newSession()
    this.log.info(`STT:ElevenLabs: session #${sessionId} continuous start (provider=${this.name})`)

    const ws = new WebSocket(STT_WS_URL, { headers: { 'xi-api-key': key } })
    this.ws = ws

    ws.on('message', (data: WebSocket.RawData) => {
      // Ignore events from a superseded session or after abort.
      if (this.aborted || !this.isActive(sessionId)) {
        this.log.info(`STT:ElevenLabs: session #${sessionId} continuous event ignored (superseded)`)
        return
      }

      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      const type = (msg.message_type || msg.type) as string

      if (type === 'session_started') {
        this.log.info(`STT:ElevenLabs: session #${sessionId} continuous started, event=session_started accepted`)
        this.startCapture(ws, sessionId)
      } else if (type === 'partial_transcript') {
        const text = String(msg.text ?? '')
        if (text) this.onPartial?.(text)
      } else if (type === 'committed_transcript') {
        // Each committed segment is a distinct utterance in continuous mode.
        // Every segment is delivered separately — never concatenated.
        const text = String(msg.text ?? '').trim()
        if (text) {
          this.log.info(`STT:ElevenLabs: session #${sessionId} event=committed_transcript accepted (continuous utterance)`)
          this.contCallback?.({ transcript: text })
        }
      } else if (type && (type.includes('error') || type === 'auth_error')) {
        this.log.info(`STT:ElevenLabs: session #${sessionId} continuous event=${type} accepted (error)`)
        this.contError?.(new Error(`ElevenLabs STT: ${type}`))
      }
    })

    ws.on('error', () => {
      if (!this.isActive(sessionId)) return
      this.contError?.(new Error('ElevenLabs STT: socket error'))
    })
    ws.on('close', () => { if (this.isActive(sessionId)) this.stopCapture() })
  }

  stopContinuous(): void {
    // Invalidate the current session so any in-flight callbacks are ignored.
    this.newSession()
    this.aborted = true
    this.onPartial?.('')
    this.stopCapture()
    this.closeSocket()
    this.contCallback = null
    this.contError = null
  }

  abort(): void {
    // Invalidate the current session so late callbacks are ignored.
    this.newSession()
    this.aborted = true
    this.onPartial?.('')
    this.stopCapture()
    this.closeSocket()
  }

  // ── Audio send (shared by recognize + startContinuous) ────────────────────

  /**
   * Send one PCM chunk to the realtime STT socket using the EXACT protocol
   * schema required by ElevenLabs:
   *   { message_type: 'input_audio_chunk', audio_base_64: <base64 PCM> }
   * With VAD commit strategy, no manual commit is sent during normal chunks —
   * the server auto-commits on detected silence.
   */
  private sendAudioChunk(ws: WebSocket, chunk: Buffer): void {
    try {
      ws.send(JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: chunk.toString('base64')
      }))
    } catch { /* socket closing */ }
  }

  // ── Audio capture helpers ─────────────────────────────────────────────────

  private startCapture(ws: WebSocket, sessionId: number): void {
    if (this.captureProc) return
    this.captureProc = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-Command', PCM_CAPTURE_SCRIPT(30)
    ], { windowsHide: true })

    this.captureProc.stdout?.on('data', (chunk: Buffer) => {
      // Only stream audio while this session is still the active one.
      if (ws.readyState === WebSocket.OPEN && !this.aborted && this.isActive(sessionId)) {
        this.sendAudioChunk(ws, chunk)
      }
    })
    this.captureProc.stderr?.on('data', () => { /* status markers */ })
    this.captureProc.on('close', () => { this.captureProc = null })
    this.captureProc.on('error', () => { this.captureProc = null })
  }

  private stopCapture(): void {
    if (this.captureProc) {
      try { this.captureProc.kill() } catch { }
      this.captureProc = null
    }
  }

  private closeSocket(): void {
    if (this.ws) {
      try { this.ws.close() } catch { }
      this.ws = null
    }
  }
}
