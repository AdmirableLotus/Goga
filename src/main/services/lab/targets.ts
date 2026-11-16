import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { DeclaredTarget, TargetCheck, TargetKind } from '../../../shared/lab'
import { TARGET_KIND_LABEL } from '../../../shared/lab'
import { nanoid } from '../../utils/nanoid'
import { audit } from '../security/store'

/**
 * The declared-target model.
 *
 * This is the whole boundary of the Lab, and it is deliberately the simplest thing that can
 * work: the user writes down a host and says what authorises it. Every offensive tool asks
 * this file first. If the host is not covered by a live declaration, the tool refuses before
 * it starts a process, and the refusal names the host and says why.
 *
 * What this is not: it is not verification. Goga cannot check that the user owns a host. The
 * declaration is the user's own assertion, recorded in the audit trail, and the tools key off
 * it. That is exactly how Burp, Metasploit and every professional tool handle it — the
 * operator states the scope, and the tool holds them to it.
 *
 * Two things are refused even when declared, because no declaration can make them the user's:
 * cloud metadata endpoints. Those are never a machine the user owns, whatever they type.
 */

const MAX_TARGETS = 200

interface Store { targets: DeclaredTarget[] }

function file(): string { return path.join(app.getPath('userData'), 'goga-lab-targets.json') }

function load(): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<Store>
    return { targets: Array.isArray(raw.targets) ? raw.targets : [] }
  } catch { return { targets: [] } }
}

function save(store: Store): void {
  const target = file()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(store, null, 2), { mode: 0o600 })
}

// ── Host parsing, pure ──────────────────────────────────────────────────────

function ipToLong(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let out = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out = (out << 8) | n
  }
  return out >>> 0
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsText] = cidr.split('/')
  const bits = Number(bitsText)
  const ipNum = ipToLong(ip)
  const baseNum = ipToLong(base ?? '')
  if (ipNum === null || baseNum === null || !(bits >= 0 && bits <= 32)) return false
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ipNum & mask) === (baseNum & mask)
}

/**
 * Normalise a host the way a request would see it: lowercase, no scheme, no path, no port,
 * no trailing dot. Returns null for anything that is not a usable host.
 */
export function normaliseHost(raw: string): string | null {
  let text = String(raw ?? '').trim().toLowerCase()
  if (!text) return null
  // A URL is accepted and reduced to its host, so pasting one works.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try { text = new URL(text).hostname.toLowerCase() } catch { return null }
  }
  // An IPv4 CIDR block is kept whole: it is a valid declaration target (it covers a range),
  // and it is never a request host, so the path-strip below must not swallow the mask.
  const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(text)
  if (cidr) {
    const bits = Number(cidr[2])
    if (ipToLong(cidr[1]) === null || bits < 0 || bits > 32) return null
    return `${cidr[1]}/${bits}`
  }
  // Strip a path, a query and a port.
  text = text.replace(/[/?#].*$/, '')
  text = text.replace(/:\d+$/, '')
  text = text.replace(/\.$/, '')
  if (!text) return null
  if (text.length > 253) return null
  // A hostname or an IPv4 address. Anything else (a bare word, a wildcard) is not a target.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return ipToLong(text) === null ? null : text
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(text)) return null
  return text
}

/** Parse a port range as typed: "80", "1-1024", "80,443,8080", or empty for all. */
export function parsePorts(raw: string): { ok: boolean; ports: number[] | null; reason: string } {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: true, ports: null, reason: 'every port' }
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const piece = part.trim()
    if (!piece) continue
    const range = /^(\d{1,5})\s*-\s*(\d{1,5})$/.exec(piece)
    if (range) {
      const lo = Number(range[1]), hi = Number(range[2])
      if (lo < 1 || hi > 65535 || lo > hi) return { ok: false, ports: null, reason: `"${piece}" is not a port range between 1 and 65535` }
      if (hi - lo > 4096) return { ok: false, ports: null, reason: `"${piece}" covers more than 4096 ports; narrow it` }
      for (let p = lo; p <= hi; p++) out.add(p)
      continue
    }
    if (!/^\d{1,5}$/.test(piece)) return { ok: false, ports: null, reason: `"${piece}" is not a port` }
    const n = Number(piece)
    if (n < 1 || n > 65535) return { ok: false, ports: null, reason: `${n} is not a port between 1 and 65535` }
    out.add(n)
  }
  if (!out.size) return { ok: true, ports: null, reason: 'every port' }
  return { ok: true, ports: [...out].sort((a, b) => a - b), reason: `${out.size} port(s)` }
}

