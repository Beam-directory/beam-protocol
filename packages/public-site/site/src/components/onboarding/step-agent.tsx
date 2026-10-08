import { useState, type FormEvent, type ReactNode } from 'react'
import { DownloadIcon, FileCheckIcon, KeyRoundIcon, LockIcon, ShieldCheckIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ComingSoonCard } from '@/components/onboarding/coming-soon'
import { CopyField, LiveBadge, Notice, Panel, SoonBadge, Spinner, StatusBadge, TextField, downloadJson } from '@/components/onboarding/primitives'
import type { StepProps } from '@/components/onboarding/types'
import { useI18n } from '@/i18n/context'
import { buildRecoveryKit, generateAgentIdentity, recoveryKitFileName } from '@/lib/agent-keys'
import { directoryApiBase } from '@/lib/directory-client'
import { describeError, registerAgent, submitBusinessRegistration, type BusinessRegistrationResult } from '@/lib/onboarding-api'
import {
  EMPTY_MANDATE,
  buildBeamId,
  mandatePreview,
  normalizeAgentName,
  validateAgentName,
  validateDisplayName,
  validateMandate,
  validateRegistration,
  type MandateDraft,
  type ValidationKey,
} from '@/lib/onboarding-steps'
import { fingerprintPublicKey } from '@/lib/public-agent'

function Check({ id, label, checked, onChange, children }: { id: string; label: string; checked: boolean; onChange: (value: boolean) => void; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3 has-[:checked]:border-beam/50 has-[:checked]:bg-beam/5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
      <label htmlFor={id} className="flex cursor-pointer items-center gap-2.5 text-sm">
        <input id={id} type="checkbox" className="size-4 accent-[var(--beam)]" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        {label}
      </label>
      {checked && children ? <div className="pl-6.5">{children}</div> : null}
    </div>
  )
}

