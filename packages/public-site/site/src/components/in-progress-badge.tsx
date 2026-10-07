import { CircleDashedIcon } from 'lucide-react'
import { cn } from 'cn'

/** Marks a capability that is planned but not live yet. Same look as "Bald verfügbar" in the onboarding. */
export function InProgressBadge({ className, label = 'Im Aufbau' }: { className?: string; label?: string }) {
  return (
    <span className={cn('inline-flex w-fit shrink-0 items-center gap-1 rounded-full border border-dashed border-muted-foreground/40 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-muted-foreground', className)}>
      <CircleDashedIcon aria-hidden="true" className="size-3" />
      {label}
    </span>
  )
}
