import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

export type GestureEvent =
  | { type: 'rotate'; deltaY: number }
  | { type: 'scale'; factor: number }
  | { type: 'listen' }       // open palm held
  | { type: 'stop' }         // closed fist held

interface GestureControllerOptions {
  onGesture: (e: GestureEvent) => void
  wasmPath?: string
  modelPath?: string
}

const PINCH_THRESHOLD = 0.06   // normalized distance for pinch
const HOLD_FRAMES = 18          // frames to hold before triggering
const OPEN_PALM_THRESHOLD = 0.15

function landmarkDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

function isPinched(landmarks: { x: number; y: number; z: number }[]): boolean {
  // Thumb tip (4) to index tip (8)
  return landmarkDistance(landmarks[4], landmarks[8]) < PINCH_THRESHOLD
}

function isOpenPalm(landmarks: { x: number; y: number; z: number }[]): boolean {
  // All finger tips far from palm base
  const tips = [8, 12, 16, 20]
  const wrist = landmarks[0]
  return tips.every(i => landmarkDistance(landmarks[i], wrist) > OPEN_PALM_THRESHOLD)
}

function isClosedFist(landmarks: { x: number; y: number; z: number }[]): boolean {
  const tips = [8, 12, 16, 20]
  const wrist = landmarks[0]
  return tips.every(i => landmarkDistance(landmarks[i], wrist) < 0.12)
}

export class GogaGestureController {
  private landmarker: HandLandmarker | null = null
  private video: HTMLVideoElement | null = null
  private animId = 0
  private onGesture: (e: GestureEvent) => void
  private wasmPath: string
  private modelPath: string

  // State tracking
  private prevPinchCenter: { x: number; y: number } | null = null
  private prevTwoHandDist: number | null = null
  private openPalmFrames = 0
  private fistFrames = 0
  private lastGesture = ''

  constructor(opts: GestureControllerOptions) {
    this.onGesture = opts.onGesture
    this.wasmPath = opts.wasmPath ?? '/mediapipe'
    this.modelPath = opts.modelPath ?? '/mediapipe/hand_landmarker.task'
  }

  async start(videoEl: HTMLVideoElement) {
    this.video = videoEl

    const vision = await FilesetResolver.forVisionTasks(this.wasmPath)
    this.landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: this.modelPath, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.5,
    })

    // Start webcam
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } })
    videoEl.srcObject = stream
    await videoEl.play()

    this.loop()
  }

  private loop() {
    if (!this.landmarker || !this.video) return
    this.animId = requestAnimationFrame(() => this.loop())

    const results = this.landmarker.detectForVideo(this.video, performance.now())
    const hands = results.landmarks ?? []

    if (hands.length === 0) {
      this.prevPinchCenter = null
      this.prevTwoHandDist = null
      this.openPalmFrames = 0
      this.fistFrames = 0
      return
    }

    // ── ONE HAND ──────────────────────────────────────────────────────────────
    if (hands.length === 1) {
      const lm = hands[0]

      // Open palm → listen
      if (isOpenPalm(lm)) {
        this.openPalmFrames++
        this.fistFrames = 0
        if (this.openPalmFrames === HOLD_FRAMES && this.lastGesture !== 'listen') {
          this.lastGesture = 'listen'
          this.onGesture({ type: 'listen' })
        }
      } else if (isClosedFist(lm)) {
        this.fistFrames++
        this.openPalmFrames = 0
        if (this.fistFrames === HOLD_FRAMES && this.lastGesture !== 'stop') {
          this.lastGesture = 'stop'
          this.onGesture({ type: 'stop' })
        }
      } else {
        this.openPalmFrames = 0
        this.fistFrames = 0
        this.lastGesture = ''
      }

      // Pinch + drag → rotate
      if (isPinched(lm)) {
        const center = {
          x: (lm[4].x + lm[8].x) / 2,
          y: (lm[4].y + lm[8].y) / 2,
        }
        if (this.prevPinchCenter) {
          const dx = center.x - this.prevPinchCenter.x
          if (Math.abs(dx) > 0.002) {
            this.onGesture({ type: 'rotate', deltaY: dx * 8 })
          }
        }
        this.prevPinchCenter = center
      } else {
        this.prevPinchCenter = null
      }
    }

    // ── TWO HANDS ─────────────────────────────────────────────────────────────
    if (hands.length === 2) {
      const [h1, h2] = hands
      if (isPinched(h1) && isPinched(h2)) {
        const c1 = { x: (h1[4].x + h1[8].x) / 2, y: (h1[4].y + h1[8].y) / 2 }
        const c2 = { x: (h2[4].x + h2[8].x) / 2, y: (h2[4].y + h2[8].y) / 2 }
        const dist = landmarkDistance(c1, c2)
        if (this.prevTwoHandDist !== null) {
          const factor = dist / this.prevTwoHandDist
          if (Math.abs(factor - 1) > 0.01) {
            this.onGesture({ type: 'scale', factor })
          }
        }
        this.prevTwoHandDist = dist
      } else {
        this.prevTwoHandDist = null
      }
    }
  }

  stop() {
    cancelAnimationFrame(this.animId)
    if (this.video?.srcObject) {
      const stream = this.video.srcObject as MediaStream
      stream.getTracks().forEach(t => t.stop())
      this.video.srcObject = null
    }
    this.landmarker?.close()
    this.landmarker = null
  }
}
