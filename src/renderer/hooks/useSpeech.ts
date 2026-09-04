import { useState, useRef, useCallback } from 'react'

export function useSpeech(onTranscript: (text: string) => void) {
  const [listening, setListening]   = useState(false)
  const [speaking, setSpeaking]     = useState(false)
  const abortedRef = useRef(false)

  const startListening = useCallback(async () => {
    if (listening) return
    abortedRef.current = false
    setListening(true)
    window.goga.invoke('tts:stop')
    try {
      const { transcript } = await window.goga.invoke('stt:start')
      if (!abortedRef.current && transcript) onTranscript(transcript)
    } catch {
      // ignore — user stopped or no mic
    } finally {
      setListening(false)
    }
  }, [listening, onTranscript])

  const stopListening = useCallback(() => {
    abortedRef.current = true
    setListening(false)
    window.goga.invoke('stt:stop').catch(() => {})
  }, [])

  const speak = useCallback(async (text: string) => {
    const clean = text.replace(/\*\*/g, '').replace(/\*/g, '').replace(/__/g, '').trim()
    if (!clean) return
    setSpeaking(true)
    try {
      await window.goga.invoke('tts:speak', clean)
    } finally {
      setSpeaking(false)
    }
  }, [])

  const stopSpeaking = useCallback(() => {
    window.goga.invoke('tts:stop')
    setSpeaking(false)
  }, [])

  return { listening, speaking, startListening, stopListening, speak, stopSpeaking }
}
