import { describe, expect, it, vi, beforeAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ProgramImport, ScopeAsset } from '../../../shared/security'
import { assetCovers, decideScope, denyRules, hostMatches, parseTarget } from '../security/scope'

/**
 * The scope checker is the only thing standing between an imported program and a request
 * against somebody's production host, so these cases are hand-checked against how a
 * program page actually reads:
 *
 *   - an asset the program marks NOT eligible for submission is a deny rule;
 *   - that deny beats a wildcard elsewhere in the same program;
 *   - a sibling the program does allow is still allowed;
 *   - a program exclusion still refuses an in-scope target.
 *
 * The Coinbase case is the one that was wrong: `status.coinbase.com` is listed by the
 * program as not eligible, and `*.coinbase.com` is listed as eligible. The wildcard must
 * not win.
 */

function asset(identifier: string, eligible: boolean, assetType = 'URL'): ScopeAsset {
  return { identifier, assetType, eligibleForSubmission: eligible, eligibleForBounty: eligible, maxSeverity: null, instruction: null }
}

function program(assets: ScopeAsset[], exclusions: { category: string; details: string }[] = []): ProgramImport {
  return {
    id: 'p1', source: 'hackerone', handle: 'coinbase', name: 'Coinbase',
    url: 'https://hackerone.com/coinbase', importedAt: '2026-11-11T00:00:00.000Z',
    policy: '', submissionState: 'open', offersBounties: true,
    assets, exclusions, skipped: [], notes: '',
  }
}

describe('host matching', () => {
  it('treats a bare host as an exact match', () => {
    expect(hostMatches('status.coinbase.com', 'status.coinbase.com')).toBe(true)
    expect(hostMatches('status.coinbase.com', 'www.coinbase.com')).toBe(false)
    expect(hostMatches('status.coinbase.com', 'status.coinbase.com.evil.test')).toBe(false)
  })

  it('lets a leading wildcard cover the apex and any depth below it', () => {
    expect(hostMatches('*.coinbase.com', 'coinbase.com')).toBe(true)
    expect(hostMatches('*.coinbase.com', 'www.coinbase.com')).toBe(true)
    expect(hostMatches('*.coinbase.com', 'a.b.coinbase.com')).toBe(true)
    expect(hostMatches('*.coinbase.com', 'notcoinbase.com')).toBe(false)
    expect(hostMatches('*.coinbase.com', 'coinbase.com.evil.test')).toBe(false)
  })

  it('matches a wildcard in a middle label', () => {
    expect(hostMatches('status.*.coinbase.com', 'status.api.coinbase.com')).toBe(true)
    expect(hostMatches('status.*.coinbase.com', 'status.coinbase.com')).toBe(false)
    // A deny rule is deliberately greedy: it must not miss a deeper host.
    expect(hostMatches('status.*.coinbase.com', 'status.a.b.coinbase.com', { deny: true })).toBe(true)
  })
})

describe('the ineligible-asset deny rule', () => {
  const coinbase = program([
    asset('*.coinbase.com', true),
    asset('status.coinbase.com', false),
    asset('status.*.coinbase.com', false, 'WILDCARD'),
    asset('*.cbhq.net', true),
  ])

  it('denies an ineligible exact host', () => {
    const d = decideScope(coinbase, 'https://status.coinbase.com/incidents')
    expect(d.inScope).toBe(false)
    expect(d.undetermined).toBe(false)
    expect(d.matchedRule).toBe('status.coinbase.com')
    expect(d.reason).toContain('NOT eligible for submission')
  })

  it('denies an ineligible host even though a parent wildcard is in scope', () => {
    // The wildcard alone would allow this host; the deny rule has to be decided first.
    const wildcardOnly = program([asset('*.coinbase.com', true)])
    expect(decideScope(wildcardOnly, 'https://status.coinbase.com/').inScope).toBe(true)

    const d = decideScope(coinbase, 'https://status.coinbase.com/')
    expect(d.inScope).toBe(false)
    expect(d.matchedRule).toBe('status.coinbase.com')
  })

  it('denies a host under an ineligible wildcard', () => {
    const d = decideScope(coinbase, 'https://status.api.coinbase.com/')
    expect(d.inScope).toBe(false)
    expect(d.matchedRule).toBe('status.*.coinbase.com')
  })

  it('still allows an in-scope sibling', () => {
    const d = decideScope(coinbase, 'https://www.coinbase.com/prices')
    expect(d.inScope).toBe(true)
    expect(d.matchedRule).toBe('*.coinbase.com')
  })

  it('still allows a host in a different eligible wildcard', () => {
    expect(decideScope(coinbase, 'https://app.cbhq.net/').inScope).toBe(true)
  })

  it('denies a host the program lists as not eligible with no wildcard anywhere', () => {
    const p = program([asset('api.example.com', true), asset('admin.example.com', false)])
    expect(decideScope(p, 'https://admin.example.com/').inScope).toBe(false)
    expect(decideScope(p, 'https://api.example.com/').inScope).toBe(true)
  })

  it('denies an ineligible CIDR and an ineligible IP', () => {
    const p = program([asset('10.0.0.0/8', false, 'CIDR'), asset('203.0.113.9', false, 'IP_ADDRESS'), asset('203.0.113.0/24', true, 'CIDR')])
    expect(decideScope(p, 'https://10.1.2.3/').inScope).toBe(false)
    expect(decideScope(p, 'https://203.0.113.9/').inScope).toBe(false)
    expect(decideScope(p, 'https://203.0.113.10/').inScope).toBe(true)
  })

  it('denies an ineligible host whatever path the deny rule lists', () => {
    const p = program([asset('*.example.com', true), asset('https://app.example.com/admin', false)])
    expect(decideScope(p, 'https://app.example.com/admin/users').inScope).toBe(false)
    // The deny is on the host, so a different path on that host is denied too.
    expect(decideScope(p, 'https://app.example.com/public').inScope).toBe(false)
  })

  it('lists the deny rules an import kept', () => {
    expect(denyRules(coinbase)).toEqual(['status.coinbase.com', 'status.*.coinbase.com'])
  })
})

