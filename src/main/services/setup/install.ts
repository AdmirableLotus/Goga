import type {
  CatalogueReading, InstallProposal, InstallProposalResult, InstallRunResult, InstallSource,
} from '../../../shared/setup'
import { INSTALL_TTL_MS } from '../../../shared/setup'
import { SingleUseGate } from '../approval/singleUse'
import { findTool } from '../security/toolboxQuery'
import { refusalFor } from '../security/toolboxVerdicts'
import { auditSetup } from './store'
import { findInstalled } from './catalogue'
import { psQuote, runPowerShell } from './powershell'
import { nanoid } from '../../utils/nanoid'

/**
 * Proposing an install, and carrying it out only after the user approved that exact install.
 *
 * The shape of the safety here:
 *
 *   1. A proposal names the exact package, the source it comes from, the version, and what it
 *      will change. Nothing is downloaded or run to make a proposal.
 *   2. The approval is bound to package id + source + version. Change any of them and the
 *      approval no longer matches, so the install is refused.
 *   3. A Toolbox "never" tool is refused outright — no proposal, no approval offered. A
 *      "needs explicit program permission" tool may be installed for study, and the verdict
 *      travels with the proposal so the page can say that installing it authorises nothing.
 *   4. Every proposal, approval, refusal and completed install writes an audit line.
 *
 * Installing a tool is not permission to use it against anyone's system. That sentence is in
 * the proposal text, not just in this comment.
 */

/** The one gate for installs. */
export const installGate = new SingleUseGate<InstallProposal>(
  p => [p.packageId, p.source.kind, p.source.where, p.version ?? 'newest'].join('|'),
  () => Date.now(),
  INSTALL_TTL_MS,
)

/** The vendor hosts Goga will accept a direct download from. Anything else is refused. */
const VENDOR_HOSTS: Record<string, string> = {
  'nmap.org': 'Nmap',
  'nmap.com': 'Nmap',
  'github.com': 'GitHub releases',
  'objects.githubusercontent.com': 'GitHub releases',
  'wireshark.org': 'Wireshark',
  'www.wireshark.org': 'Wireshark',
  '7-zip.org': '7-Zip',
  'www.7-zip.org': '7-Zip',
  'python.org': 'Python',
  'www.python.org': 'Python',
  'nodejs.org': 'Node.js',
  'git-scm.com': 'Git',
  'code.visualstudio.com': 'Visual Studio Code',
  'mozilla.org': 'Mozilla',
  'www.mozilla.org': 'Mozilla',
  'virtualbox.org': 'Oracle VirtualBox',
  'www.virtualbox.org': 'Oracle VirtualBox',
  'oracle.com': 'Oracle',
  'www.oracle.com': 'Oracle',
  'microsoft.com': 'Microsoft',
  'www.microsoft.com': 'Microsoft',
  'aka.ms': 'Microsoft',
  'go.dev': 'Go',
  'golang.org': 'Go',
  'rust-lang.org': 'Rust',
  'www.rust-lang.org': 'Rust',
  'docker.com': 'Docker',
  'www.docker.com': 'Docker',
  'postgresql.org': 'PostgreSQL',
  'www.postgresql.org': 'PostgreSQL',
  'sqlite.org': 'SQLite',
  'www.sqlite.org': 'SQLite',
  'ffmpeg.org': 'FFmpeg',
  'www.ffmpeg.org': 'FFmpeg',
  'gnu.org': 'GNU',
  'www.gnu.org': 'GNU',
  'vim.org': 'Vim',
  'www.vim.org': 'Vim',
  'putty.org': 'PuTTY',
  'www.putty.org': 'PuTTY',
  'openvpn.net': 'OpenVPN',
  'torproject.org': 'Tor Project',
  'www.torproject.org': 'Tor Project',
}

/** The vendor host a URL belongs to, or null when it is not a vendor Goga recognises. */
export function vendorHostOf(url: string): string | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase()
  return Object.prototype.hasOwnProperty.call(VENDOR_HOSTS, host) ? host : null
}

/** What `winget show` says about a package, which is what a proposal is built from. */
interface WingetShow {
  found: boolean
  id: string | null
  version: string | null
  publisher: string | null
  homepage: string | null
  installerUrl: string | null
  installerSha256: string | null
  installerType: string | null
  license: string | null
  description: string | null
}

