# Action Items & Questions for Slotegrator Integration

## 📋 Summary of Fixes Applied

✅ **HTTP 200 Status Code** - All error responses now return HTTP 200 with error_code in JSON body (not HTTP 401)
✅ **X-Sign Validation** - Fixed hardcoded merchant key issue, now uses actual environment key
✅ **Balance Error Response** - Invalid player_id now returns proper JSON error object (not empty array)
✅ **Refund Logic** - WIN transaction refunds no longer modify player balance
✅ **Transaction Idempotency** - Duplicate requests return cached response with same transaction_id
✅ **Rollback Format** - Includes rollback_transactions array with processed IDs

---

## 🤔 Questions to Ask Slotegrator

### 1. **Game Session Initialization Error**
**Issue:** `/games/init` endpoint is returning HTTP 403 with message "Incorrect required parameter"

**Question:** 
- What parameter is missing or incorrect in our /games/init request?
- Should we include additional fields beyond: `game_uuid`, `player_id`, `player_name`, `currency`, `session_id`, `device`, `return_url`, `language`, `email`?
- Is there a required authentication header we're missing for the game init endpoint?

**Current Parameters Sent:**
```json
{
  "game_uuid": "7487f0fac9049c9ee0dd0635a8ce5f5bfe04cd15",
  "player_id": "test_player_001", 
  "player_name": "Test Player",
  "currency": "EUR",
  "session_id": "session_val_xxxxx",
  "device": "desktop",
  "return_url": "https://boztestarea.ngrok.app",
  "language": "en",
  "email": "test@example.com"
}
```

---

### 2. **Callback Response Format Verification**
**Question:** Please confirm our callback response formats are correct:

**Balance Success:**
```json
{ "balance": 1234.56 }
```

**Balance Error:**
```json
{
  "error_code": "INTERNAL_ERROR",
  "error_description": "Wallet not found"
}
```

**Bet/Win/Refund Success:**
```json
{
  "balance": 1234.56,
  "transaction_id": "our_generated_unique_id"
}
```

**Rollback Success:**
```json
{
  "balance": 1234.56,
  "transaction_id": "our_generated_unique_id",
  "rollback_transactions": ["tx_id_1", "tx_id_2"]
}
```

---

### 3. **Transaction ID Format**
**Question:** 
- Should our generated `transaction_id` follow a specific format (UUID, hex string, etc.)?
- We're using `nanoid()` which generates 21-character alphanumeric strings (e.g., "V1StGXR_Z5j3eK8A9R1T2")
- Is this acceptable or should we use a different format?

---

### 4. **Balance Response Format - Edge Case**
**Question:** For balance request with non-existent player_id:
- We now return HTTP 200 with error JSON: `{"error_code": "INTERNAL_ERROR", "error_description": "Wallet not found"}`
- Should balance error responses also include `"balance": null` field?
- Or is error_code + error_description sufficient?

---

### 5. **Refund for WIN Transactions - Clarification**
**Issue:** When refunding a WIN transaction (refund amount = 200, balance before = 1200):
- We now return balance = 1200 (unchanged) ✅
- Should we also log/track this as a "refund not applied" event?
- Or should we only accept refunds for BET transactions and reject WIN refunds with error_code?

---

### 6. **Duplicate Transaction Handling - "Processed" Status**
**Question:**
- When a duplicate request is received (same transaction_id), we return the cached response
- Should we also return a special field (like `"duplicate": true`) to indicate this was a retry?
- Or should the response be completely identical to the original?

---

### 7. **Timeout and Retry Logic**
**Question:**
- You mention max 3 second timeout for callback responses. Our current implementation processes most requests in < 200ms
- What should happen if a request takes 2.5-3 seconds? Should we:
  - Abort gracefully and return timeout error?
  - Return partial success and retry later?
  - Continue processing even if approaching timeout?

---

### 8. **Round ID vs Provider Round ID**
**Question:**
- In rollback requests, both `round_id` and `provider_round_id` are included
- Should we use `round_id` as the primary identifier for grouping transactions?
- When rolling back, should we verify transactions match the specific `round_id`?

---

### 9. **Freespin Campaign Tracking**
**Question:**
- For freespin transactions, we receive `freespin_id` and `quantity` (rounds left)
- Should we track freespin state to prevent:
  - Using more rounds than allocated?
  - Multiple campaigns active simultaneously?
- Or do you handle this validation server-side?

---

### 10. **HTTP Status Codes for Different Errors**
**Question:** Confirming our implementation:
- ALL error responses return HTTP 200 ✅
- Error details in JSON body with `error_code` and `error_description` ✅
- Only 2 error codes used: `INTERNAL_ERROR` and `INSUFFICIENT_FUNDS` ✅
- Is this correct? Should we never return HTTP 400, 401, 403, 500 from callback?

---

### 11. **ngrok Tunnel Stability**
**Question:**
- We're using ngrok tunnel for testing (https://bozcallback.ngrok.app/)
- For production, should we:
  - Use a static domain with SSL certificate?
  - Pre-register our production domain with you?
  - Any IP whitelisting requirements you mentioned?

---

### 12. **Validation Testing Status**
**Question:** For the self-validation test:
- Current status: `/games/init` returns 403 (blocking further testing)
- Once this is resolved, the callback tests should pass without manual intervention
- Should we schedule a manual test with Slotegrator support team?
- Or will providing naruto.json with successful callback responses be sufficient?

---

## 📊 Test Results File

✅ **naruto.json** - Contains all callback test results with:
- ✅ All responses with HTTP 200 status code
- ✅ Proper JSON error format for invalid players
- ✅ Refund for WIN transactions not modifying balance
- ✅ Transaction idempotency verified
- ✅ Rollback transactions array included

---

## 🚀 Next Steps

1. **Provide answers** to questions 1-12 above
2. **Fix /games/init endpoint** issue (question #1)
3. **Re-run self-validation** with confirmed parameters
4. **Deploy to production** once all validations pass

---

**Please respond with the information above and we can proceed with full integration.**
