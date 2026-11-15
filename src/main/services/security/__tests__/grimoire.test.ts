import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * Grimoire tests.
 *
 * Four things are asserted here, and each one is a claim the feature makes about itself:
 *
 *   1. the validator can refuse — "cannot be confirmed from what we have" — and the item is
 *      dropped rather than softened into a finding;
 *   2. the specialists and the review engine have no way to reach a network, proven by running
 *      a review with a global fetch installed and watching it never be called;
 *   3. a finding that fails the seven-question gate is recorded dead, and a later run does not
 *      raise it again;
 *   4. a Cantina import produces a program whose entry-bar fields are populated from the page.
 */

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-grimoire-test-'))

vi.mock('electron', () => ({
  app: { getPath: () => userData, isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
}))

import { validate, applyValidation } from '../grimoire/validator'
import { runReview } from '../grimoire/review'
import { SPECIALISTS, GATE_QUESTIONS } from '../grimoire/specialists'
import { memoryEntries, memorySummary, alreadySettled } from '../grimoire/memory'
import { parseCantinaBountyPage, importCantina } from '../cantina'
import type { Hypothesis } from '../../../../shared/grimoire'

function hypothesis(over: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: 'h1',
    specialist: 'xss',
    key: 'local#L1::xss',
    title: 'XSS: unescaped echo at file.php:1',
    location: 'file.php',
    line: 1,
    excerpt: 'echo $_GET["q"];',
    argument: 'a variable is written to output without an escaping call',
    ifTrue: 'The line that writes the value out, and the escaping call it does not have.',
    impact: 'medium',
    state: 'hypothesis',
    validation: { outcome: 'cannot-confirm', observable: null, observableAt: null, wouldConfirm: [], why: 'not yet validated', check: 'not yet run' },
    seenBefore: false,
    firstSeen: null,
    ...over,
  }
}

/* ───────────────────────── 1. the validator's refusal ───────────────────────── */

describe('the independent validator', () => {
  it('refuses to confirm when the material does not settle the question', () => {
    // A line that writes output, but nothing around it shows a request value reaching it.
    const material = [
      '<?php',
      '$label = "Total";',
      'echo $label;',
      '?>',
    ].join('\n')

    const verdict = validate({ specialist: 'xss', line: 3, excerpt: 'echo $label;', material, location: 'file.php' })

    expect(verdict.outcome).toBe('cannot-confirm')
    expect(verdict.observable).toBeNull()
    expect(verdict.why).toMatch(/nothing in the surrounding code shows the value coming from a request/i)
    // The refusal still tells the user what would settle it.
    expect(verdict.wouldConfirm.length).toBeGreaterThan(0)
    expect(verdict.check).toMatch(/escaping call/i)
  })

  it('drops a hypothesis it cannot confirm, rather than softening it', () => {
    const material = ['<?php', '$label = "Total";', 'echo $label;', '?>'].join('\n')
    const h = hypothesis({ line: 3, excerpt: 'echo $label;' })
    const applied = applyValidation(h, material)

    expect(applied.state).toBe('dropped')
    expect(applied.validation.outcome).toBe('cannot-confirm')
    // It is still in the record — dropped, not deleted.
    expect(applied.title).toBe(h.title)
  })

  it('refutes correct code instead of flagging it', () => {
    const material = ['<?php', 'echo esc_html( $_GET["q"] );', '?>'].join('\n')
    const verdict = validate({ specialist: 'xss', line: 2, excerpt: 'echo esc_html( $_GET["q"] );', material, location: 'file.php' })

    expect(verdict.outcome).toBe('refuted')
    expect(verdict.why).toMatch(/escaping or sanitising call/i)
  })

  it('confirms only when the confirming observable is actually present', () => {
    const material = ['<?php', 'echo $_GET["q"];', '?>'].join('\n')
    const verdict = validate({ specialist: 'xss', line: 2, excerpt: 'echo $_GET["q"];', material, location: 'file.php' })

    expect(verdict.outcome).toBe('confirmed-observable')
    expect(verdict.observable).toContain('echo')
    expect(verdict.observableAt).toBe('file.php:2')
    // Even a confirmation says it is not a finding yet.
    expect(verdict.why).toMatch(/does not make it a finding yet/i)
  })

  it('refuses to confirm PII from a comment line', () => {
    // The real false positive: a docblock describing an IP helper mentions "address", and the
    // validator used to confirm it as personal data exposure.
    const material = [
      '<?php',
      'class WP_Http {',
      '\t/**',
      '\t * @param string $maybe_ip A suspected IP address.',
      '\t * @return int|false Upon success, 4 or 6 to represent an IPv4 or IPv6 address.',
      '\t */',
      '\tpublic static function is_ip_address( $maybe_ip ) {',
      '\t\treturn preg_match( "/^\\d{1,3}/", $maybe_ip );',
      '\t}',
      '}',
    ].join('\n')

    const verdict = validate({
      specialist: 'pii', line: 5,
      excerpt: '@return int|false Upon success, 4 or 6 to represent an IPv4 or IPv6 address.',
      material, location: 'class-wp-http.php',
    })

    expect(verdict.outcome).toBe('cannot-confirm')
    expect(verdict.why).toMatch(/comment or a docblock/i)
  })

  it('refuses to confirm PII where nothing returns or prints the fields', () => {
    const material = [
      '<?php',
      '$user_email = "someone@example.com";',
      '$phone = "555";',
      '// nothing is returned or printed here',
    ].join('\n')
    const verdict = validate({ specialist: 'pii', line: 2, excerpt: '$user_email = "someone@example.com";', material, location: 'x.php' })
    expect(verdict.outcome).toBe('cannot-confirm')
  })

  it('never confirms recon, because a map is not a defect', () => {
    const verdict = validate({ specialist: 'recon', line: 1, excerpt: 'register_rest_route(...)', material: 'register_rest_route(...)', location: 'file.php' })
    expect(verdict.outcome).toBe('cannot-confirm')
    expect(verdict.why).toMatch(/map, not a defect/i)
  })
})

