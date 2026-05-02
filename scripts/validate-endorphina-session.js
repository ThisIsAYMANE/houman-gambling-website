const crypto = require('crypto');
const https = require('https');

const MERCHANT_ID = 'dbb46701285c1a2e24a0bf92f00501e5';
const MERCHANT_KEY = 'f0c0ef35b5e8c8f6bb18e5c7fa6eab19';

const sessionData = {
    "server_timestamp": 1775082505,
    "player": {
        "player": "414097",
        "node_id": 479,
        "server_id": 77,
        "session": {
            "id": "8C4581118AC3449DA10F63AC4696A5E9",
            "countryCode": "MA",
            "serverId": 77,
            "nodeId": 479,
            "gameId": "endorphina_Macaroons@ENDORPHINA",
            "currency": "EUR",
            "player": "414097",
            "nickname": "1b545943fa964e82b10a45789c1332fb",
            "date": 1775082498396,
            "state": "CREATED",
            "active": true
        },
        "public_name": "77-479-41-4097",
        "_id": "69cc44502dfd98b01a36487c"
    },
    "progresses": [],
    "prizes": [],
    "events": {
        "in_other_games": [],
        "in_this_game": []
    }
};

async function validateSession() {
  const body = JSON.stringify(sessionData);
  
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

  console.log('\n🧪 Testing Endorphina Session Validation\n');
  console.log('📍 Session Details:');
  console.log(`   Player ID: ${sessionData.player.player}`);
  console.log(`   Session ID: ${sessionData.player.session.id}`);
  console.log(`   Game: ${sessionData.player.session.gameId}`);
  console.log(`   Currency: ${sessionData.player.session.currency}`);
  console.log(`   State: ${sessionData.player.session.state}\n`);
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
            console.log('\n✅ VALIDATION PASSED!\n');
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
              console.log('\n✅ No errors found in log\n');
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
