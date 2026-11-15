import type {
  CatalogueReading, InstallEvidence, InstalledProgram,
} from '../../../shared/setup'
import { runPowerShell } from './powershell'

/**
 * What is already installed on this machine, read from the machine.
 *
 * The point of this file is that Goga does not propose something the user already has. It
 * reads four sources and says which one each row came from, because they disagree and the
 * disagreement is information:
 *
 *   - `winget list` — the package manager's own view, with the ids an install would use.
 *   - the registry uninstall keys — what Windows itself thinks is installed, including
 *     programs winget has never heard of.
 *   - PATH — what can actually be run by name right now.
 *   - Program Files — what is on disk under the usual roots.
 *
 * Nothing here changes anything. Every command is a read.
 */

/** The winget list table, sliced by the header's own column positions. */
const WINGET_LIST_SCRIPT = `
$ErrorActionPreference = 'Continue'
$lines = @(winget list --accept-source-agreements --disable-interactivity 2>&1 | Out-String -Stream)
$header = $lines | Where-Object { $_ -match '^Name\\s+Id\\s+Version' } | Select-Object -First 1
if (-not $header) { Write-Output '{"ok":false,"error":"winget printed no table header"}'; exit 0 }
$idx = [array]::IndexOf($lines, $header)
$cols = [ordered]@{}
foreach ($k in @('Name','Id','Version','Available','Source')) {
  $p = $header.IndexOf($k)
  if ($p -ge 0) { $cols[$k] = $p }
}
$names = @($cols.Keys)
$starts = @($cols.Values)
$rows = @()
for ($i = $idx + 2; $i -lt $lines.Count; $i++) {
  $line = $lines[$i]
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  if ($line -match '^\\s*-+\\s*$') { continue }
  $obj = [ordered]@{}
  for ($c = 0; $c -lt $names.Count; $c++) {
    $start = $starts[$c]
    if ($start -ge $line.Length) { $obj[$names[$c]] = ''; continue }
    $end = if ($c + 1 -lt $starts.Count) { [Math]::Min($starts[$c + 1], $line.Length) } else { $line.Length }
    $obj[$names[$c]] = $line.Substring($start, $end - $start).Trim()
  }
  $rows += ,$obj
}
Write-Output (ConvertTo-Json -InputObject @{ ok = $true; rows = $rows } -Depth 4 -Compress)
`

/** The registry uninstall keys, which is what Windows itself reports. */
const REGISTRY_SCRIPT = `
$ErrorActionPreference = 'Continue'
$paths = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$items = @()
foreach ($p in $paths) {
  $items += Get-ItemProperty $p -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName } |
    ForEach-Object {
      [pscustomobject]@{
        name      = [string]$_.DisplayName
        version   = [string]$_.DisplayVersion
        publisher = [string]$_.Publisher
        location  = [string]$_.InstallLocation
      }
    }
}
Write-Output (ConvertTo-Json -InputObject @{ ok = $true; rows = @($items) } -Depth 4 -Compress)
`

/** What can be run by name right now, and what is on disk under the usual roots. */
const PATH_SCRIPT = `
$ErrorActionPreference = 'Continue'
$exes = @{}
foreach ($dir in ($env:PATH -split ';')) {
  if ([string]::IsNullOrWhiteSpace($dir)) { continue }
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { continue }
  Get-ChildItem -LiteralPath $dir -Filter '*.exe' -File -ErrorAction SilentlyContinue |
    ForEach-Object { $exes[$_.BaseName.ToLowerInvariant()] = $dir }
}
$rows = @()
foreach ($k in $exes.Keys) { $rows += ,([pscustomobject]@{ name = $k; dir = $exes[$k] }) }
Write-Output (ConvertTo-Json -InputObject @{ ok = $true; rows = $rows } -Depth 4 -Compress)
`

