const fs = require('fs');
const data = JSON.parse(fs.readFileSync('hahaha.json', 'utf8'));
const logs = data.log;
console.log(`success: ${data.success}, status: ${data.status}`);
console.log(`\n=== FULL TEXT LOG (hahaha.json) ===\n`);
for (let i = 0; i < logs.length; i++) {
  const l = logs[i];
  if (typeof l !== 'string') continue;
  if (l.startsWith('{') && l.length > 200) continue;
  console.log(`[${i}] ${l.substring(0, 150)}`);
}
