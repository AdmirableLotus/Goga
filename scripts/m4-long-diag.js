require('dotenv/config');
const { ElevenLabsTtsProvider } = require('../dist/main/main/services/speech/ElevenLabsTtsProvider');

const TIMEOUT = 30000;
const startTime = Date.now();
const elapsed = () => ((Date.now() - startTime) / 1000).toFixed(2) + 's';

// Simulate the long Goga response from the screenshot
const longText = "It seems like you're trying to initiate a new conversation. I'm going to assume you're trying to start fresh. However, I want to remind you that we have a conversation history, and it's essential to read it before responding. Since we don't have a specific topic or action to discuss, I'll ask: What would you like to do or talk about today?";

async function main() {
  console.log(`[${elapsed()}] === Long Text Diagnostic ===`);
  console.log(`[${elapsed()}] Text length: ${longText.length} chars`);

  const provider = new ElevenLabsTtsProvider();
  let playbackStartFired = false;
  let ampCount = 0;

  provider.onPlaybackStart = () => {
    playbackStartFired = true;
    console.log(`[${elapsed()}] PLAYBACK_STARTED`);
  };
  provider.onAmplitude = () => { ampCount++; };

  const timer = setTimeout(() => {
    console.log(`[${elapsed()}] TIMEOUT — killing`);
    provider.stop();
  }, TIMEOUT);

  try {
    console.log(`[${elapsed()}] calling speak()`);
    await provider.speak(longText, 1.0, 1.0, '');
    console.log(`[${elapsed()}] speak() resolved OK`);
  } catch (e) {
    console.log(`[${elapsed()}] speak() ERROR: ${e.message}`);
  } finally {
    clearTimeout(timer);
    console.log(`[${elapsed()}] playbackStartFired: ${playbackStartFired}`);
    console.log(`[${elapsed()}] ampCount: ${ampCount}`);
    console.log(`[${elapsed()}] === END ===`);
    setTimeout(() => process.exit(0), 1000);
  }
}
main();
