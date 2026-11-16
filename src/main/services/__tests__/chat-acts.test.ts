import { describe, expect, it, vi } from 'vitest'

// `agentLoop` imports `../index` for the window handle, and `index` touches `app` at module
// load (a diagnostic, the .env path, a Chromium switch). Under a test runner there is no
// Electron, so it is stubbed here rather than making the production entry point defensive
// about a runtime it always has.
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
import {
  CAPABILITY_STATEMENT, NOTHING_DONE_STATEMENT, claimsAction, disclaimsCapability,
  enforceHonestReply, groundAgentReply, pageEvidence,
} from '../replyHonesty'
import { isImperativeRequest, looksLikeAgentTask, namesAnActionTarget } from '../agentRouting'
import { AgentLoop } from '../agentLoop'

/**
 * The three failures from the user's own transcript, as tests.
 *
 *   1. a reply that claims an action no tool performed
 *   2. an imperative that was answered as a topic instead of dispatched
 *   3. a reply that disclaims a capability Goga actually has
 *
 * Each one is the exact sentence the user read, so a regression shows up here rather than
 * in a conversation they have to notice for themselves.
 */

describe('1. a reply may not claim an action no tool performed', () => {
  it('replaces the transcript\'s "I\'ve opened hackerone.com" when nothing ran', () => {
    const reply = "Sure, let's navigate to a site where you can find bounty hunting resources. "
      + "I've opened https://www.hackerone.com/. This site lists various organizations and their bug bounty programs."
    const out = enforceHonestReply(reply, { acted: false })
    expect(out.corrected).toBe(true)
    expect(out.reason).toBe('claim')
    // The claim is gone. Not annotated — gone.
    expect(out.content).not.toMatch(/I['’]ve opened/)
    expect(out.content).toContain(NOTHING_DONE_STATEMENT)
  })

  it('replaces the second claim from the transcript too', () => {
    const reply = "Sure, let's head over to Coinbase's bug bounty program page. I'll open it for you. "
      + "I've opened https://www.coinbase.com/bugbounty."
    const out = enforceHonestReply(reply, { acted: false })
    expect(out.content).not.toMatch(/I['’]ve opened/)
    expect(out.content).toContain(NOTHING_DONE_STATEMENT)
  })

  it('leaves a reply that really did run a tool alone', () => {
    const reply = "I've opened https://www.coinbase.com/bugbounty. The page says the program is paused."
    expect(enforceHonestReply(reply, { acted: true }).content).toBe(reply)
  })

  it('keeps the useful part of a reply that also claimed something', () => {
    const reply = 'Coinbase pays up to $50,000 for a critical report. I checked their policy page today. '
      + 'The scope covers api.coinbase.com and www.coinbase.com.'
    const out = enforceHonestReply(reply, { acted: false })
    expect(out.content).toContain('up to $50,000')
    expect(out.content).toContain('api.coinbase.com')
    expect(out.content).not.toMatch(/I checked their policy page/)
  })

  it('leaves plans, advice and offers alone', () => {
    for (const fine of [
      'Here is a draft of your pitch.',
      'I can open it for you if you want.',
      'You opened the file earlier.',
    ]) expect(enforceHonestReply(fine, { acted: false }).corrected).toBe(false)
  })

  it('corrects an agent reply that says it opened a page the navigation failed on', () => {
    const out = groundAgentReply("I've opened the Coinbase bug bounty page.", [
      { tool: 'browser.goto', result: { success: false, error: 'the page did not load' } },
    ])
    expect(out.corrected).toBe(true)
    expect(out.content).not.toMatch(/I['’]ve opened/)
    expect(out.content).toContain('could not open that page')
    expect(out.content).toContain('the page did not load')
  })

  it('appends the page\'s own words, so the answer carries something only a read could give', () => {
    const out = groundAgentReply('The program is open.', [{
      tool: 'browser.readPage',
      result: { success: true, data: 'URL: https://example.com/bounty\nTitle: Bounty\n\nWe pay for XSS and SSRF.' },
    }])
    expect(out.content).toContain('We pay for XSS and SSRF.')
    expect(pageEvidence([{ tool: 'browser.readPage', result: { success: true, data: 'the real text' } }]))
      .toBe('the real text')
  })

  it('reads nothing from a failed page read', () => {
    expect(pageEvidence([{ tool: 'browser.readPage', result: { success: false, error: 'no content' } }])).toBe('')
  })
})

describe('2. an imperative is an instruction to act, not a topic', () => {
  it('dispatches the transcript\'s first two utterances, which fell through to chat', () => {
    for (const said of ['lets do bounty', 'I would like to do coinbase one']) {
      expect(isImperativeRequest(said)).toBe(true)
      expect(looksLikeAgentTask(said)).toBe(true)
    }
  })

  it('dispatches the third, which was answered with "I can\'t perform actions"', () => {
    const said = 'please do a bounty for me on hacker one the one you think you can do'
    expect(isImperativeRequest(said)).toBe(true)
    expect(looksLikeAgentTask(said)).toBe(true)
  })

  it('dispatches a plain imperative naming a page and what to read', () => {
    const said = 'open the Coinbase bug bounty page and tell me what it says'
    expect(isImperativeRequest(said)).toBe(true)
    expect(namesAnActionTarget(said)).toBe(true)
  })

  it('dispatches the multi-step request from the brief', () => {
    const said = 'open the Coinbase bug bounty page, read what it says about scope and rewards, and tell me what I\'d be allowed to test'
    expect(isImperativeRequest(said)).toBe(true)
  })

  it('still treats a question about the same subject as a question', () => {
    for (const asked of [
      'how do I open a bug bounty program on hackerone?',
      'what is the difference between a bounty and a vulnerability?',
      'explain how hackerone scope works',
    ]) expect(looksLikeAgentTask(asked)).toBe(false)
  })

  it('does not swallow ordinary conversation that opens with a common verb', () => {
    for (const chat of [
      'I want to go back',
      'please fill in your details',
      'can you fill me in on what happened?',
      'do you remember my name?',
      'read this and tell me how it sounds',   // no target named, but "read" is an order
    ]) expect(isImperativeRequest(chat)).toBe(false)
  })

  it('does not treat a single word as an order', () => {
    expect(isImperativeRequest('run')).toBe(false)
  })
})

describe('3. a capability Goga has must not be disclaimed', () => {
  it('catches the transcript\'s disclaimer and replaces it with the real limits', () => {
    const reply = "I can guide you through the process, but remember that I can't perform actions on your behalf "
      + 'or log in to accounts.'
    expect(disclaimsCapability(reply)).toBe(true)
    const out = enforceHonestReply(reply, { acted: false })
    expect(out.corrected).toBe(true)
    expect(out.reason).toBe('disclaimer')
    expect(out.content).not.toMatch(/can['’]t perform actions on your behalf/i)
    expect(out.content).toContain(CAPABILITY_STATEMENT)
    // The specific limits survive: what it will not do, named one by one.
    expect(CAPABILITY_STATEMENT).toMatch(/sign in as you/)
    expect(CAPABILITY_STATEMENT).toMatch(/send something you haven't approved/)
  })

  it('catches the other shapes of the same false denial', () => {
    for (const denial of [
      "I can't browse the web for you.",
      "I'm unable to access websites.",
      'I do not have the ability to browse websites.',
      "I can't access the internet.",
      "I can't log in to websites on behalf of you.",
    ]) expect(disclaimsCapability(denial)).toBe(true)
  })

  it('leaves the true, specific limits exactly as they are', () => {
    for (const honest of [
      "I can't sign in as you — the login needs your password.",
      "I can't accept the terms on your behalf; that one is yours to click.",
      "I can't send the report for you. I've drafted it in your findings list.",
      "I can't deposit or withdraw — that is money, and I don't touch it.",
      "The page needs a two-factor code, so I stopped there.",
    ]) {
      expect(disclaimsCapability(honest)).toBe(false)
      expect(claimsAction(honest)).toBe(false)
    }
  })
})

describe('4. the browser is reachable from a chat request', () => {
  it('turns a named site into a real navigation as the first step', () => {
    expect(AgentLoop.siteToOpen('open the Coinbase bug bounty page and tell me what it says'))
      .toBe('https://www.coinbase.com/bugbounty')
    expect(AgentLoop.siteToOpen('go to https://example.com/scope and read it'))
      .toBe('https://example.com/scope')
    expect(AgentLoop.siteToOpen('lets do bounty')).toBe('https://www.hackerone.com/')
  })

  it('does not force HackerOne when the bounty request names a specific page or platform', () => {
    // The bug this fixes: "test goga on bounty <cantina url>" opened hackerone.com and ignored
    // the URL. A URL or a named platform in the request now wins over the generic directory.
    expect(AgentLoop.siteToOpen('test goga on this bounty https://acme.example/scope'))
      .toBe('https://acme.example/scope')
    expect(AgentLoop.siteToOpen('lets work the cantina bounty')).toBe('https://cantina.xyz/bounties')
    expect(AgentLoop.siteToOpen('lets work the bugcrowd bounty')).toBe('https://www.bugcrowd.com/')
  })

  it('routes a Cantina bounty URL to the scope importer, not a raw browser open', () => {
    expect(AgentLoop.cantinaBountyUrl('test goga on bounty https://bounties.cantina.xyz/cantina/bug-bounty'))
      .toBe('https://bounties.cantina.xyz/cantina/bug-bounty')
    const step = AgentLoop.getHardcodedFirstStep('work the bounty at https://bounties.cantina.xyz/cantina/bug-bounty')
    expect(step?.tool).toBe('security.importCantina')
    expect(step?.params.url).toBe('https://bounties.cantina.xyz/cantina/bug-bounty')
  })

  it('does not navigate for a question that merely mentions a site', () => {
    expect(AgentLoop.siteToOpen('what does hackerone.com do?')).toBeNull()
    expect(AgentLoop.siteToOpen('how much does coinbase charge?')).toBeNull()
  })

  it('produces browser.goto as the hardcoded first step, so the model cannot narrate instead', () => {
    const step = AgentLoop.getHardcodedFirstStep('open the Coinbase bug bounty page and tell me what it says')
    expect(step?.tool).toBe('browser.goto')
    expect(step?.params.url).toBe('https://www.coinbase.com/bugbounty')
  })
})