const WINGET_SHOW_SCRIPT = (id: string) => `
$ErrorActionPreference = 'Continue'
$out = winget show --id ${psQuote(id)} --exact --accept-source-agreements --disable-interactivity 2>&1 | Out-String
Write-Output $out
`

/** Parse `winget show`'s plain-text output. It is a labelled list, not JSON. */
export function parseWingetShow(text: string): WingetShow {
  const empty: WingetShow = {
    found: false, id: null, version: null, publisher: null, homepage: null,
    installerUrl: null, installerSha256: null, installerType: null, license: null, description: null,
  }
  if (!text || /No package found matching input criteria/i.test(text)) return empty
  const found = /^Found\s+(.+?)\s+\[([^\]]+)\]/m.exec(text)
  if (!found) return empty
  const field = (label: string): string | null => {
    const re = new RegExp(`^\\s*${label}:\\s*(.+)$`, 'm')
    const m = re.exec(text)
    return m ? m[1].trim() : null
  }
  return {
    found: true,
    id: found[2].trim(),
    version: field('Version'),
    publisher: field('Publisher'),
    homepage: field('Homepage'),
    installerUrl: field('Installer Url'),
    installerSha256: field('Installer SHA256'),
    installerType: field('Installer Type'),
    license: field('License'),
    description: field('Description'),
  }
}

/** Ask winget about one package. Read-only: `winget show` installs nothing. */
export async function showPackage(id: string, signal?: AbortSignal): Promise<WingetShow> {
  const result = await runPowerShell(WINGET_SHOW_SCRIPT(id), { timeoutMs: 60_000, signal })
  return parseWingetShow(result.stdout)
}

export interface ProposeInstallInput {
  /** The package the user or the task named, e.g. "nmap" or "7zip.7zip". */
  package: string
  /** The task that needs it, in the user's words. */
  task: string
  /** Why this package does that job. */
  why?: string
  /** What Goga could not do without it. */
  withoutIt?: string
  /** A vendor download URL, when the caller already knows there is no winget entry. */
  vendorUrl?: string
  /** The version to pin, when the caller wants a specific one. */
  version?: string
}

/**
 * Work out an install proposal.
 *
 * Refuses outright, with no approval offered, when:
 *   - the package is a Toolbox "never" tool;
 *   - the package is already installed;
 *   - no winget entry exists and no vendor URL was given;
 *   - the vendor URL is not on a vendor host Goga recognises.
 */
