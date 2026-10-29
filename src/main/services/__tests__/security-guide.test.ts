import { afterEach, expect, it, vi } from 'vitest'
import fs from 'fs'
import { inventoryTools, readResearch, researchUrl, searchResearch } from '../securityGuide'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('searches only the fixed search engine and filters untrusted result hosts', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('<a class="result__a" href="https://hackerone.com/reports/123">Public report</a><a class="result__a" href="https://evil.test">Ignore</a>'))
  vi.stubGlobal('fetch', fetcher)
  const results = await searchResearch('idor', 'disclosures')
  expect(results).toHaveLength(1)
  expect(results[0].url).toBe('https://hackerone.com/reports/123')
  expect(new URL(fetcher.mock.calls[0][0]).origin).toBe('https://html.duckduckgo.com')
  await expect(searchResearch('x'.repeat(201), 'programs')).rejects.toThrow('200')
  expect(fetcher).toHaveBeenCalledOnce()
})
it('limits research to fixed learning pages and exact public disclosure paths', () => {
  expect(researchUrl('https://hackerone.com/reports/123')).toContain('/reports/123')
  for (const url of ['https://target.test', 'http://hackerone.com/reports/123', 'https://hackerone.com.evil.test/reports/123', 'https://user:secret@hackerone.com/reports/123', 'https://hackerone.com/reports/123?next=target', 'https://hackerone.com/reports/123/test', 'file:///tmp/test']) expect(() => researchUrl(url)).toThrow()
})
it('captures sources with retrieval dates and never follows redirects', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('<main>Public disclosure content</main>'))
  vi.stubGlobal('fetch', fetcher)
  const result = await readResearch('https://hackerone.com/reports/123')
  expect(result.content).toContain('Public disclosure content')
  expect(Number.isNaN(Date.parse(result.retrievedAt))).toBe(false)
  expect(fetcher.mock.calls[0][1].redirect).toBe('manual')
  fetcher.mockResolvedValue(new Response('', { status: 302, headers: { Location: 'https://target.test' } }))
  await expect(readResearch('https://hackerone.com/reports/123')).rejects.toThrow('302')
  expect(fetcher).toHaveBeenCalledTimes(2)
})
it('rejects oversized research responses', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('a'.repeat(1_000_001))))
  await expect(readResearch('https://hackerone.com/reports/123')).rejects.toThrow('size limit')
})
it('inventories only absolute PATH entries without executing tools', () => {
  const stat = vi.spyOn(fs, 'statSync').mockImplementation((candidate: any) => {
    if (String(candidate).endsWith('curl.exe')) return { isFile: () => true } as any
    throw new Error('not found')
  })
  const tools = inventoryTools('relative;C:\\tools', 'win32')
  expect(tools.find(t => t.name === 'curl')?.status).toBe('Found on PATH')
  expect(tools.find(t => t.name === 'nuclei')?.location).toBeNull()
  expect(tools.every(t => t.version === 'Not executed')).toBe(true)
  expect(stat.mock.calls.every(([p]) => !String(p).startsWith('relative'))).toBe(true)
})
