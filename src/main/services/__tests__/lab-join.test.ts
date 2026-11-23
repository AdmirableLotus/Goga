import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Joining a source finding to a live attempt — the gates, in the order they run.
 *
 * Every test here fails in a way that matters if the code regresses:
 *
 *   1. an out-of-scope host is refused before any request object exists, and the deciding rule
 *      is named;
 *   2. a deny rule refuses the same way, and is not overridden by a wildcard elsewhere;
 *   3. no imported program refuses a public host outright;
 *   4. a payload or URL changed after approval is refused, and nothing is sent;
 *   5. the rate cap refuses the request that would exceed it;
 *   6. the kill switch stops a run mid-flight, including the request in hand;
 *   7. a marker that comes back in the page is recorded as a reflection, never as execution;
 *   8. a promotion carries the source evidence line all the way into the draft.
 */

const tmp = path.join(os.tmpdir(), `goga-join-${process.pid}`)
const securityFile = path.join(tmp, 'goga-security-store.json')
const targetsFile = path.join(tmp, 'goga-lab-targets.json')

const SINK_FILE = `<?php
$tag_name_value = isset( $_GET['name'] ) ? wp_unslash( $_GET['name'] ) : '';
?>
<td><input name="name" id="name" type="text" value="<?php echo $tag_name_value; ?>" /></td>
`

beforeAll(() => {
  fs.mkdirSync(tmp, { recursive: true })
  fs.writeFileSync(path.join(tmp, 'sink.php'), SINK_FILE)
  vi.doMock('electron', () => ({
    app: { getPath: () => tmp },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(s, 'utf8'),
      decryptString: (b: Buffer) => b.toString('utf8'),
    },
  }))
})

afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

beforeEach(() => {
  for (const f of [securityFile, targetsFile]) { try { fs.rmSync(f) } catch { /* fresh */ } }
})

/** Install one program into the store, as an import would. */
async function importProgram(opts: {
  name?: string
  assets?: { identifier: string; eligible: boolean }[]
  rewards?: { severity: string; amount: string }[]
} = {}) {
  const store = await import('../security/store')
  store.addProgram({
    source: 'cantina',
    handle: 'cantina',
    name: opts.name ?? 'Cantina Bug Bounty Program',
    url: 'https://bounties.cantina.xyz/cantina/bug-bounty',
    policy: '',
    submissionState: 'open',
    offersBounties: true,
    assets: (opts.assets ?? [{ identifier: 'https://cantina.xyz', eligible: true }]).map(a => ({
      identifier: a.identifier,
      assetType: 'URL',
      eligibleForSubmission: a.eligible,
      eligibleForBounty: a.eligible,
      maxSeverity: 'critical',
      instruction: null,
    })),
    exclusions: [],
    skipped: [],
    notes: '',
    entryBar: {
      kycRequired: false, kycQuote: null, depositUsd: null, findingsSubmitted: null,
      liveSince: null, assetCount: 1, scopeKind: 'web',
      automatedTestingRule: 'Excessive traffic may be flagged as malicious activity.',
      topReward: '$5,000',
      rewards: opts.rewards ?? [{ severity: 'Critical', amount: '$5,000' }, { severity: 'High', amount: '$2,000' }],
      entry: { level: 'open', why: 'test' },
    },
  })
}

/** A Brave driver that reports whatever the caller says, and counts visits. */
function fakeDriver(title: string, bodyText: string, state = 'open') {
  const visits: string[] = []
  return {
    visits,
    state: () => state,
    visit: async (url: string) => { visits.push(url); return { status: 200, title, bodyText } },
  }
}

