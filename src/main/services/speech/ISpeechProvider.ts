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
  /** True while an audio playback process is alive. */
  isPlaying?(): boolean
  /**
   * Stop playback AND resolve only after the underlying playback process has
   * genuinely terminated (so the speakers are silent before the mic opens).
   * Providers without a separate process may resolve immediately.
   */
  stopAndWait?(): Promise<void>
  /**
   * Speak text that arrives piece by piece (a reply still being written), starting with
   * the first piece. Ends when end() is called and everything pushed has been played.
   */
  speakStream?(rate: number, volume: number, voiceName: string): SpeechStream
  /** Release long-lived helper processes when this provider is replaced or Goga quits. */
  dispose?(): void
}

export interface SpeechStream {
  /** Queue one sentence (or short group of sentences) to be spoken after the previous ones. */
  push(text: string): void
  /** No more text is coming. */
  end(): void
  /** Resolves when everything has been played, or the stream was stopped. */
  readonly done: Promise<void>
}
