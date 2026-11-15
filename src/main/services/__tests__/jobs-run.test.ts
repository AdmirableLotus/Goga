import { describe, expect, it } from 'vitest'
import type { Job } from '../../../shared/jobs'
import { JobsManager, answerIsYes, shortText } from '../jobs/manager'
import { MemoryStore } from '../jobs/store'
import { newJob, applyEvent } from '../jobs/state'
import { parseStep, redactParams, runJob, stepHistory } from '../jobs/worker'

/**
 * The worker and the manager together: a job that runs, a job that asks and waits, a job that
 * hits the cap, a job that fails honestly, and a job that is canceled mid-flight.
 *
 * The brain and the tools are fakes, but the queue, the state machine, the approval gate and
 * the report are the real code the app runs.
 */

const T0 = 1_700_000_000_000

/** A planner that reads from a script, one step per call. */
function scriptedPlan(script: string[]) {
  let i = 0
  return async () => script[Math.min(i++, script.length - 1)]
}

function baseJob(over: Partial<Job> = {}): Job {
  return { ...newJob({ id: 'job-x', title: 'A job', goal: 'Do a thing with several parts', now: T0 }), state: 'running', startedAt: T0, ...over }
}

describe('reading the planner’s step', () => {
  it('takes a tool step, a finish and a question apart', () => {
    expect(parseStep('{"thought":"t","tool":"web.search","params":{"query":"x"}}')).toMatchObject({ tool: 'web.search', params: { query: 'x' } })
    expect(parseStep('{"thought":"t","done":true,"reply":"did it"}')).toMatchObject({ done: true, reply: 'did it' })
    expect(parseStep('{"thought":"t","ask":{"kind":"credential","text":"which key?"}}')).toMatchObject({ ask: { kind: 'credential', text: 'which key?' } })
  })

  it('tolerates a fenced block and trailing prose, and refuses anything else', () => {
    expect(parseStep('```json\n{"tool":"clock.now","params":{}}\n```')).toMatchObject({ tool: 'clock.now' })
    expect(parseStep('Sure! Here is my plan: {"tool":"clock.now","params":{}} — that should do it.')).toMatchObject({ tool: 'clock.now' })
    expect(parseStep('I would search the web.')).toBeNull()
    expect(parseStep('{"thought":"nothing else"}')).toBeNull()
  })

  it('takes anything that looks like a secret out of the step it stores', () => {
    const p = redactParams({ apiKey: 'sk-live-1', password: 'hunter2', query: 'x', body: 'y'.repeat(500) })
    expect(p.apiKey).toBe('[redacted]')
    expect(p.password).toBe('[redacted]')
    expect(p.query).toBe('x')
    expect(String(p.body)).toContain('500 chars')
  })
})

