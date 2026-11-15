import { describe, expect, it, vi } from 'vitest'

// `agentLoop` imports `../index`, which touches `app` at module load. Under a test runner
// there is no Electron, so it is stubbed exactly as `chat-acts.test.ts` does.
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

import { parseLocalReview, parseLocalRootCommand } from '../chatRoutes'
import { isVagueOpenWebsite } from '../agentRouting'
import { AgentLoop } from '../agentLoop'

/**
 * The three things that only broke when the app was actually run.
 *
 * Each one was invisible to the typechecker and to the unit tests that existed: the sentence
 * parsed, the app started, and the wrong thing happened. They are here so the next change
 * does not quietly bring them back.
 */

describe('a folder and a file are not the same thing', () => {
  it('does not read a source file as a folder to remember', () => {
    // This is what happened live: "review wp-includes/class-wp-http.php in the local WordPress
    // copy" was taken as "remember /class-wp-http.php as my local copy".
    expect(parseLocalRootCommand('review wp-includes/class-wp-http.php in the local WordPress copy')).toBeNull()
  })

  it('still reads a real folder', () => {
    expect(parseLocalRootCommand('use C:\\Users\\redre\\OS3\\goga-specialist-review\\wp\\wordpress as my local copy'))
      .toEqual({ root: 'C:\\Users\\redre\\OS3\\goga-specialist-review\\wp\\wordpress' })
  })

  it('refuses a single bare segment as a root', () => {
    expect(parseLocalRootCommand('use /wordpress as my local copy')).toBeNull()
  })

  it('still finds the file to review in that same sentence', () => {
    const r = parseLocalReview(
      'review wp-includes/class-wp-http.php in the local WordPress copy',
      'C:\\Users\\redre\\OS3\\goga-specialist-review\\wp\\wordpress',
    )
    expect(r).toEqual({
      root: 'C:\\Users\\redre\\OS3\\goga-specialist-review\\wp\\wordpress',
      path: 'wp-includes/class-wp-http.php',
    })
  })
})

describe('Cantina is a site, not a vague request', () => {
  it('does not ask which website when Cantina is named', () => {
    expect(isVagueOpenWebsite('open the Cantina bug bounty page and tell me what it says')).toBe(false)
  })

  it('knows where Cantina is, so the first step is a real navigation', () => {
    expect(AgentLoop.siteToOpen('open the Cantina bug bounty page and tell me what it says'))
      .toBe('https://cantina.xyz/bounties')
  })

  it('still asks when the request really is vague', () => {
    expect(isVagueOpenWebsite('open a website')).toBe(true)
    expect(isVagueOpenWebsite('open the bug bounty page')).toBe(true)
  })

  it('still treats a question about Cantina as a question', () => {
    expect(AgentLoop.siteToOpen('what is cantina?')).toBeNull()
  })
})
