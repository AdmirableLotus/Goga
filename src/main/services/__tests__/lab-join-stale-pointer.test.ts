import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The active-program pointer, in both directions.
 *
 * These tests exist because of a real store on this machine: five programs imported, and an
 * `activeProgramId` naming a program that a re-import had replaced. `activeProgram()` returned
 * null, so the join gate said "No program is imported" — a false sentence about a store holding
 * five programs, one of them in scope for the host being tested.
 *
 * What must hold after the fix:
 *
 *   1. re-importing the program that is currently active leaves it active, under its new id;
 *   2. a pointer left dangling on disk is a named, distinct state, not "nothing is imported";
 *   3. the join gate carries that state through to the user as the truth: programs are imported,
 *      and the pointer names one that no longer exists.
 */

const tmp = path.join(os.tmpdir(), `goga-join-stale-${process.pid}`)
const securityFile = path.join(tmp, 'goga-security-store.json')
const targetsFile = path.join(tmp, 'goga-lab-targets.json')

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

afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

beforeEach(() => {
  for (const f of [securityFile, targetsFile]) { try { fs.rmSync(f) } catch { /* fresh */ } }
})

/** One program as an import would hand it to the store. */
function program(handle: string, name: string, assetHost = 'https://cantina.xyz') {
  return {
    source: 'cantina' as const,
    handle,
    name,
    url: `https://bounties.cantina.xyz/${handle}`,
    policy: '',
    submissionState: 'open' as const,
    offersBounties: true,
    assets: [{
      identifier: assetHost,
      assetType: 'URL' as const,
      eligibleForSubmission: true,
      eligibleForBounty: true,
      maxSeverity: 'critical' as const,
      instruction: null,
    }],
    exclusions: [],
    skipped: [],
    notes: '',
    entryBar: {
      kycRequired: false, kycQuote: null, depositUsd: null, findingsSubmitted: null,
      liveSince: null, assetCount: 1, scopeKind: 'web' as const,
      automatedTestingRule: 'Excessive traffic may be flagged as malicious activity.',
      topReward: '$5,000',
      rewards: [{ severity: 'Critical', amount: '$5,000' }],
      entry: { level: 'open' as const, why: 'test' },
    },
  }
}

/** Push the stored pointer back to an id nothing matches — the state found on disk. */
function danglePointerAt(id: string): void {
  const store = JSON.parse(fs.readFileSync(securityFile, 'utf8'))
  store.activeProgramId = id
  fs.writeFileSync(securityFile, JSON.stringify(store, null, 2))
}

describe('re-importing the active program keeps it active', () => {
  it('re-points the pointer to the replacement when the replaced copy was the active one', async () => {
    const store = await import('../security/store')
    const first = store.addProgram(program('cantina', 'Cantina Bug Bounty Program'))
    // A first import with nothing active becomes active: the store has to start somewhere.
    expect(store.activeProgram()?.id).toBe(first.id)

    const second = store.addProgram(program('cantina', 'Cantina Bug Bounty Program'))
    // The re-import replaces the old copy under a NEW id, and the pointer must follow it.
    expect(second.id).not.toBe(first.id)
    expect(store.activeProgramState()).toEqual({ state: 'active', program: second })
    expect(store.activeProgram()?.id).toBe(second.id)
    // The old copy is gone, not duplicated.
    expect(store.listPrograms()).toHaveLength(1)
  })

  it('leaves the pointer alone when a different program is re-imported', async () => {
    const store = await import('../security/store')
    const active = store.addProgram(program('cantina', 'Cantina Bug Bounty Program'))
    store.addProgram(program('other', 'Another Program', 'https://other.example'))

    const replacedOther = store.addProgram(program('other', 'Another Program', 'https://other.example'))
    expect(store.activeProgram()?.id).toBe(active.id)
    expect(replacedOther.id).not.toBe(active.id)
  })
})

