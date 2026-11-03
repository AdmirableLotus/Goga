import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  QuizService, parseExercise, parseReview, extractQuizTopic, pickBook, materialFor,
  QUIZ_REQUEST, QUIZ_AGAIN, QUIZ_HISTORY,
} from '../quiz'
import type { BookProgress } from '../bookStudy'

const book = (title: string, done: number): BookProgress => ({
  bookId: title, title, sections: 10, done,
  notes: [{ section: 0, summary: `${title} teaches the basics.`, ideas: ['risk first', 'position sizing'], terms: [] }],
  skills: [{ name: 'Set a stop', when: 'entering a trade', steps: ['pick a level', 'size to 1% risk'], book: title, section: 0 }],
  failures: 0, startedAt: 0,
})

describe('quiz command detection', () => {
  it('recognises quiz / answer-again / history phrasings', () => {
    expect(QUIZ_REQUEST.test('quiz me')).toBe(true)
    expect(QUIZ_REQUEST.test('give me a practice question on stops')).toBe(true)
    expect(QUIZ_REQUEST.test('what is the weather')).toBe(false)
    expect(QUIZ_AGAIN.test('another')).toBe(true)
    expect(QUIZ_AGAIN.test('next question')).toBe(true)
    expect(QUIZ_AGAIN.test('another trade please')).toBe(false)
    expect(QUIZ_HISTORY.test('how am I doing')).toBe(true)
  })

  it('extracts the topic after on/about/for', () => {
    expect(extractQuizTopic('quiz me on trading')).toBe('trading')
    expect(extractQuizTopic('test me about the owasp book')).toBe('owasp')
    expect(extractQuizTopic('quiz me')).toBe('')
  })
})

describe('parsing model output', () => {
  it('reads an exercise from messy JSON and fills defaults', () => {
    const ex = parseExercise('sure:\n{"title":"Stops","prompt":"Explain a stop-loss.","rubric":"mentions risk","difficulty":"easy"} done', 'OWASP')
    expect(ex.title).toBe('Stops')
    expect(ex.prompt).toBe('Explain a stop-loss.')
    expect(ex.difficulty).toBe('intermediate') // "easy" isn't a valid level → default
    expect(ex.bookTitle).toBe('OWASP')
  })

  it('clamps a review score to 0-100', () => {
    const r = parseReview('{"score": 140, "strengths":["clear"], "gaps":["no example"], "improvedExample":"x", "nextStep":"practice"}')
    expect(r.score).toBe(100)
    expect(r.gaps).toEqual(['no example'])
  })

  it('throws when there is no JSON', () => {
    expect(() => parseExercise('I could not make one', 'B')).toThrow()
  })
})

describe('choosing study material', () => {
  it('prefers a title match, else the most-studied book', () => {
    const books = [book('OWASP', 3), book('Trading 101', 7)]
    expect(pickBook(books, 'trading')?.title).toBe('Trading 101')
    expect(pickBook(books, '')?.title).toBe('Trading 101') // most done
    expect(pickBook([], 'x')).toBeNull()
    expect(materialFor(book('OWASP', 1))).toContain('risk first')
  })
})

describe('QuizService', () => {
  let file: string
  afterEach(() => { try { fs.rmSync(file, { force: true }) } catch { /* */ } })

  const svc = (studied: BookProgress[], replies: string[]) => {
    file = path.join(os.tmpdir(), `goga-quiz-${Math.random().toString(36).slice(2)}.json`)
    let i = 0
    return new QuizService(file, { chat: async () => replies[Math.min(i++, replies.length - 1)], studied: () => studied })
  }

  it('says it is not ready when nothing is studied', () => {
    expect(svc([], []).notReady()).toMatch(/haven't studied/)
    expect(svc([book('B', 2)], []).notReady()).toBeNull()
  })

  it('makes, grades, records, and summarises', async () => {
    const q = svc([book('Trading 101', 5)], [
      '{"title":"Risk","prompt":"How much per trade?","rubric":"1% or less","difficulty":"beginner"}',
      '{"score":80,"strengths":["correct number"],"gaps":[],"improvedExample":"Risk 1%.","nextStep":"practice sizing"}',
    ])
    const ex = await q.make('trading')
    expect(ex.title).toBe('Risk')
    expect(q.hasSession()).toBe(true)
    const review = await q.grade(ex, 'One percent of the account.')
    expect(review.score).toBe(80)
    const summary = q.summary()
    expect(summary).toMatch(/average 80\/100/)
    expect(summary).toContain('Trading 101')
  })

  it('persists attempts across instances', async () => {
    const q = svc([book('B', 1)], [
      '{"title":"T","prompt":"P","rubric":"R","difficulty":"beginner"}',
      '{"score":50,"strengths":[],"gaps":["thin"],"improvedExample":"x","nextStep":"y"}',
    ])
    const ex = await q.make()
    await q.grade(ex, 'my answer')
    const reopened = new QuizService(file, { chat: async () => '', studied: () => [book('B', 1)] })
    expect(reopened.summary()).toMatch(/1 practice question/)
  })
})
