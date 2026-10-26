import { isIP } from 'net'

function ipv4(value: string): number | null {
  if (isIP(value) !== 4) return null
  return value.split('.').reduce((n, octet) => (n * 256 + Number(octet)) >>> 0, 0)
}

/** Conservative matching: no substring, wildcard apex, path or CIDR widening. */
export function matchesSecurityAsset(target: string, asset: string): boolean {
  if (!target || !asset || /[\s\\]/.test(target) || /[\s\\]/.test(asset)) return false
  try {
    if (/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(asset)) {
      const [network, bitsText] = asset.split('/')
      const bits = Number(bitsText), n = ipv4(network)
      const host = target.includes('://') ? new URL(target).hostname : target
      const ip = ipv4(host)
      if (n === null || ip === null || bits < 0 || bits > 32) return false
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
      return (ip & mask) === (n & mask)
    }
    const candidate = new URL(target.includes('://') ? target : `https://${target}`)
    if (!['http:', 'https:'].includes(candidate.protocol) || candidate.username || candidate.password || candidate.hash) return false
    const host = candidate.hostname.toLowerCase().replace(/\.$/, '')
    if (asset.startsWith('*.')) {
      const suffix = asset.slice(2).toLowerCase()
      if (!/^[a-z0-9.-]+$/.test(suffix) || !suffix.includes('.')) return false
      return host.endsWith(`.${suffix}`) && host !== suffix
    }
    if (asset.includes('://')) {
      const rule = new URL(asset)
      if (!['http:', 'https:'].includes(rule.protocol) || rule.username || rule.password || rule.hash || rule.search) return false
      if (candidate.origin !== rule.origin) return false
      // URL scopes with paths authorize only that path subtree.
      const base = rule.pathname.replace(/\/$/, '')
      if (base && candidate.pathname !== base && !candidate.pathname.startsWith(`${base}/`)) return false
      // Reject encoded path separators and traversal rather than normalize into wider scope.
      return !/%(?:2f|5c|2e)/i.test(candidate.pathname)
    }
    if (!/^[a-z0-9.:-]+$/i.test(asset)) return false
    const rule = new URL(`https://${asset}`)
    return host === rule.hostname.toLowerCase().replace(/\.$/, '') && (!rule.port || candidate.port === rule.port)
  } catch { return false }
}

export const SECURITY_TASK = /\b(hack(?:erone|ing)?|pentest|exploit|vuln(?:erability)?|recon|xss|sqli|rce|ssrf|lfi|idor|bounty|bug.?bounty|ctf|security[ -]?test(?:ing)?|scan(?:ning)?)\b/i

// Only this narrowly constrained network primitive can run against targets in
// this release. Shell, browser navigation/JS and desktop inputs can hide other
// targets, redirects or submissions, so a target string cannot authorize them.
export function securityActionTarget(tool: string, params: Record<string, unknown>): string | null {
  if (tool !== 'web.fetch' || typeof params.url !== 'string') return null
  try {
    const url = new URL(params.url)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) return null
    return url.href
  } catch { return null }
}
