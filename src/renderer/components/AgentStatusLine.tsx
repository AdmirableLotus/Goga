import React, { useEffect, useRef, useState } from 'react'
import type { AgentState } from '@shared/types'
import {
  ACTIVE_PHASES, SETTLED_HOLD_MS, phaseOf, pulseMsFor, statusView,
  type StatusPhase, type StatusView,
} from './GogaCore/agentStatus'

/**
 * The live "what is Goga doing" line on the Chat page.
 *
 * It reads the agent loop's own AgentState plus the page's loading/streaming
 * flags, so it can only ever say what is actually happening. The wording and the
 * escalation rules live in GogaCore/agentStatus.ts.
 *
 * Cost: one 500 ms interval, and only while a run is in flight. When idle there
 * is no timer and no animation.
 *
 * Each phase gets its own small tell, because the two states that actually occur
 * on every turn — a short think and then streaming — must be legible on their own.
 * The escalation to "having a headache" is a bonus, not the only signal.
 */

/** Milliseconds spent in the current phase. Resets whenever the phase changes. */
function usePhaseClock(phase: StatusPhase, active: boolean): number {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(Date.now())

  useEffect(() => {
    startRef.current = Date.now()
    setElapsed(0)
  }, [phase])

  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setElapsed(Date.now() - startRef.current), 500)
    return () => clearInterval(id)
  }, [active, phase])

  return elapsed
}

/** A finished run keeps its label for a moment, then the line goes quiet again. */
function useSettledExpiry(phase: StatusPhase): boolean {
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    setExpired(false)
    if (ACTIVE_PHASES.has(phase) || phase === 'idle') return
    const id = setTimeout(() => setExpired(true), SETTLED_HOLD_MS)
    return () => clearTimeout(id)
  }, [phase])
  return expired
}

export function useAgentStatus(
  agentState: AgentState | null,
  loading: boolean,
  streaming: boolean,
): StatusView {
  const phase = phaseOf({ agentState, loading, streaming })
  const active = ACTIVE_PHASES.has(phase)
  const elapsed = usePhaseClock(phase, active)
  const expired = useSettledExpiry(phase)
  const shown: StatusPhase = expired ? 'idle' : phase
  return statusView(shown, elapsed, agentState)
}

/**
 * The per-phase tell. Pure CSS animation, no timers, and nothing at all when the
 * phase is settled — an idle line is a still dot.
 */
function PhaseGlyph({ phase }: { phase: StatusPhase }) {
  if (phase === 'streaming') {
    return (
      <span className="g-status-glyph g-status-glyph--typing" aria-hidden="true">
        <i /><i /><i />
      </span>
    )
  }
  if (phase === 'thinking') {
    return <span className="g-status-glyph g-status-glyph--orbit" aria-hidden="true"><i /></span>
  }
  if (phase === 'tool') {
    return <span className="g-status-glyph g-status-glyph--spin" aria-hidden="true"><i /></span>
  }
  if (phase === 'approval') {
    return <span className="g-status-glyph g-status-glyph--wait" aria-hidden="true"><i /></span>
  }
  return <span className="g-status-dot" aria-hidden="true" />
}

export default function AgentStatusLine({
  agentState, loading, streaming, onHeat,
}: {
  agentState: AgentState | null
  loading: boolean
  streaming: boolean
  /** Reports 0–1 agitation so the triangle scene can follow the same curve. */
  onHeat?: (heat: number) => void
}) {
  const view = useAgentStatus(agentState, loading, streaming)
  const { heat } = view

  useEffect(() => { onHeat?.(heat) }, [heat, onHeat])

  // Faster pulse as it gets more agitated; capped so it never becomes a strobe.
  // Handed to CSS as --pulse-ms, which is the only place the duration is set.
  const pulseMs = pulseMsFor(view.phase, heat)

  return (
    <div
      className={`g-status g-status--${view.tone} g-status--phase-${view.phase}${view.active ? ' g-status--live' : ''}`}
      style={{ ['--heat' as string]: heat.toFixed(2), ['--pulse-ms' as string]: `${pulseMs}ms` }}
      role="status"
      aria-live="polite"
    >
      <PhaseGlyph phase={view.phase} />
      <span className="g-status-label">{view.label}</span>
      {view.detail && <span className="g-status-detail g-mono">{view.detail}</span>}
      {view.active && view.elapsedMs >= 1000 && (
        <span className="g-status-time g-mono">{Math.floor(view.elapsedMs / 1000)}s</span>
      )}
    </div>
  )
}
