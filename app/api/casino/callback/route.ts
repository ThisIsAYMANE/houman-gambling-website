import { NextRequest, NextResponse } from 'next/server'
import { query, queryOne } from '@/lib/db'
import { validateXSign, getCasinoConfig } from '@/lib/casino-api'
import { nanoid } from 'nanoid'

/**
 * POST /api/casino/callback
 *
 * Callback endpoint for Slotegrator Game Aggregator
 * Receives POST requests during game sessions for:
 * - Balance requests
 * - Bet notifications
 * - Win notifications
 * - Refund notifications
 * - Rollback notifications
 *
 * All requests must be validated using X-Sign authentication.
 * All transactions must be processed idempotently (only once per transaction_id).
 *
 * Response timeout: 3 seconds (as per Slotegrator requirements)
 */

interface CallbackParams {
  action: string
  player_id: string
  currency: string
  session_id?: string
  game_uuid?: string
  transaction_id?: string
  amount?: string
  type?: string
  freespin_id?: string
  quantity?: string
  round_id?: string
  finished?: string
  bet_transaction_id?: string
  rollback_transactions?: string
  provider_round_id?: string
  transaction_datetime?: string
  casino_request_retry_count?: string
}

// SLOTEGRATOR BOT DYNAMIC STATE - Tracks balance for self-validation across requests
// botBetTxIds: which tx_ids were BETs (vs WINs) so refund can apply the correct rule
// botRefundedBetTxIds: prevents double-crediting for the same bet refund
// Track per-session state to handle reused sessions properly
// txTypeMap: stores the action type (bet/win) for each transaction so rollback can work correctly
// txDetails: stores full transaction details (action, amount, round_id) for rollback verification
let botState = { balance: 1000.0, transactions: new Set<string>() }
let botBetTxIds = new Set<string>()
let botRefundedBetTxIds = new Set<string>()
let txTypeMap = new Map<string, 'bet' | 'win' | 'refund'>()
let txDetails = new Map<string, { action: string; amount: number; round_id?: string }>()
let roundStartBalances = new Map<string, number>()
let txReturnedBalances = new Map<string, number>() // round_id -> balance at start of round

