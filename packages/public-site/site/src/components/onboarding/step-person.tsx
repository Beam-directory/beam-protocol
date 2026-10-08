import { ArrowUpRightIcon, UserIcon } from 'lucide-react'
import { ComingSoonCard } from '@/components/onboarding/coming-soon'
import { Panel, StatusBadge } from '@/components/onboarding/primitives'
import type { StepProps } from '@/components/onboarding/types'
import { useI18n } from '@/i18n/context'

const DASHBOARD_URL = 'https://dashboard.beam.directory'

export function StepPerson({ progress }: Pick<StepProps, 'progress'>) {
  const { t } = useI18n()
  const copy = t.onboarding.person
  return (
    <div className="flex flex-col gap-5">
      <Panel title={copy.ownerPanel} badge={<StatusBadge tone="neutral">{copy.notVerified}</StatusBadge>}>
        <div className="flex gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
            <UserIcon aria-hidden="true" className="size-4" />
          </span>
          <div className="flex flex-col gap-2 text-sm leading-6 text-muted-foreground">
            <p>
              {copy.ownerBefore}
              {progress.orgName ? <> <span className="font-mono text-foreground">{progress.orgName}</span></> : null}
              {copy.ownerAfter}
            </p>
            <p>{copy.ownerInherit}</p>
          </div>
        </div>
      </Panel>

      <ComingSoonCard capability="startKyc" title={copy.kycTitle} company={progress.displayName}>
        {copy.kycText}
      </ComingSoonCard>

      <div className="grid gap-4 md:grid-cols-2">
        <ComingSoonCard capability="inviteEmployee" title={copy.inviteTitle} company={progress.displayName}>
          {copy.inviteBefore}{' '}
          <a href={DASHBOARD_URL} className="inline-flex items-center gap-0.5 text-foreground underline underline-offset-4">
            {copy.inviteDashboard}<ArrowUpRightIcon aria-hidden="true" className="size-3" />
          </a>
          {copy.inviteAfter}
        </ComingSoonCard>
        <ComingSoonCard capability="syncEmployeeDirectory" title={copy.syncTitle} company={progress.displayName}>
          {copy.syncText}
        </ComingSoonCard>
      </div>

      <p className="text-xs leading-5 text-muted-foreground">{copy.continueNote}</p>
    </div>
  )
}
