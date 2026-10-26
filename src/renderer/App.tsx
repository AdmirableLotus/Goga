import React, { useState } from 'react'
import type { ElectronCSSProperties } from './types/electron-styles'
import ChatPage from './pages/ChatPage'
import ActivityPage from './pages/ActivityPage'
import ApprovalsPage from './pages/ApprovalsPage'
import MemoryPage from './pages/MemoryPage'
import LibraryPage from './pages/LibraryPage'
import SettingsPage from './pages/SettingsPage'
import SecurityPage from './pages/SecurityPage'
import MissionPage from './pages/MissionPage'
import DesktopPage from './pages/DesktopPage'
import StopButton from './components/StopButton'
import MissionMode from './components/MissionMode'
import DeveloperPage from './pages/DeveloperPage'
import { GogaVisualProvider } from './context/GogaVisualContext'

type Tab = 'developer' | 'mission-mode' | 'chat' | 'mission' | 'desktop' | 'activity' | 'approvals' | 'memory' | 'library' | 'security' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'developer', label: 'Developer' },
  { id: 'chat',      label: '💬 Chat' },
  { id: 'mission',   label: '⚡ Mission' },
  { id: 'desktop',   label: '🖥 Desktop' },
  { id: 'activity',  label: '📋 Activity' },
  { id: 'approvals', label: '✅ Approvals' },
  { id: 'memory',    label: '🧠 Memory' },
  { id: 'library',   label: '📚 Library' },
  { id: 'security',  label: '🔐 Security' },
  { id: 'settings',  label: '⚙️ Settings' },
]

export default function App() {
  // Default to mission-mode (cinematic primary view)
  const [tab, setTab] = useState<Tab>('chat')

  return (
    <GogaVisualProvider>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>

        {/* Header — only shown when NOT in mission-mode */}
        {tab !== 'mission-mode' && (
          <header style={styles.header}>
            <button
              onClick={() => setTab('mission-mode')}
              style={styles.logoBtn}
              title="Back to Mission Mode"
            >Goga</button>
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
        )}

        <main style={styles.main}>
          {tab === 'developer' && <DeveloperPage />}
          {tab === 'mission-mode' && (
            <MissionMode
              onOpenChat={()     => setTab('chat')}
              onOpenSettings={() => setTab('settings')}
            />
          )}
          {tab === 'chat'      && <ChatPage />}
          {tab === 'activity'  && <ActivityPage />}
          {tab === 'approvals' && <ApprovalsPage />}
          {tab === 'memory'    && <MemoryPage />}
          {tab === 'library'   && <LibraryPage />}
          {tab === 'mission'   && <MissionPage />}
          {tab === 'desktop'   && <DesktopPage />}
          {tab === 'security'  && <SecurityPage />}
          {tab === 'settings'  && <SettingsPage />}
        </main>

      </div>
    </GogaVisualProvider>
  )
}

const styles: Record<string, ElectronCSSProperties> = {
  header: {
    display: 'flex', alignItems: 'center', gap: 16,
    padding: '0 20px', height: 52,
    background: 'var(--surface)', borderBottom: '1px solid var(--border)',
    WebkitAppRegion: 'drag', flexShrink: 0,
  },
  logoBtn: {
    fontWeight: 700, fontSize: 18, color: 'var(--accent)',
    background: 'transparent', border: 'none', marginRight: 8,
    WebkitAppRegion: 'no-drag', cursor: 'pointer',
  },
  nav:       { display: 'flex', gap: 4, WebkitAppRegion: 'no-drag', flex: 1, minWidth: 0, overflowX: 'auto' },
  tab:       { background: 'transparent', color: 'var(--text-muted)', padding: '5px 12px' },
  tabActive: { background: 'var(--surface2)', color: 'var(--text)' },
  main:      { flex: 1, overflow: 'hidden', display: 'flex' },
}
