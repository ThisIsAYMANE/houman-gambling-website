import { NextRequest, NextResponse } from 'next/server'
import { query, queryOne } from '@/lib/db'
import { nanoid } from 'nanoid'
import { 
  calculateSystemBet, 
  calculateAccumulator, 
  validateBetSelections,
  SYSTEM_BET_TYPES
} from '@/lib/advanced-bet-types'
import { validateBetLimits } from '@/lib/betting-limits'
import { BettingRulesEngine, hasSameMatchSelections, areMarketsRelated } from '@/lib/betting-rules'

// Get session from cookie
async function getUserId(request: NextRequest): Promise<string | null> {
  const sessionCookie = request.cookies.get('session')
  if (!sessionCookie) return null
  
  try {
    const session = await queryOne<{ user_id: string }>(
      'SELECT user_id FROM sessions WHERE session_token = ? AND expires > CURRENT_TIMESTAMP',
      [sessionCookie.value]
    )
    return session?.user_id || null
  } catch {
    return null
  }
}

/**
 * POST /api/bets/advanced
 * 
 * Place advanced bets (system bets, enhanced accumulators)
 * Supports: Trixie, Patent, Yankee, Lucky 15, etc.
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getUserId(request)
    if (!userId) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      )
    }

    const body = await request.json()
    const {
      betType, // 'accumulator', 'trixie', 'patent', 'yankee', etc.
      selections,
      unitStake,
      currency = 'MAD'
    } = body

    // Validate selections
    const selectionValidation = validateBetSelections(selections)
    if (!selectionValidation.valid) {
      return NextResponse.json(
        { error: 'Invalid selections', details: selectionValidation.errors },
        { status: 400 }
      )
    }

    // Initialize rules engine
    const rulesEngine = new BettingRulesEngine()

    // Prepare bet data for rules evaluation
    const betData = {
      betType,
      selections,
      selectionCount: selections.length,
      userId,
      selectionOdds: selections.map((s: any) => s.odds),
      totalOdds: selections.reduce((acc: number, s: any) => acc * s.odds, 1)
    }

    // Check for same match selections in accumulator
    if (betType === 'accumulator' || betType in SYSTEM_BET_TYPES) {
      if (hasSameMatchSelections(selections)) {
        betData.sameMatch = true
      }

      // Check for related markets
      if (areMarketsRelated(selections)) {
        betData.relatedMarkets = true
      }
    }

    // Evaluate rules
    const rulesResult = rulesEngine.evaluateRules(betData)
    if (!rulesResult.allowed) {
      return NextResponse.json(
        {
          error: 'Bet violates betting rules',
          violations: rulesResult.violations,
          warnings: rulesResult.warnings
        },
        { status: 400 }
      )
    }

    // Calculate bet
    let calculation: any
    let totalStake: number
    let potentialReturn: number

    if (betType === 'accumulator') {
      calculation = calculateAccumulator(selections, unitStake)
      totalStake = calculation.stake
      potentialReturn = calculation.potentialReturn
    } else if (betType in SYSTEM_BET_TYPES) {
      calculation = calculateSystemBet(
        selections,
        betType as keyof typeof SYSTEM_BET_TYPES,
        unitStake
      )
      totalStake = calculation.totalStake
      potentialReturn = calculation.potentialReturn
    } else {
      return NextResponse.json(
        { error: 'Invalid bet type' },
        { status: 400 }
      )
    }

    // Get sport ID from first selection (for limits check)
    const firstSelection = selections[0]
    const matchInfo = await queryOne<{ sport_id: string }>(
      'SELECT sport_id FROM matches WHERE id = ?',
      [firstSelection.matchId]
    )

    // Validate betting limits
    const limitsValidation = await validateBetLimits(
      userId,
      totalStake,
      potentialReturn,
      matchInfo?.sport_id
    )

    if (!limitsValidation.valid) {
      return NextResponse.json(
        {
          error: 'Betting limits exceeded',
          details: limitsValidation.errors,
          limits: limitsValidation.limits
        },
        { status: 400 }
      )
    }

    // Check wallet balance
    let wallet: { balance: number; bonus_balance?: number } | null = null
    let bonusBalance = 0
    
    try {
      wallet = await queryOne<{ balance: number; bonus_balance?: number }>(
        'SELECT balance, bonus_balance FROM wallets WHERE user_id = ? AND currency = ?',
        [userId, currency]
      )
      if (wallet && wallet.bonus_balance !== undefined && wallet.bonus_balance !== null) {
        bonusBalance = parseFloat(String(wallet.bonus_balance || '0'))
      }
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: bonus_balance')) {
        wallet = await queryOne<{ balance: number }>(
          'SELECT balance FROM wallets WHERE user_id = ? AND currency = ?',
          [userId, currency]
        )
        bonusBalance = 0
      } else {
        throw error
      }
    }

    if (!wallet) {
      return NextResponse.json(
        { error: 'Wallet not found' },
        { status: 404 }
      )
    }

    const totalBalance = (wallet.balance || 0) + bonusBalance
    if (totalBalance < totalStake) {
      return NextResponse.json(
        { error: 'Insufficient balance' },
        { status: 400 }
      )
    }

    // Deduct from wallet
    const deductAmount = Math.min(totalStake, wallet.balance)
    const deductBonus = totalStake - deductAmount

    await query(
      `UPDATE wallets 
       SET balance = balance - ?, 
           bonus_balance = bonus_balance - ?
       WHERE user_id = ? AND currency = ?`,
      [deductAmount, deductBonus, userId, currency]
    )

    // Create bet record
    const betId = nanoid()
    await query(
      `INSERT INTO user_bets 
        (id, user_id, bet_type, amount, currency, odds, potential_win, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)`,
      [
        betId,
        userId,
        betType,
        totalStake,
        currency,
        betType === 'accumulator' ? calculation.totalOdds : 0,
        potentialReturn
      ]
    )

    // Store selections
    for (const selection of selections) {
      await query(
        `INSERT INTO bet_selections 
          (id, bet_id, match_id, market_id, odds_id, selection, odds)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          nanoid(),
          betId,
          selection.matchId,
          selection.marketId,
          selection.oddsId || nanoid(),
          selection.selection,
          selection.odds
        ]
      )
    }

    // Store system bet details if applicable
    if (betType in SYSTEM_BET_TYPES) {
      await query(
        `INSERT INTO system_bet_details 
          (id, bet_id, system_type, unit_stake, total_combinations, calculation_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          nanoid(),
          betId,
          betType,
          unitStake,
          calculation.totalCombinations,
          JSON.stringify(calculation)
        ]
      )
    }

    // Record transaction
    await query(
      `INSERT INTO wallet_transactions 
        (id, user_id, type, amount, description, created_at)
       VALUES (?, ?, 'bet', ?, ?, CURRENT_TIMESTAMP)`,
      [
        nanoid(),
        userId,
        totalStake,
        `${betType} bet - ${selections.length} selections`
      ]
    )

    return NextResponse.json({
      betId,
      betType,
      totalStake,
      potentialReturn,
      potentialProfit: calculation.potentialProfit || (potentialReturn - totalStake),
      selectionCount: selections.length,
      combinations: betType in SYSTEM_BET_TYPES ? calculation.totalCombinations : 1,
      newBalance: totalBalance - totalStake,
      warnings: rulesResult.warnings,
      message: 'Bet placed successfully'
    })
  } catch (error) {
    console.error('Error placing advanced bet:', error)
    return NextResponse.json(
      { error: 'Failed to place bet' },
      { status: 500 }
    )
  }
}

/**
 * GET /api/bets/advanced
 * 
 * Get available system bet types for selections count
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const selectionsCount = parseInt(searchParams.get('selections') || '0')

    if (selectionsCount < 2) {
      return NextResponse.json({
        availableTypes: [],
        message: 'At least 2 selections required'
      })
    }

    const availableTypes = []

    // Check accumulator
    if (selectionsCount >= 2) {
      availableTypes.push({
        type: 'accumulator',
        name: 'Accumulator',
        description: `${selectionsCount} selections combined - all must win`,
        minSelections: 2,
        totalBets: 1
      })
    }

    // Check system bets
    for (const [type, config] of Object.entries(SYSTEM_BET_TYPES)) {
      if (
        selectionsCount >= config.minSelections &&
        selectionsCount <= config.maxSelections
      ) {
        const totalBets = config.combinations.reduce((sum, c) => sum + c.count, 0)
        availableTypes.push({
          type,
          name: config.name,
          description: config.description,
          minSelections: config.minSelections,
          totalBets
        })
      }
    }

    return NextResponse.json({
      selectionsCount,
      availableTypes
    })
  } catch (error) {
    console.error('Error getting available bet types:', error)
    return NextResponse.json(
      { error: 'Failed to get bet types' },
      { status: 500 }
    )
  }
}





