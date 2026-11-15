import fs from 'fs'
import { businessFile, ensureDirFor } from './paths'
import { nanoid } from '../../utils/nanoid'
import type {
  ApplicationDraft, ArtListingDraft, BuildProject, JobProfile, MonitoredApp, PlayTrack, SavedSearch,
  SocialPostDraft, TesterApp, TesterCandidate, TesterState, TesterWorkspace, WorkItem,
} from '../../../shared/business'
import { GOOGLE_OPT_IN_DAYS, GOOGLE_REQUIRED_TESTERS, isTesterState, newTesterApp, stateTransition } from './testers'

/**
 * Local storage for everything the business layer keeps: art drafts, social drafts, tester
 * candidates, monitored apps, build projects, the job profile, application drafts, work
 * items and saved searches.
 *
 * One JSON file, written 0600, under Goga's own user-data folder. Nothing here is sent
 * anywhere. When the folder is unavailable (a plain Node test process) the store keeps its
 * data in memory and says so, rather than writing somewhere unexpected.
 */

interface Store {
  listings: ArtListingDraft[]
  posts: SocialPostDraft[]
  testers: TesterWorkspace
  apps: MonitoredApp[]
  projects: BuildProject[]
  jobProfile: JobProfile
  applications: ApplicationDraft[]
  work: WorkItem[]
  searches: SavedSearch[]
}

export const DEFAULT_PACKAGE = 'com.base6a76745e0296d6adfc52539f.app'
export const DEAR_LOVED_ONE_PACKAGE = 'com.base692cc10480cefa8d26ea7080.app'
/** Read from the third build in the user's Downloads folder; its display name is not known. */
export const THIRD_PACKAGE = 'com.base69571f8a95f168d27bcb47ca.app'

export function emptyProfile(): JobProfile {
  return {
    headline: '', skills: [], portfolio: [], rateFloor: 0, currency: 'USD',
    availability: '', timezone: '', kinds: [], summary: '', updatedAt: null,
  }
}

/**
 * The tracker starts with the apps whose packages are known: Only3 and Dear Loved One, both
 * Base44-generated. The third app is added from the page once its package name is known —
 * guessing it would only make the record wrong.
 */
function freshTesters(): TesterWorkspace {
  const only3 = newTesterApp({
    name: 'Only3', packageName: DEFAULT_PACKAGE, track: 'closed',
    required: GOOGLE_REQUIRED_TESTERS, optInDays: GOOGLE_OPT_IN_DAYS,
    notes: 'Published through Base44; developer account Alonya Red Labs.',
    id: 'app-only3',
  })
  const dear = newTesterApp({
    name: 'Dear Loved One', packageName: DEAR_LOVED_ONE_PACKAGE, track: 'closed',
    required: GOOGLE_REQUIRED_TESTERS, optInDays: GOOGLE_OPT_IN_DAYS,
    notes: 'Published through Base44; developer account Alonya Red Labs.',
    id: 'app-dear-loved-one',
  })
  // The third app: its package was read from the build on this machine, but its name is not
  // known, so the name is left empty rather than invented. The page shows the package.
  const third = newTesterApp({
    name: '', packageName: THIRD_PACKAGE, track: 'closed',
    required: GOOGLE_REQUIRED_TESTERS, optInDays: GOOGLE_OPT_IN_DAYS,
    notes: 'Name not recorded yet — rename it here once you know it.',
    id: 'app-third',
  })
  return { apps: [only3, dear, third], copyDrafts: [] }
}

function fresh(): Store {
  return {
    listings: [], posts: [],
    testers: freshTesters(),
    apps: [], projects: [],
    jobProfile: emptyProfile(),
    applications: [], work: [], searches: [],
  }
}

/**
 * Bring an older single-app tester record forward: whatever was on the one list becomes
 * Only3's list, and the old flat states map onto the new ones. Nothing is thrown away, and
 * no tester is invented.
 */
