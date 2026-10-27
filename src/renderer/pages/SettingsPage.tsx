import React, { useEffect, useRef, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { DEFAULT_SETTINGS, MAX_PERSONALITY_CHARS } from '@shared/types'
import type { DownloadProgress } from '../../main/services/modelManager'

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [voices, setVoices] = useState<string[]>([])
  const [saved, setSaved] = useState(false)
  const [ollamaOk, setOllamaOk] = useState<boolean | null>(null)
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [brainModels, setBrainModels] = useState<string[]>([])
  const [brainStatus, setBrainStatus] = useState<Awaited<ReturnType<typeof window.goga.invoke<'localModel:status'>>> | null>(null)

  // Kokoro install state
  type KokoroPhase = 'idle' | 'preflight' | 'confirming' | 'downloading' | 'done' | 'error'
  const [kokoroInstalled, setKokoroInstalled] = useState(false)
  const [kokoroPhase, setKokoroPhase] = useState<KokoroPhase>('idle')
  const [preflight, setPreflight] = useState<Awaited<ReturnType<typeof window.goga.invoke<'model:kokoro-preflight'>>> | null>(null)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const unsubRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    window.goga.invoke('settings:get').then(setSettings)
    window.goga.invoke('tts:voices').then(setVoices)
    checkOllama()
    window.goga.invoke('model:kokoro-status').then(s => setKokoroInstalled(s.installed))
    window.goga.invoke('localModel:list').then(setBrainModels).catch(() => {})
    checkBrain()
    // Cleanup: remove progress listener if Settings unmounts mid-download
    return () => { unsubRef.current?.() }
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

  const checkBrain = async () => {
    try { setBrainStatus(await window.goga.invoke('localModel:status')) } catch { /* older backend */ }
  }

  const [ttsReloadError, setTtsReloadError] = useState<string | null>(null)

  const update = (patch: Partial<AppSettings>) => setSettings(s => ({ ...s, ...patch }))

  // Only embedding models belong in the memory picker; a chat model there would load a second
  // LLM onto the GPU. The saved name may omit Ollama's ':latest' tag, so list it under that name.
  const embeddingModels = ollamaModels
    .filter(m => m.includes('embed'))
    .map(m => sameModel(m, settings.embeddingModelName) ? settings.embeddingModelName : m)

  const updateTtsProvider = async (provider: AppSettings['ttsProvider']) => {
    update({ ttsProvider: provider })
    setTtsReloadError(null)
    // Save immediately so the main process reloads the provider.
    const updated = { ...settings, ttsProvider: provider }
    await window.goga.invoke('settings:set', updated)
    const err = await window.goga.invoke('voice:reload-tts')
    if (err) setTtsReloadError(err)
  }

  const save = async () => {
    await window.goga.invoke('settings:set', settings)
    // A changed brain model reloads in the background; refresh its status shortly after.
    setTimeout(checkBrain, 500)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const runPreflight = async () => {
    setKokoroPhase('preflight')
    try {
      const info = await window.goga.invoke('model:kokoro-preflight')
      setPreflight(info)
      setKokoroPhase('confirming')
    } catch (e) {
      setProgress({ phase: 'error', message: String(e) })
      setKokoroPhase('error')
    }
  }

  const startDownload = async () => {
    setKokoroPhase('downloading')
    // Subscribe to progress events; store unsub so we can clean up.
    unsubRef.current = window.goga.on('model:kokoro-progress', (p) => {
      setProgress(p)
      if (p.phase === 'done') {
        setKokoroInstalled(true)
        setKokoroPhase('done')
        unsubRef.current?.()
      }
      if (p.phase === 'error') {
        setKokoroPhase('error')
        unsubRef.current?.()
      }
    })
    try {
      await window.goga.invoke('model:kokoro-download')
    } catch (e) {
      setProgress({ phase: 'error', message: String(e) })
      setKokoroPhase('error')
      unsubRef.current?.()
    }
  }

  const resetKokoro = () => {
    unsubRef.current?.()
    setKokoroPhase('idle')
    setPreflight(null)
    setProgress(null)
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
        <Field label="Personality (how Goga should be)">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <textarea
              value={settings.personality ?? ''}
              onChange={e => update({ personality: e.target.value.slice(0, MAX_PERSONALITY_CHARS) })}
              rows={4}
              style={styles.textarea}
              placeholder="e.g. Be playful and joke a little. Speak to me in Russian when I write in Russian. Remind me to take breaks."
            />
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Used in chat, voice, Telegram and tasks. Honesty and safety limits always come first. {(settings.personality ?? '').length}/{MAX_PERSONALITY_CHARS}
            </span>
          </div>
        </Field>

        <Section label="AI Model" />
        <Field label="Primary model">
          <select value={settings.primaryModel ?? 'local'} onChange={e => update({ primaryModel: e.target.value as AppSettings['primaryModel'] })} style={styles.select}>
            <option value="local">Local (node-llama-cpp)</option>
            <option value="ollama">Ollama</option>
          </select>
        </Field>
        <Field label="Brain model (local)">
          {brainModels.length > 0
            ? <select value={settings.localModelPath} onChange={e => update({ localModelPath: e.target.value })} style={styles.select}>
                {!brainModels.includes(settings.localModelPath) && <option value={settings.localModelPath}>{fileName(settings.localModelPath)}</option>}
                {brainModels.map(m => <option key={m} value={m}>{fileName(m)}</option>)}
              </select>
            : <input value={settings.localModelPath} onChange={e => update({ localModelPath: e.target.value })} style={{ width: 380 }} />}
        </Field>
        <Field label="Brain memory window">
          <select value={settings.localModelContextSize} onChange={e => update({ localModelContextSize: Number(e.target.value) })} style={styles.select}>
            <option value={4096}>4K tokens (fastest)</option>
            <option value={8192}>8K tokens (recommended)</option>
            <option value={16384}>16K tokens (needs more VRAM)</option>
          </select>
        </Field>
        <Field label="Brain status">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: brainStatus?.status === 'ready' ? 'var(--success)' : brainStatus?.status === 'error' ? 'var(--danger)' : 'var(--text-muted)' }}>
              {brainStatus === null ? 'Checking…'
                : brainStatus.status === 'ready' ? `Ready — ${fileName(brainStatus.modelPath)}`
                : brainStatus.status === 'error' ? `Error — ${brainStatus.error ?? 'failed to load'}`
                : brainStatus.status === 'loading' ? `Loading ${fileName(brainStatus.modelPath)}…`
                : 'Not loaded'}
            </span>
            <button onClick={checkBrain} style={styles.smallBtn}>Recheck</button>
          </div>
        </Field>
        <Field label="Vision model (Ollama)">
          {ollamaModels.length > 0
            ? <select value={settings.visionModelName} onChange={e => update({ visionModelName: e.target.value })} style={styles.select}>
                {!ollamaModels.some(m => sameModel(m, settings.visionModelName)) && <option value={settings.visionModelName}>{settings.visionModelName} (not installed)</option>}
                {/* Vision-capable models only (Qwen-VL, LLaVA, …); the saved name may omit ':latest'. */}
                {ollamaModels.filter(m => /vl|llava|vision/i.test(m))
                  .map(m => sameModel(m, settings.visionModelName) ? settings.visionModelName : m)
                  .map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            : <input value={settings.visionModelName} onChange={e => update({ visionModelName: e.target.value })} style={{ width: 200 }} placeholder="qwen3-vl:4b" />}
        </Field>
        <Field label="Memory model (Ollama)">
          {ollamaModels.length > 0
            ? <select value={settings.embeddingModelName} onChange={e => update({ embeddingModelName: e.target.value })} style={styles.select}>
                <option value="">Off — keyword match only</option>
                {settings.embeddingModelName && !embeddingModels.includes(settings.embeddingModelName) && (
                  <option value={settings.embeddingModelName}>
                    {settings.embeddingModelName} {ollamaModels.some(m => sameModel(m, settings.embeddingModelName)) ? '(not a memory model)' : '(not installed)'}
                  </option>
                )}
                {embeddingModels.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            : <input value={settings.embeddingModelName} onChange={e => update({ embeddingModelName: e.target.value })} style={{ width: 200 }} placeholder="nomic-embed-text" />}
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
                {/* Without this a missing model shows as the first listed one, misreporting what is saved. */}
                {!ollamaModels.includes(settings.modelName) && <option value={settings.modelName}>{settings.modelName} (not installed)</option>}
                {/* Embedding models cannot chat. */}
                {ollamaModels.filter(m => !m.includes('embed')).map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            : <input value={settings.modelName} onChange={e => update({ modelName: e.target.value })} style={{ width: 200 }} placeholder="llama3" />}
        </Field>

        <Section label="Voice & Speech" />
        <Field label="TTS provider">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <select
              value={settings.ttsProvider ?? 'sapi'}
              onChange={e => updateTtsProvider(e.target.value as AppSettings['ttsProvider'])}
              style={styles.select}
            >
              <option value="sapi">Windows SAPI (built-in, offline)</option>
              <option value="kokoro">Kokoro (local neural TTS){kokoroInstalled ? ' ✓' : ' — not installed'}</option>
              <option value="elevenlabs">ElevenLabs (cloud)</option>
            </select>
            {ttsReloadError && (
              <span style={{ fontSize: 11, color: 'var(--danger)' }}>Provider error: {ttsReloadError}</span>
            )}
          </div>
        </Field>

        {/* ── Kokoro install section ─────────────────────────────────── */}
        {(settings.ttsProvider ?? 'sapi') === 'kokoro' && (
          <div style={styles.kokoroBox}>
            {kokoroInstalled && kokoroPhase === 'idle' && (
              <span style={{ color: 'var(--success)' }}>✓ Kokoro model installed and verified.</span>
            )}

            {!kokoroInstalled && kokoroPhase === 'idle' && (
              <>
                <span style={{ color: 'var(--text-muted)' }}>Kokoro model not installed.</span>
                <button onClick={runPreflight} style={{ ...styles.smallBtn, marginLeft: 12 }}>Show download info…</button>
              </>
            )}

            {kokoroPhase === 'preflight' && (
              <span style={{ color: 'var(--text-muted)' }}>Loading manifest…</span>
            )}

            {kokoroPhase === 'confirming' && preflight && (
              <div style={{ width: '100%' }}>
                <div style={styles.preflightGrid}>
                  <Row label="Source commit" value={preflight.commit} mono />
                  <Row label="Manifest" value={`v${preflight.manifestVersion}`} />
                  <Row label="Total size" value={preflight.totalSize} />
                  <Row label="Destination" value={preflight.destination} mono />
                </div>
                <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>Artifacts:</div>
                <table style={styles.artifactTable}>
                  <thead>
                    <tr>
                      <th style={styles.th}>File</th>
                      <th style={styles.th}>Size</th>
                      <th style={styles.th}>SHA-256</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preflight.artifacts.map(a => (
                      <tr key={a.filename}>
                        <td style={styles.td}><code style={styles.mono}>{a.filename}</code></td>
                        <td style={styles.td}>{a.sizeMB} MB</td>
                        <td style={styles.td}><code style={{ ...styles.mono, fontSize: 10 }}>{a.sha256}</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                  <button onClick={startDownload} style={styles.confirmBtn}>Confirm — Download {preflight.totalSize}</button>
                  <button onClick={resetKokoro} style={styles.smallBtn}>Cancel</button>
                </div>
              </div>
            )}

            {kokoroPhase === 'downloading' && progress && (
              <div style={{ width: '100%' }}>
                <div style={{ marginBottom: 6, fontSize: 12 }}>{progress.message}</div>
                {progress.percent !== undefined && (
                  <div style={styles.progressTrack}>
                    <div style={{ ...styles.progressBar, width: `${progress.percent}%` }} />
                  </div>
                )}
              </div>
            )}

            {kokoroPhase === 'done' && (
              <span style={{ color: 'var(--success)' }}>✓ Kokoro installed and verified. Save settings to activate.</span>
            )}

            {kokoroPhase === 'error' && (
              <div style={{ width: '100%' }}>
                <span style={{ color: 'var(--danger)' }}>{progress?.message ?? 'Unknown error'}</span>
                <button onClick={resetKokoro} style={{ ...styles.smallBtn, marginLeft: 12 }}>Retry</button>
              </div>
            )}
          </div>
        )}

        <Field label="STT provider">
          <select value={settings.sttProvider ?? 'windows'} onChange={e => update({ sttProvider: e.target.value as AppSettings['sttProvider'] })} style={styles.select} disabled={!settings.voiceEnabled}>
            <option value="windows">Windows Speech (offline, fast)</option>
            <option value="whisper">Whisper (accurate, local)</option>
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
              <select value={settings.whisperDevice ?? 'cpu'} onChange={e => update({ whisperDevice: e.target.value as AppSettings['whisperDevice'] })} style={styles.select} disabled={!settings.voiceEnabled}>
                <option value="cpu">CPU (works everywhere)</option>
                <option value="cuda">CUDA (RTX GPU — requires CUDA toolkit)</option>
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

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '3px 0', fontSize: 12 }}>
      <span style={{ width: 120, color: 'var(--text-muted)', flexShrink: 0 }}>{label}</span>
      <span style={mono ? { fontFamily: 'monospace', wordBreak: 'break-all' } : {}}>{value}</span>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' },
  toolbar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 24px', borderBottom: '1px solid var(--border)' },
  form: { padding: '8px 24px', overflowY: 'auto', flex: 1 },
  saveBtn: { background: 'var(--accent)', color: '#fff', fontWeight: 600 },
  textarea: { background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '6px 10px', width: 420, resize: 'vertical', fontFamily: 'inherit' },
  select: { background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '6px 10px', minWidth: 200 },
  smallBtn: { background: 'var(--surface2)', color: 'var(--text)', padding: '5px 10px' },
  ollamaGuide: { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '12px 16px', margin: '8px 0', fontSize: 13, lineHeight: 1.6 },
  code: { background: 'var(--surface)', padding: '2px 6px', borderRadius: 4, fontFamily: 'monospace', fontSize: 12 },
  kokoroBox: { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '14px 16px', margin: '6px 0 10px', display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 },
  preflightGrid: { display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 4 },
  artifactTable: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: { textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontWeight: 600 },
  td: { padding: '4px 8px', borderBottom: '1px solid var(--border)', verticalAlign: 'top' },
  mono: { fontFamily: 'monospace' },
  confirmBtn: { background: 'var(--accent)', color: '#fff', fontWeight: 600, padding: '6px 14px' },
  progressTrack: { height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden', width: '100%' },
  progressBar: { height: '100%', background: 'var(--accent)', transition: 'width 0.3s ease' },
}

function fileName(p: string) {
  return p.split(/[\\/]/).pop() ?? p
}

function sameModel(a: string, b: string) {
  const base = (m: string) => m.replace(/:latest$/, '')
  return base(a) === base(b)
}
