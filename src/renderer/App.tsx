import React, { useState } from 'react'
import ChatPage from './pages/ChatPage'
import ActivityPage from './pages/ActivityPage'
import ApprovalsPage from './pages/ApprovalsPage'
import MemoryPage from './pages/MemoryPage'
import LibraryPage from './pages/LibraryPage'
import SettingsPage from './pages/SettingsPage'
import SecurityPage from './pages/SecurityPage'
import StopButton from './components/StopButton'
import { GogaVisualProvider } from './context/GogaVisualContext'

type Tab = 'chat' | 'activity' | 'approvals' | 'memory' | 'library' | 'security' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'chat',      label: '💬 Chat' },
  { id: 'activity',  label: '📋 Activity' },
  { id: 'approvals', label: '✅ Approvals' },
  { id: 'memory',    label: '🧠 Memory' },
  { id: 'library',   label: '📚 Library' },
  { id: 'security',  label: '🔐 Security' },
  { id: 'settings',  label: '⚙️ Settings' },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('chat')

  return (
    <GogaVisualProvider>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <header style={styles.header}>
          <span style={styles.logo}>Goga</span>
          <nav style={styles.nav}>
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{ ...styles.tab, ...(tab === t.id ? styles.tabActive : {}) }}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <StopButton />
        </header>
        <main style={styles.main}>
          {tab === 'chat'      && <ChatPage />}
          {tab === 'activity'  && <ActivityPage />}
          {tab === 'approvals' && <ApprovalsPage />}
          {tab === 'memory'    && <MemoryPage />}
          {tab === 'library'   && <LibraryPage />}
          {tab === 'security'  && <SecurityPage />}
          {tab === 'settings'  && <SettingsPage />}
        </main>
      </div>
    </GogaVisualProvider>
  )
}

const styles: Record<string, React.CSSProperties> = {
  header: {
    display: 'flex', alignItems: 'center', gap: 16,
    padding: '0 20px', height: 52,
    background: 'var(--surface)', borderBottom: '1px solid var(--border)',
    WebkitAppRegion: 'drag' as never, flexShrink: 0,
  },
  logo:      { fontWeight: 700, fontSize: 18, color: 'var(--accent)', marginRight: 8 },
  nav:       { display: 'flex', gap: 4, WebkitAppRegion: 'no-drag' as never, flex: 1 },
  tab:       { background: 'transparent', color: 'var(--text-muted)', padding: '5px 12px' },
  tabActive: { background: 'var(--surface2)', color: 'var(--text)' },
  main:      { flex: 1, overflow: 'hidden', display: 'flex' },
}
