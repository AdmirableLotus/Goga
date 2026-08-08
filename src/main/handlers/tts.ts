import type { IpcMain } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { SettingsService } from '../services/settings'

let currentProcess: ChildProcess | null = null

function psEscape(text: string) {
  return text.replace(/'/g, "''").replace(/[^\x20-\x7E\n]/g, '')
}

function buildScript(text: string, rate: number, volume: number, voiceName: string) {
  const rateVal = Math.round((rate - 1) * 5)   // SAPI rate: -10 to 10, 0 = normal
  const volVal = Math.round(volume * 100)
  const voiceLine = voiceName
    ? `$synth.SelectVoice('${psEscape(voiceName)}')`
    : ''
  return [
    `$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer`,
    voiceLine,
    `$synth.Rate = ${rateVal}`,
    `$synth.Volume = ${volVal}`,
    `$synth.Speak('${psEscape(text)}')`,
    `$synth.Dispose()`
  ].filter(Boolean).join('; ')
}

export function registerTtsHandlers(ipcMain: IpcMain) {
  ipcMain.handle('tts:speak', async (_e, text: string) => {
    // Kill any in-progress speech
    if (currentProcess) { currentProcess.kill(); currentProcess = null }

    const settings = SettingsService.getInstance().get()
    if (!settings.voiceEnabled) return

    const script = buildScript(text, settings.voiceRate, settings.voiceVolume, settings.voiceName)

    return new Promise<void>((resolve, reject) => {
      currentProcess = spawn('powershell', ['-NoProfile', '-Command', script], { windowsHide: true })
      currentProcess.on('close', (code) => {
        currentProcess = null
        code === 0 ? resolve() : reject(new Error(`TTS exited with code ${code}`))
      })
      currentProcess.on('error', (err) => { currentProcess = null; reject(err) })
    })
  })

  ipcMain.handle('tts:stop', async () => {
    if (currentProcess) { currentProcess.kill(); currentProcess = null }
  })

  ipcMain.handle('tts:voices', async () => {
    return new Promise<string[]>((resolve) => {
      const script = `
        Add-Type -AssemblyName System.Speech
        $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
        $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
        $synth.Dispose()
      `
      const proc = spawn('powershell', ['-NoProfile', '-Command', script], { windowsHide: true })
      let out = ''
      proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
      proc.on('close', () => {
        resolve(out.split('\n').map(v => v.trim()).filter(Boolean))
      })
      proc.on('error', () => resolve([]))
    })
  })
}
