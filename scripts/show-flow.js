const fs = require('fs');
const files = fs.readdirSync('.').filter(f => f.startsWith('validation_result_')).sort().reverse();
const data = JSON.parse(fs.readFileSync(files[0], 'utf8'));
const logs = data.log;

// Print ALL non-JSON log entries to see the full test flow
for (let i = 0; i < logs.length; i++) {
  const l = logs[i];
  if (typeof l !== 'string') continue;
  // Skip huge JSON blocks
  if (l.startsWith('{') && l.length > 200) continue;
  console.log(`[${i}] ${l.substring(0, 150)}`);
}
