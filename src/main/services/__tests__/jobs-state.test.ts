import { describe, expect, it } from 'vitest'
import { addStep, applyEvent, buildReport, canTransition, clampCap, newJob, pickStartable, queueNote, summarise, TERMINAL } from '../jobs/state'
import type { Job } from '../../../shared/jobs'

/**
 * The job state machine.
 *
 * These tests hold the rules the whole orchestration layer leans on: a job cannot skip states,
 * a question can only be answered when one is actually open, and an answer can never be
 * invented by the worker that asked.
 */

const T0 = 1_700_000_000_000

function job(over: Partial<Job> = {}): Job {
  return { ...newJob({ id: 'job-1', title: 'Build a page', goal: 'Build a landing page and find three testers', now: T0 }), ...over }
}

describe('a job’s state machine', () => {
  it('starts queued, then runs, then finishes done', () => {
    const queued = job()
    expect(queued.state).toBe('queued')
    expect(queued.resumedCount).toBe(0)

    const running = applyEvent(queued, { type: 'start' }, T0 + 1000)
    expect(running.state).toBe('running')
    expect(running.startedAt).toBe(T0 + 1000)

    const done = applyEvent(running, { type: 'finish', ok: true }, T0 + 5000)
    expect(done.state).toBe('done')
    expect(done.finishedAt).toBe(T0 + 5000)
    expect(done.progress).toBe('finished')
  })

  it('refuses to finish a queued job, or to start a finished one', () => {
    expect(() => applyEvent(job(), { type: 'finish', ok: true }, T0)).toThrow(/cannot handle "finish"/)
    const done = applyEvent(applyEvent(job(), { type: 'start' }, T0), { type: 'finish', ok: true }, T0)
    expect(() => applyEvent(done, { type: 'start' }, T0)).toThrow(/cannot handle "start"/)
    expect(TERMINAL.has('done')).toBe(true)
    expect(canTransition('done', 'running')).toBe(false)
  })

  it('stops a running job to ask, and only resumes when there is an answer', () => {
    const running = applyEvent(job(), { type: 'start' }, T0)
    const asked = applyEvent(running, { type: 'ask', question: { kind: 'credential', text: 'Which Alpaca account should the job use?' } }, T0 + 10)
    expect(asked.state).toBe('waiting')
    expect(asked.question?.text).toBe('Which Alpaca account should the job use?')
    expect(asked.progress).toContain('waiting on you')

    // A waiting job cannot quietly carry on: the only way out is an answer or a cancel.
    expect(() => applyEvent(asked, { type: 'start' }, T0 + 20)).toThrow()
    expect(() => applyEvent(asked, { type: 'finish', ok: true }, T0 + 20)).toThrow()

    const answered = applyEvent(asked, { type: 'answer', answer: 'the paper one' }, T0 + 30)
    expect(answered.state).toBe('running')
    expect(answered.question?.answer).toBe('the paper one')
    expect(answered.question?.answeredAt).toBe(T0 + 30)
  })

  it('refuses an answer to a job that is not waiting', () => {
    const running = applyEvent(job(), { type: 'start' }, T0)
    expect(() => applyEvent(running, { type: 'answer', answer: 'yes' }, T0)).toThrow(/cannot handle "answer"/)
  })

  it('refuses an empty answer, so nothing is answered on the user’s behalf', () => {
    const asked = applyEvent(applyEvent(job(), { type: 'start' }, T0), { type: 'ask', question: { kind: 'decision', text: 'Ship it?' } }, T0)
    expect(() => applyEvent(asked, { type: 'answer', answer: '   ' }, T0)).toThrow(/empty answer/)
  })

  it('refuses a second question while one is still open', () => {
    const asked = applyEvent(applyEvent(job(), { type: 'start' }, T0), { type: 'ask', question: { kind: 'decision', text: 'One?' } }, T0)
    expect(() => applyEvent(asked, { type: 'ask', question: { kind: 'decision', text: 'Two?' } }, T0)).toThrow(/second question/)
  })

  it('marks a running job interrupted rather than failed when the app closes', () => {
    const running = applyEvent(job(), { type: 'start' }, T0)
    const interrupted = applyEvent(running, { type: 'interrupt' }, T0 + 60_000)
    expect(interrupted.state).toBe('interrupted')
    expect(interrupted.interruptedAt).toBe(T0 + 60_000)
    expect(interrupted.progress).toContain('interrupted')

    const resumed = applyEvent(interrupted, { type: 'resume' }, T0 + 90_000)
    expect(resumed.state).toBe('running')
    expect(resumed.resumedCount).toBe(1)
    expect(resumed.interruptedAt).toBeUndefined()
  })

  it('cancels from every live state, and never from a finished one', () => {
    for (const from of ['queued', 'running', 'waiting', 'interrupted'] as const) {
      const base = from === 'queued' ? job()
        : from === 'running' ? applyEvent(job(), { type: 'start' }, T0)
          : from === 'waiting' ? applyEvent(applyEvent(job(), { type: 'start' }, T0), { type: 'ask', question: { kind: 'decision', text: 'q' } }, T0)
            : applyEvent(applyEvent(job(), { type: 'start' }, T0), { type: 'interrupt' }, T0)
      expect(applyEvent(base, { type: 'cancel' }, T0 + 1).state).toBe('canceled')
    }
    const done = applyEvent(applyEvent(job(), { type: 'start' }, T0), { type: 'finish', ok: true }, T0)
    expect(() => applyEvent(done, { type: 'cancel' }, T0)).toThrow()
  })

  it('leaves the job it was given untouched', () => {
    const original = job()
    const copy = JSON.stringify(original)
    applyEvent(original, { type: 'start' }, T0)
    expect(JSON.stringify(original)).toBe(copy)
  })
})

