import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The four defects from a real failed run, held one by one.
 *
 * The run: "may you please do one xss bounty for me". It asserted a declaration that did not
 * exist, spent three approvals on the same refused `lab.scan`, invented a typo as the cause,
 * and never reached the one route that can prove an XSS.
 *
 * Each test below is one of those, and each would fail on the code as it was.
 */

const tmp = path.join(os.tmpdir(), `goga-honesty-${process.pid}`)
const wpRoot = path.join(tmp, 'wordpress')
const otherRoot = path.join(tmp, 'second-wordpress')

beforeAll(() => {
  fs.mkdirSync(path.join(wpRoot, 'wp-includes', 'blocks'), { recursive: true })
  fs.writeFileSync(path.join(wpRoot, 'wp-includes', 'version.php'), '<?php // WordPress version\n')
  fs.writeFileSync(path.join(wpRoot, 'wp-includes', 'blocks', 'legacy-widget.php'), [
    '<?php',
    '/** A widget block that echoes a preview value straight back. */',
    '?>',
    '<div><?php echo $block->render( $_GET[\'legacy-widget-preview\'] ); ?></div>',
    '',
  ].join('\n'))
  fs.mkdirSync(path.join(otherRoot, 'wp-includes'), { recursive: true })
  fs.writeFileSync(path.join(otherRoot, 'wp-includes', 'version.php'), '<?php // version\n')
})

afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

// ── 1. A claim without a result ─────────────────────────────────────────────

describe('a precondition claimed with no tool result behind it', () => {
  it('drops "the target has been successfully declared" when no declare step succeeded', async () => {
    const { dropUnbackedPreconditionClaims } = await import('../replyHonesty')
    const reply = 'Now that the target has been successfully declared, the next step is to run the scan against it.'
    const r = dropUnbackedPreconditionClaims(reply, [])
    expect(r.dropped).toHaveLength(1)
    expect(r.content).not.toMatch(/successfully declared/i)
  })

  it('drops that sentence even when other steps in the turn succeeded', async () => {
    const { dropUnbackedPreconditionClaims } = await import('../replyHonesty')
    const reply = 'The file was read. Now that the target has been successfully declared, I will scan it.'
    const r = dropUnbackedPreconditionClaims(reply, [{ tool: 'filesystem.read', result: { success: true } }])
    expect(r.content).not.toMatch(/successfully declared/i)
    expect(r.content).toMatch(/The file was read\./)
  })

  it('keeps the sentence when a declare step really did succeed', async () => {
    const { dropUnbackedPreconditionClaims } = await import('../replyHonesty')
    const reply = 'The target has been declared, so the scan can start.'
    const r = dropUnbackedPreconditionClaims(reply, [{ tool: 'lab.declareTarget', result: { success: true } }])
    expect(r.dropped).toHaveLength(0)
    expect(r.content).toMatch(/has been declared/)
  })

  it('a failed declare does not back the claim', async () => {
    const { dropUnbackedPreconditionClaims } = await import('../replyHonesty')
    const reply = 'The target has been declared.'
    const r = dropUnbackedPreconditionClaims(reply, [{ tool: 'lab.declareTarget', result: { success: false, error: 'host is empty' } }])
    expect(r.dropped).toHaveLength(1)
  })
})

// ── 2. A precondition is not a retryable error ──────────────────────────────

