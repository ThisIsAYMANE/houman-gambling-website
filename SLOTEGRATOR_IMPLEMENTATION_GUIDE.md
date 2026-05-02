# Slotegrator Casino API - Complete Implementation Guide

This guide documents the complete implementation of Slotegrator Casino API integration, including all errors encountered, bugs fixed, and step-by-step instructions for implementing in a new project.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Initial Setup](#initial-setup)
3. [Core Implementation](#core-implementation)
4. [Common Errors & Solutions](#common-errors--solutions)
5. [Database Schema](#database-schema)
6. [Testing Checklist](#testing-checklist)
7. [Best Practices](#best-practices)

---

## Prerequisites

### Required Environment Variables

```env
# Slotegrator API Credentials
CASINO_MERCHANT_ID=your-merchant-id-here
CASINO_MERCHANT_KEY=your-merchant-key-here
CASINO_API_BASE_URL=https://staging.slotegrator.com/api/index.php/v1
# OR for production:
# CASINO_API_BASE_URL=https://api.slotegrator.com/api/index.php/v1

# Default Currency (must match enabled currencies in your contract)
CASINO_DEFAULT_CURRENCY=EUR

# Optional: Test area URL for return redirects
CASINO_TEST_AREA_URL=https://your-test-area-url.com
```

### Required Dependencies

```json
{
  "dependencies": {
    "better-sqlite3": "^9.x", // or your database driver
    "nanoid": "^5.x",
    "crypto": "built-in" // Node.js built-in
  }
}
```

---

## Initial Setup

### Step 1: Create Casino API Client (`lib/casino-api.ts`)

This is the core API client that handles all Slotegrator API communication.

**Key Features:**
- X-Sign authentication (SHA1 HMAC)
- Request/response logging
- Error handling
- Type-safe interfaces

**Critical Implementation Points:**

1. **X-Sign Calculation** (Lines 45-70):
   ```typescript
   export function calculateXSign(
     params: Record<string, any>,
     headers: Record<string, string>,
     merchantKey: string
   ): string {
     // Merge params and headers
     const mergedParams = { ...params, ...headers }
     // Sort by key (ascending)
     const sortedKeys = Object.keys(mergedParams).sort()
     // Build query string
     const queryString = sortedKeys
       .map((key) => {
         const value = mergedParams[key]
         return `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
       })
       .join('&')
     // Generate SHA1 HMAC
     const signature = crypto
       .createHmac('sha1', merchantKey)
       .update(queryString)
       .digest('hex')
     return signature
   }
   ```

2. **Request Logging** - Always log full request/response for debugging

3. **Error Handling** - Capture full error details including request/response

### Step 2: Database Schema

Create the following tables:

#### `game_sessions` Table
```sql
CREATE TABLE game_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL, -- Slotegrator UUID (NO foreign key!)
  session_token TEXT NOT NULL,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMP,
  initial_balance REAL NOT NULL,
  total_bet REAL DEFAULT 0,
  total_win REAL DEFAULT 0,
  session_duration INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### `recent_games` Table
```sql
CREATE TABLE recent_games (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL, -- Slotegrator UUID (NO foreign key!)
  last_played TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, game_id)
);
```

**⚠️ CRITICAL:** Do NOT add foreign key constraints on `game_id` - these are Slotegrator UUIDs that don't exist in your local games table!

---

## Core Implementation

### Step 3: Game Launch Flow

The game launch follows this flow (per Slotegrator documentation):

#### For Games WITHOUT Lobby:
1. Call `POST /games/init`
2. Redirect player to provided URL

#### For Games WITH Lobby:
1. Call `GET /games/lobby` first
2. Call `POST /games/init` with `lobby_data` from step 1
3. Redirect player to provided URL

**Implementation in `app/api/games/[id]/launch/route.ts`:**

```typescript
// 1. Check if game requires lobby
const gameDetails = await getGames({ maxPages: 10 })
const game = gameDetails.items.find(g => g.uuid === gameId)

let lobbyData: string | undefined = undefined

if (game?.has_lobby === 1) {
  // Game requires lobby - call /games/lobby first
  const lobbyResponse = await getGameLobby(gameId, userCurrency)
  lobbyData = lobbyResponse.lobby.lobbyData
}

// 2. Initialize game session
const providerSession = await initializeGameSession(
  gameId,
  userId,
  totalBalance,
  { lobbyData } // Pass lobby_data if required
)

// 3. Store session in database
await query(
  `INSERT INTO game_sessions (id, user_id, game_id, session_token, started_at, initial_balance) 
   VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
  [sessionId, userId, gameId, providerSession.sessionId, totalBalance]
)
```

### Step 4: Provider Enablement Check

**⚠️ CRITICAL:** Providers are enabled PER CURRENCY, not globally!

```typescript
// Get enabled providers for USER'S currency (not hardcoded!)
const userCurrency = profile?.currency || 'EUR'
const enabledProviders = await getEnabledProviders(userCurrency)

// Check if game's provider is enabled for this currency
const isEnabled = enabledProviders.has(game.provider)

if (!isEnabled) {
  return NextResponse.json(
    { error: 'This provider is not enabled for your contract' },
    { status: 403 }
  )
}
```

**Common Mistake:** Checking providers for USD when user has EUR currency.

---

## Common Errors & Solutions

### Error 1: "This provider is not enabled for your contract"

**Root Cause:**
- Provider enablement is currency-specific
- Checking wrong currency
- User's currency doesn't match enabled providers

**Solution:**
1. Always check providers for the USER's currency, not a hardcoded value
2. Verify user's currency in database matches enabled currencies
3. Check `/limits` endpoint to see which currencies have which providers

**Fix:**
```typescript
// ❌ WRONG - hardcoded currency
const providers = await getEnabledProviders('USD')

// ✅ CORRECT - use user's currency
const userCurrency = profile?.currency || 'EUR'
const providers = await getEnabledProviders(userCurrency)
```

### Error 2: "FOREIGN KEY constraint failed" on `game_sessions`

**Root Cause:**
- `user_id` doesn't exist in `users` table
- Session references deleted user

**Solution:**
1. Always verify user exists before inserting:
```typescript
const userExists = await queryOne(
  'SELECT id FROM users WHERE id = ?',
  [userId]
)
if (!userExists) {
  return NextResponse.json(
    { error: 'User account not found. Please log in again.' },
    { status: 404 }
  )
}
```

2. Ensure user creation includes all required tables (users, user_profiles, wallets)

### Error 3: "FOREIGN KEY constraint failed" on `recent_games`

**Root Cause:**
- `recent_games.game_id` has foreign key to local `games` table
- But we're using Slotegrator UUIDs that don't exist locally

**Solution:**
Remove foreign key constraint on `game_id`:
```sql
-- Migration to fix
CREATE TABLE recent_games_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL, -- NO foreign key!
  last_played TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, game_id)
);
```

### Error 4: "no such table: game_sessions"

**Root Cause:**
- Database migration not run
- Table doesn't exist

**Solution:**
1. Create migration file
2. Run migrations: `npm run db:migrate` or `npx tsx scripts/migrate.ts`

### Error 5: Currency selector not saving

**Root Cause:**
- Currency selector UI not connected to API
- No PUT endpoint for profile updates

**Solution:**
1. Create `PUT /api/user/profile` endpoint
2. Connect UI to save currency changes
3. Update both `user_profiles` and `wallets` tables

### Error 6: Games with lobby fail to launch

**Root Cause:**
- Not calling `/games/lobby` before `/games/init`
- Missing `lobby_data` parameter

**Solution:**
Always check `has_lobby` field and call lobby endpoint first:
```typescript
if (game.has_lobby === 1) {
  const lobbyResponse = await getGameLobby(gameId, currency)
  lobbyData = lobbyResponse.lobby.lobbyData
}
```

---

## Database Schema

### Required Tables

1. **users** - User accounts
2. **user_profiles** - User preferences (including currency)
3. **wallets** - User balances
4. **sessions** - Authentication sessions
5. **game_sessions** - Active game sessions
6. **recent_games** - Game play history
7. **casino_transactions** - Transaction tracking (for webhooks)

### Migration Files Needed

1. `010_game_sessions.sqlite.sql` - Game sessions table
2. `011_fix_recent_games_foreign_key.sqlite.sql` - Remove FK constraint

---

## Testing Checklist

### Pre-Launch Checks

- [ ] Environment variables set correctly
- [ ] Merchant ID and Key are valid (not placeholders)
- [ ] Database migrations run successfully
- [ ] User has valid currency set (matches enabled providers)
- [ ] Foreign key constraints removed from `game_id` columns

### Game Launch Tests

- [ ] Games without lobby launch successfully
- [ ] Games with lobby call `/games/lobby` first
- [ ] Provider enablement checked for user's currency
- [ ] Game session created in database
- [ ] Recent games tracked correctly
- [ ] Error handling works for disabled providers

### Currency Tests

- [ ] User can change currency in settings
- [ ] Currency change updates both profile and wallet
- [ ] Provider check uses correct currency
- [ ] Games filtered by enabled providers for currency

### Error Scenarios

- [ ] Invalid game ID returns 400
- [ ] Unauthenticated user returns 401
- [ ] Disabled provider returns 403
- [ ] Missing user returns 404
- [ ] Database errors handled gracefully

---

## Best Practices

### 1. Always Log API Requests/Responses

```typescript
// Log full request
console.log('[Casino API Request]', {
  endpoint,
  method,
  url,
  headers: { ...headers, 'X-Sign': '***masked***' },
  body
})

