import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ApiError, directoryApi, type DirectoryAgentDetail } from '../lib/api'
import { cn, formatDateTime, formatLatency, trustScoreColor, trustScoreText, verificationTierColor } from '../lib/utils'

export default function AgentProfilePage() {
  const { beamId } = useParams<{ beamId: string }>()
  const resolvedBeamId = beamId ? decodeURIComponent(beamId) : null
  const [agent, setAgent] = useState<DirectoryAgentDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!resolvedBeamId) return
    const beamIdToLoad = resolvedBeamId
    let cancelled = false

    async function load() {
      try {
        setLoading(true)
        const response = await directoryApi.getAgent(beamIdToLoad)
        if (cancelled) return
        setAgent(response)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load agent profile')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [resolvedBeamId])

  if (loading) {
    return <div className="panel">Loading agent profile…</div>
  }

  if (error || !agent) {
    return <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">{error ?? 'Agent not found'}</div>
  }

  return (
    <div className="space-y-6">
      <section className="panel">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            {agent.logoUrl ? (
              <img src={agent.logoUrl} alt={agent.displayName} className="h-20 w-20 rounded-2xl object-cover" />
            ) : (
              <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-orange-500/10 text-2xl font-semibold text-orange-600 dark:text-orange-300">
                {agent.displayName.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-3xl font-semibold tracking-tight">{agent.displayName}</h1>
                <span className={cn('rounded-full px-2.5 py-1 text-xs font-medium capitalize', verificationTierColor(agent.verificationTier))}>
                  {agent.verificationTier}
                </span>
              </div>
              <div className="text-sm text-slate-500 dark:text-slate-400">{agent.beamId}</div>
              {agent.description && <p className="max-w-2xl text-sm text-slate-600 dark:text-slate-300">{agent.description}</p>}
            </div>
          </div>
          <div className="space-y-2 rounded-2xl bg-slate-50 p-4 text-sm dark:bg-slate-950">
            <div><span className="text-slate-500 dark:text-slate-400">Created:</span> {formatDateTime(agent.createdAt)}</div>
            <div><span className="text-slate-500 dark:text-slate-400">Last seen:</span> {formatDateTime(agent.lastSeen)}</div>
            <div><span className="text-slate-500 dark:text-slate-400">Email:</span> {agent.email ?? '—'}</div>
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {agent.capabilities.map((capability) => (
            <div key={capability} className="rounded-xl bg-slate-50 px-4 py-3 text-sm dark:bg-slate-950">{capability}</div>
          ))}
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.2fr,0.8fr]">
        <div className="panel">
          <div className="panel-title">Trust score</div>
          <div className="mt-4 flex items-end justify-between">
            <div className="text-4xl font-semibold tracking-tight">{trustScoreText(agent.trustScore)}</div>
            <div className="text-sm text-slate-500 dark:text-slate-400">Visualized in real time</div>
          </div>
          <div className="mt-4 h-4 rounded-full bg-slate-200 dark:bg-slate-800">
            <div className={cn('h-4 rounded-full', trustScoreColor(agent.trustScore))} style={{ width: `${Math.round(agent.trustScore * 100)}%` }} />
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Verification</div>
          <div className="mt-4 space-y-3 text-sm">
            <div className={cn('inline-flex rounded-full px-2.5 py-1 font-medium capitalize', verificationTierColor(agent.verificationTier))}>{agent.verificationTier}</div>
            <div><span className="text-slate-500 dark:text-slate-400">Email status:</span> {agent.emailVerified ? 'Verified' : 'Pending'}</div>
            <div><span className="text-slate-500 dark:text-slate-400">Legacy verified flag:</span> {agent.verified ? 'Yes' : 'No'}</div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <StatCard label="Received intents" value={String(agent.intentStats.received)} />
        <StatCard label="Responded intents" value={String(agent.intentStats.responded)} />
        <StatCard label="Avg response time" value={formatLatency(agent.intentStats.avg_response_time_ms)} />
      </section>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel">
      <div className="text-sm text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight">{value}</div>
    </div>
  )
}