describe('a public host is refused before any request object exists', () => {
  it('refuses an out-of-scope host and names the program as the decider', async () => {
    await importProgram({ assets: [{ identifier: 'https://cantina.xyz', eligible: true }] })
    const { prepareJoin } = await import('../lab/joinRun')
    const r = prepareJoin({
      root: tmp, file: 'sink.php',
      targetUrl: 'https://not-in-scope.example.com/search?q={payload}',
    })
    expect(r.ok).toBe(false)
    expect(r.attempt).toBeNull()
    expect(r.message).toMatch(/not in scope|out of scope/i)
    expect(r.message).toContain('not-in-scope.example.com')
    expect(r.message).toMatch(/nothing was prepared/i)
  })

  it('refuses when the host is on the program but marked NOT eligible — the deny rule is quoted', async () => {
    await importProgram({
      assets: [
        { identifier: '*.cantina.xyz', eligible: true },
        { identifier: 'status.cantina.xyz', eligible: false },
      ],
    })
    const { prepareJoin } = await import('../lab/joinRun')
    const r = prepareJoin({
      root: tmp, file: 'sink.php',
      targetUrl: 'https://status.cantina.xyz/search?q={payload}',
    })
    expect(r.ok).toBe(false)
    expect(r.attempt).toBeNull()
    // The deny rule wins even though the wildcard covers the same host.
    expect(r.message).toMatch(/deny rule/i)
    expect(r.message).toContain('status.cantina.xyz')
  })

  it('refuses a public host when no program is imported at all', async () => {
    const { prepareJoin } = await import('../lab/joinRun')
    const r = prepareJoin({
      root: tmp, file: 'sink.php',
      targetUrl: 'https://cantina.xyz/search?q={payload}',
    })
    expect(r.ok).toBe(false)
    expect(r.attempt).toBeNull()
    expect(r.message).toMatch(/no program is imported/i)
  })

  it('allows the local reproduction without a program or a declaration', async () => {
    const { prepareJoin } = await import('../lab/joinRun')
    const r = prepareJoin({
      root: tmp, file: 'sink.php',
      targetUrl: 'http://127.0.0.1:8080/sink?v={payload}',
    })
    expect(r.ok).toBe(true)
    expect(r.attempt?.authority.via).toBe('loopback')
  })
})

describe('one approval is bound to one exact request', () => {
  it('refuses a payload changed after approval, and sends nothing', async () => {
    await importProgram()
    const { prepareJoin, decideJoin, sendJoin } = await import('../lab/joinRun')
    const prepared = prepareJoin({ root: tmp, file: 'sink.php', targetUrl: 'https://cantina.xyz/s?q={payload}' })
    expect(prepared.ok).toBe(true)
    const id = prepared.attempt!.id
    expect(decideJoin(id, true).ok).toBe(true)

    // Change the payload after the user approved the request.
    const { payloadGate } = await import('../lab/payload')
    const held = payloadGate.peek(id)!.item
    held.payload = '<img src=x onerror="document.title=\'tampered\'">'

    const driver = fakeDriver('tampered', '')
    const result = await sendJoin(id, { driver })
    expect(result.sent).toBe(false)
    expect(result.executed).toBe(false)
    expect(result.caveat).toMatch(/changed/i)
    expect(driver.visits).toHaveLength(0)
  })

  it('refuses a URL changed after approval, and sends nothing', async () => {
    await importProgram()
    const { prepareJoin, decideJoin, sendJoin } = await import('../lab/joinRun')
    const prepared = prepareJoin({ root: tmp, file: 'sink.php', targetUrl: 'https://cantina.xyz/s?q={payload}' })
    const id = prepared.attempt!.id
    expect(decideJoin(id, true).ok).toBe(true)

    const { payloadGate } = await import('../lab/payload')
    payloadGate.peek(id)!.item.url = 'https://cantina.xyz/other?q=clean'

    const driver = fakeDriver('clean', '')
    const result = await sendJoin(id, { driver })
    expect(result.sent).toBe(false)
    expect(result.caveat).toMatch(/changed/i)
    expect(driver.visits).toHaveLength(0)
  })

  it('refuses a send that was never approved', async () => {
    await importProgram()
    const { prepareJoin, sendJoin } = await import('../lab/joinRun')
    const prepared = prepareJoin({ root: tmp, file: 'sink.php', targetUrl: 'https://cantina.xyz/s?q={payload}' })
    const driver = fakeDriver('nothing', '')
    const result = await sendJoin(prepared.attempt!.id, { driver })
    expect(result.sent).toBe(false)
    expect(result.caveat).toMatch(/not been approved/i)
    expect(driver.visits).toHaveLength(0)
  })
})

