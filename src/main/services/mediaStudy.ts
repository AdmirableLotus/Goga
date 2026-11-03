import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import { SettingsService } from './settings'
import { LogService } from './logs'

// Learn from a video or audio recording: transcribe the spoken content with Whisper
// (faster-whisper reads a video's audio track directly through PyAV, no ffmpeg needed),
// then the transcript is ingested into the Library and studied like any other book.

export const MEDIA_EXT = /\.(mp4|mkv|mov|webm|avi|m4v|wmv|flv|mp3|m4a|wav|aac|ogg|flac|opus|wma)$/i

/**
 * "watch this video and learn from it", "study this lecture and take notes",
 * "learn from C:\\Users\\me\\course.mp4". Needs a media file and a learn/watch intent.
 */
export function isLearnFromVideo(text: string): boolean {
  if (!extractMediaPath(text)) return false
  return /\b(learn|study|watch|go through|take notes|notes|skills?|teach|absorb|review)\b/i.test(text)
    || /\b(video|recording|lecture|footage|clip|audio|podcast|course)\b/i.test(text)
}

/** The local path to a video/audio file in the message, else null. A quoted path, a Windows
 *  drive path, or a POSIX absolute path — each must end in a known media extension. */
export function extractMediaPath(text: string): string | null {
  const t = text.trim()
  const quoted = t.match(/["'“”]((?<![A-Za-z])[A-Za-z]:[\\/][^"'“”]+|\/[^"'“”]+)["'“”]/)
  if (quoted && MEDIA_EXT.test(quoted[1].trim())) return quoted[1].trim()
  // A bare path ending at a media extension (stop at the extension so trailing words are dropped).
  const bare = t.match(/((?<![A-Za-z])[A-Za-z]:[\\/].+?|\/[^\s"'“”]+?)\.(mp4|mkv|mov|webm|avi|m4v|wmv|flv|mp3|m4a|wav|aac|ogg|flac|opus|wma)\b/i)
  if (bare) return `${bare[1]}.${bare[2]}`
  return null
}

export type TranscribeEvent =
  | { type: 'model'; name: string }
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; chars: number }
  | { type: 'error'; message: string }

/** Parse one stdout line from transcribe_media.py, or null if it isn't a status line. */
export function parseTranscribeLine(line: string): TranscribeEvent | null {
  const t = line.trim()
  let m
  if ((m = t.match(/^MODEL\s+(\S+)/))) return { type: 'model', name: m[1] }
  if ((m = t.match(/^PROGRESS\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/))) return { type: 'progress', done: Number(m[1]), total: Number(m[2]) }
  if ((m = t.match(/^DONE\s+(\d+)/))) return { type: 'done', chars: Number(m[1]) }
  if ((m = t.match(/^ERROR\s+(.+)/))) return { type: 'error', message: m[1].trim() }
  return null
}

/** Media files directly inside a folder and its subfolders (shallow-first), capped. */
export function collectMedia(dir: string, maxFiles = 50): string[] {
  const found: string[] = []
  const walk = (d: string, depth: number) => {
    if (found.length >= maxFiles || depth > 3) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
      if (MEDIA_EXT.test(e.name)) { found.push(path.join(d, e.name)); if (found.length >= maxFiles) return }
    }
    for (const e of entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) walk(path.join(d, e.name), depth + 1)
  }
  walk(dir, 0)
  return found
}

/** A folder path in a "learn from the videos in <folder>" request, else null (not a media file). */
export function extractFolderPath(text: string): string | null {
  if (extractMediaPath(text)) return null   // a single file wins; this is only for folders
  const t = text.trim()
  const quoted = t.match(/["'“”]((?<![A-Za-z])[A-Za-z]:[\\/][^"'“”]+|\/[^"'“”]+)["'“”]/)
  if (quoted) return quoted[1].trim()
  const bare = t.match(/((?<![A-Za-z])[A-Za-z]:[\\/].+)$/)
  if (bare) return bare[1].replace(/["'“”]+$/, '').replace(/\s+(and|then)\s+.*$/i, '').trim()
  return null
}

/** "learn from the videos in C:\\courses", "go through all the lectures in that folder". */
export function isLearnFromVideoFolder(text: string): boolean {
  if (!extractFolderPath(text)) return false
  const mediaWord = /\b(videos?|recordings?|lectures?|footage|clips?|audio|podcasts?|courses?)\b/i.test(text)
  const learnWord = /\b(learn|study|watch|go through|take notes|notes|skills?|teach|absorb|review)\b/i.test(text)
  return mediaWord && learnWord
}

/** A one-line "35% (2h 6m / 6h 0m)" style progress string from seconds done/total. */
export function progressText(done: number, total: number): string {
  const hm = (s: number) => {
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60)
    return h > 0 ? `${h}h ${m}m` : `${m}m`
  }
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return total > 0 ? `${pct}% (${hm(done)} / ${hm(total)})` : `${hm(done)} transcribed`
}

function scriptPath(): string {
  return path.join(app.getAppPath(), 'scripts', 'transcribe_media.py')
}

/**
 * Transcribe a media file to a temp .txt and return its path. Progress is reported through
 * onProgress. Rejects on an ERROR line, a non-zero exit, or abort. There is no hard timeout:
 * a six-hour recording legitimately takes a long time; cancel with the AbortSignal instead.
 */
export function transcribeMedia(
  mediaPath: string,
  opts: { onProgress?: (done: number, total: number) => void; onModel?: (name: string) => void; signal?: AbortSignal } = {},
): Promise<string> {
  const log = LogService.getInstance()
  const s = SettingsService.getInstance().get() as { whisperModel?: string; whisperDevice?: string; whisperLanguage?: string; mediaFastModel?: string }
  const device = s.whisperDevice ?? 'cuda'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-media-'))
  const base = path.basename(mediaPath).replace(MEDIA_EXT, '').replace(/[^A-Za-z0-9 ._-]/g, '_').slice(0, 120) || 'recording'
  const outPath = path.join(dir, `${base}.txt`)

  return new Promise<string>((resolve, reject) => {
    const proc = spawn('python', [scriptPath(), mediaPath, outPath], {
      windowsHide: true,
      env: {
        ...process.env,
        WHISPER_MODEL: s.whisperModel ?? 'base',
        WHISPER_DEVICE: device,
        WHISPER_COMPUTE: device === 'cpu' ? 'int8' : 'int8_float16',
        MEDIA_FAST_MODEL: s.mediaFastModel ?? 'medium',
        ...(s.whisperLanguage ? { WHISPER_LANG: s.whisperLanguage } : {}),
      },
    })
    let buf = ''
    let failed: string | null = null
    const onAbort = () => { try { proc.kill() } catch { /* already gone */ } }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    proc.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const ev = parseTranscribeLine(line)
        if (ev?.type === 'model') opts.onModel?.(ev.name)
        else if (ev?.type === 'progress') opts.onProgress?.(ev.done, ev.total)
        else if (ev?.type === 'error') failed = ev.message
      }
    })
    proc.stderr.on('data', (d: Buffer) => { const m = d.toString().trim(); if (m) log.info(`transcribe diag: ${m.slice(0, 200)}`) })
    proc.on('error', e => { opts.signal?.removeEventListener('abort', onAbort); reject(e) })
    proc.on('close', code => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal?.aborted) return reject(new Error('Transcription cancelled.'))
      if (failed) return reject(new Error(failed))
      if (code !== 0) return reject(new Error(`Transcription exited with code ${code}.`))
      if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) return reject(new Error('No speech was found in that file.'))
      resolve(outPath)
    })
  })
}
