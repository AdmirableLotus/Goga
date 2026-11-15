import { ToolRegistry, type ToolContext } from './registry'
import { ResearchAdapter, type ResearchHit } from '../adapters/research'
import { foregroundText } from '../services/backgroundChat'

const reg = ToolRegistry.getInstance()

/**
 * The research adapter is wired to the tools that already exist rather than to its own
 * network code: `web.search` and `web.fetch` own the DuckDuckGo query, the readable-text
 * extraction and the redirect handling, and `foregroundText` is the same local-model path
 * the rest of Goga's research features use. Nothing here reaches the network directly.
 *
 * The deps are built per call so the task's abort signal reaches the nested tool calls:
 * Stop must cancel a research run the same way it cancels any other step.
 */
function adapterFor(ctx: ToolContext): ResearchAdapter {
  return new ResearchAdapter({
    search: async (query, maxResults) => {
      const r = await reg.execute('web.search', { query, maxResults }, { abortSignal: ctx.abortSignal })
      if (!r.success) throw new Error(r.error || 'web search failed')
      return (r.data as ResearchHit[]) ?? []
    },
    fetch: async (url, maxChars) => {
      const r = await reg.execute('web.fetch', { url, maxChars }, { abortSignal: ctx.abortSignal })
      if (!r.success) throw new Error(r.error || 'page fetch failed')
      return r.data as { url: string; content: string; truncated: boolean }
    },
    complete: (system, user, maxTokens) => foregroundText(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      maxTokens
    )
  })
}

reg.register({
  name: 'research.search',
  description: 'Search the web and return titles, URLs and snippets. Same index as web.search, shaped for research work.',
  parameters: {
    type: 'object',
    properties: {
      query:      { type: 'string', description: 'What to search for.' },
      maxResults: { type: 'number', description: 'How many results. Default: 8, max 10.' }
    },
    required: ['query']
  },
  riskLevel: 'low', reversible: true, category: 'web'
}, async (p, ctx) => {
  try {
    return { success: true, data: await adapterFor(ctx).search(p.query as string, p.maxResults as number | undefined) }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

reg.register({
  name: 'research.summarize',
  description: 'Read one web page and summarise it with the local model: a short summary plus key points. Long pages are summarised in parts and merged. Use after research.search or web.search.',
  parameters: {
    type: 'object',
    properties: {
      url:   { type: 'string', description: 'The http(s) page to read and summarise.' },
      focus: { type: 'string', description: 'Optional. What the summary should concentrate on.' }
    },
    required: ['url']
  },
  riskLevel: 'low', reversible: true, category: 'web'
}, async (p, ctx) => {
  try {
    return { success: true, data: await adapterFor(ctx).summarize(p.url as string, p.focus as string | undefined) }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

reg.register({
  name: 'research.brief',
  description: 'Answer a research question end to end: search the web, read the top pages, summarise each, and write a cited answer. Slower than a single search; use it when the user wants an answer rather than links.',
  parameters: {
    type: 'object',
    properties: {
      query:   { type: 'string', description: 'The question to answer.' },
      sources: { type: 'number', description: 'How many pages to read. Default: 3, max 5.' }
    },
    required: ['query']
  },
  riskLevel: 'low', reversible: true, category: 'web'
}, async (p, ctx) => {
  try {
    return { success: true, data: await adapterFor(ctx).brief(p.query as string, p.sources as number | undefined) }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})
