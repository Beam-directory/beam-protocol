import { useState } from 'react'
import { ArrowRight, KeyRound, Mail, Radio, ShieldCheck } from 'lucide-react'
import { useAdminAuth } from '../lib/admin-auth'

export default function LoginPage() {
  const { login, config } = useAdminAuth()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [devUrl, setDevUrl] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    
    try {
      const result = await login(email.trim())
      setSent(true)
      if (result.url) {
        setDevUrl(result.url)
      }
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div data-ui-page="login" className="relative min-h-screen overflow-hidden bg-transparent text-slate-950 dark:text-slate-50">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-24 top-0 h-80 w-80 rounded-full bg-orange-500/14 blur-3xl" style={{ animation: 'beam-float 12s ease-in-out infinite' }} />
        <div className="absolute right-[-5rem] top-12 h-96 w-96 rounded-full bg-cyan-400/10 blur-3xl" style={{ animation: 'beam-float 16s ease-in-out infinite' }} />
        <div className="beam-grid-lines absolute inset-0 opacity-45 dark:opacity-20" />
      </div>

      <div className="relative flex min-h-screen items-center justify-center px-6 py-10">
        <div className="grid w-full max-w-5xl gap-6 lg:grid-cols-[1.08fr,0.92fr]">
          <section className="panel hidden min-h-[640px] flex-col justify-between px-8 py-8 lg:flex">
            <div>
              <div className="inline-flex items-center gap-3 rounded-full border border-white/60 bg-white/[0.72] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-500 dark:border-white/10 dark:bg-slate-950/60 dark:text-slate-400">
                <Radio size={14} className="text-orange-500" />
                Beam Control Plane
              </div>
              <div className="mt-8 max-w-xl">
                <div className="text-5xl font-semibold tracking-[-0.06em] text-slate-950 dark:text-white">
                  One operator cockpit for every handoff.
                </div>
                <p className="mt-4 max-w-lg text-base leading-7 text-slate-600 dark:text-slate-300">
                  Workspaces, fleet health, partner lanes, audit proof, and OpenClaw host control stay in one surface instead of being spread across scripts and traces.
                </p>
              </div>
            </div>

            <div className="grid gap-3">
              <div className="rounded-[24px] border border-white/60 bg-white/70 p-4 dark:border-white/10 dark:bg-slate-950/55">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-orange-500/12 text-orange-600 dark:text-orange-300">
                    <KeyRound size={18} />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Short-lived operator access</div>
                    <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">Magic-link sign-in with explicit session verification.</div>
                  </div>
                </div>
              </div>
              <div className="rounded-[24px] border border-white/60 bg-white/70 p-4 dark:border-white/10 dark:bg-slate-950/55">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-cyan-500/12 text-cyan-600 dark:text-cyan-300">
                    <Mail size={18} />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Real operator workflow</div>
                    <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">Fleet, workspace, trace, and partner motion are all waiting after sign-in.</div>
                  </div>
                </div>
              </div>
              <div className="rounded-[24px] border border-white/60 bg-white/70 p-4 dark:border-white/10 dark:bg-slate-950/55">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-500/12 text-emerald-600 dark:text-emerald-300">
                    <ShieldCheck size={18} />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Proof stays attached</div>
                    <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">Every route, alert, and approval stays tied to a Beam trace.</div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="panel mx-auto w-full max-w-xl px-6 py-7 sm:px-8 sm:py-8">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-500 text-white shadow-[0_22px_60px_rgba(249,115,22,0.35)]">
                <Radio size={18} />
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.32em] text-orange-600 dark:text-orange-300">
                  Beam Directory
                </div>
                <div className="text-base font-semibold tracking-tight text-slate-950 dark:text-white">
                  Operator sign-in
                </div>
              </div>
            </div>

            {!sent ? (
              <>
                <div className="mt-8">
                  <h1 className="text-3xl font-semibold tracking-[-0.05em] text-slate-950 dark:text-white">
                    Open the operator cockpit
                  </h1>
                  <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
                    Enter the admin email that should receive your short-lived Beam magic link.
                  </p>
                </div>

                <form className="mt-7 space-y-4" onSubmit={handleSubmit}>
                  <div>
                    <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400" htmlFor="beam-admin-email">
                      Admin email
                    </label>
                    <input
                      id="beam-admin-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@company.com"
                      required
                      className="input-field"
                    />
                  </div>

                  {error ? (
                    <div className="rounded-[22px] border border-red-200 bg-red-50/90 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
                      {error}
                    </div>
                  ) : null}

                  <button type="submit" disabled={loading || !email.trim()} className="btn-primary w-full gap-2">
                    <span>{loading ? 'Sending magic link…' : 'Send magic link'}</span>
                    <ArrowRight size={16} />
                  </button>
                </form>

                <div className="mt-6 rounded-[24px] border border-white/60 bg-white/70 px-4 py-4 text-sm leading-6 text-slate-600 dark:border-white/10 dark:bg-slate-950/55 dark:text-slate-300">
                  Beam opens a short-lived operator session after verification. No shared browser key is required.
                </div>
              </>
            ) : (
              <>
                <div className="mt-8 flex h-16 w-16 items-center justify-center rounded-3xl bg-emerald-500/12 text-emerald-600 dark:text-emerald-300">
                  <Mail size={28} />
                </div>
                <div className="mt-6">
                  <h1 className="text-3xl font-semibold tracking-[-0.05em] text-slate-950 dark:text-white">
                    Check your inbox
                  </h1>
                  <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
                    A fresh magic link is ready for <span className="font-medium text-slate-950 dark:text-white">{email}</span>.
                  </p>
                </div>

                <div className="mt-6 rounded-[24px] border border-white/60 bg-white/70 px-4 py-4 text-sm leading-6 text-slate-600 dark:border-white/10 dark:bg-slate-950/55 dark:text-slate-300">
                  Didn&apos;t receive it? Check spam or{' '}
                  <button
                    onClick={() => { setSent(false); setDevUrl('') }}
                    className="font-medium text-orange-600 transition hover:text-orange-700 dark:text-orange-300"
                    type="button"
                  >
                    request a new link
                  </button>.
                </div>

                {devUrl ? (
                  <div className="mt-4 rounded-[24px] border border-orange-200 bg-orange-50/90 px-4 py-4 text-sm leading-6 text-orange-900 dark:border-orange-500/20 dark:bg-orange-500/10 dark:text-orange-100">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-orange-600 dark:text-orange-300">
                      Local dev shortcut
                    </div>
                    <div className="mt-2 break-all font-mono text-xs">{devUrl}</div>
                    <a className="mt-3 inline-flex items-center gap-2 font-medium text-orange-700 transition hover:text-orange-800 dark:text-orange-200" href={devUrl}>
                      Open local session
                      <ArrowRight size={15} />
                    </a>
                  </div>
                ) : null}
              </>
            )}

            <div className="mt-8 border-t border-white/60 pt-5 text-sm text-slate-500 dark:border-white/10 dark:text-slate-400">
              <div>
                {config?.emailDelivery
                  ? 'Authorized admins receive the magic link by email.'
                  : 'On localhost, Beam also returns the dev link directly when SMTP is not configured.'}
              </div>
              <a
                href="https://docs.beam.directory/guide/operator-observability"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-2 font-medium text-orange-600 transition hover:text-orange-700 dark:text-orange-300"
                target="_blank"
              >
                Open operator setup guide
                <ArrowRight size={15} />
              </a>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
