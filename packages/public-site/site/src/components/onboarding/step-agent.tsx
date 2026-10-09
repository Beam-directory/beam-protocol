import { useState, type FormEvent } from 'react'
import { RefreshCwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CopyField, Notice, Panel, SaveFileBox, Spinner, TextField, downloadJson } from '@/components/onboarding/primitives'
import { ScopeFields } from '@/components/onboarding/scope-fields'
import type { StepProps } from '@/components/onboarding/types'
import { useI18n } from '@/i18n/context'
import { buildRecoveryKit, generateAgentIdentity, recoveryKitFileName } from '@/lib/agent-keys'
import { directoryApiBase } from '@/lib/directory-client'
import { describeError, getKycStatus, getTrustAssertion, issueMandate, publishEncryptionKey, registerAgent, type TrustAssertionView } from '@/lib/onboarding-api'
import {
  MANDATE_TTL_MS,
  mandatePayload,
  normalizeAgentName,
  scopeGrantFromDraft,
  scopeWithin,
  validateAgentName,
  validateDisplayName,
  type ScopeDraft,
  type ValidationKey,
} from '@/lib/onboarding-steps'
import { describeActions } from '@/lib/plain-actions'
import { fingerprintPublicKey } from '@/lib/public-agent'

function createJti(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  let value = ''
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0')
  return `m${value}`
}

function mandateExpiry(): string {
  return new Date(Date.now() + MANDATE_TTL_MS).toISOString()
}

