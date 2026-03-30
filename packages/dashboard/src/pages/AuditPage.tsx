import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Search } from 'lucide-react'
import { ApiError, directoryApi, type AuditEntry } from '../lib/api'
import { EmptyPanel, PageHeader, StatusPill } from '../components/Observability'
import { formatDateTime } from '../lib/utils'

export default function AuditPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const query = searchParams.get('q') ?? ''
  const action = searchParams.get('action') ?? ''
  const actor = searchParams.get('actor') ?? ''
  const target = searchParams.get('target') ?? ''
  const hours = Number.parseInt(searchParams.get('hours') ?? String(24 * 7), 10) || 24 * 7
  const alertId = searchParams.get('alert')
  const hasDeepLinkFilters = Boolean(alertId || query || action || actor || target || hours !== 24 * 7)

  function updateSearchParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams)
    if (!value || (key === 'hours' && value === String(24 * 7))) {
      next.delete(key)
    } else {
      next.set(key, value)
    }
    setSearchParams(next, { replace: true })
  }

  function clearFilters() {
    setSearchParams({}, { replace: true })
  }

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        setLoading(true)
        const response = await directoryApi.getAuditLog({
          q: query || undefined,
          action: action || undefined,
          actor: actor || undefined,
          target: target || undefined,
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

      {hasDeepLinkFilters ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">
          {alertId ? (
            <span>Showing the filtered audit slice linked from alert <span className="font-mono">{alertId}</span>.</span>
          ) : (
            <span>Showing a filtered audit slice.</span>
          )}
          <button className="ml-2 text-orange-600 hover:text-orange-700 dark:text-orange-300" onClick={clearFilters} type="button">
            Clear filters
          </button>
        </div>
      ) : null}

      <section className="panel">
        <div className="grid gap-3 lg:grid-cols-[1.5fr,0.5fr]">
          <label className="relative block">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              className="input-field pl-10"
              placeholder="Search action, actor, target, details"
              value={query}
              onChange={(event) => updateSearchParam('q', event.target.value)}
            />
          </label>
          <select className="input-field" value={hours} onChange={(event) => updateSearchParam('hours', event.target.value)}>
            <option value={24}>24h</option>
            <option value={24 * 7}>7d</option>
            <option value={24 * 30}>30d</option>
          </select>
        </div>
        {(action || actor || target) ? (
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500 dark:text-slate-400">
            {action ? <StatusPill label={`action:${action}`} /> : null}
            {actor ? <StatusPill label={`actor:${actor}`} /> : null}
            {target ? <StatusPill label={`target:${target}`} /> : null}
          </div>
        ) : null}
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
            {entries.map((entry) => {
              const relatedNonce = extractAuditNonce(entry)

              return (
                <div key={entry.id} className="p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill label={entry.action} />
                    <span className="text-xs text-slate-500 dark:text-slate-400">{formatDateTime(entry.timestamp)}</span>
                  </div>
                  <div className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                    {entry.actor} → {entry.target}
                  </div>
                  {relatedNonce ? (
                    <div className="mt-2">
                      <Link
                        className="text-xs font-medium text-orange-600 hover:text-orange-700 dark:text-orange-300"
                        to={`/intents/${encodeURIComponent(relatedNonce)}?alert=${encodeURIComponent(alertId ?? entry.action)}`}
                      >
                        Open related trace
                      </Link>
                    </div>
                  ) : null}
                  {entry.details ? (
                    <pre className="mt-3 overflow-x-auto rounded-xl bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                      {JSON.stringify(entry.details, null, 2)}
                    </pre>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

function extractAuditNonce(entry: AuditEntry): string | null {
  const detailsNonce = typeof entry.details?.['nonce'] === 'string' ? entry.details['nonce'] : null
  if (detailsNonce) {
    return detailsNonce
  }

  if (entry.target && !entry.target.includes('@') && !entry.target.includes('://') && !entry.target.includes(' ')) {
    return entry.target
  }

  return null
}
