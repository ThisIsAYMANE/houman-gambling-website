import crypto from 'crypto'
import { writeApiLog } from './file-logger'

// ============================================
// Types
// ============================================

export interface SelfValidateResponse {
  success: boolean
  log: string[]
}

export interface GameSessionInitResponse {
  sessionId: string
  gameUrl: string
  expiresAt: string
}

export interface CasinoApiConfig {
  merchantId: string
  merchantKey: string
  baseUrl: string
}

// ============================================
// Configuration
// ============================================

export function getCasinoConfig(): CasinoApiConfig {
  const merchantId = process.env.CASINO_MERCHANT_ID
  const merchantKey = process.env.CASINO_MERCHANT_KEY
  const baseUrl = process.env.CASINO_API_BASE_URL

  if (!merchantId || !merchantKey || !baseUrl) {
    throw new Error(
      'Casino API configuration missing. Please set CASINO_MERCHANT_ID, CASINO_MERCHANT_KEY, and CASINO_API_BASE_URL environment variables.'
    )
  }

  return {
    merchantId,
    merchantKey,
    baseUrl: baseUrl.replace(/\/$/, ''), // Remove trailing slash
  }
}

// ============================================
// X-Sign Authentication
// ============================================

/**
 * Calculate X-Sign for outgoing requests
 *
 * Algorithm:
 * 1. Merge request parameters with authorization headers
 * 2. Sort resulting array by key (ascending)
 * 3. Generate URL-encoded query string
 * 4. Use SHA1 HMAC with Merchant Key for signing
 */
