import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { ApiError, directoryApi, type AuditEntry } from '../lib/api'
import { EmptyPanel, PageHeader, StatusPill } from '../components/Observability'
import { formatDateTime } from '../lib/utils'

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [query, setQuery] = useState('')
  const [hours, setHours] = useState(24 * 7)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        setLoading(true)
        const response = await directoryApi.getAuditLog({
          q: query || undefined,
          hours,
          limit: 120,
        })
        if (cancelled) return
        setEntries(response.entries)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load audit log')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [hours, query])

  return (
    <div className="space-y-6">
      <PageHeader title="Audit" description="Administrative and federation control-plane events across the directory." />

      <section className="panel">
        <div className="grid gap-3 lg:grid-cols-[1.5fr,0.5fr]">
          <label className="relative block">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              className="input-field pl-10"
              placeholder="Search action, actor, target, details"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <select className="input-field" value={hours} onChange={(event) => setHours(Number(event.target.value))}>
            <option value={24}>24h</option>
            <option value={24 * 7}>7d</option>
            <option value={24 * 30}>30d</option>
          </select>
        </div>
      </section>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <section className="panel overflow-hidden p-0">
        {loading ? (
          <div className="p-5 text-sm text-slate-500 dark:text-slate-400">Loading audit trail…</div>
        ) : entries.length === 0 ? (
          <div className="p-5">
            <EmptyPanel label="No audit events matched the current filters." />
          </div>
        ) : (
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {entries.map((entry) => (
              <div key={entry.id} className="p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill label={entry.action} />
                  <span className="text-xs text-slate-500 dark:text-slate-400">{formatDateTime(entry.timestamp)}</span>
                </div>
                <div className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                  {entry.actor} → {entry.target}
                </div>
                {entry.details ? (
                  <pre className="mt-3 overflow-x-auto rounded-xl bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                    {JSON.stringify(entry.details, null, 2)}
                  </pre>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
