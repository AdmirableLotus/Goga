require('dotenv/config');
const { VoiceOrchestrator } = require('../dist/main/main/services/voiceOrchestrator');

const startTime = Date.now();
const elapsed = () => ((Date.now() - startTime) / 1000).toFixed(2) + 's';

const longText = "It seems like you're trying to initiate a new conversation. I'm going to assume you're trying to start fresh. However, I want to remind you that we have a conversation history, and it's essential to read it before responding. Since we don't have a specific topic or action to discuss, I'll ask: What would you like to do or talk about today, Boss?";

async function main() {
  console.log(`[${elapsed()}] === Orchestrator Long Text ===`);
  VoiceOrchestrator.instance = undefined;
  const orch = VoiceOrchestrator.getInstance();

  // Test what cleanForSpeech produces
  const cleaned = orch.cleanForSpeech(longText);
  console.log(`[${elapsed()}] cleanForSpeech output (${cleaned.length} chars): "${cleaned}"`);

  orch.on('status', (s) => console.log(`[${elapsed()}] status: ${s}`));

  const timer = setTimeout(() => { console.log(`[${elapsed()}] TIMEOUT`); orch.stopSpeaking(); }, 45000);

  await orch.speak(longText);
  clearTimeout(timer);
  console.log(`[${elapsed()}] speak() done, status: ${orch.getStatus()}`);
  setTimeout(() => process.exit(0), 1000);
}
main();
