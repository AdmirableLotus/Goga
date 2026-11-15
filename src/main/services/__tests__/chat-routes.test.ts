import { describe, expect, it } from 'vitest'
import {
  parseBusinessPrepare, parseDeveloperCommand, parseEvolutionDecision, parseLocalReview,
  parseLocalRootCommand, parseMarketsCommand, parseMonitorCommand, parseScopeQuestion, parseVenueCommand,
} from '../chatRoutes'

/**
 * Chat is the route that acts.
 *
 * Each parser here turns a sentence into a real tool call. The point of the test is the
 * sentence: these are close to what the user typed, and a reply that only *described* the
 * work would fail to produce a call at all.
 */

describe('a scope question reaches the scope checker', () => {
  it('reads the example request exactly', () => {
    const q = parseScopeQuestion('is status.coinbase.com in scope for coinbase')
    expect(q).toEqual({ target: 'status.coinbase.com', program: 'coinbase' })
  })

  it('reads a URL and the program it belongs to', () => {
    const q = parseScopeQuestion('check https://api.example.com/v1/users against the acme program scope')
    expect(q?.target).toBe('api.example.com')
    expect(q?.program).toBe('acme')
  })

  it('uses the active program when none is named', () => {
    const q = parseScopeQuestion('is payments.example.com in scope?')
    expect(q).toEqual({ target: 'payments.example.com', program: null })
  })

  it('answers "is that in scope" about a target named a moment ago', () => {
    const q = parseScopeQuestion('is that in scope?', 'app.example.com')
    expect(q).toEqual({ target: 'app.example.com', program: null })
  })

  it('does not mistake a question about scope in general for a check', () => {
    expect(parseScopeQuestion('what is a scope on hackerone?')).toBeNull()
    expect(parseScopeQuestion('explain how program scope works')).toBeNull()
    expect(parseScopeQuestion('is scope important')).toBeNull()
  })

  it('refuses when there is no target anywhere, rather than inventing one', () => {
    expect(parseScopeQuestion('is that in scope?')).toBeNull()
  })
})

describe('a local review reaches the Grimoire', () => {
  it('reads the example request with a remembered root', () => {
    const r = parseLocalReview(
      'review wp-includes/class-wp-http.php in the local WordPress copy',
      'C:\\Users\\redre\\OS3\\goga-specialist-review\\wp\\wordpress',
    )
    expect(r).toEqual({
      root: 'C:\\Users\\redre\\OS3\\goga-specialist-review\\wp\\wordpress',
      path: 'wp-includes/class-wp-http.php',
    })
  })

  it('splits a full path given in the sentence', () => {
    expect(parseLocalReview('review C:\\src\\wordpress\\wp-includes\\class-wp-http.php'))
      .toEqual({ root: 'C:\\src\\wordpress\\wp-includes', path: 'class-wp-http.php' })
  })

  it('asks for the folder instead of guessing one when none is known', () => {
    expect(parseLocalReview('review wp-includes/class-wp-http.php')).toBeNull()
  })

  it('ignores a request that names no source file', () => {
    expect(parseLocalReview('review my essay', 'C:\\src')).toBeNull()
    expect(parseLocalReview('review everything in the folder', 'C:\\src')).toBeNull()
  })

  it('does not fire on a question about the review itself', () => {
    expect(parseLocalReview('how does the specialist review work?', 'C:\\src')).toBeNull()
  })

  it('remembers a root the user points at', () => {
    expect(parseLocalRootCommand('use C:\\src\\wordpress as my local copy'))
      .toEqual({ root: 'C:\\src\\wordpress' })
    expect(parseLocalRootCommand('C:\\src\\wp is my source tree')).toEqual({ root: 'C:\\src\\wp' })
    expect(parseLocalRootCommand('set up a virtual machine')).toBeNull()
  })
})

describe('a venue request reaches the venue tools', () => {
  it('reads an account', () => {
    expect(parseVenueCommand('how is my pivex account doing')).toEqual({
      tool: 'venue.read', params: { venue: 'pivex' }, intent: 'Read the pivex account',
    })
    expect(parseVenueCommand('read my alpaca paper account')?.params.venue).toBe('alpaca-paper')
  })

  it('reaches the statistics, not a description of them', () => {
    expect(parseVenueCommand('what are my pivex practice stats')?.tool).toBe('venue.stats')
    expect(parseVenueCommand('show me the pivex trades')?.tool).toBe('venue.trades')
  })

  it('reaches the halt', () => {
    const h = parseVenueCommand('stop trading on pivex')
    expect(h?.tool).toBe('venue.halt')
    expect(h?.params).toMatchObject({ venue: 'pivex', halted: true })
  })

  it('leaves a question about a venue alone', () => {
    expect(parseVenueCommand('what is pivex?')).toBeNull()
    expect(parseVenueCommand('should i trade bitcoin')).toBeNull()
  })
})

describe('a markets request reaches the markets tools', () => {
  it('reads the data and runs the backtest', () => {
    expect(parseMarketsCommand('what markets data do i have')?.tool).toBe('markets.state')
    expect(parseMarketsCommand('backtest my watchlist')?.tool).toBe('markets.backtest')
  })

  it('leaves a general question about markets alone', () => {
    expect(parseMarketsCommand('how do markets work')).toBeNull()
    expect(parseMarketsCommand('buy AAPL')).toBeNull()
  })
})

describe('a business action is prepared, never sent', () => {
  it('reads the recipient of an email', () => {
    const b = parseBusinessPrepare('draft an email to sam@example.com about the invoice')
    expect(b?.tool).toBe('business.prepareMail')
    expect(b?.params.to).toBe('sam@example.com')
  })

  it('reads a social post', () => {
    expect(parseBusinessPrepare('write a bluesky post about the release')?.tool).toBe('business.preparePost')
  })

  it('reads the monitoring request', () => {
    expect(parseMonitorCommand('check my apps')?.tool).toBe('business.checkApps')
    expect(parseMonitorCommand('is my site up')).not.toBeNull()
    expect(parseMonitorCommand('what is a website')).toBeNull()
  })

  it('does not fire on a question', () => {
    expect(parseBusinessPrepare('how do i write an email to a client?')).toBeNull()
  })
})

describe('the decisions that used to be buttons', () => {
  it('installs or discards a self-improvement run', () => {
    expect(parseEvolutionDecision('install it')?.tool).toBe('evolution.install')
    expect(parseEvolutionDecision('discard the change')?.tool).toBe('evolution.discard')
    expect(parseEvolutionDecision('install docker')).toBeNull()
  })

  it('starts a developer run on Goga\'s own source', () => {
    const d = parseDeveloperCommand('developer mode: the browser retries the same failing page and never reports why')
    expect(d?.tool).toBe('developer.start')
    expect(d?.params.mode).toBe('plan')
    expect(parseDeveloperCommand('developer mode: implement a fix so a failed navigation is reported')).toMatchObject({ params: { mode: 'build' } })
    expect(parseDeveloperCommand('improve your own code')).toBeNull()
  })
})