describe('a worker running a job', () => {
  it('records every step and ends with a report that names the failure', async () => {
    const steps: Job['steps'] = []
    const result = await runJob(baseJob(), {
      plan: scriptedPlan([
        '{"thought":"look","tool":"web.search","params":{"query":"testers"}}',
        '{"thought":"write","tool":"filesystem.write","params":{"path":"C:\\\\out\\\\plan.md","content":"x"}}',
        '{"thought":"done","done":true,"reply":"Found candidates and wrote the plan."}',
      ]),
      toolBlock: () => '- web.search(query)',
      execute: async tool => tool === 'web.search'
        ? { ok: true, detail: 'found 5 pages' }
        : { ok: true, detail: 'wrote 12 bytes', files: ['C:\\out\\plan.md'] },
      ask: async () => { throw new Error('this job should not ask') },
      save: j => { steps.length = 0; steps.push(...j.steps) },
      signal: new AbortController().signal,
      canceled: () => false,
      now: () => T0,
    })
    expect(result.state).toBe('done')
    expect(result.steps.map(s => s.tool)).toEqual(['web.search', 'filesystem.write'])
    expect(result.report?.result).toContain('Found candidates and wrote the plan.')
    expect(result.report?.files).toEqual(['C:\\out\\plan.md'])
    expect(result.report?.notDone).toEqual([])
  })

  it('reports a failed tool as not done, and still finishes', async () => {
    const result = await runJob(baseJob(), {
      plan: scriptedPlan([
        '{"thought":"send","tool":"business.approve","params":{}}',
        '{"thought":"done","done":true,"reply":"Everything else is ready."}',
      ]),
      toolBlock: () => '- business.approve()',
      execute: async () => ({ ok: false, detail: 'you did not approve this, so nothing was sent' }),
      ask: async () => null,
      save: () => {},
      signal: new AbortController().signal,
      canceled: () => false,
      now: () => T0,
    })
    expect(result.state).toBe('done')
    expect(result.report?.notDone.join(' ')).toContain('business.approve did not work')
    expect(result.report?.operations[0]).toMatch(/^failed/)
  })

  it('says plainly when it used all its steps without finishing', async () => {
    const result = await runJob(baseJob({ bounds: { maxSteps: 2, maxMinutes: 30 } }), {
      plan: scriptedPlan(['{"thought":"again","tool":"clock.now","params":{}}']),
      toolBlock: () => '- clock.now()',
      execute: async () => ({ ok: true, detail: 'noon' }),
      ask: async () => null,
      save: () => {},
      signal: new AbortController().signal,
      canceled: () => false,
      now: () => T0,
    })
    expect(result.state).toBe('failed')
    expect(result.error).toContain('step limit')
    expect(result.report?.notDone.join(' ')).toContain('used all 2 steps')
    expect(result.report?.operations).toHaveLength(2)
  })

  it('stops when the time limit passes, even mid-run', async () => {
    let clock = T0
    const result = await runJob(baseJob({ bounds: { maxSteps: 50, maxMinutes: 1 } }), {
      plan: async () => {
        clock += 40_000
        return '{"thought":"again","tool":"clock.now","params":{}}'
      },
      toolBlock: () => '- clock.now()',
      execute: async () => ({ ok: true, detail: 'noon' }),
      ask: async () => null,
      save: () => {},
      signal: new AbortController().signal,
      canceled: () => false,
      now: () => clock,
    })
    expect(result.state).toBe('failed')
    expect(result.error).toContain('time limit')
    expect(result.report?.notDone.join(' ')).toContain('1-minute limit')
  })

  it('cancels cleanly when the user stops it while it is thinking', async () => {
    let canceled = false
    const job = baseJob()
    const result = await runJob(job, {
      plan: async () => { canceled = true; return '{"thought":"x","tool":"clock.now","params":{}}' },
      toolBlock: () => '- clock.now()',
      execute: async () => ({ ok: true, detail: 'noon' }),
      ask: async () => null,
      save: () => {},
      signal: new AbortController().signal,
      canceled: () => canceled,
      now: () => T0,
    })
    expect(result.state).toBe('canceled')
  })

  it('reports a planner that cannot be reached instead of pretending it finished', async () => {
    const result = await runJob(baseJob(), {
      plan: async () => { throw new Error('the local brain is not loaded') },
      toolBlock: () => '- clock.now()',
      execute: async () => ({ ok: true, detail: 'noon' }),
      ask: async () => null,
      save: () => {},
      signal: new AbortController().signal,
      canceled: () => false,
      now: () => T0,
    })
    expect(result.state).toBe('failed')
    expect(result.error).toContain('local brain is not loaded')
    expect(result.report?.notDone.join(' ')).toContain('could not be reached')
  })

  it('stops a job that keeps writing the same file, and says so', async () => {
    // The commonest way a small model burns a job's budget: the same write to the same file,
    // over and over. Two goes are allowed (the first may be replaced); the third is stopped.
    const ran: string[] = []
    const result = await runJob(baseJob({ bounds: { maxSteps: 10, maxMinutes: 30 } }), {
      plan: scriptedPlan([
        '{"thought":"write","tool":"filesystem.write","params":{"path":"C:\\\\out\\\\a.txt","content":"one"}}',
        '{"thought":"write again","tool":"filesystem.write","params":{"path":"C:\\\\out\\\\a.txt","content":"two"}}',
        '{"thought":"and again","tool":"filesystem.write","params":{"path":"C:\\\\out\\\\a.txt","content":"three"}}',
        '{"thought":"and again","tool":"filesystem.write","params":{"path":"C:\\\\out\\\\a.txt","content":"four"}}',
      ]),
      toolBlock: () => '- filesystem.write(path, content)',
      execute: async () => { ran.push('filesystem.write'); return { ok: true, detail: 'wrote 3 bytes to C:\\out\\a.txt', files: ['C:\\out\\a.txt'] } },
      ask: async () => null,
      save: () => {},
      signal: new AbortController().signal,
      canceled: () => false,
      now: () => T0,
    })
    expect(ran).toHaveLength(2)
    expect(result.state).toBe('done')
    expect(result.report?.result.join(' ')).toContain('I stopped instead of doing it again')
    expect(result.report?.notDone.join(' ')).toContain('kept repeating filesystem.write')
  })

  it('lets a job read the same thing as often as it needs to', async () => {
    // A lookup has no side effect, so the repeat guard must not touch it.
    const ran: string[] = []
    const result = await runJob(baseJob({ bounds: { maxSteps: 4, maxMinutes: 30 } }), {
      plan: scriptedPlan([
        '{"thought":"look","tool":"web.search","params":{"query":"same"}}',
        '{"thought":"look","tool":"web.search","params":{"query":"same"}}',
        '{"thought":"look","tool":"web.search","params":{"query":"same"}}',
        '{"thought":"done","done":true,"reply":"Found it."}',
      ]),
      toolBlock: () => '- web.search(query)',
      execute: async () => { ran.push('web.search'); return { ok: true, detail: 'found 3' } },
      ask: async () => null,
      save: () => {},
      signal: new AbortController().signal,
      canceled: () => false,
      now: () => T0,
    })
    expect(ran).toHaveLength(3)
    expect(result.state).toBe('done')
  })

  it('shows the newest steps in the prompt, not the whole history', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ index: i, thought: '', tool: 't', params: {}, ok: true, detail: `d${i}`, at: T0 }))
    const text = stepHistory(many, 3)
    expect(text).not.toContain('d16')
    expect(text).toContain('d19')
    expect(text.split('\n')).toHaveLength(3)
  })
})

