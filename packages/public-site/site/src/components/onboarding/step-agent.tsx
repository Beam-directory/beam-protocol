import { useState, type FormEvent } from 'react'
import { DownloadIcon, KeyRoundIcon, LockIcon, ShieldCheckIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CopyField, LiveBadge, Notice, Panel, Spinner, StatusBadge, TextField, downloadJson } from '@/components/onboarding/primitives'
import { ScopeFields } from '@/components/onboarding/scope-fields'
import type { StepProps } from '@/components/onboarding/types'
import { useI18n } from '@/i18n/context'
import { buildRecoveryKit, generateAgentIdentity, recoveryKitFileName } from '@/lib/agent-keys'
import { directoryApiBase } from '@/lib/directory-client'
import { describeError, getTrustAssertion, issueMandate, publishEncryptionKey, registerAgent, type TrustAssertionView } from '@/lib/onboarding-api'
import {
  MANDATE_TTL_MS,
  buildBeamId,
  mandatePayload,
  normalizeAgentName,
  scopeGrantFromDraft,
  scopeWithin,
  validateAgentName,
  validateDisplayName,
  type ScopeDraft,
  type ValidationKey,
} from '@/lib/onboarding-steps'
import { fingerprintPublicKey } from '@/lib/public-agent'

function createJti(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  let value = ''
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0')
  return `m${value}`
}

export function StepAgent({ progress, update, secrets, setSecrets }: StepProps) {
  const { t } = useI18n()
  const copy = t.onboarding.agent
  const [pending, setPending] = useState<'keys' | 'register' | 'encrypt' | 'mandate' | 'assertion' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nameError, setNameError] = useState<ValidationKey | null>(null)
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [mandate, setMandate] = useState<ScopeDraft>(progress.personRights)
  const [mandateError, setMandateError] = useState<string | null>(null)
  const [assertion, setAssertion] = useState<TrustAssertionView | null>(null)

  const registered = Boolean(progress.registeredBeamId)
  const beamId = registered ? progress.registeredBeamId : buildBeamId(progress.agentName || 'name', progress.orgName || 'company')
  const canRegister = progress.orgVerified && Boolean(secrets.orgApiKey) && Boolean(secrets.identity) && Boolean(progress.personId)
  const kycVerified = progress.personKycStatus === 'verified'

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
    if (invalidName || invalidDisplay || !secrets.identity || !secrets.orgApiKey || !progress.personId) return
    setPending('register')
    setError(null)
    try {
      const agent = await registerAgent({
        orgName: progress.orgName,
        agentName: normalizeAgentName(progress.agentName),
        displayName: progress.agentDisplayName.trim(),
        publicKey: secrets.identity.publicKey,
        responsiblePersonId: progress.personId,
      }, secrets.orgApiKey)
      setSecrets({ agentApiKey: agent.apiKey, kitSaved: false })
      update({ registeredBeamId: agent.beamId, orgName: agent.org || progress.orgName })
      setPending('encrypt')
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
    if (!secrets.identity || !secrets.agentApiKey) return
    const kit = buildRecoveryKit({ beamId: progress.registeredBeamId, directoryUrl: directoryApiBase(), identity: secrets.identity, apiKey: secrets.agentApiKey })
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
        org: progress.orgName,
        scopes: parsed.grant,
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
          {progress.encryptionKeyPublished ? <p className="text-xs text-muted-foreground">{copy.encryptionPublished}</p> : null}
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
          {error ? <Notice tone="error">{error}</Notice> : null}
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
                <Button id="generate-agent-key" type="button" variant="outline" className="h-10 rounded-full px-5" onClick={() => void onGenerate()} disabled={pending !== null}>
                  {pending === 'keys' ? <Spinner label={copy.generating} /> : <><KeyRoundIcon aria-hidden="true" /> {copy.generate}</>}
                </Button>
              </div>
            )}
          </Panel>

          {!progress.orgVerified || !secrets.orgApiKey ? (
            <Notice tone="warning" title={copy.orgFirstTitle}>{copy.orgFirstText}</Notice>
          ) : null}
          {!progress.personId ? <Notice tone="warning" title={copy.personFirstTitle}>{copy.personFirstText}</Notice> : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div>
            <Button id="register-agent" type="submit" className="h-10 rounded-full px-5" disabled={!canRegister || pending !== null}>
              {pending === 'register' || pending === 'encrypt' ? <Spinner label={pending === 'encrypt' ? copy.publishingKey : copy.registering} /> : copy.register}
            </Button>
          </div>
        </form>
      )}

      <Panel title={copy.mandatePanel} badge={progress.mandateJti ? <StatusBadge tone="success">{copy.mandateIssued}</StatusBadge> : <LiveBadge />}>
        <p className="text-sm leading-6 text-muted-foreground">{copy.mandateIntro}</p>
        <p className="text-xs leading-5 text-muted-foreground">{copy.mandateTtl}</p>
        <p className="text-xs leading-5 text-muted-foreground">{copy.escalationNone}</p>
        {progress.mandateJti ? (
          <Notice tone="success" title={copy.mandateIssued}>
            <span className="font-mono text-foreground">{progress.mandateJti}</span> · {progress.mandateStatus || 'active'}
          </Notice>
        ) : (
          <>
            <ScopeFields idPrefix="mandate" value={mandate} onChange={setMandate} />
            {!kycVerified ? <Notice tone="warning" title={copy.kycBlockTitle}>{copy.kycBlockText}</Notice> : null}
            {!secrets.personIdentity ? <p className="text-xs text-muted-foreground">{copy.personKeyMissing}</p> : null}
            {mandateError ? <Notice tone="error">{mandateError}</Notice> : null}
            <div>
              <Button
                id="issue-mandate"
                type="button"
                className="h-10 rounded-full px-5"
                disabled={!registered || !kycVerified || !secrets.personIdentity || pending !== null}
                onClick={() => void onIssueMandate()}
              >
                {pending === 'mandate' || pending === 'assertion' ? <Spinner label={copy.issuing} /> : copy.issue}
              </Button>
            </div>
          </>
        )}
        {assertion ? (
          <div className="rounded-lg border bg-background/60 p-3 text-xs leading-5 text-muted-foreground">
            <p className="font-medium text-foreground">{copy.assertionTitle}</p>
            <p>{copy.assertionOrg}: <span className="font-mono text-foreground">{assertion.orgName}</span> · {assertion.orgVerified ? copy.assertionVerified : copy.assertionUnverified}</p>
            <p>{copy.assertionRegistry}: {assertion.registryStatus}</p>
            <p>{copy.assertionPerson}: {assertion.personRole || '—'} · {copy.assertionKyc}: {assertion.kycStatus || '—'}</p>
            <p>{copy.assertionMandate}: <span className="font-mono text-foreground">{assertion.mandateJti || '—'}</span></p>
            <p>{copy.assertionNote}</p>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">{copy.previewId} <span className="font-mono text-foreground">{beamId}</span></p>
      </Panel>
    </div>
  )
}