function migrateTesters(raw: unknown): TesterWorkspace {
  const base = freshTesters()
  const known = (apps: TesterApp[]): TesterWorkspace['apps'] => {
    // Keep the two apps whose packages are known even if an older file predates one of them.
    for (const b of base.apps) {
      if (!apps.some(a => a.packageName === b.packageName || a.id === b.id)) apps = [...apps, b]
    }
    return apps
  }
  if (!raw || typeof raw !== 'object') return base
  const old = raw as Partial<TesterWorkspace> & {
    packageName?: string; required?: number
    candidates?: Partial<TesterCandidate & { state: string }>[]
  }
  if (Array.isArray(old.apps)) {
    return {
      apps: known(old.apps.map(a => ({
        ...newTesterApp({ name: a.name, packageName: a.packageName, id: a.id }),
        ...a,
        candidates: Array.isArray(a.candidates) ? a.candidates : [],
      }))),
      copyDrafts: Array.isArray(old.copyDrafts) ? old.copyDrafts : [],
    }
  }
  if (!Array.isArray(old.candidates)) return { ...base, copyDrafts: Array.isArray(old.copyDrafts) ? old.copyDrafts : [] }
  const legacyState = (s: string): TesterState => {
    if (s === 'declined' || s === 'removed') return 'dropped'
    return isTesterState(s) ? s : 'candidate'
  }
  const only3 = base.apps[0]
  const migrated: TesterApp = {
    ...only3,
    packageName: String(old.packageName ?? '').trim() || only3.packageName,
    required: Number(old.required) > 0 ? Math.floor(Number(old.required)) : GOOGLE_REQUIRED_TESTERS,
    candidates: old.candidates.map(c => ({
      id: c.id ?? nanoid(),
      name: String(c.name ?? ''),
      email: String(c.email ?? ''),
      source: String(c.source ?? ''),
      state: legacyState(String(c.state ?? 'candidate')),
      invitedAt: c.invitedAt ?? null,
      acceptedAt: null,
      installedAt: null,
      optedInAt: c.optedInAt ?? null,
      droppedAt: null,
      notes: String(c.notes ?? ''),
    })),
  }
  return { apps: [migrated], copyDrafts: Array.isArray(old.copyDrafts) ? old.copyDrafts : [] }
}

let memory: Store | null = null

function load(): Store {
  const file = businessFile('goga-business-store.json')
  if (!file) return memory ??= fresh()
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Store>
    const base = fresh()
    return {
      ...base,
      ...raw,
      testers: migrateTesters(raw.testers),
      jobProfile: { ...base.jobProfile, ...(raw.jobProfile ?? {}) },
      listings: raw.listings ?? [], posts: raw.posts ?? [], apps: raw.apps ?? [],
      projects: raw.projects ?? [], applications: raw.applications ?? [],
      work: raw.work ?? [], searches: raw.searches ?? [],
    }
  } catch { return memory ??= fresh() }
}

function save(store: Store): void {
  const file = businessFile('goga-business-store.json')
  if (!file) { memory = store; return }
  ensureDirFor(file)
  fs.writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 })
}

// ── art listings ────────────────────────────────────────────────────────────

export function listListings(): ArtListingDraft[] { return load().listings }

export function addListing(input: Omit<ArtListingDraft, 'id' | 'createdAt' | 'status' | 'remoteId' | 'remoteUrl' | 'error'>): ArtListingDraft {
  const s = load()
  const listing: ArtListingDraft = {
    ...input, id: nanoid(), createdAt: new Date().toISOString(),
    status: 'draft', remoteId: null, remoteUrl: null, error: null,
  }
  s.listings = [listing, ...s.listings]
  save(s)
  return listing
}

export function updateListing(id: string, patch: Partial<ArtListingDraft>): ArtListingDraft {
  const s = load()
  const i = s.listings.findIndex(l => l.id === id)
  if (i < 0) throw new Error('no such listing draft')
  s.listings[i] = { ...s.listings[i], ...patch, id: s.listings[i].id, createdAt: s.listings[i].createdAt }
  save(s)
  return s.listings[i]
}

