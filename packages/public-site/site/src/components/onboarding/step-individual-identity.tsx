import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { ComingSoonCard } from '@/components/onboarding/coming-soon'
import { Collapsible, Notice, Panel, Spinner, StatusBadge } from '@/components/onboarding/primitives'
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
      update({ personKycStatus: 'pending', personKycProvider: 'stripe_identity' })
    } catch (startError) {
      setError(describeError(startError, t.errors))
    } finally {
      setPending(false)
    }
  }

  const stored = (
    <Collapsible id="identity-advanced" title={t.onboarding.advanced}>
      <p className="leading-6 text-muted-foreground">{copy.identityStored}</p>
      <p className="leading-6 text-muted-foreground">{copy.identityNotStored}</p>
    </Collapsible>
  )

  return (
    <div data-testid="step-individual-identity" className="flex flex-col gap-4">
      {verified ? <Notice tone="success" title={copy.verifiedTitle}>{copy.verifiedBody}</Notice> : null}
      {preview ? (
        <div data-testid="step-individual-identity-stripe">
          <Panel title={copy.previewTitle}>
            <p className="text-sm leading-6 text-muted-foreground">{copy.previewBody}</p>
            <StatusBadge tone="pending">Stripe · test</StatusBadge>
          </Panel>
        </div>
      ) : null}
      {!preview && !verified && enabled === false ? (
        <div data-testid="step-individual-identity-soon" className="flex flex-col gap-4">
          <ComingSoonCard capability="stripeIdentity" title={copy.comingSoonTitle}>
            <p>{copy.comingSoonBody}</p>
          </ComingSoonCard>
          {stored}
        </div>
      ) : null}
      {!preview && !verified && enabled === true ? (
        <div className="beam-surface flex flex-col gap-4 rounded-2xl border p-5 sm:p-6">
          {sessionUrl ? (
            <>
              <p className="text-sm leading-6 text-muted-foreground">{copy.sessionOpen}</p>
              <div className="flex flex-wrap gap-2">
                <Button className="h-10 rounded-full px-5" asChild>
                  <a href={sessionUrl} rel="noreferrer">{copy.continueStripe}</a>
                </Button>
                <Button type="button" variant="outline" className="h-10 rounded-full px-5" onClick={() => void refreshStatus()} disabled={refreshing}>
                  {refreshing ? <Spinner label={copy.refreshing} /> : copy.refreshStatus}
                </Button>
              </div>
            </>
          ) : (
            <div>
              <Button id="start-identity-check" type="button" className="h-10 rounded-full px-5" onClick={() => void onStart()} disabled={pending || !secrets.personApiKey}>
                {pending ? <Spinner label={copy.starting} /> : copy.startCheck}
              </Button>
            </div>
          )}
          {pendingNote ? <p className="text-sm text-muted-foreground">{copy.stillPending}</p> : null}
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          {stored}
        </div>
      ) : null}
      {!preview && !verified && enabled === null ? <p className="text-sm text-muted-foreground">{copy.starting}</p> : null}
      {preview || verified || enabled !== true ? (error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null) : null}
    </div>
  )
}
