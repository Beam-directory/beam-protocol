import { useEffect, useState } from 'react'
import { ApiError, directoryApi, type FederationHealthResponse } from '../lib/api'
import { EmptyPanel, MetricCard, PageHeader, StatusPill } from '../components/Observability'
import { formatDateTime, formatNumber } from '../lib/utils'

export default function FederationPage() {
  const [data, setData] = useState<FederationHealthResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        setLoading(true)
        const response = await directoryApi.getFederationHealth()
        if (cancelled) return
        setData(response)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load federation health')
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
      <PageHeader title="Federation" description="Peer directories, cache freshness, and propagated trust state." />

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Peers" value={loading || !data ? '—' : formatNumber(data.summary.peerCount)} />
        <MetricCard label="Active peers" value={loading || !data ? '—' : formatNumber(data.summary.activePeers)} />
        <MetricCard label="Stale peers" value={loading || !data ? '—' : formatNumber(data.summary.stalePeers)} tone={data && data.summary.stalePeers > 0 ? 'warning' : 'default'} />
        <MetricCard label="Cached agents" value={loading || !data ? '—' : formatNumber(data.summary.cachedAgents)} />
        <MetricCard label="Trust assertions" value={loading || !data ? '—' : formatNumber(data.summary.trustAssertions)} />
      </section>

      <section className="panel overflow-hidden p-0">
        <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="panel-title">Peer Directory Health</div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-950">
              <tr>
                <th className="table-head">Directory</th>
                <th className="table-head">Status</th>
                <th className="table-head">Trust</th>
                <th className="table-head">Cached</th>
                <th className="table-head">Assertions</th>
                <th className="table-head">Last seen</th>
                <th className="table-head">Synced</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td className="table-cell" colSpan={7}>Loading peers…</td></tr>
              ) : !data || data.peers.length === 0 ? (
                <tr><td className="table-cell" colSpan={7}>No federation peers have been registered yet.</td></tr>
              ) : (
                data.peers.map((peer) => (
                  <tr key={peer.id} className="border-t border-slate-200 dark:border-slate-800">
                    <td className="table-cell font-mono">{peer.directoryUrl}</td>
                    <td className="table-cell">
                      <StatusPill label={peer.stale ? 'stale' : peer.status} tone={peer.stale ? 'warning' : peer.status === 'active' ? 'success' : 'default'} />
                    </td>
                    <td className="table-cell">{peer.trustLevel.toFixed(2)}</td>
                    <td className="table-cell">{formatNumber(peer.cachedAgents)}</td>
                    <td className="table-cell">{formatNumber(peer.trustAssertions)}</td>
                    <td className="table-cell">{formatDateTime(peer.lastSeen)}</td>
                    <td className="table-cell">{formatDateTime(peer.syncedAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title">Federated Agent Cache</div>
        <div className="mt-4 space-y-3">
          {loading ? (
            <EmptyPanel label="Loading cached agents…" />
          ) : !data || data.agents.length === 0 ? (
            <EmptyPanel label="No cached agents are present." />
          ) : (
            data.agents.map((agent) => (
              <div key={agent.beamId} className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{agent.beamId}</div>
                    <div className="truncate text-sm text-slate-500 dark:text-slate-400">{agent.directoryUrl}</div>
                  </div>
                  <div className="text-right text-sm">
                    <div>Trust {agent.effectiveTrust?.toFixed(2) ?? '—'}</div>
                    <div className="text-slate-500 dark:text-slate-400">TTL {agent.ttl}s</div>
                  </div>
                </div>
                <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">Cached {formatDateTime(agent.cachedAt)}</div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  )
}
