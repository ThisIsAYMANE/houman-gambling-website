/**
 * Slotegrator Self-Validation Script
 * 
 * Performs the full self-validation flow:
 * 1. Fetches limits to get enabled providers
 * 2. Fetches a valid game UUID from an enabled provider
 * 3. Calls POST /games/init to create an active session
 * 4. Waits (do NOT touch the game)
 * 5. Calls POST /self-validate
 * 6. Displays the full validation log
 * 
 * Usage: node scripts/run-self-validate.js [currency]
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Load .env file manually
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
const CALLBACK_URL = process.env.CASINO_CALLBACK_URL || 'https://bozcallback.ngrok.app/api/casino/callback';
const RETURN_URL = process.env.CASINO_TEST_AREA_URL || 'https://boztestarea.ngrok.app';
// Allow override via command line arg; default EUR (confirmed enabled in /limits)
const CURRENCY = process.argv[2] || 'EUR';

if (!MERCHANT_ID || !MERCHANT_KEY) {
  console.error('❌ CASINO_MERCHANT_ID and CASINO_MERCHANT_KEY must be set in .env');
  process.exit(1);
}

console.log('✅ Configuration loaded:');
console.log(`   Merchant ID: ${MERCHANT_ID}`);
console.log(`   Merchant Key: ${MERCHANT_KEY.substring(0, 8)}...`);
console.log(`   Base URL: ${BASE_URL}`);
console.log(`   Callback URL: ${CALLBACK_URL}`);
console.log(`   Currency: ${CURRENCY}`);
console.log('');

// ============ Auth ============

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

// ============ HTTP Request ============

function makeRequest(endpoint, method = 'GET', params = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}${endpoint}`);
    let bodyData = '';

    if (method === 'GET' && Object.keys(params).length > 0) {
      Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, String(v)));
    }

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

    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: reqHeaders,
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data), raw: data });
        } catch {
          resolve({ status: res.statusCode, data: data, raw: data });
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ Main Flow ============

async function runSelfValidation() {
  console.log('============================================');
  console.log('   SLOTEGRATOR SELF-VALIDATION PROCESS');
  console.log('============================================\n');

  // ─── Step 1: Get enabled providers and a valid game UUID ─────────────────
  console.log('📋 STEP 1: Fetching limits to find enabled providers...');

  const limitsRes = await makeRequest('/limits');
  let enabledProviders = [];
  if (limitsRes.status === 200 && Array.isArray(limitsRes.data)) {
    const currencyLimit = limitsRes.data.find(l => l.currency === CURRENCY);
    if (currencyLimit) {
      enabledProviders = currencyLimit.providers || [];
      console.log(`✅ Found ${enabledProviders.length} enabled providers for ${CURRENCY}: ${enabledProviders.slice(0, 5).join(', ')}...`);
    } else {
      console.warn(`⚠️  No limits found for ${CURRENCY}. Available: ${limitsRes.data.map(l => l.currency).join(', ')}`);
    }
  }

  console.log('\n   Fetching games...');
  let gameUuid = null;
  let gameProvider = null;
  let gameName = null;
  let gameHasLobby = false;

  // Search multiple pages to find a game from an enabled provider
  // First try: games WITHOUT lobby (has_lobby === 0)
  // Fallback: games WITH lobby (has_lobby === 1) - will call /games/lobby first
  
  const gamesList = [];
  const lobbyGamesList = [];
  const nonLobbyGamesList = [];
  
  outer: for (let page = 1; page <= 5; page++) {
    const gamesRes = await makeRequest('/games', 'GET', { page });
    if (gamesRes.status !== 200) break;
    const games = gamesRes.data.items || [];
    if (games.length === 0) break;
    console.log(`   Page ${page}: ${games.length} games`);

    for (const g of games) {
      if (enabledProviders.length > 0 && !enabledProviders.includes(g.provider)) continue;
      gamesList.push(g);
      
      if (g.has_lobby === 1) {
        lobbyGamesList.push(g);
      } else {
        nonLobbyGamesList.push(g);
      }
    }
  }

  console.log(`   Found: ${lobbyGamesList.length} games with lobby, ${nonLobbyGamesList.length} games without lobby`);

  // Primary: Try games WITH lobby first (has_lobby === 1)
  if (lobbyGamesList.length > 0) {
    const g = lobbyGamesList[0];
    gameUuid = g.uuid;
    gameProvider = g.provider;
    gameName = g.name;
    gameHasLobby = true;
    console.log(`   → Selected lobby game: ${gameName}`);
  } else if (nonLobbyGamesList.length > 0) {
    // Fallback: if no lobby game found, use first non-lobby game
    const g = nonLobbyGamesList[0];
    gameUuid = g.uuid;
    gameProvider = g.provider;
    gameName = g.name;
    gameHasLobby = false;
    console.log(`   → Selected non-lobby game: ${gameName}`);
  }

  if (!gameUuid) {
    console.error('❌ No suitable game found');
    process.exit(1);
  }

  console.log(`✅ Selected game: "${gameName}"${gameHasLobby ? ' (requires lobby)' : ''}`);
  console.log(`   UUID: ${gameUuid}`);
  console.log(`   Provider: ${gameProvider}`);
  console.log('');

  // ─── Step 2: POST /games/init ─────────────────────────────────────────────
  // Define player at outer scope so it's available for /self-validate
  const playerId = '5fbW-EgviQlSB0qgLmM0Z'; // Special bot player for self-validation
  const playerName = 'Test';
  let sessionId;

  const recentActiveSession = process.env.SLOTEGRATOR_TEST_SESSION || null;
  const usingReusedSession = !!recentActiveSession;
  
  let initRes = null;

  if (usingReusedSession) {
    console.log('🔄 STEP 2: Using reused active session - skipping /games/init');
    console.log(`   Session ID: ${recentActiveSession}`);
    sessionId = recentActiveSession;
  } else {
    console.log('🚀 STEP 2: Launching game via POST /games/init...');
    
    sessionId = `session_${playerId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    let lobbyData = null;
    
    if (gameHasLobby) {
      console.log(`   Fetching lobby data for lobby game...`);
      const lobbyRes = await makeRequest('/games/lobby', 'GET', {
        game_uuid: gameUuid,
        currency: CURRENCY
      });
      
      console.log(`   /games/lobby response:`, JSON.stringify(lobbyRes.data, null, 2));
      
      if (lobbyRes.status === 200 && lobbyRes.data && lobbyRes.data.lobby) {
        const lobbyItem = Array.isArray(lobbyRes.data.lobby) ? lobbyRes.data.lobby[0] : lobbyRes.data.lobby;
        if (lobbyItem && lobbyItem.lobbyData) {
          lobbyData = lobbyItem.lobbyData;
          console.log(`   ✅ Got lobby data: ${lobbyData}`);
        }
      }
      
      if (!lobbyData) {
        console.warn(`   ⚠️  Expected lobby data for lobby game but got none.`);
      }
    }

    const initParams = {
      game_uuid: gameUuid,
      player_id: playerId,
      player_name: playerName,
      currency: CURRENCY,
      session_id: sessionId,
      device: 'desktop',
      return_url: RETURN_URL,
      language: 'en',
      email: 'test@example.com',
    };
    
    if (lobbyData) {
      initParams.lobby_data = lobbyData;
    }

    console.log('   Init params:', JSON.stringify(initParams, null, 2));

    initRes = await makeRequest('/games/init', 'POST', initParams);

    console.log(`   /games/init response status: ${initRes.status}`);
    console.log(`   /games/init response: ${JSON.stringify(initRes.data, null, 2)}`);

    if (initRes.status !== 200 || !initRes.data.url) {
      console.error(`❌ /games/init failed. The game session could not be created.`);
      console.error(`   Status: ${initRes.status}`);
      console.error(`   Response: ${JSON.stringify(initRes.data)}`);
      console.log('\n⚠️  Attempting /self-validate anyway in case a previous session is still active...\n');
    } else {
      const gameUrl = initRes.data.url;
      console.log(`\n✅ Game launched successfully!`);
      console.log(`   Game URL: ${gameUrl}`);
      console.log(`   Session ID: ${sessionId}`);
      console.log(`\n   👉 Open this URL in your browser and do NOT interact with the game.`);
      console.log(`   Game URL: ${gameUrl}`);
      console.log('');
    }
  } // end else (new session)

  // ─── Step 3: Wait (don't touch the game) ──────────────────────────────────
  const waitSecs = (initRes && initRes.status === 200) ? 30 : 2;
  console.log(`⏳ STEP 3: Waiting ${waitSecs} seconds (do NOT interact with the game)...`);
  for (let i = waitSecs; i > 0; i--) {
    process.stdout.write(`   ${i}...\r`);
    await sleep(1000);
  }
  console.log('   Done waiting!                    ');
  console.log('');

  // ─── Step 4: POST /self-validate ──────────────────────────────────────────
  console.log('🔍 STEP 4: Sending POST /self-validate to Slotegrator staging...');

  const validateRes = await makeRequest('/self-validate', 'POST', {
    session_id: sessionId,
    player_id: playerId,
    currency: CURRENCY,
  });

  console.log(`   Response status: ${validateRes.status}`);
  console.log('');

  // ─── Display Results ──────────────────────────────────────────────────────
  console.log('============================================');
  console.log('   SELF-VALIDATION RESULTS');
  console.log('============================================\n');

  const result = validateRes.data;

  if (typeof result === 'string') {
    console.log('Raw response:', result);
  } else {
    if (result.success === true || result.status === 1) {
      console.log('✅ SUCCESS: status: 1 and success: true\n');
    } else if (result.success === false) {
      console.log('❌ VALIDATION FAILED - Check log for details\n');
    }

    if (result.log) {
      console.log('📄 FULL VALIDATION LOG:');
      console.log('─'.repeat(60));
      const logLines = Array.isArray(result.log) ? result.log : [result.log];
      logLines.forEach((line, i) => {
        const isFailed = typeof line === 'string' && line.toLowerCase().includes('failed');
        const prefix = isFailed ? '❌' : '  ';
        console.log(`${prefix} [${i + 1}] ${line}`);
      });
      console.log('─'.repeat(60));

      const failures = logLines.filter(l => typeof l === 'string' && l.toLowerCase().includes('failed'));
      if (failures.length > 0) {
        console.log(`\n⚠️  Found ${failures.length} failure(s):`);
        failures.forEach(f => console.log(`   - ${f}`));
      } else {
        console.log('\n✅ No failures found in log!');
      }
    }

    // Save results to file
    const fs = require('fs');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFile = `validation_result_${timestamp}.json`;
    fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));
    console.log(`\n💾 Results saved to: ${outputFile}`);

    console.log('\n📊 Full JSON Response:');
    console.log(JSON.stringify(result, null, 2));
  }

  console.log('\n============================================');
  console.log('   Process complete. Send the above log');
  console.log('   to Slotegrator for manual review.');
  console.log('============================================\n');
}

runSelfValidation().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
