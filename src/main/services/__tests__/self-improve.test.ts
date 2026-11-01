import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { GAP_QUESTION, GapJournal, gapFromAgentEnd, gapFromChat, gapReport, groupGaps, scrubTask, type Gap } from '../gapJournal'
import { SELF_CODE_QUESTION, codeContext, codeKeywords, insideRoot, readSource, searchSource, sourceOverview } from '../selfCode'
import { plannerOffers } from '../agentRouting'

const SRC = path.resolve(__dirname, '../../..')   // the real src folder

describe('gap journal', () => {
  it('turns failed agent runs into gaps, and ignores success and user stops', () => {
    expect(gapFromAgentEnd('install the alpaca package', 'error', 'unknown_tool: terminal', '')).toEqual(expect.objectContaining({ kind: 'missing-tool', tool: 'terminal' }))
    expect(gapFromAgentEnd('do it', 'error', 'planning_failed: invalid planner response', '')?.kind).toBe('planning-failed')
    expect(gapFromAgentEnd('open site', 'error', 'duplicate_action: browser.open', 'x')?.kind).toBe('looping')
    expect(gapFromAgentEnd('big job', 'error', 'max_steps_reached', 'x')?.kind).toBe('too-long')
    expect(gapFromAgentEnd('task', 'done', undefined, 'ok')).toBeNull()
    expect(gapFromAgentEnd('task', 'stopped', undefined, 'Stopped.')).toBeNull()
  })

  it('keeps only the request, not the agreed plan, and scrubs secrets and long numbers', () => {
    const g = gapFromAgentEnd('book a table\n\nPlan agreed with Ace: open the site...', 'error', 'max_steps_reached', '')
    expect(g?.task).toBe('book a table')
    expect(scrubTask('use key sk-abcdefghijklmnop and card 4111111111111111')).toBe('use key [key] and card [number]')
    expect(scrubTask('my email is me.name@example.com')).toBe('my email is [email]')
  })

  it('notices "I can\'t" in chat, but not refusals that are rules', () => {
    expect(gapFromChat('send an sms to mom', "Sure. I can't send text messages from this PC yet.")?.detail).toMatch(/can't send text/)
    expect(gapFromChat('trade with real money', "I can't use a live account — only paper.")).toBeNull()
    expect(gapFromChat('hello', 'Hi! How are you?')).toBeNull()
  })

  it('groups gaps and ranks the most frequent first', () => {
    const t = '2026-11-01T10:00:00Z'
    const gaps: Gap[] = [
      { kind: 'missing-tool', tool: 'terminal', task: 'install alpaca', detail: '', time: t },
      { kind: 'missing-tool', tool: 'terminal', task: 'run pip', detail: '', time: t },
      { kind: 'cant-do', task: 'send sms to mom', detail: '', time: t },
    ]
    const groups = groupGaps(gaps)
    expect(groups[0]).toEqual(expect.objectContaining({ kind: 'missing-tool', key: 'terminal', count: 2 }))
    const report = gapReport(gaps, new Date('2026-11-02T00:00:00Z'))
    expect(report).toMatch(/3 things I couldn't do/)
    expect(report).toMatch(/"terminal" tool/)
    expect(gapReport([], new Date())).toMatch(/haven't run into anything/)
  })

  it('records to a file and reports weekly only with enough new gaps', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaps-'))
    let now = new Date('2026-11-01T00:00:00Z')
    const j = new GapJournal(path.join(dir, 'gaps.json'), () => now)
    expect(j.weeklyReport()).toBeNull()                       // starts the clock
    for (let i = 0; i < 3; i++) j.record({ kind: 'cant-do', task: `task ${i}`, detail: '' })
    expect(j.all()).toHaveLength(3)
    now = new Date('2026-11-05T00:00:00Z')
    expect(j.weeklyReport()).toBeNull()                       // not a week yet
    now = new Date('2026-11-09T00:00:00Z')
    expect(j.weeklyReport()).toMatch(/3 things/)
    now = new Date('2026-11-17T00:00:00Z')
    expect(j.weeklyReport()).toBeNull()                       // nothing new
  })

  it('recognises questions about what Goga needs', () => {
    for (const q of ['what tools do you need?', "what couldn't you do this week", 'show me your gap report', 'how can I improve you']) expect(GAP_QUESTION.test(q)).toBe(true)
    expect(GAP_QUESTION.test('what tools do I need to build a ring')).toBe(false)
  })
})

describe('self-reading', () => {
  it('searches and reads its own source', () => {
    const hits = searchSource(SRC, 'class TradeWatcher')
    expect(hits[0].file).toBe('main/services/trading/tradeWatcher.ts')
    const r = readSource(SRC, hits[0].file, hits[0].line, 3)
    expect(r.text).toMatch(/class TradeWatcher/)
    expect(r.to - r.from).toBe(2)
    expect(readSource(SRC, 'src/main/tools/clock.ts').text).toMatch(/clock\.now/)
  })

  it('never reads outside src or non-source files', () => {
    expect(() => insideRoot(SRC, '../.env')).toThrow(/outside/)
    expect(() => readSource(SRC, '../package.json')).toThrow()
    expect(() => searchSource(SRC, 'a')).toThrow()
  })

  it('maps itself and finds the code a question is about', () => {
    expect(sourceOverview(SRC)).toMatch(/main\/services\/trading\/: .*autoTrader\.ts/)
    expect(codeKeywords('how does your trade watcher work?')).toEqual(['trade', 'watcher'])
    const ctx = codeContext(SRC, 'how does your trade watcher work', 5000)
    expect(ctx.files[0]).toBe('src/main/services/trading/tradeWatcher.ts')
    expect(ctx.text.length).toBeLessThanOrEqual(5000)
  })

  it('routes questions about its own code, and offers self tools only for self tasks', () => {
    expect(SELF_CODE_QUESTION.test('analyze your code and tell me what is weak')).toBe(true)
    expect(SELF_CODE_QUESTION.test('how is your wake word built')).toBe(true)
    expect(SELF_CODE_QUESTION.test('fix the code in my project')).toBe(false)
    expect(plannerOffers('look through your own code for the trade watcher')('self.search')).toBe(true)
    expect(plannerOffers('open notepad')('self.search')).toBe(false)
    expect(plannerOffers('open notepad')('clock.now')).toBe(true)
  })
})
