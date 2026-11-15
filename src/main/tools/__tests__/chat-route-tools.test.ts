import { describe, expect, it, vi } from 'vitest'

// The tool modules import Electron and the services behind them. This test is about the
// registry's contents, so Electron is stubbed and the modules are imported for their
// self-registration side effects, exactly as `tools/index.ts` does in the app.
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/goga-test',
    getAppPath: () => '/tmp/goga-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    commandLine: { getSwitchValue: () => '', appendSwitch: () => {} },
    whenReady: () => new Promise(() => {}),
    on: () => {},
    requestSingleInstanceLock: () => false,
    quit: () => {},
    setAppUserModelId: () => {},
    disableHardwareAcceleration: () => {},
    setAsDefaultProtocolClient: () => true,
  },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class { static getAllWindows() { return [] } },
  shell: { openExternal: async () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}))

import { ToolRegistry } from '../registry'
import {
  parseBusinessPrepare, parseDeveloperCommand, parseEvolutionDecision, parseLocalReview,
  parseMarketsCommand, parseMonitorCommand, parseScopeQuestion, parseVenueCommand,
} from '../../services/chatRoutes'

/**
 * Every route chat can take lands on a tool that exists.
 *
 * A parser that returns a tool name nobody registered is worse than no parser: the reply says
 * "Couldn't do that: Unknown tool", which reads like a bug in the user's request. This test
 * walks the same sentences the route tests use and checks the registry holds each tool.
 */

// Import the modules the routes reach. Each registers itself on import.
import '../../tools/security'
import '../../tools/grimoire'
import '../../tools/venues'
import '../../tools/markets'
import '../../tools/business'
import '../../tools/evolution'
import '../../tools/developer'

const reg = ToolRegistry.getInstance()

/** Every tool name the direct routes can produce, from the sentences that produce them. */
function routedTools(): string[] {
  const names: string[] = []
  const scope = parseScopeQuestion('is status.coinbase.com in scope for coinbase')
  if (scope?.program) names.push('security.importProgram')
  names.push('security.checkTarget')

  const review = parseLocalReview('review wp-includes/class-wp-http.php', 'C:\\src\\wordpress')
  if (review) names.push('security.reviewFile')
  names.push('security.indexTarget')

  for (const said of [
    'how is my pivex account doing', 'what are my pivex practice stats',
    'show me the pivex trades', 'stop trading on pivex', 'what should i practise on pivex',
  ]) {
    const v = parseVenueCommand(said)
    if (v) names.push(v.tool)
  }

  for (const said of ['what markets data do i have', 'backtest my watchlist']) {
    const m = parseMarketsCommand(said)
    if (m) names.push(m.tool)
  }

  const monitor = parseMonitorCommand('check my apps')
  if (monitor) names.push(monitor.tool)

  const mail = parseBusinessPrepare('draft an email to sam@example.com about the invoice')
  if (mail) names.push(mail.tool)

  const install = parseEvolutionDecision('install it')
  if (install) names.push(install.tool)
  const discard = parseEvolutionDecision('discard the change')
  if (discard) names.push(discard.tool)

  const dev = parseDeveloperCommand('developer mode: the browser retries the same failing page and never reports why')
  if (dev) names.push(dev.tool)

  return [...new Set(names)]
}

describe('every tool a chat route can name is registered', () => {
  it('finds the routes at all, so this test cannot pass vacuously', () => {
    expect(routedTools().length).toBeGreaterThanOrEqual(12)
  })

  it('has each one in the registry', () => {
    for (const name of routedTools()) {
      expect(reg.has(name), `route names "${name}" but no tool is registered under it`).toBe(true)
    }
  })

  it('gives each one a description and a risk level, so the planner can reason about it', () => {
    for (const name of routedTools()) {
      const tool = reg.get(name)!.definition
      expect(tool.description.length, name).toBeGreaterThan(30)
      expect(['low', 'medium', 'high', 'critical'], name).toContain(tool.riskLevel)
    }
  })
})

describe('the tools that used to be page-only now exist', () => {
  it('has the venue reads the Practice page had', () => {
    for (const name of ['venue.info', 'venue.read', 'venue.stats', 'venue.trades', 'venue.halt', 'venue.halts', 'venue.events', 'venue.studyBase']) {
      expect(reg.has(name), name).toBe(true)
    }
  })

  it('has the markets operations the Markets page had', () => {
    for (const name of ['markets.state', 'markets.import', 'markets.watchlist', 'markets.backtest']) {
      expect(reg.has(name), name).toBe(true)
    }
  })

  it('has the business preparations the Business page had', () => {
    for (const name of ['business.prepareMail', 'business.preparePost', 'business.prepareListing', 'business.checkApps']) {
      expect(reg.has(name), name).toBe(true)
    }
  })

  it('has the self-improvement decision the Self-improve page had', () => {
    for (const name of ['evolution.install', 'evolution.discard']) expect(reg.has(name), name).toBe(true)
  })

  it('has the developer run the Developer page had', () => {
    for (const name of ['developer.start', 'developer.state', 'developer.stop']) expect(reg.has(name), name).toBe(true)
  })
})

describe('the safety split is unchanged', () => {
  it('keeps the one tool that reaches a target critical', () => {
    expect(reg.get('security.probe')!.definition.riskLevel).toBe('critical')
  })

  it('keeps installing a self-improvement run critical, because it writes source', () => {
    expect(reg.get('evolution.install')!.definition.riskLevel).toBe('critical')
  })

  it('keeps a developer build run critical, because it edits source', () => {
    expect(reg.get('developer.start')!.definition.riskLevel).toBe('critical')
  })

  it('keeps the venue halt reversible and the order path absent', () => {
    expect(reg.get('venue.halt')!.definition.reversible).toBe(true)
    // No tool in the venue family can prepare or send an order: that stays on the page,
    // behind the single-use ticket the user approves.
    for (const name of ['venue.prepare', 'venue.send', 'venue.order']) {
      expect(reg.has(name), `${name} must not exist`).toBe(false)
    }
  })

  it('keeps every business preparation non-sending', () => {
    for (const name of ['business.prepareMail', 'business.preparePost', 'business.prepareListing']) {
      expect(reg.get(name)!.definition.reversible, name).toBe(true)
    }
    // There is still no tool that sends mail or posts.
    for (const name of ['business.sendMail', 'business.post', 'business.publish']) {
      expect(reg.has(name), `${name} must not exist`).toBe(false)
    }
  })
})
