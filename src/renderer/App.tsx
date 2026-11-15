import React, { useEffect, useState } from 'react'
import ChatPage from './pages/ChatPage'
import ActivityPage from './pages/ActivityPage'
import ApprovalsPage from './pages/ApprovalsPage'
import MemoryPage from './pages/MemoryPage'
import LibraryPage from './pages/LibraryPage'
import SettingsPage from './pages/SettingsPage'
import StopButton from './components/StopButton'
import MissionMode from './components/MissionMode'
import DeveloperPage from './pages/DeveloperPage'
import TradingPage from './pages/TradingPage'
import BrowserPage from './pages/BrowserPage'
import VenuesPage from './pages/VenuesPage'
import SecurityPage from './pages/SecurityPage'
import EngineeringPage from './pages/EngineeringPage'
import EvolutionPage from './pages/EvolutionPage'
import OsintPage from './pages/OsintPage'
import StrategyPage from './pages/StrategyPage'
import BusinessPage from './pages/BusinessPage'
import JobsPage from './pages/JobsPage'
import SetupPage from './pages/SetupPage'
import MarketsPage from './pages/MarketsPage'
import { GogaVisualProvider } from './context/GogaVisualContext'
import { NAV, destinationOf, resolveLegacy, type DestinationId } from './nav'

/**
 * Chat-first, and short.
 *
 * Nine destinations instead of twenty tabs. Chat is the front door and the place work is
 * asked for; the other eight are the things a person has to see or configure. Every page that
 * used to be its own tab is a section inside one of them, and every one of those pages is
 * still reachable — by its section, and by asking in chat, because the capability behind it is
 * a tool the chat path can call.
 *
 * The old tab ids still resolve (see `nav.ts`), so a link or a test that names `osint` or
 * `practice` lands on the right section rather than nowhere.
 */
export default function App() {
  const [destination, setDestination] = useState<DestinationId>('chat')
  const [section, setSection] = useState<string>('chat')
  const [missionMode, setMissionMode] = useState(false)

  // A destination with one section opens straight onto it; one with several opens on its first.
  function go(next: DestinationId, wanted?: string) {
    const dest = NAV.find(d => d.id === next)
    if (!dest) return
    setDestination(next)
    setSection(wanted && dest.sections.some(s => s.id === wanted) ? wanted : dest.sections[0].id)
    setMissionMode(false)
  }

  // Anything that used to name a tab by id (a deep link, a test, an old habit) still works.
  useEffect(() => {
    const legacy = new URLSearchParams(window.location.search).get('tab')
    if (!legacy) return
    const hit = resolveLegacy(legacy)
    if (hit) go(hit.destination, hit.section)
  }, [])

  const current = NAV.find(d => d.id === destination) ?? NAV[0]
  const multi = current.sections.length > 1

  return (
    <GogaVisualProvider>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>

        {!missionMode && (
          <header className="g-header">
            <button
              onClick={() => setMissionMode(true)}
              className="g-logo"
              title="Back to Mission Mode"
            >Goga</button>
            <nav className="g-nav" aria-label="Sections">
              {NAV.map(d => (
                <button
                  key={d.id}
                  onClick={() => go(d.id)}
                  className={`g-tab${destination === d.id ? ' g-tab--active' : ''}`}
                  aria-current={destination === d.id ? 'page' : undefined}
                >
                  {d.label}
                </button>
              ))}
            </nav>
            <StopButton />
          </header>
        )}

        {/* A destination with more than one page shows its sections as a second row. */}
        {!missionMode && multi && (
          <div className="g-subnav" role="tablist" aria-label={`${current.label} sections`}>
            {current.sections.map(s => (
              <button
                key={s.id}
                role="tab"
                aria-selected={section === s.id}
                onClick={() => setSection(s.id)}
                className={`g-subtab${section === s.id ? ' g-subtab--active' : ''}`}
              >
                {s.label}
              </button>
            ))}
            <span className="g-subnav-purpose">{current.purpose}</span>
          </div>
        )}

        <main style={styles.main}>
          {missionMode && (
            <MissionMode
              onOpenChat={() => go('chat')}
              onOpenSettings={() => go('settings')}
            />
          )}

          {!missionMode && section === 'chat' && <ChatPage />}
          {!missionMode && section === 'activity' && <ActivityPage />}
          {!missionMode && section === 'approvals' && <ApprovalsPage />}
          {!missionMode && section === 'settings' && <SettingsPage />}

          {!missionMode && section === 'security' && <SecurityPage />}
          {!missionMode && section === 'osint' && <OsintPage />}
          {!missionMode && section === 'engineering' && <EngineeringPage />}

          {!missionMode && section === 'trading' && <TradingPage />}
          {!missionMode && section === 'practice' && <VenuesPage />}
          {!missionMode && section === 'strategy' && <StrategyPage />}
          {!missionMode && section === 'markets' && <MarketsPage />}

          {!missionMode && section === 'business' && <BusinessPage />}
          {!missionMode && section === 'jobs' && <JobsPage />}

          {!missionMode && section === 'browser' && <BrowserPage />}
          {!missionMode && section === 'setup' && <SetupPage />}

          {!missionMode && section === 'memory' && <MemoryPage />}
          {!missionMode && section === 'library' && <LibraryPage />}
          {!missionMode && section === 'evolution' && <EvolutionPage />}
          {!missionMode && section === 'developer' && <DeveloperPage />}
        </main>

      </div>
    </GogaVisualProvider>
  )
}

const styles: Record<string, React.CSSProperties> = {
  main: { flex: 1, overflow: 'hidden', display: 'flex' },
}

// Exported for the reachability test: every section id the shell can render.
export const RENDERED_SECTIONS = [
  'chat', 'activity', 'approvals', 'settings',
  'security', 'osint', 'engineering',
  'trading', 'practice', 'strategy', 'markets',
  'business', 'jobs',
  'browser', 'setup',
  'memory', 'library', 'evolution', 'developer',
]

// Kept so a caller can ask where a section lives without importing the whole nav model.
export { destinationOf }
