import { describe, expect, it, vi, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { githubRepoRef, rawGithubUrl, downloadDocument } from '../webLibrary'

describe('github repo reference', () => {
  it('reads owner/name from a URL or shorthand, and rejects anything else', () => {
    expect(githubRepoRef('https://github.com/akr3ch/BugBountyBooks')).toEqual({ owner: 'akr3ch', repo: 'BugBountyBooks' })
    expect(githubRepoRef('github.com/akr3ch/BugBountyBooks/tree/main')).toEqual({ owner: 'akr3ch', repo: 'BugBountyBooks' })
    expect(githubRepoRef('akr3ch/BugBountyBooks')).toEqual({ owner: 'akr3ch', repo: 'BugBountyBooks' })
    expect(githubRepoRef('https://github.com/akr3ch/BugBountyBooks.git')).toEqual({ owner: 'akr3ch', repo: 'BugBountyBooks' })
    for (const bad of ['https://evil.test/a/b', 'https://github.com/akr3ch/..', 'not a url', '']) expect(githubRepoRef(bad)).toBeNull()
  })
})

describe('github page link to raw file link', () => {
  it('rewrites a blob page URL to the raw file, and leaves other URLs alone', () => {
    expect(rawGithubUrl('https://github.com/akr3ch/BugBountyBooks/blob/main/zseanos-methodology.pdf'))
      .toBe('https://raw.githubusercontent.com/akr3ch/BugBountyBooks/main/zseanos-methodology.pdf')
    expect(rawGithubUrl('https://raw.githubusercontent.com/a/b/main/x.pdf')).toBe('https://raw.githubusercontent.com/a/b/main/x.pdf')
    expect(rawGithubUrl('https://example.com/book.pdf')).toBe('https://example.com/book.pdf')
  })
})

describe('downloadDocument retries a transient failure once', () => {
  const realFetch = global.fetch
  afterEach(() => { global.fetch = realFetch; vi.useRealTimers() })

  const pdfResponse = () =>
    new Response(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(32, 0x20)]), {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    })

  it('retries once after a dropped connection, then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network reset'))
      .mockResolvedValueOnce(pdfResponse())
    global.fetch = fetchMock as unknown as typeof fetch
    vi.useFakeTimers()

    const pending = downloadDocument('https://example.com/book.pdf')
    await vi.advanceTimersByTimeAsync(1500)
    const file = await pending

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fs.existsSync(file)).toBe(true)
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })

  it('does not retry a deterministic failure (a bad URL)', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    await expect(downloadDocument('not a real url')).rejects.toThrow(/not a valid URL/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
