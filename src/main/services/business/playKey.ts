import { createPrivateKey, createSign } from 'crypto'

/**
 * The Google service account key, and the JWT that turns it into an access token.
 *
 * Everything here is pure: it takes text in and gives values out, so the shape check and the
 * signature can be tested without a network call and without a real key. The private key is
 * never returned from `parseServiceAccountKey` — only the fields the UI is allowed to show
 * (the service account's email, the project, the key id). Callers that need the key itself
 * read it from the parsed object and hand it straight to `signJwt`.
 *
 * The route is Google's own: a service account signs a JWT with its private key, Google
 * exchanges that JWT for an OAuth access token, and the token is used against the Android
 * Publisher REST API. Expo's guide describes the same credential for EAS; Goga is not EAS,
 * so it does the two steps itself.
 */

export const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const PUBLISHER_BASE = 'https://androidpublisher.googleapis.com'
export const REPORTING_BASE = 'https://playdeveloperreporting.googleapis.com'

/** Both scopes in one token: publishing, and the app list the reporting API exposes. */
export const SCOPES = [
  'https://www.googleapis.com/auth/androidpublisher',
  'https://www.googleapis.com/auth/playdeveloperreporting',
].join(' ')

export interface ServiceAccountKey {
  type: 'service_account'
  project_id: string
  private_key_id: string | null
  private_key: string
  client_email: string
  client_id: string | null
  token_uri: string
}

/** What the UI may know about a stored key. Never the key itself. */
export interface ServiceAccountSummary {
  clientEmail: string
  projectId: string
  keyId: string | null
}

export type KeyParseResult =
  | { ok: true; key: ServiceAccountKey; summary: ServiceAccountSummary }
  | { ok: false; reason: string; fix: string }

const PEM_BEGIN = '-----BEGIN PRIVATE KEY-----'
const PEM_BEGIN_RSA = '-----BEGIN RSA PRIVATE KEY-----'

/**
 * Check a downloaded key file. The checks are the ones that actually matter: it is a service
 * account key (not an OAuth client, not a project file), it names an account, and the private
 * key is a PEM that Node can load. A file that fails any of these is refused with the reason
 * and where to get a correct one, rather than being stored and failing later at Google.
 */
