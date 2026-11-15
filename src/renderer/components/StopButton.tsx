import React, { useEffect, useState } from 'react'
import type { AgentState } from '@shared/types'

/**
 * Emergency stop.
 *
 * It is only loud while something is actually running. When the agent is idle it
 * stays in the header as a quiet, neutral control so the shortcut is still
 * discoverable, but it no longer reads as an error state on a calm screen.
 */
export default function StopButton() {
  const [stopping, setStopping] = useState(false)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    let alive = true
    const apply = (state: AgentState | null | undefined) => {
      if (!alive) return
      setRunning(state?.status === 'running' || state?.status === 'waiting-approval')
    }
    window.goga.invoke('agent:state').then(apply).catch(() => {})
    const off = window.goga.on('agent:state', apply)
    return () => { alive = false; off() }
  }, [])

  const handleStop = async () => {
    setStopping(true)
    // Speech goes first, and on its own. Stop has to cut Goga off mid-sentence, and
    // the silence must not wait on stopping the rest: stopSpeaking can take up to
    // three seconds to confirm shutdown, and a quiet voice is the part the user
    // asked for first. The other stops do not depend on it.
    const silence = window.goga.invoke('voice:stopSpeaking').catch(() => {})
    await Promise.all([
      silence,
      window.goga.invoke('action:stop'),
      window.goga.invoke('developer:stop'),
      window.goga.invoke('agent:stop')
    ])
    setStopping(false)
  }

  return (
    <button
      onClick={handleStop}
      disabled={stopping}
      title="Stop the agent and all actions (also: Ctrl+Shift+Escape)"
      className={running ? 'g-btn g-btn--danger' : 'g-btn g-btn--ghost g-btn--sm'}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {stopping ? 'Stopping…' : running ? '⏹ Stop' : 'Stop'}
    </button>
  )
}
