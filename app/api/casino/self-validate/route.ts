import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { queryOne } from '@/lib/db'

/**
 * POST /api/casino/self-validate
 * 
 * Direct self-validation endpoint that calls Slotegrator's /self-validate
 * without requiring a database session.
 */
export async function POST(request: NextRequest) {
  try {
    const MERCHANT_ID = process.env.CASINO_MERCHANT_ID
    const MERCHANT_KEY = process.env.CASINO_MERCHANT_KEY
    const BASE_URL = process.env.CASINO_API_BASE_URL || 'https://staging.slotegrator.com/api/index.php/v1'

    if (!MERCHANT_ID || !MERCHANT_KEY) {
      return NextResponse.json(
        { error: 'Missing merchant credentials' },
        { status: 500 }
      )
    }

    // Generate auth headers
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const nonce = crypto.randomBytes(16).toString('hex')
    const body = {}

    const signatureData = `${MERCHANT_ID}${timestamp}${nonce}${JSON.stringify(body)}`
    const signature = crypto
      .createHash('sha1')
      .update(signatureData + MERCHANT_KEY)
      .digest('hex')

    // Call Slotegrator
    const response = await fetch(`${BASE_URL}/self-validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Merchant-Id': MERCHANT_ID,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        'X-Sign': signature,
      },
      body: JSON.stringify(body),
    })

    const data = await response.json()

    return NextResponse.json(data, { status: response.status })
  } catch (error: any) {
    console.error('Self-validate error:', error)
    return NextResponse.json(
      { error: error.message || 'Self-validation failed' },
      { status: 500 }
    )
  }
}

/**
 * GET /api/casino/self-validate
 * 
 * Get information about self-validation requirements
 */
export async function GET(request: NextRequest) {
  try {
    let activeSession = null
    let hasActiveSession = false

    // Try to check for active game session (table might not exist yet)
    try {
      const session = await queryOne<{
        id: string
        user_id: string
        game_id: string
        session_token: string
        started_at: string
      }>(
        `SELECT id, user_id, game_id, session_token, started_at 
         FROM game_sessions 
         WHERE started_at > datetime('now', '-15 minutes')
         ORDER BY started_at DESC 
         LIMIT 1`
      )
      activeSession = session
      hasActiveSession = !!session
    } catch (dbError) {
      // Table might not exist yet, that's okay
      console.log('game_sessions table check:', dbError instanceof Error ? dbError.message : 'Unknown error')
      hasActiveSession = false
    }

    // Check if Casino API is configured
    const merchantId = process.env.CASINO_MERCHANT_ID
    const merchantKey = process.env.CASINO_MERCHANT_KEY
    const baseUrl = process.env.CASINO_API_BASE_URL

    const isConfigured = !!(merchantId && merchantKey && baseUrl)
    
    // Check if Merchant ID is still the placeholder
    const hasRealMerchantId = merchantId && merchantId !== 'your-merchant-id'

    return NextResponse.json({
      ready: hasActiveSession && isConfigured && hasRealMerchantId,
      hasActiveSession,
      isConfigured,
      hasRealMerchantId,
      configuration: {
        merchantId: merchantId ? (hasRealMerchantId ? '***configured***' : '⚠️ placeholder value') : '❌ missing',
        merchantKey: merchantKey ? '***configured***' : '❌ missing',
        baseUrl: baseUrl ? '***configured***' : '❌ missing',
      },
      activeSession: activeSession
        ? {
            id: activeSession.id,
            gameId: activeSession.game_id,
            startedAt: activeSession.started_at,
          }
        : null,
      requirements: {
        activeGameSession: 'A game session opened within the last 15 minutes',
        casinoApiCredentials:
          'CASINO_MERCHANT_ID, CASINO_MERCHANT_KEY, and CASINO_API_BASE_URL must be set',
        merchantId: 'You need to replace "your-merchant-id" with your actual Merchant ID from Slotegrator',
      },
    })
  } catch (error) {
    console.error('Self-validation info error:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    
    return NextResponse.json(
      { 
        error: 'Failed to get self-validation information',
        details: errorMessage,
        message: 'Check server logs for more details'
      },
      { status: 500 }
    )
  }
}

