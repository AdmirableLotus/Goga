import type { GogaFact } from '../../shared/types'

export interface StoredEmbedding { model: string; vector: number[] }

export interface RecallOptions {
  query: string
  facts: GogaFact[]
  limit: number
  model: string
  /** Embed a batch of texts with the local embedding model. */
  embed: (texts: string[]) => Promise<number[][]>
  /** Cached fact vectors keyed by fact id; missing or stale entries are re-embedded. */
  cache: Record<string, StoredEmbedding>
  /** Called with only the newly computed vectors so the caller can persist them. */
  saveCache: (updates: Record<string, StoredEmbedding>) => void
}

// Calibrated on nomic-embed-text: unrelated query/fact pairs score ~0.34–0.47, real matches
// 0.50+ and stand out from the rest, so require both a floor and closeness to the best match.
const MIN_SIMILARITY = 0.48
const MAX_GAP_FROM_BEST = 0.08

export function keywordScore(query: string, content: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2)
  const text = content.toLowerCase()
  return terms.filter(t => text.includes(t)).length
}

export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/** Rank facts by meaning (embeddings) plus exact keyword hits. Throws if embedding fails,
 *  so the caller can fall back to keyword-only recall. */
export async function recallFacts(opts: RecallOptions): Promise<GogaFact[]> {
  const { query, facts, limit, model, embed, cache, saveCache } = opts
  if (facts.length === 0) return []

  const stale = facts.filter(f => cache[f.id]?.model !== model)
  const texts = [`search_query: ${query}`, ...stale.map(f => `search_document: ${f.content}`)]
  const vectors = await embed(texts)
  if (vectors.length !== texts.length) throw new Error(`embedding returned ${vectors.length} vectors for ${texts.length} inputs`)

  const [queryVec, ...factVecs] = vectors
  const updates: Record<string, StoredEmbedding> = {}
  stale.forEach((f, i) => { updates[f.id] = { model, vector: factVecs[i] } })
  if (stale.length > 0) saveCache(updates)
  const lookup = { ...cache, ...updates }

  const scored = facts.map(f => {
    const similarity = cosine(queryVec, lookup[f.id].vector)
    const keywords = keywordScore(query, f.content)
    return { fact: f, similarity, keywords, score: similarity + 0.1 * keywords }
  })
  const best = Math.max(...scored.map(s => s.similarity))
  const relevant = scored
    .filter(s => s.keywords > 0 || (s.similarity >= MIN_SIMILARITY && s.similarity >= best - MAX_GAP_FROM_BEST))
    .sort((a, b) => b.score - a.score)
    .map(s => s.fact)
  // Facts about the user stay in context even when the query is unrelated, after the relevant ones.
  const aboutUser = facts.filter(f => f.category === 'about_user' && !relevant.includes(f))
  return [...relevant, ...aboutUser].slice(0, limit)
}
