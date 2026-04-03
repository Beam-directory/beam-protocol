import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight, LoaderCircle, Radio, ShieldAlert } from 'lucide-react'
import { useAdminAuth } from '../lib/admin-auth'

export default function AuthCallbackPage() {
  const [searchParams] = useSearchParams()
  const { verify } = useAdminAuth()
  const navigate = useNavigate()
  const [error, setError] = useState('')

  useEffect(() => {
    const token = searchParams.get('token')
    if (!token) {
      setError('No token found in URL')
      return
    }

    verify(token).then(success => {
      if (success) {
        navigate('/', { replace: true })
      } else {
        setError('Invalid or expired magic link. Please request a new one.')
      }
    })
  }, [searchParams, verify, navigate])

  return (
    <div className="relative min-h-screen overflow-hidden bg-transparent text-slate-950 dark:text-slate-50">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-24 top-0 h-80 w-80 rounded-full bg-orange-500/14 blur-3xl" style={{ animation: 'beam-float 12s ease-in-out infinite' }} />
        <div className="absolute right-[-5rem] top-16 h-96 w-96 rounded-full bg-cyan-400/10 blur-3xl" style={{ animation: 'beam-float 18s ease-in-out infinite' }} />
        <div className="beam-grid-lines absolute inset-0 opacity-45 dark:opacity-20" />
      </div>

      <div className="relative flex min-h-screen items-center justify-center px-6 py-10">
        <div className="panel w-full max-w-lg px-6 py-8 text-center sm:px-8">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-orange-500 text-white shadow-[0_24px_60px_rgba(249,115,22,0.35)]">
            {error ? <ShieldAlert size={22} /> : <Radio size={22} />}
          </div>
          <div className="mt-5 text-[11px] font-semibold uppercase tracking-[0.34em] text-orange-600 dark:text-orange-300">
            Beam Control Plane
          </div>

          {error ? (
            <>
              <div className="mt-3 text-3xl font-semibold tracking-[-0.05em] text-slate-950 dark:text-white">
                Magic link failed
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
                {error}
              </p>
              <div className="mt-6 rounded-[24px] border border-red-200 bg-red-50/90 px-4 py-4 text-sm leading-6 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
                Request a fresh link and try again. Beam only opens an operator session after the token is verified.
              </div>
              <a href="/login" className="btn-primary mt-6 inline-flex gap-2">
                Request a new magic link
                <ArrowRight size={16} />
              </a>
            </>
          ) : (
            <>
              <div className="mt-3 text-3xl font-semibold tracking-[-0.05em] text-slate-950 dark:text-white">
                Verifying your operator session
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
                Checking the magic link and restoring your Beam operator surface.
              </p>
              <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-white/60 bg-white/70 px-4 py-2 text-sm text-slate-600 dark:border-white/10 dark:bg-slate-950/60 dark:text-slate-300">
                <LoaderCircle className="animate-spin" size={16} />
                Verifying magic link
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
