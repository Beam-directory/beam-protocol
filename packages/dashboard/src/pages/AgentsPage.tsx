import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Search } from 'lucide-react'
import { ApiError, directoryApi, type DirectoryAgent, type VerificationTier } from '../lib/api'
import { cn, formatRelativeTime, trustScoreColor, trustScoreText, trustScoreTextColor, verificationTierColor } from '../lib/utils'

const TIER_OPTIONS: Array<{ value: 'all' | VerificationTier; label: string }> = [
  { value: 'all', label: 'All tiers' },
  { value: 'basic', label: 'Basic' },
  { value: 'verified', label: 'Verified' },
  { value: 'business', label: 'Business' },
  { value: 'enterprise', label: 'Enterprise' },
]

export default function AgentsPage() {
  const [agents, setAgents] = useState<DirectoryAgent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedCapability, setSelectedCapability] = useState('all')
  const [selectedTier, setSelectedTier] = useState<'all' | VerificationTier>('all')

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        setLoading(true)
        const response = await directoryApi.searchAgents({ limit: 250 })
        if (cancelled) return
        setAgents(response.agents)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load agents')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const capabilities = useMemo(() => {
    const values = new Set<string>()
    agents.forEach((agent) => agent.capabilities.forEach((capability) => values.add(capability)))
    return Array.from(values).sort((left, right) => left.localeCompare(right))
  }, [agents])

  const filteredAgents = useMemo(() => {
    return agents
      .filter((agent) => {
        const matchesQuery = !query || [agent.displayName, agent.beamId, agent.description ?? '', agent.capabilities.join(' ')].join(' ').toLowerCase().includes(query.toLowerCase())
        const matchesCapability = selectedCapability === 'all' || agent.capabilities.includes(selectedCapability)
        const matchesTier = selectedTier === 'all' || agent.verificationTier === selectedTier
        return matchesQuery && matchesCapability && matchesTier
      })
      .sort((left, right) => right.trustScore - left.trustScore)
  }, [agents, query, selectedCapability, selectedTier])

  const hasActiveFilters = query.trim().length > 0 || selectedCapability !== 'all' || selectedTier !== 'all'

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">Search and filter real agents from the directory registry.</p>
        </div>
        <div className="text-sm text-slate-500 dark:text-slate-400">{filteredAgents.length} results</div>
      </section>

      <section className="panel">
        <div className="grid gap-3 lg:grid-cols-[1.6fr,1fr,1fr]">
          <label className="relative block">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              className="input-field pl-10"
              placeholder="Search by Beam-ID, name, description"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <select className="input-field" value={selectedCapability} onChange={(event) => setSelectedCapability(event.target.value)}>
            <option value="all">All capabilities</option>
            {capabilities.map((capability) => (
              <option key={capability} value={capability}>{capability}</option>
            ))}
          </select>
          <select className="input-field" value={selectedTier} onChange={(event) => setSelectedTier(event.target.value as 'all' | VerificationTier)}>
            {TIER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      </section>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">{error}</div>}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {loading ? (
          <PlaceholderGrid />
        ) : filteredAgents.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 p-8 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400 md:col-span-2 xl:col-span-3">
            {hasActiveFilters ? 'No agents matched your search. Try clearing a filter or broadening the query.' : 'No agents are listed yet. Check back soon as new agents join the directory.'}
          </div>
        ) : (
          filteredAgents.map((agent) => (
            <Link key={agent.beamId} to={`/agents/${encodeURIComponent(agent.beamId)}`} className="panel transition hover:-translate-y-0.5 hover:border-orange-300 dark:hover:border-orange-500/40">
              <div className="flex items-start gap-4">
                {agent.logoUrl ? (
                  <img src={agent.logoUrl} alt={agent.displayName} className="h-12 w-12 rounded-xl object-cover" />
                ) : (
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-orange-500/10 text-sm font-semibold text-orange-600 dark:text-orange-300">
                    {agent.displayName.slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-lg font-semibold tracking-tight">{agent.displayName}</h2>
                    <span className={cn('rounded-full px-2 py-1 text-xs font-medium capitalize', verificationTierColor(agent.verificationTier))}>
                      <span className="mr-1" aria-hidden="true">{verificationTierBadge(agent.verificationTier)}</span>
                      {agent.verificationTier}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-sm text-slate-500 dark:text-slate-400">{agent.beamId}</div>
                </div>
              </div>

              {agent.description && <p className="mt-4 line-clamp-2 text-sm text-slate-600 dark:text-slate-300">{agent.description}</p>}

              <div className="mt-4 flex flex-wrap gap-2">
                {agent.capabilities.map((capability) => (
                  <span key={capability} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {capability}
                  </span>
                ))}
              </div>

              <div className="mt-5 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-500 dark:text-slate-400">Trust score</span>
                  <span className={cn('font-medium', trustScoreTextColor(agent.trustScore))}>{trustScoreText(agent.trustScore)}</span>
                </div>
                <div className="h-2.5 rounded-full bg-slate-200 dark:bg-slate-800">
                  <div className={cn('h-2.5 rounded-full', trustScoreColor(agent.trustScore))} style={{ width: `${Math.round(agent.trustScore * 100)}%` }} />
                </div>
              </div>

              <div className="mt-4 text-sm text-slate-500 dark:text-slate-400">Seen {formatRelativeTime(agent.lastSeen)}</div>
            </Link>
          ))
        )}
      </section>
    </div>
  )
}

function verificationTierBadge(tier: VerificationTier): string {
  switch (tier) {
    case 'enterprise':
      return '👑'
    case 'business':
      return '🏢'
    case 'verified':
      return '✅'
    default:
      return '🔹'
  }
}

function PlaceholderGrid() {
  return Array.from({ length: 6 }).map((_, index) => (
    <div key={index} className="panel animate-pulse space-y-4">
      <div className="h-12 w-12 rounded-xl bg-slate-200 dark:bg-slate-800" />
      <div className="h-5 w-40 rounded bg-slate-200 dark:bg-slate-800" />
      <div className="h-4 w-full rounded bg-slate-200 dark:bg-slate-800" />
      <div className="h-4 w-3/4 rounded bg-slate-200 dark:bg-slate-800" />
    </div>
  ))
}
