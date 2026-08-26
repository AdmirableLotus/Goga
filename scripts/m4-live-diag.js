/**
 * M4 Live Diagnostic — provider-only test with real env.
 * Strict timeout. Reports lifecycle events. Never prints secrets.
 */
require('dotenv/config');
const { ElevenLabsTtsProvider } = require('../dist/main/main/services/speech/ElevenLabsTtsProvider');

const TIMEOUT = 15000;
const startTime = Date.now();
const elapsed = () => ((Date.now() - startTime) / 1000).toFixed(2) + 's';

async function main() {
  console.log(`[${elapsed()}] === M4 Live Diagnostic ===`);
  console.log(`[${elapsed()}] KEY present: ${!!process.env.ELEVENLABS_API_KEY}`);
  console.log(`[${elapsed()}] VOICE_ID present: ${!!process.env.ELEVENLABS_VOICE_ID}`);
  console.log(`[${elapsed()}] isConfigured: ${ElevenLabsTtsProvider.isConfigured()}`);

  const provider = new ElevenLabsTtsProvider();
  let playbackStartFired = false;
  let ampCount = 0;

  provider.onPlaybackStart = () => {
    playbackStartFired = true;
    console.log(`[${elapsed()}] PLAYBACK_STARTED callback fired`);
  };
  provider.onAmplitude = (v) => { ampCount++; };

  const timer = setTimeout(() => {
    console.log(`[${elapsed()}] TIMEOUT - killing provider`);
    provider.stop();
  }, TIMEOUT);

  try {
    console.log(`[${elapsed()}] calling speak("Testing Goga voice.")`);
    await provider.speak('Testing Goga voice.', 1.0, 1.0, '');
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