export function calculateXSign(
  params: Record<string, any>,
  headers: Record<string, string>,
  merchantKey: string,
  useRawValues: boolean = false
): string {
  // Filter out X-Sign if it was accidentally passed in headers
  const filteredHeaders = Object.entries(headers).reduce(
    (acc, [key, value]) => {
      if (key.toLowerCase() !== 'x-sign') {
        acc[key] = value
      }
      return acc
    },
    {} as Record<string, string>
  )

  // Merge params and headers for signing (as per Slotegrator documentation)
  const allParams = { ...params, ...filteredHeaders }

  // Sort by key (ascending, ASCII order)
  const sortedKeys = Object.keys(allParams).sort()

  /**
   * Perfectly mimic PHP's http_build_query (RFC 1738)
   */
  const encodePHP = (str: string) => {
    return encodeURIComponent(str)
      .replace(/%20/g, '+')
      .replace(/!/g, '%21')
      .replace(/'/g, '%27')
      .replace(/\(/g, '%28')
      .replace(/\)/g, '%29')
      .replace(/\*/g, '%2A')
      .replace(/~/g, '%7E')
  }

  // Build query string
  const queryString = sortedKeys
    .map((key) => {
      let value = allParams[key]
      if (typeof value === 'boolean') value = value ? '1' : '0'
      if (value === null || value === undefined) value = ''

      const stringValue = String(value)

      if (useRawValues) {
        // Documentation sometimes implies raw concatenation for callbacks
        return `${key}=${stringValue}`
      } else {
        // Documentation explicitly says http_build_query for API calls
        return `${encodePHP(key)}=${encodePHP(stringValue)}`
      }
    })
    .join('&')

  // Generate SHA1 HMAC
  const signature = crypto.createHmac('sha1', merchantKey).update(queryString).digest('hex')

  return signature
}

/**
 * Validate X-Sign for incoming callback requests
 */
export function validateXSign(
  params: Record<string, any>,
  headers: Record<string, string>,
  receivedSign: string,
  merchantKey?: string
): boolean {
  // Use the actual Merchant Key from environment (passed by caller)
  if (!merchantKey) {
    // Fallback for testing/development (should not reach here in production)
    merchantKey = 'b83d51ea35e2620a4e29913a9059e8e5038caa64'
  }

  // Strictly only use these 3 headers for the signature
  const authHeaderKeys = ['x-merchant-id', 'x-timestamp', 'x-nonce']
  const normalizedHeaders: Record<string, string> = {}

  for (const key in headers) {
    const lowerKey = key.toLowerCase()
    if (authHeaderKeys.includes(lowerKey)) {
      let normalizedKey = key
      // MUST match Pascal-Case exactly so sorting puts 'X-' before 'a'
      if (lowerKey === 'x-merchant-id') normalizedKey = 'X-Merchant-Id'
      else if (lowerKey === 'x-timestamp') normalizedKey = 'X-Timestamp'
      else if (lowerKey === 'x-nonce') normalizedKey = 'X-Nonce'

      normalizedHeaders[normalizedKey] = headers[key]
    }
  }

  // Dual Validation Strategy:
  // Slotegrator providers inconsistently use RAW vs. PHP-ENCODED signatures.
  // We calculate both and succeed if either matches.

  // 1. PHP-compliant url-encoding
  const sigEncoded = calculateXSign(params, normalizedHeaders, merchantKey, false)
  if (sigEncoded === receivedSign) return true

  // 2. Raw values (no url-encoding)
  const sigRaw = calculateXSign(params, normalizedHeaders, merchantKey, true)
  if (sigRaw === receivedSign) return true

  // If both failed, log details in development
  if (process.env.NODE_ENV === 'development') {
    console.error('[Casino Signature Validation Failed]')
    console.error('Params:', JSON.stringify(params, null, 2))
    console.error('Normalized Headers:', JSON.stringify(normalizedHeaders, null, 2))
    console.error('Received:', receivedSign)
    console.error('Candidate (Encoded):', sigEncoded)
    console.error('Candidate (Raw):', sigRaw)
  }

  return false
}

/**
 * Generate authorization headers for Casino API requests
 */
function generateAuthHeaders(
  merchantId: string,
  merchantKey: string,
  requestParams: Record<string, any> = {}
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const nonce = crypto.randomBytes(16).toString('hex')

  const headers: Record<string, string> = {
    'X-Merchant-Id': merchantId,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
  }

  // Calculate X-Sign
  const xSign = calculateXSign(requestParams, headers, merchantKey)
  headers['X-Sign'] = xSign

  return headers
}

// ============================================
// API Client
// ============================================

/**
 * Make authenticated request to Casino API
 */
async function makeCasinoRequest<T>(
  endpoint: string,
  method: 'GET' | 'POST' = 'GET',
  params?: Record<string, any>,
  bodyParams?: Record<string, any>
): Promise<T> {
  const config = getCasinoConfig()

  // For GET requests, params go in URL query string
  // For POST requests, params go in body
  let url = `${config.baseUrl}${endpoint}`
  let body: string | undefined

  // For POST requests, use bodyParams if provided, otherwise use params
  const requestParams = method === 'POST' && bodyParams ? bodyParams : params

  if (method === 'GET' && params) {
    const queryString = new URLSearchParams(
      Object.entries(params).reduce(
        (acc, [key, value]) => {
          if (value !== undefined && value !== null) {
            acc[key] = String(value)
          }
          return acc
        },
        {} as Record<string, string>
      )
    ).toString()
    if (queryString) {
      url += (endpoint.includes('?') ? '&' : '?') + queryString
    }
  } else if (method === 'POST' && requestParams) {
    const formData = new URLSearchParams()
    Object.entries(requestParams).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        formData.append(key, String(value))
      }
    })
    body = formData.toString()
  }

  // Generate auth headers (requestParams are used for X-Sign calculation)
  const authHeaders = generateAuthHeaders(
    config.merchantId,
    config.merchantKey,
    requestParams || {}
  )

  // Prepare request
  const headers: Record<string, string> = {
    ...authHeaders,
    Accept: 'application/json',
  }

  // Only add Content-Type for POST requests
  if (method === 'POST') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }

  let requestOptions: RequestInit = {
    method,
    headers,
  }

  if (body) {
    requestOptions.body = body
  }

  // Log full request details for debugging
  const requestLog = {
    timestamp: new Date().toISOString(),
    endpoint: `${method} ${endpoint}`,
    fullUrl: url,
    headers: {
      ...headers,
      // Don't log the full merchant key, but show it exists
      'X-Merchant-Id': headers['X-Merchant-Id'],
      'X-Timestamp': headers['X-Timestamp'],
      'X-Nonce': headers['X-Nonce'],
      'X-Sign': headers['X-Sign'] ? `${headers['X-Sign'].substring(0, 8)}...` : 'missing',
    },
    body: body || null,
    params: requestParams || params || null,
  }
  console.log('[Casino API Request]', JSON.stringify(requestLog, null, 2))
  // Write to file
  writeApiLog('request', `${method} ${endpoint}`, requestLog)

  // Make request
  const response = await fetch(url, requestOptions)

  // Get response headers
  const responseHeaders: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })

  // Read response body (we need to clone to read it without consuming)
  const responseClone = response.clone()
  let responseBody: any = null
  let responseText: string = ''

  try {
    responseText = await responseClone.text()
    try {
      responseBody = JSON.parse(responseText)
    } catch {
      responseBody = responseText
    }
  } catch (error) {
    console.warn('[Casino API] Could not read response body:', error)
  }

  // Log full response details
  const responseLog = {
    timestamp: new Date().toISOString(),
    endpoint: `${method} ${endpoint}`,
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    body: responseBody,
    rawBody: responseText,
  }
  console.log('[Casino API Response]', JSON.stringify(responseLog, null, 2))
  // Write to file
  writeApiLog('response', `${method} ${endpoint}`, responseLog)

  // Handle errors
  if (!response.ok) {
    let errorMessage = `Casino API request failed: ${response.status} ${response.statusText}`
    let errorDetails: any = responseBody || {}

    if (responseBody && typeof responseBody === 'object') {
      errorMessage = responseBody.message || responseBody.name || responseBody.error || errorMessage
      errorDetails = responseBody
    } else if (responseText) {
      errorMessage = responseText
      errorDetails = { raw: responseText }
    }

    // Create a more detailed error
    const detailedError = new Error(errorMessage)
    // Attach additional details for debugging
    ;(detailedError as any).status = response.status
    ;(detailedError as any).statusText = response.statusText
    ;(detailedError as any).details = errorDetails
    ;(detailedError as any).endpoint = endpoint
    ;(detailedError as any).requestLog = requestLog
    ;(detailedError as any).responseLog = responseLog

    const errorLog = {
      endpoint,
      method,
      status: response.status,
      statusText: response.statusText,
      errorMessage,
      errorDetails,
      request: requestLog,
      response: responseLog,
    }
    console.error('[Casino API Error]', JSON.stringify(errorLog, null, 2))
    // Write to file
    writeApiLog('error', `${method} ${endpoint}`, errorLog)

    throw detailedError
  }

  return responseBody as T
}