/**
 * Hosts no declaration can cover. A cloud metadata endpoint is never a machine the user owns,
 * and reaching one is how a scan turns into credential theft from the cloud account.
 */
export function neverDeclarable(host: string): string | null {
  const h = host.toLowerCase()
  if (h === '169.254.169.254' || h === 'metadata.google.internal' || h === 'metadata') {
    return 'cloud metadata endpoints are never a target, whatever is declared'
  }
  if (h === 'fd00:ec2::254') return 'cloud metadata endpoints are never a target, whatever is declared'
  return null
}

// ── The check every tool calls ──────────────────────────────────────────────

/**
 * Does a live declaration cover this host (and port)?
 *
 * Pure: takes the declarations as an argument, so the rule can be tested without a file or
 * Electron. A revoked declaration covers nothing. A CIDR declaration covers any address
 * inside it. A port range on the declaration narrows what may be touched.
 */
export function checkAgainst(declarations: DeclaredTarget[], rawHost: string, port?: number | null): TargetCheck {
  const host = normaliseHost(rawHost)
  if (!host) {
    return { declared: false, target: null, host: String(rawHost ?? ''), port: port ?? null, reason: `"${rawHost}" is not a hostname or IPv4 address` }
  }
  const never = neverDeclarable(host)
  if (never) return { declared: false, target: null, host, port: port ?? null, reason: never }

  const live = declarations.filter(d => !d.revokedAt)
  if (!live.length) {
    return { declared: false, target: null, host, port: port ?? null, reason: `no target is declared, so ${host} is not covered. Declare it in the Lab first.` }
  }

  for (const d of live) {
    const declaredHost = normaliseHost(d.host)
    if (!declaredHost) continue
    const hostHit = declaredHost.includes('/')
      ? (ipToLong(host) !== null && inCidr(host, declaredHost))
      : declaredHost === host
    if (!hostHit) continue

    // The declaration's port range narrows it. A port outside the range is a refusal, not a
    // pass, because the user wrote down which ports they meant.
    if (port !== undefined && port !== null) {
      const parsed = parsePorts(d.ports)
      if (parsed.ports && !parsed.ports.includes(port)) {
        return {
          declared: false, target: d, host, port,
          reason: `${host} is declared, but port ${port} is outside the ports that declaration names (${d.ports}). Nothing was sent.`,
        }
      }
    }
    return {
      declared: true, target: d, host, port: port ?? null,
      reason: `${host}${port ? `:${port}` : ''} is covered by your declaration (${TARGET_KIND_LABEL[d.kind]}, declared ${d.declaredAt.slice(0, 10)}).`,
    }
  }

  return {
    declared: false, target: null, host, port: port ?? null,
    reason: `${host} is not covered by any live declaration. Declared: ${live.map(d => d.host).join(', ')}. Nothing was sent.`,
  }
}

/** The check against what is stored. This is what a tool calls. */
export function checkTarget(rawHost: string, port?: number | null): TargetCheck {
  return checkAgainst(load().targets, rawHost, port)
}

/** The declaration covering a host, or null. Used to resolve a target id to its host. */
export function getTarget(id: string): DeclaredTarget | null {
  return load().targets.find(t => t.id === id) ?? null
}

export function listTargets(): DeclaredTarget[] {
  return load().targets
}

export function liveTargets(): DeclaredTarget[] {
  return load().targets.filter(t => !t.revokedAt)
}

// ── Declaring and revoking ──────────────────────────────────────────────────

