import React, { useEffect, useState } from 'react'
import type { WakeStatus } from '../../main/services/wakeWord'
import { Alert, Field } from './ui'

/**
 * The "hey goga" switch.
 *
 * An always-on microphone is the user's decision, so this is off until they turn
 * it on. The switch shows the main process's real state, not the click: it is
 * only ticked while the listener actually reports listening. If the microphone
 * is missing or Windows blocks it, the switch goes back to off and the line
 * underneath says why. Turning it on also enables voice, because the answer is
 * spoken through the same voice settings.
 */
export default function WakeWordSettings({
  voiceEnabled,
  wakeEnabled,
  phrase,
  onEnable,
  disabled,
}: {
  voiceEnabled: boolean
  wakeEnabled: boolean
  phrase: string
  /** Reports the setting the main process actually ended up with. */
  onEnable: (on: boolean) => void
  disabled?: boolean
}) {
  const [wake, setWake] = useState<WakeStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)

  useEffect(() => {
    let alive = true
    window.goga.invoke('voice:wakeStatus').then(s => { if (alive) setWake(s) }).catch(() => {})
    const off = window.goga.on('voice:wakeStatus', s => { if (alive) setWake(s) })
    return () => { alive = false; off() }
  }, [])

  const toggle = async (wantOn: boolean) => {
    setBusy(true)
    setAsking(wantOn)
    try {
      // The click is the request; the main process starts (or refuses) and
      // reports what it actually ended up as.
      const next = await window.goga.invoke(wantOn ? 'voice:startWakeLoop' : 'voice:stopWakeLoop')
      setWake(next)
      onEnable(next.enabled)
    } catch (err) {
      setWake({
        enabled: false, state: 'error', micReady: false, phrase,
        message: err instanceof Error ? err.message : String(err),
      })
      onEnable(false)
    } finally {
      setBusy(false)
      setAsking(false)
    }
  }

  const listening = wake?.state === 'listening' || wake?.state === 'request'
  // Ticked only while the listener really is listening. While the microphone is
  // being checked the box follows the click, so the switch does not look stuck;
  // whatever comes back overrides it.
  const checked = busy && asking ? true : listening

  const status = !voiceEnabled
    ? 'Turn voice on first — the wake word speaks answers with the same voice settings.'
    : busy
      ? (asking ? 'Checking the microphone…' : 'Stopping…')
      : wake?.message ?? (wakeEnabled ? 'Starting…' : 'Wake word is off.')

  return (
    <>
      <Field
        label={`Wake word (say "${phrase || 'hey goga'}")`}
        hint="The microphone stays on while this is on. Goga listens only for the wake phrase; nothing is recorded, and no audio leaves this computer. Off by default."
      >
        <div className="g-row">
          {/* A real word beside the box, clickable as its label. The hint below
              already names the control; this names the state it is in. */}
          <input
            id="wake-word-switch"
            type="checkbox"
            aria-label={`Wake word, listening for ${phrase || 'hey goga'}`}
            checked={checked}
            disabled={disabled || busy || !voiceEnabled}
            onChange={e => void toggle(e.target.checked)}
          />
          <label htmlFor="wake-word-switch" style={{ cursor: 'pointer', fontSize: 'var(--fs-caption)', color: 'var(--text-muted)' }}>
            <span>{listening ? 'Listening' : 'Listen for it'}</span>
          </label>
        </div>
      </Field>
      <div style={{ marginBottom: 12 }}>
        <Alert kind={wake?.state === 'error' ? 'error' : listening ? 'ok' : 'info'}>
          {status}
        </Alert>
      </div>
    </>
  )
}
