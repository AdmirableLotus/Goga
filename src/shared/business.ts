/**
 * Business layer types: the user's own accounts, their inbox and social presence,
 * their art, their apps, and their freelance work.
 *
 * The rule these types exist to enforce: Goga reads and drafts. Anything that leaves
 * the machine — a mail, a post, a listing, an invite, a release, an application — is
 * prepared as a pending action with its full content, and only runs after the user
 * approves that exact action.
 */

// ── connections ─────────────────────────────────────────────────────────────

export type ConnectionId = 'gmail' | 'bluesky' | 'mastodon' | 'shopify' | 'printful'

export type ConnectionState = 'connected' | 'expired' | 'needs-reauth' | 'not-connected' | 'error'

export type ConnectionKind = 'email' | 'social' | 'storefront'

/** How the user proves it is their account. Never a password typed into Goga. */
export type AuthKind = 'oauth' | 'app-password' | 'token'

export interface ConnectionView {
  id: ConnectionId
  name: string
  kind: ConnectionKind
  authKind: AuthKind
  state: ConnectionState
  /** The account Goga is signed in as, when the provider tells us. Never a secret. */
  account: string | null
  /** One line on what is wrong, when something is. */
  detail: string
  /** What Goga can actually do with this connection, in plain words. */
  capabilities: string[]
  /** What it cannot do, and why. */
  limits: string[]
  /** Where the user gets the credential. */
  where: string
  encryptionAvailable: boolean
  lastCheckedAt: string | null
}

/** A platform Goga deliberately does not automate, with the reason. */
export interface DeclinedPlatform {
  name: string
  reason: string
  manualPath: string
}

// ── digest ──────────────────────────────────────────────────────────────────

export interface DigestMailItem {
  id: string
  threadId: string
  from: string
  subject: string
  snippet: string
  receivedAt: string
  unread: boolean
  important: boolean
  /** True when the last message in the thread is from someone else. */
  needsReply: boolean
  /** The real Gmail link for this message. */
  url: string
}

export interface DigestSocialItem {
  id: string
  platform: 'bluesky' | 'mastodon'
  kind: 'mention' | 'reply' | 'message' | 'follow' | 'repost' | 'like' | 'quote'
  author: string
  text: string
  createdAt: string
  /** The real permalink, when the platform gives one. */
  url: string | null
  unread: boolean
}

export interface Digest {
  generatedAt: string
  mail: {
    connected: boolean
    unread: number
    important: number
    needsReply: number
    items: DigestMailItem[]
    error: string | null
  }
  social: {
    connected: boolean
    items: DigestSocialItem[]
    byPlatform: { platform: string; count: number; error: string | null }[]
  }
  /** Written by the local model from the items above, or a plain count when it is off. */
  summary: string
  /** What was not read, and why. Never silently empty. */
  notes: string[]
}

// ── art ─────────────────────────────────────────────────────────────────────

export type Storefront = 'shopify' | 'printful'

export interface ArtListingDraft {
  id: string
  createdAt: string
  storefront: Storefront
  title: string
  description: string
  tags: string[]
  price: number
  currency: string
  shipping: string
  /** Local draft until the user approves it; then it is created on the storefront as a DRAFT. */
  status: 'draft' | 'approved' | 'created' | 'failed'
  /** The storefront's own id for the created draft product. */
  remoteId: string | null
  remoteUrl: string | null
  error: string | null
}

export interface SocialPostDraft {
  id: string
  createdAt: string
  platform: 'bluesky' | 'mastodon'
  text: string
  /** What it is for: a listing, an app, a general post. */
  about: string
  status: 'draft' | 'approved' | 'posted' | 'failed'
  remoteUrl: string | null
  error: string | null
}

// ── testers ─────────────────────────────────────────────────────────────────

/**
 * The states a tester moves through. Google counts only `opted-in`, and only while they stay
 * opted in continuously — so `dropped` is a real state, not a deletion.
 */
export type TesterState = 'candidate' | 'invited' | 'accepted' | 'installed' | 'opted-in' | 'dropped'

export const TESTER_STATES: TesterState[] = ['candidate', 'invited', 'accepted', 'installed', 'opted-in', 'dropped']

export interface TesterCandidate {
  id: string
  name: string
  email: string
  /** Where this person came from, so the user can remember. */
  source: string
  state: TesterState
  invitedAt: string | null
  /** They said yes. Not the same as opted in. */
  acceptedAt: string | null
  /** They told you the app is on their phone. Goga did not check. */
  installedAt: string | null
  /** The day they opted in to the closed test. The user records this, or the date they marked it. */
  optedInAt: string | null
  /** When they left the test. Kept, because Google's clock cares about it. */
  droppedAt: string | null
  notes: string
}

