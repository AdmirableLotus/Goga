import { decideRobots } from '../osint/robots'
import { redact, redactDeep, luhn } from '../osint/redact'
import { siteKey, OsintHttp } from '../osint/http'
import { validDomain, validEmail, validUsername, SITES, EXCLUDED } from '../osint/sites'
import {
  aggregateProfile, domainRecon, gravatarHash, looksLikePersonName, parseRdapDomain, parseRdapIp,
  requirePurpose, reverseEmail, reverseUsername, type OsintContext,
} from '../osint/engine'
import { formatOsint } from '../osint/run'
import type { ProgramImport } from '../../../shared/security'

// ---------------------------------------------------------------- robots.txt

describe('robots.txt', () => {
  it('allows a path with no matching rule', () => {
    expect(decideRobots('User-agent: *\nDisallow: /private', '/public').verdict).toBe('allowed')
  })

  it('disallows a matching prefix', () => {
    expect(decideRobots('User-agent: *\nDisallow: /private', '/private/x').verdict).toBe('disallowed')
  })

  it('lets a longer Allow beat a shorter Disallow', () => {
    const text = 'User-agent: *\nDisallow: /a\nAllow: /a/b'
    expect(decideRobots(text, '/a/b/c').verdict).toBe('allowed')
    expect(decideRobots(text, '/a/c').verdict).toBe('disallowed')
  })

  it('prefers a group that names us over the wildcard group', () => {
    const text = 'User-agent: *\nDisallow: /\n\nUser-agent: GogaOSINT\nDisallow: /nothing'
    expect(decideRobots(text, '/profile', 'gogaosint').verdict).toBe('allowed')
  })

  it('handles wildcards and the end anchor', () => {
    const text = 'User-agent: *\nDisallow: /*/raw/\nDisallow: /*.json$'
    expect(decideRobots(text, '/user/repo/raw/file').verdict).toBe('disallowed')
    expect(decideRobots(text, '/api/thing.json').verdict).toBe('disallowed')
    expect(decideRobots(text, '/api/thing.json?x=1').verdict).toBe('allowed')
  })

  it('treats an empty Disallow as permission', () => {
    expect(decideRobots('User-agent: *\nDisallow:', '/anything').verdict).toBe('allowed')
  })
})

// ---------------------------------------------------------------- redaction

describe('redaction', () => {
  it('removes a password value', () => {
    const r = redact('username: ace password: hunter2 and more')
    expect(r.text).not.toContain('hunter2')
    expect(r.hits.some(h => h.kind === 'password')).toBe(true)
  })

  it('removes a card number that passes the check digit', () => {
    const r = redact('card 4111 1111 1111 1111 on file')
    expect(r.text).not.toContain('4111')
    expect(r.hits.some(h => h.kind === 'financial account number')).toBe(true)
  })

  it('leaves a long number that is not a card alone', () => {
    const r = redact('order 1234 5678 9012 3456 shipped')
    expect(r.text).toContain('1234')
  })

  it('removes a US SSN and a labelled passport number', () => {
    const r = redact('ssn 123-45-6789 passport no: X1234567')
    expect(r.text).not.toContain('123-45-6789')
    expect(r.text).not.toContain('X1234567')
    expect(r.hits.filter(h => h.kind === 'government identifier').length).toBeGreaterThan(0)
  })

  it('removes a health statement', () => {
    const r = redact('diagnosed with type 2 diabetes in 2019')
    expect(r.text).not.toContain('diabetes')
    expect(r.hits.some(h => h.kind === 'health data')).toBe(true)
  })

  it('redacts inside a nested object and keeps the shape', () => {
    const { value, hits } = redactDeep({ a: 'password: abc123', b: ['ok', 'ssn 111-22-3333'] })
    expect(value.a).not.toContain('abc123')
    expect(value.b[1]).not.toContain('111-22-3333')
    expect(hits.length).toBeGreaterThan(0)
  })

  it('checks Luhn correctly', () => {
    expect(luhn('4111111111111111')).toBe(true)
    expect(luhn('4111111111111112')).toBe(false)
  })
})

// ---------------------------------------------------------------- inputs

