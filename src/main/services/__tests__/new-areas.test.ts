import { describe, expect, it } from 'vitest'
import { assetCovers, decideScope, forbiddenTarget, parseTarget } from '../security/scope'
import { reflectionReport } from '../security/probe'
import { powerBudget, electrodeImpedance, filterResponse } from '../ee/calc'
import { guardHits, contentProblems, editablePath } from '../evolution/guard'
import { planProblems, parsePlan } from '../evolution/loop'
import { plannerOffers } from '../agentRouting'
import { riskRefusals } from '../broker/risk'
import type { ProgramImport } from '../../../shared/security'
import type { RiskLimitsView } from '../../../shared/broker'

const program = (over: Partial<ProgramImport> = {}): ProgramImport => ({
  id: 'p1', source: 'hackerone', handle: 'demo', name: 'Demo', url: 'https://hackerone.com/demo',
  importedAt: '2026-11-08T00:00:00.000Z', policy: '', submissionState: 'open', offersBounties: true,
  assets: [
    { identifier: '*.example.com', assetType: 'wildcard', eligibleForSubmission: true, eligibleForBounty: true, maxSeverity: 'critical', instruction: null },
    { identifier: 'https://app.example.com/admin', assetType: 'url', eligibleForSubmission: true, eligibleForBounty: false, maxSeverity: null, instruction: 'admin panel' },
    { identifier: '10.0.0.0/8', assetType: 'cidr', eligibleForSubmission: true, eligibleForBounty: false, maxSeverity: null, instruction: null },
  ],
  exclusions: [{ category: 'Automated scanners', details: 'No automated vulnerability scanners' }],
  skipped: [], notes: '',
  ...over,
})

describe('scope', () => {
  it('parses a bare host as https', () => {
    expect(parseTarget('shop.example.com/a?b=1')).toMatchObject({ scheme: 'https', host: 'shop.example.com' })
  })

  it('matches a wildcard for a subdomain and the apex', () => {
    const t = parseTarget('https://shop.example.com/')
    expect(assetCovers('*.example.com', 'wildcard', t).covers).toBe(true)
    expect(assetCovers('*.example.com', 'wildcard', parseTarget('https://example.com/')).covers).toBe(true)
    expect(assetCovers('*.example.com', 'wildcard', parseTarget('https://example.org/')).covers).toBe(false)
  })

  it('does not let a path asset authorize a sibling path', () => {
    const inside = parseTarget('https://app.example.com/admin/users')
    const outside = parseTarget('https://app.example.com/orders')
    expect(assetCovers('https://app.example.com/admin', 'url', inside).covers).toBe(true)
    expect(assetCovers('https://app.example.com/admin', 'url', outside).covers).toBe(false)
  })

  it('checks CIDR membership', () => {
    expect(assetCovers('10.0.0.0/8', 'cidr', parseTarget('http://10.4.5.6/')).covers).toBe(true)
    expect(assetCovers('10.0.0.0/8', 'cidr', parseTarget('http://11.4.5.6/')).covers).toBe(false)
  })

  it('defaults to deny when nothing matches', () => {
    const d = decideScope(program(), 'https://nope.test/')
    expect(d.inScope).toBe(false)
    expect(d.undetermined).toBe(true)
  })

  it('refuses when no program is imported', () => {
    expect(decideScope(null, 'https://app.example.com/').inScope).toBe(false)
  })

  it('applies a category exclusion', () => {
    const d = decideScope(program(), 'https://app.example.com/x', 'automated scanner')
    expect(d.inScope).toBe(false)
  })

  it('blocks local and metadata hosts', () => {
    expect(forbiddenTarget('localhost')).not.toBeNull()
    expect(forbiddenTarget('127.0.0.1')).not.toBeNull()
    expect(forbiddenTarget('169.254.169.254')).not.toBeNull()
    expect(forbiddenTarget('shop.example.com')).toBeNull()
  })
})

describe('reflection check', () => {
  it('finds a marker in element text', () => {
    const r = reflectionReport('<p>hello goga7f3a91 world</p>', 'goga7f3a91')
    expect(r.found).toBe(true)
    expect(r.contexts[0].context).toContain('element text')
  })

  it('notices an attribute context', () => {
    const r = reflectionReport('<input value="goga7f3a91">', 'goga7f3a91')
    expect(r.contexts[0].context).toContain('attribute')
  })

  it('reports absence without claiming safety', () => {
    const r = reflectionReport('<p>nothing here</p>', 'goga7f3a91')
    expect(r.found).toBe(false)
    expect(r.verdict).toContain('did not come back')
  })
})

