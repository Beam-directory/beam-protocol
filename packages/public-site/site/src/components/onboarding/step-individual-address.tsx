import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { LiveBadge, Notice, Panel, Spinner, TextField, downloadJson } from '@/components/onboarding/primitives'
import type { StepProps } from '@/components/onboarding/types'
import { useI18n } from '@/i18n/context'
import { generateSigningIdentity } from '@/lib/agent-keys'
import { createIndividual, describeError } from '@/lib/onboarding-api'
import {
  personalBeamId,
  validateDisplayName,
  validateEmail,
  validatePersonalHandle,
  type ScopeDraft,
  type ValidationKey,
} from '@/lib/onboarding-steps'

const INDIVIDUAL_RIGHTS: ScopeDraft = {
  read: true,
  schedule: true,
  files: true,
  order: true,
  orderLimitEur: '100000.00',
}

export function StepIndividualAddress({ progress, update, secrets, setSecrets }: StepProps) {
  const { t } = useI18n()
  const copy = t.onboarding.individual
  const [pending, setPending] = useState<'key' | 'create' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<ValidationKey | null>(null)
  const reserved = Boolean(progress.personId)

  async function onGenerate() {
    setPending('key')
    setError(null)
    try {
      const identity = await generateSigningIdentity()
      setSecrets({ personIdentity: identity, personKeySaved: false })
    } catch (keyError) {
      setError(describeError(keyError, t.errors))
    } finally {
      setPending(null)
    }
  }

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const invalid = validatePersonalHandle(progress.personalHandle)
      ?? validateEmail(progress.personEmail)
      ?? validateDisplayName(progress.personDisplayName)
    setFieldError(invalid)
    if (invalid || !secrets.personIdentity) return
    setPending('create')
    setError(null)
    try {
      const created = await createIndividual({
        email: progress.personEmail.trim(),
        handle: progress.personalHandle.trim().toLowerCase(),
        displayName: progress.personDisplayName.trim(),
        publicKey: secrets.personIdentity.publicKey,
      })
      setSecrets({ personApiKey: created.apiKey, personKeySaved: false })
      update({
        personId: created.personId,
        personalHandle: progress.personalHandle.trim().toLowerCase(),
        personKycStatus: 'unverified',
        personKycProvider: '',
        personRights: { ...INDIVIDUAL_RIGHTS },
      })
    } catch (createError) {
      setError(describeError(createError, t.errors))
    } finally {
      setPending(null)
    }
  }

  function saveKey() {
    if (!secrets.personIdentity || !secrets.personApiKey || !progress.personId) return
    const beamId = personalBeamId(progress.personalHandle)
    downloadJson(`beam-person-${progress.personalHandle}.json`, {
      format: 'beam-person-key',
      version: 1,
      personId: progress.personId,
      beamId,
      org: null,
      publicKey: secrets.personIdentity.publicKey,
      privateKey: secrets.personIdentity.privateKey,
      personApiKey: secrets.personApiKey,
      notice: copy.keyFileNotice,
    })
    setSecrets({ personKeySaved: true })
  }

  return (
    <div data-testid="step-individual-address" className="flex flex-col gap-4">
      <Panel title={copy.addressPanel} badge={reserved ? <LiveBadge /> : undefined}>
        {reserved ? (
          <Notice tone="success" title={copy.reservedTitle}>{copy.reservedText(personalBeamId(progress.personalHandle))}</Notice>
        ) : (
          <form onSubmit={onCreate} className="flex flex-col gap-4" noValidate>
            <TextField
              id="individual-handle"
              label={copy.handleLabel}
              value={progress.personalHandle}
              onChange={(personalHandle) => update({ personalHandle })}
              suffix="@beam.directory"
              autoComplete="off"
              maxLength={32}
              error={fieldError === 'handleRequired' || fieldError === 'handleInvalid' ? t.validation[fieldError] : null}
            />
            <TextField
              id="individual-email"
              label={copy.emailLabel}
              type="email"
              inputMode="email"
              autoComplete="email"
              value={progress.personEmail}
              onChange={(personEmail) => update({ personEmail })}
              error={fieldError === 'emailInvalid' ? t.validation.emailInvalid : null}
            />
            <TextField
              id="individual-name"
              label={copy.nameLabel}
              value={progress.personDisplayName}
              onChange={(personDisplayName) => update({ personDisplayName })}
              autoComplete="name"
              maxLength={80}
              error={fieldError === 'nameRequired' || fieldError === 'nameTooLong' ? t.validation[fieldError] : null}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" className="h-10 rounded-full" onClick={() => void onGenerate()} disabled={pending !== null}>
                {pending === 'key' ? <Spinner label={copy.generating} /> : copy.generateKey}
              </Button>
              <Button type="submit" className="h-10 rounded-full" disabled={pending !== null || !secrets.personIdentity}>
                {pending === 'create' ? <Spinner label={copy.creating} /> : copy.create}
              </Button>
            </div>
          </form>
        )}
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      </Panel>
      {reserved && secrets.personApiKey ? (
        <Panel title={copy.keyTitle}>
          <p className="text-sm leading-6 text-muted-foreground">{copy.keyFileNotice}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" className="h-10 rounded-full" onClick={saveKey}>{copy.download}</Button>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[var(--beam)]" checked={secrets.personKeySaved} onChange={(event) => setSecrets({ personKeySaved: event.target.checked })} />
              {copy.saved}
            </label>
          </div>
        </Panel>
      ) : null}
    </div>
  )
}
