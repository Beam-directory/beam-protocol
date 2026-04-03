import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  ApiError,
  adminAuthApi,
  type AdminMagicLinkResponse,
  type AdminRole,
  BUS_DEFAULT_URL,
  DIRECTORY_URL,
  busApi,
  clearStoredBusConfig,
  directoryApi,
  directoryRoleApi,
  getBusBaseUrl,
  getStoredBusApiKey,
  getStoredBusUrl,
  hasStoredAdminSessionToken,
  hasStoredBusApiKey,
  setStoredBusApiKey,
  setStoredBusUrl,
  type BusHealth,
  type BusStats,
  type DirectoryRoleAssignment,
  type DirectoryHealth,
  type RootStatsResponse,
  type RetentionResponse,
} from '../lib/api'
import { useAdminAuth } from '../lib/admin-auth'

const PRIVATE_KEY_PREFIX = 'beam-dashboard-private-key:'

type RoleFormState = {
  email: string
  role: AdminRole
}

export default function SettingsPage() {
  const { session, config, logout } = useAdminAuth()
  const [health, setHealth] = useState<DirectoryHealth | null>(null)
  const [rootStats, setRootStats] = useState<RootStatsResponse | null>(null)
  const [busHealth, setBusHealth] = useState<BusHealth | null>(null)
  const [busStats, setBusStats] = useState<BusStats | null>(null)
  const [retention, setRetention] = useState<RetentionResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busUrl, setBusUrl] = useState(() => getStoredBusUrl() || BUS_DEFAULT_URL)
  const [busApiKey, setBusApiKey] = useState(() => getStoredBusApiKey())
  const [busStatus, setBusStatus] = useState<string | null>(hasStoredBusApiKey() || getStoredBusUrl() ? 'Bus configuration stored locally.' : null)
  const [roles, setRoles] = useState<DirectoryRoleAssignment[]>([])
  const [roleForm, setRoleForm] = useState<RoleFormState>({ email: '', role: 'viewer' })
  const [roleStatus, setRoleStatus] = useState<string | null>(null)
  const [roleActionBusy, setRoleActionBusy] = useState<string | null>(null)
  const [magicLinkResult, setMagicLinkResult] = useState<AdminMagicLinkResponse | null>(null)

  const isAdmin = session?.role === 'admin'
  const canOperate = session?.role === 'admin' || session?.role === 'operator'

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const [healthResponse, statsResponse, retentionResponse] = await Promise.allSettled([
          directoryApi.getHealth(),
          directoryApi.getRootStats(),
          directoryApi.getRetention(),
        ])

        if (cancelled) return

        if (healthResponse.status === 'fulfilled') {
          setHealth(healthResponse.value)
          setError(null)
        } else if (healthResponse.reason instanceof ApiError) {
          setError(healthResponse.reason.message)
        }

        if (statsResponse.status === 'fulfilled') {
          setRootStats(statsResponse.value)
        }

        if (retentionResponse.status === 'fulfilled') {
          setRetention(retentionResponse.value)
        }

        const [busHealthResponse, busStatsResponse] = await Promise.allSettled([
          busApi.getHealth(),
          busApi.getStats(),
        ])

        if (cancelled) return

        if (busHealthResponse.status === 'fulfilled') {
          setBusHealth(busHealthResponse.value)
        }

        if (busStatsResponse.status === 'fulfilled') {
          setBusStats(busStatsResponse.value)
        } else if (busStatsResponse.reason instanceof ApiError) {
          setBusStatus(busStatsResponse.reason.message)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Failed to reach the directory API')
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const releaseTruthMatches = useMemo(() => {
    const healthVersion = health?.release?.version ?? health?.version ?? null
    const healthSha = health?.release?.gitSha ?? health?.gitSha ?? null
    const healthDeployedAt = health?.release?.deployedAt ?? health?.deployedAt ?? null
    const statsVersion = rootStats?.release?.version ?? rootStats?.version ?? null
    const statsSha = rootStats?.release?.gitSha ?? rootStats?.gitSha ?? null
    const statsDeployedAt = rootStats?.release?.deployedAt ?? rootStats?.deployedAt ?? null

    if (!healthVersion || !statsVersion) {
      return null
    }

    return healthVersion === statsVersion
      && (healthSha ?? '') === (statsSha ?? '')
      && (healthDeployedAt ?? '') === (statsDeployedAt ?? '')
  }, [health, rootStats])

  const storedKeys = useMemo(() => {
    return Object.keys(localStorage).filter((key) => key.startsWith(PRIVATE_KEY_PREFIX))
  }, [])

  const sortedRoles = useMemo(() => {
    return [...roles].sort((left, right) => left.email.localeCompare(right.email))
  }, [roles])

  async function loadRoles() {
    try {
      const response = await directoryRoleApi.list()
      setRoles(response.roles)
    } catch (err) {
      setRoleStatus(err instanceof ApiError ? err.message : 'Failed to load directory roles')
    }
  }

  useEffect(() => {
    if (!session) {
      setRoles([])
      return
    }

    void loadRoles()
  }, [session?.email, session?.role])

  async function validateBusConfig() {
    try {
      setStoredBusUrl(busUrl)
      setStoredBusApiKey(busApiKey)
      const [healthResponse, statsResponse] = await Promise.all([
        busApi.getHealth(),
        busApi.getStats(),
      ])
      setBusHealth(healthResponse)
      setBusStats(statsResponse)
      setBusStatus('Message bus connection validated.')
    } catch (err) {
      setBusStatus(err instanceof ApiError ? err.message : 'Message bus validation failed')
    }
  }

  function clearBusSettings() {
    clearStoredBusConfig()
    setBusUrl(BUS_DEFAULT_URL)
    setBusApiKey('')
    setBusHealth(null)
    setBusStats(null)
    setBusStatus('Message bus URL and API key removed from local storage.')
  }

  async function handleAssignRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!isAdmin) {
      setRoleStatus('Assigning or changing roles requires an admin session.')
      return
    }

    const email = roleForm.email.trim().toLowerCase()
    if (!email || !email.includes('@')) {
      setRoleStatus('Enter a valid email address for the role assignment.')
      return
    }

    try {
      setRoleActionBusy('assign')
      setRoleStatus(null)
      await directoryRoleApi.assign({ email, role: roleForm.role })
      await loadRoles()
      setRoleForm({ email: '', role: 'viewer' })
      setRoleStatus(`Role ${roleForm.role} assigned to ${email}.`)
    } catch (err) {
      setRoleStatus(err instanceof ApiError ? err.message : 'Failed to assign directory role')
    } finally {
      setRoleActionBusy(null)
    }
  }

  async function handleRevokeRole(email: string) {
    if (!isAdmin) {
      setRoleStatus('Revoking roles requires an admin session.')
      return
    }
    if (!window.confirm(`Revoke the directory role for ${email}?`)) {
      return
    }

    try {
      setRoleActionBusy(`revoke:${email}`)
      setRoleStatus(null)
      await directoryRoleApi.revoke(email)
      await loadRoles()
      setRoleStatus(`Role assignment removed for ${email}.`)
    } catch (err) {
      setRoleStatus(err instanceof ApiError ? err.message : 'Failed to revoke directory role')
    } finally {
      setRoleActionBusy(null)
    }
  }

  async function handleIssueMagicLink(email?: string) {
    if (!canOperate) {
      setRoleStatus('Issuing sign-in links requires at least an operator session.')
      return
    }

    const targetEmail = (email ?? roleForm.email).trim().toLowerCase()
    if (!targetEmail || !targetEmail.includes('@')) {
      setRoleStatus('Enter a valid email address before issuing a sign-in link.')
      return
    }

    try {
      setRoleActionBusy(`magic:${targetEmail}`)
      setRoleStatus(null)
      const response = await adminAuthApi.requestMagicLink(targetEmail)
      setMagicLinkResult(response)
      setRoleStatus(`Sign-in link issued for ${targetEmail}.`)
    } catch (err) {
      setRoleStatus(err instanceof ApiError ? err.message : 'Failed to issue sign-in link')
    } finally {
      setRoleActionBusy(null)
    }
  }

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Connection health, admin session state, and browser-stored credentials for observability access.</p>
      </section>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="panel space-y-3">
          <div className="panel-title">API connection</div>
          <InfoRow label="Directory URL" value={DIRECTORY_URL} />
          <InfoRow label="Health status" value={health?.status ?? 'Unavailable'} />
          <InfoRow label="Protocol" value={health?.protocol ?? '—'} />
          <InfoRow label="Connected agents" value={health ? String(health.connectedAgents) : '—'} />
          <InfoRow label="Last heartbeat" value={health?.timestamp ?? '—'} />
          <InfoRow label="Release version" value={health?.release?.version ?? health?.version ?? '—'} />
          <InfoRow label="Git SHA" value={health?.release?.gitShaShort ?? health?.gitSha ?? '—'} />
          <InfoRow label="Deployed at" value={health?.release?.deployedAt ?? health?.deployedAt ?? '—'} />
          <InfoRow
            label="Release truth"
            value={releaseTruthMatches == null ? 'Unavailable' : releaseTruthMatches ? 'health/stats match' : 'drift detected'}
          />
        </div>

        <div className="panel space-y-3">
          <div className="panel-title">Message bus</div>
          <InfoRow label="Bus URL" value={getBusBaseUrl()} />
          <InfoRow label="Health status" value={busHealth?.status ?? 'Unavailable'} />
          <InfoRow label="Service" value={busHealth?.service ?? '—'} />
          <InfoRow label="Dead letters" value={busStats ? String(busStats.dead_letter) : '—'} />
          <InfoRow label="Queued retries" value={busStats ? String(busStats.queued) : '—'} />
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="panel space-y-4">
          <div className="panel-title">Admin access</div>
          <InfoRow label="Signed in as" value={session?.email ?? 'No active session'} />
          <InfoRow label="Role" value={session?.role ?? '—'} />
          <InfoRow label="Session expires" value={session?.expiresAt ?? '—'} />
          <InfoRow label="Authorized admins configured" value={config?.configured ? 'Yes' : 'No'} />
          <InfoRow label="Magic-link delivery" value={config?.emailDelivery ? 'Email provider configured' : 'Local dev / bootstrap only'} />
          <div className="flex flex-wrap gap-3">
            <button className="btn-secondary" onClick={() => void logout()} type="button">
              Sign out
            </button>
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Observability requests now use an authenticated admin session instead of a pasted static browser key.
          </p>
        </div>

        <div className="panel space-y-4">
          <div className="panel-title">Message bus access</div>
          <input
            className="input-field"
            placeholder={BUS_DEFAULT_URL}
            type="text"
            value={busUrl}
            onChange={(event) => setBusUrl(event.target.value)}
          />
          <input
            className="input-field"
            placeholder="Paste BEAM_BUS_API_KEY"
            type="password"
            value={busApiKey}
            onChange={(event) => setBusApiKey(event.target.value)}
          />
          <div className="flex flex-wrap gap-3">
            <button className="btn-primary" onClick={() => void validateBusConfig()} type="button">
              Save & Validate
            </button>
            <button className="btn-secondary" onClick={clearBusSettings} type="button">
              Clear
            </button>
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Dead-letter requests use the configured URL and attach the bus API key as `Authorization: Bearer ...`.
          </p>
          {busStatus ? <p className="text-sm text-slate-600 dark:text-slate-300">{busStatus}</p> : null}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
        <div className="panel space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="panel-title">Operators and members</div>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Beam role directory for hosted fleet operators. Viewers can inspect posture, operators can issue sign-in links, and admins can change access.
              </p>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">{sortedRoles.length} assignments</div>
          </div>

          {roleStatus ? (
            <div className="rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-300">
              {roleStatus}
            </div>
          ) : null}

          <div className="space-y-3">
            {sortedRoles.length > 0 ? (
              sortedRoles.map((role) => (
                <div key={role.email} className="rounded-2xl border border-slate-200 px-4 py-4 dark:border-slate-800">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{role.email}</div>
                      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">Hosted fleet access via {role.role} privileges.</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <span className="rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-700 dark:border-slate-800 dark:text-slate-200">{role.role}</span>
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={roleActionBusy === `magic:${role.email}`}
                        onClick={() => { void handleIssueMagicLink(role.email) }}
                      >
                        {roleActionBusy === `magic:${role.email}` ? 'Issuing…' : 'Issue link'}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={!isAdmin || roleActionBusy === `revoke:${role.email}`}
                        onClick={() => { void handleRevokeRole(role.email) }}
                      >
                        {roleActionBusy === `revoke:${role.email}` ? 'Revoking…' : 'Revoke'}
                      </button>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 px-4 py-6 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                No directory roles are assigned yet.
              </div>
            )}
          </div>
        </div>

        <div className="panel space-y-4">
          <div className="panel-title">Role management</div>
          <form className="space-y-3" onSubmit={(event) => { void handleAssignRole(event) }}>
            <input
              className="input-field"
              placeholder="operator@beam.directory"
              type="email"
              value={roleForm.email}
              onChange={(event) => setRoleForm((current) => ({ ...current, email: event.target.value }))}
            />
            <select
              className="input-field"
              value={roleForm.role}
              onChange={(event) => setRoleForm((current) => ({ ...current, role: event.target.value as AdminRole }))}
            >
              <option value="viewer">viewer</option>
              <option value="operator">operator</option>
              <option value="admin">admin</option>
            </select>
            <div className="flex flex-wrap gap-3">
              <button className="btn-primary" disabled={!isAdmin || roleActionBusy === 'assign'} type="submit">
                {roleActionBusy === 'assign' ? 'Saving…' : 'Assign role'}
              </button>
              <button
                className="btn-secondary"
                disabled={!canOperate || roleActionBusy === `magic:${roleForm.email.trim().toLowerCase()}`}
                onClick={() => { void handleIssueMagicLink() }}
                type="button"
              >
                {roleActionBusy === `magic:${roleForm.email.trim().toLowerCase()}` ? 'Issuing…' : 'Issue sign-in link'}
              </button>
            </div>
          </form>

          <div className="rounded-2xl border border-slate-200 px-4 py-4 text-sm dark:border-slate-800">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Role guardrails</div>
            <div className="mt-2 space-y-2 text-slate-600 dark:text-slate-300">
              <div>`viewer` can inspect release truth, fleet posture, and dashboards.</div>
              <div>`operator` can run guided operations and issue sign-in links.</div>
              <div>`admin` can change roles and execute destructive fleet actions.</div>
            </div>
          </div>

          {magicLinkResult ? (
            <div className="rounded-2xl border border-slate-200 px-4 py-4 text-sm dark:border-slate-800">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Latest sign-in link</div>
              <div className="mt-2 text-sm font-medium text-slate-900 dark:text-slate-100">{magicLinkResult.email}</div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {`${magicLinkResult.role} · expires ${magicLinkResult.expiresAt}`}
              </div>
              {magicLinkResult.url ? (
                <a className="mt-3 inline-flex break-all rounded-xl bg-slate-100 px-3 py-3 font-mono text-xs text-slate-700 dark:bg-slate-900 dark:text-slate-200" href={magicLinkResult.url}>
                  {magicLinkResult.url}
                </a>
              ) : magicLinkResult.token ? (
                <div className="mt-3 break-all rounded-xl bg-slate-100 px-3 py-3 font-mono text-xs text-slate-700 dark:bg-slate-900 dark:text-slate-200">
                  {magicLinkResult.token}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="panel space-y-3">
          <div className="panel-title">Observability retention</div>
          <InfoRow label="Default days" value={retention ? String(retention.defaultDays) : '—'} />
          <InfoRow label="Datasets" value={retention?.datasets.join(', ') ?? '—'} />
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Retention controls in the Alerts page now require an admin-only preview plus a typed confirmation phrase before prune is allowed.
          </p>
          {retention?.details?.length ? (
            <div className="space-y-2 rounded-xl bg-slate-50 p-3 text-sm text-slate-600 dark:bg-slate-950 dark:text-slate-300">
              {retention.details.map((entry) => (
                <div key={entry.name}>
                  <span className="font-medium">{entry.name}:</span> {entry.description}
                  {entry.cascadesTo?.length ? ` Also removes ${entry.cascadesTo.join(', ')}.` : ''}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="panel space-y-3">
          <div className="panel-title">Browser storage</div>
          <InfoRow label="Stored private keys" value={String(storedKeys.length)} />
          <InfoRow label="Admin session token" value={hasStoredAdminSessionToken() ? 'Stored' : 'Not stored'} />
          <InfoRow label="Bus API key" value={hasStoredBusApiKey() ? 'Stored' : 'Not stored'} />
          <InfoRow label="Bus URL" value={getStoredBusUrl() || BUS_DEFAULT_URL} />
          <p className="text-sm text-slate-500 dark:text-slate-400">Private keys generated on the Register page stay in `localStorage` for this browser profile only.</p>
        </div>
      </section>

      <section className="panel space-y-3">
        <div className="panel-title">Operator docs</div>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Admin setup, alert triage, exports, and prune safety are documented end to end in the operator guide.
        </p>
        <div className="flex flex-wrap gap-3">
          <a
            className="inline-flex w-fit rounded-full border border-slate-200 px-3 py-1.5 text-sm text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-900"
            href="https://docs.beam.directory/guide/operator-observability"
            rel="noreferrer"
            target="_blank"
          >
            Open operator guide
          </a>
          <a
            className="inline-flex w-fit rounded-full border border-slate-200 px-3 py-1.5 text-sm text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-900"
            href="https://beam.directory/status.html"
            rel="noreferrer"
            target="_blank"
          >
            Open release status
          </a>
        </div>
      </section>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-sm text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 break-all text-sm font-medium">{value}</div>
    </div>
  )
}
