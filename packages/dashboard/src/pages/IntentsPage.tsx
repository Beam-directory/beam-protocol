import { useEffect, useRef, useState } from 'react'
import { Radio } from 'lucide-react'
import { ApiError, connectIntentFeed, directoryApi, type RecentIntent } from '../lib/api'
import { cn, formatDateTime, formatLatency, truncateBeamId } from '../lib/utils'

export default function IntentsPage() {
  const [intents, setIntents] = useState<RecentIntent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [socketState, setSocketState] = useState<'connecting' | 'live' | 'offline'>('connecting')
  const socketRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    let cancelled = false
    let reconnectTimer: number | null = null

    async function loadInitial() {
      try {
        setLoading(true)
        const response = await directoryApi.getRecentIntents(50)
        if (!cancelled) {
          setIntents(response.intents)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Failed to load intents')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    function connect() {
      setSocketState('connecting')
      socketRef.current?.close()
      socketRef.current = connectIntentFeed({
        onOpen: () => setSocketState('live'),
        onClose: () => {
          setSocketState('offline')
          if (!cancelled) {
            reconnectTimer = window.setTimeout(connect, 2500)
          }
        },
        onError: () => setSocketState('offline'),
        onMessage: (message) => {
          if (message.type !== 'intent_feed' || !message.entry) return
          const entry = message.entry
          setIntents((current) => {
            const index = current.findIndex((currentEntry) => currentEntry.nonce === entry.nonce)
            if (index >= 0) {
              const updated = [...current]
              updated[index] = entry
              return updated.sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
            }
            return [entry, ...current].slice(0, 75)
          })
        },
      })
    }

    void loadInitial()
    connect()

    return () => {
      cancelled = true
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      socketRef.current?.close()
    }
  }, [])

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Intents</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">Live intent feed over the real `/ws` endpoint.</p>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-3 py-1.5 text-sm dark:border-slate-800">
          <Radio size={14} className={cn(socketState === 'live' ? 'text-emerald-500' : socketState === 'connecting' ? 'text-amber-500' : 'text-red-500')} />
          <span className="capitalize">{socketState}</span>
        </div>
      </section>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">{error}</div>}

      <section className="panel overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-950">
              <tr>
                <th className="table-head">Intent</th>
                <th className="table-head">From</th>
                <th className="table-head">To</th>
                <th className="table-head">Status</th>
                <th className="table-head">Latency</th>
                <th className="table-head">Requested</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td className="table-cell" colSpan={6}>Loading intent history…</td></tr>
              ) : intents.length === 0 ? (
                <tr><td className="table-cell" colSpan={6}>No intent activity yet.</td></tr>
              ) : (
                intents.map((intent) => (
                  <tr key={intent.nonce} className="border-t border-slate-200 dark:border-slate-800">
                    <td className="table-cell font-medium">{intent.intentType}</td>
                    <td className="table-cell">{truncateBeamId(intent.from, 28)}</td>
                    <td className="table-cell">{truncateBeamId(intent.to, 28)}</td>
                    <td className="table-cell">
                      <span className={cn(
                        'rounded-full px-2 py-1 text-xs font-medium capitalize',
                        intent.status === 'success'
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                          : intent.status === 'pending'
                            ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
                            : 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
                      )}>
                        {intent.status}
                      </span>
                    </td>
                    <td className="table-cell">{formatLatency(intent.roundTripLatencyMs)}</td>
                    <td className="table-cell">{formatDateTime(intent.timestamp)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
