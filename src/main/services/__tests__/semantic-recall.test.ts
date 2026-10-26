import { describe, expect, it, vi } from 'vitest'
import type { GogaFact } from '../../../shared/types'
import { cosine, recallFacts, type StoredEmbedding } from '../semanticRecall'

const fact = (id: string, content: string, category: GogaFact['category'] = 'learned'): GogaFact =>
  ({ id, content, category, source: 'conversation', createdAt: 0 })

// Toy 2-d embedding space: "pets" point along x, "cars" along y.
const VECTORS: Record<string, number[]> = {
  'search_query: how is my puppy': [1, 0],
  'search_document: I have a dog named Rex': [0.9, 0.1],
  'search_document: I drive a Honda': [0, 1],
  'search_document: My name is Ana': [0.1, 0.2],
}
const fakeEmbed = vi.fn(async (texts: string[]) => texts.map(t => VECTORS[t] ?? [0, 0]))

describe('semantic recall', () => {
  it('finds facts by meaning, not just shared words', async () => {
    const facts = [fact('car', 'I drive a Honda'), fact('dog', 'I have a dog named Rex')]
    const result = await recallFacts({ query: 'how is my puppy', facts, limit: 5, model: 'm', embed: fakeEmbed, cache: {}, saveCache: () => {} })
    expect(result.map(f => f.id)).toEqual(['dog'])
  })

  it('keeps facts about the user after the relevant ones', async () => {
    const facts = [fact('name', 'My name is Ana', 'about_user'), fact('dog', 'I have a dog named Rex')]
    const result = await recallFacts({ query: 'how is my puppy', facts, limit: 5, model: 'm', embed: fakeEmbed, cache: {}, saveCache: () => {} })
    expect(result.map(f => f.id)).toEqual(['dog', 'name'])
  })

  it('embeds only facts missing from the cache or made by another model', async () => {
    fakeEmbed.mockClear()
    const facts = [fact('dog', 'I have a dog named Rex'), fact('car', 'I drive a Honda')]
    const cache: Record<string, StoredEmbedding> = { dog: { model: 'm', vector: [0.9, 0.1] }, car: { model: 'old', vector: [5, 5] } }
    const saveCache = vi.fn()
    await recallFacts({ query: 'how is my puppy', facts, limit: 5, model: 'm', embed: fakeEmbed, cache, saveCache })
    expect(fakeEmbed.mock.calls[0][0]).toEqual(['search_query: how is my puppy', 'search_document: I drive a Honda'])
    expect(saveCache).toHaveBeenCalledWith({ car: { model: 'm', vector: [0, 1] } })
  })

  it('throws when the embedder fails so the caller can fall back', async () => {
    const embed = async () => { throw new Error('ollama down') }
    await expect(recallFacts({ query: 'q', facts: [fact('a', 'x')], limit: 5, model: 'm', embed, cache: {}, saveCache: () => {} }))
      .rejects.toThrow('ollama down')
  })

  it('cosine handles mismatched and zero vectors', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosine([1, 0], [1, 0, 0])).toBe(0)
    expect(cosine([0, 0], [1, 0])).toBe(0)
  })
})