export async function proposeInstall(
  input: ProposeInstallInput,
  catalogue: CatalogueReading,
  signal?: AbortSignal,
): Promise<InstallProposalResult> {
  const asked = input.package.trim()
  if (!asked) {
    return { ok: false, message: 'Name the package to install.', proposal: null, refused: false }
  }

  // ── 1. The Toolbox verdict, before anything else ──────────────────────────
  const toolboxTool = findTool(asked)
  if (toolboxTool && toolboxTool.verdict === 'NEVER') {
    const refusal = refusalFor(toolboxTool) ?? `${toolboxTool.name} is a NEVER tool.`
    auditSetup('refusal', `refused to install ${toolboxTool.name} (${toolboxTool.id}): Toolbox verdict NEVER — ${toolboxTool.verdictReason}`)
    return {
      ok: false,
      refused: true,
      proposal: null,
      message: [
        `Goga will not install ${toolboxTool.name}.`,
        '',
        refusal,
        '',
        'This is a refusal, not a proposal: there is no approval you can give that would make Goga install it. '
        + 'The Toolbox marks it NEVER because it is a credential-attacking, wireless-attacking or traffic-interception tool, '
        + 'and no program scope authorises those.',
      ].join('\n'),
    }
  }

  // ── 2. Already installed? ─────────────────────────────────────────────────
  const already = findInstalled(catalogue, asked)
  if (already.length) {
    const first = already[0]
    auditSetup('refusal', `did not propose installing ${asked}: already present as ${first.name}${first.version ? ` ${first.version}` : ''} (${first.source})`)
    return {
      ok: false,
      refused: false,
      proposal: null,
      message: `${first.name} is already on this machine${first.version ? ` (version ${first.version})` : ''}, found via ${first.source}${first.locatedAt ? ` at ${first.locatedAt}` : ''}. Nothing to install.`,
    }
  }

  // ── 3. Where it comes from ────────────────────────────────────────────────
  let source: InstallSource
  let displayName = asked
  let version: string | null = input.version ?? null
  let publisher: string | null = null
  let installerUrl: string | null = null
  let installerSha256: string | null = null
  let installsTo: string | null = null
  let downloadMb: number | null = null
  let description: string | null = null

  const shown = await showPackage(asked, signal)
  if (shown.found && shown.id) {
    displayName = shown.id
    version = input.version ?? shown.version
    publisher = shown.publisher
    installerUrl = shown.installerUrl
    installerSha256 = shown.installerSha256
    description = shown.description
    source = {
      kind: 'winget',
      where: shown.id,
      vendorHost: shown.homepage ? vendorHostOf(shown.homepage) : null,
      note: `winget's own entry for ${shown.id}${shown.publisher ? `, published by ${shown.publisher}` : ''}. `
        + 'winget fetches the installer from the address in its manifest and checks the manifest\'s SHA-256 before running it.',
    }
  } else if (input.vendorUrl) {
    const host = vendorHostOf(input.vendorUrl)
    if (!host) {
      auditSetup('refusal', `refused to install ${asked}: ${input.vendorUrl} is not a vendor host Goga recognises`)
      return {
        ok: false,
        refused: true,
        proposal: null,
        message: [
          `Goga will not install ${asked} from ${input.vendorUrl}.`,
          '',
          'That address is not on a vendor host Goga recognises, so it could be a mirror, a repackager or a search-result link. '
          + 'Goga only installs from winget or from the vendor\'s own download address, and it verifies the signature or hash before running anything.',
        ].join('\n'),
      }
    }
    source = {
      kind: 'vendor-download',
      where: input.vendorUrl,
      vendorHost: host,
      note: `The vendor's own download address (${VENDOR_HOSTS[host]}). Goga will check the file's Authenticode signature and SHA-256 before running it.`,
    }
  } else {
    auditSetup('refusal', `did not propose installing ${asked}: no winget entry and no vendor download address`)
    return {
      ok: false,
      refused: false,
      proposal: null,
      message: [
        `There is no winget package called "${asked}", and no vendor download address was given.`,
        '',
        'Goga will not install from a search-result link or an unofficial mirror. Give the vendor\'s own download address, '
        + 'or the exact winget package id, and it will propose that.',
      ].join('\n'),
    }
  }

  // ── 4. What it will change ────────────────────────────────────────────────
  const changes: string[] = []
  if (source.kind === 'winget') {
    changes.push(`Installs ${displayName}${version ? ` ${version}` : ''} through winget, into the location its manifest names.`)
    if (installerUrl) changes.push(`The installer winget will run is ${installerUrl}.`)
    if (installerSha256) changes.push(`winget checks that file against SHA-256 ${installerSha256} before running it.`)
  } else {
    changes.push(`Downloads ${source.where} and runs it after checking its signature and hash.`)
  }
  changes.push('Adds an entry to the Windows uninstall list so it can be removed the normal way.')
  changes.push('Does not change, upgrade or remove anything already installed.')

  const needsElevation = source.kind === 'winget'
    ? /machine|msi|wix|exe/i.test(shown.installerType ?? '')
    : true

  const proposal: InstallProposal = {
    id: nanoid(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + INSTALL_TTL_MS).toISOString(),
    packageId: source.kind === 'winget' ? (shown.id ?? asked) : asked,
    displayName,
    version,
    source,
    impact: {
      downloadMb,
      installsTo,
      needsElevation,
      changes,
    },
    purpose: {
      task: input.task || 'a task that needs this program',
      why: input.why || description || `${displayName} is the program that does this job.`,
      withoutIt: input.withoutIt || 'Goga cannot do that part of the task without it.',
    },
    verdict: toolboxTool ? toolboxTool.verdict : null,
    verdictReason: toolboxTool ? toolboxTool.verdictReason : null,
    carriesSecurityVerdict: !!toolboxTool && toolboxTool.verdict !== 'ALLOWED_UNDER_SCOPE',
    status: 'proposed',
    approved: false,
  }

  installGate.offer(proposal)
  auditSetup('proposal', `proposed installing ${displayName}${version ? ` ${version}` : ''} from ${source.kind} (${source.where}) for: ${proposal.purpose.task}`)

  return {
    ok: true,
    refused: false,
    proposal,
    message: [
      `Proposed: install ${displayName}${version ? ` ${version}` : ''}.`,
      `Source: ${source.kind === 'winget' ? 'winget' : 'the vendor\'s own download'} — ${source.where}`,
      `For: ${proposal.purpose.task}`,
      '',
      'Nothing has been downloaded or run. Approve this exact install to carry it out, or discard it.',
      ...(proposal.carriesSecurityVerdict
        ? ['', `This is a security tool with the Toolbox verdict "${proposal.verdict}". Installing it does not authorise running it at anyone's system.`]
        : []),
    ].join('\n'),
  }
}

