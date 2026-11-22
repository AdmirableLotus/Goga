import { nanoid } from '../../utils/nanoid'
import type { LabLiveEvent, LabLiveState, LiveEntry, LiveFrame, LiveKind } from '../../../shared/lab'

/**
 * The live view of a Lab run: what happened, in the order it happened, while it happens.
 *
 * This file only records and forwards. It cannot start a run, cannot approve anything and
 * cannot send a request — every entry it carries is written by the code that actually did
 * the thing, at the moment it did it. That is the whole point: a visual view of work is
 * worth nothing if the view can invent the work.
 *
 * Three rules the rest of the code holds this to:
 *
 *   1. An entry exists only because something occurred. Nothing here generates a "thinking"
 *      line, a progress estimate or a filler step.
 *   2. A frame is a real screenshot taken from the browser Goga drives, with the address it
 *      was taken at and its own capture time. No capture means no frame — never a placeholder.
 *   3. When nothing is running, the state says idle. `liveState()` with no active run returns
 *      an empty log and no frame, so the page has nothing to animate.
 */

const MAX_ENTRIES = 400

let publisher: ((event: LabLiveEvent) => void) | null = null

interface Buffer {
  active: boolean
  runKind: string | null
  label: string
  startedAt: string | null
  endedAt: string | null
  entries: LiveEntry[]
  frame: LiveFrame | null
}

const idle = (): Buffer => ({
  active: false,
  runKind: null,
  label: '',
  startedAt: null,
  endedAt: null,
  entries: [],
  frame: null,
})

let buffer: Buffer = idle()

/** Wire the renderer channel. Called once from main; absent in tests and in headless use. */
export function setLivePublisher(fn: ((event: LabLiveEvent) => void) | null): void {
  publisher = fn
}

function statusText(): string {
  if (buffer.active) return `${buffer.label || 'A run'} is working now.`
  if (buffer.endedAt) return `${buffer.label || 'The run'} finished at ${buffer.endedAt.slice(11, 19)}. No longer working.`
  return 'Idle — nothing is running.'
}

/** What the page shows on open, and what every push carries as its context. */
export function liveState(): LabLiveState {
  return {
    active: buffer.active,
    runKind: buffer.runKind,
    label: buffer.label,
    startedAt: buffer.startedAt,
    endedAt: buffer.endedAt,
    entries: buffer.entries.slice(-MAX_ENTRIES),
    frame: buffer.frame,
    status: statusText(),
  }
}

/**
 * Open a live view for a run that is starting now.
 *
 * The previous log and frame are dropped: a new run starts from empty, so nothing from an
 * earlier run can be mistaken for this one's work or this one's picture.
 */
export function beginLiveRun(kind: string, label: string): LabLiveState {
  buffer = { ...idle(), active: true, runKind: kind, label, startedAt: new Date().toISOString() }
  publisher?.({ type: 'state', state: liveState() })
  return liveState()
}

/** One line, written because something happened. `at` is the moment of the call. */
export function publishEntry(kind: LiveKind, label: string, detail = ''): LiveEntry {
  const entry: LiveEntry = {
    id: nanoid(),
    at: new Date().toISOString(),
    kind,
    label: String(label ?? '').slice(0, 160),
    detail: String(detail ?? '').slice(0, 1200),
  }
  buffer.entries = [...buffer.entries.slice(-(MAX_ENTRIES - 1)), entry]
  publisher?.({ type: 'entry', entry, state: liveState() })
  return entry
}

/** Close the view. Anything already shown stays, marked as no longer live. */
export function endLiveRun(note: string): LabLiveState {
  if (buffer.active) {
    publishEntry('stop', note || 'The run ended.')
  }
  buffer.active = false
  buffer.endedAt = new Date().toISOString()
  if (buffer.frame) buffer.frame = { ...buffer.frame, live: false }
  publisher?.({ type: 'state', state: liveState() })
  return liveState()
}

/**
 * Record a screenshot taken from the browser Goga drives.
 *
 * Called only with a picture that was actually returned by the browser layer. An empty
 * capture is dropped rather than stored, so the pane can never show an old picture as if it
 * were current.
 */
export function recordFrame(shot: { base64: string; url: string }): LiveFrame | null {
  const base64 = String(shot?.base64 ?? '')
  if (!base64) return null
  const frame: LiveFrame = {
    base64,
    url: String(shot?.url ?? ''),
    capturedAt: new Date().toISOString(),
    live: buffer.active,
  }
  buffer.frame = frame
  publisher?.({ type: 'frame', frame })
  return frame
}

// ── The frame loop ─────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null
let capturing = false

/**
 * Ask for a fresh picture every `everyMs` while the run is active.
 *
 * `capture` is the caller's own route to the browser — the browser layer's screenshot on
 * Firefox, the same Playwright page on Brave. It returns null when there is nothing attached,
 * and nothing is pushed in that case. The loop never invents a frame and stops the moment the
 * run ends.
 */
export function startFrameLoop(capture: () => Promise<{ base64: string; url: string } | null>, everyMs = 700): void {
  stopFrameLoop()

  const tick = (): void => {
    if (!buffer.active || capturing) return
    capturing = true
    void (async () => {
      try {
        const shot = await capture()
        if (shot && shot.base64 && buffer.active) recordFrame(shot)
      } catch {
        // No picture this tick. The pane keeps the last real one, timestamped as such.
      } finally {
        capturing = false
      }
    })()
  }

  // One capture straight away. A short run on loopback can finish inside a single interval,
  // and a pane that only ever shows a picture after the run is not the thing the user asked
  // for. This is still a real capture â€” it is just taken at the start instead of 700ms later.
  tick()
  timer = setInterval(tick, Math.max(300, everyMs))
  timer.unref?.()
}

export function stopFrameLoop(): void {
  if (timer) { clearInterval(timer); timer = null }
}

/** Test hook: forget everything. Not used by the app. */
export function resetLiveRunForTests(): void {
  stopFrameLoop()
  buffer = idle()
  publisher = null
}
