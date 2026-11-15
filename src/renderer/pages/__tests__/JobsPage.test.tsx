// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import JobsPage from '../JobsPage'
import type { Job, JobsView } from '../../../shared/jobs'

/**
 * The job board's job is to be readable at a glance: what is running, what is waiting on the
 * user, and — for a finished job — what you get versus what it did not do.
 */

const T0 = 1_700_000_000_000

function job(over: Partial<Job>): Job {
  return {
    id: 'job-1', title: 'Ring landing page', goal: 'Build a page and find testers', state: 'running',
    createdAt: T0, startedAt: T0, progress: 'thinking about step 2', steps: [], bounds: { maxSteps: 12, maxMinutes: 30 },
    resumedCount: 0, ...over,
  }
}

function view(jobs: Job[], cap = 2): JobsView {
  return {
    jobs, cap,
    running: jobs.filter(j => j.state === 'running').length,
    queued: jobs.filter(j => j.state === 'queued').length,
    waiting: jobs.filter(j => j.state === 'waiting').length,
  }
}

function installApi(state: JobsView, onAnswer?: (id: string, answer: string) => void) {
  ;(window as unknown as { goga: unknown }).goga = {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'jobs:state') return state
      if (channel === 'jobs:answer') { onAnswer?.(String(args[0]), String(args[1])); return state }
      if (channel === 'jobs:cancel') return state
      if (channel === 'jobs:resume') return state
      if (channel === 'jobs:setCap') return state
      return null
    }),
    on: vi.fn(() => () => {}),
  }
}

afterEach(() => cleanup())

describe('the job board', () => {
  it('shows a running job with its progress line', async () => {
    installApi(view([job({})]))
    render(<JobsPage />)
    await waitFor(() => expect(screen.getByText('Ring landing page')).toBeTruthy())
    expect(screen.getByText('thinking about step 2')).toBeTruthy()
    expect(screen.getByText('running')).toBeTruthy()
  })

  it('puts a waiting job first and sends the answer back to that job', async () => {
    const answers: [string, string][] = []
    const waiting = job({
      id: 'job-9', title: 'Tester outreach', state: 'waiting', progress: 'waiting on you: which storefront?',
      question: { id: 'q1', kind: 'decision', text: 'Which storefront should the listing go to?', askedAt: T0 },
    })
    installApi(view([job({ id: 'job-2', title: 'Other work' }), waiting]), (id, answer) => answers.push([id, answer]))
    render(<JobsPage />)

    await waitFor(() => expect(screen.getByText(/Waiting on you — Tester outreach/)).toBeTruthy())
    expect(screen.getByText('Which storefront should the listing go to?')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('your answer'), { target: { value: 'Shopify' } })
    fireEvent.click(screen.getByText('Send answer'))
    await waitFor(() => expect(answers).toEqual([['job-9', 'Shopify']]))
  })

  it('offers the options as buttons when the job gave a list', async () => {
    const answers: [string, string][] = []
    const waiting = job({
      id: 'job-9', title: 'Pick one', state: 'waiting',
      question: { id: 'q1', kind: 'choice', text: 'Which account?', options: ['paper', 'live'], askedAt: T0 },
    })
    installApi(view([waiting]), (id, answer) => answers.push([id, answer]))
    render(<JobsPage />)
    await waitFor(() => expect(screen.getByText('paper')).toBeTruthy())
    fireEvent.click(screen.getByText('live'))
    await waitFor(() => expect(answers).toEqual([['job-9', 'live']]))
  })

  it('splits a finished job’s report into what you get and what was not done', async () => {
    const done = job({
      id: 'job-3', title: 'Landing page', state: 'done', progress: 'finished',
      report: {
        result: ['The page is built at C:\\out\\index.html', 'File: C:\\out\\index.html'],
        operations: ['ok — filesystem.write: wrote 812 bytes', 'failed — business.prepareTesterInvite: no Gmail account is connected'],
        notDone: ['business.prepareTesterInvite did not work: no Gmail account is connected'],
        files: ['C:\\out\\index.html'],
      },
    })
    installApi(view([done]))
    render(<JobsPage />)
    await waitFor(() => expect(screen.getByText('Landing page')).toBeTruthy())
    expect(screen.getByText('What you get')).toBeTruthy()
    expect(screen.getByText('The page is built at C:\\out\\index.html')).toBeTruthy()
    expect(screen.getByText('Not done')).toBeTruthy()
    expect(screen.getByText('business.prepareTesterInvite did not work: no Gmail account is connected')).toBeTruthy()
  })

  it('marks a finished job that left something undone as partly done, on the row itself', async () => {
    const partly = job({
      id: 'job-6', title: 'Partly', state: 'done',
      report: {
        result: ['File: C:\\out\\a.md'],
        operations: ['ok — filesystem.write: wrote 4 bytes', 'failed — filesystem.read: no such file'],
        notDone: ['filesystem.read did not work: no such file'],
        files: ['C:\\out\\a.md'],
      },
    })
    installApi(view([partly]))
    render(<JobsPage />)
    await waitFor(() => expect(screen.getByText('partly done')).toBeTruthy())
  })

  it('says every step worked when nothing was left undone', async () => {
    const done = job({
      id: 'job-4', title: 'Clean job', state: 'done',
      report: { result: ['Done.'], operations: ['ok — clock.now: noon'], notDone: [], files: [] },
    })
    installApi(view([done]))
    render(<JobsPage />)
    await waitFor(() => expect(screen.getByText('Every step this job attempted worked.')).toBeTruthy())
  })

  it('shows an interrupted job with a resume button', async () => {
    const interrupted = job({ id: 'job-5', title: 'Half done', state: 'interrupted', interruptedAt: T0, progress: 'interrupted — Goga closed while this was running' })
    installApi(view([interrupted]))
    render(<JobsPage />)
    await waitFor(() => expect(screen.getByText('Half done')).toBeTruthy())
    expect(screen.getByText(/Interrupted 2023-11-14 22:13 UTC/)).toBeTruthy()
    expect(screen.getByText('Resume')).toBeTruthy()
  })

  it('says plainly when the queue is full', async () => {
    installApi(view([job({ id: 'a', title: 'Running one' }), job({ id: 'b', title: 'Queued one', state: 'queued' })], 1))
    render(<JobsPage />)
    await waitFor(() => expect(screen.getByText(/the 1-job limit is full/)).toBeTruthy())
  })

  it('shows an empty board as an invitation, not a blank page', async () => {
    installApi(view([]))
    render(<JobsPage />)
    await waitFor(() => expect(screen.getByText('No jobs yet')).toBeTruthy())
  })
})
