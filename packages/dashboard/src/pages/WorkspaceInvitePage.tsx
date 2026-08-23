import { useEffect, useState, type FormEvent } from 'react'
import { ArrowRight, CheckCircle2, KeyRound, LoaderCircle, Mail, Radio, ShieldCheck } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAdminAuth } from '../lib/admin-auth'
import { ApiError, directoryApi, type WorkspaceInvitationPreview } from '../lib/api'

export default function WorkspaceInvitePage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { session, login, loading: authLoading } = useAdminAuth()
  const token = searchParams.get('token')?.trim() ?? ''
  const [preview, setPreview] = useState<WorkspaceInvitationPreview | null>(null)
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [devUrl, setDevUrl] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      setError('This invitation is invalid or no longer available.')
      setLoading(false)
      return () => { cancelled = true }
    }

    void directoryApi.getWorkspaceInvitationPreview(token)
      .then((response) => {
        if (!cancelled) setPreview(response)
      })
      .catch(() => {
        if (!cancelled) setError('This invitation is invalid or no longer available.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [token])

  async function handleSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!email.trim() || !token) return
    try {
      setBusy(true)
      setError('')
      const returnTo = `/workspace-invite?token=${encodeURIComponent(token)}`
      const result = await login(email.trim(), returnTo)
      setSent(true)
      setDevUrl(result.url ?? '')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the sign-in link.')
    } finally {
      setBusy(false)
    }
  }

  async function handleAccept() {
    if (!preview || !token) return
    try {
      setBusy(true)
      setError('')
      const result = await directoryApi.acceptWorkspaceInvitation(token)
      navigate(`/workspaces?workspace=${encodeURIComponent(result.workspace.slug)}`, { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not accept this invitation.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-ui-page="workspace-invite" className="relative min-h-screen overflow-hidden bg-transparent text-slate-950 dark:text-slate-50">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-24 top-0 h-80 w-80 rounded-full bg-orange-500/12 blur-3xl" />
        <div className="absolute right-[-5rem] top-16 h-96 w-96 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="beam-grid-lines absolute inset-0 opacity-40 dark:opacity-20" />
      </div>

      <div className="relative flex min-h-screen items-center justify-center px-6 py-10">
        <main className="panel w-full max-w-2xl px-6 py-8 sm:px-9">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-500 text-white shadow-[0_22px_60px_rgba(249,115,22,0.28)]">
              <Radio size={18} />
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.3em] text-orange-600 dark:text-orange-300">Beam workspace</div>
              <div className="text-base font-semibold tracking-tight">Secure team invitation</div>
            </div>
          </div>

          {loading || authLoading ? (
            <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-slate-500 dark:text-slate-400">
              <LoaderCircle className="animate-spin" size={18} />
              Checking invitation
            </div>
          ) : preview ? (
            <>
              <div className="mt-8">
                <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">You were invited to</div>
                <h1 className="mt-2 text-3xl font-semibold tracking-[-0.05em]">{preview.invitation.workspace.name}</h1>
                <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
                  Join as <span className="font-medium text-slate-950 dark:text-white">{preview.invitation.role}</span>. The invitation is bound to {preview.invitation.emailMasked} and expires {new Date(preview.invitation.expiresAt).toLocaleString()}.
                </p>
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                  <KeyRound size={17} className="text-orange-500" />
                  <div className="mt-3 text-sm font-medium">One-time invite</div>
                </div>
                <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                  <Mail size={17} className="text-cyan-500" />
                  <div className="mt-3 text-sm font-medium">Email-bound sign-in</div>
                </div>
                <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                  <ShieldCheck size={17} className="text-emerald-500" />
                  <div className="mt-3 text-sm font-medium">Workspace-only access</div>
                </div>
              </div>

              {session ? (
                <div className="mt-7 rounded-2xl border border-slate-200 p-5 dark:border-slate-800">
                  <div className="text-sm font-medium">Signed in as {session.email}</div>
                  <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">Accepting grants only the workspace role shown above.</div>
                  <button className="btn-primary mt-5 gap-2" disabled={busy} onClick={() => { void handleAccept() }} type="button">
                    {busy ? <LoaderCircle className="animate-spin" size={16} /> : <CheckCircle2 size={16} />}
                    Accept invitation
                  </button>
                </div>
              ) : sent ? (
                <div className="mt-7 rounded-2xl border border-emerald-200 bg-emerald-50/80 p-5 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100">
                  <div className="font-medium">Check your inbox</div>
                  <p className="mt-2 text-sm leading-6">Open the Beam sign-in link sent to {email}. It will bring you back here to accept.</p>
                  {devUrl ? (
                    <a className="mt-4 inline-flex items-center gap-2 text-sm font-medium underline" href={devUrl}>
                      Local development sign-in
                      <ArrowRight size={15} />
                    </a>
                  ) : null}
                </div>
              ) : (
                <form className="mt-7 rounded-2xl border border-slate-200 p-5 dark:border-slate-800" onSubmit={(event) => { void handleSignIn(event) }}>
                  <label className="block text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400" htmlFor="workspace-invite-email">Invited email</label>
                  <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                    <input id="workspace-invite-email" className="input-field flex-1" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" />
                    <button className="btn-primary gap-2" disabled={busy || !email.trim()} type="submit">
                      {busy ? <LoaderCircle className="animate-spin" size={16} /> : <Mail size={16} />}
                      Continue securely
                    </button>
                  </div>
                </form>
              )}
            </>
          ) : (
            <div className="mt-8 min-h-52 rounded-2xl border border-red-200 bg-red-50/80 p-6 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100">
              <div className="text-lg font-semibold">Invitation unavailable</div>
              <p className="mt-2 text-sm leading-6">{error || 'Ask the workspace owner for a fresh invitation.'}</p>
            </div>
          )}

          {error && preview ? (
            <div className="mt-5 rounded-2xl border border-red-200 bg-red-50/80 px-4 py-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100">{error}</div>
          ) : null}
        </main>
      </div>
    </div>
  )
}
