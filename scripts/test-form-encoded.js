const crypto = require('crypto');
const https = require('https');

const MERCHANT_ID = 'dbb46701285c1a2e24a0bf92f00501e5';
const MERCHANT_KEY = 'f0c0ef35b5e8c8f6bb18e5c7fa6eab19';

async function testGameInit() {
  const params = {
    game_uuid: 'fe38b9de0f44ac5892261d426ba39cd1aa410807',
    player_id: 'testplayer123',
    player_name: 'Test Player',
    currency: 'EUR',
    session_id: 'sess_' + Date.now(),
    device: 'desktop',
    return_url: 'http://localhost:3000',
    language: 'en',
    email: 'test@test.com'
  };

  // CRITICAL: Convert to form-encoded, NOT JSON
  const formData = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    formData.append(key, String(value));
  });

  const body = formData.toString();
  console.log('📝 Request Data (form-encoded):\n', body);
  console.log('\n' + '='.repeat(70));

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');

  // Sort parameters for signature
  const sortedKeys = Object.keys(params).sort();
  const sortedParams = sortedKeys.reduce((obj, key) => {
    obj[key] = params[key];
    return obj;
  }, {});

  // Build signature data - MUST match file order
  const signatureString = Object.entries(sortedParams)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  console.log('\n🔑 Signature Data:');
  console.log(signatureString);
  console.log('\nMerchant Key:', MERCHANT_KEY);

  const signature = crypto
    .createHmac('sha1', MERCHANT_KEY)
    .update(signatureString)
    .digest('hex');

  console.log('X-Sign:', signature);
  console.log('\n' + '='.repeat(70));

  const options = {
    hostname: 'staging.slotegrator.com',
    path: '/api/index.php/v1/games/init',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'X-Merchant-Id': MERCHANT_ID,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Sign': signature
    }
  };

  console.log('\n📤 Request Headers:');
  console.log(`  X-Merchant-Id: ${options.headers['X-Merchant-Id']}`);
  console.log(`  X-Timestamp: ${options.headers['X-Timestamp']}`);
  console.log(`  X-Nonce: ${options.headers['X-Nonce']}`);
  console.log(`  X-Sign: ${options.headers['X-Sign']}`);
  console.log(`  Content-Type: ${options.headers['Content-Type']}`);
  console.log('\n' + '='.repeat(70));

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        console.log('\n📥 Response:');
        console.log(`Status Code: ${res.statusCode}`);
        
        try {
          const response = JSON.parse(data);
          console.log(JSON.stringify(response, null, 2));
          
          if (res.statusCode === 200 || res.statusCode === 302) {
            console.log('\n✅ SUCCESS! Check the game URL in response.url');
          } else if (res.statusCode === 403) {
            console.log('\n❌ Still getting 403 - check if signature is correct');
          }
        } catch (e) {
          console.log('Raw response:', data.substring(0, 500));
        }
        resolve();
      });
    });

    req.on('error', (error) => {
      console.error('Error:', error.message);
      resolve();
    });

    req.write(body);
    req.end();
  });
}

console.log('\n🧪 Testing /games/init with FORM-ENCODED body (not JSON)\n');
testGameInit();