describe('the rate cap and the kill switch', () => {
  it('refuses to start above the fixed ceiling', async () => {
    await importProgram()
    const { checkJoinLimits, JOIN_CEILING } = await import('../lab/joinBudget')
    const above = checkJoinLimits({ maxRequests: JOIN_CEILING.maxRequests + 1, maxPerMinute: 1 })
    expect(above.ok).toBe(false)
    expect(above.reason).toMatch(/ceiling/i)
    const fast = checkJoinLimits({ maxRequests: 1, maxPerMinute: JOIN_CEILING.maxPerMinute + 1 })
    expect(fast.ok).toBe(false)
  })

  it('refuses a run whose limits are above the ceiling, before anything is prepared', async () => {
    await importProgram()
    const { prepareJoin } = await import('../lab/joinRun')
    const r = prepareJoin({
      root: tmp, file: 'sink.php', targetUrl: 'https://cantina.xyz/s?q={payload}',
      limits: { maxRequests: 999, maxPerMinute: 1 },
    })
    expect(r.ok).toBe(false)
    expect(r.attempt).toBeNull()
    expect(r.message).toMatch(/ceiling/i)
  })

  it('refuses the request that would exceed the total cap', async () => {
    const { JoinBudget } = await import('../lab/joinBudget')
    const budget = new JoinBudget({ maxRequests: 1, maxPerMinute: 6 })
    expect(await budget.spend()).toBeNull()
    expect(await budget.spend()).toBe('cap')
    expect(budget.requests).toBe(1)
  })

  it('paces to the per-minute rate instead of exceeding it', async () => {
    const { JoinBudget } = await import('../lab/joinBudget')
    let now = 0
    const waits: number[] = []
    const budget = new JoinBudget(
      { maxRequests: 10, maxPerMinute: 1 },
      () => now,
      async ms => { waits.push(ms); now += ms },
    )
    expect(await budget.spend()).toBeNull()
    // The second spend must wait out the minute window rather than go straight through.
    expect(await budget.spend()).toBeNull()
    expect(waits.length).toBe(1)
    expect(waits[0]).toBeGreaterThan(0)
  })

  it('the kill switch stops a run mid-flight and aborts the request in hand', async () => {
    await importProgram()
    const { prepareJoin, decideJoin, sendJoin, stopJoin } = await import('../lab/joinRun')
    const prepared = prepareJoin({ root: tmp, file: 'sink.php', targetUrl: 'https://cantina.xyz/s?q={payload}' })
    const id = prepared.attempt!.id
    expect(decideJoin(id, true).ok).toBe(true)

    const stopped = stopJoin(id)
    expect(stopped.ok).toBe(true)

    const driver = fakeDriver('never', '')
    const result = await sendJoin(id, { driver })
    expect(result.sent).toBe(false)
    expect(result.caveat).toMatch(/stopped/i)
    expect(driver.visits).toHaveLength(0)
  })

  it('the kill switch aborts the signal a live request is holding', async () => {
    const { JoinBudget } = await import('../lab/joinBudget')
    const budget = new JoinBudget({ maxRequests: 5, maxPerMinute: 5 })
    let aborted = false
    budget.signal.addEventListener('abort', () => { aborted = true })
    expect(budget.signal.aborted).toBe(false)
    budget.stop()
    expect(aborted).toBe(true)
    expect(await budget.spend()).toBe('stopped')
  })
})

