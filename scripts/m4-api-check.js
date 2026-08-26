require('dotenv/config');
const https = require('https');

const key = process.env.ELEVENLABS_API_KEY;
const voiceId = process.env.ELEVENLABS_VOICE_ID;

// Test with eleven_multilingual_v2
const body = JSON.stringify({
  text: 'Hello',
  model_id: 'eleven_multilingual_v2',
  voice_settings: { stability: 0.5, similarity_boost: 0.75 }
});

const opts = {
  hostname: 'api.elevenlabs.io',
  path: `/v1/text-to-speech/${voiceId}/stream`,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'xi-api-key': key,
    'Accept': 'audio/mpeg'
  }
};

const req = https.request(opts, (res) => {
  let data = [];
  res.on('data', (c) => data.push(c));
  res.on('end', () => {
    const total = Buffer.concat(data);
    console.log('Status:', res.statusCode);
    console.log('Content-Type:', res.headers['content-type']);
    console.log('Bytes:', total.length);
    if (res.statusCode >= 400) {
      console.log('Body:', total.toString().slice(0, 200));
    }
  });
});
req.on('error', (e) => console.log('Error:', e.message));
req.write(body);
req.end();
