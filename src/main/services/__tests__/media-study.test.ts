import { describe, expect, it, vi } from 'vitest'

// mediaStudy imports electron/settings transitively; the pure helpers tested here never call them.
vi.mock('electron', () => ({ app: { getAppPath: () => '/app', getPath: () => '/fake/userData' } }))

import { isLearnFromVideo, extractMediaPath, parseTranscribeLine, progressText } from '../mediaStudy'

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
  it('parses PROGRESS / DONE / ERROR and ignores other lines', () => {
    expect(parseTranscribeLine('PROGRESS 120 3600')).toEqual({ type: 'progress', done: 120, total: 3600 })
    expect(parseTranscribeLine('DONE 4521')).toEqual({ type: 'done', chars: 4521 })
    expect(parseTranscribeLine('ERROR could not read that media file')).toEqual({ type: 'error', message: 'could not read that media file' })
    expect(parseTranscribeLine('loading model=large-v3')).toBeNull()
    expect(parseTranscribeLine('')).toBeNull()
  })
})

describe('human-readable progress', () => {
  it('shows percent and hours/minutes', () => {
    expect(progressText(1800, 3600)).toBe('50% (30m / 1h 0m)')
    expect(progressText(7560, 21600)).toBe('35% (2h 6m / 6h 0m)')
    expect(progressText(100, 0)).toBe('2m transcribed')
  })
})