describe('calculators', () => {
  it('sums power as V x I and multiplies duty', () => {
    const r = powerBudget({ loads: [{ name: 'a', voltage: 3.3, currentMa: 10 }, { name: 'b', voltage: 5, currentMa: 2, dutyCycle: 0.5 }] })
    // 3.3*10 = 33 mW, 5*1 = 5 mW
    expect(r.result['Total power']).toBe('38 mW')
    expect(r.steps.some(s => s.expression.includes('3.3 V'))).toBe(true)
  })

  it('derives impedance from V / I', () => {
    const r = electrodeImpedance({ currentUa: 50, voltageMv: 250, seriesOhm: 100 })
    // 0.25 V / 50e-6 A = 5000 ohm; minus 100 = 4900
    expect(r.steps.find(s => s.label === 'Impedance')?.value).toBe('5000 Ω')
    expect(r.result['Electrode-only']).toBe('4900 Ω')
  })

  it('computes an RC corner as 1/(2 pi R C)', () => {
    const r = filterResponse({ kind: 'lowpass', resistanceOhm: 10000, capacitanceF: 100e-9 })
    // 1/(2*pi*1e-3) = 159.15 Hz
    expect(r.steps[0].value).toBe('159.155 Hz')
  })
})

describe('self-improvement guardrails', () => {
  it('protects the approval, security, broker and credential code', () => {
    expect(guardHits(['src/main/services/authorization.ts'])).toHaveLength(1)
    expect(guardHits(['src/main/services/broker/credentials.ts'])).toHaveLength(1)
    expect(guardHits(['src/main/tools/security.ts'])).toHaveLength(1)
    expect(guardHits(['src/main/tools/clock.ts'])).toHaveLength(0)
  })

  it('offers the OSINT tools only for OSINT tasks, and approval-gates them', () => {
    // A normal task must not be tempted by osint.* tools.
    expect(plannerOffers('make a text file on my desktop')('osint.username')).toBe(false)
    // An OSINT task gets them, alongside the ordinary search tools.
    expect(plannerOffers('run a reverse username check on this handle')('osint.username')).toBe(true)
    expect(plannerOffers('run a reverse username check on this handle')('web.search')).toBe(true)
    // Read-only history stays available everywhere.
    expect(plannerOffers('make a text file')('osint.history')).toBe(false)
  })

  it('protects the OSINT rules, tools and page bridge', () => {
    expect(guardHits(['src/main/services/osint/engine.ts'])).toHaveLength(1)
    expect(guardHits(['src/main/tools/osint.ts'])).toHaveLength(1)
    expect(guardHits(['src/main/handlers/osint.ts'])).toHaveLength(1)
  })

  it('only allows source files under src', () => {
    expect(editablePath('src/main/tools/clock.ts')).toBe(true)
    expect(editablePath('package.json')).toBe(false)
    expect(editablePath('src/../secrets.ts')).toBe(false)
  })

  it('refuses a live trading address and an auto-reload in new code', () => {
    expect(contentProblems('src/x.ts', 'fetch("https://api.alpaca.markets/v2/orders")').length).toBeGreaterThan(0)
    expect(contentProblems('src/x.ts', 'app.relaunch()').length).toBeGreaterThan(0)
    expect(contentProblems('src/x.ts', 'export const ok = 1').length).toBe(0)
  })

  it('refuses a plan that touches a protected file', () => {
    const plan = parsePlan(JSON.stringify({ summary: 's', edits: [{ file: 'src/main/services/authorization.ts', find: 'a', replace: 'b' }] }))
    expect(planProblems(plan).join(' ')).toContain('protected')
  })
})

describe('broker risk rules', () => {
  const limits: RiskLimitsView = { maxPositionPct: 10, maxOpenPositions: 2, maxOrderNotional: 500, dailyLossPct: 3 }
  const state = { liveEnabled: false, halted: false, haltReason: null, haltedOn: null, lossHaltDay: null, updatedAt: '' }
  const base = { mode: 'paper' as const, symbol: 'AAPL', side: 'buy' as const, estimatedNotional: 100, equity: 10000, dayPnlPct: 0, existingPositionValue: 0, openPositionCount: 0 }

  it('passes a small order', () => {
    expect(riskRefusals(base, limits, state)).toHaveLength(0)
  })

  it('refuses over the per-order limit', () => {
    expect(riskRefusals({ ...base, estimatedNotional: 600 }, limits, state).join(' ')).toContain('per-order limit')
  })

  it('refuses a live order while live trading is off', () => {
    expect(riskRefusals({ ...base, mode: 'live' }, limits, state).join(' ')).toContain('live trading is switched off')
  })

  it('refuses after the daily loss limit', () => {
    expect(riskRefusals({ ...base, dayPnlPct: -3.5 }, limits, state).join(' ')).toContain('daily loss limit')
  })

  it('refuses when the kill switch is on', () => {
    expect(riskRefusals(base, limits, { ...state, halted: true, haltReason: 'manual stop' }).join(' ')).toContain('kill switch')
  })

  it('refuses a new symbol beyond the position-count limit', () => {
    expect(riskRefusals({ ...base, openPositionCount: 2 }, limits, state).join(' ')).toContain('positions')
  })
})
