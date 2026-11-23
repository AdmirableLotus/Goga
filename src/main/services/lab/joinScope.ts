import type { ProgramImport, ScopeDecision } from '../../../shared/security'
import { assetCovers, decideScope, forbiddenTarget, parseTarget } from '../security/scope'
import { activeProgram, getProgram } from '../security/store'
import { checkTarget } from './targets'

/**
 * Who authorises a LIVE request: a bug-bounty program's own scope, or the user's declaration.
 *
 * This file answers the one question a live attempt has to answer before a request object can
 * exist: *may Goga send this at all, and on whose word?* It is the program half of the answer.
 * The declaration half stays where it already lives (`lab/targets.ts`), so there is one rule for
 * a declared host and not two.
 *
 * The three refusals it can return are deliberately distinguishable, because they need different
 * things from the user and a single "out of scope" would hide that:
 *
 *   - **no program** — nothing is imported, so nothing authorises a public host. Import one.
 *   - **deny rule** — the program lists this host and marks it NOT eligible for submission.
 *     Nothing overrides that: not a wildcard elsewhere in the program, not a declaration, not
 *     an approval.
 *   - **out of scope** — a program is imported but no eligible asset covers this host. Under-
 *     declaring is safe; guessing is not.
 *
 * It returns `null` in exactly one case: a program is imported and active, but it says nothing
 * at all about this host. That is not a decision — the caller falls back to the declaration
 * check, and if that fails too, the host is refused.
 */

export type JoinVia = 'loopback' | 'declaration' | 'program'

/** Which refusal this was. Named, so the UI can say which of the three it is. */
export type JoinRefusal = 'no-program' | 'deny-rule' | 'out-of-scope' | 'forbidden' | 'bad-url'

export interface ProgramScopeVerdict {
  allowed: boolean
  via: 'program'
  host: string
  port: number
  /** The asset identifier that decided it, quoted so the user can check it on the program page. */
  rule: string | null
  refusal: JoinRefusal | null
  decision: ScopeDecision | null
  reason: string
}

/**
 * The program's verdict for one URL, or null when the program does not mention this host.
 *
 * Order, matching `decideScope` and not re-implementing it: forbidden host, then deny rules,
 * then coverage, then exclusions. The decision is not re-derived here — `decideScope` is called
 * and its answer is carried through with its own quoted rule, so this cannot drift from the
 * scope checker every other tool already uses.
 */
