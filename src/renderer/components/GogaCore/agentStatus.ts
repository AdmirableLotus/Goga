import type { AgentState } from '@shared/types'

/**
 * The Chat page's "what is Goga doing right now" line.
 *
 * Everything here is derived from state the app already has — AgentState from the
 * agent loop, plus the page's own loading/streaming flags. There is no second
 * state machine: if the loop says idle, this says idle.
 *
 * All wording lives in this file. Change a phrase here and the whole app follows.
 */

export type StatusPhase =
  | 'idle'
  | 'thinking'
  | 'tool'
  | 'approval'
  | 'streaming'
  | 'error'
  | 'done'
  | 'stopped'

export type StatusTone = 'calm' | 'busy' | 'wait' | 'bad' | 'good' | 'off'

export interface StatusView {
  phase: StatusPhase
  label: string
  /** The concrete thing behind the phrase — a tool name, an error, a pending action. */
  detail?: string
  tone: StatusTone
  /** 0 = calm, 1 = maximum agitation. Drives the dot and the triangle scene. */
  heat: number
  /** True while work is actually in flight (the only time the clock ticks). */
  active: boolean
  elapsedMs: number
}

// ── WORDING ──────────────────────────────────────────────────────────────────
// One table. Nothing else in the renderer hard-codes a status phrase.

/**
 * Thinking escalates: calm → restless → headache. Times are milliseconds in the phase.
 *
 * The tiers are set from what this machine actually does, not from taste. Measured
 * on the local model, a think lasts about 2 s before the first token arrives, and a
 * think that has to plan a tool call runs 5–8 s. The old 8 s / 25 s tiers therefore
 * never fired: the phase was already over. 4 s is reachable on a real think, and
 * 20 s is a genuine stall worth calling a headache.
 *
 * The escalation is not the only thing the user sees — the first tier has its own
 * animation, and the streaming phase has its own, because those are the two states
 * that actually occur on every turn.
 */
export const THINKING_TIERS: { afterMs: number; label: string }[] = [
  { afterMs: 0,      label: 'messing around in there…' },
  { afterMs: 4_000,  label: 'pacing about in there…' },
  { afterMs: 20_000, label: 'having a headache' },
]

/** A tool call says what the tool actually is. `long` is used once it drags on. */
export const TOOL_PHRASES: { match: RegExp; label: string; long: string }[] = [
  { match: /^filesystem\.|^files\./,                          label: 'digging through files',      long: 'still digging through files' },
  { match: /^browser\./,                                      label: 'poking at the browser',      long: 'still poking at the browser' },
  { match: /^computer\./,                                     label: 'moving the mouse about',     long: 'still moving the mouse about' },
  { match: /^shell\.|^process\.|^python\./,                   label: 'running commands',           long: 'still running commands' },
  { match: /^web\.|^research\./,                              label: 'reading the web',            long: 'still reading the web' },
  { match: /^vision\./,                                       label: 'squinting at the screen',    long: 'still squinting at the screen' },
  { match: /^trading\.|^broker\./,                            label: 'staring at the market',      long: 'still staring at the market' },
  { match: /^security\./,                                     label: 'sniffing around',            long: 'still sniffing around' },
  { match: /^osint\./,                                        label: 'digging up public records',  long: 'still digging up public records' },
  { match: /^memory\.|^brain\./,                              label: 'rummaging in memory',        long: 'still rummaging in memory' },
  { match: /^library\./,                                      label: 'flipping through books',     long: 'still flipping through books' },
  { match: /^ee\.|^electronics\.|^microcontroller\.|^schematik\./, label: 'doing the maths',       long: 'still doing the maths' },
  { match: /^evolution\.|^self\./,                            label: 'tinkering with itself',      long: 'still tinkering with itself' },
  { match: /^schedule\./,                                     label: 'checking the calendar',      long: 'still checking the calendar' },
  { match: /^notepad\./,                                      label: 'writing it down',            long: 'still writing it down' },
  { match: /^clock\./,                                        label: 'checking the time',          long: 'still checking the time' },
]

export const STATUS_PHRASES = {
  idle:      'Ready',
  approval:  'waiting on you',
  streaming: 'talking',
  error:     'that hurt',
  done:      'done',
  stopped:   'stopped',
  toolFallback:     'working',
  toolFallbackLong: 'still working',
}

/** A tool call is "dragging" after this long, and switches to its `long` phrase. */
export const TOOL_LONG_AFTER_MS = 20_000

/** How long a finished/stopped run keeps its label before the line goes back to Ready. */
export const SETTLED_HOLD_MS = 4_000

/**
 * Heat ramps over these windows, then stops. Capped so a long run stays watchable.
 *
 * The important part is the floor. A think on this machine lasts about two seconds,
 * so a curve that starts at 0 and ramps over 30 s left the backdrop at 0.07 — which
 * is why the animation had nothing to show. Every active phase now starts at a
 * visible floor and rises from there, and streaming (the state that actually lasts)
 * holds a steady, visible value instead of a token 0.15.
 */
const THINKING_HEAT_FLOOR = 0.40
const THINKING_HEAT_MS = 20_000
const TOOL_HEAT_FLOOR = 0.55
const TOOL_HEAT_MS = 30_000
const TOOL_HEAT_CAP = 0.90
const APPROVAL_HEAT = 0.30
const STREAMING_HEAT = 0.50

