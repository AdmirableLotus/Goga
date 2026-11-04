import { describe, expect, it } from 'vitest'
import {
  isLearnFromWeb, isWebSearch, isWebRecall, extractTopic,
  isPublicHttpUrl, decodeEntities, htmlToText, parseDuckResults,
  rankLessons, formatFindings, type Lesson,
} from '../webLearning'

describe('web-learning intent detection', () => {
  it('recognizes a research request only with a web cue and no explicit link', () => {
    expect(isLearnFromWeb('research deep learning online')).toBe(true)
    expect(isLearnFromWeb('learn about options trading from the web')).toBe(true)
    expect(isLearnFromWeb('look up ATR indicators on the internet')).toBe(true)
    expect(isLearnFromWeb('learn about options trading')).toBe(false)          // no web cue — could be a book
    expect(isLearnFromWeb('learn from https://d2l.ai/ and study it')).toBe(false) // a link is a book download
  })

  it('separates search-only, learn-and-save, and recall', () => {
    expect(isWebSearch('search the web for python asyncio')).toBe(true)
    expect(isWebSearch('google the latest on CMS kidney models')).toBe(true)
    expect(isWebSearch('what is python asyncio')).toBe(false)                 // no web cue
    expect(isWebRecall('what did you find about asyncio online')).toBe(true)
    expect(isWebRecall('from your web research, how do stops work')).toBe(true)
    expect(isWebRecall('research stops online')).toBe(false)                   // that is a learn request
  })

  it('strips command words down to the topic', () => {
    expect(extractTopic('research deep learning online')).toBe('deep learning')
    expect(extractTopic('search the web for python asyncio')).toBe('python asyncio')
    expect(extractTopic('learn about options trading from the internet')).toBe('options trading')
  })
})

describe('URL safety guard', () => {
  it('allows public https and blocks private/loopback/non-https', () => {
    expect(isPublicHttpUrl('https://example.com/page')).toBe(true)
    expect(isPublicHttpUrl('http://example.com')).toBe(false)         // https only
    expect(isPublicHttpUrl('https://localhost/x')).toBe(false)
    expect(isPublicHttpUrl('https://127.0.0.1/x')).toBe(false)
    expect(isPublicHttpUrl('https://10.0.0.5/x')).toBe(false)
    expect(isPublicHttpUrl('https://192.168.1.1/x')).toBe(false)
    expect(isPublicHttpUrl('https://169.254.1.1/x')).toBe(false)
    expect(isPublicHttpUrl('https://user:pw@example.com/x')).toBe(false)
    expect(isPublicHttpUrl('https://printer.local/x')).toBe(false)
  })
})

describe('HTML to text', () => {
  it('decodes entities', () => {
    expect(decodeEntities('A &amp; B &lt;ok&gt; &#39;q&#39; &#x41;')).toBe("A & B <ok> 'q' A")
  })
  it('drops scripts/styles and strips tags', () => {
    const html = '<html><head><title>T</title><style>.a{}</style></head><body><script>bad()</script><h1>Hi</h1><p>One &amp; two</p></body></html>'
    const text = htmlToText(html)
    expect(text).toContain('Hi')
    expect(text).toContain('One & two')
    expect(text).not.toContain('bad()')
    expect(text).not.toContain('.a{}')
    expect(text).not.toContain('<')
  })
  it('parses DuckDuckGo result links and decodes uddg redirects', () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x">First result</a>
      <a class="result__a" href="https://example.org/b">Second</a>`
    const hits = parseDuckResults(html, 5)
    expect(hits.map(h => h.url)).toEqual(['https://example.com/a', 'https://example.org/b'])
    expect(hits[0].title).toBe('First result')
  })
})

describe('recall and formatting', () => {
  const lessons: Lesson[] = [
    { id: 1, topic: 'stops', title: 'ATR stop losses', url: 'https://a.com', learnedAt: '2026-11-04T00:00:00Z', note: 'Use ATR to size a stop.', excerpt: '' },
    { id: 2, topic: 'position sizing', title: 'Risk per trade', url: 'https://b.com', learnedAt: '2026-11-04T00:00:00Z', note: 'Risk 1% per trade.', excerpt: '' },
  ]
  it('ranks lessons by term overlap, weighting topic/title', () => {
    const ranked = rankLessons(lessons, 'how do ATR stops work')
    expect(ranked[0].id).toBe(1)
  })
  it('formats findings and the empty case honestly', () => {
    expect(formatFindings('stops', [], 3)).toContain("couldn't read any usable pages")
    const msg = formatFindings('stops', [lessons[0]], 0)
    expect(msg).toContain('ATR stop losses')
    expect(msg).toContain('https://a.com')
    expect(msg).toContain("recalling what I saved")
  })
})
