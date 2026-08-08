import React, { createContext, useContext, useState, useCallback } from 'react'
import type { GogaVisualState } from '../components/GogaCore/GogaVisualState'

interface GogaVisualContextValue {
  visualState: GogaVisualState
  setVisualState: (s: GogaVisualState) => void
  audioAmplitude: number          // 0–1, for speaking pulse
  setAudioAmplitude: (v: number) => void
}

const GogaVisualContext = createContext<GogaVisualContextValue>({
  visualState: 'idle',
  setVisualState: () => {},
  audioAmplitude: 0,
  setAudioAmplitude: () => {},
})

export function GogaVisualProvider({ children }: { children: React.ReactNode }) {
  const [visualState, setVisualStateRaw] = useState<GogaVisualState>('idle')
  const [audioAmplitude, setAudioAmplitude] = useState(0)

  const setVisualState = useCallback((s: GogaVisualState) => {
    setVisualStateRaw(s)
    // Auto-return to idle after transient states
    if (s === 'success' || s === 'error' || s === 'stopped') {
      setTimeout(() => setVisualStateRaw('idle'), s === 'error' ? 2000 : 3000)
    }
  }, [])

  return (
    <GogaVisualContext.Provider value={{ visualState, setVisualState, audioAmplitude, setAudioAmplitude }}>
      {children}
    </GogaVisualContext.Provider>
  )
}

export function useGogaVisual() {
  return useContext(GogaVisualContext)
}
