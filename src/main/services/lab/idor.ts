import type { IdorComparison, IdorRequest, IdorResult, LabFinding } from '../../../shared/lab'
import { checkTarget, getTarget } from './targets'
import { Budget, RunLog } from './runner'
import { finishRun, refuseRun, startRun, updateRun } from './runs'
import { bodySimilarity, firstDifference, labRequest } from './http'

/**
 * IDOR auto-testing.
 *
 * The approach is the Burp extension's: take an endpoint that carries an identifier, request
 * it with the identifier you are entitled to see, then request it with other identifiers and
 * compare. A response that comes back with someone else's data is broken object-level
 * authorization.
 *
 * What this does NOT do is call that a finding. A difference is a lead. The comparison can be
 * fooled by a page that renders the same shell for every id, by a 200 that carries an error
 * message, by a redirect to a login, or by a soft 404. So the report says "lead" and names
 * what to check by hand, and the caveat travels with the result.
 */

const CAVEAT = 'A difference here is a lead, not a confirmed finding. It means two responses differed in a way worth a human look. Before you write it up, open both responses yourself and confirm the second one actually returned data belonging to another account — a shared page shell, a soft 404 or a login redirect all look like a difference and are not a vulnerability.'

export async function idorTest(req: IdorRequest, signal?: AbortSignal): Promise<IdorResult> {
  const declared = getTarget(req.targetId)
  if (!declared) {
    const run = refuseRun('idor', req.targetId, 'no such declaration')
    return { run, baseline: null, comparisons: [], caveat: CAVEAT }
  }
  const template = String(req.urlTemplate ?? '').trim()
  if (!template.includes('{id}')) {
    const run = refuseRun('idor', declared.host, 'the URL template has no {id} placeholder, so there is nothing to substitute')
    return { run, baseline: null, comparisons: [], caveat: CAVEAT }
  }
  const baselineUrl = template.replace('{id}', encodeURIComponent(String(req.baselineId ?? '')))
  const check = checkTarget(baselineUrl)
  if (!check.declared) {
    const run = refuseRun('idor', baselineUrl, check.reason)
    return { run, baseline: null, comparisons: [], caveat: CAVEAT }
  }
  const candidates = (Array.isArray(req.candidateIds) ? req.candidateIds : []).map(String).filter(Boolean).slice(0, 200)
  if (!candidates.length) {
    const run = refuseRun('idor', declared.host, 'no candidate identifiers were given')
    return { run, baseline: null, comparisons: [], caveat: CAVEAT }
  }

  const run = startRun({ tool: 'idor', targetId: declared.id, targetHost: declared.host, budget: req.budget })
  const budget = new Budget(run.budget)
  const log = new RunLog(lines => updateRun(run.id, { log: lines }))
  const onAbort = () => budget.stop()
  signal?.addEventListener('abort', onAbort)

  log.add('info', `IDOR test on ${template} — baseline id ${req.baselineId}, ${candidates.length} candidate(s)`)
  const findings: LabFinding[] = []
  let baseline: IdorComparison | null = null
  const comparisons: IdorComparison[] = []
  let stopReason: string | null = null
  let raw = ''

  try {
    const baseRes = await labRequest({ url: baselineUrl, budget, signal })
    raw += `GET ${baselineUrl} → ${baseRes.status ?? baseRes.refusedReason} (${baseRes.bytes} bytes)\n`
    if (!baseRes.ok) {
      stopReason = baseRes.refusedReason ?? 'the baseline request failed'
      log.add('error', stopReason)
    } else {
      baseline = {
        id: String(req.baselineId), status: baseRes.status, bytes: baseRes.bytes, similarity: 1,
        differs: false, why: 'the baseline: the identifier you are entitled to see', excerpt: baseRes.body.slice(0, 400),
      }
      log.add('result', `baseline ${baseRes.status}, ${baseRes.bytes} bytes`)

      for (const id of candidates) {
        if (signal?.aborted || budget.isStopped) { stopReason = 'stopped by the user'; break }
        if (budget.remaining <= 0) { stopReason = `request cap reached (${budget.maxRequests})`; break }
        const url = template.replace('{id}', encodeURIComponent(id))
        const res = await labRequest({ url, budget, signal })
        raw += `GET ${url} → ${res.status ?? res.refusedReason} (${res.bytes} bytes)\n`
        if (!res.ok) {
          if (res.undeclared) { stopReason = res.refusedReason ?? 'a candidate URL left the declared target'; break }
          comparisons.push({ id, status: null, bytes: 0, similarity: 0, differs: false, why: res.refusedReason ?? 'the request failed', excerpt: '' })
          continue
        }
        const similarity = bodySimilarity(baseline.excerpt, res.body.slice(0, 400), [String(req.baselineId), id])
        const sameStatus = res.status === baseline.status
        const lengthRatio = baseline.bytes > 0 ? res.bytes / baseline.bytes : 0
        // A lead is: the same status, a body that is not the baseline's, and a body that is not
        // an empty or error shell. Anything else is noise and is recorded as such.
        const looksLikeData = res.bytes > 40 && !/^\s*(not found|unauthorized|forbidden|error|login)/i.test(res.body.slice(0, 60))
        const differs = sameStatus && similarity < 0.95 && looksLikeData && lengthRatio > 0.2
        const why = !sameStatus
          ? `status ${res.status} differs from the baseline's ${baseline.status} — that is a different response, not necessarily a leak`
          : similarity >= 0.95
            ? 'the body is essentially the baseline, so this id returned the same thing'
            : !looksLikeData
              ? 'the body is short or reads as an error page, so this is not data'
              : 'same status, a different body with content in it — worth opening by hand'
        comparisons.push({
          id, status: res.status, bytes: res.bytes, similarity: Number(similarity.toFixed(3)),
          differs, why, excerpt: differs ? firstDifference(baseline.excerpt, res.body.slice(0, 400)) : res.body.slice(0, 200),
        })
        if (differs) {
          findings.push({
            id: `idor-${id}`, kind: 'idor',
            title: `IDOR lead: id ${id} returned a different body at ${template}`,
            detail: `${why}. This is a lead, not a confirmed finding.`,
            confidence: 'lead',
            evidence: `GET ${url} → ${res.status}, ${res.bytes} bytes, similarity ${similarity.toFixed(2)} to the baseline`,
          })
          log.add('result', `id ${id}: lead (${res.status}, ${res.bytes} bytes, similarity ${similarity.toFixed(2)})`)
        }
        updateRun(run.id, { requests: budget.requests })
      }
    }
  } catch (err) {
    stopReason = err instanceof Error ? err.message : String(err)
    log.add('error', stopReason)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }

  const finished = finishRun(run.id, stopReason ? (stopReason.includes('stopped') ? 'stopped' : 'failed') : 'done', stopReason, {
    requests: budget.requests, rawOutput: raw, findings, log: log.all(),
  })
  return { run: finished ?? run, baseline, comparisons, caveat: CAVEAT }
}
