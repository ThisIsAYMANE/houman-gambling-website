import { NextRequest, NextResponse } from 'next/server'
import { query, queryOne } from '@/lib/db'
import { nanoid } from 'nanoid'
import { initializeGameSession, getGames, getEnabledProviders, getGameLobby, Game } from '@/lib/casino-api'
import { getSession } from '@/lib/auth'
import { getCachedData } from '@/lib/api-cache'
import { writeGameLaunchLog } from '@/lib/file-logger'

// Get session from cookie or Authorization header
async function getUserId(request: NextRequest): Promise<string | null> {
  // Try Authorization header first (Bearer token)
  const authHeader = request.headers.get('authorization')
  if (authHeader) {
    const sessionToken = authHeader.replace('Bearer ', '').trim()
    if (sessionToken) {
      try {
        const session = await getSession(sessionToken)
        if (session && session.expires > new Date()) {
          return session.userId
        }
      } catch (error) {
        console.warn('Error validating session from Authorization header:', error)
        // Continue to try cookie
      }
    }
  }
  
  // Fallback to cookie
  const sessionCookie = request.cookies.get('session')
  if (!sessionCookie) return null
  
  try {
    const session = await getSession(sessionCookie.value)
    if (session && session.expires > new Date()) {
      return session.userId
    }
    return null
  } catch (error) {
    console.warn('Error validating session from cookie:', error)
    return null
  }
}

