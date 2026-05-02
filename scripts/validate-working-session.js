const crypto = require('crypto');
const https = require('https');

const MERCHANT_ID = 'dbb46701285c1a2e24a0bf92f00501e5';
const MERCHANT_KEY = 'f0c0ef35b5e8c8f6bb18e5c7fa6eab19';

// This session comes from your successful callback data (batata.json)
// It's the one that Slotegrator actually created and is sending callbacks for
const sessionPayload = {
    player_id: "5fbW-EgviQlSB0qgLmM0Z",
    session_id: "session_5fbW-EgviQlSB0qgLmM0Z_1775007610989_359z6y"
};

async function validateSession() {
  const body = JSON.stringify(sessionPayload);
  
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
      'Content-Length': Buffer.byteLength(body),
      'X-Merchant-Id': MERCHANT_ID,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Sign': signature
    }
  };

  console.log('\n🧪 Testing Working Slotegrator Session\n');
  console.log('📍 Session Details:');
  console.log(`   Player ID: ${sessionPayload.player_id}`);
  console.log(`   Session ID: ${sessionPayload.session_id}`);
  console.log(`   Source: Slotegrator (proven by successful callbacks in batata.json)\n`);
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
          console.log('\n📊 Validation Response:\n');
          console.log(JSON.stringify(response, null, 2));

          if (response.success === true && response.status === 1) {
            console.log('\n✅✅✅ VALIDATION PASSED! ✅✅✅\n');
            console.log('🎉 Your callback handlers are working correctly!\n');
          } else if (response.log && Array.isArray(response.log)) {
            console.log('\n📋 Validation Log:\n');
            
            response.log.forEach((item, idx) => {
              const hasFailed = item.toLowerCase().includes('failed');
              const icon = hasFailed ? '❌' : '✓';
              console.log(`${idx + 1}. ${icon} ${item}`);
            });
            
            const failedCount = response.log.filter(item => item.toLowerCase().includes('failed')).length;
            if (failedCount > 0) {
              console.log(`\n❌ Found ${failedCount} validation error(s)\n`);
            } else {
              console.log('\n✅ No errors found in validation log\n');
            }
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

    req.write(body);
    req.end();
  });
}

validateSession();