export function deleteListing(id: string): void {
  const s = load()
  s.listings = s.listings.filter(l => l.id !== id)
  save(s)
}

// ── social drafts ───────────────────────────────────────────────────────────

export function listPosts(): SocialPostDraft[] { return load().posts }

export function addPost(input: Omit<SocialPostDraft, 'id' | 'createdAt' | 'status' | 'remoteUrl' | 'error'>): SocialPostDraft {
  const s = load()
  const post: SocialPostDraft = {
    ...input, id: nanoid(), createdAt: new Date().toISOString(),
    status: 'draft', remoteUrl: null, error: null,
  }
  s.posts = [post, ...s.posts]
  save(s)
  return post
}

export function updatePost(id: string, patch: Partial<SocialPostDraft>): SocialPostDraft {
  const s = load()
  const i = s.posts.findIndex(p => p.id === id)
  if (i < 0) throw new Error('no such post draft')
  s.posts[i] = { ...s.posts[i], ...patch, id: s.posts[i].id, createdAt: s.posts[i].createdAt }
  save(s)
  return s.posts[i]
}

export function deletePost(id: string): void {
  const s = load()
  s.posts = s.posts.filter(p => p.id !== id)
  save(s)
}

// ── testers ─────────────────────────────────────────────────────────────────

export function testerWorkspace(): TesterWorkspace { return load().testers }

/** The app record, or a clear error. Every tester write names its app. */
function findApp(s: Store, appId: string): TesterApp {
  const app = s.testers.apps.find(a => a.id === appId)
  if (!app) throw new Error('no such app in the tracker')
  return app
}

function touch(app: TesterApp): void { app.updatedAt = new Date().toISOString() }

/** Add an app to the tracker. The package name is required; the id is generated here. */
export function addTesterApp(input: {
  name: string; packageName: string; track?: PlayTrack; required?: number; optInDays?: number; notes?: string
}): TesterApp {
  const packageName = String(input.packageName ?? '').trim()
  if (!packageName) throw new Error('an app needs its package name')
  if (!/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(packageName)) throw new Error('that does not look like an Android package name (com.example.app)')
  const s = load()
  if (s.testers.apps.some(a => a.packageName === packageName)) throw new Error('that package is already being tracked')
  const app = newTesterApp({ ...input, packageName })
  s.testers.apps = [...s.testers.apps, app]
  save(s)
  return app
}

export function updateTesterApp(appId: string, patch: Partial<Pick<TesterApp, 'name' | 'track' | 'required' | 'optInDays' | 'notes'>>): TesterApp {
  const s = load()
  const app = findApp(s, appId)
  if (patch.name !== undefined) app.name = String(patch.name).trim()
  if (patch.track !== undefined) app.track = patch.track
  if (patch.required !== undefined && Number(patch.required) > 0) app.required = Math.floor(Number(patch.required))
  if (patch.optInDays !== undefined && Number(patch.optInDays) > 0) app.optInDays = Math.floor(Number(patch.optInDays))
  if (patch.notes !== undefined) app.notes = String(patch.notes)
  touch(app)
  save(s)
  return app
}

/** Remove an app and its testers. The candidates go with it, because they belong to it. */
export function removeTesterApp(appId: string): void {
  const s = load()
  s.testers.apps = s.testers.apps.filter(a => a.id !== appId)
  save(s)
}

