import { useEffect, useState } from 'react'
import { Activity, Bot, Clock3, ShieldCheck } from 'lucide-react'
import { ApiError, directoryApi, type DirectoryStats, type RecentIntent } from '../lib/api'
import { formatDateTime, formatLatency, formatNumber, truncateBeamId } from '../lib/utils'

export default function OverviewPage() {
  const [stats, setStats] = useState<DirectoryStats | null>(null)
  const [recentIntents, setRecentIntents] = useState<RecentIntent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        setLoading(true)
        const [statsResponse, intentsResponse] = await Promise.all([
          directoryApi.getAgentStats(),
          directoryApi.getRecentIntents(6),
        ])

        if (cancelled) return
        setStats(statsResponse)
        setRecentIntents(intentsResponse.intents)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load dashboard overview')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">Live network stats from the Beam Directory API.</p>
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Bot} label="Total agents" value={loading || !stats ? '—' : formatNumber(stats.total_agents)} />
        <StatCard icon={ShieldCheck} label="Verified agents" value={loading || !stats ? '—' : formatNumber(stats.verified_agents)} />
        <StatCard icon={Activity} label="Processed intents" value={loading || !stats ? '—' : formatNumber(stats.intents_processed)} />
        <StatCard icon={Clock3} label="Avg response" value={loading || !stats ? '—' : formatLatency(stats.avg_response_time_ms)} />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.1fr,0.9fr]">
        <div className="panel">
          <div className="panel-title">Verification coverage</div>
          <div className="mt-5 space-y-4">
            <div>
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="text-slate-600 dark:text-slate-300">Verified share</span>
                <span className="font-medium">{stats && stats.total_agents > 0 ? `${Math.round((stats.verified_agents / stats.total_agents) * 100)}%` : '0%'}</span>
              </div>
              <div className="h-3 rounded-full bg-slate-200 dark:bg-slate-800">
                <div
                  className="h-3 rounded-full bg-blue-500 transition-all"
                  style={{ width: `${stats && stats.total_agents > 0 ? (stats.verified_agents / stats.total_agents) * 100 : 0}%` }}
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <MiniStat label="Verified" value={stats ? formatNumber(stats.verified_agents) : '—'} />
              <MiniStat label="Unverified" value={stats ? formatNumber(Math.max(stats.total_agents - stats.verified_agents, 0)) : '—'} />
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Latest intents</div>
          <div className="mt-4 space-y-3">
            {recentIntents.length === 0 ? (
              <EmptyState label={loading ? 'Loading recent intents…' : 'No intents have been processed yet.'} />
            ) : (
              recentIntents.map((intent) => (
                <div key={intent.nonce} className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="rounded-full bg-orange-500/10 px-2 py-1 text-xs font-medium text-orange-600 dark:text-orange-300">
                      {intent.intentType}
                    </span>
                    <span className="text-slate-500 dark:text-slate-400">{formatDateTime(intent.timestamp)}</span>
                  </div>
                  <div className="mt-2 grid gap-1 text-sm text-slate-600 dark:text-slate-300">
                    <div>From {truncateBeamId(intent.from)}</div>
                    <div>To {truncateBeamId(intent.to)}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Bot
  label: string
  value: string
}) {
  return (
    <div className="panel">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-slate-500 dark:text-slate-400">{label}</div>
          <div className="mt-2 text-3xl font-semibold tracking-tight">{value}</div>
        </div>
        <div className="rounded-xl bg-orange-500/10 p-3 text-orange-500">
          <Icon size={18} />
        </div>
      </div>
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-4 dark:bg-slate-950">
      <div className="text-sm text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
    </div>
  )
}

function EmptyState({ label }: { label: string }) {
  return <div className="rounded-xl border border-dashed border-slate-200 p-6 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">{label}</div>
}
