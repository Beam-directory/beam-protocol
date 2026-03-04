import { useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { Key, Plus, Trash2, Shield, ShieldCheck, Copy, Eye, EyeOff } from 'lucide-react'
import { formatRelativeTime, generateKeyHash } from '../lib/utils'

// Demo org — in production this would come from auth
const DEMO_ORG = 'demo-org'

export default function SettingsPage() {
  const apiKeys = useQuery(api.apiKeys.getOrgApiKeys, { orgId: DEMO_ORG })
  const org = useQuery(api.organizations.getOrg, { orgId: DEMO_ORG })
  const createOrg = useMutation(api.organizations.createOrg)
  const createApiKey = useMutation(api.apiKeys.createApiKey)
  const revokeApiKey = useMutation(api.apiKeys.revokeApiKey)

  const [newKeyName, setNewKeyName] = useState('')
  const [newKey, setNewKey] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [creating, setCreating] = useState(false)
  const [copiedHash, setCopiedHash] = useState<string | null>(null)

  async function handleCreateKey() {
    if (!newKeyName.trim()) return
    setCreating(true)
    try {
      // Ensure org exists
      if (!org) {
        await createOrg({ orgId: DEMO_ORG, name: 'Demo Organization' })
      }

      const rawKey = `beam_${generateKeyHash()}`
      const hash = await sha256(rawKey)

      await createApiKey({
        orgId: DEMO_ORG,
        keyHash: hash,
        name: newKeyName.trim(),
      })

      setNewKey(rawKey)
      setShowKey(true)
      setNewKeyName('')
    } finally {
      setCreating(false)
    }
  }

  async function handleRevoke(keyHash: string) {
    if (!confirm('Revoke this API key? This cannot be undone.')) return
    await revokeApiKey({ keyHash })
  }

  function copyToClipboard(text: string, hash: string) {
    navigator.clipboard.writeText(text)
    setCopiedHash(hash)
    setTimeout(() => setCopiedHash(null), 2000)
  }

  const activeKeys = apiKeys?.filter(k => !k.revokedAt) ?? []
  const revokedKeys = apiKeys?.filter(k => k.revokedAt) ?? []

  return (
    <div className="p-5 space-y-5 animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="text-base font-bold text-text tracking-tight">Settings</h1>
        <p className="text-xs text-text-muted mt-0.5 font-mono">API keys & organization</p>
      </div>

      {/* Org verification card */}
      <div className="bg-bg-card border border-border rounded-lg p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            {org?.verified ? (
              <ShieldCheck size={20} className="text-signal-green mt-0.5" />
            ) : (
              <Shield size={20} className="text-text-dim mt-0.5" />
            )}
            <div>
              <div className="text-sm font-medium text-text">
                {org?.name ?? 'Demo Organization'}
              </div>
              <div className="text-xs text-text-muted font-mono mt-0.5">
                {DEMO_ORG} · {org?.plan ?? 'free'} plan
              </div>
            </div>
          </div>
          <div>
            {org?.verified ? (
              <span className="badge-green">
                <ShieldCheck size={10} />
                Verified
              </span>
            ) : (
              <span className="badge-muted">Unverified</span>
            )}
          </div>
        </div>
        {org?.domain && (
          <div className="mt-3 pt-3 border-t border-border text-xs text-text-muted font-mono">
            Domain: {org.domain}
          </div>
        )}
      </div>

      {/* New key revealed */}
      {newKey && (
        <div className="bg-accent/5 border border-accent/30 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Key size={14} className="text-accent" />
            <span className="text-xs font-mono text-accent font-medium uppercase tracking-widest">
              New API Key — Copy now, shown once
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 bg-bg rounded border border-border px-3 py-2 font-mono text-xs text-text">
              {showKey ? newKey : '•'.repeat(newKey.length)}
            </div>
            <button
              className="btn-ghost p-2"
              onClick={() => setShowKey(s => !s)}
              title={showKey ? 'Hide' : 'Show'}
            >
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            <button
              className="btn-ghost p-2"
              onClick={() => copyToClipboard(newKey, 'new')}
            >
              {copiedHash === 'new' ? (
                <span className="text-signal-green text-xs font-mono">Copied!</span>
              ) : (
                <Copy size={14} />
              )}
            </button>
          </div>
          <button className="text-xs text-text-dim font-mono hover:text-text" onClick={() => setNewKey(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Create new key */}
      <div className="bg-bg-card border border-border rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Plus size={13} className="text-accent" />
          <span className="text-xs font-mono text-text-muted uppercase tracking-widest">
            Create New API Key
          </span>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            className="input-field flex-1"
            placeholder="Key name (e.g. production, ci-runner)"
            value={newKeyName}
            onChange={e => setNewKeyName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreateKey()}
          />
          <button
            className="btn-primary flex items-center gap-1.5"
            onClick={handleCreateKey}
            disabled={creating || !newKeyName.trim()}
          >
            <Plus size={13} />
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>

      {/* Active keys */}
      <div className="bg-bg-card border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Key size={13} className="text-signal-green" />
          <span className="text-xs font-mono text-text-muted uppercase tracking-widest">
            Active Keys ({activeKeys.length})
          </span>
        </div>
        {activeKeys.length === 0 ? (
          <div className="py-6 text-center text-xs text-text-dim font-mono">
            No active API keys
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="table-cell text-left text-xs font-mono text-text-dim uppercase tracking-widest">Name</th>
                <th className="table-cell text-left text-xs font-mono text-text-dim uppercase tracking-widest">Hash (prefix)</th>
                <th className="table-cell text-left text-xs font-mono text-text-dim uppercase tracking-widest">Created</th>
                <th className="table-cell text-left text-xs font-mono text-text-dim uppercase tracking-widest">Last Used</th>
                <th className="table-cell text-right text-xs font-mono text-text-dim uppercase tracking-widest">Action</th>
              </tr>
            </thead>
            <tbody>
              {activeKeys.map(key => (
                <tr key={key._id} className="table-row">
                  <td className="table-cell">
                    <span className="text-sm text-text">{key.name}</span>
                  </td>
                  <td className="table-cell">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-xs text-text-muted">
                        {key.keyHash.slice(0, 8)}…
                      </span>
                      <button
                        className="text-text-dim hover:text-text transition-colors"
                        onClick={() => copyToClipboard(key.keyHash, key.keyHash)}
                        title="Copy full hash"
                      >
                        {copiedHash === key.keyHash ? (
                          <span className="text-signal-green text-xs">✓</span>
                        ) : (
                          <Copy size={11} />
                        )}
                      </button>
                    </div>
                  </td>
                  <td className="table-cell">
                    <span className="text-xs text-text-muted font-mono">
                      {formatRelativeTime(key.createdAt)}
                    </span>
                  </td>
                  <td className="table-cell">
                    <span className="text-xs text-text-muted font-mono">
                      {key.lastUsedAt ? formatRelativeTime(key.lastUsedAt) : 'Never'}
                    </span>
                  </td>
                  <td className="table-cell text-right">
                    <button
                      className="text-text-dim hover:text-signal-red transition-colors p-1"
                      onClick={() => handleRevoke(key.keyHash)}
                      title="Revoke key"
                    >
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Revoked keys */}
      {revokedKeys.length > 0 && (
        <div className="bg-bg-card border border-border rounded-lg overflow-hidden opacity-60">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Key size={13} className="text-text-dim" />
            <span className="text-xs font-mono text-text-dim uppercase tracking-widest">
              Revoked Keys ({revokedKeys.length})
            </span>
          </div>
          <table className="w-full">
            <tbody>
              {revokedKeys.map(key => (
                <tr key={key._id} className="border-b border-border last:border-0">
                  <td className="table-cell">
                    <span className="text-sm text-text-dim line-through">{key.name}</span>
                  </td>
                  <td className="table-cell">
                    <span className="font-mono text-xs text-text-dim">{key.keyHash.slice(0, 8)}…</span>
                  </td>
                  <td className="table-cell">
                    <span className="badge-red text-xs">
                      Revoked {key.revokedAt ? formatRelativeTime(key.revokedAt) : ''}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(text)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