export function addTester(input: {
  appId: string; name: string; email: string; source: string; notes: string; state?: TesterState; optedInAt?: string | null
}): TesterCandidate {
  const email = String(input.email ?? '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('that does not look like an email address')
  const s = load()
  const app = findApp(s, input.appId)
  if (app.candidates.some(c => c.email === email)) throw new Error('that address is already on this app’s list')
  const state: TesterState = isTesterState(input.state) ? input.state : 'candidate'
  const candidate: TesterCandidate = {
    id: nanoid(), name: String(input.name ?? '').trim(), email,
    source: String(input.source ?? '').trim(), state,
    invitedAt: state === 'invited' || state === 'accepted' || state === 'installed' || state === 'opted-in' ? new Date().toISOString() : null,
    acceptedAt: null, installedAt: null,
    optedInAt: state === 'opted-in' ? (input.optedInAt ?? new Date().toISOString()) : null,
    droppedAt: null,
    notes: String(input.notes ?? '').trim(),
  }
  app.candidates = [candidate, ...app.candidates]
  touch(app)
  save(s)
  return candidate
}

export function updateTester(appId: string, id: string, patch: Partial<TesterCandidate>): TesterCandidate {
  const s = load()
  const app = findApp(s, appId)
  const i = app.candidates.findIndex(c => c.id === id)
  if (i < 0) throw new Error('no such candidate')
  const next = { ...app.candidates[i], ...patch, id: app.candidates[i].id, email: app.candidates[i].email }
  app.candidates[i] = next
  touch(app)
  save(s)
  return next
}

/**
 * Move a tester to a new state, filling in the date that state needs. The state machine and
 * the dates live in `testers.ts` so they are tested on their own.
 */
export function setTesterState(appId: string, id: string, state: TesterState, at?: string | null, optedInAt?: string | null): TesterCandidate {
  const s = load()
  const app = findApp(s, appId)
  const existing = app.candidates.find(c => c.id === id)
  if (!existing) throw new Error('no such candidate')
  const patch = stateTransition(existing, state, new Date(), at)
  if (state === 'opted-in' && optedInAt) patch.optedInAt = optedInAt
  return updateTester(appId, id, patch)
}

export function removeTester(appId: string, id: string): void {
  const s = load()
  const app = findApp(s, appId)
  app.candidates = app.candidates.filter(c => c.id !== id)
  touch(app)
  save(s)
}

export function addTesterCopy(channel: string, text: string): TesterWorkspace['copyDrafts'][number] {
  const s = load()
  const draft = { id: nanoid(), createdAt: new Date().toISOString(), channel: String(channel ?? '').trim() || 'general', text: String(text ?? '') }
  s.testers.copyDrafts = [draft, ...s.testers.copyDrafts]
  save(s)
  return draft
}

export function deleteTesterCopy(id: string): void {
  const s = load()
  s.testers.copyDrafts = s.testers.copyDrafts.filter(d => d.id !== id)
  save(s)
}

// ── monitored apps ──────────────────────────────────────────────────────────

export function listApps(): MonitoredApp[] { return load().apps }

export function addApp(input: { name: string; url: string; packageName: string; liveVersion: string; publishedWhere: string }): MonitoredApp {
  const url = String(input.url ?? '').trim()
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error('that is not a URL Goga can poll') }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('only http and https can be polled')
  const s = load()
  const app: MonitoredApp = {
    id: nanoid(), name: String(input.name ?? '').trim() || parsed.hostname, url: parsed.toString(),
    packageName: String(input.packageName ?? '').trim(), liveVersion: String(input.liveVersion ?? '').trim(),
    lastPublishedAt: null, publishedWhere: String(input.publishedWhere ?? '').trim(),
    checks: [], createdAt: new Date().toISOString(),
  }
  s.apps = [app, ...s.apps]
  save(s)
  return app
}

export function updateApp(id: string, patch: Partial<MonitoredApp>): MonitoredApp {
  const s = load()
  const i = s.apps.findIndex(a => a.id === id)
  if (i < 0) throw new Error('no such app')
  s.apps[i] = { ...s.apps[i], ...patch, id: s.apps[i].id, createdAt: s.apps[i].createdAt }
  save(s)
  return s.apps[i]
}

export function removeApp(id: string): void {
  const s = load()
  s.apps = s.apps.filter(a => a.id !== id)
  save(s)
}

