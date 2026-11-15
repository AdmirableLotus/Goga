import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WAKE_PHRASE, MIN_WAKE_CONFIDENCE, acceptWakeHit, buildWakeScript,
  normalizePhrase, opensWithWakePhrase, parseMicProbe, parseWakeLine,
  wakePhrases, wakeStatusFromProbe,
} from '../wakeWord'

describe('wake phrases — what the local grammar listens for', () => {
  it('includes the configured phrase and the mishearings Windows produces', () => {
    const phrases = wakePhrases(DEFAULT_WAKE_PHRASE)
    expect(phrases).toContain('hey goga')
    expect(phrases).toContain('hi goga')
    expect(phrases).toContain('hello goga')
    expect(phrases).toContain('hey gogo')
    expect(phrases).toContain('hey golda')
  })

  it('leaves out the lone word goga, which nothing separated from google', () => {
    // Measured with scripts/wake-measure-final.js at the shipped threshold: a bare
    // goga alternative matched Google it for me, Go gather your things and Cocoa and
    // coffee please at 0.90-0.93, while no real phrase scored above 0.94. No
    // threshold sits between those, so the word is not in the grammar. It is still
    // understood once the wake phrase has fired (see afterWakeWord in the voice
    // orchestrator).
    expect(wakePhrases(DEFAULT_WAKE_PHRASE)).not.toContain('goga')
  })

  it('leaves out the two variants that produced the most confident false accept', () => {
    // Measured with scripts/wake-grammar-sets.js: with these two in the grammar,
    // "I went to yoga class today" matched "okay goga" at 0.80 — higher than every
    // real phrase in the corpus except the strongest. They are still understood once
    // the wake word has already fired, through the dictation path's own matcher.
    const phrases = wakePhrases(DEFAULT_WAKE_PHRASE)
    expect(phrases).not.toContain('okay goga')
    expect(phrases).not.toContain('ok goga')
  })

  it('follows a custom phrase instead of the defaults', () => {
    const phrases = wakePhrases('oi goga')
    expect(phrases).toContain('oi goga')
    expect(phrases).toContain('goga')
    expect(phrases).not.toContain('hey golda')
  })

  it('falls back to the default when the phrase is blank', () => {
    expect(wakePhrases('   ')).toContain(DEFAULT_WAKE_PHRASE)
  })

  it('normalises punctuation and case', () => {
    expect(normalizePhrase('  Hey,   GOGA! ')).toBe('hey goga')
  })
})

describe('MIN_WAKE_CONFIDENCE — the measured threshold', () => {
  it('sits at the lowest value that cleared the corpus without losing a phrase', () => {
    // scripts/wake-measure-final.js on this machine, 14 wake phrases and 18 ordinary
    // sentences: 0.78 left one false accept, 0.82 left none and kept 14/14, and 0.84
    // started losing phrases. 0.82 is therefore the shipped number.
    expect(MIN_WAKE_CONFIDENCE).toBe(0.82)
  })
})

describe('opensWithWakePhrase — a stray word does not wake Goga', () => {
  it('accepts the phrase and its variants at the start', () => {
    expect(opensWithWakePhrase('hey goga what time is it')).toBe(true)
    expect(opensWithWakePhrase('Hey, Goga.')).toBe(true)
    expect(opensWithWakePhrase('hey gogo open notepad')).toBe(true)
    expect(opensWithWakePhrase('hey golda check my account')).toBe(true)
  })

  it('accepts the grammar result with its trailing placeholder', () => {
    // The SRGS grammar reports the phrase and "...'' for the rest.
    expect(opensWithWakePhrase('hey goga ...')).toBe(true)
  })

  it('rejects ordinary sentences that merely contain a similar word', () => {
    expect(opensWithWakePhrase('I went to yoga class today')).toBe(false)
    expect(opensWithWakePhrase('the toga party was fun')).toBe(false)
    expect(opensWithWakePhrase('open notepad')).toBe(false)
  })
})

describe('acceptWakeHit — confidence and phrase both have to agree', () => {
  it('accepts a confident hit that opens with the wake phrase', () => {
    // 0.83 is the weakest real phrase the measured corpus produced, and the
    // threshold itself is 0.82, so this is the tightest hit that still counts.
    expect(acceptWakeHit({ text: 'hey goga what is on my screen', confidence: 0.83 }, DEFAULT_WAKE_PHRASE)).toBe(true)
  })

  it('drops the strongest ordinary sentence the corpus produced', () => {
    // "google it for me" scored 0.81 against a grammar that carried the lone word
    // goga; with that word gone it does not match the grammar at all.
    expect(acceptWakeHit({ text: 'google it for me', confidence: 0.81 }, DEFAULT_WAKE_PHRASE)).toBe(false)
  })

  it('drops a hit the engine barely believed', () => {
    expect(acceptWakeHit({ text: 'hey goga', confidence: MIN_WAKE_CONFIDENCE - 0.01 }, DEFAULT_WAKE_PHRASE)).toBe(false)
  })

  it('drops a confident hit that is not the wake phrase', () => {
    expect(acceptWakeHit({ text: 'what is the weather', confidence: 0.95 }, DEFAULT_WAKE_PHRASE)).toBe(false)
  })

  it('accepts a hit with no confidence reported', () => {
    expect(acceptWakeHit({ text: 'hey goga' }, DEFAULT_WAKE_PHRASE)).toBe(true)
  })
})

