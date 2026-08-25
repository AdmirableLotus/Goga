import React from 'react'
import type { Action } from '@shared/types'

interface Props {
  action: Action
  onApprove: (id: string) => void
  onDeny: (id: string) => void
}

const RISK_LABEL: Record<Action['riskLevel'], string> = {
  low:      'Low risk',
  medium:   'Medium risk',
  high:     'High risk',
  critical: 'Critical risk',
}

const RISK_COLOR: Record<Action['riskLevel'], string> = {
  low:      '#00ffcc',
  medium:   '#ffaa22',
  high:     '#ff4466',
  critical: '#ff2244',
}

/**
 * Focused single-action approval card.
 * Used by ApprovalsPage (full list) and MissionMode (inline, one at a time).
 * Preserves the exact approve/reject behavior from ApprovalsPage.
 */
export default function ApprovalCard({ action, onApprove, onDeny }: Props) {
  const riskColor = RISK_COLOR[action.riskLevel] ?? '#ffaa22'

  return (
    <div style={S.card}>
      <div style={S.header}>
        <span style={S.amber}>⏳ Approval required</span>
        <span style={{ color: riskColor, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 }}>
          {RISK_LABEL[action.riskLevel]}
        </span>
      </div>

      <div style={S.label}>{action.label}</div>

      {action.params.target != null && (
        <div style={S.meta}>
          <span style={S.metaKey}>Target</span>
          <span style={S.metaVal}>{String(action.params.target)}</span>
        </div>
      )}
      {action.params.executable != null && (
        <div style={S.meta}>
          <span style={S.metaKey}>App</span>
          <span style={S.metaVal}>{String(action.params.executable)}</span>
        </div>
      )}
      {action.params.url != null && (
        <div style={S.meta}>
          <span style={S.metaKey}>URL</span>
          <span style={S.metaVal}>{String(action.params.url).slice(0, 80)}</span>
        </div>
      )}

      <div style={S.reason}>
        This action requires your explicit approval before Goga proceeds.
      </div>

      <div style={S.btns}>
        <button onClick={() => onApprove(action.id)} style={S.approveBtn}>Approve</button>
        <button onClick={() => onDeny(action.id)}    style={S.denyBtn}>Deny</button>
      </div>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  card: {
    background: 'rgba(20,14,36,0.95)',
    border: '1px solid #ffaa2244',
    borderRadius: 10,
    padding: '14px 18px',
    display: 'flex', flexDirection: 'column', gap: 8,
    backdropFilter: 'blur(12px)',
  },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  },
  amber:   { color: '#ffaa22', fontSize: 12, fontWeight: 700 },
  label:   { color: '#e8d8ff', fontSize: 14, fontWeight: 600, lineHeight: 1.4 },
  meta:    { display: 'flex', gap: 8, alignItems: 'baseline' },
  metaKey: { color: '#554477', fontSize: 11, width: 48, flexShrink: 0 },
  metaVal: { color: '#b794ff', fontSize: 12, wordBreak: 'break-all' },
  reason:  { color: '#443355', fontSize: 11, lineHeight: 1.5 },
  btns:    { display: 'flex', gap: 8, marginTop: 4 },
  approveBtn: {
    flex: 1, background: '#00cc88', color: '#000', fontWeight: 700,
    padding: '8px 0', borderRadius: 6, fontSize: 13,
  },
  denyBtn: {
    flex: 1, background: '#1a0a2e', color: '#ff4466', fontWeight: 700,
    padding: '8px 0', borderRadius: 6, fontSize: 13,
    border: '1px solid #ff446633',
  },
}
