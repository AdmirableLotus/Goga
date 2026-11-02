import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Scheduler, describeSchedule, nextRunAfter, parseSchedule, SCHEDULE_LIST, SCHEDULE_TASK_COMMAND, SCHEDULE_STOP_ALL, type SchedulerDeps } from '../scheduler'

// Goga setting up recurring tasks for himself: "every hour check alpaca".

describe('reading a schedule from chat', () => {
  it('understands intervals and pulls out the request', () => {
    expect(parseSchedule('every hour check alpaca')).toEqual({ request: 'check alpaca', kind: 'task', everyMinutes: 60, dailyAt: undefined })
    expect(parseSchedule('goga, show me the market news every 2 hours')).toMatchObject({ request: 'show me the market news', everyMinutes: 120 })
    expect(parseSchedule('can you set up a task to check my trading journal every 30 minutes?')).toMatchObject({ request: 'check my trading journal', everyMinutes: 30 })
    expect(parseSchedule('hourly: news on AAPL')).toMatchObject({ request: 'news on AAPL', everyMinutes: 60 })
  })

  it('understands times of day', () => {
    expect(parseSchedule('every day at 9am give me the crypto news')).toMatchObject({ request: 'give me the crypto news', dailyAt: '09:00', everyMinutes: undefined })
    expect(parseSchedule('every morning show my account')).toMatchObject({ request: 'show my account', dailyAt: '08:00' })
    expect(parseSchedule('daily at 6:30 pm check alpaca')).toMatchObject({ dailyAt: '18:30' })
  })

  it('makes reminders', () => {
    expect(parseSchedule('remind me to stretch every 2 hours')).toEqual({ request: 'stretch', kind: 'reminder', everyMinutes: 120, dailyAt: undefined })
  })

  it('resolves "it" to what was just asked', () => {
    expect(parseSchedule('review it on your own every hour', 'how is alpaca')).toMatchObject({ request: 'how is alpaca', everyMinutes: 60 })
    expect(parseSchedule('do that every day at 8am', 'news on bitcoin')).toMatchObject({ request: 'news on bitcoin', dailyAt: '08:00' })
    expect(parseSchedule('do that every hour')).toBeNull()
  })

  it('ignores facts and questions about the user', () => {
    expect(parseSchedule('I go to the gym every day')).toBeNull()
    expect(parseSchedule('my mom calls every morning')).toBeNull()
    expect(parseSchedule('what happens every hour?')).toBeNull()
    expect(parseSchedule('check alpaca')).toBeNull()
  })

  it('recognizes the commands about the schedule itself', () => {
    expect(SCHEDULE_LIST.test('what are your scheduled tasks')).toBe(true)
    expect(SCHEDULE_LIST.test('show my automated tasks')).toBe(true)
    expect('stop task 2'.match(SCHEDULE_TASK_COMMAND)?.slice(1)).toEqual(['stop', '2'])
    expect('pause task #3'.match(SCHEDULE_TASK_COMMAND)?.slice(1)).toEqual(['pause', '3'])
    expect(SCHEDULE_STOP_ALL.test('stop all scheduled tasks')).toBe(true)
  })
})

describe('schedule wording and timing', () => {
  it('says the schedule plainly', () => {
    expect(describeSchedule({ everyMinutes: 60 })).toBe('every hour')
    expect(describeSchedule({ everyMinutes: 90 })).toBe('every 90 minutes')
    expect(describeSchedule({ dailyAt: '18:30' })).toBe('every day at 6:30 PM')
  })

  it('finds the next daily run, tomorrow when today has passed', () => {
    const at10 = new Date(2026, 10, 2, 10, 0).getTime()
    expect(new Date(nextRunAfter({ dailyAt: '09:00' }, at10)).getDate()).toBe(3)
    expect(new Date(nextRunAfter({ dailyAt: '18:00' }, at10)).getHours()).toBe(18)
  })
})

