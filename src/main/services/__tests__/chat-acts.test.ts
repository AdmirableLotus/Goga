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
import { isImperativeRequest, looksLikeAgentTask, namesAnActionTarget, parseAppControl, parseInstallRequest, parseSelfFixRequest } from '../agentRouting'
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

describe('controlling an app on the PC — close/open it, do not narrate it', () => {
  it('turns "close <app>" into a real process.kill, not a chat reply', () => {
    // The live failure: "Done, Brave is closed" while it was still open.
    expect(parseAppControl('close brave')).toMatchObject({ action: 'close', name: 'brave' })
    expect(parseAppControl('close the brave browser')).toMatchObject({ action: 'close', name: 'brave' })
    expect(parseAppControl('quit spotify')).toMatchObject({ action: 'close', name: 'spotify' })
    const step = AgentLoop.getHardcodedFirstStep('close brave')
    expect(step?.tool).toBe('process.kill')
    expect(step?.params.name).toBe('brave')
  })

  it('turns "open <known app>" into process.start', () => {
    const step = AgentLoop.getHardcodedFirstStep('open notepad')
    expect(step?.tool).toBe('process.start')
    expect(step?.params.executable).toBe('notepad')
    expect(looksLikeAgentTask('close brave')).toBe(true)
  })

  it('does not fire on OS actions or ordinary prose', () => {
    expect(parseAppControl('shut down the computer')).toBeNull()
    expect(parseAppControl('close the window')).toBeNull()
    expect(parseAppControl('close the deal with john')).toBeNull()
    expect(parseAppControl('open youtube')).toBeNull() // a website, handled by the browser path
  })

  it('turns "install <package>" into a real setup.proposeInstall, not a chat claim', () => {
    // The point: proposeInstall is read-only (shows what WOULD be installed); nothing is
    // downloaded or run until the user approves, so routing here cannot install anything.
    expect(parseInstallRequest('install nmap')).toMatchObject({ package: 'nmap' })
    expect(parseInstallRequest('can you install wireshark for me')).toMatchObject({ package: 'wireshark' })
    expect(parseInstallRequest('download and install 7zip.7zip')).toMatchObject({ package: '7zip.7zip' })
    expect(parseInstallRequest('I need python installed')).toMatchObject({ package: 'python' })
    const step = AgentLoop.getHardcodedFirstStep('install nmap')
    expect(step?.tool).toBe('setup.proposeInstall')
    expect(step?.params.package).toBe('nmap')
    expect(step?.params.task).toBe('install nmap')
    expect(looksLikeAgentTask('install nmap')).toBe(true)
  })

  it('does not treat a VM, a state question, or prose as a package install', () => {
    expect(parseInstallRequest('is nmap installed?')).toBeNull()
    expect(parseInstallRequest('do you have docker installed')).toBeNull()
    expect(parseInstallRequest('what\'s installed on this machine')).toBeNull()
    expect(parseInstallRequest('set up a virtual machine for recon')).toBeNull()
    expect(parseInstallRequest('install confidence in the team')).toBeNull() // trailing prose, not a package
    expect(parseInstallRequest('install the app')).toBeNull() // "app" → NOT_A_PACKAGE
    expect(parseInstallRequest('install it')).toBeNull()
  })

  it('starts self-fix by searching Goga\'s own source for the named symbol', () => {
    // selfwork.apply is critical + gated, so the first step only READS the source; nothing is
    // written without approval. The point is proposing from real code, not from memory.
    expect(parseSelfFixRequest('fix this bug in your code: parseWingetShow returns null')).toMatchObject({ term: 'parseWingetShow' })
    expect(parseSelfFixRequest('debug your own code, the file src/main/services/replyHonesty.ts')).toMatchObject({ term: 'src/main/services/replyHonesty.ts' })
    expect(parseSelfFixRequest('fix your bug where it says "Cannot read property of undefined"')).toMatchObject({ term: 'Cannot read property of undefined' })
    expect(parseSelfFixRequest('fix your own parseAppControl function')).toMatchObject({ term: 'parseAppControl' })
    const step = AgentLoop.getHardcodedFirstStep('fix this bug in your code: parseWingetShow returns null')
    expect(step?.tool).toBe('selfwork.search')
    expect(step?.params.query).toBe('parseWingetShow')
    expect(looksLikeAgentTask('fix this bug in your code: parseWingetShow is not a function')).toBe(true)
  })

  it('does not treat help with the user\'s own code as editing Goga\'s source', () => {
    // No self-reference → not a self-fix. These must fall through so the planner (or ordinary
    // coding help) handles them, never Goga editing its own source.
    expect(parseSelfFixRequest('fix this bug in my project')).toBeNull()
    expect(parseSelfFixRequest('can you fix the login form')).toBeNull()
    expect(parseSelfFixRequest('how do I debug a memory leak')).toBeNull()
    // Self-reference but no extractable symbol → routes, but no hardcoded first step (planner drives).
    const vague = parseSelfFixRequest('fix your bugs please')
    expect(vague).not.toBeNull()
    expect(vague?.term).toBeNull()
    expect(AgentLoop.getHardcodedFirstStep('fix your bugs please')).toBeNull()
  })
})
