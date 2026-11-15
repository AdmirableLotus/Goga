import type { HealthCheck, MonitoredApp, UptimeSummary } from '../../../shared/business'

/**
 * Health checks and uptime maths.
 *
 * The arithmetic is kept here, pure and separate from the network call, so what the page
 * shows can be checked in a test: an uptime percentage is "checks that answered OK" out of
 * "checks taken", and nothing is rounded into a nicer story. With no checks the percentage
 * is null rather than 100%.
 */

export const MAX_CHECKS_KEPT = 500
const CHECK_TIMEOUT_MS = 12_000

/**
 * One check: a plain GET with a short timeout, redirects not followed. Any HTTP answer at
 * all counts as "the server answered"; only 2xx/3xx counts as healthy, because a 500 from
 * a page is a real outage even though the host is up.
 */
export async function probeUrl(url: string, http: typeof fetch = fetch): Promise<HealthCheck> {
  const at = new Date().toISOString()
  const started = Date.now()
  try {
    const res = await http(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'Goga/0.1 (local uptime check)' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
    return {
      at,
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      ms: Date.now() - started,
      error: null,
    }
  } catch (err) {
    return {
      at,
      ok: false,
      status: null,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Tally one app's checks. `uptimePct` is null when nothing has been checked yet. */
export function summariseUptime(appId: string, checks: HealthCheck[]): UptimeSummary {
  const list = checks.filter(c => typeof c?.at === 'string')
  if (!list.length) {
    return { appId, checks: 0, up: 0, uptimePct: null, avgMs: null, lastCheck: null }
  }
  const up = list.filter(c => c.ok).length
  const avgMs = Math.round(list.reduce((a, c) => a + (Number.isFinite(c.ms) ? c.ms : 0), 0) / list.length)
  return {
    appId,
    checks: list.length,
    up,
    uptimePct: (up / list.length) * 100,
    avgMs,
    lastCheck: list[list.length - 1],
  }
}

/** The most recent `limit` checks, newest last, capped so the store cannot grow forever. */
export function trimChecks(checks: HealthCheck[], limit = MAX_CHECKS_KEPT): HealthCheck[] {
  return checks.length > limit ? checks.slice(-limit) : checks
}

export interface MonitorRow {
  app: MonitoredApp
  uptime: UptimeSummary
  /** True when the last check failed or the last three in a row failed. */
  down: boolean
}

export function monitorRows(apps: MonitoredApp[]): MonitorRow[] {
  return apps.map(app => {
    const uptime = summariseUptime(app.id, app.checks ?? [])
    const recent = (app.checks ?? []).slice(-3)
    const down = recent.length > 0 && recent.every(c => !c.ok)
    return { app, uptime, down }
  })
}

/** A one-line description of where a release would be published, for each builder's own gate. */
export function publishSteps(publishedWhere: string): string[] {
  const where = String(publishedWhere ?? '').toLowerCase()
  if (where.includes('play')) {
    return [
      'Build the release in the project folder (Goga can run the build).',
      'Increment the version code in the app before uploading.',
      'Upload the bundle in Google Play Console → your app → Release.',
      'Google reviews it. Publishing is your click, in your own account.',
    ]
  }
  if (where.includes('base44') || where.includes('runable') || where.includes('choicely')) {
    return [
      'Build the change in the project folder.',
      'Publish from the builder’s own dashboard — that release is your click, in your own account.',
      'Goga cannot publish for you and does not try to.',
    ]
  }
  if (where.includes('web') || where.includes('netlify') || where.includes('vercel')) {
    return [
      'Build the site in the project folder.',
      'Deploy from your own host account, or the CLI already signed in on this machine.',
      'Nothing is deployed by Goga on its own.',
    ]
  }
  return [
    'Goga builds and monitors only. It does not publish anywhere.',
    'Tell it where the release goes and it will show the steps for that place.',
  ]
}
