import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ApiError, directoryApi, type AgentHealthResponse, type DirectoryAgentDetail } from '../lib/api'
import { BarList, EmptyPanel, MetricCard, PageHeader, TimeSeriesChart } from '../components/Observability'
import { cn, formatDateTime, formatLatency, formatPercent, trustScoreColor, trustScoreText, verificationTierColor } from '../lib/utils'

export default function AgentProfilePage() {
  const { beamId } = useParams<{ beamId: string }>()
  const resolvedBeamId = beamId ? decodeURIComponent(beamId) : null
  const [agent, setAgent] = useState<DirectoryAgentDetail | null>(null)
  const [health, setHealth] = useState<AgentHealthResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!resolvedBeamId) return
    const beamIdToLoad = resolvedBeamId
    let cancelled = false

    async function load() {
      try {
        setLoading(true)
        const [agentResponse, healthResponse] = await Promise.all([
          directoryApi.getAgent(beamIdToLoad),
          directoryApi.getAgentHealth(beamIdToLoad),
        ])

        if (cancelled) return
        setAgent(agentResponse)
        setHealth(healthResponse)
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

  if (error || !agent || !health) {
    return <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">{error ?? 'Agent not found'}</div>
  }

  return (
    <div className="space-y-6">
      <PageHeader title={agent.displayName} description={agent.beamId} />

      <section className="grid gap-6 xl:grid-cols-[1.1fr,0.9fr]">
        <div className="panel">
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
                  <span className={cn('rounded-full px-2.5 py-1 text-xs font-medium capitalize', verificationTierColor(agent.verificationTier))}>
                    {agent.verificationTier}
                  </span>
                  <span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                    {agent.emailVerified ? 'email verified' : 'email pending'}
                  </span>
                </div>
                {agent.description ? <p className="max-w-2xl text-sm text-slate-600 dark:text-slate-300">{agent.description}</p> : null}
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
        </div>

        <div className="panel">
          <div className="panel-title">Trust score</div>
          <div className="mt-4 flex items-end justify-between">
            <div className="text-4xl font-semibold tracking-tight">{trustScoreText(agent.trustScore)}</div>
            <div className="text-sm text-slate-500 dark:text-slate-400">Pairwise directory confidence</div>
          </div>
          <div className="mt-4 h-4 rounded-full bg-slate-200 dark:bg-slate-800">
            <div className={cn('h-4 rounded-full', trustScoreColor(agent.trustScore))} style={{ width: `${Math.round(agent.trustScore * 100)}%` }} />
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <MetricCard label="Success rate" value={formatPercent(health.summary.successRate)} />
            <MetricCard label="p95 latency" value={formatLatency(health.summary.p95LatencyMs)} />
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard label="Sent" value={String(health.summary.sentCount)} />
        <MetricCard label="Received" value={String(health.summary.receivedCount)} />
        <MetricCard label="Counterparties" value={String(health.summary.uniqueCounterparties)} />
        <MetricCard label="Direct" value={String(health.usage.directCount)} />
        <MetricCard label="Relayed" value={String(health.usage.relayedCount)} />
        <MetricCard label="Shield holds" value={String(health.shield.held)} tone={health.shield.held > 0 ? 'warning' : 'default'} />
      </section>

      <section className="panel">
        <div className="panel-title">Traffic timeline</div>
        <div className="mt-5">
          <TimeSeriesChart
            data={health.timeline}
            series={[
              { key: 'sent', label: 'Sent', color: '#f97316' },
              { key: 'received', label: 'Received', color: '#3b82f6' },
              { key: 'error', label: 'Errors', color: '#ef4444' },
            ]}
          />
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[0.9fr,1.1fr]">
        <div className="panel">
          <div className="panel-title">Counterparties</div>
          <div className="mt-5">
            <BarList items={health.counterparties.map((entry) => ({ label: entry.beamId, value: entry.outbound + entry.inbound }))} />
          </div>
        </div>

        <div className="panel overflow-hidden p-0">
          <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
            <div className="panel-title">Error codes</div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-950">
                <tr>
                  <th className="table-head">Code</th>
                  <th className="table-head">Count</th>
                  <th className="table-head">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {health.errors.length === 0 ? (
                  <tr><td className="table-cell" colSpan={3}>No errors recorded for this agent.</td></tr>
                ) : (
                  health.errors.map((entry) => (
                    <tr key={entry.errorCode} className="border-t border-slate-200 dark:border-slate-800">
                      <td className="table-cell font-medium">{entry.errorCode}</td>
                      <td className="table-cell">{entry.count}</td>
                      <td className="table-cell">{formatDateTime(entry.lastSeenAt)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1fr,1fr]">
        <div className="panel">
          <div className="panel-title">Intent mix</div>
          <div className="mt-4 space-y-3">
            {health.intents.length === 0 ? (
              <EmptyPanel label="No intent history recorded for this agent." />
            ) : (
              health.intents.map((intent) => (
                <div key={intent.intentType} className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="font-medium">{intent.intentType}</div>
                      <div className="text-sm text-slate-500 dark:text-slate-400">{intent.errors} errors</div>
                    </div>
                    <div className="text-right text-sm">
                      <div>{intent.total} total</div>
                      <div className="text-slate-500 dark:text-slate-400">{formatLatency(intent.avgLatencyMs)}</div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Usage & Shield</div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <MetricCard label="Intent count" value={String(health.usage.intentCount)} hint={health.usage.period} />
            <MetricCard label="Encrypted" value={String(health.usage.encryptedCount)} />
            <MetricCard label="Shield passed" value={String(health.shield.passed)} />
            <MetricCard label="High risk" value={String(health.shield.highRiskCount)} tone={health.shield.highRiskCount > 0 ? 'warning' : 'default'} />
          </div>
        </div>
      </section>
    </div>
  )
}