describe('a precondition failure stops the run instead of being retried', () => {
  it('recognises "no such declaration" as a precondition failure', async () => {
    const { isPreconditionFailure, preconditionNextStep } = await import('../agentResilience')
    expect(isPreconditionFailure('no such declaration')).toBe(true)
    const next = preconditionNextStep('no such declaration')
    expect(next).toBeTruthy()
    // The next step must be an actual way forward, not "try again".
    expect(next).not.toMatch(/try again|retry/i)
    expect(next).toMatch(/declare|WordPress/i)
  })

  it('names the local WordPress path as an alternative that needs no declaration', async () => {
    const { preconditionNextStep } = await import('../agentResilience')
    expect(preconditionNextStep('no such declaration')).toMatch(/WordPress XSS path/i)
  })

  it('does not treat an ordinary transient failure as a precondition', async () => {
    const { isPreconditionFailure } = await import('../agentResilience')
    expect(isPreconditionFailure('the connection timed out')).toBe(false)
    expect(isPreconditionFailure('HTTP 503')).toBe(false)
  })

  it('reports a refusal with no reason as the refusal, without inventing one', async () => {
    const { refusalText } = await import('../agentResilience')
    expect(refusalText('lab.scan', 'no such declaration')).toBe('no such declaration')
    // An empty error carries no cause, and none is added.
    expect(refusalText('lab.scan', '')).toMatch(/refused without giving a reason/i)
  })
})

// ── 3. A cause the result did not give ─────────────────────────────────────

describe('a cause the tool result did not support', () => {
  it('drops "it seems there is a typo" when the result said only "no such declaration"', async () => {
    const { dropInventedCause } = await import('../replyHonesty')
    const reply = "It seems there's a typo or missing closing quotation mark in the previous target."
    const r = dropInventedCause(reply, 'no such declaration')
    expect(r.dropped).toHaveLength(1)
    expect(r.content).not.toMatch(/typo/i)
  })

  it('keeps a diagnosis the result itself supports', async () => {
    const { dropInventedCause } = await import('../replyHonesty')
    const reply = 'It seems there is a typo in the path.'
    const r = dropInventedCause(reply, 'ENOENT: no such file or directory — a typo in the path is likely')
    expect(r.dropped).toHaveLength(0)
  })

  it('leaves a plain factual sentence alone', async () => {
    const { dropInventedCause } = await import('../replyHonesty')
    const reply = 'The tool said: no such declaration.'
    const r = dropInventedCause(reply, 'no such declaration')
    expect(r.dropped).toHaveLength(0)
    expect(r.content).toBe(reply)
  })
})

// ── 4. The wrong route ─────────────────────────────────────────────────────

describe('"do one xss bounty for me" takes the WordPress path, not a scan', () => {
  it('recognises the request as an XSS request', async () => {
    const { XSS_REQUEST } = await import('../lab/xssRoute')
    expect(XSS_REQUEST.test('may you please do one xss bounty for me')).toBe(true)
    expect(XSS_REQUEST.test('find an xss on the login page')).toBe(true)
    expect(XSS_REQUEST.test('how is my alpaca account doing')).toBe(false)
  })

  it('chooses the local tree when exactly one exists, and names a file to read', async () => {
    const { decideXssRoute } = await import('../lab/xssRoute')
    const d = decideXssRoute([wpRoot])
    expect(d.route).toBe('wp-local')
    expect(d.root).toBe(wpRoot)
    expect(d.file).toBe('wp-includes/blocks/legacy-widget.php')
    // And it says why, in words, so the page can show the choice.
    expect(d.why).toMatch(/evidence/i)
  })

  it('refuses to choose between two trees instead of guessing', async () => {
    const { decideXssRoute } = await import('../lab/xssRoute')
    const d = decideXssRoute([wpRoot, otherRoot])
    expect(d.route).toBe('no-tree')
    expect(d.why).toMatch(/2 local copies/i)
    expect(d.next).toMatch(/use C:/i)
  })

  it('says there is no tree rather than falling back to a scan', async () => {
    const { decideXssRoute } = await import('../lab/xssRoute')
    const d = decideXssRoute([])
    expect(d.route).toBe('no-tree')
    expect(d.why).toMatch(/scan/i)
    expect(d.next).not.toMatch(/^.{0,40}scan/i)
  })

  it('the chosen file really does hold a sink the validator would confirm', async () => {
    const { decideXssRoute } = await import('../lab/xssRoute')
    const { readSinks } = await import('../lab/wpXss')
    const d = decideXssRoute([wpRoot])
    expect(d.file).toBeTruthy()
    const reading = readSinks(wpRoot, d.file!)
    expect(reading.candidates.length).toBeGreaterThan(0)
  })
})
