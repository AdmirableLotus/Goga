import React, { useState, useEffect, useRef } from 'react'
import type { Mission, MissionEvent, MissionStep } from '@shared/types'

const STATUS_ICON: Record<string, string> = {
  pending: '○', running: '⋯', verifying: '⋯', retrying: '↺',
  succeeded: '✓', failed: '✗', cancelled: '⊘',
}
const STATUS_COLOR: Record<string, string> = {
  pending: '#443355', running: '#8b5cff', verifying: '#aa88ff', retrying: '#cc8800',
  succeeded: '#00ffcc', failed: '#ff4466', cancelled: '#554477',
}
const MISSION_STATUS_COLOR: Record<string, string> = {
  planning: '#8b5cff', running: '#8b5cff', verifying: '#aa88ff',
  recovering: '#cc8800', waiting_approval: '#ffaa00',
  completed: '#00ffcc', failed: '#ff4466', cancelled: '#554477',
}

export default function MissionPage() {
  const [goal, setGoal]           = useState('')
  const [activeMission, setActiveMission] = useState<Mission | null>(null)
  const [events, setEvents]       = useState<MissionEvent[]>([])
  const [history, setHistory]     = useState<Mission[]>([])
  const [loading, setLoading]     = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Load mission list on mount
  useEffect(() => {
    window.goga.invoke('mission:list').then(list => {
      const done = list.filter(m => m.status === 'completed' || m.status === 'failed' || m.status === 'cancelled')
      setHistory(done.slice(-10).reverse())
      const running = list.find(m => m.status === 'running' || m.status === 'planning' || m.status === 'recovering' || m.status === 'waiting_approval')
      if (running) { setActiveMission(running); setLoading(true) }
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const unsubs = [
      window.goga.on('mission:event', (evt: MissionEvent) => {
        setEvents(prev => [...prev.slice(-99), evt])
      }),
      window.goga.on('mission:state', (m: Mission) => {
        setActiveMission(m)
        if (m.status === 'completed' || m.status === 'failed' || m.status === 'cancelled') {
          setLoading(false)
          setHistory(prev => [m, ...prev.filter(x => x.id !== m.id)].slice(0, 10))
        }
      }),
    ]
    return () => unsubs.forEach(u => u())
  }, [])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [events])

  const start = async () => {
    const trimmed = goal.trim()
    if (!trimmed || loading) return
    setGoal(''); setEvents([]); setLoading(true)
    try {
      const id = await window.goga.invoke('mission:start', trimmed)
      const m = await window.goga.invoke('mission:state', id)
      if (m) setActiveMission(m)
    } catch (e) {
      setLoading(false)
      setEvents([{ type: 'mission.failed', missionId: '', timestamp: Date.now(), meta: { error: String(e) } }])
    }
  }

  const stop = () => {
    if (activeMission) window.goga.invoke('mission:stop', activeMission.id).catch(() => {})
  }

  const isRunning = loading && activeMission &&
    !['completed','failed','cancelled'].includes(activeMission.status)

  return (
    <div style={S.page}>
      <div style={S.header}>
        <span style={S.title}>⚡ Mission Engine</span>
        <span style={S.sub}>Autonomous multi-step task execution</span>
      </div>

      {/* Goal input */}
      <div style={S.inputRow}>
        <input
          style={S.input}
          value={goal}
          onChange={e => setGoal(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && start()}
          placeholder="Describe a goal… e.g. Open GitHub and star the top trending repo"
          disabled={!!isRunning}
        />
        {isRunning
          ? <button onClick={stop} style={{ ...S.btn, background: '#cc2244' }}>⏹ Stop</button>
          : <button onClick={start} disabled={!goal.trim()} style={S.btn}>▶ Start</button>
        }
      </div>

      {/* Active mission */}
      {activeMission && (
        <div style={S.missionCard}>
          <div style={S.missionHeader}>
            <span style={{ color: MISSION_STATUS_COLOR[activeMission.status] ?? '#8b5cff', fontWeight: 600, fontSize: 11 }}>
              {activeMission.status.toUpperCase()}
            </span>
            <span style={S.missionGoal}>{activeMission.userGoal.slice(0, 120)}</span>
            <span style={S.stepCount}>{activeMission.steps.length} steps</span>
          </div>

          {/* Steps */}
          {activeMission.steps.length > 0 && (
            <div style={S.stepList}>
              {activeMission.steps.map((step: MissionStep) => (
                <div key={step.id} style={S.stepRow}>
                  <span style={{ color: STATUS_COLOR[step.status] ?? '#443355', width: 14, flexShrink: 0, fontWeight: 700 }}>
                    {STATUS_ICON[step.status] ?? '○'}
                  </span>
                  <span style={S.stepTool}>{step.tool}</span>
                  <span style={S.stepThought}>{step.goal.slice(0, 100)}</span>
                  {step.error && <span style={S.stepError}>{step.error.slice(0, 60)}</span>}
                </div>
              ))}
              {isRunning && (
                <div style={{ ...S.stepRow, color: '#443355', fontStyle: 'italic' }}>
                  <span style={{ width: 14 }}>⋯</span><span style={{ fontSize: 10 }}>planning next step…</span>
                </div>
              )}
            </div>
          )}

          {/* Final result */}
          {activeMission.finalResult && (
            <div style={S.result}>{activeMission.finalResult}</div>
          )}
          {activeMission.error && (
            <div style={{ ...S.result, color: '#ff4466', borderColor: '#ff446633' }}>{activeMission.error}</div>
          )}
        </div>
      )}

      {/* Event log */}
      {events.length > 0 && (
        <div style={S.eventLog}>
          <div style={S.eventLogHeader}>Event log</div>
          <div style={S.eventList}>
            {events.map((e, i) => (
              <div key={i} style={S.eventRow}>
                <span style={S.eventTime}>{new Date(e.timestamp).toLocaleTimeString()}</span>
                <span style={{ color: e.type.includes('fail') || e.type.includes('cancel') ? '#ff4466' : e.type.includes('succeed') || e.type.includes('complet') ? '#00ffcc' : '#8b5cff' }}>
                  {e.type}
                </span>
                {e.meta && Object.keys(e.meta).length > 0 && (
                  <span style={S.eventMeta}>{JSON.stringify(e.meta).slice(0, 80)}</span>
                )}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <div style={S.history}>
          <div style={S.eventLogHeader}>Recent missions</div>
          {history.map(m => (
            <div key={m.id} style={S.historyRow} onClick={() => setActiveMission(m)}>
              <span style={{ color: MISSION_STATUS_COLOR[m.status] ?? '#443355', width: 70, flexShrink: 0, fontSize: 10 }}>
                {m.status}
              </span>
              <span style={S.historyGoal}>{m.userGoal.slice(0, 100)}</span>
              <span style={S.historySteps}>{m.steps.length}s</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  page:           { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', background: '#06050e', padding: '20px 24px', gap: 14 },
  header:         { flexShrink: 0 },
  title:          { fontSize: 18, fontWeight: 700, color: '#b794ff', display: 'block' },
  sub:            { fontSize: 11, color: '#443355', display: 'block', marginTop: 2 },
  inputRow:       { display: 'flex', gap: 8, flexShrink: 0 },
  input:          { flex: 1, background: '#0e0c18', border: '1px solid #2a1f4a', color: '#e8d8ff', padding: '8px 12px', borderRadius: 6, fontSize: 13 },
  btn:            { background: '#5b21ff', color: '#fff', fontWeight: 600, padding: '8px 18px', borderRadius: 6, flexShrink: 0, cursor: 'pointer', border: 'none' },
  missionCard:    { background: '#0a0816', border: '1px solid #1e1a30', borderRadius: 8, padding: '12px 16px', flexShrink: 0 },
  missionHeader:  { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 },
  missionGoal:    { flex: 1, color: '#c8b8f0', fontSize: 12 },
  stepCount:      { color: '#443355', fontSize: 10, flexShrink: 0 },
  stepList:       { display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 200, overflowY: 'auto' },
  stepRow:        { display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11 },
  stepTool:       { color: '#8b5cff', width: 160, flexShrink: 0, fontSize: 10 },
  stepThought:    { color: '#554477', flex: 1 },
  stepError:      { color: '#ff4466', fontSize: 10, flexShrink: 0 },
  result:         { marginTop: 10, padding: '8px 10px', background: '#0d0b1a', borderRadius: 6, border: '1px solid #1e1a3088', color: '#00ffcc', fontSize: 12, whiteSpace: 'pre-wrap' },
  eventLog:       { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: '#0a0816', border: '1px solid #1e1a30', borderRadius: 8, overflow: 'hidden' },
  eventLogHeader: { padding: '6px 14px', fontSize: 10, color: '#443355', borderBottom: '1px solid #1e1a30', flexShrink: 0, textTransform: 'uppercase', letterSpacing: 1 },
  eventList:      { flex: 1, overflowY: 'auto', padding: '6px 14px', display: 'flex', flexDirection: 'column', gap: 3 },
  eventRow:       { display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 11 },
  eventTime:      { color: '#2a1f4a', fontSize: 10, flexShrink: 0, width: 70 },
  eventMeta:      { color: '#3d2d55', fontSize: 10 },
  history:        { flexShrink: 0, background: '#0a0816', border: '1px solid #1e1a30', borderRadius: 8, overflow: 'hidden' },
  historyRow:     { display: 'flex', gap: 10, alignItems: 'center', padding: '5px 14px', cursor: 'pointer', borderBottom: '1px solid #0f0d1a', fontSize: 11 },
  historyGoal:    { flex: 1, color: '#554477' },
  historySteps:   { color: '#2a1f4a', fontSize: 10, flexShrink: 0 },
}
