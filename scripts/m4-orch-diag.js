/**
 * M4 Orchestrator Diagnostic — tests the full speak() path including fallback.
 * Uses the real built orchestrator with .env credentials.
 */
require('dotenv/config');
const { VoiceOrchestrator } = require('../dist/main/main/services/voiceOrchestrator');

const TIMEOUT = 45000;
const startTime = Date.now();
const elapsed = () => ((Date.now() - startTime) / 1000).toFixed(2) + 's';

async function main() {
  console.log(`[${elapsed()}] === Orchestrator Diagnostic ===`);

  // Reset singleton
  VoiceOrchestrator.instance = undefined;
  const orch = VoiceOrchestrator.getInstance();

  const statuses = [];
  orch.on('status', (s) => { statuses.push(s); console.log(`[${elapsed()}] status: ${s}`); });

  const timer = setTimeout(() => {
    console.log(`[${elapsed()}] EXTERNAL TIMEOUT — calling stopSpeaking()`);
    orch.stopSpeaking();
  }, TIMEOUT);

  try {
    console.log(`[${elapsed()}] calling speak("Hello, this is a live test.")`);
    await orch.speak('Hello, this is a live test.');
    console.log(`[${elapsed()}] speak() resolved`);
  } catch (e) {
    console.log(`[${elapsed()}] speak() ERROR: ${e.message}`);
  } finally {
    clearTimeout(timer);
    console.log(`[${elapsed()}] final status: ${orch.getStatus()}`);
    console.log(`[${elapsed()}] statuses: [${statuses.join(', ')}]`);
    console.log(`[${elapsed()}] === END ===`);
    setTimeout(() => process.exit(0), 1000);
  }
}
main();
