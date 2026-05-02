const crypto = require('crypto');
const https = require('https');

const MERCHANT_ID = 'dbb46701285c1a2e24a0bf92f00501e5';
const MERCHANT_KEY = 'f0c0ef35b5e8c8f6bb18e5c7fa6eab19';
const BASE_URL = 'https://staging.slotegrator.com/api/index.php/v1';

// Use the game UUID from batata.json callbacks (the one that actually works)
const WORKING_GAME_UUID = 'fe38b9de0f44ac5892261d426ba39cd1aa410807';
const CORRECT_GAME_UUID = '7487f0fac9049c9ee0dd0635a8ce5f5bfe04cd15';

// Use player_id format that actually worked in callbacks
const WORKING_PLAYER_ID = '5fbW-EgviQlSB0qgLmM0Z';

const testCases = [
  {
    name: 'Test 1: Correct UUID + Working player format',
    params: {
      game_uuid: CORRECT_GAME_UUID,
      player_id: WORKING_PLAYER_ID,
      player_name: 'TestPlayer',
      currency: 'EUR',
      session_id: 'session_' + WORKING_PLAYER_ID + '_' + Date.now(),
      device: 'desktop',
      return_url: 'https://localhost',
      language: 'en',
      email: 'test@test.com'
    }
  },
  {
    name: 'Test 2: Working UUID + Working player format',
    params: {
      game_uuid: WORKING_GAME_UUID,
      player_id: WORKING_PLAYER_ID,
      player_name: 'TestPlayer',
      currency: 'EUR',
      session_id: 'session_' + WORKING_PLAYER_ID + '_' + Date.now(),
      device: 'desktop',
      return_url: 'https://localhost',
      language: 'en',
      email: 'test@test.com'
    }
  },
  {
    name: 'Test 3: Correct UUID only (all other fields minimal)',
    params: {
      game_uuid: CORRECT_GAME_UUID,
      player_id: 'player_' + Math.random().toString(36).substr(2, 12),
      currency: 'EUR'
    }
  }
];

async function testGamesInit(testCase) {
  return new Promise((resolve) => {
    const params = testCase.params;
    const body = JSON.stringify(params);

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');

    const signatureData = `${MERCHANT_ID}${timestamp}${nonce}${body}`;
    const signature = crypto
      .createHash('sha1')
      .update(signatureData + MERCHANT_KEY)
      .digest('hex');

    const options = {
      hostname: 'staging.slotegrator.com',
      path: '/api/index.php/v1/games/init',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Merchant-Id': MERCHANT_ID,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        'X-Sign': signature
      }
    };

    console.log(`\n${'='.repeat(70)}`);
    console.log(`🧪 ${testCase.name}`);
    console.log(`${'='.repeat(70)}`);
    console.log('Parameters:', JSON.stringify(params, null, 2));

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          console.log(`\nStatus Code: ${res.statusCode}`);
          console.log('Response:', JSON.stringify(response, null, 2));
          
          if (res.statusCode === 200 || res.statusCode === 302) {
            console.log('\n✅ SUCCESS! Game session created!');
          } else if (res.statusCode === 403) {
            console.log('\n❌ 403 Forbidden - Parameter error');
          } else {
            console.log('\n⚠️  Unexpected status code');
          }
        } catch (e) {
          console.log(`\nStatus Code: ${res.statusCode}`);
          console.log('Response (raw):', data.substring(0, 1000));
        }
        resolve();
      });
    });

    req.on('error', (error) => {
      console.error('Request error:', error.message);
      resolve();
    });

    req.write(body);
    req.end();
  });
}

async function runAllTests() {
  console.log('\n\n🔬 TESTING GAMES/INIT WITH CORRECT PARAMETERS\n');
  console.log('Key findings from your existing callback data:');
  console.log('  - Working player_id format: 5fbW-EgviQlSB0qgLmM0Z');
  console.log('  - Working game_uuid: fe38b9de0f44ac5892261d426ba39cd1aa410807');
  console.log('  - Correct game_uuid (from docs): 7487f0fac9049c9ee0dd0635a8ce5f5bfe04cd15\n');
  
  for (const testCase of testCases) {
    await testGamesInit(testCase);
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  
  console.log(`\n${'='.repeat(70)}`);
  console.log('Testing complete!');
  console.log('If Test 2 works, use: game_uuid from batata.json + player format');
  console.log('If Test 3 works, you only need game_uuid + player_id + currency');
  console.log(`${'='.repeat(70)}\n`);
}

runAllTests();