describe('running scheduled tasks', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
  const setup = (over: Partial<SchedulerDeps> = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-sched-'))
    dirs.push(dir)
    let now = new Date(2026, 10, 2, 10, 0).getTime()
    const deps = { run: vi.fn(async () => ({ ok: true, text: 'value $99,891' })), report: vi.fn(), busy: () => false, now: () => now, ...over }
    const file = path.join(dir, 'scheduled-tasks.json')
    return { s: new Scheduler(file, deps), deps, file, later: (min: number) => { now += min * 60_000 } }
  }

  it('runs a task when due, then schedules the next run', async () => {
    const { s, deps, later } = setup()
    s.add({ request: 'check alpaca', kind: 'task', everyMinutes: 60 }, 'user')
    await s.tick()
    expect(deps.run).not.toHaveBeenCalled()
    later(60)
    await s.tick()
    expect(deps.run).toHaveBeenCalledTimes(1)
    expect(s.list()[0]).toMatchObject({ runs: 1, lastResult: 'value $99,891' })
    await s.tick()
    expect(deps.run).toHaveBeenCalledTimes(1)
  })

  it('waits while Goga is busy', async () => {
    let busy = true
    const { s, deps, later } = setup({ busy: () => busy })
    s.add({ request: 'check alpaca', kind: 'task', everyMinutes: 60 }, 'user')
    later(61)
    await s.tick()
    expect(deps.run).not.toHaveBeenCalled()
    busy = false
    await s.tick()
    expect(deps.run).toHaveBeenCalledTimes(1)
  })

  it('reminds without running anything', async () => {
    const { s, deps, later } = setup()
    s.add({ request: 'stretch', kind: 'reminder', everyMinutes: 120 }, 'user')
    later(120)
    await s.tick()
    expect(deps.run).not.toHaveBeenCalled()
    expect(deps.report).toHaveBeenCalledWith('⏰ Reminder: stretch', true)
  })

  it('pauses a task that keeps failing and says so', async () => {
    const { s, deps, later } = setup({ run: vi.fn(async () => ({ ok: false, text: 'fetch failed' })) })
    s.add({ request: 'check alpaca', kind: 'task', everyMinutes: 15 }, 'goga')
    for (let i = 0; i < 3; i++) { later(15); await s.tick() }
    expect(s.list()[0].paused).toBe(true)
    expect(deps.report).toHaveBeenCalledWith(expect.stringMatching(/paused scheduled task 1[\s\S]*fetch failed/), true)
    later(15); await s.tick()
    expect(deps.run).toHaveBeenCalledTimes(3)
  })

  it('runs a missed task once after the PC was off, not once per missed hour', async () => {
    const { s, deps, later } = setup()
    s.add({ request: 'check alpaca', kind: 'task', everyMinutes: 60 }, 'user')
    later(60 * 10)
    await s.tick(); await s.tick()
    expect(deps.run).toHaveBeenCalledTimes(1)
  })

  it('keeps limits: no tiny intervals, no duplicates', () => {
    const { s } = setup()
    expect(() => s.add({ request: 'check alpaca', kind: 'task', everyMinutes: 5 }, 'goga')).toThrow(/every 15 minutes/)
    const a = s.add({ request: 'check alpaca', kind: 'task', everyMinutes: 60 }, 'user')
    expect(s.add({ request: 'Check Alpaca', kind: 'task', everyMinutes: 60 }, 'goga')).toBe(a)
    expect(s.list()).toHaveLength(1)
  })

  it('keeps tasks across restarts, and removes them', () => {
    const { s, file, deps } = setup()
    s.add({ request: 'check alpaca', kind: 'task', everyMinutes: 60 }, 'user')
    s.add({ request: 'news on AAPL', kind: 'task', dailyAt: '09:00' }, 'goga')
    const again = new Scheduler(file, deps)
    expect(again.list().map(t => t.id)).toEqual([1, 2])
    expect(again.summary()).toMatch(/2\. news on AAPL — every day at 9:00 AM.*I set this up myself/)
    again.remove(1)
    expect(new Scheduler(file, deps).list().map(t => t.request)).toEqual(['news on AAPL'])
  })
})
