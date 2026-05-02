/**
 * Quick validation test using the real session you just played
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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

function calculateXSign(params, headers, merchantKey) {
  const merged = { ...params, ...headers };
  const sortedKeys = Object.keys(merged).sort();
  const queryString = sortedKeys
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(merged[k]))}`)
    .join('&');
  return crypto.createHmac('sha1', merchantKey).update(queryString).digest('hex');
}

function generateAuthHeaders(merchantId, merchantKey, params = {}) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const headers = {
    'X-Merchant-Id': merchantId,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
  };
  headers['X-Sign'] = calculateXSign(params, headers, merchantKey);
  return headers;
}

function makeRequest(endpoint, method = 'GET', params = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}${endpoint}`);
    let bodyData = '';

    const authHeaders = generateAuthHeaders(MERCHANT_ID, MERCHANT_KEY, params);

    const reqHeaders = {
      ...authHeaders,
      'Accept': 'application/json',
    };

    if (method === 'POST' && Object.keys(params).length > 0) {
      const form = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => form.append(k, String(v)));
      bodyData = form.toString();
      reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      reqHeaders['Content-Length'] = Buffer.byteLength(bodyData).toString();
    }

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: reqHeaders,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);
    if (method === 'POST' && bodyData) {
      req.write(bodyData);
    }
    req.end();
  });
}

async function test() {
  console.log('Testing /self-validate with real session...\n');
  
  // REPLACE THIS with the session ID from your game
  const sessionId = process.argv[2] || 'FD7C7FC55366482B8E2813BE67D6E8E0';
  
  console.log(`Testing with session: ${sessionId}\n`);
  
  const params = {
    session_id: sessionId,
    sign_to_verify: '550e8400e29b41d4a716446655440000'
  };
  
  const res = await makeRequest('/self-validate', 'POST', params);
  
  console.log('Status:', res.status);
  console.log('Response:', JSON.stringify(res.data, null, 2));
}

test().catch(console.error);