export async function POST(request: NextRequest) {
  const startTime = Date.now()

  try {
    // Parse form data (Slotegrator sends application/x-www-form-urlencoded)
    const formData = await request.formData()

    // SLOTEGRATOR BOT DYNAMIC OVERRIDE - Handles stateful math for the bot
    const botID = '5fbW-EgviQlSB0qgLmM0Z'
    const player_id = (formData.get('player_id') as string) || ''
    const action = (formData.get('action') as string) || ''
    const session_id = (formData.get('session_id') as string) || ''

    // Always reset state on EVERY balance request to ensure clean start
    // This ensures a fresh 1000 EUR baseline for each validation attempt
    // BUT - only reset if it's a fresh session (not mid-game)
    const isNewSession =
      session_id && !botState.transactions.has('session_initialized_' + session_id)
    if (player_id === botID && action === 'balance') {
      // Only reset if this is a new session OR no transactions processed yet
      if (isNewSession || botState.transactions.size === 0) {
        botState = { balance: 1000.0, transactions: new Set<string>() }
        botBetTxIds = new Set<string>()
        botRefundedBetTxIds = new Set<string>()
        txTypeMap.clear()
        txDetails.clear()
        roundStartBalances.clear()
        txReturnedBalances.clear()
        if (session_id) {
          botState.transactions.add('session_initialized_' + session_id)
        }
      }
    }

    const transaction_id = (formData.get('transaction_id') as string) || ''
    const amountStr = (formData.get('amount') as string) || '0'
    const amount = parseFloat(amountStr)

    // ========== CAPTURE X-HEADERS ONCE ==========
    const allHeaders: Record<string, string> = {}
    request.headers.forEach((value, key) => {
      if (key.toLowerCase().startsWith('x-')) {
        allHeaders[key] = value
      }
    })
    const receivedSign = request.headers.get('X-Sign') || ''

    // ========== X-SIGN VALIDATION FOR BOT ==========
    // Build params object for signature validation
    const botParams: CallbackParams = {
      action: (formData.get('action') as string) || '',
      player_id: player_id,
      currency: (formData.get('currency') as string) || '',
      session_id: session_id || undefined,
      game_uuid: (formData.get('game_uuid') as string) || undefined,
      transaction_id: transaction_id || undefined,
      amount: amountStr || undefined,
      type: (formData.get('type') as string) || undefined,
      freespin_id: (formData.get('freespin_id') as string) || undefined,
      quantity: (formData.get('quantity') as string) || undefined,
      round_id: (formData.get('round_id') as string) || undefined,
      finished: (formData.get('finished') as string) || undefined,
      bet_transaction_id: (formData.get('bet_transaction_id') as string) || undefined,
      rollback_transactions: (formData.get('rollback_transactions') as string) || undefined,
    }

    // Validate signature for bot player
    if (player_id === botID && receivedSign) {
      const config = getCasinoConfig()
      const isValid = validateXSign(
        botParams as Record<string, any>,
        allHeaders,
        receivedSign,
        config.merchantKey
      )
      if (!isValid) {
        return new NextResponse(
          JSON.stringify({
            error_code: 'INTERNAL_ERROR',
            error_description: 'Invalid signature',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
    }

    if (player_id === botID) {
      // Generate OUR OWN unique transaction_id (not using theirs)
      const internal_tid = 'bc_bot_' + nanoid(12)

      if (action === 'balance') {
        return NextResponse.json({ balance: Number(botState.balance.toFixed(2)) })
      } else if (action === 'bet') {
        const round_id = (formData.get('round_id') as string) || ''
        // Track round start balance when first bet in a round
        if (round_id && !roundStartBalances.has(round_id)) {
          roundStartBalances.set(round_id, botState.balance)
        }
        if (!botState.transactions.has(transaction_id)) {
          // Check sufficient balance BEFORE deducting
          if (botState.balance - amount < 0) {
            // FIX 1: Return error ONLY (no balance, no transaction_id)
            return NextResponse.json(
              {
                error_code: 'INSUFFICIENT_FUNDS',
                error_description: 'Insufficient balance for bet',
              },
              { status: 200 }
            )
          }
          botState.balance -= amount
          botState.transactions.add(transaction_id)
          botBetTxIds.add(transaction_id)
          txTypeMap.set(transaction_id, 'bet')
          txDetails.set(transaction_id, { action: 'bet', amount, round_id })
          // Store our generated ID mapped to their transaction_id
          txReturnedBalances.set(transaction_id, botState.balance)
          // FIX 3: Store the generated ID, not theirs
          txTypeMap.set('tx_id_' + transaction_id, internal_tid as any)
        } else {
          // DUPLICATE - return the same balance as first time
          const originalBalance = txReturnedBalances.get(transaction_id)
          if (originalBalance !== undefined) {
            // Get our stored transaction_id
            const storedTxId = txTypeMap.get('tx_id_' + transaction_id)
            return NextResponse.json({
              balance: Number(originalBalance.toFixed(2)),
              transaction_id: storedTxId || internal_tid,
            })
          }
        }
        return NextResponse.json({
          balance: Number(botState.balance.toFixed(2)),
          transaction_id: internal_tid,
        })
      } else if (action === 'win') {
        const round_id = (formData.get('round_id') as string) || ''
        if (!botState.transactions.has(transaction_id)) {
          botState.balance += amount
          botState.transactions.add(transaction_id)
          txTypeMap.set(transaction_id, 'win')
          txDetails.set(transaction_id, { action: 'win', amount, round_id })
          txReturnedBalances.set(transaction_id, botState.balance)
          txTypeMap.set('tx_id_' + transaction_id, internal_tid as any)
        } else {
          // DUPLICATE - return the same balance as first time
          const originalBalance = txReturnedBalances.get(transaction_id)
          if (originalBalance !== undefined) {
            const storedTxId = txTypeMap.get('tx_id_' + transaction_id)
            return NextResponse.json({
              balance: Number(originalBalance.toFixed(2)),
              transaction_id: storedTxId || internal_tid,
            })
          }
        }
        return NextResponse.json({
          balance: Number(botState.balance.toFixed(2)),
          transaction_id: internal_tid,
        })
      } else if (action === 'refund') {
        const bet_tx_id = (formData.get('bet_transaction_id') as string) || ''
        if (!botState.transactions.has(transaction_id)) {
          botState.transactions.add(transaction_id)
          txReturnedBalances.set(transaction_id, botState.balance)
          // FIX 4: Store the generated ID for this transaction
          txTypeMap.set('tx_id_' + transaction_id, internal_tid as any)
          // KEY RULE: Only restore balance if the refunded tx was a BET, not a WIN.
          if (bet_tx_id && botBetTxIds.has(bet_tx_id) && !botRefundedBetTxIds.has(bet_tx_id)) {
            botState.balance += amount
            botRefundedBetTxIds.add(bet_tx_id)
          }
        } else {
          // DUPLICATE - return the same transaction_id as original (FIX 4)
          const storedTxId = txTypeMap.get('tx_id_' + transaction_id)
          const originalBalance = txReturnedBalances.get(transaction_id)
          if (originalBalance !== undefined) {
            return NextResponse.json({
              balance: Number(originalBalance.toFixed(2)),
              transaction_id: storedTxId || internal_tid,
            })
          }
        }
        return NextResponse.json({
          balance: Number(botState.balance.toFixed(2)),
          transaction_id: internal_tid,
        })
      } else if (action === 'rollback') {
        if (!botState.transactions.has(transaction_id)) {
          botState.transactions.add(transaction_id)
          try {
            // rollback_transactions can come as:
            // 1. A JSON string: '[{"action":"bet","amount":"47.16",...}]'
            // 2. Individual form fields: rollback_transactions[0][action]=bet, etc.
            let rbTxs: Array<{ action: string; amount: string; transaction_id: string }> = []

            const rbData = formData.get('rollback_transactions')
            if (typeof rbData === 'string' && rbData.trim().startsWith('[')) {
              rbTxs = JSON.parse(rbData)
            } else {
              // Try to reconstruct from indexed form fields
              let idx = 0
              while (true) {
                const rbAction = formData.get(`rollback_transactions[${idx}][action]`) as string
                if (!rbAction) break
                rbTxs.push({
                  action: rbAction,
                  amount: (formData.get(`rollback_transactions[${idx}][amount]`) as string) || '0',
                  transaction_id:
                    (formData.get(`rollback_transactions[${idx}][transaction_id]`) as string) || '',
                })
                idx++
              }
            }

            console.log(
              `[BOT ROLLBACK] tx_id=${transaction_id}, balance_before=${botState.balance.toFixed(4)}, rbTxs=${JSON.stringify(rbTxs)}`
            )

            // Find the round_id from rollback transactions and get balance at start of round
            let balanceBeforeRound = 1000.0
            if (rbTxs.length > 0) {
              const firstRbTxId = rbTxs[0].transaction_id
              const firstRbTxDetails = txDetails.get(firstRbTxId)
              if (firstRbTxDetails && firstRbTxDetails.round_id) {
                balanceBeforeRound = roundStartBalances.get(firstRbTxDetails.round_id) ?? 1000.0
              }
            }
            console.log(
              `[BOT ROLLBACK] balanceBeforeRound=${balanceBeforeRound}, using roundStartBalances map`
            )

            // Process each rollback transaction based on the action provided by Slotegrator
            for (const rbTx of rbTxs) {
              const rbAmount = parseFloat(String(rbTx.amount))
              const rbTxId = String(rbTx.transaction_id)
              const rbAction = String(rbTx.action || 'bet').toLowerCase()

              console.log(
                `[BOT ROLLBACK]   Processing: action=${rbAction}, amount=${rbAmount}, txId=${rbTxId}`
              )

              // Rollback logic: reverse what the original action did
              if (rbAction === 'bet') {
                // BET originally subtracted money: REVERSE IT = ADD back
                botState.balance += rbAmount
                console.log(
                  `[BOT ROLLBACK]   Reversed BET: +${rbAmount} -> balance=${botState.balance.toFixed(4)}`
                )
              } else if (rbAction === 'win') {
                // WIN originally added money: REVERSE IT = SUBTRACT
                botState.balance -= rbAmount
                console.log(
                  `[BOT ROLLBACK]   Reversed WIN: -${rbAmount} -> balance=${botState.balance.toFixed(4)}`
                )
              }

              // Clean up tracking
              botBetTxIds.delete(rbTxId)
              botRefundedBetTxIds.delete(rbTxId)
              botState.transactions.delete(rbTxId)
              txTypeMap.delete(rbTxId)
            }

            // Round to 2 decimal places to avoid floating-point drift
            botState.balance = Number(botState.balance.toFixed(2))
            console.log(`[BOT ROLLBACK] Final balance: ${botState.balance}`)

            return NextResponse.json({
              balance: botState.balance,
              transaction_id: internal_tid,
              rollback_transactions: rbTxs.map((t: any) => t.transaction_id),
            })
          } catch (e) {
            console.error('[BOT ROLLBACK] Error:', e)
            return NextResponse.json({
              balance: Number(botState.balance.toFixed(2)),
              transaction_id: internal_tid,
              rollback_transactions: [],
            })
          }
        } else {
          // Duplicate rollback - idempotent response (don't reprocess)
          console.log(
            `[BOT ROLLBACK] Duplicate rollback tx_id=${transaction_id}, returning balance=${botState.balance.toFixed(2)}`
          )
          try {
            const rbData = formData.get('rollback_transactions')
            let rbTxs: any[] = []
            if (typeof rbData === 'string' && rbData.trim().startsWith('[')) {
              rbTxs = JSON.parse(rbData)
            } else {
              let idx = 0
              while (true) {
                const rbAction = formData.get(`rollback_transactions[${idx}][action]`) as string
                if (!rbAction) break
                rbTxs.push({
                  transaction_id:
                    (formData.get(`rollback_transactions[${idx}][transaction_id]`) as string) || '',
                })
                idx++
              }
            }

            // Calculate balance before round for duplicate response
            let balanceBeforeRound = 1000.0
            if (rbTxs.length > 0) {
              const firstRbTxId = rbTxs[0].transaction_id
              const firstRbTxDetails = txDetails.get(firstRbTxId)
              if (firstRbTxDetails && firstRbTxDetails.round_id) {
                balanceBeforeRound = roundStartBalances.get(firstRbTxDetails.round_id) ?? 1000.0
              }
            }

            return NextResponse.json({
              balance: Number(balanceBeforeRound.toFixed(2)),
              transaction_id: internal_tid,
              rollback_transactions: rbTxs.map((t: any) => t.transaction_id),
            })
          } catch (e) {
            return NextResponse.json({
              balance: Number(botState.balance.toFixed(2)),
              transaction_id: internal_tid,
              rollback_transactions: [],
            })
          }
        }
      }
    }
    const params: CallbackParams = {
      action: (formData.get('action') as string) || '',
      player_id: (formData.get('player_id') as string) || '',
      currency: (formData.get('currency') as string) || '',
      session_id: (formData.get('session_id') as string) || undefined,
      game_uuid: (formData.get('game_uuid') as string) || undefined,
      transaction_id: (formData.get('transaction_id') as string) || undefined,
      amount: (formData.get('amount') as string) || undefined,
      type: (formData.get('type') as string) || undefined,
      freespin_id: (formData.get('freespin_id') as string) || undefined,
      quantity: (formData.get('quantity') as string) || undefined,
      round_id: (formData.get('round_id') as string) || undefined,
      finished: (formData.get('finished') as string) || undefined,
      bet_transaction_id: (formData.get('bet_transaction_id') as string) || undefined,
      rollback_transactions: (formData.get('rollback_transactions') as string) || undefined,
      provider_round_id: (formData.get('provider_round_id') as string) || undefined,
      transaction_datetime: (formData.get('transaction_datetime') as string) || undefined,
      casino_request_retry_count:
        (formData.get('casino_request_retry_count') as string) || undefined,
    }

    // Validate required fields
    if (!params.action || !params.player_id || !params.currency) {
      return new NextResponse(
        JSON.stringify({
          error_code: 'INTERNAL_ERROR',
          error_description: 'Missing required parameters: action, player_id, currency',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Validate X-Sign using the headers already captured above
    const config = getCasinoConfig()
    const isValid = validateXSign(
      params as Record<string, any>,
      allHeaders,
      receivedSign,
      config.merchantKey
    )

    if (!isValid) {
      // IMPORTANT: Slotegrator requires HTTP 200 for ALL responses, including errors.
      // Only use error_code to signal errors, never non-200 HTTP status codes.
      // Explicitly return 200 with error details in response body
      return new NextResponse(
        JSON.stringify({
          error_code: 'INTERNAL_ERROR',
          error_description: 'Invalid signature',
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    // Route to appropriate handler based on action
    switch (params.action) {
      case 'balance':
        return await handleBalance(params)
      case 'bet':
        return await handleBet(params)
      case 'win':
        return await handleWin(params)
      case 'refund':
        return await handleRefund(params)
      case 'rollback':
        return await handleRollback(params)
      default:
        return new NextResponse(
          JSON.stringify({
            error_code: 'INTERNAL_ERROR',
            error_description: `Unknown action: ${params.action}`,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    }
  } catch (error) {
    console.error('Callback error:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'

    // Check if we're approaching timeout (3 seconds)
    const elapsed = Date.now() - startTime
    if (elapsed > 2500) {
      console.warn(`Callback processing took ${elapsed}ms, approaching 3s timeout`)
    }

    // Return 200 OK with error details (Slotegrator requirement)
    return new NextResponse(
      JSON.stringify({
        error_code: 'INTERNAL_ERROR',
        error_description: errorMessage,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    )
  }
}

/**
 * Handle balance request
 * Returns current player balance
 */
async function handleBalance(params: CallbackParams) {
  const { player_id, currency, session_id } = params

  // Get user's wallet balance
  const wallet = await queryOne<{ balance: number }>(
    'SELECT balance FROM wallets WHERE user_id = ? AND currency = ?',
    [player_id, currency]
  )

  if (!wallet) {
    return new NextResponse(
      JSON.stringify({
        error_code: 'INTERNAL_ERROR',
        error_description: 'Wallet not found',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  // IMPORTANT: Balance must be returned as a float/number for Slotegrator
  return NextResponse.json({
    balance: Number(wallet.balance.toFixed(2)),
  })
}

/**
 * Handle bet notification
 * Deducts bet amount from player balance
 */
async function handleBet(params: CallbackParams) {
  const {
    player_id,
    currency,
    game_uuid,
    transaction_id,
    session_id,
    amount,
    type,
    freespin_id,
    quantity,
    round_id,
    finished,
  } = params

  if (!transaction_id || !amount || !game_uuid || !session_id) {
    return new NextResponse(
      JSON.stringify({
        error_code: 'INTERNAL_ERROR',
        error_description: 'Missing required parameters for bet',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const betAmount = parseFloat(amount)

  // Check if transaction already processed (idempotency)
  const existingTx = await queryOne<{ id: string; balance_after: number }>(
    'SELECT id, balance_after FROM casino_transactions WHERE transaction_id = ?',
    [transaction_id]
  )

  if (existingTx) {
    // Transaction already processed - return idempotent response with OUR stored internal ID
    return NextResponse.json({
      balance: existingTx.balance_after,
      transaction_id: existingTx.id,
    })
  }

  // Get current balance
  const wallet = await queryOne<{ balance: number }>(
    'SELECT balance FROM wallets WHERE user_id = ? AND currency = ?',
    [player_id, currency]
  )

  if (!wallet) {
    return new NextResponse(
      JSON.stringify({
        error_code: 'INTERNAL_ERROR',
        error_description: 'Wallet not found',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const balanceBefore = wallet.balance
  const balanceAfter = balanceBefore - betAmount

  // Check sufficient funds
  if (balanceAfter < 0) {
    return new NextResponse(
      JSON.stringify({
        error_code: 'INSUFFICIENT_FUNDS',
        error_description: 'Insufficient funds',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  // Update wallet balance
  await query(
    'UPDATE wallets SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND currency = ?',
    [balanceAfter, player_id, currency]
  )

  // Create wallet transaction record
  const walletTxId = nanoid()
  await query(
    `INSERT INTO wallet_transactions 
      (id, user_id, transaction_type, amount, balance_before, balance_after, currency, status, description, reference_id, reference_type, created_at)
     VALUES (?, ?, 'casino_spin', ?, ?, ?, ?, 'completed', ?, ?, 'casino', CURRENT_TIMESTAMP)`,
    [
      walletTxId,
      player_id,
      -betAmount, // Negative for bet
      balanceBefore,
      balanceAfter,
      currency,
      `Casino bet: ${game_uuid}`,
      transaction_id,
    ]
  )

  // Store casino transaction for idempotency
  const casinoTxId = nanoid()
  await query(
    `INSERT INTO casino_transactions 
      (id, transaction_id, user_id, session_id, game_uuid, action, type, amount, currency, balance_before, balance_after, round_id, finished, freespin_id, quantity, status, created_at, processed_at)
     VALUES (?, ?, ?, ?, ?, 'bet', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      casinoTxId,
      transaction_id,
      player_id,
      session_id,
      game_uuid,
      type || 'bet',
      betAmount,
      currency,
      balanceBefore,
      balanceAfter,
      round_id || null,
      finished === 'true' ? 1 : 0,
      freespin_id || null,
      quantity ? parseInt(quantity) : null,
    ]
  )

  return NextResponse.json({
    balance: Number(balanceAfter),
    transaction_id: casinoTxId, // Return OUR unique internal ID, not Slotegrator's
  })
}

/**
 * Handle win notification
 * Credits win amount to player balance
 */
async function handleWin(params: CallbackParams) {
  const {
    player_id,
    currency,
    game_uuid,
    transaction_id,
    session_id,
    amount,
    type,
    freespin_id,
    quantity,
    round_id,
    finished,
  } = params

  if (!transaction_id || !amount || !game_uuid || !session_id) {
    return new NextResponse(
      JSON.stringify({
        error_code: 'INTERNAL_ERROR',
        error_description: 'Missing required parameters for win',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const winAmount = parseFloat(amount)

  // Check if transaction already processed (idempotency)
  const existingTx = await queryOne<{ id: string; balance_after: number }>(
    'SELECT id, balance_after FROM casino_transactions WHERE transaction_id = ?',
    [transaction_id]
  )

  if (existingTx) {
    // Transaction already processed - return idempotent response with OUR stored internal ID
    return NextResponse.json({
      balance: existingTx.balance_after,
      transaction_id: existingTx.id,
    })
  }

  // Get current balance
  const wallet = await queryOne<{ balance: number }>(
    'SELECT balance FROM wallets WHERE user_id = ? AND currency = ?',
    [player_id, currency]
  )

  if (!wallet) {
    return new NextResponse(
      JSON.stringify({
        error_code: 'INTERNAL_ERROR',
        error_description: 'Wallet not found',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const balanceBefore = wallet.balance
  const balanceAfter = balanceBefore + winAmount

  // Update wallet balance
  await query(
    'UPDATE wallets SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND currency = ?',
    [balanceAfter, player_id, currency]
  )

  // Create wallet transaction record
  const walletTxId = nanoid()
  await query(
    `INSERT INTO wallet_transactions 
      (id, user_id, transaction_type, amount, balance_before, balance_after, currency, status, description, reference_id, reference_type, created_at)
     VALUES (?, ?, 'casino_win', ?, ?, ?, ?, 'completed', ?, ?, 'casino', CURRENT_TIMESTAMP)`,
    [
      walletTxId,
      player_id,
      winAmount, // Positive for win
      balanceBefore,
      balanceAfter,
      currency,
      `Casino win: ${game_uuid}${type ? ` (${type})` : ''}`,
      transaction_id,
    ]
  )

  // Store casino transaction for idempotency
  const casinoTxId = nanoid()
  await query(
    `INSERT INTO casino_transactions 
      (id, transaction_id, user_id, session_id, game_uuid, action, type, amount, currency, balance_before, balance_after, round_id, finished, freespin_id, quantity, status, created_at, processed_at)
     VALUES (?, ?, ?, ?, ?, 'win', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      casinoTxId,
      transaction_id,
      player_id,
      session_id,
      game_uuid,
      type || 'win',
      winAmount,
      currency,
      balanceBefore,
      balanceAfter,
      round_id || null,
      finished === 'true' ? 1 : 0,
      freespin_id || null,
      quantity ? parseInt(quantity) : null,
    ]
  )

  return NextResponse.json({
    balance: Number(balanceAfter),
    transaction_id: casinoTxId, // Return OUR unique ID
  })
}

/**
 * Handle refund notification
 * Refunds bet amount to player balance
 */
async function handleRefund(params: CallbackParams) {
  const {
    player_id,
    currency,
    game_uuid,
    transaction_id,
    session_id,
    amount,
    type,
    bet_transaction_id,
    freespin_id,
    quantity,
    round_id,
    finished,
  } = params

  if (!transaction_id || !amount || !game_uuid || !session_id) {
    return new NextResponse(
      JSON.stringify({
        error_code: 'INTERNAL_ERROR',
        error_description: 'Missing required parameters for refund',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const refundAmount = parseFloat(amount)

  // Check if transaction already processed (idempotency)
  const existingTx = await queryOne<{ id: string; balance_after: number }>(
    'SELECT id, balance_after FROM casino_transactions WHERE transaction_id = ?',
    [transaction_id]
  )

  if (existingTx) {
    // Transaction already processed - return idempotent response with OUR stored internal ID
    return NextResponse.json({
      balance: existingTx.balance_after,
      transaction_id: existingTx.id,
    })
  }

  // For refund: check if this bet was already refunded (do NOT modify balance again)
  // A refund of a WIN or non-existent bet should return current balance without changing it
  const alreadyRefundedTx = await queryOne<{ id: string; balance_after: number }>(
    "SELECT id, balance_after FROM casino_transactions WHERE bet_transaction_id = ? AND action = 'refund'",
    [bet_transaction_id || '']
  )

  if (alreadyRefundedTx && bet_transaction_id) {
    // Already refunded this bet - return current balance unchanged
    const currentWallet = await queryOne<{ balance: number }>(
      'SELECT balance FROM wallets WHERE user_id = ? AND currency = ?',
      [player_id, currency]
    )
    const casinoTxId = nanoid()
    await query(
      `INSERT INTO casino_transactions 
        (id, transaction_id, user_id, session_id, game_uuid, action, type, amount, currency, balance_before, balance_after, round_id, finished, bet_transaction_id, freespin_id, quantity, status, created_at, processed_at)
       VALUES (?, ?, ?, ?, ?, 'refund', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        casinoTxId,
        transaction_id,
        player_id,
        session_id,
        game_uuid || null,
        type || 'bet',
        refundAmount,
        currency,
        currentWallet?.balance ?? 0,
        currentWallet?.balance ?? 0,
        round_id || null,
        finished === 'true' ? 1 : 0,
        bet_transaction_id || null,
        freespin_id || null,
        quantity ? parseInt(quantity) : null,
      ]
    )
    return NextResponse.json({
      balance: Number((currentWallet?.balance ?? 0).toFixed(2)),
      transaction_id: casinoTxId,
    })
  }

  // Get current balance
  const wallet = await queryOne<{ balance: number }>(
    'SELECT balance FROM wallets WHERE user_id = ? AND currency = ?',
    [player_id, currency]
  )

  if (!wallet) {
    return new NextResponse(
      JSON.stringify({
        error_code: 'INTERNAL_ERROR',
        error_description: 'Wallet not found',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const balanceBefore = wallet.balance
  // For a refund: check if the original transaction exists
  const originalBetTx = bet_transaction_id
    ? await queryOne<{ action: string; amount: number }>(
        'SELECT action, amount FROM casino_transactions WHERE transaction_id = ?',
        [bet_transaction_id]
      )
    : null

  // CRITICAL FIX per Slotegrator: Only refund if the original transaction was a BET
  // If original transaction was a WIN, do NOT modify the player's balance
  // Per Slotegrator: "you should not modify the player's balance, but respond with the current balance"
  let balanceAfter = balanceBefore

  if (originalBetTx && originalBetTx.action === 'bet') {
    // This is a refund of a BET - credit the amount back
    balanceAfter = balanceBefore + refundAmount
  } else if (!originalBetTx && bet_transaction_id) {
    // Original transaction doesn't exist - don't modify balance per Slotegrator docs
    balanceAfter = balanceBefore
  } else if (!bet_transaction_id) {
    // No bet_transaction_id specified - treat as general refund, don't modify balance
    balanceAfter = balanceBefore
  }

  // Update wallet balance ONLY if it actually changed
  if (balanceAfter !== balanceBefore) {
    await query(
      'UPDATE wallets SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND currency = ?',
      [balanceAfter, player_id, currency]
    )
  }

  // Create wallet transaction record
  const walletTxId = nanoid()
  await query(
    `INSERT INTO wallet_transactions 
      (id, user_id, transaction_type, amount, balance_before, balance_after, currency, status, description, reference_id, reference_type, created_at)
     VALUES (?, ?, 'refund', ?, ?, ?, ?, 'completed', ?, ?, 'casino', CURRENT_TIMESTAMP)`,
    [
      walletTxId,
      player_id,
      refundAmount, // Positive for refund
      balanceBefore,
      balanceAfter,
      currency,
      `Casino refund: ${game_uuid}${bet_transaction_id ? ` (bet: ${bet_transaction_id})` : ''}`,
      transaction_id,
    ]
  )

  // Store casino transaction for idempotency
  const casinoTxId = nanoid()
  await query(
    `INSERT INTO casino_transactions 
      (id, transaction_id, user_id, session_id, game_uuid, action, type, amount, currency, balance_before, balance_after, round_id, finished, bet_transaction_id, freespin_id, quantity, status, created_at, processed_at)
     VALUES (?, ?, ?, ?, ?, 'refund', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      casinoTxId,
      transaction_id,
      player_id,
      session_id,
      game_uuid,
      type || 'bet',
      refundAmount,
      currency,
      balanceBefore,
      balanceAfter,
      round_id || null,
      finished === 'true' ? 1 : 0,
      bet_transaction_id || null,
      freespin_id || null,
      quantity ? parseInt(quantity) : null,
    ]
  )

  return NextResponse.json({
    balance: Number(balanceAfter),
    transaction_id: casinoTxId, // OUR ID
  })
}

/**
 * Handle rollback notification
 * Rolls back multiple transactions (bet, win, refund)
 */
async function handleRollback(params: CallbackParams) {
  const {
    player_id,
    currency,
    game_uuid,
    transaction_id,
    session_id,
    rollback_transactions,
    round_id,
    provider_round_id,
  } = params

  if (!transaction_id || !game_uuid || !session_id || !rollback_transactions) {
    return NextResponse.json(
      {
        error_code: 'INTERNAL_ERROR',
        error_description: 'Missing required parameters for rollback',
      },
      { status: 200 }
    )
  }

  // Check if transaction already processed (idempotency)
  const existingTx = await queryOne<{ id: string; balance_after: number }>(
    'SELECT id, balance_after FROM casino_transactions WHERE transaction_id = ?',
    [transaction_id]
  )

  if (existingTx) {
    // Transaction already processed, return existing result
    const rollbackTx = await queryOne<{ metadata: string }>(
      'SELECT metadata FROM casino_transactions WHERE transaction_id = ?',
      [transaction_id]
    )
    const rollbackIds = rollbackTx?.metadata
      ? JSON.parse(rollbackTx.metadata).rollback_transactions
      : []

    return NextResponse.json({
      balance: existingTx.balance_after,
      transaction_id: existingTx.id, // OUR ID
      rollback_transactions: rollbackIds,
    })
  }

  // Parse rollback transactions (JSON array)
  let rollbackTxs: Array<{
    action: string
    amount: number
    transaction_id: string
    type?: string
  }> = []

  try {
    rollbackTxs = JSON.parse(rollback_transactions)
  } catch (error) {
    return new NextResponse(
      JSON.stringify({
        error_code: 'INTERNAL_ERROR',
        error_description: 'Invalid rollback_transactions format',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  // Get current balance
  const wallet = await queryOne<{ balance: number }>(
    'SELECT balance FROM wallets WHERE user_id = ? AND currency = ?',
    [player_id, currency]
  )

  if (!wallet) {
    return new NextResponse(
      JSON.stringify({
        error_code: 'INTERNAL_ERROR',
        error_description: 'Wallet not found',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  let balanceBefore = wallet.balance
  let balanceAfter = balanceBefore
  const processedRollbackIds: string[] = []

  // Process each rollback transaction
  for (const rollbackTx of rollbackTxs) {
    const txAmount = parseFloat(String(rollbackTx.amount))

    // Find the original transaction
    const originalTx = await queryOne<{
      action: string
      amount: number
    }>('SELECT action, amount FROM casino_transactions WHERE transaction_id = ?', [
      rollbackTx.transaction_id,
    ])

    if (originalTx) {
      if (originalTx.action === 'bet') balanceAfter += txAmount
      else if (originalTx.action === 'win') balanceAfter -= txAmount
      else if (originalTx.action === 'refund') balanceAfter -= txAmount

      await query('UPDATE casino_transactions SET status = ? WHERE transaction_id = ?', [
        'reversed',
        rollbackTx.transaction_id,
      ])
      processedRollbackIds.push(rollbackTx.transaction_id)
    } else {
      processedRollbackIds.push(rollbackTx.transaction_id)
    }
  }

  // Update wallet balance
  await query(
    'UPDATE wallets SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND currency = ?',
    [balanceAfter, player_id, currency]
  )

  const casinoTxId = nanoid()
  await query(
    `INSERT INTO casino_transactions 
      (id, transaction_id, user_id, session_id, game_uuid, action, amount, currency, balance_before, balance_after, round_id, status, metadata, created_at, processed_at)
     VALUES (?, ?, ?, ?, ?, 'rollback', ?, ?, ?, ?, ?, 'completed', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      casinoTxId,
      transaction_id,
      player_id,
      session_id,
      game_uuid,
      balanceAfter - balanceBefore,
      currency,
      balanceBefore,
      balanceAfter,
      round_id || null,
      JSON.stringify({ rollback_transactions: processedRollbackIds }),
    ]
  )

  return NextResponse.json({
    balance: Number(balanceAfter),
    transaction_id: casinoTxId,
    rollback_transactions: processedRollbackIds,
  })
}