describe('reflection is never execution', () => {
  it('records a marker that came back in the page as a reflection, and no finding', async () => {
    await importProgram()
    const { prepareJoin, decideJoin, sendJoin, buildJoinDraft } = await import('../lab/joinRun')
    const prepared = prepareJoin({ root: tmp, file: 'sink.php', targetUrl: 'https://cantina.xyz/s?q={payload}' })
    const id = prepared.attempt!.id
    expect(decideJoin(id, true).ok).toBe(true)

    // The page carries the marker and the payload text, but the title is untouched: the value
    // was reflected, and nothing ran.
    const marker = prepared.attempt!.marker
    const payload = prepared.attempt!.payload
    const driver = fakeDriver('Cantina', `You searched for: ${payload} ${marker}`)
    const result = await sendJoin(id, { driver })

    expect(result.sent).toBe(true)
    expect(result.reflected).toBe(true)
    expect(result.markerInBody).toBe(true)
    expect(result.executed).toBe(false)
    expect(result.confidence).toBe('observation')
    expect(result.observationContext).toMatch(/reflected, not executed/i)
    expect(result.caveat).toMatch(/reflection/i)

    // And a reflection cannot become a report.
    const draft = buildJoinDraft(id, { verifiedByUser: true })
    expect(draft.ok).toBe(false)
    expect(draft.draft).toBeNull()
    expect(draft.message).toMatch(/reflection cannot become a report/i)
  })

  it('records execution only when the title becomes the value only script could set', async () => {
    await importProgram()
    const { prepareJoin, decideJoin, sendJoin } = await import('../lab/joinRun')
    const prepared = prepareJoin({ root: tmp, file: 'sink.php', targetUrl: 'https://cantina.xyz/s?q={payload}' })
    const id = prepared.attempt!.id
    expect(decideJoin(id, true).ok).toBe(true)

    const expected = prepared.attempt!.expectedTitle
    const driver = fakeDriver(expected, '')
    const result = await sendJoin(id, { driver })
    expect(result.executed).toBe(true)
    expect(result.confidence).toBe('confirmed')
  })

  it('a title that merely resembles the nonce is not execution', async () => {
    await importProgram()
    const { prepareJoin, decideJoin, sendJoin } = await import('../lab/joinRun')
    const prepared = prepareJoin({ root: tmp, file: 'sink.php', targetUrl: 'https://cantina.xyz/s?q={payload}' })
    const id = prepared.attempt!.id
    expect(decideJoin(id, true).ok).toBe(true)
    const driver = fakeDriver('GOGA-WPXSS-', '')
    const result = await sendJoin(id, { driver })
    expect(result.executed).toBe(false)
  })

  it('refuses to send when the Brave session is not signed in, and says so', async () => {
    await importProgram()
    const { prepareJoin, decideJoin, sendJoin, NOT_SIGNED_IN } = await import('../lab/joinRun')
    const prepared = prepareJoin({ root: tmp, file: 'sink.php', targetUrl: 'https://cantina.xyz/s?q={payload}' })
    const id = prepared.attempt!.id
    expect(decideJoin(id, true).ok).toBe(true)
    const driver = fakeDriver('x', '', 'login-required')
    const result = await sendJoin(id, { driver })
    expect(result.sent).toBe(false)
    expect(result.caveat).toBe(NOT_SIGNED_IN)
    expect(driver.visits).toHaveLength(0)
  })
})

describe('the promotion keeps the source evidence line', () => {
  it('carries file, line, context and the evidence line into the attempt and the draft', async () => {
    await importProgram()
    const { prepareJoin, decideJoin, sendJoin, buildJoinDraft } = await import('../lab/joinRun')
    const prepared = prepareJoin({ root: tmp, file: 'sink.php', targetUrl: 'https://cantina.xyz/s?q={payload}' })
    expect(prepared.ok).toBe(true)
    const id = prepared.attempt!.id

    // The attempt already carries the line from source.
    expect(prepared.attempt!.source.file).toBe('sink.php')
    expect(prepared.attempt!.source.line).toBeGreaterThan(0)
    expect(prepared.attempt!.source.context).toMatch(/attribute/i)
    expect(prepared.attempt!.source.evidenceLine).toContain('sink.php:')

    expect(decideJoin(id, true).ok).toBe(true)
    const driver = fakeDriver(prepared.attempt!.expectedTitle, '')
    const result = await sendJoin(id, { driver })
    expect(result.executed).toBe(true)

    const draft = buildJoinDraft(id, { verifiedByUser: true })
    expect(draft.ok).toBe(true)
    expect(draft.draft!.sourceEvidence).toContain('sink.php, line')
    expect(draft.draft!.sourceEvidence).toContain('echo')
    expect(draft.draft!.liveEvidence).toContain(prepared.attempt!.expectedTitle)
    expect(draft.draft!.aiDisclosure).toMatch(/verified by hand|confirmed by hand/i)
    expect(draft.draft!.caveat).toMatch(/not a bounty/i)
  })

  it('refuses to promote a line the validator dismissed', async () => {
    fs.writeFileSync(path.join(tmp, 'safe.php'), `<?php
$tag_name_value = isset( $_GET['name'] ) ? wp_unslash( $_GET['name'] ) : '';
?>
<td><input name="name" value="<?php echo esc_attr( $tag_name_value ); ?>" /></td>
`)
    await importProgram()
    const { prepareJoin } = await import('../lab/joinRun')
    const r = prepareJoin({ root: tmp, file: 'safe.php', targetUrl: 'https://cantina.xyz/s?q={payload}' })
    expect(r.ok).toBe(false)
    expect(r.attempt).toBeNull()
    expect(r.message).toMatch(/dismissed|kept nothing/i)
  })
})
