import type { ReactNode } from 'react'
import { ResponsiveContainer, AreaChart, Area, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts'
import { cn, formatChartTime } from '../lib/utils'

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description: string
  actions?: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{description}</p>
      </div>
      {actions}
    </section>
  )
}

export function MetricCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'default' | 'warning' | 'critical' | 'success'
}) {
  return (
    <div className={cn(
      'panel',
      tone === 'warning' && 'border-amber-200 dark:border-amber-500/30',
      tone === 'critical' && 'border-red-200 dark:border-red-500/30',
      tone === 'success' && 'border-emerald-200 dark:border-emerald-500/30',
    )}>
      <div className="text-sm text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight">{value}</div>
      {hint ? <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">{hint}</div> : null}
    </div>
  )
}

export function StatusPill({
  label,
  tone = 'default',
}: {
  label: string
  tone?: 'default' | 'success' | 'warning' | 'critical'
}) {
  return (
    <span className={cn(
      'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium capitalize',
      tone === 'success' && 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
      tone === 'warning' && 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
      tone === 'critical' && 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
      tone === 'default' && 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    )}>
      {label}
    </span>
  )
}

export function EmptyPanel({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 p-6 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
      {label}
    </div>
  )
}

export function TimeSeriesChart<T extends object>({
  data,
  series,
  height = 260,
}: {
  data: Array<T & { bucketStart: string }>
  series: Array<{
    key: string
    label: string
    color: string
  }>
  height?: number
}) {
  if (data.length === 0) {
    return <EmptyPanel label="No timeseries data in the selected window." />
  }

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ left: -16, right: 12, top: 8, bottom: 0 }}>
          <defs>
            {series.map((entry) => (
              <linearGradient key={entry.key} id={`gradient-${entry.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={entry.color} stopOpacity={0.35} />
                <stop offset="95%" stopColor={entry.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.18)" />
          <XAxis
            dataKey="bucketStart"
            tickFormatter={(value) => formatChartTime(String(value))}
            minTickGap={24}
            tickLine={false}
            axisLine={false}
            fontSize={12}
          />
          <YAxis tickLine={false} axisLine={false} fontSize={12} width={36} />
          <Tooltip
            contentStyle={{
              background: 'rgba(15, 23, 42, 0.96)',
              borderRadius: 16,
              border: '1px solid rgba(148, 163, 184, 0.15)',
              color: '#f8fafc',
            }}
            formatter={(value: number, name: string) => [value ?? 0, name]}
            labelFormatter={(label) => formatChartTime(String(label))}
          />
          {series.map((entry) => (
            <Area
              key={entry.key}
              type="monotone"
              dataKey={entry.key}
              name={entry.label}
              stroke={entry.color}
              fill={`url(#gradient-${entry.key})`}
              strokeWidth={2}
              connectNulls
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

export function BarList({
  items,
  valueKey = 'value',
  labelKey = 'label',
}: {
  items: Array<Record<string, string | number>>
  valueKey?: string
  labelKey?: string
}) {
  if (items.length === 0) {
    return <EmptyPanel label="Nothing to visualize yet." />
  }

  const maxValue = items.reduce((max, item) => Math.max(max, Number(item[valueKey] ?? 0)), 0)

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const value = Number(item[valueKey] ?? 0)
        const width = maxValue > 0 ? (value / maxValue) * 100 : 0
        return (
          <div key={`${item[labelKey]}-${value}`} className="space-y-1">
            <div className="flex items-center justify-between gap-3 text-sm">
              <div className="truncate text-slate-700 dark:text-slate-200">{String(item[labelKey] ?? '')}</div>
              <div className="text-slate-500 dark:text-slate-400">{value}</div>
            </div>
            <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800">
              <div className="h-2 rounded-full bg-orange-500" style={{ width: `${width}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