/** The user's decision about one exact install. */
export function decideInstall(proposalId: string, approved: boolean): { ok: boolean; message: string; proposal: InstallProposal | null } {
  const result = installGate.decide(proposalId, approved, {
    unknown: 'That is not an install Goga proposed. Propose it again.',
    spent: 'That install has already been carried out. It works once.',
    expired: 'That proposal expired before it was approved. Nothing was installed. Propose it again.',
    approved: 'Approved. This exact install, once.',
    denied: 'Discarded. Nothing was downloaded or installed.',
  })
  if (result.item) {
    result.item.approved = true
    result.item.status = 'approved'
    auditSetup('approval', `approved installing ${result.item.displayName}${result.item.version ? ` ${result.item.version}` : ''} from ${result.item.source.where}`)
  } else if (!approved) {
    auditSetup('denial', `discarded the proposal to install ${proposalId}`)
  }
  return { ok: result.ok, message: result.message, proposal: result.item }
}

/**
 * Carry out an approved install.
 *
 * The gate is claimed first, so an unapproved or already-spent proposal never reaches a
 * command. Only then does anything run, and only the exact package the approval named.
 */
export async function runInstall(proposalId: string, signal?: AbortSignal): Promise<InstallRunResult> {
  const claim = installGate.claim(proposalId, undefined, {
    unknown: 'That is not an install Goga proposed. Nothing was installed.',
    spent: 'That install has already been carried out. Nothing was installed a second time.',
    notApproved: 'This install has not been approved. Nothing was downloaded or installed.',
    expired: 'That proposal expired before it was approved. Nothing was installed.',
    changed: 'That proposal changed after it was approved, so nothing was installed. Propose it again.',
  })
  if (!claim.ok || !claim.item) {
    auditSetup('refusal', `refused to run install ${proposalId}: ${claim.message}`)
    return { ok: false, message: claim.message, output: '', exitCode: null }
  }

  const proposal = claim.item
  proposal.status = 'installed'

  if (proposal.source.kind === 'winget') {
    const command = `winget install --id ${psQuote(proposal.packageId)} --exact --accept-package-agreements --accept-source-agreements --disable-interactivity`
    const result = await runPowerShell(command, { timeoutMs: 15 * 60_000, signal })
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    if (result.needsElevation) {
      proposal.status = 'failed'
      auditSetup('install-failed', `installing ${proposal.displayName} needed administrator rights; nothing was installed`)
      return {
        ok: false,
        exitCode: result.exitCode,
        output,
        message: [
          `Installing ${proposal.displayName} needs administrator rights, and Goga does not elevate on its own.`,
          '',
          'Nothing was installed. To do it yourself, open a terminal as administrator and run:',
          `  ${command}`,
          '',
          'Or install it from the Microsoft Store / the vendor\'s installer, which will show you the UAC prompt.',
        ].join('\n'),
      }
    }
    if (result.exitCode !== 0) {
      proposal.status = 'failed'
      auditSetup('install-failed', `winget install ${proposal.packageId} exited ${result.exitCode}`)
      return {
        ok: false,
        exitCode: result.exitCode,
        output,
        message: `winget could not install ${proposal.displayName} (exit code ${result.exitCode}). Nothing else was changed. The output is below.`,
      }
    }
    auditSetup('install', `installed ${proposal.displayName}${proposal.version ? ` ${proposal.version}` : ''} from winget (${proposal.packageId})`)
    return {
      ok: true,
      exitCode: result.exitCode,
      output,
      message: `${proposal.displayName} is installed. Read the catalogue again to confirm it is there.`,
    }
  }

  // A vendor download: fetch, verify, then run. Verification is not optional.
  const download = await downloadAndVerify(proposal, signal)
  if (!download.ok) {
    proposal.status = 'failed'
    auditSetup('install-failed', `did not run the installer for ${proposal.displayName}: ${download.message}`)
    return { ok: false, message: download.message, output: download.output, exitCode: null }
  }
  const run = await runPowerShell(`Start-Process -FilePath ${psQuote(download.path)} -Wait -PassThru | Select-Object -ExpandProperty ExitCode`, { timeoutMs: 15 * 60_000, signal })
  if (run.needsElevation) {
    proposal.status = 'failed'
    auditSetup('install-failed', `the installer for ${proposal.displayName} needed administrator rights; nothing was installed`)
    return {
      ok: false,
      exitCode: run.exitCode,
      output: run.stdout,
      message: [
        `The installer for ${proposal.displayName} needs administrator rights, and Goga does not elevate on its own.`,
        '',
        `Nothing was installed. The verified installer is at ${download.path} — run it yourself and click Yes on the UAC prompt.`,
      ].join('\n'),
    }
  }
  if (run.exitCode !== 0) {
    proposal.status = 'failed'
    auditSetup('install-failed', `the installer for ${proposal.displayName} exited ${run.exitCode}`)
    return { ok: false, exitCode: run.exitCode, output: run.stdout, message: `The installer exited ${run.exitCode}. Nothing else was changed.` }
  }
  auditSetup('install', `installed ${proposal.displayName} from ${proposal.source.where} after verifying its signature`)
  return { ok: true, exitCode: run.exitCode, output: run.stdout, message: `${proposal.displayName} is installed.` }
}

