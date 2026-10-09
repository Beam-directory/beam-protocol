import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CopyField, Notice, SaveFileBox, Spinner, TextField, downloadJson } from '@/components/onboarding/primitives'
import { ScopeFields } from '@/components/onboarding/scope-fields'
import type { StepProps } from '@/components/onboarding/types'
import { useI18n } from '@/i18n/context'
import { buildRecoveryKit, generateAgentIdentity, recoveryKitFileName, type AgentIdentity } from '@/lib/agent-keys'
import { directoryApiBase } from '@/lib/directory-client'
import { describeError, issueMandate, publishEncryptionKey, registerIndividualAgent } from '@/lib/onboarding-api'
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

function createJti(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  let value = ''
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0')
  return `m${value}`
}

const READ_ONLY: ScopeDraft = { read: true, schedule: false, files: false, order: false, orderLimitEur: '' }

export function StepIndividualAgent({ progress, update, secrets, setSecrets }: StepProps) {
  const { t } = useI18n()
  const copy = t.onboarding.individual
  const agentCopy = t.onboarding.agent
  const [pending, setPending] = useState<'register' | 'mandate' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nameError, setNameError] = useState<ValidationKey | null>(null)
  const [mandate, setMandate] = useState<ScopeDraft>(READ_ONLY)
  const [mandateError, setMandateError] = useState<string | null>(null)
  const registered = Boolean(progress.registeredBeamId)
  const mandateGrant = scopeGrantFromDraft(mandate)
  const mandateWords = 'grant' in mandateGrant
    ? describeActions(mandateGrant.grant.actions, mandateGrant.grant.order, t.check.actions)
    : ''

  async function signMandate(beamId: string, identity: NonNullable<StepProps['secrets']['personIdentity']>) {
    const parsed = scopeGrantFromDraft(mandate)
    const rights = scopeGrantFromDraft(progress.personRights)
    if ('error' in parsed) {
      setMandateError(t.validation[parsed.error])
      return false
    }
    if ('error' in rights || !scopeWithin(parsed.grant, rights.grant)) {
      setMandateError(t.validation.scopeExceedsRights)
      return false
    }
    if (!progress.personId) return false
    const expiresAt = new Date(Date.now() + MANDATE_TTL_MS).toISOString()
    const payload = mandatePayload({
      jti: createJti(),
      personId: progress.personId,
      agentBeamId: beamId,
      org: null,
      scopes: parsed.grant,
      expiresAt,
    })
    const issued = await issueMandate({ beamId, payload, signingKey: identity.signingKey })
    update({ mandateJti: issued.jti, mandateStatus: issued.status })
    return true
  }

  async function onRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = normalizeAgentName(progress.agentName)
    const sameHandle = name === progress.personalHandle.trim().toLowerCase()
    const displayName = progress.agentDisplayName.trim() || name
    const invalidName = validateAgentName(name)
    const invalidDisplay = invalidName || sameHandle ? null : validateDisplayName(displayName)
    const scopeError = 'error' in mandateGrant ? mandateGrant.error : null
    setNameError(invalidName ?? (sameHandle ? 'agentNameInvalid' : null) ?? invalidDisplay)
    setMandateError(scopeError ? t.validation[scopeError] : null)
    if (invalidName || sameHandle || invalidDisplay || scopeError || !secrets.personApiKey || !secrets.personIdentity) return
    setPending('register')
    setError(null)
    try {
      const identity: AgentIdentity = secrets.identity ?? await generateAgentIdentity()
      const agent = await registerIndividualAgent({
        agentName: name,
        displayName,
        publicKey: identity.publicKey,
        personApiKey: secrets.personApiKey,
      })
      setSecrets({ identity, agentApiKey: agent.apiKey, kitSaved: false })
      update({ registeredBeamId: agent.beamId, agentName: name, agentDisplayName: displayName })
      await publishEncryptionKey({
        beamId: agent.beamId,
        dhPublicKey: identity.encryption.publicKey,
        signingKey: identity.signingKey,
      })
      update({ encryptionKeyPublished: true, registeredBeamId: agent.beamId })
      setPending('mandate')
      await signMandate(agent.beamId, secrets.personIdentity)
    } catch (registerError) {
      setError(describeError(registerError, t.errors))
    } finally {
      setPending(null)
    }
  }

  async function onRetryMandate() {
    if (!secrets.personIdentity || !progress.registeredBeamId) return
    setPending('mandate')
    setMandateError(null)
    setError(null)
    try {
      await signMandate(progress.registeredBeamId, secrets.personIdentity)
    } catch (mandateFailure) {
      setMandateError(describeError(mandateFailure, t.errors))
    } finally {
      setPending(null)
    }
  }

  function saveKit() {
    if (!secrets.identity || !secrets.agentApiKey || !progress.registeredBeamId) return
    const kit = buildRecoveryKit({
      beamId: progress.registeredBeamId,
      directoryUrl: directoryApiBase(),
      identity: secrets.identity,
      apiKey: secrets.agentApiKey,
    })
    downloadJson(recoveryKitFileName(kit.beamId), kit)
    setSecrets({ kitSaved: true })
  }

  if (registered) {
    return (
      <div data-testid="step-individual-agent" className="flex flex-col gap-4">
        <div className="beam-surface flex flex-col gap-3 rounded-2xl border p-5 sm:p-6">
          <CopyField label={agentCopy.address} value={progress.registeredBeamId} />
          {progress.mandateJti ? <Notice tone="success">{agentCopy.confirmed(mandateWords)}</Notice> : null}
        </div>
        {secrets.identity && secrets.agentApiKey ? (
          <SaveFileBox
            title={agentCopy.kitTitle}
            text={agentCopy.kitText}
            buttonLabel={agentCopy.downloadFile}
            buttonId="download-individual-agent"
            emphasis="outline"
            onSave={saveKit}
            saved={secrets.kitSaved}
            savedLabel={agentCopy.downloadStarted}
          />
        ) : (
          <Notice tone="warning" title={agentCopy.keysGoneTitle}>
            {agentCopy.keysGoneBefore} <a className="underline underline-offset-4" href="/network">/network</a>{agentCopy.keysGoneAfter}
          </Notice>
        )}
        {!progress.mandateJti ? (
          <div className="flex flex-col gap-2">
            {mandateError ? <Notice tone="error">{mandateError}</Notice> : null}
            <div>
              <Button type="button" variant="outline" className="h-10 rounded-full px-5" disabled={pending !== null || !secrets.personIdentity} onClick={() => void onRetryMandate()}>
                {pending === 'mandate' ? <Spinner label={agentCopy.confirming} /> : agentCopy.confirm}
              </Button>
            </div>
          </div>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Collapsible id="individual-agent-advanced" title={t.onboarding.advanced}>
          <p className="leading-6 text-muted-foreground">{agentCopy.technicalKeys}</p>
          <p className="leading-6 text-muted-foreground">{agentCopy.technicalMandate}</p>
        </Collapsible>
      </div>
    )
  }

  return (
    <form data-testid="step-individual-agent" onSubmit={onRegister} className="beam-surface flex flex-col gap-4 rounded-2xl border p-5 sm:p-6" noValidate>
      <p className="text-sm leading-6 text-muted-foreground">{copy.agentHint}</p>
      <TextField
        id="individual-agent-name"
        label={agentCopy.agentName}
        value={progress.agentName}
        onChange={(agentName) => update({ agentName })}
        suffix="@beam.directory"
        placeholder={agentCopy.agentPlaceholder}
        autoComplete="off"
        maxLength={63}
        error={nameError === 'agentNameRequired' || nameError === 'agentNameInvalid' ? t.validation[nameError] : null}
      />
      <Collapsible id="individual-agent-advanced" title={t.onboarding.advanced}>
        <TextField
          id="individual-agent-display"
          label={agentCopy.technicalDisplayName}
          value={progress.agentDisplayName}
          onChange={(agentDisplayName) => update({ agentDisplayName })}
          description={agentCopy.technicalDisplayHelp(progress.agentName || agentCopy.agentPlaceholder)}
          autoComplete="off"
        />
        <div className="flex flex-col gap-2">
          <p className="font-medium text-foreground">{agentCopy.mayTitle}</p>
          <ScopeFields idPrefix="individual-mandate" value={mandate} onChange={setMandate} />
        </div>
        <p className="leading-6 text-muted-foreground">{agentCopy.technicalKeys}</p>
      </Collapsible>
      {nameError === 'nameRequired' || nameError === 'nameTooLong' ? <p className="text-sm text-destructive">{t.validation[nameError]}</p> : null}
      {mandateError ? <Notice tone="error">{mandateError}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div>
        <Button id="register-individual-agent" type="submit" className="h-10 rounded-full px-5" disabled={pending !== null || !secrets.personApiKey}>
          {pending ? <Spinner label={copy.registering} /> : copy.register}
        </Button>
      </div>
    </form>
  )
}
