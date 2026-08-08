import { useState, useRef, useCallback } from 'react'

// Extend window type for webkit speech
declare global {
  interface Window {
    webkitSpeechRecognition: new () => SpeechRecognition
    SpeechRecognition: new () => SpeechRecognition
  }
}

export function useSpeech(onTranscript: (text: string) => void) {
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const recogRef = useRef<SpeechRecognition | null>(null)

  const startListening = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) { alert('Speech recognition not supported in this browser.'); return }

    // Stop any ongoing speech before listening
    window.goga.invoke('tts:stop')

    const recog = new SR()
    recog.lang = 'en-US'
    recog.interimResults = false
    recog.maxAlternatives = 1
    recogRef.current = recog

    recog.onresult = (e) => {
      const transcript = e.results[0][0].transcript.trim()
      if (transcript) onTranscript(transcript)
    }
    recog.onend = () => setListening(false)
    recog.onerror = (e) => {
      setListening(false)
      console.error('Speech recognition error:', e.error, e.message)
      if (e.error === 'not-allowed') {
        alert('Microphone access denied. Please allow microphone access in Electron settings.')
      } else if (e.error === 'no-speech') {
        // silent — user just didn't speak
      } else if (e.error === 'audio-capture') {
        alert('No microphone found. Check that your headset is connected and set as default input device in Windows Sound settings.')
      } else {
        alert(`Speech error: ${e.error}`)
      }
    }

    recog.start()
    setListening(true)
  }, [onTranscript])

  const stopListening = useCallback(() => {
    recogRef.current?.stop()
    setListening(false)
  }, [])

  const speak = useCallback(async (text: string) => {
    // Strip markdown bold/italic markers for cleaner speech
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