/**
 * Download a vendor installer and verify it before anything runs it.
 *
 * The signature check is the point: an unsigned or wrongly-signed file is deleted and never
 * run, whatever the address said.
 */
async function downloadAndVerify(proposal: InstallProposal, signal?: AbortSignal): Promise<{ ok: boolean; path: string; message: string; output: string }> {
  const target = `${process.env.TEMP ?? 'C:\\Windows\\Temp'}\\goga-install-${proposal.id}.exe`
  const script = `
$ErrorActionPreference = 'Stop'
$url = ${psQuote(proposal.source.where)}
$out = ${psQuote(target)}
try {
  Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing -MaximumRedirection 5
} catch {
  Write-Output ('DOWNLOAD-FAILED: ' + $_.Exception.Message)
  exit 2
}
$sig = Get-AuthenticodeSignature -FilePath $out
$hash = (Get-FileHash -FilePath $out -Algorithm SHA256).Hash
Write-Output ('SIGNATURE-STATUS: ' + $sig.Status)
Write-Output ('SIGNER: ' + $(if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { 'none' }))
Write-Output ('SHA256: ' + $hash)
`
  const result = await runPowerShell(script, { timeoutMs: 10 * 60_000, signal })
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
  if (/DOWNLOAD-FAILED/.test(result.stdout)) {
    return { ok: false, path: target, message: `The download failed, so nothing was run. ${output}`, output }
  }
  const status = /SIGNATURE-STATUS:\s*(\S+)/.exec(result.stdout)?.[1] ?? 'unknown'
  if (status !== 'Valid') {
    await runPowerShell(`Remove-Item -LiteralPath ${psQuote(target)} -Force -ErrorAction SilentlyContinue`)
    return {
      ok: false,
      path: target,
      message: `The downloaded file's signature is "${status}", not Valid, so Goga deleted it and ran nothing. `
        + 'An installer that is unsigned or signed by someone other than its vendor is exactly what this check exists to stop.',
      output,
    }
  }
  return { ok: true, path: target, message: 'Downloaded and signature verified.', output }
}

/** Everything the gate is holding, for the page. */
export function listProposals(): InstallProposal[] {
  return installGate.list().map(p => p.item)
}
