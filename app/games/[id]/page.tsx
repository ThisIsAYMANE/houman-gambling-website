'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, Play, Heart, Loader2 } from 'lucide-react'
import GameLaunch from '@/components/casino/GameLaunch'
import { mockGames } from '@/lib/mockData'

interface Game {
  id: string
  title: string
  slug: string
  description?: string
  thumbnail_url?: string
  game_url: string
  provider_name: string
  provider_logo?: string
  player_count?: number
  multiplier?: number
  is_new?: boolean
  is_exclusive?: boolean
  is_original?: boolean
  category_name?: string
}

export default function GameDetailPage() {
  const params = useParams()
  const router = useRouter()
  const gameId = params.id as string

  const [game, setGame] = useState<Game | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isFavorite, setIsFavorite] = useState(false)
  const [launching, setLaunching] = useState(false)

  useEffect(() => {
    if (gameId) {
      fetchGame()
      checkFavorite()
    }
  }, [gameId])

  const fetchGame = async () => {
    try {
      setLoading(true)
      // TODO: Replace with actual API call
      // const response = await fetch(`/api/games/${gameId}`)
      // if (!response.ok) {
      //   throw new Error('Game not found')
      // }
      // const data = await response.json()
      // setGame(data.game)
      
      // Using mock data for now
      await new Promise(resolve => setTimeout(resolve, 500))
      const gameData = mockGames.find(g => g.id === gameId)
      if (!gameData) {
        throw new Error('Game not found')
      }
      setGame(gameData)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load game')
    } finally {
      setLoading(false)
    }
  }

  const checkFavorite = async () => {
    try {
      // TODO: Replace with actual API call
      // const response = await fetch('/api/games/favorites')
      // if (response.ok) {
      //   const data = await response.json()
      //   const isFav = data.games?.some((g: Game) => g.id === gameId)
      //   setIsFavorite(isFav)
      // }
      
      // Using mock data for now
      await new Promise(resolve => setTimeout(resolve, 200))
      setIsFavorite(gameId === '1' || gameId === '2') // First two games are favorites
    } catch (error) {
      console.error('Error checking favorite:', error)
    }
  }

  const toggleFavorite = async () => {
    if (!game) return

    try {
      const method = isFavorite ? 'DELETE' : 'POST'
      const response = await fetch(`/api/games/${gameId}/favorite`, {
        method
      })

      if (response.ok) {
        setIsFavorite(!isFavorite)
      }
    } catch (error) {
      console.error('Error toggling favorite:', error)
    }
  }

  const handleLaunch = async () => {
    if (!game) return

    try {
      setLaunching(true)
      const response = await fetch(`/api/games/${gameId}/launch`, {
        method: 'POST'
      })
      const data = await response.json()

      if (response.ok) {
        // GameLaunch component will handle the iframe
        setLaunching(true)
      }
    } catch (error) {
      console.error('Error launching game:', error)
      setLaunching(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-accent-primary animate-spin" />
      </div>
    )
  }

  if (error || !game) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-500 mb-4">{error || 'Game not found'}</p>
          <button
            onClick={() => router.back()}
            className="px-6 py-2 bg-accent-primary text-white rounded-lg hover:bg-accent-primary/90"
          >
            Retour
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="min-h-screen">
        {/* Header */}
        <div className="mb-6">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-2 text-text-secondary hover:text-text-primary mb-4 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
            Retour
          </button>
        </div>

        {/* Game Info */}
        <div className="bg-bg-secondary rounded-lg border border-border-primary p-6 mb-6">
          <div className="flex flex-col md:flex-row gap-6">
            {/* Game Thumbnail/Preview */}
            <div className="w-full md:w-64 h-64 rounded-lg bg-gradient-to-b from-gray-800 via-gray-700 to-gray-600 flex items-center justify-center flex-shrink-0">
              <Play className="w-24 h-24 text-white/80" />
            </div>

            {/* Game Details */}
            <div className="flex-1">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h1 className="text-3xl font-bold text-text-primary mb-2">{game.title}</h1>
                  <p className="text-text-secondary">{game.provider_name}</p>
                </div>
                <button
                  onClick={toggleFavorite}
                  className={`p-3 rounded-lg transition-colors ${
                    isFavorite
                      ? 'bg-red-500/20 text-red-500'
                      : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                  }`}
                >
                  <Heart className={`w-6 h-6 ${isFavorite ? 'fill-current' : ''}`} />
                </button>
              </div>

              {game.description && (
                <p className="text-text-secondary mb-4">{game.description}</p>
              )}

              <div className="flex flex-wrap gap-2 mb-4">
                {game.is_original && (
                  <span className="px-3 py-1 bg-purple-600 text-white text-sm font-bold rounded">
                    ORIGINAL
                  </span>
                )}
                {game.is_exclusive && (
                  <span className="px-3 py-1 bg-orange-500 text-white text-sm font-bold rounded">
                    EXCLUSIF
                  </span>
                )}
                {game.is_new && (
                  <span className="px-3 py-1 bg-green-500 text-white text-sm font-bold rounded">
                    NOUVEAU
                  </span>
                )}
                {game.category_name && (
                  <span className="px-3 py-1 bg-bg-tertiary text-text-primary text-sm rounded">
                    {game.category_name}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-6 text-sm text-text-secondary mb-6">
                {game.player_count !== undefined && (
                  <span>👥 {game.player_count.toLocaleString()} joueurs</span>
                )}
                {game.multiplier && (
                  <span>⚡ {game.multiplier}x multiplicateur</span>
                )}
              </div>

              <button
                onClick={handleLaunch}
                disabled={launching}
                className="px-8 py-3 bg-accent-primary text-white rounded-lg font-semibold hover:bg-accent-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {launching ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Lancement...
                  </>
                ) : (
                  <>
                    <Play className="w-5 h-5" />
                    Jouer maintenant
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Game Launch Modal */}
      {launching && game && (
        <GameLaunch
          gameId={game.id}
          gameUrl={game.game_url}
          gameTitle={game.title}
          onClose={() => setLaunching(false)}
        />
      )}
    </>
  )
}

