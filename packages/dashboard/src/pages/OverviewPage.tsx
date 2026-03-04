import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts'
import { Activity, Bot, Zap, Clock, TrendingUp, Shield } from 'lucide-react'
import { formatNumber, formatLatency } from '../lib/utils'

const TRUST_COLORS = {
  elite: '#39d98a',
  high: '#4c9cf1',
  medium: '#f7c603',
  low: '#f75c5c',
}

export default function OverviewPage() {
  const stats = useQuery(api.intents.getGlobalStats)

  const intentVolumeData = stats
    ? [
        { period: '24h', intents: stats.intents24h },
        { period: '7d', intents: stats.intents7d },
        { period: '30d', intents: stats.intents30d },
      ]
    : []

  const trustData = stats
    ? [
        { name: 'Elite (75-100)', value: stats.trustDistribution.elite, color: TRUST_COLORS.elite },
        { name: 'High (50-74)', value: stats.trustDistribution.high, color: TRUST_COLORS.high },
        { name: 'Medium (25-49)', value: stats.trustDistribution.medium, color: TRUST_COLORS.medium },
        { name: 'Low (0-24)', value: stats.trustDistribution.low, color: TRUST_COLORS.low },
      ].filter(d => d.value > 0)
    : []

  const totalTrust = trustData.reduce((s, d) => s + d.value, 0)

  return (
    <div className="p-5 space-y-5 animate-fade-in">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold text-text tracking-tight">System Overview</h1>
          <p className="text-xs text-text-muted mt-0.5 font-mono">Real-time network telemetry</p>
        </div>
        <div className="flex items-center gap-2 text-xs font-mono text-text-muted">
          <span className="w-1.5 h-1.5 rounded-full bg-signal-green animate-pulse-slow" />
          LIVE
        </div>
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          icon={<Bot size={14} className="text-signal-blue" />}
          label="Active Agents"
          value={stats ? formatNumber(stats.agentCount) : '—'}
          sub="registered beam IDs"
        />
        <StatCard
          icon={<Zap size={14} className="text-accent" />}
          label="Intents / 24h"
          value={stats ? formatNumber(stats.intents24h) : '—'}
          sub={stats ? `${formatNumber(stats.intents7d)} this week` : ''}
        />
        <StatCard
          icon={<Clock size={14} className="text-signal-purple" />}
          label="Avg Latency"
          value={stats ? formatLatency(stats.avgLatencyMs) : '—'}
          sub="p50 round-trip"
        />
        <StatCard
          icon={<Shield size={14} className="text-signal-green" />}
          label="Orgs"
          value={stats ? formatNumber(stats.orgCount) : '—'}
          sub="registered organizations"
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Intent volume bar chart */}
        <div className="lg:col-span-2 bg-bg-card border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-4">
            <Activity size={13} className="text-accent" />
            <span className="text-xs font-mono text-text-muted uppercase tracking-widest">
              Intent Volume
            </span>
          </div>
          {intentVolumeData.length > 0 ? (
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={intentVolumeData} barSize={32}>
                <XAxis
                  dataKey="period"
                  tick={{ fill: '#7070a0', fontSize: 11, fontFamily: 'JetBrains Mono' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#7070a0', fontSize: 11, fontFamily: 'JetBrains Mono' }}
                  axisLine={false}
                  tickLine={false}
                  width={30}
                />
                <Tooltip
                  contentStyle={{
                    background: '#111118',
                    border: '1px solid #1e1e2e',
                    borderRadius: 6,
                    fontSize: 12,
                    fontFamily: 'JetBrains Mono',
                  }}
                  labelStyle={{ color: '#7070a0' }}
                  itemStyle={{ color: '#F75C03' }}
                  cursor={{ fill: 'rgba(247,92,3,0.05)' }}
                />
                <Bar dataKey="intents" fill="#F75C03" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState label="No intent data yet" />
          )}
        </div>

        {/* Trust distribution */}
        <div className="bg-bg-card border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp size={13} className="text-signal-green" />
            <span className="text-xs font-mono text-text-muted uppercase tracking-widest">
              Trust Distribution
            </span>
          </div>
          {totalTrust > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={110}>
                <PieChart>
                  <Pie
                    data={trustData}
                    cx="50%"
                    cy="50%"
                    innerRadius={30}
                    outerRadius={50}
                    dataKey="value"
                    strokeWidth={0}
                  >
                    {trustData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: '#111118',
                      border: '1px solid #1e1e2e',
                      borderRadius: 6,
                      fontSize: 12,
                      fontFamily: 'JetBrains Mono',
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="space-y-1.5 mt-3">
                {trustData.map((d) => (
                  <div key={d.name} className="flex items-center gap-2">
                    <span
                      className="w-2 h-2 rounded-sm shrink-0"
                      style={{ background: d.color }}
                    />
                    <span className="text-xs text-text-muted font-mono flex-1 truncate">{d.name}</span>
                    <span className="text-xs font-mono text-text">{d.value}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <EmptyState label="No agents yet" />
          )}
        </div>
      </div>

      {/* Recent activity placeholder */}
      <div className="bg-bg-card border border-border rounded-lg p-4">
        <div className="flex items-center gap-2 mb-3">
          <Activity size={13} className="text-signal-blue" />
          <span className="text-xs font-mono text-text-muted uppercase tracking-widest">
            System Status
          </span>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <StatusRow label="Directory" status="online" />
          <StatusRow label="Intent Router" status="online" />
          <StatusRow label="Convex Sync" status="online" />
        </div>
      </div>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub: string
}) {
  return (
    <div className="stat-card">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="stat-label">{label}</span>
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  )
}

function StatusRow({ label, status }: { label: string; status: 'online' | 'offline' | 'degraded' }) {
  const colors = {
    online: 'bg-signal-green',
    offline: 'bg-signal-red',
    degraded: 'bg-signal-yellow',
  }
  const labels = {
    online: 'ONLINE',
    offline: 'OFFLINE',
    degraded: 'DEGRADED',
  }
  return (
    <div className="flex items-center gap-2">
      <span className={`w-1.5 h-1.5 rounded-full ${colors[status]}`} />
      <span className="text-xs font-mono text-text-muted">{label}</span>
      <span className={`text-xs font-mono ml-auto text-${status === 'online' ? 'signal-green' : 'signal-red'}`}>
        {labels[status]}
      </span>
    </div>
  )
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center h-24 text-xs text-text-dim font-mono">
      {label}
    </div>
  )
}