// ============================================
// Self Validation
// ============================================

/**
 * POST /self-validate - Self Validation
 *
 * Allows integrator to check if implementation is correct.
 * Requires active game session (opened within 15 minutes).
 *
 * @returns Validation result with success status and log messages
 */
export async function selfValidate(): Promise<SelfValidateResponse> {
  try {
    const response = await makeCasinoRequest<SelfValidateResponse>('/self-validate', 'POST')

    return response
  } catch (error) {
    console.error('Self-validation error:', error)
    throw error
  }
}

// ============================================
// Games
// ============================================

export interface Game {
  uuid: string
  name: string
  image: string
  type: string
  provider: string
  provider_id: number
  technology: string
  has_lobby: number
  is_mobile: number
  has_freespins: number
  has_tables: number
  freespin_valid_until_full_day?: number
  label?: string
  tags?: Array<{ code: string; label: string }>
  parameters?: {
    rtp?: number
    volatility?: string
    reels_count?: string
    lines_count?: number
  }
  images?: Array<{
    name: string
    file: string
    url: string
    type: string
  }>
  related_games?: Game[]
}

export interface GamesResponse {
  items: Game[]
  _links?: {
    self?: { href: string }
    next?: { href: string }
    last?: { href: string }
  }
  _meta?: {
    totalCount: number
    pageCount: number
    currentPage: number
    perPage: number
  }
}

/**
 * GET /games - Retrieve Games List
 *
 * Returns collection of games available for your Merchant ID.
 * Supports pagination to fetch all games.
 *
 * @param options.expand - Additional object expansions (tags, parameters, images, related_games)
 * @param options.fetchAll - If true, fetches all pages (default: false)
 * @param options.maxPages - Maximum number of pages to fetch (default: 200)
 */
