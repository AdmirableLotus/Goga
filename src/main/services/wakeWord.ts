/**
 * Wake word — the cheap, always-on part of hands-free Goga.
 *
 * The listener never transcribes the room. It runs a tiny local grammar
 * (System.Speech `Choices`) that only reports when one of a handful of short
 * phrases is heard, so nothing is written down and nothing leaves the machine.
 * Full dictation only starts after the wake word fires, and stops again when
 * the conversation window closes.
 *
 * This module also answers the honest question the Settings toggle has to ask
 * before it may claim to be listening: is there a microphone, and will Windows
 * let us open it?
 */

import { spawn, type ChildProcess } from 'child_process'

export type WakeState = 'off' | 'starting' | 'listening' | 'request' | 'error'

export interface WakeStatus {
  /** What the user asked for in Settings. */
  enabled: boolean
  state: WakeState
  /** Plain-English line for the UI. Never says "listening" unless it is. */
  message: string
  phrase: string
  /** True only when a microphone probe actually succeeded. */
  micReady: boolean
}

export interface MicProbe {
  ok: boolean
  message: string
}

export const DEFAULT_WAKE_PHRASE = 'hey goga'

/**
 * How sure the recogniser must be before a grammar hit counts as the wake word.
 *
 * Set from measurement, not from taste. scripts/wake-measure-final.js builds this
 * exact grammar with buildWakeGrammar below, synthesises a 32-utterance corpus
 * with the local Windows voice (14 wake phrases, including the close variants, and
 * 18 ordinary sentences), and feeds each one through the real engine at a range of
 * rejection thresholds. Measured on this machine, with the phrase set below:
 *
 *   threshold   recall    false accepts
 *      65       14/14        5/18
 *      70       14/14        5/18
 *      72       14/14        3/18
 *      75       14/14        2/18
 *      78       14/14        1/18   <- "google it for me" at 0.81
 *      82       14/14        0/18   <- shipped
 *      84       12/14        0/18   <- drops "hi goga" and "goga, check my email"
 *      88       10/14        0/18   <- drops plain "hey goga"
 *
 * 82 is the lowest threshold that clears the whole corpus without losing a single
 * wake phrase. The margin is measured too: at 82 the weakest real phrase scored
 * 0.83 and the strongest non-wake sentence 0.81, so there is one point of room each
 * side. 84 is where recall starts to fall, so 82 is also the edge of this corpus —
 * a noisier room will miss more real phrases than this.
 *
 * The set matters as much as the number. An earlier draft also carried a lone
 * "goga" alternative, and on the same audio "google it for me", "go gather your
 * things" and "cocoa and coffee please" matched it at 0.90-0.93 — higher than two
 * real phrases, so no threshold could separate them. Dropping the bare word is what
 * made 0/18 reachable. (scripts/wake-measure-bare.js keeps that comparison.)
 */
export const MIN_WAKE_CONFIDENCE = 0.82

// Windows dictation does not know the word "Goga"; the grammar needs the
// mishearings spelled out or the phrase never matches.
//
// "okay goga" and "ok goga" are deliberately absent. Measured on the same corpus,
// they were what let "I went to yoga class today" through at 0.80 — the most
// confident false accept of any variant. Dictation still accepts them once the
// wake word has already fired.
//
// The lone word "goga" is absent as well: see the numbers above. A custom phrase
// still keeps it (see wakePhrases), because then the user chose that word.
const DEFAULT_VARIANTS = [
  'hey goga',
  'hi goga',
  'hello goga',
  'hey gogo',
  'hey gaga',
  'hey golda',
]