describe('input validation', () => {
  it('accepts a plain handle and strips a leading @', () => {
    expect(validUsername('@torvalds')).toBe('torvalds')
    expect(validUsername('a.b-c_d')).toBe('a.b-c_d')
  })

  it('refuses a handle with a slash or space', () => {
    expect(validUsername('a/b')).toBeNull()
    expect(validUsername('a b')).toBeNull()
  })

  it('accepts a domain and strips a scheme and path', () => {
    expect(validDomain('https://Example.com/path')).toBe('example.com')
    expect(validDomain('not a domain')).toBeNull()
  })

  it('accepts an address and refuses a bare word', () => {
    expect(validEmail('Someone@Example.com')).toBe('someone@example.com')
    expect(validEmail('someone')).toBeNull()
  })

  it('computes the Gravatar hash the way Gravatar does', () => {
    expect(gravatarHash('test@example.com')).toBe('55502f40dc8b7c769880b10874abc9d0')
  })

  it('recognises a person-shaped name but not a handle or address', () => {
    expect(looksLikePersonName('Jane Doe')).toBe(true)
    expect(looksLikePersonName('torvalds')).toBe(false)
    expect(looksLikePersonName('jane@example.com')).toBe(false)
  })

  it('keeps every listed site unambiguous and every exclusion explained', () => {
    for (const s of SITES) expect(s.about.length).toBeGreaterThan(10)
    for (const e of EXCLUDED) expect(e.reason.length).toBeGreaterThan(10)
  })

  it('groups hosts by site, including two-part suffixes', () => {
    expect(siteKey('api.github.com')).toBe('github.com')
    expect(siteKey('shop.example.co.uk')).toBe('example.co.uk')
  })
})

// ---------------------------------------------------------------- purpose gate

describe('purpose gate', () => {
  it('refuses a person-shaped subject with no purpose', () => {
    expect(() => requirePurpose('', 'a username search', true)).toThrow(/purpose/i)
  })

  it('refuses a placeholder purpose', () => {
    expect(() => requirePurpose('testing', 'a search', true)).toThrow(/not a purpose/i)
  })

  it('refuses a purpose too short to record', () => {
    expect(() => requirePurpose('check', 'a search', true)).toThrow(/too short/i)
  })

  it('accepts a real purpose', () => {
    expect(requirePurpose('authorised assessment for the Example program', 'a search', true)).toContain('authorised')
  })

  it('allows an empty purpose when it is not required', () => {
    expect(requirePurpose('', 'domain recon', false)).toBe('')
  })
})

// ---------------------------------------------------------------- RDAP parsing

