import { useId } from 'react'

/** Beam logo mark: two nodes joined by a beam, on a gradient tile. Decorative; label the surrounding link. */
export function BeamMark({ className }: { className?: string }) {
  const id = useId()
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--beam)" />
          <stop offset="1" stopColor="var(--beam-2)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <path d="M9.5 22.5 22.5 9.5" stroke="white" strokeOpacity="0.95" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="9.5" cy="22.5" r="3" fill="white" />
      <circle cx="22.5" cy="9.5" r="3" fill="white" />
    </svg>
  )
}