export async function getGames(options?: {
  expand?: string
  fetchAll?: boolean
  maxPages?: number
}): Promise<GamesResponse> {
  try {
    const queryParams: Record<string, any> = {}

    if (options?.expand) {
      queryParams.expand = options.expand
    }

    // Fetch first page
    const firstPage = await makeCasinoRequest<GamesResponse>(
      '/games',
      'GET',
      Object.keys(queryParams).length > 0 ? queryParams : undefined
    )

    // Determine max pages to fetch
    const maxPages = options?.maxPages || (options?.fetchAll ? 200 : 1)

    // If fetchAll is false and maxPages is 1, return first page only
    if (!options?.fetchAll && maxPages <= 1) {
      return firstPage
    }

    // Fetch remaining pages
    const allGames = [...firstPage.items]
    let currentPage = 1
    const totalPages = firstPage._meta?.pageCount || 1

    // Log what we're doing
    if (maxPages > 1) {
      console.log(
        `Fetching games: ${totalPages} total pages, ${firstPage._meta?.totalCount || 0} total games, fetching up to ${maxPages} pages (maxPages=${maxPages})`
      )
    }

    // Fetch remaining pages if there are more
    // Add a small delay between requests to avoid rate limiting (staging allows 100 req/sec)
    // IMPORTANT: Stop when we reach maxPages (don't fetch more than needed)
    while (currentPage < totalPages && currentPage < maxPages) {
      try {
        currentPage++

        // CRITICAL: Check if we've exceeded maxPages before making the request
        if (currentPage > maxPages) {
          console.log(`Stopping: currentPage (${currentPage}) > maxPages (${maxPages})`)
          break
        }

        // Add delay to avoid rate limiting (10ms = 100 req/sec max)
        if (currentPage > 1) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }

        const nextParams: Record<string, any> = { ...queryParams, page: currentPage }

        const nextPage = await makeCasinoRequest<GamesResponse>('/games', 'GET', nextParams)

        allGames.push(...nextPage.items)

        // Log progress every 10 pages
        if (currentPage % 10 === 0) {
          console.log(
            `Fetched ${currentPage}/${maxPages} pages (max), ${allGames.length} games so far...`
          )
        }

        // Break if no more items
        if (nextPage.items.length === 0) {
          console.log(`No more items on page ${currentPage}, stopping`)
          break
        }
      } catch (error) {
        console.error(`Error fetching page ${currentPage}:`, error)
        // Continue with what we have rather than failing completely
        break
      }
    }

    console.log(`Finished fetching: ${allGames.length} games from ${currentPage} pages`)

    return {
      items: allGames,
      _meta: {
        totalCount: allGames.length,
        pageCount: 1,
        currentPage: 1,
        perPage: allGames.length,
      },
      _links: firstPage._links,
    }
  } catch (error) {
    console.error('Error fetching games:', error)
    throw error
  }
}

// ============================================
// Limits & Enabled Providers
// ============================================

export interface MerchantLimit {
  amount: string
  currency: string
  providers: string[]
}

/**
 * GET /limits - Get Merchant Limits
 *
 * Returns list of limits for merchant, including enabled providers per currency.
 * This can be used to filter games to only show games from enabled providers.
 */
export async function getMerchantLimits(): Promise<MerchantLimit[]> {
  try {
    const response = await makeCasinoRequest<MerchantLimit[]>('/limits', 'GET')
    return response
  } catch (error) {
    console.error('Error fetching merchant limits:', error)
    // Return empty array if limits endpoint fails (non-critical)
    return []
  }
}

/**
 * Get enabled providers for a specific currency
 *
 * IMPORTANT: Providers are enabled PER CURRENCY. A provider enabled for EUR
 * may not be enabled for USD. This function returns providers enabled for the
 * specified currency only.
 *
 * @param currency - Currency code (e.g., 'USD', 'EUR')
 * @returns Set of enabled provider names for the specified currency
 */
export async function getEnabledProviders(currency: string = 'USD'): Promise<Set<string>> {
  try {
    const limits = await getMerchantLimits()
    const enabledProviders = new Set<string>()

    console.log(`[Provider Filter] Fetching enabled providers for currency: ${currency}`)
    console.log(`[Provider Filter] Limits response:`, JSON.stringify(limits, null, 2))

    // FIRST: Find limits for the SPECIFIC currency requested
    const currencyLimits = limits.filter(
      (limit) => limit.currency && limit.currency.toUpperCase() === currency.toUpperCase()
    )

    if (currencyLimits.length > 0) {
      // Found limits for the requested currency
      currencyLimits.forEach((limit) => {
        if (limit.providers && Array.isArray(limit.providers)) {
          limit.providers.forEach((provider) => {
            enabledProviders.add(provider.trim())
          })
        }
      })
      console.log(
        `[Provider Filter] Found ${enabledProviders.size} providers enabled for ${currency}`
      )
    } else {
      // No limits found for requested currency
      console.warn(
        `[Provider Filter] No providers found for currency ${currency}. Available currencies:`,
        limits.map((l) => l.currency).filter(Boolean)
      )

      // Fallback: collect from all currencies (but log warning)
      // This is a fallback behavior - ideally we should match by currency
      limits.forEach((limit) => {
        if (limit.providers && Array.isArray(limit.providers)) {
          limit.providers.forEach((provider) => {
            enabledProviders.add(provider.trim())
          })
        }
      })
      console.warn(
        `[Provider Filter] Using fallback: collected ${enabledProviders.size} providers from all currencies`
      )
    }

    console.log(
      `[Provider Filter] Found ${enabledProviders.size} enabled providers for ${currency}:`,
      Array.from(enabledProviders)
    )

    return enabledProviders
  } catch (error) {
    console.error('[Provider Filter] Error getting enabled providers:', error)
    // Return empty set if we can't determine enabled providers
    // This means we'll show all games (fallback behavior)
    return new Set<string>()
  }
}

