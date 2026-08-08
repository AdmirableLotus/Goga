import type { IpcMain, BrowserWindow } from 'electron'
import { spawn, ChildProcess } from 'child_process'

let proc: ChildProcess | null = null

// PowerShell script using System.Speech.Recognition (Windows built-in, offline)
const PS_SCRIPT = `
Add-Type -AssemblyName System.Speech
$r = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$r.SetInputToDefaultAudioDevice()
$grammar = New-Object System.Speech.Recognition.DictationGrammar
$r.LoadGrammar($grammar)
$r.BabbleTimeout = [TimeSpan]::FromSeconds(3)
$r.InitialSilenceTimeout = [TimeSpan]::FromSeconds(8)
$result = $r.Recognize([TimeSpan]::FromSeconds(10))
if ($result -and $result.Text) {
  Write-Output $result.Text
} else {
  Write-Output "__NO_SPEECH__"
}
$r.Dispose()
`

export function registerSttHandlers(ipcMain: IpcMain, getWindow: () => BrowserWindow | null) {
  ipcMain.handle('stt:start', async () => {
    // Kill any existing session
    if (proc) { try { proc.kill() } catch { } proc = null }

    return new Promise<{ transcript: string }>((resolve) => {
      let output = ''
      proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT])

      proc.stdout?.on('data', (d: Buffer) => { output += d.toString() })
      proc.on('close', () => {
        proc = null
        const transcript = output.trim().split('\n').pop()?.trim() ?? ''
        resolve({ transcript: transcript === '__NO_SPEECH__' ? '' : transcript })
      })
      proc.on('error', () => resolve({ transcript: '' }))
    })
  })

  ipcMain.handle('stt:stop', async () => {
    if (proc) { try { proc.kill() } catch { } proc = null }
  })
}