/** Keep the most recent 500 checks per app, so the file cannot grow without bound. */
export function appendCheck(id: string, check: MonitoredApp['checks'][number]): MonitoredApp {
  const s = load()
  const i = s.apps.findIndex(a => a.id === id)
  if (i < 0) throw new Error('no such app')
  s.apps[i] = { ...s.apps[i], checks: [...s.apps[i].checks, check].slice(-500) }
  save(s)
  return s.apps[i]
}

// ── build projects ──────────────────────────────────────────────────────────

export function listProjects(): BuildProject[] { return load().projects }

export function addProject(project: BuildProject): BuildProject {
  const s = load()
  s.projects = [project, ...s.projects.filter(p => p.dir !== project.dir)]
  save(s)
  return project
}

export function updateProject(id: string, patch: Partial<BuildProject>): BuildProject {
  const s = load()
  const i = s.projects.findIndex(p => p.id === id)
  if (i < 0) throw new Error('no such project')
  s.projects[i] = { ...s.projects[i], ...patch, id: s.projects[i].id }
  save(s)
  return s.projects[i]
}

export function removeProject(id: string): void {
  const s = load()
  s.projects = s.projects.filter(p => p.id !== id)
  save(s)
}

// ── freelance ───────────────────────────────────────────────────────────────

export function jobProfile(): JobProfile { return load().jobProfile }

export function saveJobProfile(patch: Partial<JobProfile>): JobProfile {
  const s = load()
  s.jobProfile = { ...s.jobProfile, ...patch, updatedAt: new Date().toISOString() }
  save(s)
  return s.jobProfile
}

export function listApplications(): ApplicationDraft[] { return load().applications }

export function addApplication(input: Omit<ApplicationDraft, 'id' | 'createdAt' | 'status' | 'submittedAt'>): ApplicationDraft {
  const s = load()
  const draft: ApplicationDraft = {
    ...input, id: nanoid(), createdAt: new Date().toISOString(), status: 'draft', submittedAt: null,
  }
  s.applications = [draft, ...s.applications]
  save(s)
  return draft
}

export function updateApplication(id: string, patch: Partial<ApplicationDraft>): ApplicationDraft {
  const s = load()
  const i = s.applications.findIndex(a => a.id === id)
  if (i < 0) throw new Error('no such application draft')
  s.applications[i] = { ...s.applications[i], ...patch, id: s.applications[i].id, createdAt: s.applications[i].createdAt }
  save(s)
  return s.applications[i]
}

export function deleteApplication(id: string): void {
  const s = load()
  s.applications = s.applications.filter(a => a.id !== id)
  save(s)
}

export function listWork(): WorkItem[] { return load().work }

export function addWork(input: Omit<WorkItem, 'id' | 'createdAt'>): WorkItem {
  const s = load()
  const item: WorkItem = { ...input, id: nanoid(), createdAt: new Date().toISOString() }
  s.work = [item, ...s.work]
  save(s)
  return item
}

export function updateWork(id: string, patch: Partial<WorkItem>): WorkItem {
  const s = load()
  const i = s.work.findIndex(w => w.id === id)
  if (i < 0) throw new Error('no such work item')
  s.work[i] = { ...s.work[i], ...patch, id: s.work[i].id, createdAt: s.work[i].createdAt }
  save(s)
  return s.work[i]
}

export function deleteWork(id: string): void {
  const s = load()
  s.work = s.work.filter(w => w.id !== id)
  save(s)
}

export function listSearches(): SavedSearch[] { return load().searches }

export function addSearch(input: Omit<SavedSearch, 'id' | 'createdAt'>): SavedSearch {
  const s = load()
  const search: SavedSearch = { ...input, id: nanoid(), createdAt: new Date().toISOString() }
  s.searches = [search, ...s.searches]
  save(s)
  return search
}

export function deleteSearch(id: string): void {
  const s = load()
  s.searches = s.searches.filter(x => x.id !== id)
  save(s)
}
