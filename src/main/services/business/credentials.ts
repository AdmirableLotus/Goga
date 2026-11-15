import fs from 'fs'
import { businessFile, ensureDirFor } from './paths'
import type { ConnectionId } from '../../../shared/business'

/**
 * Connection credentials.
 *
 * Every secret goes through Electron's safeStorage, which is keyed to the Windows
 * account — the same mechanism the Alpaca and HackerOne credentials already use. Nothing
 * here is ever written as plain text, and nothing here is ever returned to the renderer:
 * the UI only ever learns whether a credential exists and what account it belongs to.
 *
 * Goga never asks for a password. Each provider's own documented route is used:
 *   - Gmail: OAuth 2.0 with PKCE, refresh token stored here.
 *   - Bluesky: an app password the user creates in Bluesky settings.
 *   - Mastodon: an access token the user creates in their instance's development settings.
 *   - Shopify: an Admin API access token from a custom app the user installs.
 *   - Printful: a private API token from the user's Printful dashboard.
 */

export interface GmailCredential {
  kind: 'gmail'
  clientId: string
  clientSecret: string
  refreshToken: string
  /** The address the token belongs to, read from the Gmail profile. */
  account: string
  scope: string
  obtainedAt: string
}

export interface BlueskyCredential {
  kind: 'bluesky'
  /** The handle or DID used to sign in. */
  identifier: string
  appPassword: string
  accessJwt: string
  refreshJwt: string
  did: string
  handle: string
  obtainedAt: string
}

export interface MastodonCredential {
  kind: 'mastodon'
  /** The instance origin, e.g. https://mastodon.social */
  instance: string
  accessToken: string
  account: string
  obtainedAt: string
}

export interface ShopifyCredential {
  kind: 'shopify'
  /** The shop's myshopify domain, e.g. my-shop.myshopify.com */
  shop: string
  accessToken: string
  obtainedAt: string
}

export interface PrintfulCredential {
  kind: 'printful'
  accessToken: string
  storeId: string | null
  obtainedAt: string
}

export type Credential =
  | GmailCredential | BlueskyCredential | MastodonCredential | ShopifyCredential | PrintfulCredential

const FILES: Record<ConnectionId, string> = {
  gmail: 'goga-business-gmail.bin',
  bluesky: 'goga-business-bluesky.bin',
  mastodon: 'goga-business-mastodon.bin',
  shopify: 'goga-business-shopify.bin',
  printful: 'goga-business-printful.bin',
}

export function encryptionAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { safeStorage } = require('electron') as typeof import('electron')
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function safeStorageOrNull(): typeof import('electron').safeStorage | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { safeStorage } = require('electron') as typeof import('electron')
    return safeStorage
  } catch {
    return null
  }
}

export function readCredential<T extends Credential = Credential>(id: ConnectionId): T | null {
  const file = businessFile(FILES[id])
  if (!file) return null
  const store = safeStorageOrNull()
  if (!store) return null
  try {
    const raw = fs.readFileSync(file)
    const json = store.decryptString(raw)
    const parsed = JSON.parse(json) as T
    return parsed && parsed.kind === id ? parsed : null
  } catch {
    return null
  }
}

export function writeCredential(id: ConnectionId, credential: Credential): void {
  const file = businessFile(FILES[id])
  if (!file) throw new Error('Goga has no data folder to store this in, so nothing was saved')
  const store = safeStorageOrNull()
  if (!store || !store.isEncryptionAvailable()) {
    throw new Error('secure storage is not available on this PC, so the credential was not saved')
  }
  ensureDirFor(file)
  fs.writeFileSync(file, store.encryptString(JSON.stringify(credential)), { mode: 0o600 })
}

export function clearCredential(id: ConnectionId): void {
  const file = businessFile(FILES[id])
  if (!file) return
  try { fs.unlinkSync(file) } catch { /* nothing stored */ }
}

/** What the UI may know: that a credential exists, and which account it is for. */
export function credentialAccount(id: ConnectionId): string | null {
  const c = readCredential(id)
  if (!c) return null
  switch (c.kind) {
    case 'gmail': return c.account
    case 'bluesky': return c.handle
    case 'mastodon': return `${c.account}@${new URL(c.instance).hostname}`
    case 'shopify': return c.shop
    case 'printful': return c.storeId ? `store ${c.storeId}` : 'Printful account'
  }
}