/**
 * POST /api/games/:id/launch
 * 
 * Launch a casino game with wallet balance integration
 * - Creates game session in database
 * - Initializes session with casino provider
 * - Tracks user balance for game play
 * - Records game in recent games
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const launchLog: any = {
    timestamp: new Date().toISOString(),
    gameId: params.id,
    steps: [],
  }

  try {
    const userId = await getUserId(request)
    const gameId = params.id
    launchLog.userId = userId

    // User must be logged in to play
    if (!userId) {
      launchLog.steps.push({ step: 'auth_check', status: 'failed', error: 'User not authenticated' })
      console.log('[Game Launch Log]', JSON.stringify(launchLog, null, 2))
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      )
    }

    // For Slotegrator games, gameId is the UUID
    // We don't need to check database since games come from Slotegrator API
    // Just validate it's a valid UUID format (32+ hex characters)
    if (!gameId || gameId.length < 32) {
      launchLog.steps.push({ step: 'game_id_validation', status: 'failed', error: 'Invalid game ID format' })
      console.log('[Game Launch Log]', JSON.stringify(launchLog, null, 2))
      return NextResponse.json(
        { error: 'Invalid game ID' },
        { status: 400 }
      )
    }

    launchLog.steps.push({ step: 'game_id_validation', status: 'success', gameId })

    // Verify user exists in database (foreign key constraint requirement)
    const userExists = await queryOne<{ id: string }>(
      'SELECT id FROM users WHERE id = ?',
      [userId]
    )
    
    if (!userExists) {
      launchLog.steps.push({ 
        step: 'user_validation', 
        status: 'failed', 
        error: 'User not found in database',
        userId 
      })
      console.log('[Game Launch Log]', JSON.stringify(launchLog, null, 2))
      return NextResponse.json(
        { error: 'User account not found. Please log in again.' },
        { status: 404 }
      )
    }
    
    launchLog.steps.push({ step: 'user_validation', status: 'success', userId })

    // Get user's currency FIRST (needed for provider check)
    const profile = await queryOne<{ currency: string }>(
      'SELECT currency FROM user_profiles WHERE user_id = ?',
      [userId]
    )
    const userCurrency = profile?.currency || process.env.CASINO_DEFAULT_CURRENCY || 'USD'
    launchLog.userCurrency = userCurrency

    // Check if the game's provider is enabled before attempting launch
    // This prevents "provider not enabled" errors from Slotegrator
    // IMPORTANT: Providers are enabled PER CURRENCY - check for user's currency
    try {
      launchLog.steps.push({ step: 'provider_check_start', status: 'in_progress', currency: userCurrency })
      
      // Get enabled providers for the USER'S currency (not hardcoded USD)
      const enabledProviders = await getCachedData(
        `enabled-providers-${userCurrency}`,
        async () => {
          const providers = await getEnabledProviders(userCurrency)
          return Array.from(providers)
        },
        3600000 // Cache for 1 hour
      )
      const enabledProvidersSet = new Set(enabledProviders)
      
      launchLog.steps.push({ 
        step: 'get_enabled_providers', 
        status: 'success', 
        enabledProviders: Array.from(enabledProviders),
        count: enabledProviders.length
      })

      // If we have enabled providers list, verify the game's provider
      if (enabledProvidersSet.size > 0) {
        // Fetch game details to get provider name
        // We'll search through a small batch of games to find this one
        launchLog.steps.push({ step: 'fetch_game_details', status: 'in_progress' })
        
        const gamesResponse = await getGames({
          fetchAll: false,
          maxPages: 5, // Only fetch first 5 pages to find the game (250 games should be enough)
        })

        launchLog.steps.push({ 
          step: 'fetch_game_details', 
          status: 'success', 
          gamesFound: gamesResponse.items.length,
          totalPages: gamesResponse._meta?.pageCount
        })

        const game = gamesResponse.items.find(g => g.uuid === gameId)
        
        if (game) {
          const gameProvider = game.provider.trim()
          launchLog.gameDetails = {
            uuid: game.uuid,
            name: game.name,
            provider: gameProvider,
            provider_id: game.provider_id,
            type: game.type,
          }
          
          const isEnabled = Array.from(enabledProvidersSet).some(
            enabledProvider => enabledProvider.toLowerCase() === gameProvider.toLowerCase()
          )

          launchLog.steps.push({ 
            step: 'provider_validation', 
            status: isEnabled ? 'success' : 'failed',
            gameProvider,
            isEnabled,
            enabledProviders: Array.from(enabledProvidersSet)
          })

          if (!isEnabled) {
            console.warn(`[Game Launch] Blocked launch of game "${game.name}" from disabled provider "${gameProvider}"`)
            launchLog.steps.push({ step: 'launch_blocked', status: 'blocked', reason: 'Provider not enabled' })
            console.log('[Game Launch Log]', JSON.stringify(launchLog, null, 2))
            return NextResponse.json(
              { 
                error: 'This game is not available',
                message: 'This provider is not enabled for your contract'
              },
              { status: 403 }
            )
          }
        } else {
          // Game not found in first 5 pages - might be in later pages
          // We'll let it proceed and let Slotegrator handle the error
          console.warn(`[Game Launch] Game ${gameId} not found in first 5 pages, proceeding with launch`)
          launchLog.steps.push({ 
            step: 'game_not_found_in_first_pages', 
            status: 'warning',
            message: 'Game not found in first 5 pages, proceeding anyway'
          })
        }
      } else {
        launchLog.steps.push({ 
          step: 'no_enabled_providers', 
          status: 'warning',
          message: 'No enabled providers found, proceeding anyway'
        })
      }
    } catch (error) {
      // If provider check fails, log but don't block launch
      // This ensures we don't break the app if limits endpoint is down
      console.error('[Game Launch] Error checking enabled providers:', error)
      launchLog.steps.push({ 
        step: 'provider_check_error', 
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        message: 'Provider check failed, proceeding anyway'
      })
    }

    // Get user's wallet balance
    launchLog.steps.push({ step: 'get_wallet_balance', status: 'in_progress' })
    
    let wallet: { balance: number; bonus_balance?: number } | null = null
    let bonusBalance = 0
    
    try {
      // Try to get wallet with bonus_balance column (if it exists)
      wallet = await queryOne<{ 
        balance: number
        bonus_balance?: number
      }>(
        'SELECT balance, bonus_balance FROM wallets WHERE user_id = ?',
        [userId]
      )
      
      if (wallet && wallet.bonus_balance !== undefined && wallet.bonus_balance !== null) {
        bonusBalance = parseFloat(String(wallet.bonus_balance || '0'))
      }
    } catch (error: any) {
      // Fallback: bonus_balance column doesn't exist, query without it
      launchLog.steps.push({
        step: 'get_wallet_balance_retry',
        status: 'info',
        reason: 'bonus_balance column not found, retrying without it'
      })
      
      if (error.message && error.message.includes('no such column: bonus_balance')) {
        wallet = await queryOne<{ balance: number }>(
          'SELECT balance FROM wallets WHERE user_id = ?',
          [userId]
        )
        bonusBalance = 0
      } else {
        throw error
      }
    }

    if (!wallet) {
      launchLog.steps.push({ step: 'get_wallet_balance', status: 'failed', error: 'Wallet not found' })
      console.log('[Game Launch Log]', JSON.stringify(launchLog, null, 2))
      return NextResponse.json(
        { error: 'Wallet not found' },
        { status: 404 }
      )
    }

    const totalBalance = (wallet.balance || 0) + bonusBalance
    launchLog.wallet = {
      balance: wallet.balance,
      bonus_balance: bonusBalance,
      totalBalance
    }
    launchLog.steps.push({ step: 'get_wallet_balance', status: 'success', totalBalance })

    // Note: min_bet check removed since we're using Slotegrator games
    // You can add a minimum balance check here if needed

    // Check if game requires lobby (per documentation: Games With Lobby flow)
    // Documentation line 175-178: Games with lobby must call /games/lobby first
    launchLog.steps.push({ step: 'check_game_lobby_requirement', status: 'in_progress' })
    
    let lobbyData: string | undefined = undefined
    let gameDetails: Game | null = null
    
    // Fetch game details to check if it has lobby
    try {
      const gamesResponse = await getGames({
        fetchAll: false,
        maxPages: 10, // Search more pages to find the game
      })
      
      gameDetails = gamesResponse.items.find(g => g.uuid === gameId) || null
      
      if (gameDetails) {
        launchLog.gameDetails = {
          uuid: gameDetails.uuid,
          name: gameDetails.name,
          provider: gameDetails.provider,
          has_lobby: gameDetails.has_lobby,
        }
        
        // Check if game has lobby (has_lobby === 1 means it requires lobby)
        if (gameDetails.has_lobby === 1) {
          launchLog.steps.push({ 
            step: 'check_game_lobby_requirement', 
            status: 'success',
            requiresLobby: true,
            note: 'Game requires lobby - must call /games/lobby first'
          })
          
          // Use user's currency for lobby request (already fetched above)
          launchLog.steps.push({ 
            step: 'get_lobby_data', 
            status: 'in_progress',
            currency: userCurrency,
            note: 'Calling GET /games/lobby'
          })
          
          // Call /games/lobby to get lobby_data (required for games with lobby)
          const lobbyResponse = await getGameLobby(gameId, userCurrency)
          
          if (lobbyResponse.lobby && lobbyResponse.lobby.lobbyData) {
            lobbyData = lobbyResponse.lobby.lobbyData
            launchLog.steps.push({ 
              step: 'get_lobby_data', 
              status: 'success',
              lobbyData: lobbyData.substring(0, 20) + '...', // Log partial data
              lobbyName: lobbyResponse.lobby.name,
              isOpen: lobbyResponse.lobby.isOpen,
            })
          } else {
            throw new Error('No lobbyData returned from /games/lobby')
          }
        } else {
          launchLog.steps.push({ 
            step: 'check_game_lobby_requirement', 
            status: 'success',
            requiresLobby: false,
            note: 'Game does not require lobby - can call /games/init directly'
          })
        }
      } else {
        launchLog.steps.push({ 
          step: 'check_game_lobby_requirement', 
          status: 'warning',
          note: 'Game not found in first 10 pages - proceeding without lobby check'
        })
      }
    } catch (error) {
      console.error('[Game Launch] Error checking lobby requirement:', error)
      launchLog.steps.push({ 
        step: 'check_game_lobby_requirement', 
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        note: 'Lobby check failed - proceeding anyway (may cause error if game requires lobby)'
      })
      // Continue anyway - let Slotegrator handle the error
    }

    // Initialize game session with casino provider
    // gameId is the Slotegrator game UUID
    launchLog.steps.push({ 
      step: 'initialize_game_session', 
      status: 'in_progress', 
      note: 'Calling POST /games/init',
      hasLobbyData: !!lobbyData
    })
    
    const providerSession = await initializeGameSession(
      gameId, // This is the Slotegrator game UUID
      userId,
      totalBalance,
      {
        lobbyData: lobbyData // Pass lobby_data if game requires it
      }
    )
    
    launchLog.steps.push({ 
      step: 'initialize_game_session', 
      status: 'success',
      sessionId: providerSession.sessionId,
      gameUrl: providerSession.gameUrl,
      expiresAt: providerSession.expiresAt
    })

    // Create game session record in database
    const sessionId = nanoid()
    await query(
      `INSERT INTO game_sessions 
        (id, user_id, game_id, session_token, started_at, initial_balance) 
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
      [sessionId, userId, gameId, providerSession.sessionId, totalBalance]
    )

    // Track in recent games
    const existingRecent = await queryOne<{ id: string }>(
      'SELECT id FROM recent_games WHERE user_id = ? AND game_id = ?',
      [userId, gameId]
    )

    if (existingRecent) {
      await query(
        'UPDATE recent_games SET last_played = CURRENT_TIMESTAMP WHERE user_id = ? AND game_id = ?',
        [userId, gameId]
      )
    } else {
      await query(
        'INSERT INTO recent_games (id, user_id, game_id, last_played) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
        [nanoid(), userId, gameId]
      )
    }

    // Return game launch information
    launchLog.steps.push({ step: 'launch_complete', status: 'success' })
    launchLog.result = {
      sessionId,
      gameId: gameId,
      gameUrl: providerSession.gameUrl,
      balance: totalBalance,
      expiresAt: providerSession.expiresAt,
    }
    
    console.log('[Game Launch Log - SUCCESS]', JSON.stringify(launchLog, null, 2))
    // Write to file
    writeGameLaunchLog(gameId, launchLog)
    
    return NextResponse.json({
      sessionId,
      gameId: gameId, // Slotegrator UUID
      gameUrl: providerSession.gameUrl,
      balance: totalBalance,
      expiresAt: providerSession.expiresAt,
      message: 'Game session created successfully'
    })
  } catch (error) {
    console.error('Error launching game:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const errorStack = error instanceof Error ? error.stack : undefined
    
    // Capture error details in launch log
    launchLog.steps.push({ 
      step: 'launch_error', 
      status: 'failed',
      error: errorMessage,
      errorDetails: error instanceof Error && (error as any).details ? (error as any).details : null,
      requestLog: error instanceof Error && (error as any).requestLog ? (error as any).requestLog : null,
      responseLog: error instanceof Error && (error as any).responseLog ? (error as any).responseLog : null,
    })
    
    // Log full error details for debugging
    console.error('Error details:', {
      message: errorMessage,
      stack: errorStack,
      gameId: params.id,
    })
    
    // Log complete launch log with error
    console.log('[Game Launch Log - ERROR]', JSON.stringify(launchLog, null, 2))
    // Write to file
    writeGameLaunchLog(params.id, launchLog)
    
    return NextResponse.json(
      { 
        error: 'Failed to launch game',
        message: errorMessage,
        // Include full launch log in development
        ...(process.env.NODE_ENV === 'development' && { 
          stack: errorStack,
          launchLog 
        })
      },
      { status: 500 }
    )
  }
}