export interface DeclareInput {
  host: string
  ports?: string
  kind: TargetKind
  note: string
}

export interface DeclareResult {
  ok: boolean
  target: DeclaredTarget | null
  message: string
}

/**
 * Record a declaration.
 *
 * The note is required and is not a formality: it is the sentence the user will read back in
 * the audit trail if anyone ever asks what authorised the traffic. An empty note is refused.
 */
export function declareTarget(input: DeclareInput): DeclareResult {
  const host = normaliseHost(input.host)
  if (!host) {
    audit('blocked', `declaration refused: "${input.host}" is not a hostname or IPv4 address`)
    return { ok: false, target: null, message: `"${input.host}" is not a hostname or IPv4 address. Give a host like 127.0.0.1, 192.168.56.10 or lab.example.test.` }
  }
  const never = neverDeclarable(host)
  if (never) {
    audit('blocked', `declaration refused for ${host}: ${never}`)
    return { ok: false, target: null, message: `${never}. Nothing was declared.` }
  }
  const note = String(input.note ?? '').trim()
  if (note.length < 8) {
    audit('blocked', `declaration refused for ${host}: no authorisation note`)
    return { ok: false, target: null, message: 'Write what authorises this target — one sentence is enough ("my VirtualBox Ubuntu VM on the host-only network"). A declaration with no note is not a declaration.' }
  }
  const ports = String(input.ports ?? '').trim()
  const parsed = parsePorts(ports)
  if (!parsed.ok) {
    audit('blocked', `declaration refused for ${host}: ${parsed.reason}`)
    return { ok: false, target: null, message: `${parsed.reason}. Nothing was declared.` }
  }
  const kind: TargetKind = (Object.keys(TARGET_KIND_LABEL) as TargetKind[]).includes(input.kind) ? input.kind : 'own-server'

  const store = load()
  if (store.targets.length >= MAX_TARGETS) {
    return { ok: false, target: null, message: `There are already ${MAX_TARGETS} declarations. Revoke one before adding another.` }
  }
  // Declaring the same host twice replaces the old declaration, so scope never lives in two
  // places with two different port ranges.
  const existing = store.targets.find(t => !t.revokedAt && normaliseHost(t.host) === host)
  if (existing) {
    existing.ports = ports
    existing.kind = kind
    existing.note = note
    existing.declaredAt = new Date().toISOString()
    save(store)
    audit('note', `declaration updated: ${host}${ports ? ` ports ${ports}` : ' all ports'} (${TARGET_KIND_LABEL[kind]}) — "${note}"`)
    return { ok: true, target: existing, message: `${host} is declared (updated). ${TARGET_KIND_LABEL[kind]}.` }
  }

  const target: DeclaredTarget = {
    id: nanoid(),
    host,
    ports,
    kind,
    note,
    declaredAt: new Date().toISOString(),
    revokedAt: null,
    revokedReason: null,
  }
  store.targets = [...store.targets, target]
  save(store)
  audit('note', `target declared: ${host}${ports ? ` ports ${ports}` : ' all ports'} (${TARGET_KIND_LABEL[kind]}) — "${note}"`)
  return { ok: true, target, message: `${host} is declared. ${TARGET_KIND_LABEL[kind]}. Every Lab tool will now accept it and refuse everything else.` }
}

/** Revoke a declaration. The record stays, marked revoked, so the audit still shows it. */
export function revokeTarget(id: string, reason: string): { ok: boolean; message: string } {
  const store = load()
  const target = store.targets.find(t => t.id === id)
  if (!target) return { ok: false, message: 'No such declaration.' }
  if (target.revokedAt) return { ok: false, message: `${target.host} was already revoked.` }
  target.revokedAt = new Date().toISOString()
  target.revokedReason = String(reason ?? '').trim() || 'revoked by the user'
  save(store)
  audit('note', `target revoked: ${target.host} — ${target.revokedReason}`)
  return { ok: true, message: `${target.host} is revoked. Every Lab tool will refuse it from now on.` }
}
