import type { ReactNode } from 'react'
import { ResponsiveContainer, AreaChart, Area, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts'
import { cn, formatChartTime } from '../lib/utils'

export function PageHeader({
  eyebrow = 'Beam Control Plane',
  title,
  description,
  badges,
  aside,
  actions,
}: {
  eyebrow?: string
  title: string
  description: string
  badges?: ReactNode
  aside?: ReactNode
  actions?: ReactNode
}) {
  return (
    <section className="panel beam-page-enter overflow-hidden px-6 py-6 sm:px-7 sm:py-7 lg:px-8 lg:py-8">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-16 top-0 h-40 w-40 rounded-full bg-orange-500/10 blur-3xl dark:bg-orange-400/10" />
        <div className="absolute right-0 top-0 h-52 w-52 rounded-full bg-cyan-400/10 blur-3xl dark:bg-cyan-300/10" />
        <div className="beam-grid-lines absolute inset-0 opacity-40 dark:opacity-20" />
      </div>
      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl">
          <div className="text-[11px] font-semibold uppercase tracking-[0.34em] text-orange-600 dark:text-orange-300">{eyebrow}</div>
          <h1 className="mt-4 text-3xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-white sm:text-4xl xl:text-5xl">{title}</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300 sm:text-base sm:leading-7">{description}</p>
          {badges ? <div className="mt-5 flex flex-wrap gap-2">{badges}</div> : null}
        </div>
        {(aside || actions) ? (
          <div className="flex w-full flex-col gap-3 lg:max-w-md lg:items-end">
            {aside ? (
              <div className="w-full rounded-[24px] border border-white/60 bg-white/[0.72] p-4 text-sm text-slate-600 shadow-[0_18px_50px_rgba(15,23,42,0.08)] backdrop-blur-xl dark:border-white/10 dark:bg-slate-950/60 dark:text-slate-300">
                {aside}
              </div>
            ) : null}
            {actions ? <div className="flex flex-wrap gap-2 lg:justify-end">{actions}</div> : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}

export function MetricCard({
  label,
  value,
  hint,
  tone = 'default',
  className,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'default' | 'warning' | 'critical' | 'success'
  className?: string
}) {
  return (
    <div className={cn(
      'panel beam-reveal-soft min-h-[132px] md:min-h-[148px]',
      tone === 'warning' && 'border-amber-200 dark:border-amber-500/30',
      tone === 'critical' && 'border-red-200 dark:border-red-500/30',
      tone === 'success' && 'border-emerald-200 dark:border-emerald-500/30',
      className,
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-400 dark:text-slate-500">{label}</div>
        <span
          className={cn(
            'beam-status-dot inline-flex h-2.5 w-2.5 rounded-full',
            tone === 'warning' && 'bg-amber-400',
            tone === 'critical' && 'bg-red-400',
            tone === 'success' && 'bg-emerald-400',
            tone === 'default' && 'bg-slate-300 dark:bg-slate-600',
          )}
        />
      </div>
      <div className="mt-6 text-3xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-white">{value}</div>
      {hint ? <div className="mt-3 max-w-[24ch] text-xs leading-5 text-slate-500 dark:text-slate-400">{hint}</div> : null}
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
      'inline-flex items-center rounded-full border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.2em]',
      tone === 'success' && 'border-emerald-200 bg-emerald-100/80 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300',
      tone === 'warning' && 'border-amber-200 bg-amber-100/80 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300',
      tone === 'critical' && 'border-red-200 bg-red-100/80 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300',
      tone === 'default' && 'border-slate-200 bg-white/70 text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300',
    )}>
      {label}
    </span>
  )
}

export function EmptyPanel({ label }: { label: string }) {
  return (
    <div className="rounded-[24px] border border-dashed border-slate-300/80 bg-white/35 p-6 text-sm text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-slate-400">
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
