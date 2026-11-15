/**
 * Toolbox - the security-tool reference, typed.
 *
 * A memory aid: the cheat sheets the user sent, transcribed by hand, each tool with a verdict.
 * Nothing here runs anything - no executor, no scanner, no fuzzer, no credential-attacking
 * path. The only request in the Security area is still the single approved GET that
 * security.probe sends.
 *
 * A cheat sheet is not authorisation. Reading a command is legal and useful; running most of
 * them against someone else's system is not without that owner's written permission, and Goga
 * cannot give permission.
 *
 * ALLOWED_UNDER_SCOPE means usable inside an imported program when the scope checker passes and
 * the program's rules permit it. NEEDS_PROGRAM_PERMISSION means active scanning or fuzzing,
 * which many programs forbid and several ban accounts for. NEVER means credential attacking,
 * wireless attacks against networks the user does not own, or interception on a network that
 * is not the user's own.
 */
export type ToolVerdict = 'ALLOWED_UNDER_SCOPE' | 'NEEDS_PROGRAM_PERMISSION' | 'NEVER'

export type ToolNeed = 'target host' | 'target URL' | 'domain' | 'capture file' | 'hash file'
  | 'wordlist' | 'interface' | 'credentials or hash of someone else' | 'local Windows host'
  | 'api key (optional)' | 'none'
  // Reference entries drawn from the public OSINT list: these need material the user already
  // holds, never a live target.
  | 'a file on this machine' | 'the media file or its public URL' | 'a domain name'
  | 'an organisation name or jurisdiction' | 'a machine you own, or the provider\'s sandbox'

export type SheetCommand = {
  /** The flag as printed on a cheat sheet. Absent for reference entries that are not flags. */
  flag?: string
  command: string
  description: string
  bannedPath?: boolean
}

export type SheetSection = {
  heading: string
  commands: SheetCommand[]
}

export type ToolReference = {
  id: string
  name: string
  what: string
  sheet: string
  verdict: ToolVerdict
  verdictReason: string
  usefulPart: string
  bannedPart: string
  needs: ToolNeed[]
  docs: { title: string; url: string }[]
  sections: SheetSection[]
}

export type ToolboxCatalog = {
  version: string
  note: string
  unreadable: { tool: string; detail: string }[]
  tools: ToolReference[]
}

export type ToolboxSearchResult = {
  id: string
  name: string
  verdict: ToolVerdict
  matchedIn: string
  excerpt: string
}
