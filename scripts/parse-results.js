const fs = require('fs');
const files = fs.readdirSync('.').filter(f => f.startsWith('validation_result_')).sort().reverse();
if (!files.length) { console.log('No results found'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(files[0], 'utf8'));
console.log(`File: ${files[0]}`);
console.log(`success: ${data.success}`);
console.log(`status: ${data.status}`);
console.log(`\n=== PASS/FAIL SUMMARY ===\n`);
const logs = data.log || [];
logs.forEach((l, i) => {
  if (typeof l !== 'string') return;
  if (l.includes('passed')) console.log(`✅ [${i}] ${l.substring(0, 140)}`);
  else if (l.includes('failed')) console.log(`❌ [${i}] ${l.substring(0, 140)}`);
  else if (l.includes('rejected')) console.log(`✅ [${i}] ${l.substring(0, 140)}`);
  else if (l.includes('should fail')) console.log(`⚠️  [${i}] ${l.substring(0, 140)}`);
});