export function StepAgent({ progress, update, secrets, setSecrets }: StepProps) {
  const { t } = useI18n()
  const copy = t.onboarding.agent
  const [pending, setPending] = useState<'keys' | 'register' | 'business' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nameError, setNameError] = useState<ValidationKey | null>(null)
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [mandate, setMandate] = useState<MandateDraft>(EMPTY_MANDATE)
  const [business, setBusiness] = useState<BusinessRegistrationResult | null>(null)
  const [businessError, setBusinessError] = useState<string | null>(null)

  const registered = Boolean(progress.registeredBeamId)
  const beamId = registered ? progress.registeredBeamId : buildBeamId(progress.agentName || 'name', progress.orgName || 'company')
  const canRegister = progress.orgVerified && Boolean(secrets.orgApiKey) && Boolean(secrets.identity)
  const mandateError = validateMandate(mandate)
  const hasRegistryData = Boolean(progress.registrationNumber && progress.legalName)
    && !validateRegistration(progress.registryCountry, progress.registrationNumber, progress.legalName)

  async function onGenerate() {
    setPending('keys')
    setError(null)
    try {
      const identity = await generateAgentIdentity()
      setSecrets({ identity, kitSaved: false })
      setFingerprint(await fingerprintPublicKey(identity.publicKey))
    } catch (keyError) {
      setError(describeError(keyError, t.errors))
    } finally {
      setPending(null)
    }
  }

  async function onRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const invalidName = validateAgentName(progress.agentName)
    const invalidDisplay = validateDisplayName(progress.agentDisplayName)
    setNameError(invalidName ?? invalidDisplay)
    if (invalidName || invalidDisplay || !secrets.identity || !secrets.orgApiKey) return
    setPending('register')
    setError(null)
    try {
      const agent = await registerAgent({
        beamId: buildBeamId(progress.agentName, progress.orgName),
        org: progress.orgName,
        displayName: progress.agentDisplayName.trim(),
        publicKey: secrets.identity.publicKey,
        dhPublicKey: secrets.identity.encryption.publicKey,
      }, secrets.orgApiKey)
      setSecrets({ agentApiKey: agent.apiKey, kitSaved: false })
      update({ registeredBeamId: agent.beamId })
    } catch (registerError) {
      setError(describeError(registerError, t.errors))
    } finally {
      setPending(null)
    }
  }

  function saveKit() {
    if (!secrets.identity || !secrets.agentApiKey) return
    const kit = buildRecoveryKit({ beamId: progress.registeredBeamId, directoryUrl: directoryApiBase(), identity: secrets.identity, apiKey: secrets.agentApiKey })
    downloadJson(recoveryKitFileName(kit.beamId), kit)
    setSecrets({ kitSaved: true })
  }

  async function onSubmitBusiness() {
    if (!secrets.agentApiKey) return
    setPending('business')
    setBusinessError(null)
    try {
      setBusiness(await submitBusinessRegistration(progress.registeredBeamId, secrets.agentApiKey, {
        country: progress.registryCountry,
        registrationNumber: progress.registrationNumber.trim(),
        legalName: progress.legalName.trim(),
      }))
    } catch (submitError) {
      setBusinessError(describeError(submitError, t.errors))
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex gap-3 rounded-2xl border border-beam/30 bg-beam/5 p-4 sm:p-5">
        <LockIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-beam" />
        <div className="flex flex-col gap-1 text-sm leading-6">
          <p className="font-medium">{copy.keyNoticeTitle}</p>
          <p className="text-muted-foreground">{copy.keyNoticeText}</p>
        </div>
      </div>

      {registered ? (
        <Panel title={copy.registeredPanel} badge={<StatusBadge tone="success">{copy.registered}</StatusBadge>}>
          <CopyField label={copy.beamId} value={progress.registeredBeamId} />
          {secrets.identity && secrets.agentApiKey ? (
            <div className="flex flex-col gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
              <p className="flex items-center gap-2 text-sm font-medium">
                <KeyRoundIcon aria-hidden="true" className="size-4 text-amber-600 dark:text-amber-400" />
                {copy.kitTitle}
              </p>
              <p className="text-xs leading-5 text-muted-foreground">{copy.kitText}</p>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" className="h-9 rounded-full px-4" onClick={saveKit}>
                  <DownloadIcon aria-hidden="true" /> {copy.downloadFile}
                </Button>
                {secrets.kitSaved ? <StatusBadge tone="success">{copy.downloadStarted}</StatusBadge> : null}
              </div>
            </div>
          ) : (
            <Notice tone="warning" title={copy.keysGoneTitle}>
              {copy.keysGoneBefore} <a className="underline underline-offset-4" href="/network">/network</a>{copy.keysGoneAfter}
            </Notice>
          )}
        </Panel>
      ) : (
        <form onSubmit={onRegister} className="flex flex-col gap-5" noValidate>
          <Panel title={copy.addressPanel} badge={<LiveBadge />}>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                id="agent-name"
                label={copy.beamId}
                value={progress.agentName}
                onChange={(value) => update({ agentName: normalizeAgentName(value) })}
                suffix={`@${progress.orgName || 'company'}.beam.directory`}
                placeholder={copy.agentPlaceholder}
                autoComplete="off"
                maxLength={63}
                error={nameError ? t.validation[nameError] : null}
              />
              <TextField
                id="agent-display-name"
                label={copy.displayName}
                value={progress.agentDisplayName}
                onChange={(value) => update({ agentDisplayName: value })}
                placeholder={copy.displayPlaceholder}
                autoComplete="off"
              />
            </div>
            <p className="text-xs leading-5 text-muted-foreground">{copy.unlistedNote}</p>
          </Panel>

          <Panel title={copy.keyPanel} badge={secrets.identity ? <StatusBadge tone="success">{copy.keyCreated}</StatusBadge> : <LiveBadge />}>
            {secrets.identity ? (
              <div className="flex flex-col gap-3">
                <CopyField label={copy.publicKeyLabel} value={secrets.identity.publicKey} />
                {fingerprint ? <p className="text-xs text-muted-foreground">{copy.fingerprint} <span className="font-mono text-foreground">{fingerprint}</span></p> : null}
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <ShieldCheckIcon aria-hidden="true" className="size-3.5 text-success" />
                  {copy.privateInMemory}
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-start gap-3">
                <p className="text-sm leading-6 text-muted-foreground">{copy.keyIntro}</p>
                <Button type="button" variant="outline" className="h-10 rounded-full px-5" onClick={() => void onGenerate()} disabled={pending !== null}>
                  {pending === 'keys' ? <Spinner label={copy.generating} /> : <><KeyRoundIcon aria-hidden="true" /> {copy.generate}</>}
                </Button>
              </div>
            )}
          </Panel>

          {!progress.orgVerified || !secrets.orgApiKey ? (
            <Notice tone="warning" title={copy.orgFirstTitle}>{copy.orgFirstText}</Notice>
          ) : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div>
            <Button type="submit" className="h-10 rounded-full px-5" disabled={!canRegister || pending !== null}>
              {pending === 'register' ? <Spinner label={copy.registering} /> : copy.register}
            </Button>
          </div>
        </form>
      )}

      <Panel title={copy.mandatePanel} badge={<SoonBadge />} className="border-dashed bg-transparent">
        <p className="text-sm leading-6 text-muted-foreground">{copy.mandateIntro}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Check id="scope-read" label={copy.scopes.read} checked={mandate.read} onChange={(read) => setMandate({ ...mandate, read })} />
          <Check id="scope-appointments" label={copy.scopes.appointments} checked={mandate.acceptAppointments} onChange={(acceptAppointments) => setMandate({ ...mandate, acceptAppointments })} />
          <Check id="scope-files" label={copy.scopes.files} checked={mandate.sendFiles} onChange={(sendFiles) => setMandate({ ...mandate, sendFiles })} />
          <Check id="scope-order" label={copy.scopes.order} checked={mandate.order} onChange={(order) => setMandate({ ...mandate, order })}>
            <TextField id="scope-order-limit" label={copy.scopes.orderLimit} inputMode="decimal" value={mandate.orderLimitEur} onChange={(orderLimitEur) => setMandate({ ...mandate, orderLimitEur })} placeholder="500" />
          </Check>
          <div className="sm:col-span-2">
            <Check id="scope-escalate" label={copy.scopes.escalate} checked={mandate.escalate} onChange={(escalate) => setMandate({ ...mandate, escalate })}>
              <TextField id="scope-escalate-to" label={copy.scopes.escalateTo} value={mandate.escalateTo} onChange={(escalateTo) => setMandate({ ...mandate, escalateTo })} placeholder={copy.scopes.escalatePlaceholder} />
            </Check>
          </div>
        </div>
        {mandateError ? <p className="text-xs text-muted-foreground">{t.validation[mandateError]}</p> : null}
        <details className="rounded-lg border bg-background/60 text-xs">
          <summary className="cursor-pointer rounded-lg px-3 py-2 text-muted-foreground">{copy.viewDraft}</summary>
          <pre className="overflow-x-auto border-t p-3 font-mono leading-5">{JSON.stringify(mandatePreview(mandate, beamId), null, 2)}</pre>
        </details>
      </Panel>
      <ComingSoonCard capability="issueMandate" title={copy.issueTitle} company={progress.displayName}>
        {copy.issueText}
      </ComingSoonCard>

      {registered ? (
        <Panel title={copy.businessPanel} badge={business ? <StatusBadge tone="pending">{copy.reviewPending}</StatusBadge> : <LiveBadge>{t.onboarding.firma.registryBadge}</LiveBadge>}>
          {business ? (
            <Notice tone="info" title={copy.submittedTitle}>
              {copy.submittedText(business.status === 'pending' ? copy.statusPending : business.status)}
            </Notice>
          ) : hasRegistryData ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm leading-6 text-muted-foreground">
                <FileCheckIcon aria-hidden="true" className="mr-1 inline size-4" />
                {progress.legalName}, {progress.registrationNumber} ({t.onboarding.firma.countries[progress.registryCountry]})
              </p>
              {businessError ? <Notice tone="error">{businessError}</Notice> : null}
              <Button type="button" variant="outline" className="h-9 rounded-full px-4" disabled={!secrets.agentApiKey || pending !== null} onClick={() => void onSubmitBusiness()}>
                {pending === 'business' ? <Spinner label={copy.submitting} /> : copy.submitReview}
              </Button>
            </div>
          ) : (
            <p className="text-sm leading-6 text-muted-foreground">{copy.noRegistryData}</p>
          )}
        </Panel>
      ) : null}
    </div>
  )
}
