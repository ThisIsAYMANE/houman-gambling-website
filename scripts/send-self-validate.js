/**
 * Send /self-validate POST request to Slotegrator
 * 
 * User manually launches game via /games/init in browser
 * Then run this script to validate the callback handlers
 * 
 * Usage: node scripts/send-self-validate.js
 */

const https = require('https');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Load .env
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    content.split('\n').forEach(line => {
      line = line.trim();
      if (line && !line.startsWith('#')) {
        const eqIdx = line.indexOf('=');
        if (eqIdx > 0) {
          const key = line.substring(0, eqIdx).trim();
          const value = line.substring(eqIdx + 1).trim();
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      }
    });
  }
}

loadEnv();

const MERCHANT_ID = process.env.CASINO_MERCHANT_ID;
const MERCHANT_KEY = process.env.CASINO_MERCHANT_KEY;
const BASE_URL = process.env.CASINO_API_BASE_URL || 'https://staging.slotegrator.com/api/index.php/v1';

if (!MERCHANT_ID || !MERCHANT_KEY) {
  console.error('❌ CASINO_MERCHANT_ID and CASINO_MERCHANT_KEY must be set in .env');
  process.exit(1);
}

console.log('✅ Configuration loaded:');
console.log(`   Merchant ID: ${MERCHANT_ID}`);
console.log(`   Base URL: ${BASE_URL}`);
console.log('');

function generateAuthHeaders(merchantId, merchantKey, params = {}) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  
  const signatureData = `${merchantId}${timestamp}${nonce}${JSON.stringify(params)}`;
  const signature = crypto.createHash('sha1').update(signatureData + merchantKey).digest('hex');
  
  return {
    'X-Merchant-Id': merchantId,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Sign': signature,
  };
}

function makeRequest(endpoint, method = 'POST', body = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}${endpoint}`);
    const authHeaders = generateAuthHeaders(MERCHANT_ID, MERCHANT_KEY, body);
    
    const bodyStr = JSON.stringify(body);
    
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: method,
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function run() {
  console.log('📡 Sending POST /self-validate to Slotegrator...\n');

  try {
    const validateRes = await makeRequest('/self-validate', 'POST', {});
    
    console.log(`Response Status: ${validateRes.status}\n`);
    console.log('Response Data:');
    console.log(JSON.stringify(validateRes.data, null, 2));
    
    // Check results
    if (validateRes.data && validateRes.data.success === true && validateRes.data.status === 1) {
      console.log('\n✅✅✅ VALIDATION PASSED! ✅✅✅');
      console.log('Your callback handlers are working correctly!');
    } else if (validateRes.data && validateRes.data.log) {
      console.log('\n❌ Validation failed');
      console.log('Errors/Warnings:');
      validateRes.data.log.forEach((msg, idx) => {
        if (msg.toLowerCase().includes('failed')) {
          console.log(`  [${idx + 1}] ❌ ${msg}`);
        } else {
          console.log(`  [${idx + 1}] ${msg}`);
        }
      });
    }
  } catch (err) {
    console.error('❌ Request failed:', err.message);
    process.exit(1);
  }
}

run();
