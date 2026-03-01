import type { ReactNode } from 'react'

type BadgeVariant = 'default' | 'green' | 'red' | 'blue' | 'accent' | 'purple' | 'pink' | 'muted'

interface BadgeProps {
  children: ReactNode
  variant?: BadgeVariant
  className?: string
}

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-surface text-text-dim',
  green: 'bg-green/10 text-green',
  red: 'bg-red/10 text-red',
  blue: 'bg-blue/10 text-blue',
  accent: 'bg-accent/10 text-accent',
  purple: 'bg-purple/10 text-purple',
  pink: 'bg-pink/10 text-pink',
  muted: 'bg-surface text-text-muted',
}

export default function Badge({ children, variant = 'default', className = '' }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full font-medium ${variantClasses[variant]} ${className}`}
    >
      {children}
    </span>
  )
}
