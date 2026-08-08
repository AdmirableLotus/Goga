import React, { useEffect, useState } from 'react'
import type { Action } from '@shared/types'

const RISK_COLOR: Record<Action['riskLevel'], string> = {
  low: 'var(--success)',
  medium: 'var(--warn)',
  high: 'var(--danger)'
}

export default function ApprovalsPage() {
  const [actions, setActions] = useState<Action[]>([])

  const load = async () => {
    const all = await window.goga.invoke('actions:list')
    setActions(all.filter(a => a.status === 'pending' && a.requiresApproval))
  }

  useEffect(() => { load() }, [])

  const approve = async (id: string) => { await window.goga.invoke('action:approve', id); load() }
  const reject = async (id: string) => { await window.goga.invoke('action:reject', id); load() }

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <span style={{ fontWeight: 600 }}>Pending Approvals</span>
        <button onClick={load} style={styles.btn}>Refresh</button>
      </div>
      <div style={styles.list}>
        {actions.length === 0 && <p style={{ color: 'var(--text-muted)', padding: 20 }}>No pending approvals.</p>}
        {actions.map(a => (
          <div key={a.id} style={styles.card}>
            <div style={styles.cardHeader}>
              <span style={{ fontWeight: 600 }}>{a.label}</span>
              <span style={{ color: RISK_COLOR[a.riskLevel], fontSize: 12, textTransform: 'uppercase' }}>
                {a.riskLevel} risk
              </span>
            </div>
            <pre style={styles.params}>{JSON.stringify(a.params, null, 2)}</pre>
            <div style={styles.actions}>
              <button onClick={() => approve(a.id)} style={styles.approveBtn}>Approve</button>
              <button onClick={() => reject(a.id)} style={styles.rejectBtn}>Reject</button>
            </div>
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
  list: { flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 },
  card: { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 16 },
  cardHeader: { display: 'flex', justifyContent: 'space-between', marginBottom: 8 },
  params: { background: 'var(--surface2)', borderRadius: 4, padding: '8px 10px', fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, overflow: 'auto' },
  actions: { display: 'flex', gap: 8 },
  approveBtn: { background: 'var(--success)', color: '#000', fontWeight: 600 },
  rejectBtn: { background: 'var(--surface2)', color: 'var(--danger)' }
}