describe('the rest of the decision order', () => {
  it('refuses a target no eligible asset covers', () => {
    const d = decideScope(program([asset('*.coinbase.com', true)]), 'https://example.org/')
    expect(d.inScope).toBe(false)
    expect(d.undetermined).toBe(true)
  })

  it('refuses when no program is imported', () => {
    expect(decideScope(null, 'https://www.coinbase.com/').inScope).toBe(false)
  })

  it('still refuses an in-scope target when the program excludes the technique', () => {
    const p = program([asset('*.coinbase.com', true)], [{ category: 'Automated scanners', details: 'No automated vulnerability scanners.' }])
    expect(decideScope(p, 'https://www.coinbase.com/', 'automated scanner').inScope).toBe(false)
    expect(decideScope(p, 'https://www.coinbase.com/', 'manual review').inScope).toBe(true)
  })

  it('keeps a path-bearing eligible asset to its path', () => {
    const p = program([asset('https://app.example.com/api', true)])
    expect(decideScope(p, 'https://app.example.com/api/v1/users').inScope).toBe(true)
    expect(decideScope(p, 'https://app.example.com/admin').inScope).toBe(false)
  })

  it('parses a bare hostname as https', () => {
    expect(parseTarget('www.coinbase.com').scheme).toBe('https')
    expect(parseTarget('www.coinbase.com').host).toBe('www.coinbase.com')
  })

  it('reports why an asset does not cover a host', () => {
    const r = assetCovers('*.coinbase.com', 'URL', parseTarget('https://example.org/'))
    expect(r.covers).toBe(false)
    expect(r.why).toContain('not under')
  })
})

/**
 * The importer half of the same defect: `structured_scopes` entries with
 * `eligible_for_submission: false` used to be dropped, which is what let the wildcard win.
 * They must arrive in the imported program as deny rules.
 */
describe('the HackerOne importer keeps ineligible assets as deny rules', () => {
  const tmp = path.join(os.tmpdir(), `goga-h1-import-test-${process.pid}`)

  beforeAll(() => {
    fs.mkdirSync(tmp, { recursive: true })
    vi.doMock('electron', () => ({
      app: { getPath: () => tmp },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s: string) => Buffer.from(s, 'utf8'),
        decryptString: (b: Buffer) => b.toString('utf8'),
      },
    }))
  })

  it('imports status.coinbase.com as a deny rule and denies it', async () => {
    const { saveCredentials, importHackerOne } = await import('../security/programs')
    saveCredentials('hackerone', 'admirablelotus', 'test-token-not-real')

    const scopePage = {
      data: [
        { attributes: { asset_identifier: '*.coinbase.com', asset_type: 'URL', eligible_for_submission: true, eligible_for_bounty: true, max_severity: 'critical' } },
        { attributes: { asset_identifier: 'status.coinbase.com', asset_type: 'URL', eligible_for_submission: false, eligible_for_bounty: false } },
        { attributes: { asset_identifier: 'status.*.coinbase.com', asset_type: 'WILDCARD', eligible_for_submission: false, eligible_for_bounty: false } },
      ],
    }
    const fakeFetch = (async (url: string) => {
      const body = String(url).includes('structured_scopes')
        ? scopePage
        : String(url).includes('scope_exclusions')
          ? { data: [] }
          : { data: { attributes: { name: 'Coinbase', submission_state: 'open', offers_bounties: true } } }
      return { status: 200, ok: true, text: async () => JSON.stringify(body) } as unknown as Response
    }) as unknown as typeof fetch

    const imported = await importHackerOne('coinbase', fakeFetch)
    expect(imported.assets.map(a => a.identifier)).toContain('status.coinbase.com')
    expect(imported.assets.find(a => a.identifier === 'status.coinbase.com')?.eligibleForSubmission).toBe(false)
    expect(imported.skipped.join(' ')).toContain('status.coinbase.com')

    const asProgram: ProgramImport = { ...imported, id: 'x', importedAt: '2026-11-11T00:00:00.000Z' }
    expect(decideScope(asProgram, 'https://status.coinbase.com/').inScope).toBe(false)
    expect(decideScope(asProgram, 'https://www.coinbase.com/').inScope).toBe(true)
  })
})
