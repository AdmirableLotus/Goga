import { describe, expect, it, vi } from 'vitest'

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
import { groundAgentReply, pageEvidence, reportsPageContent } from '../replyHonesty'

/**
 * What running the app found that compiling did not.
 *
 * Every case here is a transcript from the diagnostic instance: a reply that quoted a page
 * nobody read, a navigate-then-read request that ended in a planning error with the page text
 * already in hand, and a review that looked for a relative path in the wrong folder.
 */

const step = (tool: string, success: boolean, data?: unknown, error?: string) => ({
  index: 0, thought: '', tool,
  params: {}, riskLevel: 'low' as const,
  result: { success, data, error },
})

describe('a page answer comes from the page, not from a second planning step', () => {
  it('answers once the page has been read, instead of asking the model again', () => {
    const read = 'URL: https://cantina.xyz/bounties\nTitle: Cantina\n\nWelcome to Cantina.\n\nInteractive elements on the page: 41\n- link "Home"'
    const answer = AgentLoop.answerAfterRead(
      'open the Cantina bug bounty page and tell me what it says',
      [step('browser.goto', true, 'Opened it'), step('browser.readPage', true, read)],
    )
    expect(answer).toContain('Welcome to Cantina.')
  })

  it('drops the list of interactive elements, which is for a planner not a person', () => {
    const read = 'URL: https://x.example\nTitle: X\n\nReal page text.\n\nInteractive elements on the page: 2\n- link "Home"\n- link "Terms"'
    const answer = AgentLoop.readablePageAnswer(read)
    expect(answer).toContain('Real page text.')
    expect(answer).not.toMatch(/Interactive elements/)
    expect(answer).not.toMatch(/- link "Home"/)
  })

  it('does not answer for a request that only asked to open the page', () => {
    expect(AgentLoop.answerAfterRead('open cantina.xyz', [
      step('browser.goto', true, 'ok'), step('browser.readPage', true, 'text'),
    ])).toBeNull()
  })

  it('does not answer from a failed read', () => {
    expect(AgentLoop.answerAfterRead('open cantina.xyz and tell me what it says', [
      step('browser.goto', true, 'ok'), step('browser.readPage', false, undefined, 'no content'),
    ])).toBeNull()
  })
})

describe('a reply may not quote a page that was never read', () => {
  it('catches the exact shape the live run produced', () => {
    const fabricated = 'Opening the Cantina bug bounty page now.\n\n'
      + 'The Cantina bug bounty page states:\n\n**Welcome to Cantina\'s Bug Bounty Program!**\n\n'
      + '1. **Scope:** Identify the scope of the program.'
    expect(reportsPageContent(fabricated)).toBe(true)
    const out = groundAgentReply(fabricated, [step('browser.goto', true, 'Opened it')])
    expect(out.corrected).toBe(true)
    expect(out.reason).toBe('page-unread')
    expect(out.content).not.toMatch(/Welcome to Cantina's Bug Bounty Program/)
    expect(out.content).toContain('Nothing was read from that page')
  })

  it('leaves a reply alone when a page really was read', () => {
    const honest = 'The page states: we pay for XSS and SSRF.'
    const out = groundAgentReply(honest, [step('browser.readPage', true, honest)])
    expect(out.reason).not.toBe('page-unread')
  })

  it('does not fire on a reply that describes what it will do', () => {
    expect(reportsPageContent('I will open the page and tell you what it says.')).toBe(false)
    expect(reportsPageContent('Here is a draft of your post.')).toBe(false)
    // A plan to check is not a claim to have checked.
    expect(reportsPageContent('I want me to read the page?')).toBe(false)
  })
})

describe('the page evidence is attached, not invented', () => {
  it('carries the read page text into the reply', () => {
    const read = 'URL: https://x.example\nTitle: X\n\nWe pay for XSS.'
    const out = groundAgentReply('The program is open.', [step('browser.readPage', true, read)])
    expect(out.content).toContain('We pay for XSS.')
  })

  it('reads nothing from a failed read', () => {
    expect(pageEvidence([step('browser.readPage', false, undefined, 'no content')])).toBe('')
  })
})

describe('Cantina is a known site', () => {
  it('navigates to its bounty page rather than asking which website', () => {
    expect(AgentLoop.siteToOpen('open the Cantina bug bounty page and tell me what it says'))
      .toBe('https://cantina.xyz/bounties')
  })
})