// Log full response
console.log('[Casino API Response]', {
  status,
  statusText,
  headers,
  body
})
```

### 2. Cache Provider Lists

```typescript
const enabledProviders = await getCachedData(
  `enabled-providers-${currency}`,
  async () => {
    const providers = await getEnabledProviders(currency)
    return Array.from(providers)
  },
  3600000 // Cache for 1 hour
)
```

### 3. Validate User Currency

Always check user's currency before provider checks:
```typescript
const profile = await queryOne(
  'SELECT currency FROM user_profiles WHERE user_id = ?',
  [userId]
)
const userCurrency = profile?.currency || process.env.CASINO_DEFAULT_CURRENCY || 'EUR'
```

### 4. Handle Lobby Games

Always check `has_lobby` field:
```typescript
if (game.has_lobby === 1) {
  // Must call /games/lobby first
  const lobby = await getGameLobby(gameId, currency)
  lobbyData = lobby.lobby.lobbyData
}
```

### 5. Error Messages

Provide clear, user-friendly error messages:
```typescript
if (!isEnabled) {
  return NextResponse.json(
    { 
      error: 'This game is not available',
      message: 'This provider is not enabled for your contract'
    },
    { status: 403 }
  )
}
```

### 6. Database Constraints

**DO:**
- Keep foreign keys on `user_id` (references your users table)
- Use `ON DELETE CASCADE` for cleanup

**DON'T:**
- Add foreign keys on `game_id` (Slotegrator UUIDs)
- Assume games exist in local database

---

## Implementation Steps Summary

1. ✅ Set up environment variables
2. ✅ Create `lib/casino-api.ts` with X-Sign authentication
3. ✅ Implement `getGames()` - fetch games list
4. ✅ Implement `getEnabledProviders()` - check provider enablement
5. ✅ Implement `getGameLobby()` - for lobby games
6. ✅ Implement `initializeGameSession()` - launch games
7. ✅ Create database tables (game_sessions, recent_games)
8. ✅ Create launch endpoint with full flow
9. ✅ Add currency management (settings page)
10. ✅ Add error handling and logging
11. ✅ Test with different currencies
12. ✅ Test with lobby and non-lobby games

---

## Key Files Reference

### Core Files
- `lib/casino-api.ts` - API client with authentication
- `app/api/games/[id]/launch/route.ts` - Game launch endpoint
- `lib/file-logger.ts` - Logging utility

### Database Migrations
- `sql/migrations/010_game_sessions.sqlite.sql`
- `sql/migrations/011_fix_recent_games_foreign_key.sqlite.sql`

### API Endpoints
- `GET /api/games` - List games
- `POST /api/games/[id]/launch` - Launch game
- `PUT /api/user/profile` - Update currency
- `GET /api/games/find-working` - Find working games

---

## Documentation References

- Slotegrator API Documentation: `CASINO_API_DOCUMENTATION.md`
- Key sections:
  - Lines 169-178: Game Launch Flow
  - Lines 369-388: POST /games/init
  - Lines 315-365: GET /games/lobby
  - Lines 416-434: GET /limits (Provider enablement)

---

## Quick Start Checklist

Use this checklist when implementing in a new project:

### Phase 1: Setup (30 minutes)
- [ ] Copy `lib/casino-api.ts` to new project
- [ ] Set environment variables (MERCHANT_ID, MERCHANT_KEY, BASE_URL)
- [ ] Install dependencies (better-sqlite3, nanoid, crypto)
- [ ] Test API connection with `/self-validate` endpoint

### Phase 2: Database (15 minutes)
- [ ] Create `game_sessions` table (migration 010)
- [ ] Create `recent_games` table WITHOUT foreign key on game_id
- [ ] Run migrations
- [ ] Verify tables created correctly

### Phase 3: Core Functions (1 hour)
- [ ] Implement `getGames()` - fetch games list
- [ ] Implement `getEnabledProviders()` - check providers per currency
- [ ] Implement `getGameLobby()` - for lobby games
- [ ] Implement `initializeGameSession()` - launch games
- [ ] Test each function individually

### Phase 4: Launch Endpoint (1 hour)
- [ ] Create `POST /api/games/[id]/launch` endpoint
- [ ] Add user validation
- [ ] Add currency check
- [ ] Add provider enablement check
- [ ] Add lobby handling
- [ ] Add error handling

### Phase 5: Currency Management (30 minutes)
- [ ] Create `PUT /api/user/profile` endpoint
- [ ] Connect currency selector to API
- [ ] Test currency changes

### Phase 6: Testing (1 hour)
- [ ] Test with EUR currency (most common)
- [ ] Test with different currencies
- [ ] Test lobby games
- [ ] Test non-lobby games
- [ ] Test error scenarios

---

## Troubleshooting

### Check Logs
- Server console for API requests/responses
- `logs/YYYY-MM-DD_api_request.log`
- `logs/YYYY-MM-DD_api_response.log`
- `logs/YYYY-MM-DD_game_launch.log`

### Common Issues

1. **500 Error on Launch**
   - Check server logs for specific error
   - Verify database tables exist
   - Check foreign key constraints
   - Verify user exists in database

2. **Provider Not Enabled**
   - Verify user's currency matches enabled currencies
   - Check `/limits` endpoint response
   - Ensure provider is enabled for that currency
   - **Most common:** User has USD but providers enabled for EUR

3. **Lobby Games Fail**
   - Check if `has_lobby === 1`
   - Verify `/games/lobby` is called first
   - Check `lobby_data` is passed to `/games/init`
   - Verify currency is passed to lobby endpoint

4. **FOREIGN KEY constraint failed**
   - Check if user exists: `SELECT id FROM users WHERE id = ?`
   - Verify `game_id` columns don't have foreign keys
   - Check `recent_games` table structure

5. **Currency selector not working**
   - Verify `PUT /api/user/profile` endpoint exists
   - Check if currency is saved to database
   - Verify both `user_profiles` and `wallets` are updated

---

## Next Steps After Implementation

1. Implement webhook handlers for transactions
2. Add game history tracking
3. Implement balance synchronization
4. Add game favorites
5. Implement game search and filtering
6. Add analytics and reporting

---

## Complete Error Log Reference

### All Errors Encountered During Implementation

1. **"This provider is not enabled for your contract"**
   - **Frequency:** Very common
   - **Cause:** Currency mismatch
   - **Fix:** Check providers for user's currency, not hardcoded value

2. **"FOREIGN KEY constraint failed" on game_sessions**
   - **Frequency:** Common
   - **Cause:** User doesn't exist in database
   - **Fix:** Verify user exists before insert

3. **"FOREIGN KEY constraint failed" on recent_games**
   - **Frequency:** Common
   - **Cause:** Foreign key on game_id referencing local games table
   - **Fix:** Remove foreign key constraint (migration 011)

4. **"no such table: game_sessions"**
   - **Frequency:** Once
   - **Cause:** Migration not run
   - **Fix:** Run database migrations

5. **Currency selector not saving**
   - **Frequency:** Once
   - **Cause:** No PUT endpoint, UI not connected
   - **Fix:** Create endpoint and connect UI

6. **Games with lobby fail**
   - **Frequency:** Once
   - **Cause:** Not calling /games/lobby first
   - **Fix:** Check has_lobby and call lobby endpoint

---

## Code Snippets Reference

### X-Sign Authentication
```typescript
function calculateXSign(params, headers, merchantKey) {
  const merged = { ...params, ...headers }
  const sorted = Object.keys(merged).sort()
  const queryString = sorted
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(merged[key]))}`)
    .join('&')
  return crypto.createHmac('sha1', merchantKey).update(queryString).digest('hex')
}
```

