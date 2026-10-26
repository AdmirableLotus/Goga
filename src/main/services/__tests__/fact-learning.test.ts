import { describe, expect, it, vi } from 'vitest'
import type { GogaFact } from '../../../shared/types'
import { FactLearner, parseLearnedFacts, worthLearningFrom } from '../factLearning'

const known = (content: string): GogaFact => ({ id: content, category: 'about_user', content, source: 'conversation', createdAt: 0 })

function learner(reply: string, existing: GogaFact[] = []) {
  const deps = {
    chat: vi.fn(async () => reply),
    knownFacts: vi.fn(async () => existing),
    addFact: vi.fn(),
    userName: () => 'Ace',
    log: { info: vi.fn(), warn: vi.fn() },
  }
  return { deps, learner: new FactLearner(deps) }
}

describe('worthLearningFrom', () => {
  it('only asks the brain when the user talks about themself', () => {
    expect(worthLearningFrom('My mom lives in Kyiv and visits in June')).toBe(true)
    expect(worthLearningFrom("I'm a nurse on night shifts")).toBe(true)
    expect(worthLearningFrom('remember that the dentist is on Friday')).toBe(true)
    expect(worthLearningFrom('open google.com')).toBe(false)
    expect(worthLearningFrom('what is the weather in Paris?')).toBe(false)
    expect(worthLearningFrom('hi')).toBe(false)
  })
})

describe('parseLearnedFacts', () => {
  it('keeps valid facts and drops malformed, oversized or secret ones', () => {
    const raw = JSON.stringify({ facts: [
      { category: 'about_user', content: "Ace's mom lives in Kyiv." },
      { category: 'preference', content: '  Ace   prefers short answers. ' },
      { category: 'learned', content: 'Wrong category is dropped.' },
      { category: 'about_user', content: 'Ace' },
      { category: 'about_user', content: "Ace's email password is hunter2." },
      { category: 'event', content: 'x'.repeat(250) },
    ] })
    expect(parseLearnedFacts(raw)).toEqual([
      { category: 'about_user', content: "Ace's mom lives in Kyiv." },
      { category: 'preference', content: 'Ace prefers short answers.' },
    ])
  })

  it('accepts a fenced reply and rejects non-JSON', () => {
    expect(parseLearnedFacts('```json\n{"facts":[{"category":"event","content":"Ace has a dentist visit on Friday."}]}\n```')).toHaveLength(1)
    expect(parseLearnedFacts("User's name is hoping")).toEqual([])
    expect(parseLearnedFacts('{"facts":"none"}')).toEqual([])
  })
})

describe('FactLearner', () => {
  it('saves what the brain extracts, skipping facts it already knows', async () => {
    const { deps, learner: l } = learner(JSON.stringify({ facts: [
      { category: 'about_user', content: "Ace's mom lives in Kyiv." },
      { category: 'about_user', content: 'Ace works night shifts as a nurse.' },
    ] }), [known('Ace works night shifts as a nurse.')])
    const saved = await l.learnFrom("My mom lives in Kyiv, and as you know I'm a night-shift nurse")
    expect(saved).toEqual([{ category: 'about_user', content: "Ace's mom lives in Kyiv." }])
    expect(deps.addFact).toHaveBeenCalledOnce()
    // The prompt lists what is already known so the brain doesn't repeat it.
    expect(deps.chat.mock.calls[0][0][0].content).toContain('- Ace works night shifts as a nurse.')
  })

  it("does not invent a name from \"I'm hoping\" (the old pattern's bug) when the brain finds nothing", async () => {
    const { deps, learner: l } = learner('{"facts":[]}')
    expect(await l.learnFrom("I'm hoping you can open notepad for me")).toEqual([])
    expect(deps.addFact).not.toHaveBeenCalled()
  })

  it('never throws and skips while a previous extraction is still running', async () => {
    const { deps, learner: l } = learner('')
    deps.chat.mockRejectedValueOnce(new Error('local brain not ready'))
    await expect(l.learnFrom('I love hiking on weekends')).resolves.toEqual([])
    expect(deps.log.warn).toHaveBeenCalled()

    let release!: (v: string) => void
    deps.chat.mockImplementationOnce(() => new Promise(r => { release = r }))
    const first = l.learnFrom('I love hiking on weekends')
    await vi.waitFor(() => expect(deps.chat).toHaveBeenCalledTimes(2))
    expect(await l.learnFrom('My cat is called Mochi')).toEqual([])   // busy → skipped
    release('{"facts":[]}')
    await first
  })
})
