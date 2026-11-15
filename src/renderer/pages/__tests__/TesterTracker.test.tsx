// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TesterTracker from '../../components/TesterTracker'
import type { TesterApp, TesterAppSummary, TesterRecruitment } from '../../../shared/business'

/**
 * The tracker's job is to be honest about the count and to send nothing by itself. These
 * render tests hold it to both: the shortfall is visible, a drop-out is named, and the only
 * outbound call it can make is `prepareTesterInvite` — never a send.
 */

afterEach(cleanup)

function app(over: Partial<TesterApp> = {}): TesterApp {
  return {
    id: 'app-only3', name: 'Only3', packageName: 'com.base6a76745e0296d6adfc52539f.app',
    track: 'closed', required: 12, optInDays: 14, candidates: [], notes: '',
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...over,
  }
}

function summary(over: Partial<TesterAppSummary> = {}): TesterAppSummary {
  return {
    appId: 'app-only3', name: 'Only3', packageName: 'com.base6a76745e0296d6adfc52539f.app',
    track: 'closed', required: 12, optInDays: 14, optedIn: 10, optedInLongEnough: 10,
    outstanding: 1, dropped: 1, meetsCount: false, eligibleAt: null, daysRemaining: null,
    status: '10 of 12 opted in',
    warning: '2 short: 10 of 12 opted in. Google\'s clock needs 12 opted in at the same time for 14 days. The most recent drop-out was recorded 2026-11-09; a break in the streak restarts that tester\'s 14 days.',
    latestDropAt: '2026-11-09T09:00:00.000Z', ...over,
  }
}

function recruitment(apps: TesterApp[], summaries: TesterAppSummary[]): TesterRecruitment {
  return {
    apps, summaries, copyDrafts: [],
    shortApps: summaries.filter(s => !s.meetsCount).length,
  }
}

function installApi(over: Partial<TesterRecruitment> = {}) {
  const r = recruitment([app()], [summary()])
  const state = { ...r, ...over }
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'business:state') return state
    if (channel.startsWith('business:')) return null
    return null
  })
  ;(window as unknown as { goga: unknown }).goga = { invoke, on: vi.fn(() => () => {}) }
  return invoke
}

describe('the tester tracker', () => {
  it('shows the count, the shortfall and the drop-out warning', () => {
    installApi()
    render(<TesterTracker recruitment={recruitment([app()], [summary()])} busy={false} onChanged={() => {}} notify={() => {}} />)
    expect(screen.getAllByText(/10 of 12 opted in/).length).toBeGreaterThan(0)
    expect(screen.getByText(/2 short: 10 of 12 opted in/)).toBeTruthy()
    expect(screen.getByText(/most recent drop-out was recorded 2026-11-09/)).toBeTruthy()
  })

  it('says all apps are at the requirement when they are', () => {
    const good = summary({ optedIn: 12, meetsCount: true, warning: null, status: '12 of 12 opted in — 4 days to go', daysRemaining: 4, eligibleAt: '2026-11-15T12:00:00.000Z' })
    render(<TesterTracker recruitment={recruitment([app()], [good])} busy={false} onChanged={() => {}} notify={() => {}} />)
    expect(screen.getByText(/all apps at the requirement/)).toBeTruthy()
    expect(screen.getByText(/streak completes 2026-11-15/)).toBeTruthy()
  })

  it('offers no outbound call except preparing an invite', async () => {
    const invoke = installApi()
    render(
      <TesterTracker
        recruitment={recruitment([app()], [summary()])}
        busy={false}
        onChanged={() => {}}
        notify={() => {}}
      />,
    )
    // The first app is open by default, so its tester form is already on screen.
    fireEvent.change(screen.getByPlaceholderText('name@example.com'), { target: { value: 'friend@example.com' } })
    fireEvent.click(screen.getByText('Add tester'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('business:addCandidate', expect.objectContaining({ email: 'friend@example.com' })))
    const channels = invoke.mock.calls.map(c => String(c[0]))
    expect(channels.every(c => c.startsWith('business:'))).toBe(true)
    expect(channels).not.toContain('business:approve')
    expect(channels).not.toContain('business:prepareMail')
  })
})