describe('RDAP parsing', () => {
  it('reads registrar, dates, statuses and nameservers', () => {
    const body = JSON.stringify({
      ldhName: 'EXAMPLE.COM',
      status: ['client transfer prohibited'],
      nameservers: [{ ldhName: 'A.IANA-SERVERS.NET' }],
      events: [
        { eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' },
        { eventAction: 'expiration', eventDate: '2027-08-13T04:00:00Z' },
      ],
      entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Example Registrar']]] }],
    })
    const r = parseRdapDomain(body)
    expect(r.registrar).toBe('Example Registrar')
    expect(r.registeredAt).toContain('1995-08-14')
    expect(r.nameservers).toEqual(['A.IANA-SERVERS.NET'])
    expect(r.summary.join(' ')).toContain('client transfer prohibited')
  })

  it('returns an empty summary for unreadable input rather than inventing one', () => {
    expect(parseRdapDomain('<html>nope</html>').summary).toEqual([])
  })

  it('reads a network range and ASN', () => {
    const r = parseRdapIp(JSON.stringify({ name: 'GOOGLE', startAddress: '8.8.8.0', endAddress: '8.8.8.255', entities: [{ publicIds: [{ type: 'Autnum', identifier: '15169' }] }] }))
    expect(r.network).toBe('8.8.8.0 – 8.8.8.255')
    expect(r.asn).toBe('AS15169')
  })
})

// ---------------------------------------------------------------- engine, with a fake network

type Reply = { status: number | null; body?: string; error?: string | null; location?: string | null }

function fakeHttp(replies: (url: string) => Reply) {
  const seen: string[] = []
  const http = new OsintHttp({
    cacheFile: null,
    hostDelayMs: 0,
    fetchImpl: async (url: string) => {
      seen.push(url)
      const r = replies(url)
      return { status: r.status, location: r.location ?? null, body: r.body ?? '', error: r.error ?? null }
    },
  })
  return { http, seen }
}

const program = (over: Partial<ProgramImport> = {}): ProgramImport => ({
  id: 'p1', source: 'hackerone', handle: 'demo', name: 'Demo', url: 'https://hackerone.com/demo',
  importedAt: '2026-11-10T00:00:00.000Z', policy: '', submissionState: 'open', offersBounties: true,
  assets: [{ identifier: '*.example.com', assetType: 'wildcard', eligibleForSubmission: true, eligibleForBounty: true, maxSeverity: null, instruction: null }],
  exclusions: [], skipped: [], notes: '', ...over,
})

describe('reverse username', () => {
  it('separates found, absent and blocked, and never calls absence proof', async () => {
    const { http } = fakeHttp(url => {
      if (url.includes('github.com/torvalds')) return { status: 200, body: '<html>profile</html>' }
      if (url.includes('codeberg.org/torvalds')) return { status: 404 }
      if (url.includes('huggingface.co/torvalds')) return { status: 403 }
      if (url.includes('gitlab.com/api')) return { status: 200, body: '[]' }
      if (url.includes('registry.npmjs.org')) return { status: 200, body: '{"total":0}' }
      if (url.includes('hacker-news')) return { status: 200, body: 'null' }
      if (url.includes('hub.docker.com')) return { status: 200, body: '{"username":"torvalds"}' }
      return { status: 404 }
    })
    const ctx: OsintContext = { http, program: null, purpose: '' }
    const r = await reverseUsername('torvalds', ctx)
    expect(r.found.map(f => f.site)).toContain('GitHub')
    expect(r.absent.map(a => a.site)).toContain('Codeberg')
    expect(r.blocked.map(b => b.site)).toContain('Hugging Face')
    expect(r.mode).toBe('unattributed')
    expect(r.notes.some(n => /does not establish/.test(n.detail))).toBe(true)
    expect(r.checked.some(c => c.site === 'Reddit' && c.outcome === 'not_checked')).toBe(true)
    expect(r.found.every(f => !!f.readAt)).toBe(true)
  })

  it('sends a person-shaped subject to profile aggregation instead of checking it as a handle', async () => {
    const { http } = fakeHttp(() => ({ status: 404 }))
    await expect(reverseUsername('Jane Doe', { http, program: null, purpose: '' })).rejects.toThrow(/person's name/i)
  })

  it('refuses a handle with a path in it', async () => {
    const { http } = fakeHttp(() => ({ status: 404 }))
    await expect(reverseUsername('a/b', { http, program: null, purpose: '' })).rejects.toThrow(/not a username/i)
  })
})

describe('reverse email', () => {
  it('reads a Gravatar profile and its self-published links', async () => {
    const { http } = fakeHttp(url => {
      if (url.includes('gravatar.com/') && url.endsWith('.json')) {
        return {
          status: 200,
          body: JSON.stringify({ entry: [{ profileUrl: 'https://gravatar.com/beau', displayName: 'Beau Lebens', aboutMe: 'Builds things', accounts: [{ domain: 'github.com', display: 'beaulebens', url: 'https://github.com/beaulebens', verified: true }] }] }),
        }
      }
      if (url.includes('cloudflare-dns.com')) return { status: 200, body: JSON.stringify({ Status: 0, Answer: [{ data: '10 mail.example.com.' }] }) }
      if (url.includes('rdap.org/domain')) return { status: 200, body: JSON.stringify({ ldhName: 'EXAMPLE.COM', events: [{ eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' }] }) }
      return { status: 404 }
    })
    const r = await reverseEmail('beau@example.com', { http, program: null, purpose: 'checking my own address' })
    expect(r.gravatar.outcome).toBe('found')
    expect(r.gravatar.displayName).toBe('Beau Lebens')
    expect(r.gravatar.linkedAccounts[0].verified).toBe(true)
    expect(r.domainContext.hasMailRoute).toBe(true)
    expect(r.breach.checked).toBe(false)
    expect(r.breach.detail).toMatch(/no breach-check API key/i)
  })

  it('reports a missing Gravatar as a weak signal, not as proof', async () => {
    const { http } = fakeHttp(url => {
      if (url.includes('gravatar.com')) return { status: 404 }
      if (url.includes('cloudflare-dns.com')) return { status: 200, body: JSON.stringify({ Status: 0 }) }
      return { status: 404 }
    })
    const r = await reverseEmail('nobody@example.com', { http, program: null, purpose: 'checking an address I own' })
    expect(r.gravatar.outcome).toBe('absent')
    expect(r.gravatar.detail).toMatch(/weak signal/i)
    expect(r.domainContext.hasMailRoute).toBe(false)
  })

  it('reads a null MX as a refusal of mail, not as a working route', async () => {
    const { http } = fakeHttp(url => {
      if (url.includes('gravatar.com')) return { status: 404 }
      if (url.includes('cloudflare-dns.com')) return { status: 200, body: JSON.stringify({ Answer: [{ data: '0 .' }] }) }
      return { status: 404 }
    })
    const r = await reverseEmail('nobody@example.com', { http, program: null, purpose: 'checking an address I own' })
    expect(r.domainContext.hasMailRoute).toBe(false)
    expect(r.notes.some(n => /null MX/.test(n.detail))).toBe(true)
  })

  it('requires a purpose for an address', async () => {
    const { http } = fakeHttp(() => ({ status: 404 }))
    await expect(reverseEmail('a@b.com', { http, program: null, purpose: '' })).rejects.toThrow(/purpose/i)
  })
})

describe('domain recon', () => {
  it('refuses a domain the active program does not cover', async () => {
    const { http, seen } = fakeHttp(() => ({ status: 200, body: '{}' }))
    await expect(domainRecon('other.test', { http, program: program(), purpose: '' })).rejects.toThrow(/not covered/i)
    expect(seen).toHaveLength(0)
  })

  it('refuses a private or metadata host outright', async () => {
    const { http } = fakeHttp(() => ({ status: 200, body: '{}' }))
    await expect(domainRecon('169.254.169.254', { http, program: null, purpose: '' })).rejects.toThrow(/never/i)
  })

  it('collects registration, DNS and certificate names, and labels unattributed research', async () => {
    const { http } = fakeHttp(url => {
      if (url.includes('rdap.org/domain')) return { status: 200, body: JSON.stringify({ ldhName: 'EXAMPLE.COM', events: [{ eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' }], entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Reg Co']]] }] }) }
      if (url.includes('cloudflare-dns.com')) {
        if (url.includes('type=A')) return { status: 200, body: JSON.stringify({ Answer: [{ data: '93.184.216.34' }] }) }
        return { status: 200, body: JSON.stringify({ Answer: [] }) }
      }
      if (url.includes('crt.sh')) return { status: 200, body: JSON.stringify([{ name_value: 'www.example.com\napi.example.com' }, { name_value: '*.example.com' }]) }
      if (url.includes('rdap.org/ip')) return { status: 200, body: JSON.stringify({ name: 'EDGECAST', startAddress: '93.184.216.0', endAddress: '93.184.216.255' }) }
      return { status: 404 }
    })
    const r = await domainRecon('example.com', { http, program: null, purpose: '' })
    expect(r.registration.registrar).toBe('Reg Co')
    expect(r.subdomains.names).toEqual(['api.example.com', 'www.example.com'])
    expect(r.mode).toBe('unattributed')
    expect(r.notes.some(n => /unattributed public research/.test(n.detail))).toBe(true)
    expect(r.notes.some(n => /No ports were scanned/.test(n.detail))).toBe(true)
  })

  it('runs under a program when the domain is in scope', async () => {
    const { http } = fakeHttp(url => {
      if (url.includes('rdap.org/domain')) return { status: 200, body: JSON.stringify({ ldhName: 'EXAMPLE.COM' }) }
      if (url.includes('cloudflare-dns.com')) return { status: 200, body: JSON.stringify({ Answer: [] }) }
      return { status: 404 }
    })
    const r = await domainRecon('example.com', { http, program: program(), purpose: '' })
    expect(r.mode).toBe('program')
    expect(r.programName).toBe('Demo')
  })
})

describe('profile aggregation', () => {
  it('requires a purpose and collects only self-published data', async () => {
    const { http } = fakeHttp(url => {
      if (url.includes('api.github.com/users/torvalds')) return { status: 200, body: JSON.stringify({ html_url: 'https://github.com/torvalds', name: 'Linus Torvalds', bio: 'kernel', public_repos: 8 }) }
      if (url.includes('keybase.io')) return { status: 200, body: JSON.stringify({ them: [{ basics: { username: 'torvalds' }, proofs_summary: { all: [{ proof_type: 'twitter', human_url: 'https://twitter.com/x', state: 1 }] } }] }) }
      if (url.includes('hacker-news')) return { status: 200, body: 'null' }
      return { status: 404 }
    })
    const r = await aggregateProfile('torvalds', { http, program: null, purpose: 'checking my own public footprint' })
    expect(r.selfPublished.map(p => p.site)).toContain('GitHub')
    expect(r.facts.some(f => f.label.includes('GitHub bio'))).toBe(true)
    expect(r.selfPublished.some(p => p.site.includes('Keybase proof'))).toBe(true)
    expect(r.purpose).toContain('public footprint')
  })

  it('refuses with no purpose', async () => {
    const { http } = fakeHttp(() => ({ status: 404 }))
    await expect(aggregateProfile('torvalds', { http, program: null, purpose: '' })).rejects.toThrow(/purpose/i)
  })
})

describe('result text', () => {
  it('names the source and read time for every hit, and lists what was not checked', async () => {
    const { http } = fakeHttp(url => (url.includes('github.com/torvalds') ? { status: 200, body: 'x' } : { status: 404 }))
    const r = await reverseUsername('torvalds', { http, program: null, purpose: '' })
    const text = formatOsint('username', r as unknown as Record<string, unknown>)
    expect(text).toContain('GitHub')
    expect(text).toContain('read ')
    expect(text).toContain('Not checked')
    expect(text).toContain('unattributed public research')
  })
})
