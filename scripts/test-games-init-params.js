const crypto = require('crypto');
const https = require('https');

const MERCHANT_ID = 'dbb46701285c1a2e24a0bf92f00501e5';
const MERCHANT_KEY = 'f0c0ef35b5e8c8f6bb18e5c7fa6eab19';
const BASE_URL = 'https://staging.slotegrator.com/api/index.php/v1';

// Test different parameter combinations
const testCases = [
  {
    name: 'Test 1: Current parameters',
    params: {
      game_uuid: 'fe38b9de0f44ac5892261d426ba39cd1aa410807',
      player_id: 'P1',
      player_name: 'A',
      currency: 'EUR',
      session_id: 'S_' + Date.now(),
      device: 'desktop',
      return_url: 'http://localhost:3000',
      language: 'en',
      email: 'a@b.c'
    }
  },
  {
    name: 'Test 2: UUID format session_id',
    params: {
      game_uuid: 'fe38b9de0f44ac5892261d426ba39cd1aa410807',
      player_id: 'player1',
      player_name: 'Player One',
      currency: 'EUR',
      session_id: crypto.randomUUID(),
      device: 'desktop',
      return_url: 'http://localhost:3000',
      language: 'en',
      email: 'test@example.com'
    }
  },
  {
    name: 'Test 3: Numeric player_id',
    params: {
      game_uuid: 'fe38b9de0f44ac5892261d426ba39cd1aa410807',
      player_id: '123456',
      player_name: 'TestPlayer',
      currency: 'EUR',
      session_id: crypto.randomUUID(),
      device: 'desktop',
      return_url: 'http://localhost:3000',
      language: 'en',
      email: 'test@localhost.local'
    }
  },
  {
    name: 'Test 4: Without return_url',
    params: {
      game_uuid: 'fe38b9de0f44ac5892261d426ba39cd1aa410807',
      player_id: 'testplayer',
      player_name: 'Test',
      currency: 'EUR',
      session_id: crypto.randomUUID(),
      device: 'desktop',
      language: 'en',
      email: 'a@b.c'
    }
  },
  {
    name: 'Test 5: Minimal (only required)',
    params: {
      game_uuid: 'fe38b9de0f44ac5892261d426ba39cd1aa410807',
      player_id: 'player1',
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

    console.log(`\n${'='.repeat(60)}`);
    console.log(`📝 ${testCase.name}`);
    console.log(`${'='.repeat(60)}`);
    console.log('Parameters:', JSON.stringify(params, null, 2));
    console.log('Sending request...');

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          console.log(`Status Code: ${res.statusCode}`);
          console.log('Response:', JSON.stringify(response, null, 2));
          
          if (res.statusCode === 200 || res.statusCode === 302) {
            console.log('✅ SUCCESS!');
          } else {
            console.log('❌ ERROR');
          }
        } catch (e) {
          console.log(`Status Code: ${res.statusCode}`);
          console.log('Response (raw):', data.substring(0, 500));
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
  console.log('🔍 Testing /games/init endpoint with different parameters\n');
  
  for (const testCase of testCases) {
    await testGamesInit(testCase);
    // Wait 1 second between tests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log(`\n${'='.repeat(60)}`);
  console.log('Testing complete. Check results above for which parameters work.');
  console.log(`${'='.repeat(60)}\n`);
}

runAllTests();
