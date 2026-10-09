import { useState, type FormEvent } from 'react'
import { RefreshCwIcon, UserIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ComingSoonCard } from '@/components/onboarding/coming-soon'
import { Collapsible, CopyField, Notice, SaveFileBox, Spinner, StatusBadge, TextField, downloadJson } from '@/components/onboarding/primitives'
import { ScopeFields } from '@/components/onboarding/scope-fields'
import type { StepProps } from '@/components/onboarding/types'
import { useI18n } from '@/i18n/context'
import { generateSigningIdentity, importSigningIdentity } from '@/lib/agent-keys'
import { createPerson, describeError, getKycStatus, inviteEmployee, requestManualKyc, acceptInvitation, type PersonRecord } from '@/lib/onboarding-api'
import {
  EMPTY_SCOPE,
  scopeGrantFromDraft,
  validateDisplayName,
  validateEmail,
  validateRole,
  type KycStatus,
  type ScopeDraft,
  type ValidationKey,
} from '@/lib/onboarding-steps'

function kycTone(status: string): 'success' | 'pending' | 'neutral' {
  if (status === 'verified') return 'success'
  if (status === 'pending' || status === 'rejected') return 'pending'
  return 'neutral'
}

function kycStatusOf(person: Pick<PersonRecord, 'kycStatus'>, fallback: KycStatus | ''): KycStatus | '' {
  const status = person.kycStatus
  return status === 'pending' || status === 'verified' || status === 'rejected' || status === 'unverified' ? status : fallback
}

