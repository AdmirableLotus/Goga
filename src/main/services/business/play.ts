import { PUBLISHER_BASE, REPORTING_BASE, TOKEN_URL, classifyGoogleError, tokenRequestBody, type GoogleError } from './playKey'

/**
 * A thin client for the two Google APIs this build uses.
 *
 * There is no Google SDK here on purpose. The Android Publisher API is ordinary REST: an edit
 * is opened, things are added to it, and it is committed or thrown away. Keeping the calls
 * visible means the commit step can be kept behind the approval queue instead of buried in a
 * library that might retry or auto-commit on its own.
 *
 * Every call takes its access token from `getToken`, so the token is fetched once per session
 * operation and never stored.
 */

export interface TrackRelease {
  name: string | null
  versionCodes: string[]
  status: string | null
  /** The release notes as written, per language. */
  releaseNotes: { language: string; text: string }[]
}

export interface TrackSummary {
  track: string
  releases: TrackRelease[]
}

export interface PlayApp {
  packageName: string
  displayName: string
}

export interface EditAppDetails {
  packageName: string
  defaultLanguage: string | null
  contactEmail: string | null
}

export interface UploadedBundle {
  versionCode: string
  sha1: string | null
  sha256: string | null
}

export class PlayApiError extends Error {
  readonly google: GoogleError
  readonly status: number
  constructor(status: number, google: GoogleError) {
    super(google.message)
    this.name = 'PlayApiError'
    this.status = status
    this.google = google
  }
}

export interface PlayClientOptions {
  getToken: () => Promise<string>
  fetchImpl?: typeof fetch
  base?: string
  reportingBase?: string
}

export class PlayClient {
  private readonly getToken: () => Promise<string>
  private readonly http: typeof fetch
  private readonly base: string
  private readonly reporting: string