/** Which Play track this app is on. Goga records what the user says; it does not read Play. */
export type PlayTrack = 'internal' | 'closed' | 'open' | 'production'

/** One app being tracked, with its own list of testers. */
export interface TesterApp {
  id: string
  /** The name the user knows it by, e.g. "Only3". */
  name: string
  packageName: string
  track: PlayTrack
  /** Google's gate for a new personal developer account: 12. */
  required: number
  /** How many days they must stay opted in continuously: 14. */
  optInDays: number
  candidates: TesterCandidate[]
  notes: string
  createdAt: string
  updatedAt: string
}

export interface TesterWorkspace {
  apps: TesterApp[]
  /** Copy drafts for recruiting, kept separate from the candidate lists. One set, any app. */
  copyDrafts: { id: string; createdAt: string; channel: string; text: string }[]
}

/** The counted view of one app. Every number here comes from the recorded states above. */
export interface TesterAppSummary {
  appId: string
  name: string
  packageName: string
  track: PlayTrack
  required: number
  optInDays: number
  /** Currently opted in. This is the figure Google counts. */
  optedIn: number
  /** Opted in long enough that their 14 days are done, by the dates recorded here. */
  optedInLongEnough: number
  /** Invited, accepted or installed but not yet opted in. */
  outstanding: number
  dropped: number
  meetsCount: boolean
  /** The day the 12th tester's 14 days finish, once there are 12 opted in; else null. */
  eligibleAt: string | null
  /** Whole days until `eligibleAt`. Negative means it has passed. */
  daysRemaining: number | null
  /** Where the count stands against the requirement, in one line. */
  status: string
  /** Set only when something needs the user's attention. */
  warning: string | null
  /** The most recent drop-out, if any. */
  latestDropAt: string | null
}

// ── deploy + monitor ────────────────────────────────────────────────────────

export interface HealthCheck {
  at: string
  ok: boolean
  status: number | null
  ms: number
  error: string | null
}

export interface MonitoredApp {
  id: string
  name: string
  url: string
  packageName: string
  /** What the user says is live. Goga does not read the Play Console. */
  liveVersion: string
  lastPublishedAt: string | null
  /** Where the release was published, in the user's words. */
  publishedWhere: string
  checks: HealthCheck[]
  createdAt: string
}

export interface UptimeSummary {
  appId: string
  checks: number
  up: number
  uptimePct: number | null
  avgMs: number | null
  lastCheck: HealthCheck | null
}

// ── app building ────────────────────────────────────────────────────────────

export type BuildTemplate = 'static' | 'vite-react' | 'node-express'

export interface BuildProject {
  id: string
  name: string
  dir: string
  template: BuildTemplate
  description: string
  createdAt: string
  /** Files Goga wrote, relative to dir. */
  files: string[]
  lastBuild: { at: string; ok: boolean; command: string; output: string } | null
  /** Set while a dev server Goga started is running. */
  devUrl: string | null
  devPid: number | null
  /** True when this project already existed and Goga was pointed at it. */
  existing: boolean
}

// ── freelance work ──────────────────────────────────────────────────────────

export interface JobProfile {
  headline: string
  skills: string[]
  portfolio: string[]
  rateFloor: number
  currency: string
  availability: string
  timezone: string
  kinds: string[]
  summary: string
  updatedAt: string | null
}

export interface JobListing {
  id: string
  source: string
  title: string
  company: string
  url: string
  location: string
  remote: boolean
  tags: string[]
  salary: string
  postedAt: string | null
  /** When Goga read it. Every listing carries this. */
  readAt: string
  description: string
}

export interface MatchReason {
  label: string
  points: number
  detail: string
}

export interface JobMatch {
  listing: JobListing
  score: number
  reasons: MatchReason[]
}

export interface ApplicationDraft {
  id: string
  listingId: string
  listingTitle: string
  listingUrl: string
  createdAt: string
  body: string
  status: 'draft' | 'approved'
  /** The user submits it themselves; Goga records that they did. */
  submittedAt: string | null
}

export type WorkStatus = 'scoping' | 'active' | 'blocked' | 'delivered' | 'paid' | 'closed'

export interface WorkItem {
  id: string
  title: string
  client: string
  scope: string
  deadline: string | null
  deliverables: string[]
  hours: number
  rate: number
  currency: string
  status: WorkStatus
  notes: string
  /** A folder Goga may work in for this job, when the user gives one. */
  projectDir: string
  createdAt: string
}

