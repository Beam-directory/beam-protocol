import { useState, type FormEvent } from 'react'
import { DownloadIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Notice, Panel, Spinner, TextField, downloadJson } from '@/components/onboarding/primitives'
import { ScopeFields } from '@/components/onboarding/scope-fields'
import type { StepProps } from '@/components/onboarding/types'
import { useI18n } from '@/i18n/context'
import { buildRecoveryKit, generateAgentIdentity, recoveryKitFileName } from '@/lib/agent-keys'
import { directoryApiBase } from '@/lib/directory-client'
import {
  describeError,
  getTrustAssertion,
  issueMandate,
  publishEncryptionKey,
  registerIndividualAgent,
  type TrustAssertionView,
} from '@/lib/onboarding-api'
import {
  MANDATE_TTL_MS,
  mandatePayload,
  normalizeAgentName,
  personalBeamId,
  scopeGrantFromDraft,
  scopeWithin,
  validateAgentName,
  validateDisplayName,
  type ScopeDraft,
  type ValidationKey,
} from '@/lib/onboarding-steps'

function createJti(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  let value = ''
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0')
  return `m${value}`
}

export function StepIndividualAgent({ progress, update, secrets, setSecrets }: StepProps) {
  const { t } = useI18n()
  const copy = t.onboarding.individual
  const [pending, setPending] = useState<'keys' | 'register' | 'mandate' | 'assertion' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nameError, setNameError] = useState<ValidationKey | null>(null)
  const [mandate, setMandate] = useState<ScopeDraft>({ read: true, schedule: false, files: false, order: false, orderLimitEur: '' })
  const [mandateError, setMandateError] = useState<string | null>(null)
  const [assertion, setAssertion] = useState<TrustAssertionView | null>(null)
  const registered = Boolean(progress.registeredBeamId)
  const previewId = registered
    ? progress.registeredBeamId
    : `${normalizeAgentName(progress.agentName) || 'name'}@beam.directory`

  async function onGenerate() {
    setPending('keys')
    setError(null)
    try {
      const identity = await generateAgentIdentity()
      setSecrets({ identity, kitSaved: false })
    } catch (keyError) {
      setError(describeError(keyError, t.errors))
    } finally {
      setPending(null)
    }
  }

  async function onRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const invalidName = validateAgentName(progress.agentName)
    const sameHandle = normalizeAgentName(progress.agentName) === progress.personalHandle.trim().toLowerCase()
    const invalidDisplay = validateDisplayName(progress.agentDisplayName)
    setNameError(invalidName ?? (sameHandle ? 'agentNameInvalid' : null) ?? invalidDisplay)
    if (invalidName || sameHandle || invalidDisplay || !secrets.identity || !secrets.personApiKey) return
    setPending('register')
    setError(null)
    try {
      const agent = await registerIndividualAgent({
        agentName: normalizeAgentName(progress.agentName),
        displayName: progress.agentDisplayName.trim(),
        publicKey: secrets.identity.publicKey,
        personApiKey: secrets.personApiKey,
      })
      setSecrets({ agentApiKey: agent.apiKey, kitSaved: false })
      update({ registeredBeamId: agent.beamId })
      await publishEncryptionKey({
        beamId: agent.beamId,
        dhPublicKey: secrets.identity.encryption.publicKey,
        signingKey: secrets.identity.signingKey,
      })
      update({ encryptionKeyPublished: true, registeredBeamId: agent.beamId })
    } catch (registerError) {
      setError(describeError(registerError, t.errors))
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

  async function onIssueMandate() {
    const parsed = scopeGrantFromDraft(mandate)
    const rights = scopeGrantFromDraft(progress.personRights)
    if ('error' in parsed) {
      setMandateError(t.validation[parsed.error])
      return
    }
    if ('error' in rights || !scopeWithin(parsed.grant, rights.grant)) {
      setMandateError(t.validation.scopeExceedsRights)
      return
    }
    if (!secrets.personIdentity || !progress.personId || !progress.registeredBeamId) return
    setPending('mandate')
    setMandateError(null)
    try {
      const expiresAt = new Date(Date.now() + MANDATE_TTL_MS).toISOString()
      const payload = mandatePayload({
        jti: createJti(),
        personId: progress.personId,
        agentBeamId: progress.registeredBeamId,
        org: null,
        scopes: parsed.grant,
        expiresAt,
      })
      const issued = await issueMandate({
        beamId: progress.registeredBeamId,
        payload,
        signingKey: secrets.personIdentity.signingKey,
      })
      update({ mandateJti: issued.jti, mandateStatus: issued.status })
    } catch (mandateFailure) {
      setMandateError(describeError(mandateFailure, t.errors))
    } finally {
      setPending(null)
    }
  }

  async function onAssertion() {
    if (!progress.registeredBeamId || !secrets.personApiKey) return
    setPending('assertion')
    setError(null)
    try {
      setAssertion(await getTrustAssertion(progress.registeredBeamId, secrets.personApiKey))
    } catch (readError) {
      setError(describeError(readError, t.errors))
    } finally {
      setPending(null)
    }
  }

  return (
    <div data-testid="step-individual-agent" className="flex flex-col gap-4">
      <Panel title={copy.agentPanel}>
        <p className="text-sm leading-6 text-muted-foreground">{copy.agentHint}</p>
        <p className="font-mono text-sm">{personalBeamId(progress.personalHandle || 'name')} · {previewId}</p>
        {registered ? (
          <Notice tone="success" title={progress.registeredBeamId}>{copy.assertionIndividual}</Notice>
        ) : (
          <form onSubmit={onRegister} className="flex flex-col gap-4" noValidate>
            <TextField
              id="individual-agent-name"
              label={t.onboarding.agent.addressPanel}
              value={progress.agentName}
              onChange={(agentName) => update({ agentName })}
              suffix="@beam.directory"
              autoComplete="off"
              error={nameError === 'agentNameRequired' || nameError === 'agentNameInvalid' ? t.validation[nameError] : null}
            />
            <TextField
              id="individual-agent-display"
              label={t.onboarding.agent.displayName}
              value={progress.agentDisplayName}
              onChange={(agentDisplayName) => update({ agentDisplayName })}
              error={nameError === 'nameRequired' || nameError === 'nameTooLong' ? t.validation[nameError] : null}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" className="h-10 rounded-full" onClick={() => void onGenerate()} disabled={pending !== null}>
                {pending === 'keys' ? <Spinner label={copy.generating} /> : copy.generateKey}
              </Button>
              <Button type="submit" className="h-10 rounded-full" disabled={pending !== null || !secrets.identity || !secrets.personApiKey}>
                {pending === 'register' ? <Spinner label={copy.registering} /> : copy.register}
              </Button>
            </div>
          </form>
        )}
        {registered && secrets.agentApiKey ? (
          <Button type="button" variant="outline" className="h-10 w-fit rounded-full" onClick={saveKit}>
            <DownloadIcon aria-hidden="true" /> {copy.download}
          </Button>
        ) : null}
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      </Panel>
      {registered ? (
        <Panel title={copy.mandate}>
          <ScopeFields idPrefix="individual-mandate" value={mandate} onChange={setMandate} />
          {mandateError ? <p className="text-sm text-destructive" role="alert">{mandateError}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" className="h-10 rounded-full" onClick={() => void onIssueMandate()} disabled={pending !== null || !secrets.personIdentity}>
              {pending === 'mandate' ? <Spinner label={copy.signing} /> : copy.mandate}
            </Button>
            <Button type="button" variant="outline" className="h-10 rounded-full" onClick={() => void onAssertion()} disabled={pending !== null}>
              {pending === 'assertion' ? <Spinner label={copy.checking} /> : copy.assertion}
            </Button>
          </div>
          {assertion ? (
            <p className="text-sm" data-testid="individual-assertion">
              {assertion.personSubject === 'individual' ? copy.assertionIndividual : assertion.orgName}
              {assertion.personLevel ? ` · ${assertion.personLevel}` : ''}
            </p>
          ) : null}
        </Panel>
      ) : null}
    </div>
  )
}
