import React, { useEffect, useState } from 'react'
import type { WakeStatus } from '../../main/services/wakeWord'

/**
 * The small "hey goga" indicator on the Chat page.
 *
 * It only ever shows what the main process reports: off, starting, listening,
 * heard-you, or an error with the reason. There is no local guess about whether
 * the microphone is open — if the listener is not running, this says off.
 */
export default function WakeIndicator() {
  const [wake, setWake] = useState<WakeStatus | null>(null)

  useEffect(() => {
    let alive = true
    window.goga.invoke('voice:wakeStatus')
      .then(s => { if (alive) setWake(s) })
      .catch(() => { /* older backend without the channel */ })
    const off = window.goga.on('voice:wakeStatus', s => { if (alive) setWake(s) })
    return () => { alive = false; off() }
  }, [])

  // Only an actually-on listener earns a line here. A refused start (no
  // microphone, Windows blocking it) is shown in Settings, next to the switch that
  // caused it — Chat does not keep a red line for something that is off.
  if (!wake || !wake.enabled) return null

  const tone = wake.state === 'error' ? 'bad' : wake.state === 'request' ? 'wait' : 'busy'
  const label =
    wake.state === 'starting' ? 'checking the microphone…' :
    wake.state === 'listening' ? `wake word on · "${wake.phrase}"` :
    wake.state === 'request' ? 'heard you' :
    wake.message

  return (
    <div
      className={`g-wake g-wake--${tone}${wake.state === 'listening' ? ' g-wake--live' : ''}`}
      role="status"
      aria-live="polite"
      title={wake.message}
    >
      <span className="g-wake-ear" aria-hidden="true">👂</span>
      <span className="g-wake-label">{label}</span>
    </div>
  )
}
