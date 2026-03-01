import { useParams, useNavigate } from 'react-router-dom'
import { useEffect, useState, useRef } from 'react'
import { getWebSocketURL } from '@/lib/api'

type ProgressPhase = 
  | 'queued' 
  | 'initializing'
  | 'data_collection'
  | 'injury_analysis'
  | 'transfer_optimization'
  | 'chip_strategy'
  | 'captain_analysis'
  | 'finalization'
  | 'collecting_data'
  | 'processing'
  | 'analyzing'
  | 'complete'

interface ProgressUpdate {
  type: 'progress' | 'complete' | 'error'
  progress?: number
  phase?: string
  results?: any
  error?: string
}

const PHASE_LABELS: Record<string, string> = {
  queued: 'QUEUED',
  initializing: 'INITIALIZING',
  data_collection: 'DATA COLLECTION',
  injury_analysis: 'INJURY ANALYSIS',
  transfer_optimization: 'TRANSFER OPTIMIZATION',
  chip_strategy: 'CHIP STRATEGY',
  captain_analysis: 'CAPTAIN ANALYSIS',
  finalization: 'FINALIZATION',
  collecting_data: 'COLLECTING',
  processing: 'PROCESSING',
  analyzing: 'ANALYZING',
  complete: 'COMPLETE',
}

export default function Progress() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [progress, setProgress] = useState(0)
  const [phase, setPhase] = useState<ProgressPhase>('queued')
  const [error, setError] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const reconnectAttemptsRef = useRef(0)
  const MAX_RECONNECT_ATTEMPTS = 5

  useEffect(() => {
    if (!id) return

    const connectWebSocket = () => {
      const wsUrl = getWebSocketURL(id)
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        console.log('WebSocket connected')
        setReconnecting(false)
        reconnectAttemptsRef.current = 0 // Reset on successful connection
      }

      ws.onmessage = (event) => {
        const data: ProgressUpdate = JSON.parse(event.data)
        console.log('WebSocket message:', data)

        if (data.type === 'progress') {
          if (data.progress !== undefined) {
            setProgress(data.progress)
          }
          if (data.phase) {
            setPhase(data.phase as ProgressPhase)
          }
        } else if (data.type === 'complete') {
          setProgress(100)
          setPhase('complete')
          
          // Cache results in sessionStorage for the Results page
          if (data.results && id) {
            sessionStorage.setItem(`analysis_${id}`, JSON.stringify({
              status: 'completed',
              results: data.results
            }))
          }
          
          // Navigate to results after brief delay
          setTimeout(() => {
            navigate(`/results/${id}`)
          }, 1500)
        } else if (data.type === 'error') {
          setError(data.error || 'Analysis failed')
        }
      }

      ws.onerror = (error) => {
        console.error('WebSocket error:', error)
      }

      ws.onclose = (event) => {
        console.log('WebSocket closed:', event.code, event.reason)
        
        // Reconnect if not a normal closure and not already complete
        if (event.code !== 1000 && phase !== 'complete' && !error) {
          if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
            setReconnecting(true)
            reconnectAttemptsRef.current += 1
            console.log(`Reconnect attempt ${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS}`)
            
            reconnectTimeoutRef.current = setTimeout(() => {
              console.log('Attempting to reconnect...')
              connectWebSocket()
            }, 2000)
          } else {
            // Max reconnection attempts reached
            console.error('Max reconnection attempts reached')
            setError('Connection lost — unable to reconnect. Backend may be offline.')
            setReconnecting(false)
          }
        }
      }
    }

    connectWebSocket()

    // Cleanup
    return () => {
      if (wsRef.current) {
        wsRef.current.close()
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
    }
  }, [id, navigate])

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="max-w-lg w-full space-y-6">
          <div className="space-y-2">
            <h1 className="text-decision text-veto">ANALYSIS FAILED</h1>
            <p className="text-meta text-sage-muted uppercase">ID: {id}</p>
          </div>
          
          <div className="bg-surface-card border border-veto p-6">
            <p className="text-body text-veto">{error}</p>
          </div>

          <button
            onClick={() => navigate('/')}
            className="w-full h-12 bg-hold text-bg-primary text-body font-medium hover:bg-hold/90"
          >
            RETURN TO CONSOLE
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="max-w-lg w-full space-y-6">
        <div className="space-y-1">
          <h1 className="text-decision text-sage-white">RUNNING ANALYSIS</h1>
          <p className="text-meta text-sage-muted uppercase">
            Runtime: 2-3 minutes
          </p>
        </div>
        
        <div className="bg-surface-card p-8 border border-surface-elevated space-y-6">
          {/* Current Phase */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                {PHASE_LABELS[phase] || phase}
              </span>
              <span className="text-sm text-muted-foreground">
                {Math.round(progress)}%
              </span>
            </div>
            <div className="flex justify-between items-baseline">
              <span className="text-section text-sage-white">
                {PHASE_LABELS[phase] || 'UNKNOWN'}
              </span>
              <span className="text-meta text-sage-muted tabular-nums">
                {Math.round(progress)}%
              </span>
            </div>
            
            {/* Progress Bar - Minimal */}
            <div className="h-1 bg-surface-elevated">
              <div 
                className="h-full bg-hold transition-all duration-300" 
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* Reconnection Warning */}
          {reconnecting && (
            <div className="p-4 bg-surface-elevated border border-risky">
              <p className="text-body text-risky">
                Connection lost — reconnecting ({reconnectAttemptsRef.current}/{MAX_RECONNECT_ATTEMPTS})
              </p>
            </div>
          )}

          {/* Phase Steps - Factual list */}
          <div className="pt-4 border-t border-surface-elevated space-y-3">
            <h3 className="text-meta text-sage-muted uppercase tracking-wide">
              Process
            </h3>
            <div className="space-y-2">
              {['queued', 'initializing', 'data_collection', 'injury_analysis', 'transfer_optimization', 'chip_strategy', 'captain_analysis', 'finalization', 'complete'].map((p) => {
                const currentIndex = Object.keys(PHASE_LABELS).indexOf(phase)
                const stepIndex = Object.keys(PHASE_LABELS).indexOf(p)
                const isComplete = stepIndex < currentIndex
                const isCurrent = phase === p
                
                return (
                  <div key={p} className="flex items-center gap-3 text-body">
                    <span className={
                      isComplete 
                        ? 'text-execute' 
                        : isCurrent 
                          ? 'text-hold' 
                          : 'text-sage-disabled'
                    }>
                      {isComplete ? '■' : isCurrent ? '▶' : '□'}
                    </span>
                    <span className={
                      isCurrent 
                        ? 'text-sage-white' 
                        : isComplete
                          ? 'text-sage-light'
                          : 'text-sage-disabled'
                    }>
                      {PHASE_LABELS[p]}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="pt-4 border-t border-surface-elevated">
            <p className="text-meta text-sage-muted text-center">
              ID: <span className="font-mono text-sage-light">{id}</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