const PROGRAM_FILES_SCRIPT = `
$ErrorActionPreference = 'Continue'
$roots = @($env:ProgramFiles, \${env:ProgramFiles(x86)}, $env:LOCALAPPDATA + '\\Programs')
$rows = @()
foreach ($root in $roots) {
  if ([string]::IsNullOrWhiteSpace($root)) { continue }
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
  Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { $rows += ,([pscustomobject]@{ name = $_.Name; dir = $_.FullName }) }
}
Write-Output (ConvertTo-Json -InputObject @{ ok = $true; rows = $rows } -Depth 4 -Compress)
`

interface WingetRow { Name?: string; Id?: string; Version?: string; Available?: string; Source?: string }
interface RegRow { name?: string; version?: string; publisher?: string; location?: string }
interface PathRow { name?: string; dir?: string }

function emptyCounts(): Record<InstallEvidence, number> {
  return { winget: 0, registry: 0, path: 0, 'program-files': 0, 'windows-feature': 0 }
}

/**
 * Read the catalogue.
 *
 * A source that fails is reported as a gap rather than silently dropped: a catalogue that
 * quietly read only half the machine would let Goga propose something already installed.
 */
export async function readCatalogue(signal?: AbortSignal): Promise<CatalogueReading> {
  const gaps: string[] = []
  const programs: InstalledProgram[] = []
  const counts = emptyCounts()

  const [winget, registry, pathScan, programFiles] = await Promise.all([
    runPowerShell(WINGET_LIST_SCRIPT, { timeoutMs: 90_000, signal }),
    runPowerShell(REGISTRY_SCRIPT, { timeoutMs: 60_000, signal }),
    runPowerShell(PATH_SCRIPT, { timeoutMs: 60_000, signal }),
    runPowerShell(PROGRAM_FILES_SCRIPT, { timeoutMs: 30_000, signal }),
  ])

  let wingetAvailable = false
  let wingetError: string | null = null

  // ── winget ────────────────────────────────────────────────────────────────
  if (winget.timedOut) {
    wingetError = 'winget did not answer within 90 seconds.'
  } else if (!winget.stdout) {
    wingetError = winget.stderr || 'winget printed nothing.'
  } else {
    try {
      const parsed = JSON.parse(winget.stdout) as { ok?: boolean; error?: string; rows?: WingetRow[] }
      if (parsed.ok === false) {
        wingetError = parsed.error ?? 'winget printed no table header.'
      } else {
        wingetAvailable = true
        for (const row of parsed.rows ?? []) {
          const name = (row.Name ?? '').trim()
          if (!name) continue
          programs.push({
            name,
            packageId: (row.Id ?? '').trim() || null,
            version: (row.Version ?? '').trim() || null,
            publisher: null,
            source: 'winget',
            locatedAt: (row.Source ?? '').trim() || null,
          })
          counts.winget++
        }
      }
    } catch {
      wingetError = 'winget printed something that was not a table Goga could read.'
    }
  }
  if (wingetError) gaps.push(`winget: ${wingetError} Only the registry, PATH and Program Files were read, so a package winget knows about may be missing from this list.`)

  // ── registry ──────────────────────────────────────────────────────────────
  if (registry.timedOut) {
    gaps.push('The registry uninstall keys did not answer within 60 seconds.')
  } else {
    try {
      const parsed = JSON.parse(registry.stdout || '{"ok":false}') as { ok?: boolean; rows?: RegRow[] }
      for (const row of parsed.rows ?? []) {
        const name = (row.name ?? '').trim()
        if (!name) continue
        programs.push({
          name,
          packageId: null,
          version: (row.version ?? '').trim() || null,
          publisher: (row.publisher ?? '').trim() || null,
          source: 'registry',
          locatedAt: (row.location ?? '').trim() || null,
        })
        counts.registry++
      }
    } catch {
      gaps.push('The registry uninstall keys could not be read.')
    }
  }

  // ── PATH ──────────────────────────────────────────────────────────────────
  if (pathScan.timedOut) {
    gaps.push('The PATH scan did not answer within 60 seconds.')
  } else {
    try {
      const parsed = JSON.parse(pathScan.stdout || '{"ok":false}') as { ok?: boolean; rows?: PathRow[] }
      for (const row of parsed.rows ?? []) {
        const name = (row.name ?? '').trim()
        if (!name) continue
        programs.push({
          name,
          packageId: null,
          version: null,
          publisher: null,
          source: 'path',
          locatedAt: (row.dir ?? '').trim() || null,
        })
        counts.path++
      }
    } catch {
      gaps.push('The PATH scan could not be read.')
    }
  }

  // ── Program Files ─────────────────────────────────────────────────────────
  if (programFiles.timedOut) {
    gaps.push('The Program Files listing did not answer within 30 seconds.')
  } else {
    try {
      const parsed = JSON.parse(programFiles.stdout || '{"ok":false}') as { ok?: boolean; rows?: PathRow[] }
      for (const row of parsed.rows ?? []) {
        const name = (row.name ?? '').trim()
        if (!name) continue
        programs.push({
          name,
          packageId: null,
          version: null,
          publisher: null,
          source: 'program-files',
          locatedAt: (row.dir ?? '').trim() || null,
        })
        counts['program-files']++
      }
    } catch {
      gaps.push('The Program Files listing could not be read.')
    }
  }

  return {
    readAt: new Date().toISOString(),
    wingetAvailable,
    wingetError,
    programs,
    counts,
    gaps,
  }
}

