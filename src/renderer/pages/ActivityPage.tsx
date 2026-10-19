import React, { useEffect, useState } from 'react'
import type { AgentState, AgentStep, LogEntry } from '@shared/types'

const LEVEL_COLOR: Record<LogEntry['level'], string> = {
  info: 'var(--text-muted)',
  warn: 'var(--warn)',
  error: 'var(--danger)'
}

const AGENT_STATUS: Record<AgentState['status'], string> = {
  idle: 'Idle', running: 'Running', 'waiting-approval': 'Waiting for approval',
  done: 'Completed', stopped: 'Stopped', error: 'Failed',
}

function stepStatus(step: AgentStep): string {
  if (step.result.success) return 'Succeeded'
  return step.result.error === 'cancelled' || step.result.error === 'cancelled before save dispatch'
    ? 'Stopped' : 'Failed'
}

function returnedPath(step: AgentStep): string | undefined {
  const data = step.result.data
  if (!data || typeof data !== 'object' || !('filePath' in data)) return
  return typeof data.filePath === 'string' ? data.filePath : undefined
}

export default function ActivityPage() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [agent, setAgent] = useState<AgentState | null>(null)
  const [agentLoadError, setAgentLoadError] = useState<string | null>(null)

  const load = async () => setLogs(await window.goga.invoke('logs:list'))

  useEffect(() => { load() }, [])

  useEffect(() => {
    let active = true
    let receivedUpdate = false
    const unsubscribe = window.goga.on('agent:state', state => {
      receivedUpdate = true
      setAgent(state)
      setAgentLoadError(null)
    })
    // State includes completed steps, so opening the tab after a task finishes
    // still shows its outcome. A late snapshot must not replace a newer event.
    window.goga.invoke('agent:state').then(state => {
      if (active && !receivedUpdate) setAgent(state)
    }).catch(() => {
      if (active && !receivedUpdate) setAgentLoadError('Task activity could not be loaded.')
    })
    return () => { active = false; unsubscribe() }
  }, [])

  const clear = async () => { await window.goga.invoke('logs:clear'); setLogs([]) }
  const selectedTool = agent?.currentTool || agent?.steps[agent.steps.length - 1]?.tool

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <span style={{ fontWeight: 600 }}>Activity Log</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={styles.btn}>Refresh</button>
          <button onClick={clear} style={{ ...styles.btn, color: 'var(--danger)' }}>Clear</button>
        </div>
      </div>
      <div style={styles.list}>
        {agentLoadError && <p role="alert" style={styles.task}>{agentLoadError}</p>}
        {agent?.task && (
          <section aria-label="Current task" style={styles.task}>
            <div role="status" aria-live="polite" style={{ fontWeight: 600 }}>{AGENT_STATUS[agent.status]}</div>
            <p style={styles.detail}>{agent.task}</p>
            {selectedTool ? <p style={styles.detail}>{agent.status === 'waiting-approval' ? 'Last tool' : 'Selected tool'}: <code>{selectedTool}</code></p>
              : agent.status === 'running' && <p style={styles.detail}>Planning next action…</p>}
            {agent.error && <p style={styles.detail}>{agent.error}</p>}
            {agent.reply && <p aria-label="Task result" style={{ ...styles.detail, whiteSpace: 'pre-wrap' }}>{agent.reply}</p>}
            {agent.steps.length > 0 && (
              <ol aria-label="Tool results" style={{ margin: '12px 0 0', paddingLeft: 20 }}>
                {agent.steps.map(step => (
                  <li key={step.index} style={styles.step}>
                    <code>{step.tool}</code> — {stepStatus(step)}
                    {returnedPath(step) && <div style={styles.detail}>File: <code>{returnedPath(step)}</code></div>}
                    {step.result.error && <div style={styles.detail}>{step.result.error}</div>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
        {logs.length === 0 && <p style={{ color: 'var(--text-muted)', padding: 20 }}>No log entries yet.</p>}
        {logs.map(entry => (
          <div key={entry.id} style={styles.row}>
            <span style={{ color: LEVEL_COLOR[entry.level], width: 44, flexShrink: 0 }}>{entry.level.toUpperCase()}</span>
            <span style={{ color: 'var(--text-muted)', width: 80, flexShrink: 0, fontSize: 12 }}>
              {new Date(entry.timestamp).toLocaleTimeString()}
            </span>
            <span style={{ flex: 1 }}>{entry.message}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' },
  toolbar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 24px', borderBottom: '1px solid var(--border)' },
  btn: { background: 'var(--surface2)', color: 'var(--text)' },
  list: { flex: 1, overflowY: 'auto', padding: '8px 0' },
  task: { padding: '12px 24px', borderBottom: '1px solid var(--border)', fontSize: 13, overflowWrap: 'anywhere' },
  detail: { margin: '6px 0 0', whiteSpace: 'pre-wrap' },
  step: { padding: '6px 0' },
  row: { display: 'flex', gap: 12, padding: '7px 24px', borderBottom: '1px solid var(--border)', fontSize: 13 }
}
