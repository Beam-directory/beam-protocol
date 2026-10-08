import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { ComingSoonCard } from '@/components/onboarding/coming-soon'
import { Notice, Panel, Spinner, StatusBadge } from '@/components/onboarding/primitives'
import type { StepProps } from '@/components/onboarding/types'
import { useI18n } from '@/i18n/context'
import { describeError, getIdentityProviderStatus, getIndividualProfile, startIndividualVerification } from '@/lib/onboarding-api'

export function StepIndividualIdentity({ progress, update, secrets }: StepProps) {
  const { t } = useI18n()
  const copy = t.onboarding.individual
  const [params] = useSearchParams()
  const preview = import.meta.env.DEV && params.get('identityPreview') === 'stripe'
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sessionUrl, setSessionUrl] = useState<string | null>(null)
  const [sessionStatus, setSessionStatus] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [pendingNote, setPendingNote] = useState(false)
  const verified = progress.personKycStatus === 'verified' && progress.personKycProvider === 'stripe_identity'

  async function refreshStatus() {
    if (!secrets.personApiKey) return
    setRefreshing(true)
    setError(null)
    setPendingNote(false)
    try {
      const profile = await getIndividualProfile(secrets.personApiKey)
      const provider = profile.kycProvider ?? ''
      update({
        personKycStatus: profile.kycStatus === 'verified' || profile.kycStatus === 'pending' || profile.kycStatus === 'rejected' || profile.kycStatus === 'unverified'
          ? profile.kycStatus
          : 'pending',
        personKycProvider: provider,
      })
      if (profile.kycStatus !== 'verified' || provider !== 'stripe_identity') setPendingNote(true)
    } catch (refreshError) {
      setError(describeError(refreshError, t.errors))
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    if (!sessionUrl || verified || !secrets.personApiKey) return undefined
    const timer = window.setInterval(() => {
      void refreshStatus()
    }, 4000)
    return () => window.clearInterval(timer)
    // refreshStatus closes over the latest key; the session url is the signal that a check is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionUrl, verified, secrets.personApiKey])

  useEffect(() => {
    if (preview || verified) return undefined
    let cancel = false
    void getIdentityProviderStatus().then((status) => {
      if (!cancel) setEnabled(status.enabled)
    })
    return () => {
      cancel = true
    }
  }, [preview, verified])

  async function onStart() {
    if (!secrets.personApiKey) return
    setPending(true)
    setError(null)
    try {
      const session = await startIndividualVerification(secrets.personApiKey)
      setSessionUrl(session.url)
      setSessionStatus(session.status)
      update({ personKycStatus: 'pending', personKycProvider: 'stripe_identity' })
    } catch (startError) {
      setError(describeError(startError, t.errors))
    } finally {
      setPending(false)
    }
  }

  return (
    <div data-testid="step-individual-identity" className="flex flex-col gap-4">
      {verified ? (
        <Notice tone="success" title={copy.verifiedTitle}>{copy.verifiedBody}</Notice>
      ) : null}
      {preview ? (
        <div data-testid="step-individual-identity-stripe">
          <Panel title={copy.previewTitle}>
            <p className="text-sm leading-6 text-muted-foreground">{copy.previewBody}</p>
            <StatusBadge tone="pending">Stripe · test</StatusBadge>
          </Panel>
        </div>
      ) : null}
      {!preview && !verified && enabled === false ? (
        <div data-testid="step-individual-identity-soon">
          <ComingSoonCard capability="stripeIdentity" title={copy.comingSoonTitle}>
            <p>{copy.comingSoonBody}</p>
            <p>{copy.identityNotStored}</p>
          </ComingSoonCard>
        </div>
      ) : null}
      {!preview && !verified && enabled === true ? (
        <Panel title={copy.identityPanel}>
          <p className="text-sm leading-6 text-muted-foreground">{copy.identityBody}</p>
          <p className="text-sm leading-6 text-muted-foreground">{copy.identityNotStored}</p>
          {sessionStatus ? <p className="text-sm">{copy.sessionOpen}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" className="h-10 rounded-full" onClick={() => void onStart()} disabled={pending || !secrets.personApiKey}>
              {pending ? <Spinner label={copy.starting} /> : copy.startCheck}
            </Button>
            {sessionUrl ? (
              <a href={sessionUrl} className="inline-flex h-10 items-center rounded-full border px-4 text-sm" rel="noreferrer">
                {copy.continueStripe}
              </a>
            ) : null}
            {sessionUrl ? (
              <Button type="button" variant="outline" className="h-10 rounded-full" onClick={() => void refreshStatus()} disabled={refreshing}>
                {refreshing ? <Spinner label={copy.refreshing} /> : copy.refreshStatus}
              </Button>
            ) : null}
          </div>
          {pendingNote && !verified ? <p className="text-sm text-muted-foreground">{copy.stillPending}</p> : null}
        </Panel>
      ) : null}
      {!preview && !verified && enabled === null ? <p className="text-sm text-muted-foreground">{copy.starting}</p> : null}
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
    </div>
  )
}
