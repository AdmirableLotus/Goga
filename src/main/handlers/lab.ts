import type { IpcMain } from 'electron'
import { audit } from '../services/security/store'
import {
  declareTarget, revokeTarget, listTargets, type DeclareResult,
} from '../services/lab/targets'
import { listRuns } from '../services/lab/runs'
import { isRunning, killedTotal, killAll, runningCount } from '../services/lab/runner'
import {
  preparePayload, decidePayload, dispatchPayload, listPayloadProposals, checkPayloadTarget,
} from '../services/lab/payload'
import { readSinks, runWordPressXss } from '../services/lab/wpXss'
import { labRequest } from '../services/lab/http'
import { Budget } from '../services/lab/runner'
import { browserLayer } from '../services/browser/layer'
import { ensureAttached } from '../tools/browserFirefox'
import {
  beginLiveRun, endLiveRun, liveState, publishEntry, recordFrame,
  startFrameLoop, stopFrameLoop,
} from '../services/lab/liveRun'
import { braveCantinaSession } from '../services/browser/braveSession'
import type { TargetKind } from '../../shared/lab'

/**
 * Lab IPC: the declared-target list, payload dispatch, and the local WordPress XSS path.
 *
 * Every handler here runs in main and every one that can send anything goes through the same
 * checks the chat tools use — the declaration gate for a target, the single-use gate for a
 * dispatch, and a 127.0.0.1-only re-check inside the XSS path. The renderer can prepare and
 * approve, but it cannot send: `lab:dispatchPayload` refuses until the proposal it names has
 * been approved, and the WordPress path cannot be aimed off this machine at all.
 *
 * Nothing here declares a target silently. `lab:declareTarget` writes the user's own sentence
 * to the audit trail and refuses one that does not have it.
 */

/**
 * A real picture of the browser Goga drives, or null when there is nothing attached.
 *
 * Firefox goes through the browser layer's own screenshot over BiDi; Brave goes through the
 * same Playwright page the Cantina session holds. Both are the browser Goga launched in its own
 * profile — never the user's own Brave window, which Goga does not attach to.
 */
export async function captureDrivenBrowser(): Promise<{ base64: string; url: string } | null> {
  // Firefox first: it is the engine Goga drives for security work when it is up.
  try {
    const layer = browserLayer()
    if (layer.isAttached) {
      const shot = await layer.screenshot()
      if (shot?.base64) return { base64: shot.base64, url: shot.url ?? '' }
    }
  } catch { /* no Firefox picture this tick */ }
  // Then the Brave window Goga opened itself, if it is up.
  try {
    const status = braveCantinaSession().status()
    if (status.state !== 'stopped' && status.state !== 'disconnected') {
      const shot = await braveCantinaSession().screenshot()
      if (shot?.base64) return { base64: shot.base64, url: shot.url ?? status.url ?? '' }
    }
  } catch { /* no Brave picture this tick */ }
  return null
}