export function programScopeFor(
  rawUrl: string,
  program: ProgramImport | null,
  technique: string | null = 'xss',
): ProgramScopeVerdict | null {
  if (!program) {
    return {
      allowed: false, via: 'program', host: '', port: 0, rule: null, refusal: 'no-program',
      decision: null,
      reason: 'no program scope is imported — import a program before any request to a public host',
    }
  }

  let parsed: ReturnType<typeof parseTarget>
  try { parsed = parseTarget(rawUrl) } catch (err) {
    return {
      allowed: false, via: 'program', host: '', port: 0, rule: null, refusal: 'bad-url', decision: null,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
  const host = parsed.host
  const port = parsed.port ?? (parsed.scheme === 'https' ? 443 : 80)

  const forbidden = forbiddenTarget(host)
  if (forbidden) {
    return { allowed: false, via: 'program', host, port, rule: null, refusal: 'forbidden', decision: null, reason: forbidden }
  }

  // Does this program say ANYTHING about the host — as an eligible asset or as a deny rule?
  // If it says nothing, this function has no opinion and returns null further down. Reading
  // both lists here is what makes "the program mentions it but denies it" different from
  // "the program has never heard of it".
  const mentions = program.assets.some(a => {
    try { return assetCovers(a.identifier, a.assetType, parsed, parsed.path, { deny: !a.eligibleForSubmission }).covers } catch { return false }
  })
  if (!mentions) return null

  const decision = decideScope(program, rawUrl, technique ?? undefined)
  if (decision.inScope) {
    return {
      allowed: true, via: 'program', host, port,
      rule: decision.matchedRule, refusal: null, decision,
      reason: `in scope — ${decision.reason}`,
    }
  }
  // A refusal that names an asset the program marks not eligible is a deny rule; anything else
  // is coverage. The distinction is carried in `matchedRule` + the reason text of decideScope,
  // which says "deny rule" in its own words; this mirrors that verdict rather than re-deciding.
  const isDeny = /deny rule|NOT eligible/i.test(decision.reason)
  return {
    allowed: false, via: 'program', host, port,
    rule: decision.matchedRule, refusal: isDeny ? 'deny-rule' : 'out-of-scope', decision,
    reason: decision.reason,
  }
}

/** The active program's verdict, or null when there is no active program or it ignores the host. */
export function activeProgramScope(rawUrl: string, technique: string | null = 'xss'): ProgramScopeVerdict | null {
  const program = activeProgram()
  if (!program) {
    return {
      allowed: false, via: 'program', host: '', port: 0, rule: null, refusal: 'no-program', decision: null,
      reason: 'no program scope is imported — import a program before any request to a public host',
    }
  }
  return programScopeFor(rawUrl, program, technique)
}

/** A named program's verdict, for a caller that resolved one explicitly. */
export function programScopeById(programId: string, rawUrl: string, technique: string | null = 'xss'): ProgramScopeVerdict {
  const program = getProgram(programId)
  const verdict = programScopeFor(rawUrl, program, technique)
  if (verdict) return verdict
  return {
    allowed: false, via: 'program', host: '', port: 0, rule: null, refusal: 'out-of-scope', decision: null,
    reason: program
      ? `${program.name} does not list this host as eligible, so the program's scope does not authorise it. Default deny.`
      : 'no such program is imported',
  }
}

// ── The one decision a live attempt asks before a request exists ────────────

/** The answer for one URL, from both authorities: the program's scope and the declarations. */
export interface JoinDecision {
  allowed: boolean
  host: string | null
  port: number | null
  /** Which authority allowed it. Null when nothing did. */
  via: JoinVia | null
  /** The declaration id, when a declaration is what allowed it. */
  targetId: string | null
  /** The program asset that decided it, quoted. */
  rule: string | null
  refusal: JoinRefusal | 'undeclared' | null
  /** Plain words: why it was allowed, or exactly what was refused and which rule decided it. */
  reason: string
}

/** The check the join path uses. Loopback stays the local lab and needs no declaration. */
export type JoinTargetCheck = (url: string) => JoinDecision

/**
 * May a live attempt be sent to this URL?
 *
 * Order, and it is the order that matters:
 *
 *   1. **Loopback** is the local lab. Unchanged behaviour, and it is checked first so a
 *      reproduction on this machine never depends on a program.
 *   2. **A deny rule wins.** If an imported program lists this host and marks it not eligible,
 *      the answer is no — before coverage is even considered, and before a declaration is
 *      consulted. A declaration is the user's statement about a host; a program's published
 *      exclusion is the venue's own statement about it, and the stricter one decides.
 *   3. **The program's scope**, when the program mentions the host at all.
 *   4. **The user's declaration**, when the program says nothing about the host.
 *
 * A host that none of those covers is refused, and the refusal names which of the three
 * situations it was. This function decides; it sends nothing and creates nothing.
 */
export function decideJoinTarget(rawUrl: string): JoinDecision {
  const text = String(rawUrl ?? '').trim()
  let parsed: URL
  try { parsed = new URL(text) } catch {
    return {
      allowed: false, host: null, port: null, via: null, targetId: null, rule: null,
      refusal: 'bad-url', reason: `"${rawUrl}" is not a URL`,
    }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      allowed: false, host: null, port: null, via: null, targetId: null, rule: null,
      refusal: 'bad-url', reason: `only http and https are supported (got ${parsed.protocol})`,
    }
  }
  const host = parsed.hostname.toLowerCase()
  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80)

  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') {
    return {
      allowed: true, host: '127.0.0.1', port, via: 'loopback', targetId: null, rule: null,
      refusal: null, reason: `${host}:${port} is this machine — the local reproduction`,
    }
  }

  const verdict = activeProgramScope(text)
  if (verdict?.refusal === 'deny-rule') {
    return {
      allowed: false, host, port, via: null, targetId: null, rule: verdict.rule,
      refusal: 'deny-rule', reason: describeRefusal(verdict),
    }
  }
  if (verdict?.allowed) {
    return {
      allowed: true, host, port, via: 'program', targetId: null, rule: verdict.rule,
      refusal: null, reason: verdict.reason,
    }
  }
  if (verdict?.refusal === 'forbidden') {
    return {
      allowed: false, host, port, via: null, targetId: null, rule: null,
      refusal: 'forbidden', reason: describeRefusal(verdict),
    }
  }

  // The program said nothing about the host (or there is none). The user's declaration is the
  // remaining authority, and it is the same check every other Lab tool uses.
  const declared = checkTarget(host, port)
  if (declared.declared) {
    return {
      allowed: true, host, port, via: 'declaration', targetId: declared.target?.id ?? null,
      rule: null, refusal: null, reason: declared.reason,
    }
  }

  if (!verdict) {
    // A program is imported but says nothing about this host, and no declaration covers it
    // either. That is an out-of-scope answer, not a "declare it" one: the program is the
    // authority for a public host, and it has not authorised this one.
    const program = activeProgram()
    return {
      allowed: false, host, port, via: null, targetId: null, rule: null,
      refusal: 'out-of-scope',
      reason: program
        ? `Out of scope: ${host} is not covered by any eligible asset in "${program.name}", and no declaration of yours covers it either. Default deny.`
        : declared.reason,
    }
  }
  return {
    allowed: false, host, port, via: null, targetId: null, rule: verdict.rule,
    refusal: verdict.refusal ?? 'out-of-scope', reason: describeRefusal(verdict),
  }
}

/**
 * The refusal phrased for the user, naming which of the three it was and the rule that decided it.
 *
 * It says WHAT was refused and WHY, and stops there. The caller appends whether anything was
 * sent — "nothing was prepared" while preparing, "nothing was sent" while sending — because only
 * the caller knows which of the two actually happened.
 */
export function describeRefusal(v: ProgramScopeVerdict): string {
  switch (v.refusal) {
    case 'no-program':
      return 'No program is imported, so nothing authorises a request to that host.'
    case 'deny-rule':
      return `The program marks ${v.rule ?? 'that asset'} as NOT eligible for submission — that is a deny rule, and nothing overrides it. ${v.reason}`
    case 'out-of-scope':
      return `Out of scope: ${v.reason}${v.rule ? ` (closest rule: ${v.rule})` : ''}`
    case 'forbidden':
      return v.reason
    default:
      return v.reason
  }
}
