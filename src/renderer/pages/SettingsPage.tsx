import React, { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [voices, setVoices] = useState<string[]>([])
  const [saved, setSaved] = useState(false)
  const [ollamaOk, setOllamaOk] = useState<boolean | null>(null)
  const [ollamaModels, setOllamaModels] = useState<string[]>([])

  useEffect(() => {
    window.goga.invoke('settings:get').then(setSettings)
    window.goga.invoke('tts:voices').then(setVoices)
    checkOllama()
  }, [])

  const checkOllama = async () => {
    setOllamaOk(null)
    const ok = await window.goga.invoke('ollama:status')
    setOllamaOk(ok)
    if (ok) {
      try {
        const models = await window.goga.invoke('ollama:models')
        setOllamaModels(models)
      } catch { /* older backend without ollama:models */ }
    }
  }

  const update = (patch: Partial<AppSettings>) => setSettings(s => ({ ...s, ...patch }))

  const save = async () => {
    await window.goga.invoke('settings:set', settings)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <span style={{ fontWeight: 600 }}>Settings</span>
        <button onClick={save} style={styles.saveBtn}>{saved ? '✓ Saved' : 'Save'}</button>
      </div>
      <div style={styles.form}>

        <Section label="Identity" />
        <Field label="Your name (Goga calls you this)">
          <input value={settings.userName} onChange={e => update({ userName: e.target.value })} style={{ width: 200 }} placeholder="Boss" />
        </Field>

        <Section label="AI Model" />
        <Field label="Primary model">
          <select value={settings.primaryModel ?? 'local'} onChange={e => update({ primaryModel: e.target.value as AppSettings['primaryModel'] })} style={styles.select}>
            <option value="local">Local (node-llama-cpp)</option>
            <option value="ollama">Ollama</option>
          </select>
        </Field>
        <Field label="Ollama status">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
              background: ollamaOk === null ? 'var(--text-muted)' : ollamaOk ? 'var(--success)' : 'var(--danger)'
            }} />
            <span style={{ color: ollamaOk === null ? 'var(--text-muted)' : ollamaOk ? 'var(--success)' : 'var(--danger)' }}>
              {ollamaOk === null ? 'Checking…' : ollamaOk ? 'Connected — Goga is fully alive' : 'Not running — download from ollama.ai'}
            </span>
            <button onClick={checkOllama} style={styles.smallBtn}>Recheck</button>
          </div>
        </Field>
        {!ollamaOk && ollamaOk !== null && (
          <div style={styles.ollamaGuide}>
            <strong>To activate Goga's full brain:</strong>
            <ol style={{ margin: '8px 0 0 16px', lineHeight: 2 }}>
              <li>Download Ollama from <strong>ollama.ai</strong></li>
              <li>Install and open it</li>
              <li>Open a terminal and run: <code style={styles.code}>ollama pull llama3</code></li>
              <li>Come back and click Recheck — Goga will be fully alive</li>
            </ol>
          </div>
        )}
        <Field label="Model Endpoint">
          <input value={settings.modelEndpoint} onChange={e => update({ modelEndpoint: e.target.value })} style={{ width: 280 }} />
        </Field>
        <Field label="Model Name">
          {ollamaModels.length > 0
            ? <select value={settings.modelName} onChange={e => update({ modelName: e.target.value })} style={styles.select}>
                {ollamaModels.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            : <input value={settings.modelName} onChange={e => update({ modelName: e.target.value })} style={{ width: 200 }} placeholder="llama3" />}
        </Field>

        <Section label="Voice & Speech" />
        <Field label="STT provider">
          <select value={settings.sttProvider ?? 'windows'} onChange={e => update({ sttProvider: e.target.value as AppSettings['sttProvider'] })} style={styles.select} disabled={!settings.voiceEnabled}>
            <option value="windows">Windows Speech (offline, fast)</option>
            <option value="whisper">Whisper (accurate, GPU)</option>
          </select>
        </Field>
        {(settings.sttProvider ?? 'windows') === 'whisper' && (
          <>
            <Field label="Whisper model">
              <select value={settings.whisperModel ?? 'base'} onChange={e => update({ whisperModel: e.target.value as AppSettings['whisperModel'] })} style={styles.select} disabled={!settings.voiceEnabled}>
                <option value="tiny">tiny (fastest, lowest accuracy)</option>
                <option value="base">base (recommended)</option>
                <option value="small">small (better accuracy)</option>
                <option value="medium">medium (high accuracy)</option>
                <option value="large-v2">large-v2 (best accuracy)</option>
                <option value="large-v3">large-v3 (best accuracy, newest)</option>
              </select>
            </Field>
            <Field label="Whisper device">
              <select value={settings.whisperDevice ?? 'cuda'} onChange={e => update({ whisperDevice: e.target.value as AppSettings['whisperDevice'] })} style={styles.select} disabled={!settings.voiceEnabled}>
                <option value="cuda">CUDA (RTX GPU — recommended)</option>
                <option value="cpu">CPU (slower)</option>
                <option value="auto">Auto</option>
              </select>
            </Field>
            <Field label="Language (blank = auto-detect)">
              <input value={settings.whisperLanguage ?? ''} onChange={e => update({ whisperLanguage: e.target.value })} style={{ width: 120 }} placeholder="en, fr, de…" disabled={!settings.voiceEnabled} />
            </Field>
          </>
        )}
        <Field label="Voice conversation">
          <input type="checkbox" checked={settings.voiceEnabled} onChange={e => update({ voiceEnabled: e.target.checked })} />
        </Field>
        <Field label="Wake word (Hey Goga)">
          <input type="checkbox" checked={settings.wakeWordEnabled ?? false} onChange={e => update({ wakeWordEnabled: e.target.checked })} disabled={!settings.voiceEnabled} />
        </Field>
        <Field label="Wake phrase">
          <input value={settings.wakePhrase ?? 'hey goga'} onChange={e => update({ wakePhrase: e.target.value })} style={{ width: 180 }} disabled={!settings.voiceEnabled || !settings.wakeWordEnabled} />
        </Field>
        <Field label="Automatically speak responses">
          <input type="checkbox" checked={settings.autoSpeakResponses ?? true} onChange={e => update({ autoSpeakResponses: e.target.checked })} disabled={!settings.voiceEnabled} />
        </Field>
        <Field label="Allow barge-in (interrupt Goga while speaking)">
          <input type="checkbox" checked={settings.allowBargeIn ?? true} onChange={e => update({ allowBargeIn: e.target.checked })} disabled={!settings.voiceEnabled} />
        </Field>
        <Field label={`Conversation window (${settings.conversationWindowSecs ?? 45}s after last interaction)`}>
          <input type="range" min="10" max="120" step="5" value={settings.conversationWindowSecs ?? 45} onChange={e => update({ conversationWindowSecs: Number(e.target.value) })} disabled={!settings.voiceEnabled || !settings.wakeWordEnabled} style={{ width: 180 }} />
        </Field>
        <Field label="Goga voice">
          <select value={settings.voiceName} onChange={e => update({ voiceName: e.target.value })} style={styles.select} disabled={!settings.voiceEnabled}>
            <option value="">System default</option>
            {voices.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
          <button onClick={() => window.goga.invoke('tts:speak', 'Hey, I am Goga. Good to meet you.')} disabled={!settings.voiceEnabled} style={{ ...styles.smallBtn, marginLeft: 8 }}>Test</button>
        </Field>
        <Field label={`Speech rate (${settings.voiceRate.toFixed(1)}x)`}>
          <input type="range" min="0.5" max="2" step="0.1" value={settings.voiceRate} onChange={e => update({ voiceRate: parseFloat(e.target.value) })} disabled={!settings.voiceEnabled} style={{ width: 180 }} />
        </Field>
        <Field label={`Volume (${Math.round(settings.voiceVolume * 100)}%)`}>
          <input type="range" min="0" max="1" step="0.05" value={settings.voiceVolume} onChange={e => update({ voiceVolume: parseFloat(e.target.value) })} disabled={!settings.voiceEnabled} style={{ width: 180 }} />
        </Field>

        <Section label="General" />
        <Field label="Log Retention (days)">
          <input type="number" value={settings.logRetentionDays} onChange={e => update({ logRetentionDays: Number(e.target.value) })} style={{ width: 80 }} />
        </Field>
        <Field label="Require Approval for All Actions">
          <input type="checkbox" checked={settings.requireApprovalForAll} onChange={e => update({ requireApprovalForAll: e.target.checked })} />
        </Field>
        <Field label="Auto-approve actions below risk level">
          <select
            value={settings.autoApproveBelow}
            onChange={e => update({ autoApproveBelow: e.target.value as AppSettings['autoApproveBelow'] })}
            style={styles.select}
            disabled={settings.requireApprovalForAll}
          >
            <option value="low">Low only</option>
            <option value="medium">Low + Medium</option>
            <option value="high">Low + Medium + High</option>
            <option value="critical">Everything (not recommended)</option>
          </select>
        </Field>
        <Field label="Agent max steps per task">
          <input type="number" min={1} max={50} value={settings.agentMaxSteps} onChange={e => update({ agentMaxSteps: Number(e.target.value) })} style={{ width: 80 }} />
        </Field>
        <Field label="Vision model (Ollama)">
          <input value={settings.visionModelName} onChange={e => update({ visionModelName: e.target.value })} style={{ width: 200 }} placeholder="llava:13b" />
        </Field>
      </div>
    </div>
  )
}

function Section({ label }: { label: string }) {
  return <div style={{ paddingTop: 20, paddingBottom: 6, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--accent)', fontWeight: 700 }}>{label}</div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ width: 260, color: 'var(--text-muted)', flexShrink: 0 }}>{label}</span>
      {children}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' },
  toolbar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 24px', borderBottom: '1px solid var(--border)' },
  form: { padding: '8px 24px', overflowY: 'auto', flex: 1 },
  saveBtn: { background: 'var(--accent)', color: '#fff', fontWeight: 600 },
  select: { background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '6px 10px', minWidth: 200 },
  smallBtn: { background: 'var(--surface2)', color: 'var(--text)', padding: '5px 10px' },
  ollamaGuide: { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '12px 16px', margin: '8px 0', fontSize: 13, lineHeight: 1.6 },
  code: { background: 'var(--surface)', padding: '2px 6px', borderRadius: 4, fontFamily: 'monospace', fontSize: 12 }
}
