import type { ConnectionId, ConnectionView, DeclinedPlatform } from '../../../shared/business'
import { credentialAccount, encryptionAvailable, readCredential } from './credentials'

/**
 * What Goga can connect to, what each connection can do, and what it deliberately will not.
 *
 * The list is short on purpose. Every entry here has a documented API that a personal
 * account can use, and a route the account owner can take themselves. The platforms that
 * do not are in `DECLINED`, with the reason, so the UI can say so plainly instead of
 * offering a button that would get the account banned.
 */

interface Spec {
  id: ConnectionId
  name: string
  kind: ConnectionView['kind']
  authKind: ConnectionView['authKind']
  capabilities: string[]
  limits: string[]
  where: string
}

const SPECS: Spec[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    kind: 'email',
    authKind: 'oauth',
    capabilities: [
      'Read and search mail',
      'Apply and remove labels',
      'Create drafts in your Drafts folder',
      'Send a message you have read and approved',
    ],
    limits: [
      'Google sign-in only — Goga never sees your password',
      'Sending needs your approval of that exact message, every time',
      'Other mail providers need IMAP, which is not built yet',
    ],
    where: 'Google Cloud Console → APIs & Services → Credentials → Create OAuth client (Desktop app). Enable the Gmail API on the same project.',
  },
  {
    id: 'bluesky',
    name: 'Bluesky',
    kind: 'social',
    authKind: 'app-password',
    capabilities: [
      'Read mentions, replies, quotes, follows, likes and reposts',
      'Read your own recent posts and their counts',
      'Post text you have read and approved',
    ],
    limits: [
      '300 characters per post',
      'Text only — no image upload yet',
      'Use an app password, never your main password',
    ],
    where: 'bsky.app → Settings → App Passwords → Add App Password.',
  },
  {
    id: 'mastodon',
    name: 'Mastodon',
    kind: 'social',
    authKind: 'token',
    capabilities: [
      'Read mentions, replies, follows, favourites and boosts',
      'Read your own recent posts and their counts',
      'Post text you have read and approved',
    ],
    limits: [
      'One instance at a time',
      'Text only — no media upload yet',
      'The token needs read and write:statuses scopes',
    ],
    where: 'Your instance → Preferences → Development → New application, with read and write:statuses scopes.',
  },
  {
    id: 'shopify',
    name: 'Shopify',
    kind: 'storefront',
    authKind: 'token',
    capabilities: [
      'Read your shop name and currency',
      'Create a product as a DRAFT with title, description, tags and price',
    ],
    limits: [
      'Goga creates drafts only — you publish in Shopify',
      'Shipping profiles and variants are set in Shopify, not here',
      'Needs the write_products scope on a custom app',
    ],
    where: 'Shopify admin → Settings → Apps and sales channels → Develop apps → Create an app → Admin API access token (write_products).',
  },
  {
    id: 'printful',
    name: 'Printful',
    kind: 'storefront',
    authKind: 'token',
    capabilities: [
      'Read your Printful account and stores',
      'Create a sync product in your store',
    ],
    limits: [
      'Printful prices from the product and your store markup — Goga does not set a price there',
      'Publishing is done in Printful',
      'Needs a private token with store product write access',
    ],
    where: 'Printful dashboard → Settings → Developers → API tokens → Add token.',
  },
]

export const DECLINED: DeclinedPlatform[] = [
  {
    name: 'Instagram',
    reason: 'The Instagram Graph API only serves Business and Creator accounts through a Meta app that has passed App Review, and its content-publishing permission is limited to specific media types. Personal-account automation is prohibited in Meta\'s terms, and unofficial libraries get accounts restricted.',
    manualPath: 'Goga writes the caption and the hashtags; you post them in the Instagram app.',
  },
  {
    name: 'Facebook',
    reason: 'Pages can be posted to through the Graph API with a reviewed Meta app, but a personal profile cannot, and automating a personal profile breaks Meta\'s terms.',
    manualPath: 'Goga drafts the post; you paste it into Facebook.',
  },
  {
    name: 'X (Twitter)',
    reason: 'The free API tier no longer allows posting, and the paid tiers are priced for businesses. Automation of a personal account is also restricted by X\'s automation rules.',
    manualPath: 'Goga drafts the post; you paste it into X.',
  },
  {
    name: 'TikTok',
    reason: 'The Content Posting API requires an approved developer app and only accepts direct uploads from a registered, audited client. There is no route for a desktop tool to post to a personal account.',
    manualPath: 'Goga writes the caption and the script; you upload in TikTok.',
  },
  {
    name: 'LinkedIn',
    reason: 'Posting needs a LinkedIn developer app with the "Share on LinkedIn" product approved, and the API is aimed at organisations. Personal-profile automation is restricted.',
    manualPath: 'Goga drafts the post; you paste it into LinkedIn.',
  },
  {
    name: 'Pinterest',
    reason: 'The Pinterest API needs an approved app and a business account, and standard access is granted per use case. It is not available to a local tool out of the box.',
    manualPath: 'Goga drafts the pin title and description; you create the pin in Pinterest.',
  },
  {
    name: 'Etsy',
    reason: 'Etsy\'s Open API v3 requires an approved application and OAuth, and new app registrations are reviewed. It is a real API, but it needs an approved app before any call works.',
    manualPath: 'Goga drafts the listing; you paste it into Etsy\'s listing form. If you get an Etsy app approved, this can be added.',
  },
  {
    name: 'Reddit',
    reason: 'The Reddit API now requires a registered app and is rate-limited per client; posting to a personal account through a third-party client is restricted by Reddit\'s terms.',
    manualPath: 'Goga drafts the post; you submit it in Reddit.',
  },
]

export function connectionSpecs(): Spec[] { return SPECS }

export function connectionViews(): ConnectionView[] {
  const enc = encryptionAvailable()
  return SPECS.map(spec => {
    const cred = readCredential(spec.id)
    const account = cred ? credentialAccount(spec.id) : null
    return {
      id: spec.id,
      name: spec.name,
      kind: spec.kind,
      authKind: spec.authKind,
      state: cred ? 'connected' : 'not-connected',
      account,
      detail: cred
        ? `Connected${account ? ` as ${account}` : ''}.`
        : 'Not connected. Goga has no credential for this account.',
      capabilities: spec.capabilities,
      limits: spec.limits,
      where: spec.where,
      encryptionAvailable: enc,
      lastCheckedAt: cred?.obtainedAt ?? null,
    }
  })
}

/** Mark a connection as needing attention without losing the credential. */
export function markNeedsReauth(id: ConnectionId, detail: string): ConnectionView {
  const view = connectionViews().find(v => v.id === id)
  if (!view) throw new Error('no such connection')
  return { ...view, state: 'needs-reauth', detail }
}
