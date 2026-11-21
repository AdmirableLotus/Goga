import { describe, expect, it } from 'vitest'
import type { ProgramImport, ScopeAsset } from '../../../shared/security'
import type { ProgramEntryBar } from '../../../shared/security'
import { automationRule, bountyPreview, buildBountyGoal, declarableHost, inScopeHosts } from '../security/bounty'

/**
 * The bounty run builder is the handoff from "a program is selected" to "a watched run is
 * going". Its one safety-critical job is to offer for declaration ONLY hosts the pure scope
 * checker confirms are in scope — never more. These cases pin that down: a wildcard reduces
 * to its apex, a deny rule is left out, a path-bearing URL whose apex is not itself covered is
 * left out, and a CIDR is not auto-declared.
 */

function asset(identifier: string, eligible: boolean, assetType = 'URL'): ScopeAsset {
  return { identifier, assetType, eligibleForSubmission: eligible, eligibleForBounty: eligible, maxSeverity: null, instruction: null }
}

function program(assets: ScopeAsset[], exclusions: { category: string; details: string }[] = []): ProgramImport {
  return {
    id: 'p1', source: 'hackerone', handle: 'acme', name: 'Acme',
    url: 'https://hackerone.com/acme', importedAt: '2026-11-17T00:00:00.000Z',
    policy: '', submissionState: 'open', offersBounties: true,
    assets, exclusions, skipped: [], notes: '',
  }
}

describe('declarableHost', () => {
  it('reduces a leading wildcard to its apex', () => {
    expect(declarableHost(asset('*.acme.com', true, 'wildcard'))).toBe('acme.com')
  })
  it('pulls the host out of a URL and drops the path', () => {
    expect(declarableHost(asset('https://app.acme.com/login', true))).toBe('app.acme.com')
  })
  it('keeps a plain hostname and an IPv4', () => {
    expect(declarableHost(asset('api.acme.com', true))).toBe('api.acme.com')
    expect(declarableHost(asset('203.0.113.4', true, 'ip_address'))).toBe('203.0.113.4')
  })
  it('refuses a CIDR, an odd wildcard and a bare label', () => {
    expect(declarableHost(asset('10.0.0.0/24', true, 'cidr'))).toBeNull()
    expect(declarableHost(asset('status.*.acme.com', true, 'wildcard'))).toBeNull()
    expect(declarableHost(asset('localhost', true))).toBeNull()
  })
})

describe('inScopeHosts', () => {
  it('offers only hosts the scope checker confirms, de-duplicated', () => {
    const p = program([
      asset('*.acme.com', true, 'wildcard'),  // covers apex + subdomains
      asset('app.acme.com', true),            // duplicate host once reduced — collapses
      asset('https://evil.test/x', false),    // deny rule — must be excluded
    ])
    const hosts = inScopeHosts(p).map(h => h.host)
    expect(hosts).toContain('acme.com')
    expect(hosts).toContain('app.acme.com')
    expect(hosts).not.toContain('evil.test')
    // No host appears twice.
    expect(new Set(hosts).size).toBe(hosts.length)
  })

  it('leaves out a host the program lists but marks not eligible, even if a wildcard covers it', () => {
    const p = program([
      asset('*.acme.com', true, 'wildcard'),
      asset('status.acme.com', false),  // explicit deny beats the wildcard
    ])
    const hosts = inScopeHosts(p).map(h => h.host)
    expect(hosts).not.toContain('status.acme.com')
  })

  it('returns nothing for a program with no eligible, declarable hosts', () => {
    expect(inScopeHosts(program([asset('10.0.0.0/24', true, 'cidr')]))).toEqual([])
  })
})

describe('buildBountyGoal', () => {
  it('names the program, lists the declared hosts, and spells out the out-of-scope deny rules', () => {
    const p = program([asset('*.acme.com', true, 'wildcard'), asset('internal.acme.com', false)])
    const goal = buildBountyGoal(p, inScopeHosts(p))
    expect(goal).toContain('Acme')
    expect(goal).toContain('acme.com')
    expect(goal).toContain('OUT OF SCOPE')
    expect(goal).toContain('internal.acme.com')
    expect(goal).toContain('security.addFinding')
  })

  it('tells the run to stop and ask before declaring a new host', () => {
    const goal = buildBountyGoal(program([asset('*.acme.com', true, 'wildcard')]), [])
    expect(goal.toLowerCase()).toContain('stop and ask')
  })

  it('threads a focus note through when given', () => {
    const goal = buildBountyGoal(program([asset('*.acme.com', true, 'wildcard')]), [], 'the checkout flow')
    expect(goal).toContain('the checkout flow')
  })
})

/* A Cantina-shaped program: eligible web assets plus an entry bar that states an automated-
 * testing rule. The run must surface that rule, gate launch on acknowledging it, and carry it
 * into the goal. */
const CANTINA_RULE = 'Please be extremely cautious when performing any automated scans or tests that involve multiple requests.'

function entryBar(automatedTestingRule: string | null): ProgramEntryBar {
  return {
    kycRequired: false, kycQuote: null, depositUsd: null, findingsSubmitted: null, liveSince: null,
    assetCount: 1, scopeKind: 'web', automatedTestingRule, topReward: '$5,000', rewards: [],
    entry: { level: 'open', why: 'web scope, no deposit stated' },
  }
}

function cantinaProgram(rule: string | null) {
  return { ...program([asset('https://cantina.xyz', true), asset('https://cantina.security', true)]), source: 'cantina' as const, name: 'Cantina Bug Bounty Program', entryBar: entryBar(rule) }
}

describe('automationRule', () => {
  it('returns the program\'s stated automated-testing rule', () => {
    expect(automationRule(cantinaProgram(CANTINA_RULE))).toBe(CANTINA_RULE)
  })
  it('is null when the program states no such rule', () => {
    expect(automationRule(cantinaProgram(null))).toBeNull()
    expect(automationRule(program([asset('*.acme.com', true, 'wildcard')]))).toBeNull()
  })
})

describe('bountyPreview', () => {
  it('reports the in-scope hosts, the automated-testing rule, and that it needs acknowledgement', () => {
    const p = bountyPreview(cantinaProgram(CANTINA_RULE))
    expect(p.program.source).toBe('cantina')
    expect(p.hosts.map(h => h.host)).toContain('cantina.xyz')
    expect(p.automatedTestingRule).toBe(CANTINA_RULE)
    expect(p.requiresAck).toBe(true)
  })
  it('does not require acknowledgement for a program with no automation rule', () => {
    expect(bountyPreview(cantinaProgram(null)).requiresAck).toBe(false)
  })
  it('lists out-of-scope deny rules', () => {
    const p = { ...cantinaProgram(null), assets: [asset('https://cantina.xyz', true), asset('https://admin.cantina.xyz', false)] }
    expect(bountyPreview(p).outOfScope).toContain('https://admin.cantina.xyz')
  })
})

describe('buildBountyGoal with an automation rule', () => {
  it('carries the program\'s automated-testing rule and tells the run to go low and slow', () => {
    const goal = buildBountyGoal(cantinaProgram(CANTINA_RULE), inScopeHosts(cantinaProgram(CANTINA_RULE)))
    expect(goal).toContain('RESTRICTS AUTOMATED TESTING')
    expect(goal).toContain(CANTINA_RULE)
    expect(goal.toLowerCase()).toContain('low and slow')
  })
  it('says nothing about automation limits when the program states none', () => {
    const goal = buildBountyGoal(cantinaProgram(null), [])
    expect(goal).not.toContain('RESTRICTS AUTOMATED TESTING')
  })
})
