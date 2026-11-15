import { generateKeyPairSync, createVerify } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  classifyGoogleError, parseServiceAccountKey, redactSecrets, signJwt, tokenRequestBody, type ServiceAccountKey,
} from '../business/playKey'
import { PlayClient, fetchAccessToken, PlayApiError, describeTrack } from '../business/play'
import { highestVersionCode, prepareSubmission } from '../business/playService'
import { consumeApproval, denyAction, getPending, prepareAction } from '../business/audit'

/**
 * The Play credential and the API calls it makes.
 *
 * Nothing here signs against Google: there is no key on this machine, and inventing one would
 * only test Google's servers. What is tested is everything Goga does on its own — the shape
 * check, the JWT bytes and their signature, the error mapping, and the order of the upload
 * calls with a fake fetch standing in for Google.
 */

/** A throwaway RSA key, generated here, used only to sign and then verify locally. */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

function keyFile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'goga-play-test',
    private_key_id: 'abc123def456',
    private_key: privatePem,
    client_email: 'goga-play@goga-play-test.iam.gserviceaccount.com',
    client_id: '1234567890',
    token_uri: 'https://oauth2.googleapis.com/token',
    ...overrides,
  })
}

const decode = (part: string) => JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))

describe('a downloaded service account key', () => {
  it('accepts a real-shaped key and reports only the harmless fields', () => {
    const r = parseServiceAccountKey(keyFile())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.summary.clientEmail).toBe('goga-play@goga-play-test.iam.gserviceaccount.com')
    expect(r.summary.projectId).toBe('goga-play-test')
    expect(r.summary.keyId).toBe('abc123def456')
    // The summary is what the renderer sees, and it must not carry the key.
    expect(JSON.stringify(r.summary)).not.toContain('PRIVATE KEY')
  })

  it('refuses an OAuth client file, which is the wrong download from the same console', () => {
    const r = parseServiceAccountKey(JSON.stringify({ type: 'authorized_user', client_id: 'x', refresh_token: 'y' }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('authorized_user')
    expect(r.fix).toContain('Service Accounts')
  })

  it('refuses a file that is not JSON at all', () => {
    const r = parseServiceAccountKey('<html>not a key</html>')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('not JSON')
  })

  it('refuses an empty file', () => {
    expect(parseServiceAccountKey('   ').ok).toBe(false)
  })

  it('refuses a key whose private key is missing or damaged', () => {
    const missing = parseServiceAccountKey(keyFile({ private_key: '' }))
    expect(missing.ok).toBe(false)
    const damaged = parseServiceAccountKey(keyFile({ private_key: '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n' }))
    expect(damaged.ok).toBe(false)
    if (!damaged.ok) expect(damaged.reason).toContain('cannot be read')
  })

  it('refuses a key with no service account email', () => {
    const r = parseServiceAccountKey(keyFile({ client_email: '' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('client_email')
  })

  it('refuses a file with no project id', () => {
    const r = parseServiceAccountKey(keyFile({ project_id: '' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('project_id')
  })
})

describe('the JWT Google is given', () => {
  const key = (parseServiceAccountKey(keyFile()) as { ok: true; key: ServiceAccountKey }).key

  it('has the header, claims and signature Google expects', () => {
    const jwt = signJwt(key, { now: 1_700_000_000 })
    const [h, c, s] = jwt.split('.')
    expect(decode(h)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'abc123def456' })
    const claims = decode(c)
    expect(claims.iss).toBe('goga-play@goga-play-test.iam.gserviceaccount.com')
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token')
    expect(claims.iat).toBe(1_700_000_000)
    expect(claims.exp).toBe(1_700_003_600)
    expect(claims.scope).toContain('androidpublisher')
    expect(claims.scope).toContain('playdeveloperreporting')
    // The signature must verify against the matching public key, over exactly those bytes.
    const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
    expect(ok).toBe(true)
  })

  it('caps the lifetime at an hour, because Google rejects longer ones', () => {
    const claims = decode(signJwt(key, { now: 1_000, lifetimeSec: 99_999 }).split('.')[1])
    expect(claims.exp - claims.iat).toBe(3600)
  })

  it('never puts the private key in the token', () => {
    const jwt = signJwt(key)
    expect(jwt).not.toContain('PRIVATE')
    expect(jwt.includes(privatePem.split('\n')[1])).toBe(false)
  })

  it('builds the jwt-bearer form body', () => {
    const body = new URLSearchParams(tokenRequestBody('a.b.c'))
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(body.get('assertion')).toBe('a.b.c')
  })
})

describe('what a Google error means for the user', () => {
  it('names the un-invited service account, not a bad key', () => {
    const e = classifyGoogleError(403, '{"error":{"message":"The caller does not have permission"}}')
    expect(e.kind).toBe('access-denied')
    expect(e.message).toContain('no access to your Play Console')
    expect(e.message).toContain('invited')
    expect(e.fixUrl).toContain('7935784357221763213/users-and-permissions')
  })

  it('separates a rejected key from a missing permission', () => {
    expect(classifyGoogleError(401, 'invalid_grant').kind).toBe('invalid-key')
    expect(classifyGoogleError(401, 'Invalid JWT Signature.').kind).toBe('invalid-key')
  })

  it('names the disabled API and which one to enable', () => {
    const publisher = classifyGoogleError(403, 'Google Play Android Developer API has not been used in project 1 before or it is disabled')
    expect(publisher.kind).toBe('api-disabled')
    expect(publisher.fixUrl).toContain('androidpublisher.googleapis.com')

    const reporting = classifyGoogleError(403, 'Play Developer Reporting API has not been used in project 1', 'reporting')
    expect(reporting.kind).toBe('api-disabled')
    expect(reporting.fixUrl).toContain('playdeveloperreporting')
  })

  it('calls a version-code rejection a rejected bundle, not a generic error', () => {
    const e = classifyGoogleError(400, '{"error":{"message":"APK or bundle has version code 3 which is not greater than 3"}}')
    expect(e.kind).toBe('upload-rejected')
    expect(e.message).toContain('version code')
  })

  it('treats no answer as a network failure, never as success', () => {
    const e = classifyGoogleError(0, '')
    expect(e.kind).toBe('network')
    expect(e.message).toContain('could not be reached')
  })

  it('strips a private key or a JWT out of anything it is given', () => {
    const dirty = `failed with ${privatePem} and {"private_key":"abcdef"} token eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ4In0.c2lnbmF0dXJlaGVyZQ`
    const clean = redactSecrets(dirty)
    expect(clean).not.toContain('PRIVATE KEY')
    expect(clean).not.toContain('abcdef')
    expect(clean).not.toContain('eyJhbGciOiJSUzI1NiJ9')
    expect(clean).toContain('[private key removed]')
  })
})

// ── the API calls, against a fake Google ────────────────────────────────────

interface Call { method: string; url: string; body?: unknown }

function fakeGoogle(handlers: { match: RegExp; method?: string; status?: number; body: unknown }[]) {
  const calls: Call[] = []
  const impl = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ method, url: String(url), body: init?.body })
    const h = handlers.find(x => x.match.test(String(url)) && (!x.method || x.method === method))
    if (!h) throw new Error(`no fake for ${method} ${url}`)
    return {
      ok: (h.status ?? 200) < 400,
      status: h.status ?? 200,
      text: async () => (typeof h.body === 'string' ? h.body : JSON.stringify(h.body)),
    } as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('reading Play without changing it', () => {
  it('lists the apps the key can see', async () => {
    const { impl, calls } = fakeGoogle([
      { match: /apps:search/, body: { apps: [{ packageName: 'com.one.app', displayName: 'One' }, { packageName: 'com.two.app', displayName: 'Two' }] } },
    ])
    const client = new PlayClient({ getToken: async () => 'tok', fetchImpl: impl })
    const apps = await client.listApps()
    expect(apps.map(a => a.packageName)).toEqual(['com.one.app', 'com.two.app'])
    expect(calls[0].url).toContain('v1beta1/apps:search')
  })

  it('opens an edit, reads the tracks, and deletes the edit', async () => {
    const { impl, calls } = makeReadFakes()
    const client = new PlayClient({ getToken: async () => 'tok', fetchImpl: impl })
    const editId = await client.insertEdit('com.one.app')
    const tracks = await client.listTracks('com.one.app', editId)
    await client.deleteEdit('com.one.app', editId)
    expect(tracks[0].track).toBe('internal')
    expect(tracks[0].releases[0].versionCodes).toEqual(['7'])
    expect(describeTrack(tracks[0])).toBe('internal: completed, version 7')
    // Order matters: the delete is last, so the read left nothing behind.
    expect(calls.map(c => c.method)).toEqual(['POST', 'GET', 'DELETE'])
  })

  it('parses a 403 into the invited-permission error, not a crash', async () => {
    const { impl } = fakeGoogle([{ match: /edits$/, method: 'POST', status: 403, body: { error: { message: 'The caller does not have permission' } } }])
    const client = new PlayClient({ getToken: async () => 'tok', fetchImpl: impl })
    await expect(client.insertEdit('com.one.app')).rejects.toBeInstanceOf(PlayApiError)
    try {
      await client.insertEdit('com.one.app')
    } catch (err) {
      expect((err as PlayApiError).google.kind).toBe('access-denied')
    }
  })

  it('exchanges the assertion for a token and reports a refusal', async () => {
    const good = fakeGoogle([{ match: /token/, method: 'POST', body: { access_token: 'ya29.x', expires_in: 3599 } }])
    const t = await fetchAccessToken('assertion', good.impl)
    expect(t.accessToken).toBe('ya29.x')
    expect(t.expiresInSec).toBe(3599)

    const bad = fakeGoogle([{ match: /token/, method: 'POST', status: 400, body: { error: 'invalid_grant' } }])
    await expect(fetchAccessToken('assertion', bad.impl)).rejects.toBeInstanceOf(PlayApiError)
  })
})

function makeReadFakes() {
  return fakeGoogle([
    { match: /\/edits$/, method: 'POST', body: { id: 'edit-1' } },
    { match: /\/tracks$/, method: 'GET', body: { tracks: [{ track: 'internal', releases: [{ name: null, versionCodes: [7], status: 'completed', releaseNotes: [{ language: 'en-US', text: 'first' }] }] }] } },
    { match: /\/edits\/edit-1$/, method: 'DELETE', body: {} },
  ])
}

describe('the upload, with Google faked', () => {
  it('uploads, sets the track and commits, in that order', async () => {
    const { impl, calls } = fakeGoogle([
      { match: /\/edits$/, method: 'POST', body: { id: 'e1' } },
      { match: /bundles\?uploadType=media/, method: 'POST', body: { versionCode: 12, sha1: 'aa' } },
      { match: /\/tracks\/internal$/, method: 'PUT', body: { track: 'internal', releases: [{ versionCodes: [12], status: 'completed' }] } },
      { match: /:commit$/, method: 'POST', body: {} },
    ])
    const client = new PlayClient({ getToken: async () => 'tok', fetchImpl: impl })
    const editId = await client.insertEdit('com.one.app')
    const up = await client.uploadBundle('com.one.app', editId, Buffer.from([0x50, 0x4b, 3, 4]))
    expect(up.versionCode).toBe('12')
    await client.setTrackRelease('com.one.app', editId, { track: 'internal', versionCode: '12', releaseNotes: 'notes', language: 'en-US' })
    await client.commitEdit('com.one.app', editId)
    expect(calls.map(c => c.method)).toEqual(['POST', 'POST', 'PUT', 'POST'])
    expect(calls[1].url).toContain('/upload/androidpublisher/v3/applications/com.one.app/edits/e1/bundles')
    const putBody = JSON.parse(String(calls[2].body))
    expect(putBody.releases[0].releaseNotes[0]).toEqual({ language: 'en-US', text: 'notes' })
  })

  it('reports a refused commit with Play’s own words, redacted', async () => {
    const { impl } = fakeGoogle([
      { match: /\/edits$/, method: 'POST', body: { id: 'e1' } },
      { match: /bundles/, method: 'POST', body: { versionCode: 3 } },
      { match: /:commit$/, method: 'POST', status: 403, body: { error: { message: 'The caller does not have permission' } } },
    ])
    const client = new PlayClient({ getToken: async () => 'tok', fetchImpl: impl })
    const editId = await client.insertEdit('com.one.app')
    await client.uploadBundle('com.one.app', editId, Buffer.from('x'))
    await expect(client.commitEdit('com.one.app', editId)).rejects.toMatchObject({
      google: expect.objectContaining({ kind: 'access-denied' }),
    })
  })
})

describe('the approval that gates an upload', () => {
  it('is single use, and cannot be spent on a different kind of action', () => {
    const a = prepareAction('release-publish', 'Upload app.aab to com.one.app — internal, version 5', 'Package: com.one.app')
    // A mail approval cannot be spent on this, and this one cannot be spent on a mail.
    expect(consumeApproval(a.id, 'mail-send').ok).toBe(false)
    expect(consumeApproval(a.id, 'release-publish').ok).toBe(true)
    expect(consumeApproval(a.id, 'release-publish').ok).toBe(false)
  })

  it('leaves nothing to approve once denied', () => {
    const a = prepareAction('release-publish', 'Upload app.aab', 'Package: com.one.app')
    expect(denyAction(a.id).ok).toBe(true)
    expect(getPending(a.id)).toBeNull()
    expect(consumeApproval(a.id, 'release-publish').ok).toBe(false)
  })
})

describe('the next version code', () => {  it('takes the highest code across every track and adds one', () => {
    const baseline = {
      readAt: '2026-11-11T00:00:00Z',
      error: null,
      note: '',
      apps: [
        { packageName: 'a', displayName: 'A', error: null, tracks: [{ track: 'internal', releases: [{ name: null, versionCodes: ['3', '9'], status: 'completed', releaseNotes: [] }] }] },
        { packageName: 'b', displayName: 'B', error: null, tracks: [{ track: 'beta', releases: [{ name: null, versionCodes: ['11'], status: 'completed', releaseNotes: [] }] }] },
      ],
    }
    expect(highestVersionCode(baseline)).toBe('12')
  })

  it('says nothing when Play showed no numbers', () => {
    expect(highestVersionCode({ readAt: null, apps: [], error: null, note: '' })).toBeNull()
  })
})

describe('preparing an upload, which uploads nothing', () => {
  it('refuses a production release outright, before anything else is considered', () => {
    const r = prepareSubmission({ packageName: 'com.one.app', track: 'production', aabPath: 'x.aab', versionCode: '5', releaseNotes: 'n' })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('testing tracks only')
    expect(r.submission).toBeNull()
  })

  it('refuses an unknown track, a bad package name and a missing version code', () => {
    expect(prepareSubmission({ packageName: 'com.one.app', track: 'nightly', aabPath: 'x.aab', versionCode: '5', releaseNotes: 'n' }).message).toContain('Choose a track')
    expect(prepareSubmission({ packageName: 'not a package', track: 'internal', aabPath: 'x.aab', versionCode: '5', releaseNotes: 'n' }).message).toContain('package name')
    expect(prepareSubmission({ packageName: 'com.one.app', track: 'internal', aabPath: 'x.aab', versionCode: 'five', releaseNotes: 'n' }).message).toContain('whole number')
    expect(prepareSubmission({ packageName: 'com.one.app', track: 'internal', aabPath: 'x.aab', versionCode: '5', releaseNotes: '  ' }).message).toContain('release notes')
  })

  it('refuses an .apk, a missing file, and a file that is not a zip', () => {
    expect(prepareSubmission({ packageName: 'com.one.app', track: 'internal', aabPath: 'app.apk', versionCode: '5', releaseNotes: 'n' }).message).toContain('.aab')
    const missing = path.join(os.tmpdir(), 'goga-no-such-bundle.aab')
    expect(prepareSubmission({ packageName: 'com.one.app', track: 'internal', aabPath: missing, versionCode: '5', releaseNotes: 'n' }).message).toContain('not there')

    const notZip = path.join(os.tmpdir(), 'goga-not-a-bundle.aab')
    fs.writeFileSync(notZip, 'this is a text file with an aab extension')
    try {
      expect(prepareSubmission({ packageName: 'com.one.app', track: 'internal', aabPath: notZip, versionCode: '5', releaseNotes: 'n' }).message).toContain('zip')
    } finally { fs.unlinkSync(notZip) }
  })

  it('refuses a real-looking bundle when no key is stored, and queues nothing', () => {
    const bundle = path.join(os.tmpdir(), 'goga-fake-bundle.aab')
    fs.writeFileSync(bundle, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))
    try {
      const r = prepareSubmission({ packageName: 'com.one.app', track: 'internal', aabPath: bundle, versionCode: '5', releaseNotes: 'first build' })
      expect(r.ok).toBe(false)
      expect(r.message).toContain('No service account key')
      expect(r.submission).toBeNull()
    } finally { fs.unlinkSync(bundle) }
  })
})
