import React, { useEffect, useState } from 'react'
import type { LogEntry } from '@shared/types'

const LEVEL_COLOR: Record<LogEntry['level'], string> = {
  info: 'var(--text-muted)',
  warn: 'var(--warn)',
  error: 'var(--danger)'
}

export default function ActivityPage() {
  const [logs, setLogs] = useState<LogEntry[]>([])

  const load = async () => setLogs(await window.goga.invoke('logs:list'))

  useEffect(() => { load() }, [])

  const clear = async () => { await window.goga.invoke('logs:clear'); setLogs([]) }

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
  row: { display: 'flex', gap: 12, padding: '7px 24px', borderBottom: '1px solid var(--border)', fontSize: 13 }
}
