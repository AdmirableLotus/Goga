import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// mediaStudy imports electron/settings transitively; the pure helpers tested here never call them.
vi.mock('electron', () => ({ app: { getAppPath: () => '/app', getPath: () => '/fake/userData' } }))

import { isLearnFromVideo, extractMediaPath, parseTranscribeLine, progressText, isLearnFromVideoFolder, extractFolderPath, collectMedia, parseFrameLine, timeTag, formatVisualNotes, isVideoFile } from '../mediaStudy'

describe('finding a media file in a message', () => {
  it('pulls a video/audio path, quoted or bare, but not other files or URLs', () => {
    expect(extractMediaPath('learn from C:\\Users\\me\\course.mp4')).toBe('C:\\Users\\me\\course.mp4')
    expect(extractMediaPath('watch "C:/Users/me/My Lecture.mkv" and take notes')).toBe('C:/Users/me/My Lecture.mkv')
    expect(extractMediaPath('study C:\\talks\\keynote.m4a please')).toBe('C:\\talks\\keynote.m4a')
    expect(extractMediaPath('read C:\\docs\\notes.txt')).toBeNull()
    expect(extractMediaPath('study https://youtube.com/watch?v=abc')).toBeNull()
  })
})

describe('is this a "learn from a recording" request', () => {
  it('needs a media file and a learn/watch intent', () => {
    expect(isLearnFromVideo('watch this video and learn from it C:\\v\\a.mp4')).toBe(true)
    expect(isLearnFromVideo('study this lecture C:/v/lecture.mkv and take notes')).toBe(true)
    expect(isLearnFromVideo('C:\\v\\a.mp4')).toBe(false)          // a bare path is not a request
    expect(isLearnFromVideo('play C:\\music\\song.mp3')).toBe(false)
    expect(isLearnFromVideo('learn about the stock market')).toBe(false) // no file
  })
})

describe('reading transcriber status lines', () => {
  it('parses MODEL / PROGRESS / DONE / ERROR and ignores other lines', () => {
    expect(parseTranscribeLine('MODEL small')).toEqual({ type: 'model', name: 'small' })
    expect(parseTranscribeLine('PROGRESS 120 3600')).toEqual({ type: 'progress', done: 120, total: 3600 })
    expect(parseTranscribeLine('DONE 4521')).toEqual({ type: 'done', chars: 4521 })
    expect(parseTranscribeLine('ERROR could not read that media file')).toEqual({ type: 'error', message: 'could not read that media file' })
    expect(parseTranscribeLine('loading model=large-v3')).toBeNull()
    expect(parseTranscribeLine('')).toBeNull()
  })
})

describe('learning from a folder of recordings', () => {
  it('detects a folder request and distinguishes it from a single file', () => {
    expect(isLearnFromVideoFolder('learn from the videos in C:\\courses')).toBe(true)
    expect(isLearnFromVideoFolder('go through all the lectures in "C:/Users/me/Trading Course" and take notes')).toBe(true)
    expect(isLearnFromVideoFolder('watch this video and learn C:\\v\\a.mp4')).toBe(false) // a single file, not a folder
    expect(isLearnFromVideoFolder('clean up C:\\courses')).toBe(false)                     // no learn/media intent
    expect(extractFolderPath('learn from the videos in C:\\courses')).toBe('C:\\courses')
    expect(extractFolderPath('watch C:\\v\\a.mp4')).toBeNull()
  })

  it('collects media files from a folder tree, skipping non-media', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-media-test-'))
    try {
      fs.writeFileSync(path.join(dir, 'b.mp4'), '')
      fs.writeFileSync(path.join(dir, 'a.mp3'), '')
      fs.writeFileSync(path.join(dir, 'notes.txt'), '')
      fs.mkdirSync(path.join(dir, 'module2'))
      fs.writeFileSync(path.join(dir, 'module2', 'lesson.mkv'), '')
      const found = collectMedia(dir).map(p => path.basename(p))
      expect(found).toEqual(['a.mp3', 'b.mp4', 'lesson.mkv'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('reading a video\'s frames', () => {
  it('parses FRAME / DONE / ERROR lines', () => {
    expect(parseFrameLine('FRAME 125 C:\\tmp\\f_000125.jpg')).toEqual({ type: 'frame', seconds: 125, path: 'C:\\tmp\\f_000125.jpg' })
    expect(parseFrameLine('DONE 42')).toEqual({ type: 'done', count: 42 })
    expect(parseFrameLine('ERROR no video track')).toEqual({ type: 'error', message: 'no video track' })
    expect(parseFrameLine('loading')).toBeNull()
  })

  it('tags times and builds a visual-notes section, distinguishing video from audio', () => {
    expect(timeTag(75)).toBe('01:15')
    expect(timeTag(3725)).toBe('1:02:05')
    expect(formatVisualNotes([])).toBe('')
    const notes = formatVisualNotes([{ seconds: 90, text: 'Slide: Risk 1% per trade' }])
    expect(notes).toContain('[01:30] Slide: Risk 1% per trade')
    expect(notes).toContain('On-screen slides')
    expect(isVideoFile('C:\\v\\a.mp4')).toBe(true)
    expect(isVideoFile('C:\\v\\a.mp3')).toBe(false)
  })
})

describe('human-readable progress', () => {
  it('shows percent and hours/minutes', () => {
    expect(progressText(1800, 3600)).toBe('50% (30m / 1h 0m)')
    expect(progressText(7560, 21600)).toBe('35% (2h 6m / 6h 0m)')
    expect(progressText(100, 0)).toBe('2m transcribed')
  })
})
