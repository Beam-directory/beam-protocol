import { useState, useEffect } from 'react'
import { useAuth } from '../lib/auth'
import { DIRECTORY_URL } from '../lib/api'

interface UsageData {
  beamId: string
  plan: string
  period: string
  usage: { intentCount: number; encryptedCount: number; directCount: number; relayedCount: number }
  limits: { dailyLimit: number; overageRate: string }
}

interface ShieldStats {
  blockedIntents: number
  totalScanned: number
  piiDetections: number
  injectionAttempts: number
}

export default function DashboardPage() {
  const { user, selectedAgent, selectAgent, logout } = useAuth()
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [loadingUsage, setLoadingUsage] = useState(true)

  useEffect(() => {
    if (!selectedAgent) return
    setLoadingUsage(true)
    fetch(`${DIRECTORY_URL}/billing/usage/${encodeURIComponent(selectedAgent.beamId)}`)
      .then(r => r.json())
      .then(d => setUsage(d))
      .catch(() => setUsage(null))
      .finally(() => setLoadingUsage(false))
  }, [selectedAgent?.beamId])

  if (!user || !selectedAgent) return null

  const tierColors: Record<string, string> = {
    basic: '#A1A1AA',
    verified: '#3B82F6',
    business: '#22C55E',
    enterprise: '#F75C03',
  }

  const tierBadge = (tier: string) => (
    <span style={{
      background: `${tierColors[tier] || '#A1A1AA'}20`,
      color: tierColors[tier] || '#A1A1AA',
      padding: '4px 10px',
      borderRadius: '12px',
      fontSize: '0.75rem',
      fontWeight: 600,
      textTransform: 'capitalize',
    }}>
      {tier === 'verified' ? '🔵' : tier === 'business' ? '🟢' : tier === 'enterprise' ? '🟠' : '⚪'} {tier}
    </span>
  )

  return (
    <div style={{ padding: '0 24px 40px', maxWidth: '1000px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '20px 0',
        borderBottom: '1px solid #E4E4E7',
        marginBottom: '32px',
        flexWrap: 'wrap',
        gap: '12px',
      }}>
        <div>
          <div style={{ fontSize: '1.2rem', fontWeight: 800 }}>
            📡 beam<span style={{ color: '#F75C03' }}>.directory</span>
          </div>
          <div style={{ color: '#A1A1AA', fontSize: '0.82rem' }}>{user.email}</div>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          {user.agents.length > 1 && (
            <select
              value={selectedAgent.beamId}
              onChange={(e) => selectAgent(e.target.value)}
              style={{
                padding: '8px 12px',
                borderRadius: '8px',
                border: '1px solid #E4E4E7',
                fontSize: '0.85rem',
                fontFamily: 'inherit',
                background: 'white',
              }}
            >
              {user.agents.map(a => (
                <option key={a.beamId} value={a.beamId}>{a.displayName} ({a.beamId})</option>
              ))}
            </select>
          )}
          <button
            onClick={logout}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              border: '1px solid #E4E4E7',
              background: 'white',
              cursor: 'pointer',
              fontSize: '0.85rem',
              fontFamily: 'inherit',
            }}
          >
            Logout
          </button>
        </div>
      </div>

      {/* Agent Card */}
      <div style={{
        background: 'white',
        border: '1px solid #E4E4E7',
        borderRadius: '16px',
        padding: '24px',
        marginBottom: '20px',
        boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <h2 style={{ fontSize: '1.3rem', fontWeight: 700, marginBottom: '4px' }}>
              {selectedAgent.displayName}
            </h2>
            <div style={{ color: '#52525B', fontSize: '0.9rem', fontFamily: 'monospace' }}>
              {selectedAgent.beamId}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {tierBadge(selectedAgent.verificationTier)}
            <span style={{
              background: selectedAgent.visibility === 'public' ? '#22C55E20' : '#A1A1AA20',
              color: selectedAgent.visibility === 'public' ? '#22C55E' : '#A1A1AA',
              padding: '4px 10px',
              borderRadius: '12px',
              fontSize: '0.75rem',
              fontWeight: 600,
            }}>
              {selectedAgent.visibility === 'public' ? '👁 Public' : '🔒 Unlisted'}
            </span>
          </div>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '16px',
          marginTop: '20px',
        }}>
          <div>
            <div style={{ color: '#A1A1AA', fontSize: '0.75rem', fontWeight: 600, marginBottom: '4px' }}>TRUST SCORE</div>
            <div style={{ fontSize: '1.3rem', fontWeight: 700 }}>{selectedAgent.trustScore.toFixed(2)}</div>
          </div>
          <div>
            <div style={{ color: '#A1A1AA', fontSize: '0.75rem', fontWeight: 600, marginBottom: '4px' }}>PLAN</div>
            <div style={{ fontSize: '1.3rem', fontWeight: 700, textTransform: 'capitalize' }}>{selectedAgent.plan}</div>
          </div>
          <div>
            <div style={{ color: '#A1A1AA', fontSize: '0.75rem', fontWeight: 600, marginBottom: '4px' }}>CAPABILITIES</div>
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
              {selectedAgent.capabilities.map(c => (
                <span key={c} style={{
                  background: '#F4F4F5',
                  padding: '2px 8px',
                  borderRadius: '6px',
                  fontSize: '0.75rem',
                }}>
                  {c}
                </span>
              ))}
            </div>
          </div>
          <div>
            <div style={{ color: '#A1A1AA', fontSize: '0.75rem', fontWeight: 600, marginBottom: '4px' }}>LAST SEEN</div>
            <div style={{ fontSize: '0.9rem' }}>{new Date(selectedAgent.lastSeen).toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: '16px',
        marginBottom: '20px',
      }}>
        {/* Usage */}
        <div style={{
          background: 'white',
          border: '1px solid #E4E4E7',
          borderRadius: '14px',
          padding: '20px',
          boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
        }}>
          <div style={{ color: '#A1A1AA', fontSize: '0.75rem', fontWeight: 600, marginBottom: '8px' }}>
            📊 TODAY'S USAGE
          </div>
          {loadingUsage ? (
            <div style={{ color: '#A1A1AA' }}>Loading...</div>
          ) : usage ? (
            <>
              <div style={{ fontSize: '2rem', fontWeight: 800 }}>{usage.usage.intentCount}</div>
              <div style={{ fontSize: '0.82rem', color: '#52525B' }}>
                / {usage.limits.dailyLimit.toLocaleString()} intents
              </div>
              <div style={{
                height: '6px',
                background: '#F4F4F5',
                borderRadius: '3px',
                marginTop: '10px',
                overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%',
                  background: usage.usage.intentCount > usage.limits.dailyLimit * 0.8 ? '#EF4444' : '#22C55E',
                  borderRadius: '3px',
                  width: `${Math.min(100, (usage.usage.intentCount / usage.limits.dailyLimit) * 100)}%`,
                  transition: 'width 0.3s',
                }} />
              </div>
            </>
          ) : (
            <div style={{ color: '#A1A1AA' }}>No data</div>
          )}
        </div>

        {/* Encrypted */}
        <div style={{
          background: 'white',
          border: '1px solid #E4E4E7',
          borderRadius: '14px',
          padding: '20px',
          boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
        }}>
          <div style={{ color: '#A1A1AA', fontSize: '0.75rem', fontWeight: 600, marginBottom: '8px' }}>
            🔐 ENCRYPTED
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800 }}>
            {usage?.usage.encryptedCount ?? 0}
          </div>
          <div style={{ fontSize: '0.82rem', color: '#52525B' }}>E2E encrypted intents</div>
        </div>

        {/* P2P */}
        <div style={{
          background: 'white',
          border: '1px solid #E4E4E7',
          borderRadius: '14px',
          padding: '20px',
          boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
        }}>
          <div style={{ color: '#A1A1AA', fontSize: '0.75rem', fontWeight: 600, marginBottom: '8px' }}>
            ⚡ P2P DIRECT
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800 }}>
            {usage?.usage.directCount ?? 0}
          </div>
          <div style={{ fontSize: '0.82rem', color: '#52525B' }}>
            vs {usage?.usage.relayedCount ?? 0} relayed
          </div>
        </div>

        {/* Shield */}
        <div style={{
          background: 'white',
          border: '1px solid #E4E4E7',
          borderRadius: '14px',
          padding: '20px',
          boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
        }}>
          <div style={{ color: '#A1A1AA', fontSize: '0.75rem', fontWeight: 600, marginBottom: '8px' }}>
            🛡️ SHIELD MODE
          </div>
          <div style={{ fontSize: '1.5rem', fontWeight: 800, textTransform: 'capitalize' }}>
            {selectedAgent.shieldConfig?.mode || 'open'}
          </div>
          <div style={{ fontSize: '0.82rem', color: '#52525B' }}>
            Min trust: {selectedAgent.shieldConfig?.minTrustScore ?? 0.3}
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div style={{
        background: 'white',
        border: '1px solid #E4E4E7',
        borderRadius: '14px',
        padding: '24px',
        boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
      }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '16px' }}>Quick Actions</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
          <ActionCard emoji="🛡️" title="Shield Config" desc="Configure trust gates, blocklists, and content filters" href="/shield" />
          <ActionCard emoji="📊" title="Usage & Billing" desc="View usage, upgrade plan, manage billing" href="/billing" />
          <ActionCard emoji="🔑" title="Key Management" desc="Rotate keys, set up E2E encryption" href="/keys" />
          <ActionCard emoji="✏️" title="Edit Agent" desc="Update display name, description, capabilities" href="/edit" />
          <ActionCard emoji="🌐" title="DID Document" desc={`View your W3C DID: did:beam:${selectedAgent.org ? selectedAgent.org + ':' : ''}${selectedAgent.beamId.split('@')[0]}`} href="/did" />
          <ActionCard emoji="📡" title="Intents Log" desc="View sent & received intents" href="/intents" />
        </div>
      </div>
    </div>
  )
}

function ActionCard({ emoji, title, desc, href }: { emoji: string; title: string; desc: string; href: string }) {
  return (
    <a href={href} style={{
      display: 'block',
      padding: '16px',
      border: '1px solid #E4E4E7',
      borderRadius: '12px',
      textDecoration: 'none',
      color: 'inherit',
      transition: 'all 0.2s',
    }}
    onMouseOver={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#F75C03'; (e.currentTarget as HTMLElement).style.background = 'rgba(247,92,3,0.02)' }}
    onMouseOut={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#E4E4E7'; (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      <div style={{ fontSize: '1.5rem', marginBottom: '8px' }}>{emoji}</div>
      <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '4px' }}>{title}</div>
      <div style={{ color: '#52525B', fontSize: '0.8rem', lineHeight: 1.4 }}>{desc}</div>
    </a>
  )
}
