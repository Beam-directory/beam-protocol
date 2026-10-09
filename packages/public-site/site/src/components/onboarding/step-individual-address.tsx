import { useState, type FormEvent } from 'react'
import { Notice, SaveFileBox, Spinner, TextField, downloadJson } from '@/components/onboarding/primitives'
import { Button } from '@/components/ui/button'
import type { StepProps } from '@/components/onboarding/types'
import { useI18n } from '@/i18n/context'
import { generateSigningIdentity } from '@/lib/agent-keys'
import { createIndividual, describeError } from '@/lib/onboarding-api'
import {
  personalBeamId,
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
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<ValidationKey | null>(null)
  const reserved = Boolean(progress.personId)

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const handle = progress.personalHandle.trim().toLowerCase()
    const invalid = validatePersonalHandle(handle) ?? validateEmail(progress.personEmail)
    setFieldError(invalid)
    if (invalid) return
    setPending(true)
    setError(null)
    try {
      const identity = secrets.personIdentity ?? await generateSigningIdentity()
      const created = await createIndividual({
        email: progress.personEmail.trim(),
        handle,
        displayName: handle,
        publicKey: identity.publicKey,
      })
      setSecrets({ personIdentity: identity, personApiKey: created.apiKey, personKeySaved: false })
      update({
        personId: created.personId,
        personalHandle: handle,
        personDisplayName: handle,
        personKycStatus: 'unverified',
        personKycProvider: '',
        personRights: { ...INDIVIDUAL_RIGHTS },
      })
    } catch (createError) {
      setError(describeError(createError, t.errors))
    } finally {
      setPending(false)
    }
  }

  function saveKey() {
    if (!secrets.personIdentity || !secrets.personApiKey || !progress.personId) return
    downloadJson(`beam-person-${progress.personalHandle}.json`, {
      format: 'beam-person-key',
      version: 1,
      personId: progress.personId,
      beamId: personalBeamId(progress.personalHandle),
      org: null,
      publicKey: secrets.personIdentity.publicKey,
      privateKey: secrets.personIdentity.privateKey,
      personApiKey: secrets.personApiKey,
      notice: copy.keyFileNotice,
    })
    setSecrets({ personKeySaved: true })
  }

  if (reserved) {
    return (
      <div data-testid="step-individual-address" className="flex flex-col gap-4">
        <Notice tone="success" title={copy.reservedTitle}>{copy.reservedText(personalBeamId(progress.personalHandle))}</Notice>
        {secrets.personApiKey && secrets.personIdentity ? (
          <SaveFileBox
            title={copy.keyTitle}
            text={copy.keyFileNotice}
            buttonLabel={copy.download}
            buttonId="download-person-key"
            emphasis="outline"
            onSave={saveKey}
            saved={secrets.personKeySaved}
            onSavedChange={(personKeySaved) => setSecrets({ personKeySaved })}
            savedLabel={copy.saved}
          />
        ) : null}
      </div>
    )
  }

  return (
    <form data-testid="step-individual-address" onSubmit={onCreate} className="beam-surface flex flex-col gap-4 rounded-2xl border p-5 sm:p-6" noValidate>
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
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div>
        <Button id="reserve-individual-address" type="submit" className="h-10 rounded-full px-5" disabled={pending}>
          {pending ? <Spinner label={copy.creating} /> : copy.create}
        </Button>
      </div>
    </form>
  )
}
