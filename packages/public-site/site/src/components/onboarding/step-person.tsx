import { ArrowUpRightIcon, UserIcon } from 'lucide-react'
import { ComingSoonCard } from '@/components/onboarding/coming-soon'
import { Panel, StatusBadge } from '@/components/onboarding/primitives'
import type { StepProps } from '@/components/onboarding/types'

const DASHBOARD_URL = 'https://dashboard.beam.directory'

export function StepPerson({ progress }: Pick<StepProps, 'progress'>) {
  return (
    <div className="flex flex-col gap-5">
      <Panel title="Kontoinhaber" badge={<StatusBadge tone="neutral">Person nicht geprüft</StatusBadge>}>
        <div className="flex gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
            <UserIcon aria-hidden="true" className="size-4" />
          </span>
          <div className="flex flex-col gap-2 text-sm leading-6 text-muted-foreground">
            <p>
              Heute weist dich der Org-Schlüssel aus Schritt 1 als Inhaber des Namensraums
              {progress.orgName ? <> <span className="font-mono text-foreground">{progress.orgName}</span></> : null} aus.
              Er ersetzt keine Identitätsprüfung der Person.
            </p>
            <p>
              Sobald die Ausweisprüfung bereitsteht, wird sie einmal für dich gemacht. Deine Agenten erben das Vertrauen; es gibt keine Prüfung pro Agent.
            </p>
          </div>
        </div>
      </Panel>

      <ComingSoonCard capability="startKyc" title="Identität mit Ausweisdokument" company={progress.displayName}>
        Einmalige Prüfung der Person mit Ausweis. Es gibt noch keinen Anbieter und keinen Prüfablauf; hier wird nichts hochgeladen.
      </ComingSoonCard>

      <div className="grid gap-4 md:grid-cols-2">
        <ComingSoonCard capability="inviteEmployee" title="Mitarbeitende einladen" company={progress.displayName}>
          Mitarbeitende bekommen eine Einladung und stellen ihre eigenen Agenten aus.{' '}
          Einladungen in Workspaces gibt es bereits im{' '}
          <a href={DASHBOARD_URL} className="inline-flex items-center gap-0.5 text-foreground underline underline-offset-4">
            Dashboard<ArrowUpRightIcon aria-hidden="true" className="size-3" />
          </a>
          ; mit der Firmenprüfung und Vollmachten sind sie noch nicht verbunden.
        </ComingSoonCard>
        <ComingSoonCard capability="syncEmployeeDirectory" title="Personio oder Microsoft Entra" company={progress.displayName}>
          Mitarbeitende und Hierarchie automatisch übernehmen. Wer das Unternehmen verlässt, verliert dann sofort die Rechte seiner Agenten.
        </ComingSoonCard>
      </div>

      <p className="text-xs leading-5 text-muted-foreground">
        Du kannst ohne Personenprüfung weitermachen. Dein Agent gehört dann zu einer Firma mit bestätigter Domain, nicht zu einer geprüften Person.
      </p>
    </div>
  )
}
