/**
 * M4 SAPI Diagnostic — test WindowsTtsProvider directly.
 */
const { WindowsTtsProvider } = require('../dist/main/main/services/speech/WindowsSpeechProvider');

const TIMEOUT = 20000;
const startTime = Date.now();
const elapsed = () => ((Date.now() - startTime) / 1000).toFixed(2) + 's';

async function main() {
  console.log(`[${elapsed()}] === SAPI Diagnostic ===`);
  const provider = new WindowsTtsProvider();
  let startFired = false;
  let ampCount = 0;

  provider.onPlaybackStart = () => {
    startFired = true;
    console.log(`[${elapsed()}] onPlaybackStart fired`);
  };
  provider.onAmplitude = (v) => { ampCount++; };

  const timer = setTimeout(() => {
    console.log(`[${elapsed()}] TIMEOUT - killing`);
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
    console.log(`[${elapsed()}] startFired: ${startFired}`);
    console.log(`[${elapsed()}] ampCount: ${ampCount}`);
    console.log(`[${elapsed()}] === END ===`);
    setTimeout(() => process.exit(0), 1000);
  }
}
main();
