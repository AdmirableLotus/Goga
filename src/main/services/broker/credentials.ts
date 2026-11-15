import fs from 'fs'
import path from 'path'
import { app, safeStorage } from 'electron'
import type { BrokerMode } from '../../../shared/broker'
import { alpacaKeys } from '../trading/desk'

/**
 * Broker keys.
 *
 * PAPER keys are the ones already stored by the practice-trading desk
 * (`alpaca-keys.bin`, key id must start with PK), so the Markets page and this broker
 * share one credential. LIVE keys (key id starts with AK) are stored separately in
 * `broker-live-keys.bin` and are only ever used when the user has explicitly enabled
 * live trading. Neither file is readable as plain text on disk: both go through
 * Electron's safeStorage, which is keyed to the Windows account.
 */

export interface BrokerKeys { keyId: string; secret: string }

const liveFile = () => path.join(app.getPath('userData'), 'broker-live-keys.bin')
let liveCache: BrokerKeys | null | undefined

export function encryptionAvailable(): boolean {
  try { return safeStorage.isEncryptionAvailable() } catch { return false }
}

export function liveKeys(): BrokerKeys | null {
  if (liveCache !== undefined) return liveCache
  try { liveCache = JSON.parse(safeStorage.decryptString(fs.readFileSync(liveFile()))) } catch { liveCache = null }
  return liveCache ?? null
}

export function saveLiveKeys(keys: BrokerKeys | null): void {
  if (!keys) { try { fs.unlinkSync(liveFile()) } catch { /* none stored */ } liveCache = null; return }
  if (!/^AK[A-Z0-9]{10,40}$/.test(keys.keyId)) throw new Error('a live Alpaca key id starts with AK')
  if (!encryptionAvailable()) throw new Error('secure storage is not available on this PC, so the key was not saved')
  fs.writeFileSync(liveFile(), safeStorage.encryptString(JSON.stringify(keys)), { mode: 0o600 })
  liveCache = keys
}

export function paperKeys(): BrokerKeys | null {
  const k = alpacaKeys()
  return k && /^PK/.test(k.keyId) ? k : null
}

export function keysFor(mode: BrokerMode): BrokerKeys | null {
  if (mode === 'paper') return paperKeys()
  // A live key is stored only when the user typed one in deliberately; it is still not
  // used unless live trading is switched on in risk.ts.
  return liveKeys()
}

/** What the UI is allowed to know about the stored keys: never the key itself. */
export function credentialStatus(liveEnabled: boolean, halted: boolean, haltReason: string | null) {
  return {
    paper: !!paperKeys(),
    live: !!liveKeys(),
    encryptionAvailable: encryptionAvailable(),
    liveEnabled,
    halted,
    haltReason,
  }
}
