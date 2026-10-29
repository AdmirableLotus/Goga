import { LAB_ACCOUNTS, type LabAccount, type PracticeLab } from './practiceLab'

// Goga's HTTP worker for the practice lab: requests as a named test account, to the lab
// origin only, never following redirects. Credentials stay here, never in the prompt.

const BODY_CHARS = 4000

export interface LabResponse { method: string; path: string; as: string; status: number; body: string }

export function labAccount(name: unknown): LabAccount | null {
  return LAB_ACCOUNTS.find(a => a === String(name ?? '').toLowerCase().trim()) ?? null
}

/** `path` as a URL on the lab origin, or null when it would leave it. */
export function labUrl(baseUrl: string, path: unknown): URL | null {
  if (typeof path !== 'string' || !path.trim()) return null
  try {
    const url = new URL(path.trim(), baseUrl)
    return url.origin === new URL(baseUrl).origin && !url.username && !url.password ? url : null
  } catch { return null }
}

export class LabClient {
  private tokens = new Map<LabAccount, string>()
  constructor(private lab: PracticeLab) {}

  private async call(url: URL, init: RequestInit, signal?: AbortSignal): Promise<{ status: number; body: string }> {
    const res = await fetch(url, { ...init, redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) })
    return { status: res.status, body: (await res.text()).slice(0, BODY_CHARS) }
  }

  private async token(account: LabAccount, signal?: AbortSignal): Promise<string> {
    const known = this.tokens.get(account)
    if (known) return known
    const password = this.lab.passwordFor(account)
    if (!password || !this.lab.running) throw new Error('The practice lab is not running. Start it in the Security tab.')
    const res = await this.call(new URL('/login', this.lab.baseUrl), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: account, password }) }, signal)
    const token = res.status === 200 ? (JSON.parse(res.body) as { token?: string }).token : undefined
    if (!token) throw new Error(`Could not sign in as ${account} (HTTP ${res.status}).`)
    this.tokens.set(account, token)
    return token
  }

  forgetSessions() { this.tokens.clear() }

  /** One GET as `as` (a test account), or anonymous when `as` is null. */
  async get(path: string, as: LabAccount | null, signal?: AbortSignal): Promise<LabResponse> {
    const url = labUrl(this.lab.baseUrl, path)
    if (!url) throw new Error(`"${path}" is not on the practice lab (${this.lab.baseUrl}).`)
    const headers: Record<string, string> = as ? { Authorization: `Bearer ${await this.token(as, signal)}` } : {}
    const { status, body } = await this.call(url, { method: 'GET', headers }, signal)
    return { method: 'GET', path: url.pathname + url.search, as: as ?? 'anonymous', status, body }
  }

  /**
   * Does `other` get `owner`'s resource? Asked twice each way: a finding needs the owner to
   * get it (the normal case), the other account to get the same thing, and both to repeat.
   */
  async verifyAccess(path: string, owner: LabAccount, other: LabAccount, signal?: AbortSignal): Promise<{ supported: boolean; reason: string; responses: LabResponse[] }> {
    if (owner === other) throw new Error('Use two different test accounts.')
    const responses: LabResponse[] = []
    for (let i = 0; i < 2; i++) { responses.push(await this.get(path, owner, signal)); responses.push(await this.get(path, other, signal)) }
    const [own1, oth1, own2, oth2] = responses
    if (own1.status !== 200 || own2.status !== 200) return { supported: false, reason: `${owner} could not read ${path} (HTTP ${own1.status}), so it is not ${owner}'s resource to protect.`, responses }
    if (oth1.status !== 200 || oth2.status !== 200) return { supported: false, reason: `${other} was refused (HTTP ${oth1.status}): access control works here.`, responses }
    if (oth1.body !== own1.body || oth2.body !== own2.body) return { supported: false, reason: `${other} got a different answer than ${owner}, not ${owner}'s data.`, responses }
    return { supported: true, reason: `${other} read ${owner}'s ${path} with the same response ${owner} gets, twice.`, responses }
  }
}