### Provider Check (Currency-Aware)
```typescript
// Get user's currency
const profile = await queryOne(
  'SELECT currency FROM user_profiles WHERE user_id = ?',
  [userId]
)
const userCurrency = profile?.currency || 'EUR'

// Get enabled providers for THIS currency
const providers = await getEnabledProviders(userCurrency)

// Check if game's provider is enabled
const isEnabled = providers.has(game.provider)
```

### Lobby Game Handling
```typescript
if (game.has_lobby === 1) {
  const lobby = await getGameLobby(gameId, userCurrency)
  lobbyData = lobby.lobby.lobbyData
}

const session = await initializeGameSession(gameId, userId, balance, {
  lobbyData // Pass if required
})
```

---

## Support Resources

- Slotegrator API Documentation: `CASINO_API_DOCUMENTATION.md`
- Server logs (check `logs/` directory)
- API response logs (full request/response captured)
- Game launch logs (step-by-step flow)

### Key Documentation Sections

- **Lines 169-178:** Game Launch Flow (lobby vs non-lobby)
- **Lines 369-388:** POST /games/init parameters
- **Lines 315-365:** GET /games/lobby usage
- **Lines 416-434:** GET /limits (provider enablement)
- **Lines 45-167:** X-Sign authentication algorithm

---

## Migration Files

### 010_game_sessions.sqlite.sql
```sql
CREATE TABLE IF NOT EXISTS game_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL, -- Slotegrator UUID
  session_token TEXT NOT NULL,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMP,
  initial_balance REAL NOT NULL,
  total_bet REAL DEFAULT 0,
  total_win REAL DEFAULT 0,
  session_duration INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 011_fix_recent_games_foreign_key.sqlite.sql
```sql
-- Remove foreign key on game_id (Slotegrator UUIDs don't exist locally)
CREATE TABLE recent_games_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL, -- NO foreign key!
  last_played TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, game_id)
);
INSERT INTO recent_games_new SELECT * FROM recent_games;
DROP TABLE recent_games;
ALTER TABLE recent_games_new RENAME TO recent_games;
```

---

**Last Updated:** Based on implementation completed January 2026
**Tested With:** Slotegrator Staging API
**Status:** ✅ Production Ready (after testing)
**Total Implementation Time:** ~4-5 hours
**Total Errors Fixed:** 6 major issues
