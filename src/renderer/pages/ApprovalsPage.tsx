import React, { useEffect, useState } from 'react'
import type { Action } from '@shared/types'
import ApprovalCard from '../components/ApprovalCard'

export default function ApprovalsPage() {
  const [actions, setActions] = useState<Action[]>([])

  const load = async () => {
    const all = await window.goga.invoke('actions:list')
    setActions(all.filter(a => a.status === 'pending' && a.requiresApproval))
  }

  useEffect(() => { load() }, [])

  const approve = async (id: string) => { await window.goga.invoke('action:approve', id); load() }
  const reject  = async (id: string) => { await window.goga.invoke('action:reject',  id); load() }

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <span style={{ fontWeight: 600 }}>Pending Approvals</span>
        <button onClick={load} style={styles.btn}>Refresh</button>
      </div>
      <div style={styles.list}>
        {actions.length === 0 && <p style={{ color: 'var(--text-muted)', padding: 20 }}>No pending approvals.</p>}
        {actions.map(a => (
          <ApprovalCard key={a.id} action={a} onApprove={approve} onDeny={reject} />
        ))}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' },
  toolbar:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 24px', borderBottom: '1px solid var(--border)' },
  btn:       { background: 'var(--surface2)', color: 'var(--text)' },
  list:      { flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 },
}
