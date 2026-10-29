import { describe, expect, it } from 'vitest'
import { githubRepoRef, rawGithubUrl } from '../webLibrary'

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