describe('the queue and its cap', () => {
  const make = (id: string, createdAt: number, state: Job['state'] = 'queued'): Job => ({ ...job({ id }), createdAt, state })

  it('starts the oldest queued jobs, and only up to the cap', () => {
    const jobs = [make('b', T0 + 2), make('a', T0 + 1), make('c', T0 + 3)]
    expect(pickStartable(jobs, 2).map(j => j.id)).toEqual(['a', 'b'])
    expect(pickStartable(jobs, 1).map(j => j.id)).toEqual(['a'])
  })

  it('starts nothing when the cap is already full', () => {
    const jobs = [make('running-1', T0, 'running'), make('running-2', T0 + 1, 'running'), make('waiting-1', T0 + 2, 'waiting'), make('queued-1', T0 + 3)]
    expect(pickStartable(jobs, 2)).toEqual([])
    // A job waiting on the user holds no slot, so it must not count as running.
    expect(pickStartable(jobs, 3).map(j => j.id)).toEqual(['queued-1'])
  })

  it('keeps the cap inside a sane range', () => {
    expect(clampCap(0)).toBe(2)
    expect(clampCap(undefined as unknown as number)).toBe(2)
    expect(clampCap(-4)).toBe(2)
    expect(clampCap(99)).toBe(6)
    expect(clampCap(3)).toBe(3)
  })

  it('says plainly when the queue is full', () => {
    const view = summarise([make('r', T0, 'running'), make('q1', T0 + 1), make('q2', T0 + 2)], 1)
    expect(view.running).toBe(1)
    expect(view.queued).toBe(2)
    expect(queueNote(view)).toContain('limit is full')
    expect(queueNote(view)).toContain('start when a running job finishes')
    const freeView = summarise([make('q1', T0 + 1)], 3)
    expect(queueNote(freeView)).toContain('slots free')
  })

  it('counts each state for the board header', () => {
    const view = summarise([
      make('a', T0, 'running'), make('b', T0, 'waiting'), make('c', T0), make('d', T0, 'done'), make('e', T0, 'interrupted'),
    ], 2)
    expect(view).toMatchObject({ running: 1, queued: 1, waiting: 1, cap: 2 })
    expect(view.jobs).toHaveLength(5)
  })

  it('lists the newest job first', () => {
    const view = summarise([make('old', T0), make('new', T0 + 5000)], 2)
    expect(view.jobs.map(j => j.id)).toEqual(['new', 'old'])
  })
})

describe('the report a job ends with', () => {
  const steps = [
    { index: 0, thought: 'open the page', tool: 'browser.open', params: { url: 'https://example.com' }, ok: true, detail: 'opened https://example.com', at: T0 },
    { index: 1, thought: 'write the copy', tool: 'filesystem.write', params: { path: 'C:\\out\\copy.md' }, ok: true, detail: 'wrote 812 bytes', at: T0 + 1 },
    { index: 2, thought: 'send the invite', tool: 'business.prepareTesterInvite', params: {}, ok: false, detail: 'no Gmail account is connected', at: T0 + 2 },
  ]

  it('splits results from operations, and names what did not work', () => {
    const report = buildReport({
      finalReply: 'The page is built and the copy is written.',
      steps, files: ['C:\\out\\copy.md'],
    })
    expect(report.result.join('\n')).toContain('The page is built')
    expect(report.result).toContain('File: C:\\out\\copy.md')
    expect(report.operations).toHaveLength(3)
    expect(report.operations[0]).toMatch(/^ok — browser\.open/)
    expect(report.operations[2]).toMatch(/^failed — business\.prepareTesterInvite/)
    expect(report.notDone).toHaveLength(1)
    expect(report.notDone[0]).toContain('business.prepareTesterInvite did not work: no Gmail account is connected')
    expect(report.files).toEqual(['C:\\out\\copy.md'])
  })

  it('does not claim a result when every step failed', () => {
    const report = buildReport({
      finalReply: '',
      steps: [{ index: 0, thought: '', tool: 'shell.execute', params: {}, ok: false, detail: 'refused', at: T0 }],
      files: [],
    })
    expect(report.result).toEqual(['Nothing was produced. This job ended without a result.'])
    expect(report.notDone[0]).toContain('shell.execute did not work')
  })

  it('says nothing was attempted when no step ran', () => {
    const report = buildReport({ finalReply: 'I could not start.', steps: [], files: [] })
    expect(report.notDone).toContain('Nothing was attempted — no step ran.')
  })

  it('carries the worker’s own declared gaps into "not done" and keeps duplicates out of the file list', () => {
    const report = buildReport({
      finalReply: 'Partly done.', steps, files: ['C:\\out\\copy.md', 'C:\\out\\copy.md'],
      declaredGaps: ['It used all 12 steps without finishing.'],
    })
    expect(report.files).toEqual(['C:\\out\\copy.md'])
    expect(report.notDone).toContain('It used all 12 steps without finishing.')
  })

  it('appends a step without touching the earlier ones', () => {
    const base = job()
    const one = addStep(base, { thought: 'look', tool: 'web.search', params: { q: 'x' }, ok: true, detail: 'found 3', at: T0 })
    const two = addStep(one, { thought: 'read', tool: 'web.fetch', params: { url: 'u' }, ok: false, detail: 'timed out', at: T0 + 1 })
    expect(base.steps).toHaveLength(0)
    expect(one.steps).toHaveLength(1)
    expect(two.steps.map(s => s.index)).toEqual([0, 1])
    expect(two.progress).toContain('web.fetch: timed out')
  })
})
