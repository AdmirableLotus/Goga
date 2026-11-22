import { describe, expect, it, vi } from 'vitest'

// `agentLoop` imports `../index` for the window handle, and `index` touches `app` at module
// load. Under the test runner there is no Electron, so it is stubbed here.
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

import { AgentLoop } from '../agentLoop'
import { CANTINA_DIRECTORY_URL, CANTINA_PROGRAM_URL } from '../browser/siteResolve'

/**
 * The three defects from the recorded run, as the loop itself sees them.
 *
 * These go through AgentLoop with no browser, no model and no network: they pin the decisions
 * the loop makes before any of that is involved — which page a request resolves to, and what
 * the turn ends with when the page cannot be read.
 */

const step = (tool: string, success: boolean, data?: unknown, error?: string) => ({
  index: 0, thought: '', tool,
  params: {}, riskLevel: 'low' as const,
  result: { success, data, error },
})

describe('a named Cantina program is read, not the directory', () => {
  it('"read the Cantina program page scope" opens the program page', () => {
    const s = AgentLoop.getHardcodedFirstStep('read the Cantina program page scope')
    expect(s?.tool).toBe('browser.goto')
    expect(s?.params.url).toBe(CANTINA_PROGRAM_URL)
    expect(s?.params.url).not.toBe(CANTINA_DIRECTORY_URL)
  })

  it('siteToOpen agrees, so the second route cannot disagree with the first', () => {
    expect(AgentLoop.siteToOpen('read the Cantina program page scope')).toBe(CANTINA_PROGRAM_URL)
    expect(AgentLoop.siteToOpen('read the Cantina program page scope')).not.toBe(CANTINA_DIRECTORY_URL)
  })

  it('the thought names the program, so the reply can say which one it read', () => {
    const s = AgentLoop.getHardcodedFirstStep('read the Cantina program page scope')
    expect(s?.thought).toMatch(/Cantina Bug Bounty Program/)
  })
})

describe('a scope request counts as a request for the page\'s content', () => {
  it('"read the Cantina program page scope" wants content', () => {
    // This is what failed live: the read was never issued because the request did not match
    // the old "tell me what it says" regex, and the turn ended with nothing.
    expect(AgentLoop.wantsPageContent('read the Cantina program page scope')).toBe(true)
    expect(AgentLoop.wantsPageContent('read the program rules')).toBe(true)
    expect(AgentLoop.wantsPageContent('open the Cantina bug bounty page and tell me what it says')).toBe(true)
  })

  it('a plain open still does not want content', () => {
    expect(AgentLoop.wantsPageContent('open cantina.xyz')).toBe(false)
  })

  it('issues the read after the navigation for a scope request', () => {
    const follow = AgentLoop.getHardcodedFollowUp('read the Cantina program page scope', [
      step('browser.goto', true, 'Opened it'),
    ])
    expect(follow?.tool).toBe('browser.readPage')
  })

  it('answers from the read page, with the scope in it', () => {
    const read = 'URL: https://bounties.cantina.xyz/cantina/bug-bounty\nTitle: Cantina Bug Bounty\n\n'
      + 'Scope: cantina.xyz, cantina.security. Critical $5,000. High $2,000.\n\nInteractive elements on the page: 12\n- link "Sign in to join"'
    const answer = AgentLoop.answerAfterRead('read the Cantina program page scope', [
      step('browser.goto', true, 'Opened it'),
      step('browser.readPage', true, read),
    ])
    expect(answer).toContain('cantina.xyz')
    expect(answer).toContain('cantina.security')
    expect(answer).toContain('$5,000')
    // The element dump is for a planner, not a person.
    expect(answer).not.toMatch(/Interactive elements/)
  })
})

describe('a run that cannot read the page still says why', () => {
  it('states the reason the read failed instead of nothing', () => {
    // The live failure was an acknowledgement and then silence. A failed read must leave words.
    const said = AgentLoop.failureAnswer([
      step('browser.goto', true, 'Opened it'),
      step('browser.readPage', false, undefined, 'The Brave window closed before it could be read.'),
    ])
    expect(said).toBeTruthy()
    expect(said).toContain('could not read the page')
    expect(said).toContain('The Brave window closed before it could be read.')
  })

  it('names the step that failed when it was not a read', () => {
    const said = AgentLoop.failureAnswer([
      step('browser.goto', false, undefined, 'example.com is not a host Goga\'s Brave profile reads.'),
    ])
    // Plain words, no internal tool name leaking into what the user reads.
    expect(said).toContain('could not open the page')
    expect(said).not.toContain('browser.goto')
    expect(said).toContain('not a host')
  })

  it('has nothing to say when the last step succeeded — a success is not a failure', () => {
    expect(AgentLoop.failureAnswer([step('browser.goto', true, 'Opened it')])).toBeNull()
    expect(AgentLoop.failureAnswer([])).toBeNull()
  })
})

describe('the old Cantina behaviour still holds where it should', () => {
  it('a plain "cantina bounty" request that names no program still goes to the directory', () => {
    expect(AgentLoop.siteToOpen('lets work the cantina bounty')).toBe(CANTINA_DIRECTORY_URL)
  })

  it('a question about Cantina is still a question', () => {
    expect(AgentLoop.siteToOpen('what is cantina?')).toBeNull()
  })
})