/* ───────────────────────── 2. no network, ever ───────────────────────── */

describe('the specialists and the review engine', () => {
  const realFetch = globalThis.fetch
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn(() => { throw new Error('a review must never reach the network') })
    globalThis.fetch = fetchSpy as unknown as typeof fetch
  })

  afterEach(() => { globalThis.fetch = realFetch })

  it('runs a full review without calling fetch once', () => {
    const material = [
      '<?php',
      '$id = $_GET["id"];',
      '$post = get_post( $id );',
      'echo $post->post_title;',
      '$wpdb->query( "DELETE FROM t WHERE id = $id" );',
      '?>',
    ].join('\n')

    const run = runReview({ text: material, location: 'wp-content/plugins/x/x.php', material: 'code_audit' })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(run.reviews.length).toBe(SPECIALISTS.length)
    expect(run.guarantee).toMatch(/Nothing in this review contacted a target/i)
  })

  it('has no network client in its import list', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'grimoire', 'review.ts'), 'utf8')
    const imports = [...source.matchAll(/^import .*?from '([^']+)'/gm)].map(m => m[1])
    for (const spec of imports) {
      expect(spec).not.toMatch(/^(node:)?(http|https|net|dns|tls|child_process)$/)
    }
    // And no bare fetch call anywhere in the engine.
    expect(source).not.toMatch(/\bfetch\s*\(/)
  })

  it('reports the ORIGINAL file line for a hit, not the line of the sample', () => {
    // A long file whose interesting line sits well past the 1500-character head, so it is only
    // in the sample by way of a keyword neighbourhood. The hit must still name its real line.
    // Long enough to cross the 4000-character sampling threshold, so this really is a sample.
    const filler = Array.from({ length: 300 }, (_, i) => `// filler line ${i + 1} padding padding`).join('\n')
    const material = `${filler}\n$id = $_GET["id"];\necho $id;\n`
    const realLine = material.split('\n').findIndex(l => l.includes('echo $id')) + 1

    const run = runReview({ text: material, location: 'long.php', material: 'code_audit' })
    expect(run.sample.sampled).toBe(true)

    const echoHit = run.hypotheses.find(h => h.excerpt.includes('echo $id'))
    expect(echoHit, 'the echo line should be raised or explicitly dropped').toBeTruthy()
    expect(echoHit!.line).toBe(realLine)
    // The excerpt is the original line, not a fragment from the sample's reassembly.
    expect(echoHit!.excerpt).toBe('echo $id;')
  })

  it('never attributes a hit to a line the specialists did not see', () => {
    const filler = Array.from({ length: 300 }, (_, i) => `// padding ${i + 1} padding padding`).join('\n')
    const run = runReview({ text: `${filler}\n$u = $_POST["u"];\necho $u;\n`, location: 'p.php', material: 'code_audit' })
    const lines = run.hypotheses.map(h => h.line)
    const totalLines = 302
    for (const l of lines) {
      expect(l).toBeGreaterThan(0)
      expect(l).toBeLessThanOrEqual(totalLines)
    }
  })

  it('produces hypotheses, never findings', () => {
    const run = runReview({ text: '<?php echo $_GET["q"]; ?>', location: 'a.php', material: 'code_audit' })
    for (const h of run.hypotheses) {
      expect(['hypothesis', 'dropped']).toContain(h.state)
    }
    expect(run.modelSecondOpinion.used).toBe(false)
  })
})