describe('a stale pointer is its own state, not "no program"', () => {
  it('reports the stale pointer as stale, naming how many programs are imported', async () => {
    const store = await import('../security/store')
    store.addProgram(program('a', 'Program A'))
    store.addProgram(program('b', 'Program B', 'https://b.example'))
    danglePointerAt('e6d0e0367cff9de4')

    const state = store.activeProgramState()
    expect(state.state).toBe('stale')
    if (state.state !== 'stale') throw new Error('expected a stale pointer')
    expect(state.staleId).toBe('e6d0e0367cff9de4')
    expect(state.programCount).toBe(2)
    // And it is still null for callers that only want a program — but with a reason available.
    expect(store.activeProgram()).toBeNull()
  })

  it('reports none, not stale, when nothing is imported at all', async () => {
    const store = await import('../security/store')
    expect(store.activeProgramState()).toEqual({ state: 'none' })
  })

  it('the stale reason is distinct from the no-program reason', async () => {
    const store = await import('../security/store')
    const { describeRefusal } = await import('../lab/joinScope')

    const noProgram = describeRefusal({
      allowed: false, via: 'program', host: '', port: 0, rule: null, refusal: 'no-program',
      decision: null, reason: 'no program scope is imported',
    })

    store.addProgram(program('cantina', 'Cantina Bug Bounty Program'))
    danglePointerAt('e6d0e0367cff9de4')
    const { activeProgramScope } = await import('../lab/joinScope')
    const verdict = activeProgramScope('https://cantina.xyz/search?q=x')
    expect(verdict?.refusal).toBe('stale-pointer')
    const stale = describeRefusal(verdict!)

    expect(stale).not.toBe(noProgram)
    expect(stale).not.toMatch(/no program is imported/i)
    expect(stale).toMatch(/stale/i)
    expect(stale).toMatch(/e6d0e0367cff9de4/)
    expect(stale).toMatch(/1 program/i)
  })
})

describe('decideJoinTarget surfaces the stale pointer with the truth', () => {
  it('says programs are imported and the pointer names one that no longer exists', async () => {
    const store = await import('../security/store')
    store.addProgram(program('cantina', 'Cantina Bug Bounty Program'))
    danglePointerAt('e6d0e0367cff9de4')

    const { decideJoinTarget } = await import('../lab/joinScope')
    const decision = decideJoinTarget('https://cantina.xyz/search?q=x')

    expect(decision.allowed).toBe(false)
    expect(decision.refusal).toBe('stale-pointer')
    // The sentence the old code produced, and which was false here:
    expect(decision.reason).not.toMatch(/no program is imported/i)
    // What is actually true: the store holds programs, and the pointer names a dead id;
    // and the refusal says explicitly that this is NOT the no-program case.
    expect(decision.reason).toMatch(/pointer is stale/i)
    expect(decision.reason).toMatch(/are imported/i)
    expect(decision.reason).toMatch(/no longer exists/i)
    expect(decision.reason).toMatch(/not the same as no program being imported/i)
    expect(decision.reason).toContain('e6d0e0367cff9de4')
  })

  it('still refuses a stale pointer even when a declaration covers the host', async () => {
    const store = await import('../security/store')
    store.addProgram(program('cantina', 'Cantina Bug Bounty Program'))
    danglePointerAt('e6d0e0367cff9de4')
    const targets = await import('../lab/targets')
    targets.declareTarget({ host: 'cantina.xyz', why: 'test declaration for the stale-pointer case' })

    const { decideJoinTarget } = await import('../lab/joinScope')
    const decision = decideJoinTarget('https://cantina.xyz/search?q=x')
    expect(decision.allowed).toBe(false)
    expect(decision.refusal).toBe('stale-pointer')
    expect(decision.via).toBeNull()
  })

  it('prepares nothing against a stale pointer, and says why', async () => {
    const store = await import('../security/store')
    store.addProgram(program('cantina', 'Cantina Bug Bounty Program'))
    danglePointerAt('e6d0e0367cff9de4')
    fs.writeFileSync(path.join(tmp, 'sink.php'), `<?php
$tag_name_value = isset( $_GET['name'] ) ? wp_unslash( $_GET['name'] ) : '';
?>
<td><input name="name" id="name" type="text" value="<?php echo $tag_name_value; ?>" /></td>
`)

    const { prepareJoin } = await import('../lab/joinRun')
    const r = prepareJoin({
      root: tmp, file: 'sink.php',
      targetUrl: 'https://cantina.xyz/search?q={payload}',
    })
    expect(r.ok).toBe(false)
    expect(r.attempt).toBeNull()
    expect(r.message).toMatch(/stale/i)
    expect(r.message).not.toMatch(/no program is imported/i)
    expect(r.message).toMatch(/nothing was prepared/i)
  })

  it('an active program that exists resolves normally after the pointer is set again', async () => {
    const store = await import('../security/store')
    const cantina = store.addProgram(program('cantina', 'Cantina Bug Bounty Program'))
    danglePointerAt('e6d0e0367cff9de4')
    // Selecting the program on the Security page is what repairs the pointer.
    store.setActiveProgram(cantina.id)

    const { decideJoinTarget } = await import('../lab/joinScope')
    const decision = decideJoinTarget('https://cantina.xyz/search?q=x')
    expect(decision.allowed).toBe(true)
    expect(decision.via).toBe('program')
    expect(decision.rule).toBe('https://cantina.xyz')
  })
})