export function normalizePhrase(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The phrases the local grammar listens for: the configured wake phrase plus
 * the close variants people actually say ("hey, goga", "hi goga", "hello goga",
 * "hey gogo", "hey golda"). A custom phrase keeps "goga" itself as well.
 */
export function wakePhrases(phrase: string): string[] {
  const base = normalizePhrase(phrase) || DEFAULT_WAKE_PHRASE
  const out = new Set<string>([base])
  if (base === DEFAULT_WAKE_PHRASE) {
    DEFAULT_VARIANTS.forEach(p => out.add(p))
  } else {
    out.add('goga')
    if (!base.startsWith('hey ')) out.add(`hey ${base}`)
  }
  return Array.from(out)
}

/** Read the microphone probe's output. Pure, so it can be tested without Windows. */
export function parseMicProbe(stdout: string): MicProbe {
  const text = stdout || ''
  const count = /COUNT:(\d+)/.exec(text)
  const open = /OPEN:(OK|ERR:(.*))/.exec(text)

  if (count && Number(count[1]) === 0) {
    return {
      ok: false,
      message: 'No microphone is connected. Plug one in, then turn this on again.',
    }
  }
  if (open && open[1] !== 'OK') {
    const detail = (open[2] || '').trim()
    return {
      ok: false,
      message: `Windows would not open the microphone${detail ? ` (${detail})` : ''}. Check Settings → Privacy & security → Microphone, then try again.`,
    }
  }
  if (open && open[1] === 'OK') return { ok: true, message: 'Microphone ready.' }
  return {
    ok: false,
    message: 'Could not check the microphone — Windows speech is not available on this machine.',
  }
}

// ── Detector output ───────────────────────────────────────────────────────────

export type WakeLine =
  | { kind: 'ready' }
  | { kind: 'wake'; text: string; confidence?: number }
  | { kind: 'fail'; message: string }

/** Read one line of the detector's stdout. Pure, so it can be tested without Windows. */
export function parseWakeLine(line: string): WakeLine | null {
  const text = (line || '').trim()
  if (!text) return null
  if (text === '__READY__') return { kind: 'ready' }
  const failed = /^__FAIL__(.*)$/.exec(text)
  if (failed) {
    const detail = failed[1].trim()
    return {
      kind: 'fail',
      message: `Windows speech could not start the wake word${detail ? ` (${detail})` : ''}, so it is off.`,
    }
  }
  const hit = /^__WAKE__([\d.]+)\|(.*)$/.exec(text)
  if (hit) {
    const confidence = Number(hit[1])
    const words = hit[2].trim()
    if (!words) return null
    return { kind: 'wake', text: words, confidence: Number.isFinite(confidence) ? confidence : undefined }
  }
  return null
}

/**
 * One grammar hit is the wake word only if the engine believed it enough and the
 * phrase really opens with the wake phrase. Keeps a stray "golden gate" from
 * waking Goga and keeps a mumbled non-match from being spoken back.
 */
export function acceptWakeHit(hit: { text: string; confidence?: number }, wakePhrase: string): boolean {
  if (hit.confidence !== undefined && hit.confidence < MIN_WAKE_CONFIDENCE) return false
  return opensWithWakePhrase(hit.text, wakePhrase)
}

/**
 * True when the utterance starts with the wake phrase or one of its variants.
 * Same forgiving rule the dictation path uses ("hey goga", "hey, gogo", "golda").
 */
export function opensWithWakePhrase(text: string, wakePhrase = DEFAULT_WAKE_PHRASE): boolean {
  const words = normalizePhrase(text).split(' ').filter(Boolean)
  const phrase = normalizePhrase(wakePhrase).split(' ').filter(Boolean)
  if (phrase.length && words.slice(0, phrase.length).join(' ') === phrase.join(' ')) return true
  const variants = wakePhrases(wakePhrase)
  for (const variant of variants) {
    const parts = variant.split(' ')
    if (parts.length && words.slice(0, parts.length).join(' ') === variant) return true
  }
  return false
}

/** The status the toggle and the indicator show, computed from a real probe. */
export function wakeStatusFromProbe(enabled: boolean, phrase: string, probe: MicProbe | null): WakeStatus {
  const spoken = phrase || DEFAULT_WAKE_PHRASE
  if (!enabled) {
    return { enabled: false, state: 'off', message: 'Wake word is off.', phrase: spoken, micReady: probe?.ok ?? false }
  }
  if (!probe) {
    return { enabled, state: 'starting', message: 'Checking the microphone…', phrase: spoken, micReady: false }
  }
  if (!probe.ok) {
    return { enabled, state: 'error', message: `${probe.message} The wake word is off.`, phrase: spoken, micReady: false }
  }
  return {
    enabled,
    state: 'listening',
    message: `Listening for "${spoken}".`,
    phrase: spoken,
    micReady: true,
  }
}

// ── Microphone probe ─────────────────────────────────────────────────────────

// Counts input devices with winmm, then tries to open the default one through
// System.Speech. The two failures are different problems and get different words.
const MIC_PROBE_SCRIPT = `
$ErrorActionPreference = 'Continue'
try {
  $sig = '[DllImport("winmm.dll")] public static extern int waveInGetNumDevs();'
  $t = Add-Type -MemberDefinition $sig -Name 'GogaWaveIn' -Namespace 'GogaWake' -PassThru
  [Console]::Out.WriteLine('COUNT:' + $t::waveInGetNumDevs())
} catch {
  [Console]::Out.WriteLine('COUNT:?')
}
try {
  Add-Type -AssemblyName System.Speech
  $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  $r.SetInputToDefaultAudioDevice()
  [Console]::Out.WriteLine('OPEN:OK')
  $r.Dispose()
} catch {
  [Console]::Out.WriteLine('OPEN:ERR:' + $_.Exception.Message)
}
[Console]::Out.Flush()
`

/** Ask Windows whether a microphone exists and can be opened. */
export function probeMicrophone(timeoutMs = 10_000): Promise<MicProbe> {
  return new Promise(resolve => {
    let out = ''
    let settled = false
    const finish = (probe: MicProbe) => { if (!settled) { settled = true; resolve(probe) } }

    let proc: ChildProcess
    try {
      proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', MIC_PROBE_SCRIPT], { windowsHide: true })
    } catch {
      finish({ ok: false, message: 'Could not check the microphone — Windows speech is not available on this machine.' })
      return
    }

    const timer = setTimeout(() => {
      try { proc.kill() } catch { /* already gone */ }
      finish({ ok: false, message: 'The microphone check did not answer. The wake word is off.' })
    }, timeoutMs)

    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('error', () => {
      clearTimeout(timer)
      finish({ ok: false, message: 'Could not check the microphone — Windows speech is not available on this machine.' })
    })
    proc.on('close', () => {
      clearTimeout(timer)
      finish(parseMicProbe(out))
    })
  })
}

// ── Grammar detector ─────────────────────────────────────────────────────────

/**
 * How each word of the wake phrase is pronounced, in the phoneme alphabet
 * Windows speech uses. "Goga" is not an English word, so a plain word list
 * never matches it — measured on this machine, a `Choices` grammar scored no
 * match at all on the phrase while the same audio matched these phonemes at
 * 0.89–0.93. That is why the detector ships an SRGS grammar with explicit
 * pronunciations instead of a word list.
 */
const PRONUNCIATION: Record<string, string> = {
  goga: 'g ow g ax',
  "goga's": 'g ow g ax z',
  gogo: 'g ow g ow',
  gaga: 'g aa g aa',
  golda: 'g ow l d ax',
  goda: 'g ow d ax',
  gorga: 'g ao r g ax',
  koga: 'k ow g ax',
  kogo: 'k ow g ow',
  googa: 'g uw g ax',
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** One `<item>` body: the phrase's words, with a pronunciation for the odd ones. */
function wakeItem(phrase: string): string {
  return phrase.split(/\s+/).filter(Boolean).map(word => {
    const pron = PRONUNCIATION[word.toLowerCase()]
    const safe = xmlEscape(word)
    return pron ? `<token sapi:pron="${pron}">${safe}</token>` : safe
  }).join(' ')
}

/**
 * The grammar document the engine loads. Every phrase is its own alternative,
 * each in two shapes: alone, and followed by anything at all — so "hey goga,
 * what time is it" is one hit, not a wake word and a separate request.
 */
export function buildWakeGrammar(phrases: string[]): string {
  const list = phrases.length ? phrases : [DEFAULT_WAKE_PHRASE]
  const items: string[] = []
  for (const phrase of list) {
    const body = wakeItem(phrase)
    items.push(`      <item>${body}</item>`)
    items.push(`      <item>${body} <ruleref special="GARBAGE"/></item>`)
  }
  return `<grammar xml:lang="en-US" root="wake"
  xmlns="http://www.w3.org/2001/06/grammar"
  xmlns:sapi="http://schemas.microsoft.com/Speech/2002/06/srgssapi" version="1.0">
  <rule id="wake" scope="public">
    <one-of>
${items.join('\n')}
    </one-of>
  </rule>
</grammar>`
}

/** PowerShell string literal for a piece of text. */
function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

/**
 * The detector's PowerShell program.
 *
 * One SRGS grammar, so the engine only reports speech that opens with the wake
 * phrase and never transcribes the room. When the phrase is followed by a
 * request the result carries both, so the request is not lost. Everything else
 * is rejected inside the engine and never reaches Node, which is what makes this
 * cheap enough to leave running and quiet enough to keep private.
 */
export function buildWakeScript(phrases: string[]): string {
  const grammar = buildWakeGrammar(phrases)
  return `
$ErrorActionPreference = 'Stop'
function Emit([string]$line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }
try {
  Add-Type -AssemblyName System.Speech
  $srgs = ${psQuote(grammar)}
  $reader = New-Object System.Xml.XmlTextReader((New-Object System.IO.StringReader($srgs)))
  $doc = New-Object System.Speech.Recognition.SrgsGrammar.SrgsDocument($reader)
  $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  $r.SetInputToDefaultAudioDevice()
  $grammar = New-Object System.Speech.Recognition.Grammar($doc)
  $grammar.Name = 'goga-wake'
  $r.LoadGrammar($grammar)
  $r.MaxAlternates = 1
  try { $r.UpdateRecognizerSetting('CFGConfidenceRejectionThreshold', ${Math.round(MIN_WAKE_CONFIDENCE * 100)}) } catch { }
  Register-ObjectEvent -InputObject $r -EventName SpeechRecognized -SourceIdentifier gw | Out-Null
  Register-ObjectEvent -InputObject $r -EventName RecognizeCompleted -SourceIdentifier gc | Out-Null
  $r.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
  Emit('__READY__')
  while ($true) {
    $e = Wait-Event -Timeout 1
    if (-not $e) { continue }
    switch ($e.SourceIdentifier) {
      'gw' {
        $res = $e.SourceEventArgs.Result
        if ($res -and $res.Text) {
          $conf = $res.Confidence.ToString('F2', [Globalization.CultureInfo]::InvariantCulture)
          Emit('__WAKE__' + $conf + '|' + $res.Text)
        }
      }
      'gc' { try { $r.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple) } catch { } }
    }
    Remove-Event -EventIdentifier $e.EventIdentifier
  }
} catch {
  Emit('__FAIL__' + $_.Exception.Message)
  exit 1
}
`
}

export interface WakeDetectorEvents {
  /** The engine is open on the microphone and the grammar is loaded. */
  onReady: () => void
  /** A phrase that opens with the wake word was heard. */
  onWake: (text: string, confidence: number | undefined) => void
  /** The engine could not start or died. `message` is written for the user. */
  onError: (message: string) => void
}

/**
 * The always-on listener: one PowerShell child holding a grammar-limited
 * recogniser. No audio is written anywhere and nothing leaves the machine.
 */
export class WakeDetector {
  private proc: ChildProcess | null = null
  private stopped = false

  constructor(private phrases: string[], private events: WakeDetectorEvents) {}

  isRunning(): boolean {
    return this.proc !== null && !this.stopped
  }

  start(): void {
    this.stop()
    this.stopped = false

    let proc: ChildProcess
    try {
      proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', buildWakeScript(this.phrases)], { windowsHide: true })
    } catch {
      this.events.onError('Windows speech could not be started, so the wake word is off.')
      return
    }
    this.proc = proc

    let buf = ''
    proc.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const parsed = parseWakeLine(line)
        if (!parsed) continue
        if (parsed.kind === 'ready') this.events.onReady()
        else if (parsed.kind === 'fail') this.events.onError(parsed.message)
        else this.events.onWake(parsed.text, parsed.confidence)
      }
    })

    proc.on('error', () => {
      if (this.proc === proc) this.proc = null
      if (!this.stopped) this.events.onError('Windows speech could not be started, so the wake word is off.')
    })

    proc.on('close', () => {
      if (this.proc === proc) this.proc = null
      if (!this.stopped) this.events.onError('The wake word listener stopped unexpectedly. Turn it off and on again in Settings.')
    })
  }

  stop(): void {
    this.stopped = true
    if (this.proc) {
      try { this.proc.kill() } catch { /* already gone */ }
      this.proc = null
    }
  }
}