  constructor(options: PlayClientOptions) {
    this.getToken = options.getToken
    this.http = options.fetchImpl ?? fetch
    this.base = options.base ?? PUBLISHER_BASE
    this.reporting = options.reportingBase ?? REPORTING_BASE
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.getToken()}` }
  }

  /** The apps this service account can see, across every app the developer account owns. */
  async listApps(): Promise<PlayApp[]> {
    const out: PlayApp[] = []
    let pageToken: string | undefined
    do {
      const url = new URL(`${this.reporting}/v1beta1/apps:search`)
      url.searchParams.set('pageSize', '100')
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const res = await this.http(url.toString(), { headers: await this.authHeaders() })
      const body = await res.text()
      if (!res.ok) throw new PlayApiError(res.status, classifyGoogleError(res.status, body, 'reporting'))
      const json = JSON.parse(body) as {
        apps?: { packageName?: string; displayName?: string }[]
        nextPageToken?: string
      }
      for (const app of json.apps ?? []) {
        if (app.packageName) out.push({ packageName: app.packageName, displayName: app.displayName ?? app.packageName })
      }
      pageToken = json.nextPageToken
    } while (pageToken)
    return out
  }

  /** Open an edit — the container the API requires before anything can be read or written. */
  async insertEdit(packageName: string): Promise<string> {
    const res = await this.http(`${this.base}/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/edits`, {
      method: 'POST',
      headers: { ...(await this.authHeaders()), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const body = await res.text()
    if (!res.ok) throw new PlayApiError(res.status, classifyGoogleError(res.status, body))
    const json = JSON.parse(body) as { id?: string }
    if (!json.id) throw new PlayApiError(res.status, classifyGoogleError(500, 'the edit had no id'))
    return json.id
  }

  /** Throw an edit away. Reading tracks opens one, so this is how a read leaves no trace. */
  async deleteEdit(packageName: string, editId: string): Promise<void> {
    const res = await this.http(`${this.base}/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}`, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    })
    if (!res.ok) {
      // A failed clean-up is reported, but it is not a reason to fail the read.
      const body = await res.text()
      throw new PlayApiError(res.status, classifyGoogleError(res.status, body))
    }
  }

  async listTracks(packageName: string, editId: string): Promise<TrackSummary[]> {
    const res = await this.http(
      `${this.base}/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}/tracks`,
      { headers: await this.authHeaders() },
    )
    const body = await res.text()
    if (!res.ok) throw new PlayApiError(res.status, classifyGoogleError(res.status, body))
    const json = JSON.parse(body) as {
      tracks?: {
        track?: string
        releases?: {
          name?: string
          versionCodes?: (string | number)[]
          status?: string
          releaseNotes?: { language?: string; text?: string }[]
        }[]
      }[]
    }
    return (json.tracks ?? []).map(t => ({
      track: t.track ?? '(unnamed track)',
      releases: (t.releases ?? []).map(r => ({
        name: r.name ?? null,
        versionCodes: (r.versionCodes ?? []).map(String),
        status: r.status ?? null,
        releaseNotes: (r.releaseNotes ?? []).map(n => ({ language: n.language ?? '', text: n.text ?? '' })),
      })),
    }))
  }

  async getAppDetails(packageName: string, editId: string): Promise<EditAppDetails> {
    const res = await this.http(
      `${this.base}/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}/details`,
      { headers: await this.authHeaders() },
    )
    const body = await res.text()
    if (!res.ok) throw new PlayApiError(res.status, classifyGoogleError(res.status, body))
    const json = JSON.parse(body) as { defaultLanguage?: string; contactEmail?: string }
    return { packageName, defaultLanguage: json.defaultLanguage ?? null, contactEmail: json.contactEmail ?? null }
  }

  /**
   * Upload an .aab into an open edit. The body is the file, unmodified: Google reads the
   * version code out of the bundle's manifest, so nothing here guesses it.
   */
  async uploadBundle(packageName: string, editId: string, bytes: Buffer): Promise<UploadedBundle> {
    const res = await this.http(
      `${this.base}/upload/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}/bundles?uploadType=media`,
      {
        method: 'POST',
        headers: { ...(await this.authHeaders()), 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(bytes),
      },
    )
    const body = await res.text()
    if (!res.ok) throw new PlayApiError(res.status, classifyGoogleError(res.status, body))
    const json = JSON.parse(body) as { versionCode?: number; sha1?: string; sha256?: string }
    if (json.versionCode == null) throw new PlayApiError(res.status, classifyGoogleError(500, 'the upload returned no version code'))
    return { versionCode: String(json.versionCode), sha1: json.sha1 ?? null, sha256: json.sha256 ?? null }
  }

  /** Point one track at a version code, with the release notes the user wrote. */
  async setTrackRelease(
    packageName: string,
    editId: string,
    input: { track: string; versionCode: string; releaseNotes: string; language: string; releaseName?: string | null },
  ): Promise<TrackSummary> {
    const track = input.track
    const payload = {
      track,
      releases: [
        {
          name: input.releaseName ?? undefined,
          versionCodes: [String(input.versionCode)],
          status: 'completed',
          releaseNotes: input.releaseNotes
            ? [{ language: input.language || 'en-US', text: input.releaseNotes }]
            : undefined,
        },
      ],
    }
    const res = await this.http(
      `${this.base}/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}/tracks/${encodeURIComponent(track)}`,
      {
        method: 'PUT',
        headers: { ...(await this.authHeaders()), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    )
    const body = await res.text()
    if (!res.ok) throw new PlayApiError(res.status, classifyGoogleError(res.status, body))
    const json = JSON.parse(body) as { track?: string; releases?: { versionCodes?: (string | number)[]; status?: string }[] }
    return {
      track: json.track ?? track,
      releases: (json.releases ?? []).map(r => ({
        name: null,
        versionCodes: (r.versionCodes ?? []).map(String),
        status: r.status ?? null,
        releaseNotes: [],
      })),
    }
  }

  /** Commit the edit. This is the call that makes the release real to Play. */
  async commitEdit(packageName: string, editId: string): Promise<void> {
    const res = await this.http(
      `${this.base}/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}:commit`,
      { method: 'POST', headers: { ...(await this.authHeaders()), 'Content-Type': 'application/json' }, body: '{}' },
    )
    if (!res.ok) {
      const body = await res.text()
      throw new PlayApiError(res.status, classifyGoogleError(res.status, body))
    }
  }
}

/**
 * Exchange a signed assertion for an access token. Kept separate from the client so the
 * credential never has to travel into the API layer.
 */
export async function fetchAccessToken(
  assertion: string,
  http: typeof fetch = fetch,
  tokenUrl: string = TOKEN_URL,
): Promise<{ accessToken: string; expiresInSec: number }> {
  const res = await http(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenRequestBody(assertion),
  })
  const body = await res.text()
  if (!res.ok) throw new PlayApiError(res.status, classifyGoogleError(res.status, body, 'token'))
  const json = JSON.parse(body) as { access_token?: string; expires_in?: number }
  if (!json.access_token) throw new PlayApiError(res.status, classifyGoogleError(500, 'the token response had no access_token'))
  return { accessToken: json.access_token, expiresInSec: Number(json.expires_in) || 3600 }
}

/** A markdown-free one-line summary of a track for the page and the report. */
export function describeTrack(t: TrackSummary): string {
  if (!t.releases.length) return `${t.track}: no release`
  const r = t.releases[0]
  const codes = r.versionCodes.length ? `version ${r.versionCodes.join(', ')}` : 'no version code'
  return `${t.track}: ${r.status ?? 'unknown status'}, ${codes}`
}