export function StepAgent({ progress, update, secrets, setSecrets }: StepProps) {
  const { t } = useI18n()
  const copy = t.onboarding.agent
  const [pending, setPending] = useState<'register' | 'encrypt' | 'mandate' | 'assertion' | 'refresh' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nameError, setNameError] = useState<ValidationKey | null>(null)
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [mandate, setMandate] = useState<ScopeDraft>(progress.personRights)
  const [mandateError, setMandateError] = useState<string | null>(null)
  const [assertion, setAssertion] = useState<TrustAssertionView | null>(null)

  const registered = Boolean(progress.registeredBeamId)
  const orgReady = progress.orgVerified && Boolean(secrets.orgApiKey)
  const canRegister = orgReady && Boolean(progress.personId)
  const kycVerified = progress.personKycStatus === 'verified'
  const displayFallback = progress.agentName || copy.agentPlaceholder
  const mandateGrant = scopeGrantFromDraft(mandate)
  const mandateWords = 'grant' in mandateGrant
    ? describeActions(mandateGrant.grant.actions, mandateGrant.grant.order, t.check.actions)
    : ''

  async function onRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const displayName = progress.agentDisplayName.trim() || progress.agentName
    const invalidName = validateAgentName(progress.agentName)
    const invalidDisplay = invalidName ? null : validateDisplayName(displayName)
    setNameError(invalidName ?? invalidDisplay)
    if (invalidName || invalidDisplay || !secrets.orgApiKey || !progress.personId) return
    setPending('register')
    setError(null)
    try {
      const identity = secrets.identity ?? await generateAgentIdentity()
      if (!secrets.identity) setSecrets({ identity, kitSaved: false })
      setFingerprint(await fingerprintPublicKey(identity.publicKey))
      const agent = await registerAgent({
        orgName: progress.orgName,
        agentName: normalizeAgentName(progress.agentName),
        displayName,
        publicKey: identity.publicKey,
        responsiblePersonId: progress.personId,
      }, secrets.orgApiKey)
      setSecrets({ identity, agentApiKey: agent.apiKey, kitSaved: false })
      update({ registeredBeamId: agent.beamId, orgName: agent.org || progress.orgName })
      setPending('encrypt')
      await publishEncryptionKey({
        beamId: agent.beamId,
        dhPublicKey: identity.encryption.publicKey,
        signingKey: identity.signingKey,
      })
      update({ encryptionKeyPublished: true, registeredBeamId: agent.beamId })
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

  async function onRefreshKyc() {
    if (!secrets.orgApiKey || !progress.personId) return
    setPending('refresh')
    setMandateError(null)
    try {
      const person = await getKycStatus(progress.orgName, secrets.orgApiKey, progress.personId)
      const status = person?.kycStatus
      if (status === 'pending' || status === 'verified' || status === 'rejected' || status === 'unverified') {
        update({ personKycStatus: status, personKycProvider: person?.kycProvider ?? '' })
      }
    } catch (refreshError) {
      setMandateError(describeError(refreshError, t.errors))
    } finally {
      setPending(null)
    }
  }

  async function onIssueMandate() {
    const rights = scopeGrantFromDraft(progress.personRights)
    if ('error' in mandateGrant) {
      setMandateError(t.validation[mandateGrant.error])
      return
    }
    if ('error' in rights || !scopeWithin(mandateGrant.grant, rights.grant)) {
      setMandateError(t.validation.scopeExceedsRights)
      return
    }
    if (!secrets.personIdentity || !progress.personId || !progress.registeredBeamId) return
    setPending('mandate')
    setMandateError(null)
    try {
      const expiresAt = mandateExpiry()
      const payload = mandatePayload({
        jti: createJti(),
        personId: progress.personId,
        agentBeamId: progress.registeredBeamId,
        org: progress.orgName,
        scopes: mandateGrant.grant,
        expiresAt,
      })
      const issued = await issueMandate({ beamId: progress.registeredBeamId, payload, signingKey: secrets.personIdentity.signingKey })
      update({ mandateJti: issued.jti, mandateStatus: issued.status })
      if (secrets.orgApiKey) {
        setPending('assertion')
        try {
          setAssertion(await getTrustAssertion(progress.registeredBeamId, secrets.orgApiKey))
        } catch (assertionError) {
          setMandateError(describeError(assertionError, t.errors))
        }
      }
    } catch (issueError) {
      setMandateError(describeError(issueError, t.errors))
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {!registered && !orgReady ? <Notice tone="warning" title={copy.orgFirstTitle}>{copy.orgFirstText}</Notice> : null}
      {!registered && orgReady && !progress.personId ? <Notice tone="warning" title={copy.personFirstTitle}>{copy.personFirstText}</Notice> : null}

      {registered ? (
        <>
          <div className="beam-surface flex flex-col gap-3 rounded-2xl border p-5 sm:p-6">
            <CopyField label={copy.address} value={progress.registeredBeamId} />
            {error ? <Notice tone="error">{error}</Notice> : null}
          </div>
          {secrets.identity && secrets.agentApiKey ? (
            <SaveFileBox
              title={copy.kitTitle}
              text={copy.kitText}
              buttonLabel={copy.downloadFile}
              buttonId="download-agent-file"
              onSave={saveKit}
              saved={secrets.kitSaved}
              savedLabel={copy.downloadStarted}
            />
          ) : (
            <Notice tone="warning" title={copy.keysGoneTitle}>
              {copy.keysGoneBefore} <a className="underline underline-offset-4" href="/network">/network</a>{copy.keysGoneAfter}
            </Notice>
          )}

          <Panel title={copy.mayTitle} id="mandate">
            {progress.mandateJti ? (
              <Notice tone="success">{copy.confirmed(mandateWords)}</Notice>
            ) : (
              <>
                <p className="text-sm leading-6 text-muted-foreground">{copy.mayText(mandateWords || '—')}</p>
                {!kycVerified ? (
                  <Notice tone="info" title={copy.waitTitle}>
                    {copy.waitText}
                    <div className="mt-2">
                      <Button id="refresh-kyc-agent" type="button" variant="outline" className="h-8 rounded-full px-3" disabled={!secrets.orgApiKey || pending !== null} onClick={() => void onRefreshKyc()}>
                        {pending === 'refresh' ? <Spinner label={copy.refreshing} /> : <><RefreshCwIcon aria-hidden="true" /> {copy.refresh}</>}
                      </Button>
                    </div>
                  </Notice>
                ) : null}
                {kycVerified && !secrets.personIdentity ? <p className="text-xs text-muted-foreground">{copy.personKeyMissing}</p> : null}
                {mandateError ? <Notice tone="error">{mandateError}</Notice> : null}
                <div>
                  <Button
                    id="issue-mandate"
                    type="button"
                    className="h-10 rounded-full px-5"
                    disabled={!kycVerified || !secrets.personIdentity || pending !== null}
                    onClick={() => void onIssueMandate()}
                  >
                    {pending === 'mandate' || pending === 'assertion' ? <Spinner label={copy.confirming} /> : copy.confirm}
                  </Button>
                </div>
              </>
            )}
          </Panel>
        </>
      ) : (
        <form onSubmit={onRegister} className="beam-surface flex flex-col gap-4 rounded-2xl border p-5 sm:p-6" noValidate>
          <TextField
            id="agent-name"
            label={copy.agentName}
            value={progress.agentName}
            onChange={(value) => update({ agentName: normalizeAgentName(value) })}
            suffix={`@${progress.orgName || 'company'}.beam.directory`}
            placeholder={copy.agentPlaceholder}
            autoComplete="off"
            maxLength={63}
            error={nameError ? t.validation[nameError] : null}
          />
          <Collapsible id="agent-advanced" title={t.onboarding.advanced}>
            <TextField
              id="agent-display-name"
              label={copy.technicalDisplayName}
              value={progress.agentDisplayName}
              onChange={(value) => update({ agentDisplayName: value })}
              placeholder={displayFallback}
              description={copy.technicalDisplayHelp(displayFallback)}
              autoComplete="off"
            />
            <p className="leading-6 text-muted-foreground">{copy.technicalUnlisted}</p>
            <p className="leading-6 text-muted-foreground">{copy.technicalKeys}</p>
          </Collapsible>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div>
            <Button id="register-agent" type="submit" className="h-10 rounded-full px-5" disabled={!canRegister || pending !== null}>
              {pending === 'register' || pending === 'encrypt' ? <Spinner label={copy.creating} /> : copy.create}
            </Button>
          </div>
        </form>
      )}

      {registered ? (
        <Collapsible id="agent-advanced" title={t.onboarding.advanced}>
          <p className="leading-6 text-muted-foreground">{copy.technicalKeys}</p>
          {secrets.identity ? <CopyField label={copy.technicalPublicKey} value={secrets.identity.publicKey} /> : null}
          {fingerprint ? <p className="text-xs text-muted-foreground">{copy.technicalFingerprint}: <span className="font-mono text-foreground">{fingerprint}</span></p> : null}
          {progress.encryptionKeyPublished ? <p className="text-xs text-muted-foreground">{copy.technicalEncryption}</p> : null}
          <p className="leading-6 text-muted-foreground">{copy.technicalMandate}</p>
          {!progress.mandateJti ? (
            <div className="flex flex-col gap-2">
              <p className="font-medium text-foreground">{copy.technicalScopes}</p>
              <ScopeFields idPrefix="mandate" value={mandate} onChange={setMandate} />
            </div>
          ) : (
            <CopyField label={copy.assertionMandate} value={progress.mandateJti} />
          )}
          {assertion ? (
            <div className="rounded-lg border bg-background/60 p-3 text-xs leading-5 text-muted-foreground" data-testid="trust-assertion">
              <p className="font-medium text-foreground">{copy.technicalAssertion}</p>
              <p>{copy.assertionOrg}: <span className="font-mono text-foreground">{assertion.orgName}</span> · {assertion.orgVerified ? copy.assertionVerified : copy.assertionUnverified}</p>
              <p>{copy.assertionRegistry}: {assertion.registryStatus}</p>
              <p>{copy.assertionPerson}: {assertion.personRole || '—'} · {copy.assertionKyc}: {assertion.kycStatus || '—'}</p>
              <p>{copy.assertionMandate}: <span className="font-mono text-foreground">{assertion.mandateJti || '—'}</span></p>
              <p>{copy.assertionNote}</p>
            </div>
          ) : null}
        </Collapsible>
      ) : null}
    </div>
  )
}
