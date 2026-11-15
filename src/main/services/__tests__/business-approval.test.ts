import { describe, expect, it } from 'vitest'
import { consumeApproval, denyAction, getPending, listPending, prepareAction } from '../business/audit'

/**
 * The approval queue is the only thing standing between a drafted mail and a sent one, so
 * these tests hold it to the three promises it makes: an approval is for one exact action,
 * it is single use, and it cannot be spent on a different kind of action.
 *
 * Outside Electron the queue keeps itself in memory (see `paths.ts`), which is exactly what
 * a test process is, so nothing here touches the user's data folder.
 */

describe('the business approval queue', () => {
  it('prepares an action with its full content and sends nothing', () => {
    const a = prepareAction('mail-send', 'Mail to a@b.com: hello', 'To: a@b.com\nSubject: hello\n\nbody')
    expect(a.kind).toBe('mail-send')
    expect(a.content).toContain('body')
    expect(getPending(a.id)?.id).toBe(a.id)
    expect(listPending().some(p => p.id === a.id)).toBe(true)
  })

  it('spends an approval exactly once', () => {
    const a = prepareAction('social-post', 'post', 'hello world')
    expect(consumeApproval(a.id, 'social-post').ok).toBe(true)
    // The second attempt must fail: a retry needs a fresh approval.
    const second = consumeApproval(a.id, 'social-post')
    expect(second.ok).toBe(false)
    expect(second.reason).toContain('unknown or has expired')
  })

  it('refuses to spend a mail approval on a post', () => {
    const a = prepareAction('mail-send', 'mail', 'text')
    const wrong = consumeApproval(a.id, 'social-post')
    expect(wrong.ok).toBe(false)
    expect(wrong.reason).toContain('was for mail-send')
    // The right kind still works afterwards, because the wrong attempt did not consume it.
    expect(consumeApproval(a.id, 'mail-send').ok).toBe(true)
  })

  it('denies an action and leaves nothing to approve', () => {
    const a = prepareAction('listing-create', 'listing', 'title')
    expect(denyAction(a.id).ok).toBe(true)
    expect(getPending(a.id)).toBeNull()
    expect(consumeApproval(a.id, 'listing-create').ok).toBe(false)
  })

  it('refuses an id it never issued', () => {
    expect(consumeApproval('not-a-real-id', 'mail-send').ok).toBe(false)
    expect(denyAction('not-a-real-id').ok).toBe(false)
  })

  it('gives each prepared action its own id', () => {
    const a = prepareAction('mail-send', 'one', 'x')
    const b = prepareAction('mail-send', 'two', 'y')
    expect(a.id).not.toBe(b.id)
    expect(consumeApproval(a.id, 'mail-send').ok).toBe(true)
    // Approving the first must not have approved the second.
    expect(getPending(b.id)?.id).toBe(b.id)
  })
})
