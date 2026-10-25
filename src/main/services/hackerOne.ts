import fs from 'fs'
import path from 'path'
import { app, safeStorage } from 'electron'

interface Credentials { username: string; token: string }
interface ApiResource { id?: string; type?: string; attributes?: Record<string, unknown> }
interface ApiDocument { data?: ApiResource | ApiResource[]; links?: { next?: string | null }; errors?: Array<{ title?: string; detail?: string }> }

const API_ORIGIN = 'https://api.hackerone.com'
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i
const MAX_RESPONSE_BYTES = 1_000_000
const PAGE_SIZE = 100
const MAX_PAGES = 100

export class HackerOneService {
  private static instance: HackerOneService
  private credentialPath = path.join(app.getPath('userData'), 'goga-hackerone-credentials.bin')

  static getInstance() {
    if (!HackerOneService.instance) HackerOneService.instance = new HackerOneService()
    return HackerOneService.instance
  }

  status() {
    return { configured: fs.existsSync(this.credentialPath), encryptionAvailable: safeStorage.isEncryptionAvailable() }
  }

  saveCredentials(username: string, token: string) {
    const cleanUsername = username.trim()
    if (!cleanUsername || !token.trim()) throw new Error('Enter your HackerOne username and API token.')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure desktop storage is unavailable. Enable the operating system keychain before saving a HackerOne token.')
    const encrypted = safeStorage.encryptString(JSON.stringify({ username: cleanUsername, token: token.trim() }))
    fs.writeFileSync(this.credentialPath, encrypted, { mode: 0o600 })
    return { configured: true as const }
  }

  clearCredentials() {
    if (fs.existsSync(this.credentialPath)) fs.unlinkSync(this.credentialPath)
  }

  private credentials(): Credentials {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure desktop storage is unavailable.')
    if (!fs.existsSync(this.credentialPath)) throw new Error('Connect a HackerOne API token first.')
    const parsed = JSON.parse(safeStorage.decryptString(fs.readFileSync(this.credentialPath))) as Credentials
    if (!parsed.username || !parsed.token) throw new Error('Saved HackerOne credentials are invalid. Reconnect your token.')
    return parsed
  }

  private async getJson(pathname: string): Promise<ApiDocument> {
    if (!pathname.startsWith('/v1/hackers/programs/') || pathname.startsWith('//') || pathname.includes('..')) {
      throw new Error('Invalid HackerOne API path.')
    }
    const { username, token } = this.credentials()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await fetch(new URL(pathname, API_ORIGIN), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Authorization: 'Basic ' + Buffer.from(username + ':' + token).toString('base64'),
          Accept: 'application/json',
          'User-Agent': 'Goga-Desktop-Security-Workspace'
        }
      })
      if (response.status >= 300 && response.status < 400) throw new Error('HackerOne API redirected the request; it was stopped for safety.')
      const body = await response.text()
      if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('HackerOne returned an unexpectedly large response.')
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Error('HackerOne rejected the API credentials or access to this program.')
        throw new Error(`HackerOne API request failed (${response.status}).`)
      }
      try { return JSON.parse(body) as ApiDocument } catch { throw new Error('HackerOne returned an invalid JSON response.') }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('HackerOne API request timed out.')
      throw error
    } finally { clearTimeout(timeout) }
  }

  async importProgram(handleInput: string) {
    const handle = handleInput.trim()
    if (!HANDLE_RE.test(handle)) throw new Error('Enter a valid HackerOne program handle.')
    const encoded = encodeURIComponent(handle)
    const [programDoc, exclusionsDoc] = await Promise.all([
      this.getJson(`/v1/hackers/programs/${encoded}`),
      this.getJson(`/v1/hackers/programs/${encoded}/scope_exclusions`)
    ])
    const program = Array.isArray(programDoc.data) ? programDoc.data[0] : programDoc.data
    if (!program?.attributes) throw new Error('HackerOne did not return program details for this handle.')
    const attributes = program.attributes
    const assets: string[] = []
    let hasMore = true
    for (let page = 1; hasMore && page <= MAX_PAGES; page++) {
      const doc = await this.getJson(`/v1/hackers/programs/${encoded}/structured_scopes?page[number]=${page}&page[size]=${PAGE_SIZE}`)
      const entries = Array.isArray(doc.data) ? doc.data : []
      for (const entry of entries) {
        const a = entry.attributes ?? {}
        const identifier = typeof a.asset_identifier === 'string' ? a.asset_identifier.trim() : ''
        if (identifier && a.eligible_for_submission === true) assets.push(identifier)
      }
      hasMore = Boolean(doc.links?.next) || entries.length === PAGE_SIZE
      if (page === MAX_PAGES && hasMore) throw new Error('This program has too many scope entries to import safely. Narrow the program scope and try again.')
    }
    const uniqueAssets = [...new Set(assets)]
    if (uniqueAssets.length === 0) throw new Error('No explicitly submission-eligible assets were returned. Goga did not create an unrestricted workspace.')
    const exclusions = Array.isArray(exclusionsDoc.data) ? exclusionsDoc.data : []
    const summary = {
      importedAt: new Date().toISOString(),
      source: 'HackerOne API',
      handle,
      policy: attributes.policy ?? '',
      state: attributes.state ?? '',
      submission_state: attributes.submission_state ?? '',
      offers_bounties: attributes.offers_bounties ?? false,
      open_scope: attributes.open_scope ?? false,
      scopeEntries: uniqueAssets.length,
      exclusions: exclusions.map(entry => entry.attributes ?? {})
    }
    return {
      program: typeof attributes.name === 'string' ? attributes.name : handle,
      programUrl: `https://hackerone.com/${handle}`,
      authorizedAssets: uniqueAssets,
      excludedAssets: [],
      allowedTechniques: [],
      prohibitedTechniques: [],
      rateLimit: '',
      programRules: JSON.stringify(summary, null, 2),
      testNotes: 'Scope and program policy imported from HackerOne. Review current rules before testing. API import does not grant permission beyond the listed eligible assets.',
    }
  }
}
