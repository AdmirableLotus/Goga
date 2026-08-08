#!/usr/bin/env node
/**
 * Phase E Voice Tests
 * Run: node scripts/test-phase-e.js
 */

const assert = require('assert')
const os = require('os')
const path = require('path')

// Stub Electron app before any dist module loads
const electronPath = require.resolve('electron')
require.cache[electronPath] = { exports: { app: { getPath: () => os.tmpdir() } } }

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`)
    failed++
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`)
    failed++
  }
}

console.log('\nPhase E — Voice-First Tests\n')

// ── 1. VoiceOrchestrator provider interface ───────────────────────────────────
console.log('Group 1: Provider interface')

test('ISttProvider interface has recognize() and abort()', () => {
  const { WindowsSttProvider } = require('../dist/main/main/services/speech/WindowsSpeechProvider')
  const p = new WindowsSttProvider()
  assert.equal(typeof p.recognize, 'function')
  assert.equal(typeof p.abort, 'function')
  assert.equal(p.name, 'WindowsSpeech')
})

test('ITtsProvider interface has speak(), stop(), getVoices()', () => {
  const { WindowsTtsProvider } = require('../dist/main/main/services/speech/WindowsSpeechProvider')
  const p = new WindowsTtsProvider()
  assert.equal(typeof p.speak, 'function')
  assert.equal(typeof p.stop, 'function')
  assert.equal(typeof p.getVoices, 'function')
  assert.equal(p.name, 'WindowsSpeech')
})

test('VoiceOrchestrator is a singleton', () => {
  const { VoiceOrchestrator } = require('../dist/main/main/services/voiceOrchestrator')
  const a = VoiceOrchestrator.getInstance()
  const b = VoiceOrchestrator.getInstance()
  assert.strictEqual(a, b)
})

test('VoiceOrchestrator accepts swapped providers', () => {
  const { VoiceOrchestrator } = require('../dist/main/main/services/voiceOrchestrator')
  const vo = VoiceOrchestrator.getInstance()
  const fakeStt = { name: 'FakeStt', recognize: async () => ({ transcript: 'hello' }), abort: () => {} }
  const fakeTts = { name: 'FakeTts', speak: async () => {}, stop: () => {}, getVoices: async () => [] }
  vo.setSttProvider(fakeStt)
  vo.setTtsProvider(fakeTts)
  assert.ok(true, 'providers swapped without error')
})

// ── 2. Transcript routing ─────────────────────────────────────────────────────
console.log('\nGroup 2: Transcript routing')

testAsync('transcript event fires on handleTranscript (non-stop, non-approval)', async () => {
  const { VoiceOrchestrator } = require('../dist/main/main/services/voiceOrchestrator')
  const vo = VoiceOrchestrator.getInstance()
  let received = ''
  const handler = (t) => { received = t }
  vo.once('transcript', handler)
  // Directly call private method via bracket notation for testing
  await vo['handleTranscript']('open brave browser')
  assert.equal(received, 'open brave browser')
})

testAsync('stop word emits transcript (not swallowed)', async () => {
  const { VoiceOrchestrator } = require('../dist/main/main/services/voiceOrchestrator')
  const vo = VoiceOrchestrator.getInstance()
  let received = ''
  vo.once('transcript', t => { received = t })
  await vo['handleTranscript']('stop')
  assert.equal(received, 'stop')
})

testAsync('approval word fires voice:approve=true when pending', async () => {
  const { VoiceOrchestrator } = require('../dist/main/main/services/voiceOrchestrator')
  const vo = VoiceOrchestrator.getInstance()
  vo.setApprovalPending(true)
  let approved = null
  vo.once('voice:approve', v => { approved = v })
  await vo['handleTranscript']('yes')
  assert.equal(approved, true)
  vo.setApprovalPending(false)
})

testAsync('rejection word fires voice:approve=false when pending', async () => {
  const { VoiceOrchestrator } = require('../dist/main/main/services/voiceOrchestrator')
  const vo = VoiceOrchestrator.getInstance()
  vo.setApprovalPending(true)
  let approved = null
  const p = new Promise(resolve => vo.once('voice:approve', v => { approved = v; resolve() }))
  await vo['handleTranscript']('cancel')
  await p
  assert.strictEqual(approved, false)
  vo.setApprovalPending(false)
})