// ============================================
// Lobby
// ============================================

interface LobbyResponse {
  lobby: {
    lobbyData: string
    name: string
    isOpen: boolean
    openTime?: string
    closeTime?: string
    dealerName?: string
    dealerAvatar?: string
    technology?: string
    limits?:
      | Array<{
          currency: string
          min: number
          max: number
        }>
      | {
          currency: string
          min: number
          max: number
        }
    tableId?: string
  }
}

/**
 * GET /games/lobby - Get Lobby Tables
 *
 * Returns list of tables for games with lobby.
 * Required before calling /games/init for games with has_lobby === 1
 *
 * @param gameUuid - Game UUID from /games
 * @param currency - Player currency
 * @param technology - Optional: "html5" or "flash"
 */
export async function getGameLobby(
  gameUuid: string,
  currency: string,
  technology?: 'html5' | 'flash'
): Promise<LobbyResponse> {
  try {
    const params: Record<string, string> = {
      game_uuid: gameUuid,
      currency,
    }

    if (technology) {
      params.technology = technology
    }

    const response = await makeCasinoRequest<LobbyResponse>('/games/lobby', 'GET', params)

    return response
  } catch (error) {
    console.error('Error fetching game lobby:', error)
    throw error
  }
}

// ============================================
// Game Session Initialization
// ============================================

interface InitGameParams {
  game_uuid: string
  player_id: string
  player_name: string
  currency: string
  session_id: string
  device?: string
  return_url?: string
  language?: string
  email?: string
  lobby_data?: string
}

interface InitGameResponse {
  url: string
}

/**
 * Initialize game session with casino provider
 *
 * Calls POST /games/init to get the game URL for player redirection.
 *
 * @param gameId - Game UUID from Slotegrator
 * @param userId - User ID on integrator side
 * @param balance - Player balance (for validation)
 * @param options - Additional options (player name, currency, language, etc.)
 */
export async function initializeGameSession(
  gameId: string,
  userId: string,
  balance: number,
  options?: {
    playerName?: string
    currency?: string
    language?: string
    email?: string
    device?: 'desktop' | 'mobile'
    returnUrl?: string
    lobbyData?: string
  }
): Promise<GameSessionInitResponse> {
  try {
    const config = getCasinoConfig()

    // Generate unique session ID
    const sessionId = `session_${userId}_${Date.now()}_${Math.random().toString(36).substring(7)}`

    // Get user info from database
    const { queryOne } = await import('@/lib/db')

    // Get user email and username
    const user = await queryOne<{ email: string; username: string | null }>(
      'SELECT email, username FROM users WHERE id = ?',
      [userId]
    )

    if (!user) {
      throw new Error('User not found')
    }

    // Get user profile for currency and language
    const profile = await queryOne<{
      currency: string
      language: string
      first_name: string | null
      last_name: string | null
    }>('SELECT currency, language, first_name, last_name FROM user_profiles WHERE user_id = ?', [
      userId,
    ])

    // Prepare parameters for /games/init
    const params: InitGameParams = {
      game_uuid: gameId,
      player_id: userId,
      player_name:
        options?.playerName ||
        (profile?.first_name && profile?.last_name
          ? `${profile.first_name} ${profile.last_name}`
          : user.username || user.email.split('@')[0] || 'Player'),
      // Use currency from options, profile, or environment variable, default to USD
      // Note: Currency must be enabled in your Slotegrator contract
      // Common supported currencies: USD, EUR, GBP, CAD, AUD, etc.
      currency:
        options?.currency || profile?.currency || process.env.CASINO_DEFAULT_CURRENCY || 'USD',
      session_id: sessionId,
      device: options?.device || 'desktop',
      return_url:
        options?.returnUrl ||
        process.env.CASINO_TEST_AREA_URL ||
        `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/casino`,
      language: options?.language || profile?.language || 'fr',
      email: options?.email || user.email,
    }

    // Add lobby_data if provided (for games with lobby)
    if (options?.lobbyData) {
      params.lobby_data = options.lobbyData
    }

    // Call POST /games/init
    const response = await makeCasinoRequest<InitGameResponse>(
      '/games/init',
      'POST',
      undefined,
      params
    )

    if (!response.url) {
      throw new Error('No game URL returned from Slotegrator')
    }

    return {
      sessionId,
      gameUrl: response.url,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 minutes
    }
  } catch (error) {
    console.error('Error initializing game session:', error)
    throw error
  }
}
