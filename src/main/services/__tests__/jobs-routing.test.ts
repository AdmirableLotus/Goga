import { describe, expect, it } from 'vitest'
import { looksLikeBigTask, parseJobCommand, questionMessage } from '../jobs/routing'

/**
 * Which requests become jobs, and how a job is driven from chat.
 *
 * The rule that matters: a small request must not be turned into a background job (the user
 * would lose the answer they were waiting for), and a job's question must never be answered
 * by an ordinary sentence that happens to follow it.
 */

describe('what deserves its own worker', () => {
  it('takes a compound request with several pieces of work', () => {
    expect(looksLikeBigTask('Build me a landing page for the ring project and find three testers for it')).toBe(true)
    expect(looksLikeBigTask('Research the top five bioimpedance AFEs, compare them, and write up a recommendation')).toBe(true)
    expect(looksLikeBigTask('Go through my Downloads folder, sort the datasheets by part number, then write an index of them')).toBe(true)
  })

  it('leaves a small single request in chat', () => {
    expect(looksLikeBigTask('open youtube.com')).toBe(false)
    expect(looksLikeBigTask('what is the price of AAPL')).toBe(false)
    expect(looksLikeBigTask('save this to notes.txt')).toBe(false)
    expect(looksLikeBigTask('')).toBe(false)
  })

  it('leaves a question a question, however long', () => {
    expect(looksLikeBigTask('What is the difference between an instrumentation amplifier and an op-amp, and why does it matter for the electrode front end?')).toBe(false)
  })
})

describe('driving a job from chat', () => {
  it('lists jobs', () => {
    expect(parseJobCommand('my jobs')).toEqual({ kind: 'list' })
    expect(parseJobCommand('jobs')).toEqual({ kind: 'list' })
    expect(parseJobCommand("what's running")).toEqual({ kind: 'list' })
  })

  it('reads one job', () => {
    expect(parseJobCommand('job job-abc?')).toEqual({ kind: 'read', id: 'job-abc' })
    expect(parseJobCommand('show me job job-abc')).toEqual({ kind: 'read', id: 'job-abc' })
  })

  it('answers a job only when the message names it', () => {
    expect(parseJobCommand('job job-abc: use the paper account')).toEqual({ kind: 'answer', id: 'job-abc', answer: 'use the paper account' })
    expect(parseJobCommand('answer job job-abc: yes')).toEqual({ kind: 'answer', id: 'job-abc', answer: 'yes' })
    // A bare "yes" is not an answer to a job — it belongs to whatever else is waiting.
    expect(parseJobCommand('yes')).toBeNull()
    expect(parseJobCommand('use the paper account')).toBeNull()
  })

  it('cancels, resumes and starts', () => {
    expect(parseJobCommand('cancel job job-abc')).toEqual({ kind: 'cancel', id: 'job-abc' })
    expect(parseJobCommand('stop the job job-abc')).toEqual({ kind: 'cancel', id: 'job-abc' })
    expect(parseJobCommand('resume job job-abc')).toEqual({ kind: 'resume', id: 'job-abc' })
    expect(parseJobCommand('start job: build the landing page and find testers')).toEqual({ kind: 'start', goal: 'build the landing page and find testers' })
  })

  it('leaves ordinary messages alone', () => {
    expect(parseJobCommand('open notepad')).toBeNull()
    expect(parseJobCommand('')).toBeNull()
  })
})

describe('the question a job puts in front of the user', () => {
  it('names the job, the question and how to answer it', () => {
    const text = questionMessage({
      id: 'job-abc', title: 'Ring landing page',
      question: { text: 'Which storefront should the listing go to?', detail: 'Shopify or Printful', options: ['Shopify', 'Printful'] },
    })
    expect(text).toContain('Ring landing page')
    expect(text).toContain('Which storefront should the listing go to?')
    expect(text).toContain('Shopify / Printful')
    expect(text).toContain('job job-abc: <your answer>')
  })

  it('says nothing when there is no question', () => {
    expect(questionMessage({ id: 'job-abc', title: 'x' })).toBe('')
  })
})
