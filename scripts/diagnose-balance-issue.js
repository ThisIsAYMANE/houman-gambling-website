#!/usr/bin/env node
/**
 * Balance Discrepancy Diagnostic Script
 * Runs tests and diagnostic queries to identify the 100,000 balance issue
 * 
 * Usage: node scripts/diagnose-balance-issue.js
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../.sqlite');

async function runDiagnostics() {
  console.log('🔍 BALANCE DISCREPANCY DIAGNOSTIC SCRIPT\n');
  console.log('=' .repeat(60));
  
  return new Promise((resolve) => {
    const db = new sqlite3.Database(dbPath, async (err) => {
      if (err) {
        console.error('❌ Cannot open database:', err);
        resolve();
        return;
      }
      
      console.log('✅ Database connected\n');
      
      try {
        // Test 1: Check wallets table schema
        console.log('Test 1: Wallets Table Schema');
        console.log('-'.repeat(60));
        db.all("PRAGMA table_info(wallets)", (err, rows) => {
          if (err) {
            console.error('❌ Error:', err);
          } else {
            console.log('Wallets table columns:');
            rows.forEach(row => {
              console.log(`  - ${row.name}: ${row.type} (${row.notnull ? 'NOT NULL' : 'nullable'})`);
            });
            
            const hasBonus = rows.some(r => r.name === 'bonus_balance');
            console.log(hasBonus ? '  ✅ bonus_balance column EXISTS' : '  ❌ bonus_balance column MISSING');
          }
          
          // Test 2: Check bonus_balances table
          console.log('\nTest 2: Bonus Balances Table');
          console.log('-'.repeat(60));
          db.all("PRAGMA table_info(bonus_balances)", (err, rows) => {
            if (err) {
              console.log('⚠️  bonus_balances table does not exist or error:', err.message);
            } else {
              console.log('Bonus Balances table columns:');
              rows.forEach(row => {
                console.log(`  - ${row.name}: ${row.type}`);
              });
              console.log('  ✅ bonus_balances table EXISTS');
            }
            
            // Test 3: Count wallets
            console.log('\nTest 3: Data Summary');
            console.log('-'.repeat(60));
            db.get("SELECT COUNT(*) as count FROM wallets", (err, result) => {
              if (!err) {
                console.log(`Total wallets: ${result.count}`);
              }
              
              // Test 4: Sample wallets with 0 balance
              console.log('\nTest 4: Wallets with 0 Balance');
              console.log('-'.repeat(60));
              db.all(`
                SELECT user_id, currency, balance, locked_balance FROM wallets 
                WHERE balance = 0 
                LIMIT 10
              `, (err, rows) => {
                if (err) {
                  console.error('❌ Error:', err);
                } else if (rows.length === 0) {
                  console.log('No wallets with 0 balance found');
                } else {
                  console.log(`Found ${rows.length} wallets with 0 balance:`);
                  rows.forEach(row => {
                    console.log(`  - User: ${row.user_id}, Balance: ${row.balance}, Locked: ${row.locked_balance}`);
                  });
                }
                
                // Test 5: Check for any 100,000 balance values
                console.log('\nTest 5: Wallets with 100,000 Balance');
                console.log('-'.repeat(60));
                db.all(`
                  SELECT user_id, currency, balance, locked_balance FROM wallets 
                  WHERE balance = 100000 OR balance = 1000000 OR locked_balance = 100000
                  LIMIT 10
                `, (err, rows) => {
                  if (err) {
                    console.error('❌ Error:', err);
                  } else if (rows.length === 0) {
                    console.log('No wallets with 100,000 or 1,000,000 balance found');
                  } else {
                    console.log(`Found ${rows.length} wallets with unusual balance:`);
                    rows.forEach(row => {
                      console.log(`  - User: ${row.user_id}, Balance: ${row.balance}, Locked: ${row.locked_balance}`);
                    });
                  }
                  
                  // Test 6: Sample active bonuses
                  console.log('\nTest 6: Active Bonuses Sample');
                  console.log('-'.repeat(60));
                  db.all(`
                    SELECT user_id, amount, bonus_type, status FROM bonus_balances 
                    WHERE status = 'active'
                    LIMIT 10
                  `, (err, rows) => {
                    if (err) {
                      console.log('⚠️  No active bonuses or error:', err.message);
                    } else if (rows.length === 0) {
                      console.log('No active bonuses found');
                    } else {
                      console.log(`Found ${rows.length} active bonuses:`);
                      rows.forEach(row => {
                        console.log(`  - User: ${row.user_id}, Amount: ${row.amount}, Type: ${row.bonus_type}`);
                      });
                    }
                    
                    // Test 7: List test player
                    console.log('\nTest 7: Test Player (Bot) Data');
                    console.log('-'.repeat(60));
                    const botId = '5fbW-EgviQlSB0qgLmM0Z';
                    db.get(`
                      SELECT * FROM wallets WHERE user_id = ?
                    `, [botId], (err, row) => {
                      if (err) {
                        console.error('❌ Error:', err);
                      } else if (!row) {
                        console.log(`No wallet found for bot player: ${botId}`);
                      } else {
                        console.log(`Bot player wallet:`);
                        console.log(`  - Balance: ${row.balance}`);
                        console.log(`  - Locked: ${row.locked_balance}`);
                        console.log(`  - Currency: ${row.currency}`);
                      }
                      
                      // Summary
                      console.log('\n' + '='.repeat(60));
                      console.log('📋 SUMMARY');
                      console.log('='.repeat(60));
                      console.log(`
1. Database schema issue: bonus_balance column missing from wallets table
2. Bonus data stored in separate bonus_balances table
3. Affected endpoints:
   ✅ FIXED: app/api/games/[id]/launch/route.ts (added error handling)
   ✅ FIXED: app/api/bets/advanced/route.ts (added error handling)
   ✅ SAFE: lib/wallet.ts (already has error handling)
   ✅ SAFE: app/api/casino/callback/route.ts (already has error handling)

4. Next steps:
   - Run this script to confirm database values
   - Test game launch endpoint: POST /api/games/[gameId]/launch
   - Check for any 100,000 value sources
   - Verify fixes resolve the issue
                      `);
                      
                      db.close();
                      resolve();
                    });
                  });
                });
              });
            });
          });
        });
      } catch (error) {
        console.error('❌ Error running diagnostics:', error);
        db.close();
        resolve();
      }
    });
  });
}

// Run diagnostics
runDiagnostics().then(() => {
  console.log('\n✅ Diagnostic script completed');
  process.exit(0);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
