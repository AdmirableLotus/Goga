import { describe, it, expect } from 'vitest'
import { parseXssPractice } from '../agentRouting'

/**
 * The one safety property that matters here: the offline practice lab fires for a bare "do an xss"
 * request, and NEVER when a real host, URL or bounty platform is named. A real target must fall
 * through to the scope-gated path, which refuses without an authorized program.
 */

describe('parseXssPractice', () => {
  it('fires for a request to do/practise an XSS with no target named', () => {
    expect(parseXssPractice('do one xss bounty for me')).toBe(true)
    expect(parseXssPractice('do one successful xss bounty on his own')).toBe(true)
    expect(parseXssPractice('practice xss')).toBe(true)
    expect(parseXssPractice('show me an xss')).toBe(true)
    expect(parseXssPractice('prove you can do cross-site scripting')).toBe(true)
    expect(parseXssPractice('demonstrate an XSS exploit')).toBe(true)
  })

  it('does NOT fire when a real hostname or URL is named', () => {
    expect(parseXssPractice('find an xss on shop.example.com')).toBe(false)
    expect(parseXssPractice('test xss at https://target.test/search')).toBe(false)
    expect(parseXssPractice('run an xss against api.acme.io')).toBe(false)
  })

  it('does NOT fire when a real bounty platform is named', () => {
    expect(parseXssPractice('do one xss bounty on hackerone')).toBe(false)
    expect(parseXssPractice('find an xss on the cantina program')).toBe(false)
    expect(parseXssPractice('xss on bugcrowd')).toBe(false)
  })

  it('does NOT fire on a mere mention with no intent to perform it', () => {
    expect(parseXssPractice('what is xss')).toBe(false)
    expect(parseXssPractice('tell me about cross-site scripting')).toBe(false)
  })

  it('is not triggered by unrelated requests', () => {
    expect(parseXssPractice('open notepad')).toBe(false)
    expect(parseXssPractice('do a trade on alpaca')).toBe(false)
  })
})
