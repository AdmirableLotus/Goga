/**
 * Speech provider interface — local-first, swappable.
 * WindowsSpeechProvider uses System.Speech (offline).
 * Future: WhisperProvider, PiperProvider, etc.
 */

export interface SpeechRecognitionResult {
  transcript: string
  confidence?: number
}

export interface ISttProvider {
  /** Listen once, resolve when speech ends or timeout. Returns empty string if no speech. */
  recognize(timeoutMs?: number): Promise<SpeechRecognitionResult>
  /** Start continuous recognition — calls onResult for each utterance until stopped. */
  startContinuous(onResult: (r: SpeechRecognitionResult) => void, onError?: (e: Error) => void): void
  /** Stop continuous recognition. */
  stopContinuous(): void
  /** Abort any in-progress recognition. */
  abort(): void
  readonly name: string
}

export interface ITtsProvider {
  speak(text: string, rate: number, volume: number, voiceName: string): Promise<void>
  stop(): void
  getVoices(): Promise<string[]>
  readonly name: string
  /** Optional callback invoked when audio playback has genuinely started (not just buffered). */
  onPlaybackStart?: () => void
  /** Optional callback invoked with amplitude values during playback (0–1). */
  onAmplitude?: (amp: number) => void
}