// ── the manager ──────────────────────────────────────────────────────────────

function makeManager(opts: {
  script: string[]
  gate?: Partial<{ allowed: boolean; requiresApproval: boolean; reason: string }>
  run?: (tool: string) => { success: boolean; data?: unknown; error?: string }
  cap?: number
}) {
  const store = new MemoryStore()
  const notes: string[] = []
  const manager = new JobsManager({
    store,
    tools: {
      definition: name => ({ name, riskLevel: 'low' }),
      decide: () => ({ allowed: true, requiresApproval: false, reason: 'read-only', ...(opts.gate ?? {}) }),
      run: async tool => (opts.run ? opts.run(tool) : { success: true, data: `${tool} ok` }),
    },
    plan: scriptedPlan(opts.script),
    toolBlock: () => '- clock.now()',
    notify: text => notes.push(text),
    publish: () => {},
    now: () => T0,
  }, opts.cap ?? 2)
  return { manager, store, notes }
}

const until = async (check: () => boolean, ms = 3000) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting')
    await new Promise(r => setTimeout(r, 5))
  }
}

describe('the job manager', () => {
  it('creates a job, runs it, and leaves it done with a report', async () => {
    const { manager, notes, store } = makeManager({ script: ['{"thought":"x","tool":"clock.now","params":{}}', '{"thought":"done","done":true,"reply":"All done."}'] })
    manager.start()
    const job = manager.create({ goal: 'Do a thing with several parts' })
    await until(() => manager.get(job.id)?.state === 'done')
    const done = manager.get(job.id)!
    expect(done.report?.result).toContain('All done.')
    expect(done.steps).toHaveLength(1)
    expect(notes.join(' ')).toContain('Job done')
    // Every state change went to the journal.
    expect(store.lines.join('\n')).toContain('created')
    expect(store.lines.join('\n')).toContain('running')
    expect(store.lines.join('\n')).toContain('done')
  })

  it('stops to ask, holds the job in "waiting", and carries on with the answer', async () => {
    const { manager, notes } = makeManager({
      script: [
        '{"thought":"need a key","ask":{"kind":"credential","text":"Which Alpaca account should I use?"}}',
        '{"thought":"done","done":true,"reply":"Used the paper account."}',
      ],
    })
    manager.start()
    const job = manager.create({ goal: 'Set up the trading job' })
    await until(() => manager.get(job.id)?.state === 'waiting')

    const waiting = manager.get(job.id)!
    expect(waiting.question?.text).toBe('Which Alpaca account should I use?')
    expect(waiting.question?.kind).toBe('credential')
    expect(notes.join(' ')).toContain('Which Alpaca account should I use?')

    manager.answer(job.id, 'the paper one')
    await until(() => manager.get(job.id)?.state === 'done')
    const done = manager.get(job.id)!
    expect(done.question?.answer).toBe('the paper one')
    expect(done.report?.result).toContain('Used the paper account.')
    // The question and the answer are both in the step record.
    expect(done.steps.map(s => s.tool)).toContain('ask the user')
    expect(done.steps.map(s => s.detail).join(' ')).toContain('you answered: the paper one')
  })

  it('refuses an answer to a job that is not waiting, and an empty answer', async () => {
    const { manager } = makeManager({ script: ['{"thought":"done","done":true,"reply":"fine"}'] })
    manager.start()
    const job = manager.create({ goal: 'Small job, needs nothing' })
    await until(() => manager.get(job.id)?.state === 'done')
    expect(() => manager.answer(job.id, 'yes')).toThrow(/not waiting/)
    await expect((async () => manager.answer('no-such-job', 'yes'))()).rejects.toThrow(/no such job/)
  })

  it('turns a guarded tool into a question, and does not run it without a yes', async () => {
    const ran: string[] = []
    const { manager } = makeManager({
      script: [
        '{"thought":"delete it","tool":"filesystem.delete","params":{"path":"C:\\\\x.txt"}}',
        '{"thought":"done","done":true,"reply":"I did not delete it."}',
      ],
      gate: { allowed: true, requiresApproval: true, reason: 'filesystem.delete always requires approval' },
      run: tool => { ran.push(tool); return { success: true, data: 'deleted' } },
    })
    manager.start()
    const job = manager.create({ goal: 'Clean up a file' })
    await until(() => manager.get(job.id)?.state === 'waiting')
    expect(manager.get(job.id)!.question?.kind).toBe('approval')
    expect(manager.get(job.id)!.question?.text).toContain('filesystem.delete')

    manager.answer(job.id, 'no')
    await until(() => manager.get(job.id)?.state === 'done')
    // The tool never ran, and the report says so.
    expect(ran).toEqual([])
    expect(manager.get(job.id)!.report?.notDone.join(' ')).toContain('did not approve')
  })

  it('marks a job that used all its steps as failed, with its steps and its report kept', async () => {
    const { manager } = makeManager({
      script: ['{"thought":"look again","tool":"clock.now","params":{}}'],
    })
    manager.start()
    const job = manager.create({ goal: 'A job that never finishes', bounds: { maxSteps: 3, maxMinutes: 30 } })
    await until(() => manager.get(job.id)?.state === 'failed')
    const failed = manager.get(job.id)!
    expect(failed.error).toContain('step limit')
    expect(failed.steps).toHaveLength(3)
    expect(failed.report?.notDone.join(' ')).toContain('used all 3 steps')
  })

  it('runs the guarded tool once the exact call is approved', async () => {
    const ran: string[] = []
    const { manager } = makeManager({
      script: [
        '{"thought":"delete it","tool":"filesystem.delete","params":{"path":"C:\\\\x.txt"}}',
        '{"thought":"done","done":true,"reply":"Deleted it."}',
      ],
      gate: { allowed: true, requiresApproval: true, reason: 'always requires approval' },
      run: tool => { ran.push(tool); return { success: true, data: 'deleted' } },
    })
    manager.start()
    const job = manager.create({ goal: 'Clean up a file' })
    await until(() => manager.get(job.id)?.state === 'waiting')
    manager.answer(job.id, 'yes, do it')
    await until(() => manager.get(job.id)?.state === 'done')
    expect(ran).toEqual(['filesystem.delete'])
  })

  it('never runs a tool the authorization service blocks', async () => {
    const ran: string[] = []
    const { manager } = makeManager({
      script: [
        '{"thought":"try","tool":"security.probe","params":{}}',
        '{"thought":"done","done":true,"reply":"It was refused."}',
      ],
      gate: { allowed: false, requiresApproval: false, reason: 'that target is out of scope' },
      run: tool => { ran.push(tool); return { success: true } },
    })
    manager.start()
    const job = manager.create({ goal: 'Probe a target' })
    await until(() => manager.get(job.id)?.state === 'done')
    expect(ran).toEqual([])
    expect(manager.get(job.id)!.report?.notDone.join(' ')).toContain('out of scope')
  })

  it('holds a third job at the cap, then starts it when a slot frees up', async () => {
    const { manager } = makeManager({
      cap: 1,
      script: ['{"thought":"x","tool":"clock.now","params":{}}', '{"thought":"done","done":true,"reply":"ok"}'],
    })
    manager.start()
    const a = manager.create({ goal: 'First job to run' })
    const b = manager.create({ goal: 'Second job to run' })
    await until(() => manager.get(a.id)?.state === 'done')
    await until(() => manager.get(b.id)?.state === 'done')
    expect(manager.view().cap).toBe(1)
  })

  it('keeps the queue honest when the cap is reached', async () => {
    const store = new MemoryStore()
    const notes: string[] = []
    const manager = new JobsManager({
      store,
      tools: {
        definition: name => ({ name, riskLevel: 'low' }),
        decide: () => ({ allowed: true, requiresApproval: false, reason: 'read-only' }),
        run: async () => ({ success: true, data: 'ok' }),
      },
      // Never finishes: stays "running" for the length of this test.
      plan: () => new Promise<string>(() => {}),
      toolBlock: () => '',
      notify: t => notes.push(t),
      publish: () => {},
      now: () => T0,
    }, 1)
    manager.start()
    manager.create({ goal: 'A long job that keeps running' })
    manager.create({ goal: 'Another one waiting its turn' })
    await until(() => manager.view().running === 1)
    const view = manager.view()
    expect(view.queued).toBe(1)
    expect(notes.join(' ')).toContain('queued')
    manager.shutdown()
  })

  it('cancels a running job, keeps its steps and writes a report saying it was stopped', async () => {
    let calls = 0
    const store = new MemoryStore()
    const manager = new JobsManager({
      store,
      tools: {
        definition: name => ({ name, riskLevel: 'low' }),
        decide: () => ({ allowed: true, requiresApproval: false, reason: 'read-only' }),
        run: async () => ({ success: true, data: 'noon' }),
      },
      // One real step, then it hangs — exactly like a job waiting on a slow model.
      plan: () => {
        calls++
        if (calls === 1) return Promise.resolve('{"thought":"x","tool":"clock.now","params":{}}')
        return new Promise<string>(() => {})
      },
      toolBlock: () => '- clock.now()',
      notify: () => {},
      publish: () => {},
      now: () => T0,
    }, 2)
    manager.start()
    const job = manager.create({ goal: 'A job the user stops' })
    await until(() => (manager.get(job.id)?.steps.length ?? 0) >= 1)
    manager.cancel(job.id)
    await until(() => manager.get(job.id)?.state === 'canceled')
    const canceled = manager.get(job.id)!
    expect(canceled.report?.result.join(' ')).toContain('You stopped this job')
    expect(canceled.steps.length).toBeGreaterThan(0)
    expect(store.lines.join('\n')).toContain('canceled')
  })

  it('marks a job interrupted on startup and resumes it from where it stopped', async () => {
    const store = new MemoryStore()
    const stuck = applyEvent(
      { ...newJob({ id: 'job-1', title: 'Half done', goal: 'A job that was running', now: T0 }), state: 'queued' },
      { type: 'start' }, T0,
    )
    store.saveAll([{ ...stuck, steps: [{ index: 0, thought: '', tool: 'clock.now', params: {}, ok: true, detail: 'noon', at: T0 }] }])

    const manager = new JobsManager({
      store,
      tools: {
        definition: name => ({ name, riskLevel: 'low' }),
        decide: () => ({ allowed: true, requiresApproval: false, reason: 'read-only' }),
        run: async () => ({ success: true, data: 'ok' }),
      },
      plan: scriptedPlan(['{"thought":"done","done":true,"reply":"Finished after the restart."}']),
      toolBlock: () => '',
      notify: () => {},
      publish: () => {},
      now: () => T0 + 1000,
    }, 2)
    manager.start()

    const loaded = manager.get('job-1')!
    expect(loaded.state).toBe('interrupted')
    expect(loaded.interruptedAt).toBe(T0 + 1000)
    expect(loaded.steps).toHaveLength(1)
    expect(store.lines.join('\n')).toContain('interrupted on startup')

    manager.resume('job-1')
    await until(() => manager.get('job-1')!.state === 'done')
    const done = manager.get('job-1')!
    expect(done.resumedCount).toBe(1)
    // The step it had already done is still there.
    expect(done.steps.map(s => s.tool)).toContain('clock.now')
  })

  it('refuses to resume a job that was not interrupted', async () => {
    const { manager } = makeManager({ script: ['{"thought":"done","done":true,"reply":"ok"}'] })
    manager.start()
    const job = manager.create({ goal: 'A quick job' })
    await until(() => manager.get(job.id)?.state === 'done')
    expect(() => manager.resume(job.id)).toThrow(/only an interrupted job/)
  })

  it('leaves a job interrupted — not failed, not canceled — when Goga closes under it', async () => {
    // The worker sees an abort exactly as it would if the user had stopped it. The board must
    // still say "interrupted", because that is what happened and it can be resumed.
    let calls = 0
    const store = new MemoryStore()
    const manager = new JobsManager({
      store,
      tools: {
        definition: name => ({ name, riskLevel: 'low' }),
        decide: () => ({ allowed: true, requiresApproval: false, reason: 'read-only' }),
        run: async () => ({ success: true, data: 'noon' }),
      },
      plan: () => {
        calls++
        if (calls === 1) return Promise.resolve('{"thought":"x","tool":"clock.now","params":{}}')
        return new Promise<string>(() => {})
      },
      toolBlock: () => '- clock.now()',
      notify: () => {},
      publish: () => {},
      now: () => T0,
    }, 2)
    manager.start()
    const job = manager.create({ goal: 'A job that is running when the app quits' })
    await until(() => (manager.get(job.id)?.steps.length ?? 0) >= 1)

    manager.shutdown('Goga closed')
    await until(() => manager.get(job.id)?.state !== 'running')
    const after = manager.get(job.id)!
    expect(after.state).toBe('interrupted')
    expect(after.interruptedAt).toBe(T0)
    // It kept the step it had recorded, and it is not marked as a failure.
    expect(after.steps).toHaveLength(1)
    expect(after.error).toBeUndefined()

    // A second shutdown (or a late worker exit) must not turn it into a failure either.
    manager.shutdown('Goga closed again')
    expect(manager.get(job.id)!.state).toBe('interrupted')
    expect(store.lines.join('\n')).toContain('interrupted')
  })

  it('lets a job interrupted by shutdown be resumed afterwards', async () => {
    let calls = 0
    const manager = new JobsManager({
      store: new MemoryStore(),
      tools: {
        definition: name => ({ name, riskLevel: 'low' }),
        decide: () => ({ allowed: true, requiresApproval: false, reason: 'read-only' }),
        run: async () => ({ success: true, data: 'noon' }),
      },
      plan: () => {
        calls++
        if (calls === 1) return Promise.resolve('{"thought":"x","tool":"clock.now","params":{}}')
        return new Promise<string>(() => {})
      },
      toolBlock: () => '',
      notify: () => {},
      publish: () => {},
      now: () => T0,
    }, 2)
    manager.start()
    const job = manager.create({ goal: 'A job the user stops' })
    await until(() => (manager.get(job.id)?.steps.length ?? 0) >= 1)
    manager.shutdown('Goga closed')
    // shutdown() aborts the worker; the user's own cancel is what turns it into "canceled".
    expect(manager.get(job.id)!.state).toBe('interrupted')
    expect(() => manager.resume(job.id)).not.toThrow()
  })

  it('answers a yes only when it means yes', () => {
    expect(answerIsYes('yes')).toBe(true)
    expect(answerIsYes('Yes, do it')).toBe(true)
    expect(answerIsYes('approve')).toBe(true)
    expect(answerIsYes('no')).toBe(false)
    expect(answerIsYes('not now')).toBe(false)
    expect(answerIsYes('')).toBe(false)
    // Unclear is not a yes, so nothing runs on a guess.
    expect(answerIsYes('maybe later?')).toBe(false)
  })

  it('writes one readable line from a tool result', () => {
    expect(shortText({ readable: 'wrote 3 files' })).toBe('wrote 3 files')
    expect(shortText('  a   b  ')).toBe('a b')
    expect(shortText(null)).toBe('done')
    expect(shortText({ a: 1 })).toBe('{"a":1}')
  })
})