export function StepPerson({ progress, update, secrets, setSecrets }: StepProps) {
  const { t } = useI18n()
  const copy = t.onboarding.person
  const [pending, setPending] = useState<'create' | 'kyc' | 'refresh' | 'invite' | 'accept' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<{ name?: ValidationKey | null; email?: ValidationKey | null; other?: ValidationKey | null }>({})
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('')
  const [inviteRights, setInviteRights] = useState<ScopeDraft>({ ...EMPTY_SCOPE, files: false })
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [acceptToken, setAcceptToken] = useState('')
  const [acceptName, setAcceptName] = useState('')
  const [acceptError, setAcceptError] = useState<string | null>(null)
  const [acceptedId, setAcceptedId] = useState('')

  const ready = progress.orgVerified && Boolean(secrets.orgApiKey)
  const created = Boolean(progress.personId)
  const kyc = progress.personKycStatus || 'unverified'
  const kycLabel = copy.kycStates[kyc as KycStatus] ?? kyc
  const kycText = {
    unverified: copy.reviewMissingText,
    pending: copy.reviewPendingText,
    verified: copy.reviewDoneText,
    rejected: copy.reviewRejectedText,
  }[kyc as KycStatus] ?? copy.reviewMissingText

  async function requestReview(personId: string) {
    if (!secrets.orgApiKey) return
    setPending('kyc')
    setError(null)
    try {
      const person = await requestManualKyc(progress.orgName, secrets.orgApiKey, personId)
      update({ personKycStatus: kycStatusOf(person, 'pending'), personKycProvider: person.kycProvider ?? 'manual' })
    } catch (kycError) {
      setError(describeError(kycError, t.errors))
    } finally {
      setPending(null)
    }
  }

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const role = progress.personRole.trim() || copy.roleDefault
    const rights = scopeGrantFromDraft(progress.personRights)
    const errors = {
      name: validateDisplayName(progress.personDisplayName),
      email: validateEmail(progress.personEmail),
      other: validateRole(role) ?? ('error' in rights ? rights.error : null),
    }
    setFieldErrors(errors)
    if (errors.name || errors.email || errors.other || !secrets.orgApiKey || !('grant' in rights)) return
    setPending('create')
    setError(null)
    let personId = ''
    try {
      const identity = secrets.personIdentity ?? await generateSigningIdentity()
      if (!secrets.personIdentity) setSecrets({ personIdentity: identity, personKeySaved: false })
      const person = await createPerson(progress.orgName, secrets.orgApiKey, {
        email: progress.personEmail,
        displayName: progress.personDisplayName,
        role,
        publicKey: identity.publicKey,
        rights: rights.grant,
      })
      personId = person.id
      update({
        personId: person.id,
        personRole: role,
        personKycStatus: kycStatusOf(person, 'unverified'),
        personKycProvider: person.kycProvider ?? '',
      })
      if (person.kycStatus === 'pending' || person.kycStatus === 'verified') personId = ''
    } catch (createError) {
      setError(describeError(createError, t.errors))
    } finally {
      setPending(null)
    }
    if (personId) await requestReview(personId)
  }

  function savePersonKey() {
    if (!secrets.personIdentity || !progress.personId) return
    downloadJson(`beam-person-${progress.personId}.json`, {
      format: 'beam-person-key',
      version: 1,
      personId: progress.personId,
      org: progress.orgName,
      publicKey: secrets.personIdentity.publicKey,
      privateKey: secrets.personIdentity.privateKey,
      notice: copy.keyFileNotice,
    })
    setSecrets({ personKeySaved: true })
  }

  async function onLoadKey(file: File) {
    setError(null)
    try {
      const parsed = JSON.parse(await file.text()) as { format?: string; publicKey?: string; privateKey?: string; personId?: string }
      if (parsed.format !== 'beam-person-key' || !parsed.publicKey || !parsed.privateKey) {
        setError(copy.keyFileInvalid)
        return
      }
      const identity = await importSigningIdentity(parsed.publicKey, parsed.privateKey)
      setSecrets({ personIdentity: identity, personKeySaved: true })
    } catch (loadError) {
      setError(describeError(loadError, t.errors))
    }
  }

  async function onRefreshKyc() {
    if (!secrets.orgApiKey || !progress.personId) return
    setPending('refresh')
    setError(null)
    try {
      const person = await getKycStatus(progress.orgName, secrets.orgApiKey, progress.personId)
      if (!person) {
        setError(t.errors.codes.NOT_FOUND ?? t.errors.generic)
        return
      }
      update({ personKycStatus: kycStatusOf(person, ''), personKycProvider: person.kycProvider ?? '' })
    } catch (refreshError) {
      setError(describeError(refreshError, t.errors))
    } finally {
      setPending(null)
    }
  }

  async function onInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const rights = scopeGrantFromDraft(inviteRights)
    const invalid = validateEmail(inviteEmail) ?? validateRole(inviteRole) ?? ('error' in rights ? rights.error : null)
    if (invalid || !secrets.orgApiKey || !('grant' in rights)) {
      setInviteError(invalid ? t.validation[invalid] : null)
      return
    }
    setPending('invite')
    setInviteError(null)
    try {
      const invitation = await inviteEmployee(progress.orgName, secrets.orgApiKey, {
        email: inviteEmail,
        role: inviteRole,
        rights: rights.grant,
        supervisorPersonId: progress.personId || null,
      })
      setSecrets({ invitationToken: invitation.token })
    } catch (inviteFailure) {
      setInviteError(describeError(inviteFailure, t.errors))
    } finally {
      setPending(null)
    }
  }

  async function onAccept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const invalid = validateDisplayName(acceptName)
    if (invalid || !acceptToken.trim()) {
      setAcceptError(invalid ? t.validation[invalid] : copy.tokenRequired)
      return
    }
    setPending('accept')
    setAcceptError(null)
    try {
      const identity = await generateSigningIdentity()
      const person = await acceptInvitation({ token: acceptToken.trim(), displayName: acceptName.trim(), publicKey: identity.publicKey })
      downloadJson(`beam-person-${person.id}.json`, {
        format: 'beam-person-key',
        version: 1,
        personId: person.id,
        org: person.org,
        publicKey: identity.publicKey,
        privateKey: identity.privateKey,
        notice: copy.keyFileNotice,
      })
      setAcceptedId(person.id)
      setAcceptToken('')
    } catch (acceptFailure) {
      setAcceptError(describeError(acceptFailure, t.errors))
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {!ready && !created ? <Notice tone="warning" title={copy.orgFirstTitle}>{copy.orgFirstText}</Notice> : null}

      {created ? (
        <>
          <div className="beam-surface flex flex-col gap-4 rounded-2xl border p-5 sm:p-6">
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
                <UserIcon aria-hidden="true" className="size-4" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col text-sm leading-6">
                <p className="font-medium text-foreground">{progress.personDisplayName}</p>
                <p className="text-muted-foreground">{progress.personEmail} · {progress.personRole}</p>
              </div>
              <StatusBadge tone={kycTone(kyc)}>{kycLabel}</StatusBadge>
            </div>
            <p className="text-sm leading-6 text-muted-foreground">{kycText}</p>
            {error ? <Notice tone="error">{error}</Notice> : null}
            <div className="flex flex-wrap gap-2">
              {kyc === 'unverified' ? (
                <Button id="request-kyc" type="button" variant="outline" className="h-9 rounded-full px-4" disabled={!secrets.orgApiKey || pending !== null} onClick={() => void requestReview(progress.personId)}>
                  {pending === 'kyc' ? <Spinner label={copy.requesting} /> : copy.requestReview}
                </Button>
              ) : null}
              {kyc !== 'verified' ? (
                <Button id="refresh-kyc" type="button" variant="ghost" className="h-9 rounded-full px-4" disabled={!secrets.orgApiKey || pending !== null} onClick={() => void onRefreshKyc()}>
                  {pending === 'refresh' ? <Spinner label={copy.refreshing} /> : <><RefreshCwIcon aria-hidden="true" /> {copy.refresh}</>}
                </Button>
              ) : null}
            </div>
          </div>

          {secrets.personIdentity ? (
            <SaveFileBox
              title={copy.keyBoxTitle}
              text={copy.keyBoxText}
              buttonLabel={copy.downloadKey}
              buttonId="download-person-key"
              onSave={savePersonKey}
              saved={secrets.personKeySaved}
              onSavedChange={(personKeySaved) => setSecrets({ personKeySaved })}
              savedLabel={copy.keySaved}
            />
          ) : (
            <div className="flex flex-col gap-2">
              <Notice tone="warning" title={copy.keysGoneTitle}>{copy.keysGoneText}</Notice>
              <label className="text-sm font-medium" htmlFor="person-key-file">{copy.loadKey}</label>
              <input
                id="person-key-file"
                type="file"
                accept="application/json,.json"
                className="text-sm"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void onLoadKey(file)
                }}
              />
            </div>
          )}
        </>
      ) : (
        <form onSubmit={onCreate} className="beam-surface flex flex-col gap-4 rounded-2xl border p-5 sm:p-6" noValidate>
          <TextField
            id="person-name"
            label={copy.displayName}
            autoComplete="name"
            value={progress.personDisplayName}
            onChange={(personDisplayName) => update({ personDisplayName })}
            error={fieldErrors.name ? t.validation[fieldErrors.name] : null}
          />
          <TextField
            id="person-email"
            label={copy.email}
            type="email"
            inputMode="email"
            autoComplete="email"
            value={progress.personEmail}
            onChange={(personEmail) => update({ personEmail })}
            error={fieldErrors.email ? t.validation[fieldErrors.email] : null}
          />
          <Collapsible id="person-advanced" title={t.onboarding.advanced}>
            <TextField
              id="person-role"
              label={copy.role}
              value={progress.personRole}
              onChange={(personRole) => update({ personRole })}
              placeholder={copy.roleDefault}
              description={copy.roleHelp}
            />
            <div className="flex flex-col gap-2">
              <p className="font-medium">{copy.rightsTitle}</p>
              <p className="text-xs leading-5 text-muted-foreground">{copy.rightsText}</p>
              <ScopeFields idPrefix="person-rights" value={progress.personRights} onChange={(personRights) => update({ personRights })} />
            </div>
          </Collapsible>
          {fieldErrors.other ? <p className="text-xs text-destructive">{t.validation[fieldErrors.other]}</p> : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div>
            <Button id="create-person" type="submit" className="h-10 rounded-full px-5" disabled={!ready || pending !== null}>
              {pending === 'create' || pending === 'kyc' ? <Spinner label={copy.saving} /> : copy.create}
            </Button>
          </div>
        </form>
      )}

      {created ? (
        <Collapsible id="person-advanced" title={t.onboarding.advanced}>
          {secrets.personIdentity ? <CopyField label={copy.technicalPublicKey} value={secrets.personIdentity.publicKey} /> : null}
          <CopyField label={copy.technicalPersonId} value={progress.personId} />
          <p className="leading-6 text-muted-foreground">{copy.technicalReview}</p>

          <div className="flex flex-col gap-3 border-t pt-4">
            <p className="font-medium text-foreground">{copy.inviteTitle}</p>
            <p className="leading-6 text-muted-foreground">{copy.inviteText}</p>
            {secrets.invitationToken ? (
              <div className="flex flex-col gap-2">
                <Notice tone="warning" title={copy.tokenOnce}>{copy.tokenText}</Notice>
                <CopyField label={copy.token} value={secrets.invitationToken} secret />
              </div>
            ) : (
              <form onSubmit={onInvite} className="flex flex-col gap-4" noValidate>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField id="invite-email" label={copy.email} type="email" inputMode="email" value={inviteEmail} onChange={setInviteEmail} autoComplete="off" />
                  <TextField id="invite-role" label={copy.role} value={inviteRole} onChange={setInviteRole} />
                </div>
                <ScopeFields idPrefix="invite-rights" value={inviteRights} onChange={setInviteRights} />
                <p className="text-xs text-muted-foreground">{copy.supervisorNote}</p>
                {inviteError ? <Notice tone="error">{inviteError}</Notice> : null}
                <div>
                  <Button id="invite-person" type="submit" variant="outline" className="h-9 rounded-full px-4" disabled={!secrets.orgApiKey || pending !== null}>
                    {pending === 'invite' ? <Spinner label={copy.inviting} /> : copy.invite}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </Collapsible>
      ) : null}

      <Collapsible title={copy.acceptTitle}>
        <form onSubmit={onAccept} className="flex flex-col gap-3" noValidate>
          <p className="text-xs leading-5 text-muted-foreground">{copy.acceptText}</p>
          <TextField id="accept-token" label={copy.token} value={acceptToken} onChange={setAcceptToken} autoComplete="off" />
          <TextField id="accept-name" label={copy.displayName} value={acceptName} onChange={setAcceptName} autoComplete="name" />
          {acceptedId ? <Notice tone="success" title={copy.acceptedTitle}>{copy.acceptedText} <span className="font-mono text-foreground">{acceptedId}</span></Notice> : null}
          {acceptError ? <Notice tone="error">{acceptError}</Notice> : null}
          <div>
            <Button id="accept-invitation" type="submit" variant="outline" className="h-9 rounded-full px-4" disabled={pending !== null}>
              {pending === 'accept' ? <Spinner label={copy.accepting} /> : copy.accept}
            </Button>
          </div>
        </form>
      </Collapsible>

      <Collapsible title={t.onboarding.notYet}>
        <ComingSoonCard capability="thirdPartyKyc" title={copy.kycTitle} company={progress.displayName}>
          {copy.kycText}
        </ComingSoonCard>
        <ComingSoonCard capability="syncEmployeeDirectory" title={copy.syncTitle} company={progress.displayName}>
          {copy.syncText}
        </ComingSoonCard>
      </Collapsible>
    </div>
  )
}
