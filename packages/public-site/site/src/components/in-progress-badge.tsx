import { CircleDashedIcon } from 'lucide-react'
import { cn } from 'cn'
import { useI18n } from '@/i18n/context'

/** Marks a capability that is planned but not live yet. Same look as "Coming soon" in the onboarding. */
export function InProgressBadge({ className, label }: { className?: string; label?: string }) {
  const { t } = useI18n()
  return (
    <span className={cn('inline-flex w-fit shrink-0 items-center gap-1 rounded-full border border-dashed border-muted-foreground/40 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-muted-foreground', className)}>
      <CircleDashedIcon aria-hidden="true" className="size-3" />
      {label ?? t.common.inProgress}
    </span>
  )
}