/* ───────────────────────── 3. the seven-question gate ───────────────────────── */

describe('the seven-question gate', () => {
  it('has seven questions, and the first four are the fatal ones', () => {
    expect(GATE_QUESTIONS).toHaveLength(7)
    expect(GATE_QUESTIONS.slice(0, 4).map(q => q.id)).toEqual(['observed', 'scope', 'attacker', 'impact'])
  })

  it('marks a failing finding dead, and a later run does not raise it again', async () => {
    // Register the real handlers against a captured ipcMain, then drive the gate through them.
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const electron = await import('electron')
    ;(electron.ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) },
    )
    const { registerGrimoireHandlers } = await import('../../../handlers/grimoire')
    registerGrimoireHandlers(electron.ipcMain as never)

    const decide = handlers.get('grimoire:gateDecide')!
    expect(decide).toBeTypeOf('function')

    const h = hypothesis({ key: 'local#L9::xss', title: 'XSS: unescaped echo at gate.php:9', location: 'gate.php', line: 9 })

    // Record it first, the way a review run would, so there is something to mark dead.
    const { remember } = await import('../grimoire/memory')
    remember({
      key: h.key, programId: 'prog-1', programName: 'Test program', specialist: 'xss',
      title: h.title, location: h.location, outcome: 'raised', reason: 'raised by a review',
    })

    // Answer "no" to the first question: the user did not see it happen.
    const answers = GATE_QUESTIONS.map(q => ({
      questionId: q.id,
      answer: (q.id === 'observed' ? 'no' : 'yes') as 'yes' | 'no',
      note: '',
    }))
    const result = await decide({}, { hypothesis: h, answers }) as { outcome: string; killedBy: string | null }

    expect(result.outcome).toBe('fail')
    expect(result.killedBy).toBe(GATE_QUESTIONS[0].question)

    // It is recorded dead, with the reason.
    const entry = memoryEntries('prog-1').find(e => e.key === h.key)
    expect(entry?.outcome).toBe('dead')
    expect(entry?.reason).toMatch(/failed the gate/i)

    // And a later run recognises it as settled, so it is not re-argued.
    expect(alreadySettled(h.key)?.outcome).toBe('dead')

    const summary = memorySummary('prog-1')
    expect(summary.dead).toBeGreaterThanOrEqual(1)
  })

  it('records a dead finding even when no program was active at review time', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const electron = await import('electron')
    ;(electron.ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) },
    )
    const { registerGrimoireHandlers } = await import('../../../handlers/grimoire')
    registerGrimoireHandlers(electron.ipcMain as never)

    // A key that was never recorded by a review run, which is what a local-file review produces
    // when no program is active.
    const h = hypothesis({ key: 'local#L77::pii', title: 'PII at local.php:77', location: 'local.php', line: 77 })
    const answers = GATE_QUESTIONS.map(q => ({
      questionId: q.id,
      answer: (q.id === 'observed' ? 'no' : 'yes') as 'yes' | 'no',
      note: '',
    }))

    const result = await handlers.get('grimoire:gateDecide')!({}, { hypothesis: h, answers }) as { outcome: string }
    expect(result.outcome).toBe('fail')

    // The record exists, is dead, and carries the title — not a bare key.
    const entry = memoryEntries().find(e => e.key === h.key)
    expect(entry, 'a dead finding must be recorded, not silently dropped').toBeTruthy()
    expect(entry!.outcome).toBe('dead')
    expect(entry!.title).toBe(h.title)
    expect(alreadySettled(h.key)?.outcome).toBe('dead')
  })

  it('passes a finding that answers all seven honestly', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const electron = await import('electron')
    ;(electron.ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) },
    )
    const { registerGrimoireHandlers } = await import('../../../handlers/grimoire')
    registerGrimoireHandlers(electron.ipcMain as never)

    const h = hypothesis({ key: 'local#L11::xss', title: 'XSS at pass.php:11', location: 'pass.php', line: 11 })
    const { remember } = await import('../grimoire/memory')
    remember({
      key: h.key, programId: 'prog-2', programName: 'Test program', specialist: 'xss',
      title: h.title, location: h.location, outcome: 'raised', reason: 'raised by a review',
    })

    const answers = GATE_QUESTIONS.map(q => ({ questionId: q.id, answer: 'yes' as const, note: '' }))
    const result = await handlers.get('grimoire:gateDecide')!({}, { hypothesis: h, answers }) as { outcome: string }

    expect(result.outcome).toBe('pass')
    expect(memoryEntries('prog-2').find(e => e.key === h.key)?.outcome).toBe('user-confirmed')
  })
})

