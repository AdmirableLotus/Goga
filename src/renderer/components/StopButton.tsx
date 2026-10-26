import React, { useState } from 'react'
import type { ElectronCSSProperties } from '../types/electron-styles'

export default function StopButton() {
  const [stopping, setStopping] = useState(false)

  const handleStop = async () => {
    setStopping(true)
    await Promise.all([
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
      title="Stop agent and all actions (also: Ctrl+Shift+Escape)"
      style={{
        background: 'var(--danger)', color: '#fff',
        fontWeight: 600, padding: '5px 14px',
        WebkitAppRegion: 'no-drag'
      } as ElectronCSSProperties}
    >
      {stopping ? 'Stopping…' : '⏹ Stop'}
    </button>
  )
}
