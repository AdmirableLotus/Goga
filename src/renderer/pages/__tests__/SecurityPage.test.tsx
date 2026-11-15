// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SecurityPage from '../SecurityPage'
import type { PlatformConnection } from '../../../shared/security'

/**
 * The Security page's job with a token is honesty: a stored token is not a working one, and
 * the row must say what a live call said — connected, rejected, expired, not connected —
 * with the reason and the page where the user fixes it. These tests hold it to that.
 *
 * Both platform rows are on the page, so the assertions look for the HackerOne detail line
 * rather than a chip label that both rows can share.
 */

function connection(over: Partial<PlatformConnection>): PlatformConnection {
  return {
    source: 'hackerone',
    state: 'not-connected',
    detail: 'No HackerOne token is stored.',
    account: null,
    checkedAt: null,
    where: 'https://hackerone.com/settings/api_token/edit',
    programs: [],
    listedAt: null,
    ...over,
  }
}

function installApi(opts: { configured: boolean; stored: PlatformConnection; checked?: PlatformConnection }) {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'security:programs') {
      return {
        programs: [], active: null,
        credentials: {
          hackerone: { configured: opts.configured, encryptionAvailable: true },
          bugcrowd: { configured: false, encryptionAvailable: true },
        },
        connections: {
          hackerone: opts.stored,
          bugcrowd: connection({ source: 'bugcrowd', state: 'not-connected', detail: 'No Bugcrowd token is stored.', where: 'https://tracker.bugcrowd.com/settings/api' }),
        },
      }
    }
    if (channel === 'security:checkConnection') return opts.checked ?? opts.stored
    if (channel === 'security:findings') return []
    if (channel === 'security:audit') return []
    if (channel === 'security:curriculum') return { version: '1', note: '', lessons: [] }
    return null
  })
  ;(window as unknown as { goga: unknown }).goga = { invoke }
  return invoke
}

afterEach(() => cleanup())

describe('Security page connection state', () => {
  it('says not connected when no token is stored, and does not call the API', async () => {
    const invoke = installApi({ configured: false, stored: connection({}) })
    render(<SecurityPage />)
    await waitFor(() => expect(screen.getByText(/No HackerOne token is stored/)).toBeTruthy())
    expect(screen.getAllByText('not connected').length).toBe(2)
    expect(invoke.mock.calls.some(c => c[0] === 'security:checkConnection')).toBe(false)
  })

  it('shows a stored-but-unchecked token as not checked yet, then what the live call said', async () => {
    installApi({
      configured: true,
      stored: connection({ state: 'unchecked', detail: 'A token is stored but has not been checked against the API yet. Press Check connection.' }),
      checked: connection({ state: 'connected', account: 'admirablelotus', checkedAt: '2026-11-11T15:14:26.994Z', detail: 'Connected as admirablelotus. HackerOne accepted the stored token.' }),
    })
    render(<SecurityPage />)
    await waitFor(() => expect(screen.getByText(/Connected as admirablelotus/)).toBeTruthy())
    expect(screen.getByText('connected')).toBeTruthy()
    expect(screen.getAllByText(/as admirablelotus/).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(/checked 2026-11-11 15:14 UTC/)).toBeTruthy()
  })

  it('shows a rejected token with the reason and the page to create a new one', async () => {
    installApi({
      configured: true,
      stored: connection({ state: 'unchecked', detail: 'A token is stored but has not been checked against the API yet.' }),
      checked: connection({ state: 'rejected', checkedAt: '2026-11-11T15:20:00.000Z', detail: 'HackerOne rejected the stored token (HTTP 401). It may have been revoked or replaced — create a new one and save it again.' }),
    })
    render(<SecurityPage />)
    await waitFor(() => expect(screen.getByText('rejected')).toBeTruthy())
    expect(screen.getByText(/HTTP 401/)).toBeTruthy()
    expect(screen.getByText(/Create a new token at/)).toBeTruthy()
    const link = screen.getByText('hackerone.com/settings/api_token/edit') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://hackerone.com/settings/api_token/edit')
  })

  it('shows an expired token as expired, not as connected', async () => {
    installApi({
      configured: true,
      stored: connection({ state: 'unchecked', detail: 'A token is stored but has not been checked against the API yet.' }),
      checked: connection({ state: 'expired', detail: 'The stored token can no longer be decrypted on this Windows account. Save it again.' }),
    })
    render(<SecurityPage />)
    await waitFor(() => expect(screen.getByText('expired')).toBeTruthy())
    expect(screen.getByText(/can no longer be decrypted/)).toBeTruthy()
  })
})
