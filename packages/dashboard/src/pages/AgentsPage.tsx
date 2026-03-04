import { useState, useMemo } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { Search, Bot, Shield, Clock, Filter } from 'lucide-react'
import { formatRelativeTime, trustScoreColor, truncateBeamId } from '../lib/utils'

export default function AgentsPage() {
  const agents = useQuery(api.agents.listAllAgents, { limit: 200 })
  const [search, setSearch] = useState('')
  const [capFilter, setCapFilter] = useState('')
  const [orgFilter, setOrgFilter] = useState('')

  const allCapabilities = useMemo(() => {
    if (!agents) return []
    const caps = new Set<string>()
    agents.forEach(a => a.capabilities.forEach(c => caps.add(c)))
    return Array.from(caps).sort()
  }, [agents])

  const allOrgs = useMemo(() => {
    if (!agents) return []
    const orgs = new Set<string>()
    agents.forEach(a => orgs.add(a.orgId))
    return Array.from(orgs).sort()
  }, [agents])

  const filtered = useMemo(() => {
    if (!agents) return []
    return agents.filter(a => {
      const matchSearch =
        !search ||
        a.beamId.toLowerCase().includes(search.toLowerCase()) ||
        a.displayName.toLowerCase().includes(search.toLowerCase())
      const matchCap = !capFilter || a.capabilities.includes(capFilter)
      const matchOrg = !orgFilter || a.orgId === orgFilter
      return matchSearch && matchCap && matchOrg
    })
  }, [agents, search, capFilter, orgFilter])

  return (
    <div className="p-5 space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold text-text tracking-tight">Agents</h1>
          <p className="text-xs text-text-muted mt-0.5 font-mono">
            {agents ? `${agents.length} registered beam IDs` : 'Loading…'}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim" />
          <input
            type="text"
            className="input-field w-full pl-7"
            placeholder="Search beam ID or name…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="relative">
          <Filter size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim pointer-events-none" />
          <select
            className="input-field pl-7 pr-6 appearance-none cursor-pointer"
            value={capFilter}
            onChange={e => setCapFilter(e.target.value)}
          >
            <option value="">All capabilities</option>
            {allCapabilities.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="relative">
          <select
            className="input-field pr-6 appearance-none cursor-pointer"
            value={orgFilter}
            onChange={e => setOrgFilter(e.target.value)}
          >
            <option value="">All orgs</option>
            {allOrgs.map(o => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </div>
        {(search || capFilter || orgFilter) && (
          <button
            className="btn-ghost text-xs"
            onClick={() => { setSearch(''); setCapFilter(''); setOrgFilter('') }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <th className="table-cell text-left text-xs font-mono text-text-dim uppercase tracking-widest">
                Beam ID
              </th>
              <th className="table-cell text-left text-xs font-mono text-text-dim uppercase tracking-widest">
                Org
              </th>
              <th className="table-cell text-left text-xs font-mono text-text-dim uppercase tracking-widest">
                Capabilities
              </th>
              <th className="table-cell text-left text-xs font-mono text-text-dim uppercase tracking-widest">
                Trust
              </th>
              <th className="table-cell text-left text-xs font-mono text-text-dim uppercase tracking-widest">
                Status
              </th>
              <th className="table-cell text-left text-xs font-mono text-text-dim uppercase tracking-widest">
                Last Seen
              </th>
            </tr>
          </thead>
          <tbody>
            {agents === undefined ? (
              <tr>
                <td colSpan={6} className="table-cell py-8 text-center text-text-dim font-mono text-xs">
                  Loading…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="table-cell py-8 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <Bot size={24} className="text-text-dim" />
                    <span className="text-xs text-text-dim font-mono">
                      {agents.length === 0
                        ? 'No agents registered yet'
                        : 'No agents match your filters'}
                    </span>
                  </div>
                </td>
              </tr>
            ) : (
              filtered.map(agent => (
                <tr key={agent._id} className="table-row">
                  <td className="table-cell">
                    <div className="flex items-center gap-2">
                      <div className="w-5 h-5 rounded bg-accent/10 flex items-center justify-center shrink-0">
                        <Bot size={11} className="text-accent" />
                      </div>
                      <div>
                        <div className="font-mono text-xs text-text truncate max-w-[180px]" title={agent.beamId}>
                          {truncateBeamId(agent.beamId)}
                        </div>
                        <div className="text-xs text-text-muted mt-0.5">{agent.displayName}</div>
                      </div>
                    </div>
                  </td>
                  <td className="table-cell">
                    <span className="badge-blue">{agent.orgId}</span>
                  </td>
                  <td className="table-cell">
                    <div className="flex flex-wrap gap-1 max-w-[160px]">
                      {agent.capabilities.slice(0, 3).map(cap => (
                        <span key={cap} className="badge-muted">{cap}</span>
                      ))}
                      {agent.capabilities.length > 3 && (
                        <span className="badge-muted">+{agent.capabilities.length - 3}</span>
                      )}
                    </div>
                  </td>
                  <td className="table-cell">
                    <TrustBar score={agent.trustScore} />
                  </td>
                  <td className="table-cell">
                    {agent.verified ? (
                      <span className="badge-green">
                        <Shield size={10} />
                        Verified
                      </span>
                    ) : (
                      <span className="badge-muted">Unverified</span>
                    )}
                  </td>
                  <td className="table-cell">
                    <div className="flex items-center gap-1 text-xs text-text-muted font-mono">
                      <Clock size={10} />
                      {agent.lastSeen ? formatRelativeTime(agent.lastSeen) : '—'}
                    </div>
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

function TrustBar({ score }: { score: number }) {
  const color = trustScoreColor(score)
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-bg-hover rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${score}%`, background: color }}
        />
      </div>
      <span className="text-xs font-mono" style={{ color }}>
        {score}
      </span>
    </div>
  )
}