/* ───────────────────────── 4. the Cantina import ───────────────────────── */

const CANTINA_PAGE = `
<html><body>
<h1>Cantina Bug Bounty Program</h1>
<p>Top reward</p><p>$5,000</p>
<p>This program does not require identity verification to join.</p>
<p>Deposit required</p><p>0</p>
<p>Findings submitted</p><p>1,204</p>
<p>In-scope assets</p><p>2</p>
<p>Please be extremely cautious when performing any automated scans or tests that involve multiple requests. Excessive traffic may be flagged as malicious activity.</p>
<p>https://cantina.xyz and its subdomains are eligible</p>
<p>https://cantina.security and its subdomains are eligible</p>
<h2>Out of scope</h2>
<ul>
  <li>Social engineering of Cantina staff or users</li>
  <li>Denial of service against production infrastructure</li>
</ul>
</body></html>
`

describe('the Cantina import', () => {
  it('reads the entry bar as fact from the page', () => {
    const parsed = parseCantinaBountyPage(CANTINA_PAGE, 'https://bounties.cantina.xyz/cantina/bug-bounty')

    expect(parsed.handle).toBe('cantina')
    expect(parsed.bar.kycRequired).toBe(false)
    expect(parsed.bar.kycQuote).toMatch(/does not require identity verification/i)
    expect(parsed.bar.depositUsd).toBe(0)
    expect(parsed.bar.findingsSubmitted).toBe(1204)
    expect(parsed.bar.topReward).toBe('$5,000')
    expect(parsed.bar.scopeKind).toBe('web')
    expect(parsed.bar.assetCount).toBeGreaterThan(0)
    expect(parsed.bar.automatedTestingRule).toMatch(/automated scans/i)
    // The assessment is labelled as an assessment, not as the program's own words.
    expect(parsed.bar.entry.why.length).toBeGreaterThan(0)
  })

  it('produces a program whose entry-bar fields are populated, through the real entry point', async () => {
    const http = vi.fn(async () => new Response(CANTINA_PAGE, { status: 200, headers: { 'content-type': 'text/html' } }))
    const imported = await importCantina('https://bounties.cantina.xyz/cantina/bug-bounty', http as unknown as typeof fetch)

    expect(http).toHaveBeenCalledTimes(1)
    expect(imported.source).toBe('cantina')
    expect(imported.assets.length).toBeGreaterThan(0)
    expect(imported.assets.every(a => a.eligibleForSubmission)).toBe(true)
    expect(imported.bar.kycRequired).toBe(false)
    expect(imported.bar.findingsSubmitted).toBe(1204)
    expect(imported.bar.topReward).toBe('$5,000')
    expect(imported.bar.scopeKind).toBe('web')
    expect(imported.notes).toMatch(/does not join the program/i)
  })

  it('refuses a host that is not Cantina', async () => {
    await expect(importCantina('https://example.com/bounties/abc', vi.fn() as unknown as typeof fetch))
      .rejects.toThrow(/not a Cantina host/i)
  })

  it('refuses to import a program with an empty scope', async () => {
    const http = vi.fn(async () => new Response('<html><body><p>nothing here</p></body></html>', { status: 200 }))
    await expect(importCantina('https://bounties.cantina.xyz/cantina/bug-bounty', http as unknown as typeof fetch))
      .rejects.toThrow(/no in-scope asset/i)
  })
})