export function registerLabHandlers(ipcMain: IpcMain) {
  ipcMain.handle('lab:state', async () => ({
    targets: listTargets(),
    runs: listRuns(30),
    payloads: listPayloadProposals().map(p => ({
      id: p.id, targetHost: p.targetHost, method: p.method, marker: p.marker, status: p.status,
    })),
    running: isRunning(),
    killed: killedTotal(),
  }))

  ipcMain.handle('lab:declareTarget', async (_e, input: { host: string; ports?: string; kind: TargetKind; note: string }): Promise<DeclareResult> => {
    const result = declareTarget({
      host: String(input?.host ?? ''),
      ports: input?.ports ? String(input.ports) : '',
      kind: (input?.kind ?? 'own-server') as TargetKind,
      note: String(input?.note ?? ''),
    })
    return result
  })

  ipcMain.handle('lab:revokeTarget', async (_e, id: string, reason: string) => revokeTarget(String(id ?? ''), String(reason ?? '')))

  ipcMain.handle('lab:stop', async (_e, reason?: string) => {
    const before = runningCount()
    const result = killAll(String(reason ?? 'stopped from the Lab section'))
    return { message: `${result.killed} process(es) stopped${before ? '' : ' (none were running)'}.` }
  })

  ipcMain.handle('lab:checkPayloadTarget', async (_e, url: string) => checkPayloadTarget(String(url ?? '')))

  ipcMain.handle('lab:preparePayload', async (_e, input: { urlTemplate: string; payload: string; marker: string; method?: 'GET' | 'POST'; why?: string }) => {
    const result = preparePayload({
      urlTemplate: String(input?.urlTemplate ?? ''),
      payload: String(input?.payload ?? ''),
      marker: String(input?.marker ?? ''),
      method: input?.method === 'POST' ? 'POST' : 'GET',
      why: input?.why ? String(input.why) : undefined,
    })
    return {
      ok: result.ok,
      message: result.message,
      proposal: result.proposal
        ? { id: result.proposal.id, url: result.proposal.url, method: result.proposal.method, payload: result.proposal.payload, marker: result.proposal.marker, targetHost: result.proposal.targetHost }
        : null,
    }
  })

  ipcMain.handle('lab:decidePayload', async (_e, id: string, approved: boolean) => {
    const result = decidePayload(String(id ?? ''), !!approved)
    return { ok: result.ok, message: result.message }
  })

  ipcMain.handle('lab:dispatchPayload', async (_e, id: string) => dispatchPayload(String(id ?? '')))

  ipcMain.handle('lab:readXssSinks', async (_e, root: string, file: string) => {
    const reading = readSinks(String(root ?? ''), String(file ?? ''))
    return {
      file: reading.file,
      bytes: reading.bytes,
      candidates: reading.candidates.map(c => ({
        file: c.file, line: c.line, excerpt: c.excerpt, context: c.context,
        observable: c.observable, why: c.why, wouldConfirm: c.wouldConfirm,
      })),
      dropped: reading.dropped.map(c => ({
        file: c.file, line: c.line, excerpt: c.excerpt, context: c.context, outcome: c.outcome, why: c.why,
      })),
    }
  })

  ipcMain.handle('lab:liveState', async () => liveState())

  /** One real capture of the browser Goga drives, on demand. Null when nothing is attached. */
  ipcMain.handle('lab:capturePane', async () => {
    const shot = await captureDrivenBrowser()
    if (!shot) {
      return { ok: false as const, message: 'No browser is attached, so there is no picture to show. Goga only captures the browser it launched itself.' }
    }
    return { ok: true as const, frame: recordFrame(shot) }
  })

  /**
   * The local WordPress XSS path, with the live view switched on.
   *
   * Everything the run does is published as it happens through liveRun: the file read, the
   * specialist's sink, the validator's observable, the reproduction address, each send, each
   * response, and the browser drive. The picture loop runs for the duration and stops when the
   * run ends. This is the same dispatch as before with a listener attached: it cannot send
   * anything the tools would not otherwise allow.
   */
  ipcMain.handle('lab:wpXssPath', async (_e, root: string, file: string, line?: number) => {
    const rootText = String(root ?? '')
    const fileText = String(file ?? '')
    const reading = readSinks(rootText, fileText)
    if (!reading.candidates.length) {
      throw new Error(`Nothing in ${reading.file} survived the validator, so there is nothing to reproduce.`)
    }

    beginLiveRun('wp-xss', `Local WordPress XSS path on ${reading.file}`)
    publishEntry('source', `Reading ${reading.file}`, `${reading.bytes} bytes. The XSS specialist raised ${reading.candidates.length + reading.dropped.length} candidate(s); the validator kept ${reading.candidates.length}.`)

    // Firefox already listening on Goga's own port is attached to, not relaunched: a browser an
    // earlier run started is reused. ensureAttached launches one only when nothing is listening.
    const layer = browserLayer()
    let attached = layer.isAttached
    if (!attached) {
      const status = await layer.status()
      if (status.state === 'running') {
        await layer.attach()
        attached = layer.isAttached
      } else {
        const started = await ensureAttached()
        attached = started.ok
        if (!started.ok) publishEntry('browser', 'No browser', `${started.message} Execution will not be claimed.`)
      }
    }
    if (attached) {
      publishEntry('browser', 'Firefox attached', "The run drives Firefox in Goga's own profile, so execution can be checked rather than inferred.")
    } else if (!layer.isAttached) {
      publishEntry('browser', 'No browser attached', 'Execution will not be claimed.')
    }
    const drive = attached
      ? { navigate: (u: string) => browserLayer().navigate(u), evaluate: (e: string) => browserLayer().evaluateScript(e) }
      : undefined

    // A picture at the start and then every 700ms while the run works, from the browser Goga
    // drives. No attachment means no frame, never a placeholder.
    startFrameLoop(captureDrivenBrowser, 700)

    let result: Awaited<ReturnType<typeof runWordPressXss>>
    try {
      result = await runWordPressXss({
        root: rootText,
        file: fileText,
        line: line ? Number(line) : undefined,
        drive,
        onStep: step => publishEntry(step.kind ?? 'source', step.step, step.detail),
        onBrowserShown: url => {
          // A picture of the page the browser is actually on, taken now rather than on the
          // next timer tick, so a run that finishes fast still leaves the real page on screen.
          void captureDrivenBrowser()
            .then(shot => { if (shot && shot.base64) recordFrame({ ...shot, url: shot.url || url }) })
            .catch(() => { /* no picture this moment; the loop keeps trying while the run lasts */ })
        },
        dispatch: async (url, payload) => {
          const target = url.replace('{payload}', encodeURIComponent(payload))
          const check = checkPayloadTarget(target)
          if (!check.allowed || check.host !== '127.0.0.1') {
            publishEntry('target', 'Refused by the scope check', `${check.reason} Only the local reproduction is ever dispatched at.`)
            return { status: null, body: '', bytes: 0, refused: `${check.reason} - only the local reproduction is ever dispatched at.` }
          }
          const budget = new Budget({ maxRequests: 4, maxPerMinute: 10 })
          const res = await labRequest({ url: target, budget, allowLocalLab: true })
          return { status: res.status, body: res.body, bytes: res.bytes, refused: res.refusedReason ?? undefined }
        },
      })
    } finally {
      stopFrameLoop()
    }
    audit('finding', `local XSS path on ${result.source.file}:${result.source.line} - executed=${result.executed}, tookAsMarkup=${result.tookAsMarkup}`)
    endLiveRun(result.executed
      ? 'Done. The payload ran on the reproduction and the control did not.'
      : result.tookAsMarkup
        ? 'Done. The payload came back as markup; execution was not confirmed by a browser.'
        : 'Done. The payload did not take as markup.')
    return {
      executed: result.executed,
      reflected: result.reflected,
      tookAsMarkup: result.tookAsMarkup,
      contextMatched: result.contextMatched,
      context: result.context,
      payload: result.payload,
      expectedTitle: result.expectedTitle,
      status: result.status,
      bytes: result.bytes,
      excerpt: result.excerpt,
      steps: result.steps,
      source: result.source,
      finding: result.finding ? { title: result.finding.title, detail: result.finding.detail, evidence: result.finding.evidence } : null,
      caveat: result.caveat,
    }
  })
}
