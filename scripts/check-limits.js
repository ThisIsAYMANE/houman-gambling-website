/**
 * Check Slotegrator limits/currencies and test a game init with EUR
 */
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
          if (!process.env[key]) process.env[key] = value;
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
  const headers = { 'X-Merchant-Id': merchantId, 'X-Timestamp': timestamp, 'X-Nonce': nonce };
  headers['X-Sign'] = calculateXSign(params, headers, merchantKey);
  return headers;
}

function makeRequest(endpoint, method = 'GET', params = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}${endpoint}`);
    let bodyData = '';
    if (method === 'GET' && Object.keys(params).length > 0) {
      Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, String(v)));
    }
    const authHeaders = generateAuthHeaders(MERCHANT_ID, MERCHANT_KEY, params);
    const reqHeaders = { ...authHeaders, 'Accept': 'application/json' };
    if (method === 'POST' && Object.keys(params).length > 0) {
      const form = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => form.append(k, String(v)));
      bodyData = form.toString();
      reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      reqHeaders['Content-Length'] = Buffer.byteLength(bodyData).toString();
    }
    const lib = url.protocol === 'https:' ? https : http;
    const options = { hostname: url.hostname, path: url.pathname + url.search, method, headers: reqHeaders };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data), raw: data }); }
        catch { resolve({ status: res.statusCode, data: data, raw: data }); }
      });
    });
    req.on('error', reject);
    if (method === 'POST' && bodyData) req.write(bodyData);
    req.end();
  });
}

async function main() {
  console.log('=== Checking Merchant Limits ===\n');
  
  const limitsRes = await makeRequest('/limits');
  console.log('Status:', limitsRes.status);
  console.log('Limits:', JSON.stringify(limitsRes.data, null, 2));
  
  console.log('\n=== Testing /games/init with EUR ===\n');
  
  // Get a game UUID first
  const gamesRes = await makeRequest('/games', 'GET', { page: 1 });
  const games = gamesRes.data.items || [];
  const game = games.find(g => g.has_lobby === 0) || games[0];
  
  console.log('Using game:', game ? `${game.name} (${game.uuid})` : 'none found');
  
  if (game) {
    // Try EUR
    const sessionId = `sess_eur_${Date.now()}`;
    const initParams = {
      game_uuid: game.uuid,
      player_id: 'test_player_001',
      player_name: 'Test Player',
      currency: 'EUR',
      session_id: sessionId,
      device: 'desktop',
      return_url: 'https://boztestarea.ngrok.app',
      language: 'en',
    };
    const eurRes = await makeRequest('/games/init', 'POST', initParams);
    console.log('EUR /games/init status:', eurRes.status);
    console.log('EUR /games/init response:', JSON.stringify(eurRes.data, null, 2));
    
    if (eurRes.status === 200 && eurRes.data.url) {
      console.log('\n✅ EUR works! Game URL:', eurRes.data.url);
    }
  }
}

main().catch(console.error);
