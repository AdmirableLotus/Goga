// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import OsintPage from '../OsintPage'
import type { OsintPageState, UsernameResult } from '../../../shared/osint'

/**
 * The page's job is honesty: show what was found with its source and read time, and show
 * what could not be checked in its own list. These tests hold it to that.
 */

const state: OsintPageState = {
  activeProgram: null,
  breachKey: { configured: false, encryptionAvailable: true },
  sites: [{ site: 'GitHub', about: 'Source code and commit history.' }],
  excluded: [{ site: 'Reddit', url: 'https://www.reddit.com/user/{u}', reason: 'answers 403 to automated reads' }],
  recent: [],
}

const usernameResult: UsernameResult = {
  query: 'torvalds',
  mode: 'unattributed',
  programName: null,
  purpose: '',
  checked: [],
  found: [{ site: 'GitHub', url: 'https://github.com/torvalds', outcome: 'found', status: 200, readAt: '2026-11-10T03:54:35.000Z' }],
  absent: [{ site: 'Codeberg', url: 'https://codeberg.org/torvalds', outcome: 'absent', status: 404, readAt: '2026-11-10T03:54:36.000Z' }],
  blocked: [{ site: 'Hugging Face', url: 'https://huggingface.co/torvalds', outcome: 'blocked', status: 403, readAt: '2026-11-10T03:54:37.000Z', detail: 'the site answered 403 to an automated read, so this says nothing either way' }],
  notChecked: [{ site: 'Reddit', url: 'https://www.reddit.com/user/torvalds', outcome: 'not_checked', status: null, readAt: null, detail: 'answers 403 to automated reads' }],
  notes: [{ kind: 'inconclusive', detail: 'It does not establish that the person has no account there.' }],
  redactions: [{ kind: 'password', count: 1 }],
  startedAt: '2026-11-10T03:54:34.000Z',
  finishedAt: '2026-11-10T03:54:39.000Z',
}

const audit = {
  id: 'a', time: '2026-11-10T03:54:39.000Z', tool: 'osint.username' as const, query: 'torvalds',
  purpose: '', mode: 'unattributed' as const, programName: null, sources: ['github.com'], skipped: [], summary: '8 answered',
}

function installApi(run: () => Promise<unknown>) {
  ;(window as unknown as { goga: unknown }).goga = {
    invoke: vi.fn(async (channel: string) => {
      if (channel === 'osint:state') return state
      if (channel === 'osint:history') return []
      if (channel === 'osint:run') return run()
      return null
    }),
  }
}

afterEach(() => cleanup())

describe('OSINT page', () => {
  it('shows the found profile with its source and read time', async () => {
    installApi(async () => ({ data: usernameResult, text: '', audit }))
    render(<OsintPage />)
    await waitFor(() => expect(screen.getByText(/unattributed public research/i)).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText('e.g. torvalds'), { target: { value: 'torvalds' } })
    fireEvent.click(screen.getByText('Run'))
    await waitFor(() => expect(screen.getByText('https://github.com/torvalds')).toBeTruthy())
    expect(screen.getByText(/read 2026-11-10 03:54:35Z/)).toBeTruthy()
  })

  it('keeps "no such user" and "could not be checked" apart from the hits', async () => {
    installApi(async () => ({ data: usernameResult, text: '', audit }))
    render(<OsintPage />)
    await waitFor(() => expect(screen.getByText(/unattributed public research/i)).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText('e.g. torvalds'), { target: { value: 'torvalds' } })
    fireEvent.click(screen.getByText('Run'))
    await waitFor(() => expect(screen.getByText(/a statement about those sites only/)).toBeTruthy())
    expect(screen.getByText(/the site refused an automated read/)).toBeTruthy()
    expect(screen.getByText(/It does not establish that the person has no account there/)).toBeTruthy()
    expect(screen.getByText(/Removed before display: 1× password/)).toBeTruthy()
  })

  it('shows the refusal text when a run is declined', async () => {
    installApi(async () => { throw new Error('stating a legitimate purpose is required before Goga will run an email search') })
    render(<OsintPage />)
    await waitFor(() => expect(screen.getByText(/unattributed public research/i)).toBeTruthy())
    fireEvent.click(screen.getByText('Reverse email'))
    fireEvent.change(screen.getByPlaceholderText('e.g. someone@example.com'), { target: { value: 'a@b.com' } })
    fireEvent.click(screen.getByText('Run'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/legitimate purpose/))
  })

  it('shows a declined run as a message instead of drawing it as a result', async () => {
    // A refusal comes back as { refused: "why" } with no result arrays. Drawing that as a
    // result used to throw and blank the whole window.
    installApi(async () => ({
      data: { refused: 'stating a legitimate purpose is required before Goga will run profile aggregation.' },
      text: 'OSINT profile did not run',
      audit,
    }))
    render(<OsintPage />)
    await waitFor(() => expect(screen.getByText(/unattributed public research/i)).toBeTruthy())
    fireEvent.click(screen.getByText('Profile aggregation'))
    fireEvent.change(screen.getByPlaceholderText('a handle, an email address, or a profile URL'), { target: { value: 'https://example.com/someone' } })
    fireEvent.click(screen.getByText('Run'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/legitimate purpose/))
    expect(screen.getByText(/Profile aggregation result/)).toBeTruthy()
  })

  it('lists the sites that are deliberately not checked', async () => {
    installApi(async () => ({ data: usernameResult, text: '', audit }))
    render(<OsintPage />)
    await waitFor(() => expect(screen.getByText(/Deliberately not checked/)).toBeTruthy())
    expect(screen.getByText(/answers 403 to automated reads/)).toBeTruthy()
  })
})
