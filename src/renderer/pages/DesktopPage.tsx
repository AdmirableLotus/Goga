import React, { useState, useRef, useEffect, useCallback } from 'react'
import type { ActiveWindowResult } from '@shared/ipc'

interface WindowInfo { title: string; owner: string; pid: number; bounds?: { x: number; y: number; width: number; height: number } }
interface UIElement  { name: string; role: string; x: number; y: number; width: number; height: number; value?: string; enabled: boolean }

type Panel = 'windows' | 'elements' | 'none'

export default function DesktopPage() {
  const [screenshot, setScreenshot]     = useState<string | null>(null)
  const [activeWin, setActiveWin]       = useState<ActiveWindowResult | null>(null)
  const [windows, setWindows]           = useState<WindowInfo[]>([])
  const [elements, setElements]         = useState<UIElement[]>([])
  const [panel, setPanel]               = useState<Panel>('none')
  const [typeText, setTypeText]         = useState('')
  const [keyText, setKeyText]           = useState('')
  const [status, setStatus]             = useState('')
  const [busy, setBusy]                 = useState(false)
  const [clickMarker, setClickMarker]   = useState<{ x: number; y: number } | null>(null)
  const [autoRefresh, setAutoRefresh]   = useState(false)
  const imgRef   = useRef<HTMLImageElement>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const flash = (msg: string) => { setStatus(msg); setTimeout(() => setStatus(''), 3000) }

  const takeScreenshot = useCallback(async () => {
    setBusy(true)
    try {
      const r = await window.goga.invoke('desktop:screenshot')
      setScreenshot(r.base64)
      const aw = await window.goga.invoke('desktop:activeWindow')
      setActiveWin(aw)
    } catch (e) { flash(`Screenshot failed: ${e}`) }
    finally { setBusy(false) }
  }, [])

  // Initial screenshot on mount
  useEffect(() => { takeScreenshot() }, [takeScreenshot])

  // Auto-refresh
  useEffect(() => {
    if (autoRefresh) {
      timerRef.current = setInterval(takeScreenshot, 2000)
    } else {
      if (timerRef.current) clearInterval(timerRef.current)
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [autoRefresh, takeScreenshot])

  const loadWindows = async () => {
    setBusy(true)
    try {
      // windowList is not a direct IPC handler — use agent tool via chat or call desktop directly
      // We use the desktop:activeWindow + a workaround: invoke via agent
      const aw = await window.goga.invoke('desktop:activeWindow')
      setActiveWin(aw)
      setWindows(aw.title ? [aw] : [])
      setPanel('windows')
      flash('Showing active window (full window list requires agent)')
    } catch (e) { flash(`Failed: ${e}`) }
    finally { setBusy(false) }
  }

  const loadElements = async () => {
    setBusy(true)
    try {
      // Request UI elements via chat:send so it goes through the agent tool pipeline
      const reply = await window.goga.invoke('chat:send', '__desktop:uiElements__')
      // Parse JSON from reply if agent returned it, otherwise show status
      try {
        const data = JSON.parse(reply.content)
        if (Array.isArray(data)) { setElements(data); setPanel('elements'); return }
      } catch { /* not JSON */ }
      flash('Use the agent: "list UI elements in [window name]"')
      setPanel('elements')
    } catch (e) { flash(`Failed: ${e}`) }
    finally { setBusy(false) }
  }

  // Click on screenshot image → translate to screen coordinates and click
  const handleImageClick = async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!imgRef.current || !screenshot) return
    const rect = imgRef.current.getBoundingClientRect()
    const scaleX = (activeWin?.bounds?.width  ?? window.screen.width)  / rect.width  || window.screen.width  / rect.width
    const scaleY = (activeWin?.bounds?.height ?? window.screen.height) / rect.height || window.screen.height / rect.height

    // Use actual screen resolution from screenshot dimensions
    // screenshot-desktop returns full screen, so scale against screen size
    const screenW = window.screen.width
    const screenH = window.screen.height
    const sx = Math.round((e.clientX - rect.left) * (screenW / rect.width))
    const sy = Math.round((e.clientY - rect.top)  * (screenH / rect.height))

    setClickMarker({ x: e.clientX - rect.left, y: e.clientY - rect.top })
    setTimeout(() => setClickMarker(null), 800)

    setBusy(true)
    try {
      await window.goga.invoke('desktop:click', sx, sy)
      flash(`Clicked (${sx}, ${sy})`)
      setTimeout(takeScreenshot, 400)
    } catch (err) { flash(`Click failed: ${err}`) }
    finally { setBusy(false) }
  }

  const handleType = async () => {
    if (!typeText.trim()) return
    setBusy(true)
    try {
      await window.goga.invoke('desktop:typeText', typeText)
      flash(`Typed: "${typeText}"`)
      setTypeText('')
    } catch (e) { flash(`Type failed: ${e}`) }
    finally { setBusy(false) }
  }

  const handleKey = async () => {
    if (!keyText.trim()) return
    setBusy(true)
    try {
      await window.goga.invoke('desktop:pressKey', keyText.trim())
      flash(`Key: ${keyText}`)
      setKeyText('')
      setTimeout(takeScreenshot, 300)
    } catch (e) { flash(`Key failed: ${e}`) }
    finally { setBusy(false) }
  }

  const focusWindow = async (pid: number, title: string) => {
    setBusy(true)
    try {
      // No direct IPC for focusWindow — use moveCursor as a no-op to confirm connection, then inform user
      flash(`Focus: use agent — "focus window ${title}"`)
    } finally { setBusy(false) }
  }

  const clickElement = async (el: UIElement) => {
    setBusy(true)
    try {
      await window.goga.invoke('desktop:click', el.x, el.y)
      flash(`Clicked element: ${el.name}`)
      setTimeout(takeScreenshot, 400)
    } catch (e) { flash(`Click failed: ${e}`) }
    finally { setBusy(false) }
  }

  return (
    <div style={S.page}>

      {/* Toolbar */}
      <div style={S.toolbar}>
        <span style={S.title}>🖥 Desktop Control</span>
        <div style={S.toolbarGroup}>
          <button onClick={takeScreenshot} disabled={busy} style={S.btn}>📸 Screenshot</button>
          <button onClick={loadWindows}    disabled={busy} style={S.btn}>🪟 Windows</button>
          <button onClick={loadElements}   disabled={busy} style={S.btn}>🔍 UI Elements</button>
          <label style={S.toggleLabel}>
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
            Auto (2s)
          </label>
        </div>
        {status && <span style={S.status}>{status}</span>}
      </div>

      {/* Active window bar */}
      {activeWin && (
        <div style={S.winBar}>
          <span style={S.winBarLabel}>Active:</span>
          <span style={S.winBarTitle}>{activeWin.title || '—'}</span>
          <span style={S.winBarOwner}>{activeWin.owner}</span>
          {activeWin.bounds && (
            <span style={S.winBarBounds}>
              {activeWin.bounds.width}×{activeWin.bounds.height} @ ({activeWin.bounds.x},{activeWin.bounds.y})
            </span>
          )}
        </div>
      )}

      <div style={S.body}>

        {/* Screenshot pane */}
        <div style={S.screenshotPane}>
          {screenshot ? (
            <div style={S.imgWrap}>
              <img
                ref={imgRef}
                src={`data:image/png;base64,${screenshot}`}
                alt="Desktop screenshot"
                style={{ ...S.img, cursor: busy ? 'wait' : 'crosshair' }}
                onClick={handleImageClick}
                draggable={false}
              />
              {clickMarker && (
                <div style={{
                  ...S.clickDot,
                  left: clickMarker.x - 8,
                  top:  clickMarker.y - 8,
                }} />
              )}
            </div>
          ) : (
            <div style={S.placeholder}>
              {busy ? 'Capturing…' : 'Click Screenshot to capture'}
            </div>
          )}

          {/* Input controls below screenshot */}
          <div style={S.controls}>
            <div style={S.controlRow}>
              <span style={S.controlLabel}>Type text</span>
              <input
                style={S.input}
                value={typeText}
                onChange={e => setTypeText(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleType()}
                placeholder="Text to type into focused window…"
              />
              <button onClick={handleType} disabled={busy || !typeText.trim()} style={S.btn}>Type</button>
            </div>
            <div style={S.controlRow}>
              <span style={S.controlLabel}>Press key</span>
              <input
                style={{ ...S.input, width: 140 }}
                value={keyText}
                onChange={e => setKeyText(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleKey()}
                placeholder="Enter, Escape, Tab, F5…"
              />
              <button onClick={handleKey} disabled={busy || !keyText.trim()} style={S.btn}>Press</button>
              <div style={S.keyHints}>
                {['Enter','Escape','Tab','Space','Delete','F5','LeftControl','LeftAlt'].map(k => (
                  <button key={k} onClick={() => { setKeyText(k); }} style={S.keyChip}>{k}</button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Side panel */}
        {panel !== 'none' && (
          <div style={S.sidePanel}>
            <div style={S.sidePanelHeader}>
              <span style={S.sidePanelTitle}>
                {panel === 'windows' ? '🪟 Windows' : '🔍 UI Elements'}
              </span>
              <button onClick={() => setPanel('none')} style={S.closeBtn}>✕</button>
            </div>

            {panel === 'windows' && (
              <div style={S.list}>
                {windows.length === 0
                  ? <div style={S.empty}>No windows found</div>
                  : windows.map((w, i) => (
                    <div key={i} style={S.listItem} onClick={() => focusWindow(w.pid, w.title)}>
                      <div style={S.listItemTitle}>{w.title || '(untitled)'}</div>
                      <div style={S.listItemMeta}>{w.owner} · PID {w.pid}</div>
                      {w.bounds && (
                        <div style={S.listItemMeta}>
                          {w.bounds.width}×{w.bounds.height} @ ({w.bounds.x},{w.bounds.y})
                        </div>
                      )}
                    </div>
                  ))
                }
              </div>
            )}

            {panel === 'elements' && (
              <div style={S.list}>
                {elements.length === 0
                  ? <div style={S.empty}>Ask the agent: "list UI elements in [window]"</div>
                  : elements.map((el, i) => (
                    <div
                      key={i}
                      style={{ ...S.listItem, opacity: el.enabled ? 1 : 0.4 }}
                      onClick={() => clickElement(el)}
                      title={`Click at (${el.x}, ${el.y})`}
                    >
                      <div style={S.listItemTitle}>{el.name || '(unnamed)'}</div>
                      <div style={S.listItemMeta}>
                        {el.role} · ({el.x},{el.y}) · {el.width}×{el.height}
                        {el.value ? ` · "${el.value}"` : ''}
                      </div>
                    </div>
                  ))
                }
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  page:            { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', background: '#06050e' },
  toolbar:         { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0, flexWrap: 'wrap' },
  title:           { fontWeight: 700, fontSize: 13, color: 'var(--accent)', marginRight: 4 },
  toolbarGroup:    { display: 'flex', gap: 6, alignItems: 'center' },
  btn:             { background: 'var(--surface2)', color: 'var(--text)', padding: '5px 12px', fontSize: 12, cursor: 'pointer' },
  toggleLabel:     { display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' },
  status:          { marginLeft: 'auto', fontSize: 11, color: 'var(--accent)', fontStyle: 'italic' },
  winBar:          { display: 'flex', alignItems: 'center', gap: 10, padding: '5px 16px', background: '#0a0816', borderBottom: '1px solid #1a1428', flexShrink: 0, fontSize: 11 },
  winBarLabel:     { color: '#443355', flexShrink: 0 },
  winBarTitle:     { color: '#c8b8f0', fontWeight: 600, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  winBarOwner:     { color: '#554477', flexShrink: 0 },
  winBarBounds:    { color: '#332244', marginLeft: 'auto', flexShrink: 0 },
  body:            { display: 'flex', flex: 1, overflow: 'hidden' },
  screenshotPane:  { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' },
  imgWrap:         { flex: 1, overflow: 'auto', position: 'relative', background: '#000', display: 'flex', alignItems: 'flex-start', justifyContent: 'center' },
  img:             { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block', userSelect: 'none' },
  clickDot:        { position: 'absolute', width: 16, height: 16, borderRadius: '50%', background: 'rgba(91,33,255,0.7)', border: '2px solid #b794ff', pointerEvents: 'none', transition: 'opacity 0.3s' },
  placeholder:     { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#332244', fontSize: 13 },
  controls:        { flexShrink: 0, padding: '10px 16px', borderTop: '1px solid #1a1428', background: '#0a0816', display: 'flex', flexDirection: 'column', gap: 8 },
  controlRow:      { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  controlLabel:    { width: 70, fontSize: 11, color: '#443355', flexShrink: 0 },
  input:           { flex: 1, minWidth: 180, background: '#0e0c18', border: '1px solid #2a1f4a', color: '#e8d8ff', padding: '5px 8px', fontSize: 12 },
  keyHints:        { display: 'flex', gap: 4, flexWrap: 'wrap' },
  keyChip:         { background: '#13101f', color: '#554477', padding: '2px 7px', fontSize: 10, cursor: 'pointer', border: '1px solid #2a1f4a' },
  sidePanel:       { width: 280, borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#08070f' },
  sidePanelHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 },
  sidePanelTitle:  { fontWeight: 600, fontSize: 12, color: 'var(--text)' },
  closeBtn:        { background: 'transparent', color: '#443355', padding: '2px 6px', fontSize: 12, cursor: 'pointer' },
  list:            { flex: 1, overflowY: 'auto', padding: '6px 0' },
  listItem:        { padding: '7px 12px', borderBottom: '1px solid #0f0d1a', cursor: 'pointer' },
  listItemTitle:   { fontSize: 12, color: '#c8b8f0', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  listItemMeta:    { fontSize: 10, color: '#443355', marginTop: 2 },
  empty:           { padding: '20px 12px', color: '#332244', fontSize: 12, fontStyle: 'italic' },
}
