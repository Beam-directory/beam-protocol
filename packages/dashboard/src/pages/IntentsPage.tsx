import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { Zap, CheckCircle, XCircle, Clock } from 'lucide-react'
import { formatRelativeTime, formatLatency, truncateBeamId } from '../lib/utils'
import { useMemo } from 'react'

export default function IntentsPage() {
  const result = useQuery(api.intents.getIntentLog, { limit: 100 })
  const intents = result?.items ?? []

  // Build latency series for last 20 intents (reversed = oldest first)
  const latencySeries = useMemo(() => {
    return [...intents]
      .reverse()
      .filter(i => i.latencyMs !== undefined)
      .slice(-20)
      .map((i, idx) => ({
        idx: idx + 1,
        latency: i.latencyMs ?? 0,
        label: `#${idx + 1}`,
      }))
  }, [intents])

  const successRate = useMemo(() => {
    if (intents.length === 0) return null
    const ok = intents.filter(i => i.success).length
    return Math.round((ok / intents.length) * 100)
  }, [intents])

  const avgLatency = useMemo(() => {
    const withLatency = intents.filter(i => i.latencyMs !== undefined)
    if (withLatency.length === 0) return null
    return Math.round(withLatency.reduce((s, i) => s + (i.latencyMs ?? 0), 0) / withLatency.length)
  }, [intents])

  return (
    <div className="p-5 space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold text-text tracking-tight">Intent Log</h1>
          <p className="text-xs text-text-muted mt-0.5 font-mono">
            Live updates · last {intents.length} intents
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs font-mono text-text-muted">
          <span className="w-1.5 h-1.5 rounded-full bg-signal-green animate-pulse-slow" />
          LIVE
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        <div className="stat-card">
          <span className="stat-label">Total (shown)</span>
          <span className="stat-value font-mono">{intents.length}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Success Rate</span>
          <span className="stat-value font-mono" style={{ color: successRate !== null && successRate < 80 ? '#f75c5c' : '#39d98a' }}>
            {successRate !== null ? `${successRate}%` : '—'}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Avg Latency</span>
          <span className="stat-value font-mono">{avgLatency !== null ? formatLatency(avgLatency) : '—'}</span>
        </div>
      </div>

      {/* Latency chart */}
      {latencySeries.length > 1 && (
        <div className="bg-bg-card border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-4">
            <Clock size={13} className="text-signal-purple" />
            <span className="text-xs font-mono text-text-muted uppercase tracking-widest">
              Latency Trend (last {latencySeries.length})
            </span>
          </div>
          <ResponsiveContainer width="100%" height={100}>
            <LineChart data={latencySeries}>
              <XAxis
                dataKey="label"
                tick={{ fill: '#7070a0', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: '#7070a0', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                axisLine={false}
                tickLine={false}
                width={35}
                tickFormatter={(v) => `${v}ms`}
              />
              <Tooltip
                contentStyle={{
                  background: '#111118',
                  border: '1px solid #1e1e2e',
                  borderRadius: 6,
                  fontSize: 12,
                  fontFamily: 'JetBrains Mono',
                }}
                formatter={(v: number) => [`${v}ms`, 'Latency']}
                cursor={{ stroke: 'rgba(247,92,3,0.2)' }}
              />
              <Line
                type="monotone"
                dataKey="latency"
                stroke="#F75C03"
                strokeWidth={1.5}
                dot={false}
                activeDot={{ r: 3, fill: '#F75C03' }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Intent table */}
      <div className="bg-bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <th className="table-cell text-left text-xs font-mono text-text-dim uppercase tracking-widest w-8">
                OK
              </th>
              <th className="table-cell text-left text-xs font-mono text-text-dim uppercase tracking-widest">
                From
              </th>
              <th className="table-cell text-left text-xs font-mono text-text-dim uppercase tracking-widest">
                To
              </th>
              <th className="table-cell text-left text-xs font-mono text-text-dim uppercase tracking-widest">
                Intent
              </th>
              <th className="table-cell text-left text-xs font-mono text-text-dim uppercase tracking-widest">
                Latency
              </th>
              <th className="table-cell text-left text-xs font-mono text-text-dim uppercase tracking-widest">
                Time
              </th>
            </tr>
          </thead>
          <tbody>
            {result === undefined ? (
              <tr>
                <td colSpan={6} className="table-cell py-8 text-center text-text-dim font-mono text-xs">
                  Loading…
                </td>
              </tr>
            ) : intents.length === 0 ? (
              <tr>
                <td colSpan={6} className="table-cell py-8 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <Zap size={24} className="text-text-dim" />
                    <span className="text-xs text-text-dim font-mono">No intents logged yet</span>
                  </div>
                </td>
              </tr>
            ) : (
              intents.map(intent => (
                <tr key={intent._id} className="table-row">
                  <td className="table-cell">
                    {intent.success ? (
                      <CheckCircle size={13} className="text-signal-green" />
                    ) : (
                      <XCircle size={13} className="text-signal-red" />
                    )}
                  </td>
                  <td className="table-cell">
                    <span className="font-mono text-xs text-text-muted" title={intent.fromBeamId}>
                      {truncateBeamId(intent.fromBeamId, 24)}
                    </span>
                  </td>
                  <td className="table-cell">
                    <span className="font-mono text-xs text-text-muted" title={intent.toBeamId}>
                      {truncateBeamId(intent.toBeamId, 24)}
                    </span>
                  </td>
                  <td className="table-cell">
                    <span className="badge-orange font-mono">{intent.intent}</span>
                    {intent.errorCode && (
                      <span className="badge-red ml-1 font-mono">{intent.errorCode}</span>
                    )}
                  </td>
                  <td className="table-cell">
                    <span className="font-mono text-xs text-text-muted">
                      {formatLatency(intent.latencyMs)}
                    </span>
                  </td>
                  <td className="table-cell">
                    <span className="font-mono text-xs text-text-muted">
                      {formatRelativeTime(intent.timestamp)}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