describe('parseWakeLine — the detector only reports the wake word', () => {
  it('reads readiness', () => {
    expect(parseWakeLine('__READY__')).toEqual({ kind: 'ready' })
  })

  it('reads a hit with its confidence and the words after the phrase', () => {
    expect(parseWakeLine('__WAKE__0.83|hey goga what time is it'))
      .toEqual({ kind: 'wake', text: 'hey goga what time is it', confidence: 0.83 })
  })

  it('reads a failure with the reason Windows gave', () => {
    const line = parseWakeLine('__FAIL__No audio device')
    expect(line?.kind).toBe('fail')
    expect(line && line.kind === 'fail' && line.message).toContain('No audio device')
  })

  it('ignores blank lines and anything it does not recognise', () => {
    expect(parseWakeLine('')).toBeNull()
    expect(parseWakeLine('   ')).toBeNull()
    expect(parseWakeLine('some stray output')).toBeNull()
  })

  it('ignores a hit with no words', () => {
    expect(parseWakeLine('__WAKE__0.90|')).toBeNull()
  })
})

describe('parseMicProbe — the two failures get different words', () => {
  it('reports a missing microphone plainly', () => {
    const probe = parseMicProbe('COUNT:0\nOPEN:ERR:no device')
    expect(probe.ok).toBe(false)
    expect(probe.message).toContain('No microphone is connected')
  })

  it('reports a blocked microphone with the Windows reason', () => {
    const probe = parseMicProbe('COUNT:2\nOPEN:ERR:Access is denied')
    expect(probe.ok).toBe(false)
    expect(probe.message).toContain('Access is denied')
    expect(probe.message).toContain('Microphone')
  })

  it('reports ready only when the device actually opened', () => {
    expect(parseMicProbe('COUNT:1\nOPEN:OK').ok).toBe(true)
  })

  it('never claims ready when the probe said nothing', () => {
    const probe = parseMicProbe('')
    expect(probe.ok).toBe(false)
    expect(probe.message).toContain('Could not check the microphone')
  })
})

describe('wakeStatusFromProbe — the toggle never claims to be listening', () => {
  it('is off when the user has not turned it on', () => {
    const s = wakeStatusFromProbe(false, 'hey goga', { ok: true, message: 'Microphone ready.' })
    expect(s.state).toBe('off')
    expect(s.message).toBe('Wake word is off.')
  })

  it('is starting while the probe is still running', () => {
    expect(wakeStatusFromProbe(true, 'hey goga', null).state).toBe('starting')
  })

  it('is an error, not listening, when there is no microphone', () => {
    const s = wakeStatusFromProbe(true, 'hey goga', { ok: false, message: 'No microphone is connected.' })
    expect(s.state).toBe('error')
    expect(s.micReady).toBe(false)
    expect(s.message).toContain('No microphone is connected')
  })

  it('is listening only after a real probe succeeded', () => {
    const s = wakeStatusFromProbe(true, 'hey goga', { ok: true, message: 'Microphone ready.' })
    expect(s.state).toBe('listening')
    expect(s.micReady).toBe(true)
    expect(s.message).toContain('hey goga')
  })
})

describe('buildWakeScript — a grammar, not dictation', () => {
  const script = buildWakeScript(wakePhrases(DEFAULT_WAKE_PHRASE))

  it('loads an SRGS grammar so the wake phrase can actually be recognised', () => {
    // A plain Choices grammar never matches "Goga" — the engine has no word for
    // it. The SRGS document gives it an explicit pronunciation.
    expect(script).toContain('SrgsDocument')
    expect(script).toContain('sapi:pron')
    expect(script).toContain('LoadGrammar')
  })

  it('never loads a dictation grammar, so the room is not transcribed', () => {
    expect(script).not.toContain('DictationGrammar')
  })

  it('lets the request follow in the same breath', () => {
    expect(script).toContain('GARBAGE')
  })

  it('includes every phrase as its own alternative', () => {
    for (const phrase of wakePhrases(DEFAULT_WAKE_PHRASE)) {
      const words = phrase.split(' ')
      for (const word of words) expect(script.toLowerCase()).toContain(word)
    }
  })

  it('escapes a phrase so an apostrophe cannot break the XML or the PowerShell', () => {
    const quoted = buildWakeScript(["goga's"])
    expect(quoted).toContain('goga&apos;s')
    expect(quoted).not.toContain("'goga's'")
  })

  it('sets the engine rejection threshold so its own output is already filtered', () => {
    expect(script).toContain(`CFGConfidenceRejectionThreshold', ${Math.round(MIN_WAKE_CONFIDENCE * 100)}`)
  })

  it('writes nothing to disk and opens no network connection', () => {
    expect(script).not.toMatch(/SetOutputToWaveFile|Out-File|Invoke-WebRequest|Net\.WebClient/)
  })
})