export function parseServiceAccountKey(text: string): KeyParseResult {
  const raw = String(text ?? '').trim()
  if (!raw) {
    return { ok: false, reason: 'The file is empty.', fix: 'Download the JSON key again from Google Cloud → Service Accounts → Keys.' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      ok: false,
      reason: 'That file is not JSON. It may be the wrong download, or a page saved as a file.',
      fix: 'In Google Cloud → Service Accounts → Keys → Add key → Create new key → JSON, and use the .json file it downloads.',
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'That JSON is not a key file.', fix: 'Use the JSON key downloaded from the service account’s Keys tab.' }
  }
  const obj = parsed as Record<string, unknown>

  if (obj.type !== 'service_account') {
    const seen = typeof obj.type === 'string' ? obj.type : 'no type field'
    return {
      ok: false,
      reason: `This is not a service account key (its type is "${seen}").`,
      fix: 'An OAuth client file or a project file will not work. Create the key under Google Cloud → IAM & Admin → Service Accounts → your account → Keys → Add key → JSON.',
    }
  }

  const clientEmail = typeof obj.client_email === 'string' ? obj.client_email.trim() : ''
  if (!clientEmail || !clientEmail.includes('@')) {
    return { ok: false, reason: 'The key has no service account email (client_email).', fix: 'Download the key again from the service account’s Keys tab.' }
  }

  const projectId = typeof obj.project_id === 'string' ? obj.project_id.trim() : ''
  if (!projectId) {
    return { ok: false, reason: 'The key has no project id (project_id).', fix: 'Download the key again from the service account’s Keys tab.' }
  }

  const privateKey = typeof obj.private_key === 'string' ? obj.private_key : ''
  if (!privateKey.includes(PEM_BEGIN) && !privateKey.includes(PEM_BEGIN_RSA)) {
    return {
      ok: false,
      reason: 'The key has no usable private key (private_key is missing or not a PEM block).',
      fix: 'Download the key again as JSON. Do not paste the key into a text editor that rewrites line breaks.',
    }
  }
  try {
    createPrivateKey(privateKey)
  } catch {
    return {
      ok: false,
      reason: 'The private key in the file cannot be read — it is damaged or was edited.',
      fix: 'Create a new JSON key from the service account’s Keys tab and use that file unchanged.',
    }
  }

  const key: ServiceAccountKey = {
    type: 'service_account',
    project_id: projectId,
    private_key_id: typeof obj.private_key_id === 'string' ? obj.private_key_id : null,
    private_key: privateKey,
    client_email: clientEmail,
    client_id: typeof obj.client_id === 'string' ? obj.client_id : null,
    token_uri: typeof obj.token_uri === 'string' && obj.token_uri ? obj.token_uri : TOKEN_URL,
  }

  return {
    ok: true,
    key,
    summary: { clientEmail, projectId, keyId: key.private_key_id },
  }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface JwtOptions {
  /** Seconds since the epoch. Passed in so a test can pin the clock. */
  now?: number
  lifetimeSec?: number
  scope?: string
  audience?: string
}

/**
 * Sign the assertion Google wants for a service account. RS256 over
 * `base64url(header).base64url(claims)`, with the key id in the header so Google knows which
 * key signed it.
 */
export function signJwt(key: ServiceAccountKey, options: JwtOptions = {}): string {
  const now = Math.floor(options.now ?? Date.now() / 1000)
  const lifetime = Math.max(60, Math.min(options.lifetimeSec ?? 3600, 3600))
  const header = { alg: 'RS256', typ: 'JWT', ...(key.private_key_id ? { kid: key.private_key_id } : {}) }
  const claims = {
    iss: key.client_email,
    scope: options.scope ?? SCOPES,
    aud: options.audience ?? TOKEN_URL,
    iat: now,
    exp: now + lifetime,
  }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`
  const signature = createSign('RSA-SHA256').update(signingInput).sign(key.private_key)
  return `${signingInput}.${b64url(signature)}`
}

/** The form-encoded body for the token exchange. */
export function tokenRequestBody(assertion: string): string {
  return new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  }).toString()
}

export type GoogleFailure =
  | 'invalid-key'
  | 'access-denied'
  | 'api-disabled'
  | 'app-not-found'
  | 'quota'
  | 'upload-rejected'
  | 'network'
  | 'unknown'

export interface GoogleError {
  kind: GoogleFailure
  /** One line for the user, in plain words. */
  message: string
  /** The exact page that fixes it, when there is one. */
  fixUrl: string | null
  fixLabel: string | null
  /** The provider's own words, trimmed. Never contains a key. */
  detail: string
}

const PLAY_USERS_URL = 'https://play.google.com/console/u/1/developers/7935784357221763213/users-and-permissions'
const PLAY_HOME_URL = 'https://play.google.com/console/u/1/developers/7935784357221763213/home'
const CLOUD_APIS_URL = 'https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com'
const REPORTING_API_URL = 'https://console.cloud.google.com/apis/library/playdeveloperreporting.googleapis.com'

/**
 * Turn a Google error into the thing the user has to do.
 *
 * The failure that actually happens is not a bad key: it is a perfectly good service account
 * that was never invited in Play Console, or was invited without the release permissions.
 * Google answers that with a 403 that says "does not have permission", so that case is named
 * for what it is instead of being reported as an authentication problem.
 */
export function classifyGoogleError(status: number, body: string, context: 'token' | 'publisher' | 'reporting' = 'publisher'): GoogleError {
  const detail = String(body ?? '').replace(/\s+/g, ' ').trim().slice(0, 400)
  const lower = detail.toLowerCase()

  if (status === 0) {
    return {
      kind: 'network',
      message: 'Google could not be reached from this PC.',
      fixUrl: null, fixLabel: null, detail,
    }
  }

  if (status === 401 || lower.includes('invalid_grant') || lower.includes('invalid jwt')) {
    return {
      kind: 'invalid-key',
      message: 'Google rejected the key itself. It may have been deleted, or the clock on this PC may be wrong.',
      fixUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
      fixLabel: 'Open Service Accounts',
      detail,
    }
  }

  if (lower.includes('has not been used in project') || lower.includes('service_disabled') || lower.includes('accessnotconfigured') || lower.includes('is disabled')) {
    const reporting = context === 'reporting' || lower.includes('playdeveloperreporting')
    return {
      kind: 'api-disabled',
      message: reporting
        ? 'The Play Developer Reporting API is not enabled on this Google Cloud project. Goga needs it to list your apps.'
        : 'The Google Play Android Developer API is not enabled on this Google Cloud project.',
      fixUrl: reporting ? REPORTING_API_URL : CLOUD_APIS_URL,
      fixLabel: reporting ? 'Enable the Reporting API' : 'Enable the Android Developer API',
      detail,
    }
  }

  if (status === 403) {
    return {
      kind: 'access-denied',
      message: 'The key is valid, but this service account has no access to your Play Console. It has not been invited, or it was invited without the release permissions.',
      fixUrl: PLAY_USERS_URL,
      fixLabel: 'Open Users and permissions',
      detail,
    }
  }

  if (status === 404) {
    return {
      kind: 'app-not-found',
      message: 'Play has no app with that package name for this account, or the service account cannot see it.',
      fixUrl: PLAY_HOME_URL,
      fixLabel: 'Open Play Console',
      detail,
    }
  }

  if (status === 429) {
    return { kind: 'quota', message: 'Google is rate-limiting this account. Wait a few minutes and try again.', fixUrl: null, fixLabel: null, detail }
  }

  if (status === 400 && (lower.includes('bundle') || lower.includes('apk') || lower.includes('versioncode') || lower.includes('version code'))) {
    return {
      kind: 'upload-rejected',
      message: 'Play refused the bundle. The usual cause is a version code that is not higher than the one already on that track.',
      fixUrl: PLAY_HOME_URL,
      fixLabel: 'Open Play Console',
      detail,
    }
  }

  return {
    kind: 'unknown',
    message: `Google answered ${status || 'with an error'}.`,
    fixUrl: null, fixLabel: null, detail,
  }
}

/** Strip anything that looks like a private key before a message reaches a log or the UI. */
export function redactSecrets(text: string): string {
  return String(text ?? '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key removed]')
    .replace(/"private_key"\s*:\s*"[^"]*"/g, '"private_key":"[removed]"')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[token removed]')
}
