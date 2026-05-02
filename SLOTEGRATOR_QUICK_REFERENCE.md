# Slotegrator API - Quick Reference Card

## 🚨 Most Common Errors & Quick Fixes

### Error: "This provider is not enabled for your contract"
**Fix:** Check providers for USER's currency, not hardcoded:
```typescript
// ❌ WRONG
const providers = await getEnabledProviders('USD')

// ✅ CORRECT
const userCurrency = profile?.currency || 'EUR'
const providers = await getEnabledProviders(userCurrency)
```

### Error: "FOREIGN KEY constraint failed"
**Fix:** 
1. Verify user exists: `SELECT id FROM users WHERE id = ?`
2. Remove FK on `game_id` columns (Slotegrator UUIDs don't exist locally)

### Error: "no such table: game_sessions"
**Fix:** Run migrations: `npx tsx scripts/migrate.ts`

---

## ✅ Implementation Checklist

- [ ] Environment variables set (MERCHANT_ID, MERCHANT_KEY, BASE_URL)
- [ ] `lib/casino-api.ts` created with X-Sign auth
- [ ] Database tables created (game_sessions, recent_games)
- [ ] Foreign keys removed from `game_id` columns
- [ ] Currency management implemented
- [ ] Lobby games handled (check `has_lobby === 1`)
- [ ] Provider check uses user's currency

---

## 📋 Game Launch Flow

### Games WITHOUT Lobby:
1. `POST /games/init` → Get game URL
2. Redirect player

### Games WITH Lobby:
1. `GET /games/lobby` → Get `lobby_data`
2. `POST /games/init` with `lobby_data` → Get game URL
3. Redirect player

---

## 🔑 Key Code Patterns

### X-Sign Calculation
```typescript
const merged = { ...params, ...headers }
const sorted = Object.keys(merged).sort()
const queryString = sorted.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(merged[k]))}`).join('&')
const signature = crypto.createHmac('sha1', merchantKey).update(queryString).digest('hex')
```

### Provider Check
```typescript
const userCurrency = profile?.currency || 'EUR'
const providers = await getEnabledProviders(userCurrency)
const isEnabled = providers.has(game.provider)
```

### Lobby Handling
```typescript
if (game.has_lobby === 1) {
  const lobby = await getGameLobby(gameId, currency)
  lobbyData = lobby.lobby.lobbyData
}
```

---

## 🗄️ Database Schema

### game_sessions
- `game_id` = Slotegrator UUID (NO foreign key!)
- `user_id` = Your user ID (with foreign key)

### recent_games
- `game_id` = Slotegrator UUID (NO foreign key!)
- `user_id` = Your user ID (with foreign key)

---

## 📝 Environment Variables

```env
CASINO_MERCHANT_ID=your-id
CASINO_MERCHANT_KEY=your-key
CASINO_API_BASE_URL=https://staging.slotegrator.com/api/index.php/v1
CASINO_DEFAULT_CURRENCY=EUR
```

---

## 🐛 Debugging

1. Check logs: `logs/YYYY-MM-DD_*.log`
2. Check server console for API requests
3. Verify user currency matches enabled providers
4. Check `/limits` endpoint response

---

## 📚 Documentation Sections

- **Lines 169-178:** Game Launch Flow
- **Lines 369-388:** POST /games/init
- **Lines 315-365:** GET /games/lobby
- **Lines 416-434:** GET /limits

---

**Quick Tip:** Always check user's currency before provider validation!
