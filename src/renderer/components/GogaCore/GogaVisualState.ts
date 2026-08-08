import type { AgentState } from '@shared/types'

export type GogaVisualState =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'acting'
  | 'seeing'
  | 'searching'
  | 'speaking'
  | 'waitingApproval'
  | 'success'
  | 'error'
  | 'stopped'
  | 'wakeDetected'

export function agentStateToVisual(state: AgentState | null, extras?: { listening?: boolean; speaking?: boolean }): GogaVisualState {
  if (extras?.listening) return 'listening'
  if (extras?.speaking) return 'speaking'
  if (!state || state.status === 'idle') return 'idle'
  if (state.status === 'stopped') return 'stopped'
  if (state.status === 'done') return 'success'
  if (state.status === 'error') return 'error'
  if (state.status === 'waiting-approval') return 'waitingApproval'
  if (state.status === 'running') {
    const tool = state.currentTool ?? ''
    if (tool.startsWith('vision.')) return 'seeing'
    if (tool.startsWith('web.')) return 'searching'
    if (tool.startsWith('computer.') || tool.startsWith('browser.') || tool.startsWith('shell.')) return 'acting'
    return 'thinking'
  }
  return 'idle'
}

// Color palette per state
export const STATE_COLORS: Record<GogaVisualState, { primary: number; secondary: number; core: number }> = {
  idle:            { primary: 0x6633cc, secondary: 0x3311aa, core: 0x9966ff },
  listening:       { primary: 0x00ccff, secondary: 0x0066cc, core: 0x00ffff },
  transcribing:    { primary: 0x00aadd, secondary: 0x0044aa, core: 0x88ddff },
  thinking:        { primary: 0x7744ee, secondary: 0x4422bb, core: 0xaa88ff },
  acting:          { primary: 0x8833ff, secondary: 0x00aaff, core: 0xffffff },
  seeing:          { primary: 0x00ddff, secondary: 0x0055ff, core: 0x88ffff },
  searching:       { primary: 0x5522dd, secondary: 0x00ccff, core: 0xccaaff },
  speaking:        { primary: 0x9955ff, secondary: 0x44aaff, core: 0xffffff },
  waitingApproval: { primary: 0xdd8800, secondary: 0xaa5500, core: 0xffcc44 },
  success:         { primary: 0x00cc88, secondary: 0x008855, core: 0x44ffcc },
  error:           { primary: 0xcc2222, secondary: 0x881111, core: 0xff4444 },
  stopped:         { primary: 0x332244, secondary: 0x221133, core: 0x554466 },
  wakeDetected:    { primary: 0x00ffff, secondary: 0x00aaff, core: 0xffffff },
}
