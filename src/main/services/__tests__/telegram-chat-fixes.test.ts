import { describe, expect, it } from 'vitest'
import { deviceAlertReply } from '../deviceReplies'
import { SLEEP_REQUEST, isCompoundQuestion } from '../agentRouting'
import { isVagueImproveRequest, IMPROVE_REQUEST } from '../selfImprove'
import { GAP_QUESTION } from '../gapJournal'
import { chatHonestyNote } from '../replyHonesty'

// From a real Telegram conversation (2026-11-02).

const alert = "Heads up — new device on your home network. 192.168.0.120 (44-A3-BB-16-4A-4A). If you don't recognise it, check your router's device list."

describe('a new device on the home network', () => {
  it('says honestly that the type of device is unknown', () => {
    const r = deviceAlertReply('Is the device a ultra smart phone', [alert], 'Ace')
    expect(r?.reply).toMatch(/can't tell what kind of device[\s\S]*192\.168\.0\.120[\s\S]*44-A3-BB-16-4A-4A/)
    expect(r?.fact).toBeUndefined()
  })

  it('remembers the owner\'s answer without claiming to authorize anything', () => {
    const r = deviceAlertReply('This is my new phone', ['I couldn\'t finish that change…', alert], 'Ace')
    expect(r?.reply).toMatch(/192\.168\.0\.120 is your new phone[\s\S]*won't alert you about it again[\s\S]*can only notice new devices, not allow or block/)
    expect(r?.fact).toBe("The device 44-A3-BB-16-4A-4A (192.168.0.120) on Ace's home network is Ace's new phone.")
  })

  it('stays out of the way without a recent alert or for other topics', () => {
    expect(deviceAlertReply('This is my new phone', ['Here is your account.'], 'Ace')).toBeNull()
    expect(deviceAlertReply('It is raining outside', [alert], 'Ace')).toBeNull()
  })
})

describe('going to sleep', () => {
  it('recognizes good night and sleep requests, and nothing longer', () => {
    for (const t of ['go to sleep mode good night', 'Good night', 'ok goga, go to sleep', 'sleep mode'])
      expect(SLEEP_REQUEST.test(t), t).toBe(true)
    for (const t of ['write a good night story for my kid', 'how do I make my PC go to sleep at night?'])
      expect(SLEEP_REQUEST.test(t), t).toBe(false)
  })
})

describe('a three-part question', () => {
  it('is not answered with only one part', () => {
    expect(isCompoundQuestion('Why were you not able to touch your real code and second did you read and learn from books I gave you and third how is your day going')).toBe(true)
    expect(isCompoundQuestion('what skills have you learned?')).toBe(false)
  })
})

describe('asking Goga to improve himself', () => {
  it('turns down a goal too vague for the coding model', () => {
    for (const t of ['I like please work and update your code', 'Ok you can work to fix your code to be able to read it', 'improve yourself'])
      expect(isVagueImproveRequest(t), t).toBe(true)
    expect(isVagueImproveRequest('improve yourself: when a book download fails, retry the download once before giving up')).toBe(false)
    expect(IMPROVE_REQUEST.test('I like please work and update your code')).toBe(true)
  })

  it('answers "what should we improve first" from the real failure record', () => {
    expect(GAP_QUESTION.test('Ok let’s start with one code improvement what should we improve first')).toBe(true)
  })
})

describe('made-up actions in chat replies', () => {
  it('flags claims and promises no tool backed', () => {
    expect(chatHonestyNote("Great, I've added your new phone to the list of authorized devices on your home network.")).toMatch(/nothing was done/)
    expect(chatHonestyNote('I checked the device connected to the network at 192.168.0.120.')).toMatch(/nothing was done/)
    expect(chatHonestyNote("Otherwise, I'll keep checking the account hourly and keep you updated.")).toMatch(/nothing is scheduled/)
    expect(chatHonestyNote('I can check it every hour if you like.')).toBe('')
  })
})
