const crypto = require('crypto');
const https = require('https');

const MERCHANT_ID = 'dbb46701285c1a2e24a0bf92f00501e5';
const MERCHANT_KEY = 'f0c0ef35b5e8c8f6bb18e5c7fa6eab19';

async function validateSession() {
  // Try with EMPTY body - some validation endpoints don't expect parameters
  const body = '';
  
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');

  const signatureData = `${MERCHANT_ID}${timestamp}${nonce}${body}`;
  const signature = crypto
    .createHash('sha1')
    .update(signatureData + MERCHANT_KEY)
    .digest('hex');

  const options = {
    hostname: 'staging.slotegrator.com',
    path: '/api/index.php/v1/self-validate',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': 0,
      'X-Merchant-Id': MERCHANT_ID,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Sign': signature
    }
  };

  console.log('\n🧪 Testing /self-validate with EMPTY body\n');
  console.log('Sending validation request...\n');

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        console.log('═'.repeat(70));
        console.log(`Status Code: ${res.statusCode}`);
        console.log('═'.repeat(70));
        
        try {
          const response = JSON.parse(data);
          console.log('\n📊 Response:\n');
          console.log(JSON.stringify(response, null, 2));

          if (response.success === true && response.status === 1) {
            console.log('\n✅ VALIDATION PASSED!\n');
          } else if (response.log && Array.isArray(response.log)) {
            console.log('\n📋 Validation Log:\n');
            
            response.log.forEach((item, idx) => {
              const hasFailed = item.toLowerCase().includes('failed');
              const icon = hasFailed ? '❌' : '✓';
              console.log(`${idx + 1}. ${icon} ${item}`);
            });
          }
        } catch (e) {
          console.log('Response (raw):\n', data);
        }
        resolve();
      });
    });

    req.on('error', (error) => {
      console.error('Request error:', error.message);
      resolve();
    });

    req.end();
  });
}

validateSession();