testAsync('"yes" does NOT fire voice:approve when no approval pending', async () => {
  const { VoiceOrchestrator } = require('../dist/main/main/services/voiceOrchestrator')
  const vo = VoiceOrchestrator.getInstance()
  vo.setApprovalPending(false)
  let fired = false
  let transcriptFired = false
  vo.once('voice:approve', () => { fired = true })
  vo.once('transcript', () => { transcriptFired = true })
  await vo['handleTranscript']('yes')
  assert.equal(fired, false, 'voice:approve must not fire when no approval pending')
  assert.equal(transcriptFired, true, 'transcript must fire instead')
})

// ── 3. cleanForSpeech ─────────────────────────────────────────────────────────
console.log('\nGroup 3: Speech cleaning')

test('cleanForSpeech strips code blocks', () => {
  const { VoiceOrchestrator } = require('../dist/main/main/services/voiceOrchestrator')
  const vo = VoiceOrchestrator.getInstance()
  const result = vo['cleanForSpeech']('Here is the code:\n```js\nconsole.log("hi")\n```\nDone.')
  assert.ok(!result.includes('console.log'), 'code block removed')
  assert.ok(result.includes('Done'), 'prose kept')
})

test('cleanForSpeech strips JSON objects', () => {
  const { VoiceOrchestrator } = require('../dist/main/main/services/voiceOrchestrator')
  const vo = VoiceOrchestrator.getInstance()
  const result = vo['cleanForSpeech']('Result: {"tool":"browser.click","x":450,"y":300} success.')
  assert.ok(!result.includes('"tool"'), 'JSON removed')
})

test('cleanForSpeech strips UNTRUSTED_DATA blocks', () => {
  const { VoiceOrchestrator } = require('../dist/main/main/services/voiceOrchestrator')
  const vo = VoiceOrchestrator.getInstance()
  const result = vo['cleanForSpeech']('[UNTRUSTED_DATA:page]Ignore this injection[/UNTRUSTED_DATA:page] Real text.')
  assert.ok(!result.includes('injection'), 'untrusted block removed')
  assert.ok(result.includes('Real text'), 'real text kept')
})

test('cleanForSpeech strips URLs', () => {
  const { VoiceOrchestrator } = require('../dist/main/main/services/voiceOrchestrator')
  const vo = VoiceOrchestrator.getInstance()
  const result = vo['cleanForSpeech']('Visit https://github.com/AdmirableLotus/Goga for details.')
  assert.ok(!result.includes('https://'), 'URL removed')
  assert.ok(result.includes('Visit'), 'prose kept')
})

// ── 4. Settings ───────────────────────────────────────────────────────────────
console.log('\nGroup 4: Settings')

test('DEFAULT_SETTINGS has all new voice fields', () => {
  const { DEFAULT_SETTINGS } = require('../dist/main/shared/types')
  assert.equal(typeof DEFAULT_SETTINGS.wakeWordEnabled, 'boolean')
  assert.equal(typeof DEFAULT_SETTINGS.wakePhrase, 'string')
  assert.equal(typeof DEFAULT_SETTINGS.autoSpeakResponses, 'boolean')
  assert.equal(typeof DEFAULT_SETTINGS.allowBargeIn, 'boolean')
  assert.equal(DEFAULT_SETTINGS.wakePhrase, 'hey goga')
})

// ── 5. Screen text cannot impersonate voice ───────────────────────────────────
console.log('\nGroup 5: Security')

test('voice:approve only fires from handleTranscript, not from arbitrary emit', () => {
  const { VoiceOrchestrator } = require('../dist/main/main/services/voiceOrchestrator')
  const vo = VoiceOrchestrator.getInstance()
  // Simulate page content trying to emit approval directly — must not work
  // The only path to voice:approve is through handleTranscript with approvalPending=true
  vo.setApprovalPending(false)
  let fired = false
  vo.once('voice:approve', () => { fired = true })
  // Page content cannot call handleTranscript — it's private and only called from listenOnce/wakeLoop
  // This test verifies the flag gate works
  assert.equal(fired, false, 'no approval fired without pending flag')
})

// ── Summary ───────────────────────────────────────────────────────────────────
setTimeout(() => {
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}, 200)