/** A marketplace with no public API: Goga prepares the search, the user runs it. */
export interface SavedSearch {
  id: string
  platform: string
  query: string
  url: string
  brief: string
  createdAt: string
}

// ── approvals + audit ───────────────────────────────────────────────────────

export type BusinessActionKind =
  | 'mail-send' | 'social-post' | 'listing-create' | 'tester-invite'
  | 'release-publish' | 'application-submit' | 'build-run'

export interface PendingAction {
  id: string
  kind: BusinessActionKind
  title: string
  /** The full content that will go out, exactly as it will go. */
  content: string
  createdAt: string
  expiresAt: string
}

export interface BusinessAuditEntry {
  id: string
  time: string
  kind: 'prepare' | 'approve' | 'deny' | 'execute' | 'error' | 'read' | 'note'
  action: string
  detail: string
}

export interface BusinessState {
  connections: ConnectionView[]
  declined: DeclinedPlatform[]
  encryptionAvailable: boolean
  audit: BusinessAuditEntry[]
  pending: PendingAction[]
}

/** Where a release can be published, and whether Goga can do it. Goga never can. */
export interface ReleaseDestination {
  id: string
  name: string
  note: string
}

/** Everything the Business page draws, read in one call. */
export interface BusinessPageState extends BusinessState {
  digest: Digest | null
  digestError: string | null
  listings: ArtListingDraft[]
  posts: SocialPostDraft[]
  /** The workspace plus the two counts the page shows (opted in, invited but not yet in). */
  testers: TesterRecruitment
  apps: MonitoredApp[]
  uptime: UptimeSummary[]
  projects: BuildProject[]
  jobProfile: JobProfile
  searches: SavedSearch[]
  releaseSteps: string[]
  destinations: ReleaseDestination[]
  /** The Play connection, the last baseline read, and any queued upload. */
  play: PlayState
}

// ── Google Play Console ─────────────────────────────────────────────────────

/**
 * Connection state for Play. The distinctions matter: a key can be a perfectly good service
 * account and still have no access to the developer account, and that is the failure that
 * actually happens most often.
 */
export type PlayConnectionState = 'not-connected' | 'invalid-key' | 'access-denied' | 'connected'

export interface PlayConnectionView {
  state: PlayConnectionState
  /** The service account's own address. Never the key. */
  serviceAccountEmail: string | null
  projectId: string | null
  keyId: string | null
  /** One line in plain words: what is true, and why. */
  detail: string
  /** The exact page that fixes the current state, when there is one. */
  fixUrl: string | null
  fixLabel: string | null
  checkedAt: string | null
  encryptionAvailable: boolean
}

export interface PlayReleaseView {
  name: string | null
  versionCodes: string[]
  status: string | null
  releaseNotes: { language: string; text: string }[]
}

export interface PlayTrackView {
  track: string
  releases: PlayReleaseView[]
}

export interface PlayAppView {
  packageName: string
  displayName: string
  tracks: PlayTrackView[]
  /** Why this app's tracks could not be read, when they could not. */
  error: string | null
}

export interface PlayBaseline {
  readAt: string | null
  apps: PlayAppView[]
  error: { message: string; fixUrl: string | null; fixLabel: string | null; detail: string } | null
  /** What was read, in one line. Never silently empty. */
  note: string
}

/** One queued upload, shown with everything the approval covers. */
export interface PlaySubmissionView {
  /** The approval id. The upload cannot happen without it. */
  id: string
  packageName: string
  track: string
  aabPath: string
  aabBytes: number
  versionCode: string
  releaseNotes: string
  language: string
  preparedAt: string
  expiresAt: string
}

export interface PlayState {
  connection: PlayConnectionView
  baseline: PlayBaseline
  pending: PlaySubmissionView[]
  /** The next free version code, read from Play's own numbers. Null when nothing is known. */
  suggestedVersionCode: string | null
  lastUpload: { at: string; ok: boolean; message: string; versionCode: string | null; track: string | null; committed: boolean } | null
}

/** What `business:approve` did with one prepared action. */
export interface BusinessActionResult {
  ok: boolean
  message: string
}

export interface TesterRecruitment {
  apps: TesterApp[]
  /** One counted row per app, in the order the apps were added. */
  summaries: TesterAppSummary[]
  copyDrafts: { id: string; createdAt: string; channel: string; text: string }[]
  /** Apps that are short of the requirement right now. */
  shortApps: number
}
