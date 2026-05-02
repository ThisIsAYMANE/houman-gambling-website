const https = require('https');
const crypto = require('crypto');

const MERCHANT_ID = 'dbb46701285c1a2e24a0bf92f00501e5';
const MERCHANT_KEY = 'b83d51eae8d8c6c5c3f3f60b9b3c5a7d';
const BASE_URL = 'https://staging.slotegrator.com/api/index.php/v1';
const LOCAL_API = 'http://localhost:3000/api/casino';

// Helper to make HTTPS requests with signature
function makeRequest(method, path, body, isLocal = false) {
  return new Promise((resolve, reject) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString('hex');

    let fullUrl, options;
    
    if (isLocal) {
      fullUrl = `${LOCAL_API}${path}`;
      const url = new URL(fullUrl);
      options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: method,
        headers: {
          'Content-Type': 'application/json',
        },
      };
    } else {
      fullUrl = `${BASE_URL}${path}`;
      const url = new URL(fullUrl);
      
      // Create signature
      const signatureData = `${MERCHANT_ID}${timestamp}${nonce}${JSON.stringify(body || {})}`;
      const signature = crypto.createHash('sha1').update(signatureData + MERCHANT_KEY).digest('hex');

      options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: method,
        headers: {
          'Content-Type': 'application/json',
          'X-Merchant-Id': MERCHANT_ID,
          'X-Timestamp': timestamp,
          'X-Nonce': nonce,
          'X-Sign': signature,
        },
      };
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function run() {
  console.log('\n=== CREATE SESSION AND VALIDATE ===\n');

  // Step 1: Create session via /games/init
  console.log('Step 1: Creating session via /games/init...');
  
  const initPayload = {
    game_uuid: 'fe38b9de0f44ac5892261d426ba39cd1aa410807', // valid UUID from earlier tests
    player_id: 'P1',
    player_name: 'A',
    currency: 'EUR',
    session_id: `S_${Date.now()}`,
    device: 'desktop',
    return_url: 'http://localhost',
    language: 'en',
    email: 'a@b.c'
  };

  try {
    const initRes = await makeRequest('POST', '/games/init', initPayload);
    console.log(`Init status: ${initRes.status}`);
    
    if (initRes.status !== 200) {
      console.log('ERROR: /games/init failed');
      console.log('Response:', JSON.stringify(initRes.data, null, 2));
      return;
    }

    console.log('✓ Session created successfully');
    const sessionId = initPayload.session_id;
    console.log(`Session ID: ${sessionId}`);

    // Step 2: Call /self-validate with the new session
    console.log('\nStep 2: Validating with self-validate endpoint...');
    
    const validateRes = await makeRequest('POST', '/self-validate', { session_id: sessionId });
    
    console.log(`\nValidation Response (Status: ${validateRes.status}):`);
    console.log(JSON.stringify(validateRes.data, null, 2));

    if (validateRes.data.success === true && validateRes.data.status === 1) {
      console.log('\n✓✓✓ VALIDATION PASSED! ✓✓✓');
    } else {
      console.log('\n✗ Validation failed');
      if (validateRes.data.log && validateRes.data.log.length > 0) {
        console.log('Errors:');
        validateRes.data.log.forEach(err => console.log(`  - ${err}`));
      }
    }
  } catch (err) {
    console.error('Request error:', err.message);
  }
}

run();
