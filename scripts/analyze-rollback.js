const fs = require('fs');
const files = fs.readdirSync('.').filter(f => f.startsWith('validation_result_')).sort().reverse();
const data = JSON.parse(fs.readFileSync(files[0], 'utf8'));
const logs = data.log;

// Find rollback-related entries
for (let i = 0; i < logs.length; i++) {
  const l = logs[i];
  if (typeof l !== 'string') continue;
  if (l.includes('rollback') || l.includes('Rollback') || l.includes('Exceeded')) {
    console.log(`[${i}] ${l.substring(0, 200)}`);
    // If next entry is a JSON object, parse it for rollback_transactions
    if (i+1 < logs.length && typeof logs[i+1] === 'string' && logs[i+1].startsWith('{')) {
      try {
        const detail = JSON.parse(logs[i+1]);
        if (detail.query) {
          console.log(`     -> action: ${detail.query.action}, amount: ${detail.query.amount}, player: ${detail.query.player_id}`);
          if (detail.query.rollback_transactions) {
            console.log(`     -> rollback_transactions:`, JSON.stringify(detail.query.rollback_transactions));
          }
          // Check the HTTP response
          if (detail.curlInfo) {
            console.log(`     -> HTTP: ${detail.curlInfo.http_code}`);
          }
          // Check raw response for balance
          if (detail['raw response']) {
            try {
              const resp = JSON.parse(detail['raw response']);
              console.log(`     -> Response: balance=${resp.balance}, tx=${resp.transaction_id}, rollback_txs=${JSON.stringify(resp.rollback_transactions)}`);
            } catch(e) {
              console.log(`     -> Raw response (first 200): ${detail['raw response'].substring(0, 200)}`);
            }
          }
        }
      } catch(e) {}
    }
  }
}
