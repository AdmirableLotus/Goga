require('dotenv/config');
const https = require('https');
const key = process.env.ELEVENLABS_API_KEY;

const opts = {
  hostname: 'api.elevenlabs.io',
  path: '/v1/voices',
  method: 'GET',
  headers: { 'xi-api-key': key }
};

const req = https.request(opts, (res) => {
  let data = [];
  res.on('data', (c) => data.push(c));
  res.on('end', () => {
    const body = JSON.parse(Buffer.concat(data).toString());
    if (body.voices) {
      console.log(`Found ${body.voices.length} voices:\n`);
      body.voices.forEach(v => {
        console.log(`  ${v.voice_id} — "${v.name}" (${v.category})`);
      });
    } else {
      console.log('Response:', JSON.stringify(body).slice(0, 300));
    }
  });
});
req.on('error', (e) => console.log('Error:', e.message));
req.end();
