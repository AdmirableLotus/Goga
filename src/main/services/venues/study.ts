import fs from 'fs'
import path from 'path'
import { app } from 'electron'

/**
 * The study base, in the app.
 *
 * The content is the file already written for the user at
 * C:\Users\redre\OS3\pivex-check-and-trading-basics\Pivex-check-and-trading-basics.md.
 * This service reads that file rather than keeping a second copy, so there is one text and
 * it cannot drift. If the file is missing, it says so plainly instead of showing an empty
 * page that looks like a bug.
 */

export const STUDY_BASE_SOURCE = 'C:\\Users\\redre\\OS3\\pivex-check-and-trading-basics\\Pivex-check-and-trading-basics.md'

export interface StudyBase {
  found: boolean
  /** Where it was read from. */
  source: string
  /** The markdown, as written. */
  markdown: string
  /** Plain words when it could not be read. */
  error: string | null
  /** When it was last changed on disk. */
  modifiedAt: string | null
}

/** Candidate locations, so a moved file is still found. */
function candidates(): string[] {
  const list = [STUDY_BASE_SOURCE]
  const home = app.getPath('home')
  list.push(path.join(home, 'OS3', 'pivex-check-and-trading-basics', 'Pivex-check-and-trading-basics.md'))
  list.push(path.join(app.getPath('userData'), 'study', 'Pivex-check-and-trading-basics.md'))
  return list
}

export function readStudyBase(): StudyBase {
  for (const file of candidates()) {
    try {
      const markdown = fs.readFileSync(file, 'utf8')
      const stat = fs.statSync(file)
      return { found: true, source: file, markdown, error: null, modifiedAt: stat.mtime.toISOString() }
    } catch { /* try the next place */ }
  }
  return {
    found: false,
    source: STUDY_BASE_SOURCE,
    markdown: '',
    error: `The study base file is not at ${STUDY_BASE_SOURCE} any more. It was written for you on 13 Nov 2026; if you moved it, put it back there or in ${path.join(app.getPath('userData'), 'study')}.`,
    modifiedAt: null,
  }
}
