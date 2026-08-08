import React, { useState } from 'react'

export default function StopButton() {
  const [stopping, setStopping] = useState(false)

  const handleStop = async () => {
    setStopping(true)
    await Promise.all([
      window.goga.invoke('action:stop'),
      window.goga.invoke('agent:stop')
    ])
    setStopping(false)
  }

  return (
    <button
      onClick={handleStop}
      disabled={stopping}
      title="Stop agent and all actions (also: Ctrl+Shift+Escape)"
      style={{
        background: 'var(--danger)', color: '#fff',
        fontWeight: 600, padding: '5px 14px',
        WebkitAppRegion: 'no-drag' as never
      }}
    >
      {stopping ? 'Stopping…' : '⏹ Stop'}
    </button>
  )
}