/** Clamp to 0–1. A non-finite input becomes 0 rather than NaN, so a bad heat can
 *  never turn into an invalid CSS duration. */
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0)

export function thinkingPhrase(elapsedMs: number): string {
  let label = THINKING_TIERS[0].label
  for (const tier of THINKING_TIERS) if (elapsedMs >= tier.afterMs) label = tier.label
  return label
}

export function toolPhrase(tool: string, elapsedMs: number): string {
  const family = TOOL_PHRASES.find(f => f.match.test(tool))
  const long = elapsedMs >= TOOL_LONG_AFTER_MS
  if (!family) return long ? STATUS_PHRASES.toolFallbackLong : STATUS_PHRASES.toolFallback
  return long ? family.long : family.label
}

export function heatFor(phase: StatusPhase, elapsedMs: number): number {
  if (phase === 'thinking') {
    return clamp01(THINKING_HEAT_FLOOR + (1 - THINKING_HEAT_FLOOR) * (elapsedMs / THINKING_HEAT_MS))
  }
  if (phase === 'tool') {
    return Math.min(TOOL_HEAT_CAP, TOOL_HEAT_FLOOR + (TOOL_HEAT_CAP - TOOL_HEAT_FLOOR) * (elapsedMs / TOOL_HEAT_MS))
  }
  if (phase === 'approval') return APPROVAL_HEAT
  if (phase === 'streaming') return STREAMING_HEAT
  return 0
}

/** Phases where the clock runs and the animation is allowed to move. */
export const ACTIVE_PHASES: ReadonlySet<StatusPhase> = new Set<StatusPhase>([
  'thinking', 'tool', 'approval', 'streaming',
])

// ── PULSE SPEED ──────────────────────────────────────────────────────────────
// The status dot quickens as heat rises, and stops dead when nothing runs.

/** Slowest the dot ever pulses. */
export const PULSE_SLOW_MS = 1600
/** Fastest it ever pulses. The floor is what keeps a long run from becoming a
 *  strobe: at heat 1 the dot still takes 700 ms per cycle. */
export const PULSE_FAST_MS = 700

/**
 * Dot pulse period in milliseconds, or 0 when no animation should run at all.
 * 0 is a real value here: the caller sets animation-duration to it, which is how
 * an idle line ends up with no animation rather than a hidden one.
 */
export function pulseMsFor(phase: StatusPhase, heat: number): number {
  if (!ACTIVE_PHASES.has(phase)) return 0
  const h = clamp01(heat)
  return Math.round(PULSE_SLOW_MS - (PULSE_SLOW_MS - PULSE_FAST_MS) * h)
}

export interface StatusInput {
  agentState: AgentState | null
  /** ChatPage's own "a send is in flight" flag. */
  loading: boolean
  /** True while assistant tokens are arriving. */
  streaming: boolean
}

/**
 * Which phase we are in, from the real state only.
 *
 * `loading` outranks a stale `done`/`stopped`/`error` left over from the previous
 * turn, so a new send never shows the last run's label.
 */
export function phaseOf({ agentState, loading, streaming }: StatusInput): StatusPhase {
  const status = agentState?.status
  if (status === 'waiting-approval') return 'approval'
  if (status === 'running') return agentState?.currentTool ? 'tool' : 'thinking'
  if (streaming) return 'streaming'
  if (loading) return 'thinking'
  if (status === 'error') return 'error'
  if (status === 'done') return 'done'
  if (status === 'stopped') return 'stopped'
  return 'idle'
}

export function statusView(phase: StatusPhase, elapsedMs: number, agentState: AgentState | null): StatusView {
  const active = ACTIVE_PHASES.has(phase)
  const heat = heatFor(phase, elapsedMs)

  switch (phase) {
    case 'thinking':
      return { phase, label: thinkingPhrase(elapsedMs), tone: 'busy', heat, active, elapsedMs }

    case 'tool': {
      const tool = agentState?.currentTool ?? ''
      return { phase, label: toolPhrase(tool, elapsedMs), detail: tool || undefined, tone: 'busy', heat, active, elapsedMs }
    }

    case 'approval':
      return {
        phase,
        label: STATUS_PHRASES.approval,
        detail: agentState?.pendingApproval?.tool,
        tone: 'wait', heat, active, elapsedMs,
      }

    case 'streaming':
      return { phase, label: STATUS_PHRASES.streaming, tone: 'busy', heat, active, elapsedMs }

    case 'error':
      return {
        phase,
        label: STATUS_PHRASES.error,
        detail: agentState?.error ? agentState.error.slice(0, 90) : undefined,
        tone: 'bad', heat: 0, active: false, elapsedMs,
      }

    case 'done':
      return { phase, label: STATUS_PHRASES.done, tone: 'good', heat: 0, active: false, elapsedMs }

    case 'stopped':
      return { phase, label: STATUS_PHRASES.stopped, tone: 'off', heat: 0, active: false, elapsedMs }

    default:
      return { phase: 'idle', label: STATUS_PHRASES.idle, tone: 'calm', heat: 0, active: false, elapsedMs }
  }
}
