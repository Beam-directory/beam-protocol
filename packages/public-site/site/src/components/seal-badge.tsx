import { CheckIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

export function SealBadge({ label = 'Geprüft' }: { label?: string }) {
  return (
    <Badge>
      <CheckIcon data-icon="inline-start" />
      {label}
    </Badge>
  )
}
