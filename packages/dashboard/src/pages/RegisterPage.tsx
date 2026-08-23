import { FormEvent, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ApiError,
  directoryApi,
  type WorkspaceIdentityProvisionResponse,
  type WorkspaceRecord,
} from '../lib/api'

function credentialDownloadName(beamId: string): string {
  return `${beamId.replace(/[^a-z0-9._-]+/gi, '-')}.beam-identity.json`
}

export default function RegisterPage() {
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([])
  const [workspaceSlug, setWorkspaceSlug] = useState('')
  const [agentName, setAgentName] = useState('grok')
  const [displayName, setDisplayName] = useState('Grok Collaboration Agent')
  const [capabilities, setCapabilities] = useState('conversation.message, workspace.handoff.prepare')
  const [description, setDescription] = useState('Read-only collaboration identity for a dedicated Grok MCP connector.')
  const [bindingType, setBindingType] = useState<'agent' | 'service'>('agent')
  const [orgApiKey, setOrgApiKey] = useState('')
  const [result, setResult] = useState<WorkspaceIdentityProvisionResponse | null>(null)
  const [downloaded, setDownloaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.slug === workspaceSlug) ?? null,
    [workspaceSlug, workspaces],
  )
  const capabilityList = useMemo(
    () => [...new Set(capabilities.split(',').map((value) => value.trim()).filter(Boolean))],
    [capabilities],
  )
  const beamIdPreview = selectedWorkspace
    ? selectedWorkspace.orgName
      ? `${agentName || 'agent'}@${selectedWorkspace.orgName}.beam.directory`
      : `${agentName || 'agent'}@beam.directory`
    : 'Select a workspace first'

  useEffect(() => {
    let active = true
    void directoryApi.listWorkspaces()
      .then((response) => {
        if (!active) return
        setWorkspaces(response.workspaces)
        setWorkspaceSlug((current) => current || response.workspaces[0]?.slug || '')
      })
      .catch((reason: unknown) => {
        if (!active) return
        setError(reason instanceof ApiError ? reason.message : 'Failed to load workspaces')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!result || downloaded) return undefined
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [downloaded, result])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedWorkspace) return

    try {
      setSubmitting(true)
      setError(null)
      setResult(null)
      setDownloaded(false)
      const response = await directoryApi.provisionWorkspaceIdentity(selectedWorkspace.slug, {
        agentName: agentName.trim().toLowerCase(),
        displayName: displayName.trim(),
        capabilities: capabilityList,
        description: description.trim(),
        bindingType,
        runtimeType: 'mcp:dedicated-tenant',
        ...(selectedWorkspace.orgName ? { orgApiKey: orgApiKey.trim() } : {}),
      })
      setOrgApiKey('')
      setResult(response)
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Failed to provision Beam identity')
    } finally {
      setSubmitting(false)
    }
  }

  function handleDownload() {
    if (!result) return
    const blob = new Blob([JSON.stringify(result.credential, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = credentialDownloadName(result.credential.beamId)
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
    setDownloaded(true)
  }

  return (
    <div className="space-y-6">
      <section className="panel">
        <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-orange-600 dark:text-orange-300">Beam onboarding</div>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Create the identity Grok will use</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600 dark:text-slate-300">
          The workspace reserves one Beam ID, binds it to your tenant, and returns its signing key plus API key exactly once. Nothing secret is written to browser storage.
        </p>
        <div className="mt-6 grid gap-3 md:grid-cols-4">
          <Step number="1" title="Workspace" detail="Choose the collaboration boundary." />
          <Step number="2" title="Beam ID" detail="Reserve a unique cryptographic identity." />
          <Step number="3" title="Credential" detail="Download the one-time identity bundle." />
          <Step number="4" title="Grok" detail="Connect the dedicated MCP URL with OAuth." />
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.15fr,0.85fr]">
        <section className="panel">
          <div className="panel-title">Identity details</div>
          {loading ? (
            <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">Loading your workspaces…</p>
          ) : workspaces.length === 0 ? (
            <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
              You need an owned workspace before creating a Beam ID. Ask the workspace owner for an invitation, then return here.
              <div className="mt-3"><Link className="font-medium underline" to="/workspaces">Open workspaces</Link></div>
            </div>
          ) : (
            <form className="mt-5 space-y-4" onSubmit={handleSubmit}>
              <Field label="Workspace">
                <select className="input-field" value={workspaceSlug} onChange={(event) => setWorkspaceSlug(event.target.value)} required>
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.slug}>{workspace.name}</option>
                  ))}
                </select>
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Agent name">
                  <input
                    className="input-field"
                    pattern={'[a-z0-9](?:[a-z0-9_\\-]{0,61}[a-z0-9])?'}
                    maxLength={63}
                    value={agentName}
                    onChange={(event) => setAgentName(event.target.value.toLowerCase())}
                    required
                  />
                </Field>
                <Field label="Type">
                  <select className="input-field" value={bindingType} onChange={(event) => setBindingType(event.target.value as 'agent' | 'service')}>
                    <option value="agent">Agent</option>
                    <option value="service">Service</option>
                  </select>
                </Field>
              </div>

              <Field label="Display name">
                <input className="input-field" maxLength={120} value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
              </Field>
              <Field label="Capabilities (comma separated)">
                <input className="input-field" value={capabilities} onChange={(event) => setCapabilities(event.target.value)} required />
              </Field>
              <Field label="Description">
                <textarea className="input-field min-h-24" maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} />
              </Field>

              {selectedWorkspace?.orgName ? (
                <Field label={`Organization API key for ${selectedWorkspace.orgName}`}>
                  <input
                    className="input-field"
                    type="password"
                    autoComplete="off"
                    value={orgApiKey}
                    onChange={(event) => setOrgApiKey(event.target.value)}
                    required
                  />
                  <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">Required once to prove control of the organization namespace. It is not stored with the workspace or included in audit data.</p>
                </Field>
              ) : null}

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950/40">
                <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Beam ID preview</div>
                <div className="mt-2 break-all font-mono text-sm text-slate-800 dark:text-slate-100">{beamIdPreview}</div>
                <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">Outbound sends start disabled. The first Grok connector profile is read-only.</div>
              </div>

              {error ? <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">{error}</div> : null}
              <button className="btn-primary" type="submit" disabled={submitting || capabilityList.length === 0}>
                {submitting ? 'Provisioning…' : 'Create Beam ID'}
              </button>
            </form>
          )}
        </section>

        <section className="space-y-4">
          <div className="panel">
            <div className="panel-title">What Grok receives</div>
            <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
              Grok never receives the private key. The dedicated MCP service holds the Beam credential and exposes only the approved tools after OAuth login.
            </p>
            <div className="mt-4 space-y-3 text-sm">
              <InfoRow label="Identity" value={result?.credential.beamId ?? beamIdPreview} />
              <InfoRow label="Runtime" value="Dedicated read-only MCP tenant" />
              <InfoRow label="Initial tools" value="beam_status, beam_prepare_handoff" />
              <InfoRow label="Send permission" value="Disabled until separately approved" />
            </div>
          </div>

          {result ? (
            <div className="panel border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/20 dark:bg-emerald-500/10">
              <div className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">Beam ID created</div>
              <div className="mt-2 break-all font-mono text-sm text-slate-900 dark:text-white">{result.credential.beamId}</div>
              <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
                Download the credential now. Beam stores only hashes and public material; the API cannot show this private key or API key again.
              </p>
              <button className="btn-primary mt-4" type="button" onClick={handleDownload}>
                {downloaded ? 'Download identity bundle again' : 'Download identity bundle'}
              </button>
              <div className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                {downloaded ? 'Downloaded in this browser session.' : 'Do not leave this page before downloading.'}
              </div>
              <div className="mt-5 border-t border-emerald-200 pt-4 text-sm dark:border-emerald-500/20">
                Next: provision the dedicated MCP tenant from this bundle, then add its HTTPS URL in Grok under Settings → Connectors and complete OAuth.
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </label>
  )
}

function Step({ number, title, detail }: { number: string; title: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white/70 p-4 dark:border-slate-800 dark:bg-slate-950/40">
      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500 text-xs font-semibold text-white">{number}</div>
      <div className="mt-3 text-sm font-medium">{title}</div>
      <div className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{detail}</div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 break-all font-medium">{value}</div>
    </div>
  )
}