/**
 * Is this program already here?
 *
 * Deliberately generous: a match on the winget id, the display name, or a PATH executable
 * name all count, because proposing an install of something already present is the failure
 * this catalogue exists to prevent. A false "already installed" costs the user one manual
 * install; a false "not installed" costs them a duplicate.
 */
export function findInstalled(catalogue: CatalogueReading, query: string): InstalledProgram[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const bare = q.replace(/\.exe$/, '')
  return catalogue.programs.filter(p => {
    const id = (p.packageId ?? '').toLowerCase()
    const name = p.name.toLowerCase()
    if (id && (id === q || id === bare)) return true
    if (name === q || name === bare) return true
    // A PATH row is a bare executable name, so an exact match there is the strongest signal.
    if (p.source === 'path' && name === bare) return true
    // Otherwise allow a containment match, which catches "Mozilla Firefox (x64 en-US)".
    return name.includes(bare) || (id !== '' && id.includes(bare))
  })
}

/** One line per program, for a chat reply. */
export function describeCatalogue(catalogue: CatalogueReading, limit = 40): string {
  const lines: string[] = []
  lines.push(`Read at ${catalogue.readAt.slice(0, 19).replace('T', ' ')} UTC.`)
  lines.push(
    `Sources: winget ${catalogue.wingetAvailable ? 'answered' : 'did not answer'} (${catalogue.counts.winget} rows), `
    + `registry ${catalogue.counts.registry}, PATH ${catalogue.counts.path}, Program Files ${catalogue.counts['program-files']}.`,
  )
  if (catalogue.gaps.length) {
    lines.push('')
    lines.push('What could not be read:')
    for (const gap of catalogue.gaps) lines.push(`  - ${gap}`)
  }
  const named = catalogue.programs.filter(p => p.source === 'winget' || p.source === 'registry')
  lines.push('')
  lines.push(`Installed programs (${named.length} named, showing ${Math.min(limit, named.length)}):`)
  for (const p of named.slice(0, limit)) {
    const bits = [p.name]
    if (p.version) bits.push(p.version)
    if (p.publisher) bits.push(p.publisher)
    if (p.packageId) bits.push(`[${p.packageId}]`)
    lines.push(`  - ${bits.join(' · ')}`)
  }
  if (named.length > limit) lines.push(`  … and ${named.length - limit} more.`)
  return lines.join('\n')
}
