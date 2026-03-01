interface StatusDotProps {
  status: 'online' | 'offline' | 'busy' | string
  className?: string
}

const statusColors: Record<string, string> = {
  online: 'bg-green',
  offline: 'bg-text-muted',
  busy: 'bg-accent',
}

export default function StatusDot({ status, className = '' }: StatusDotProps) {
  const color = statusColors[status] || 'bg-text-muted'

  return (
    <span
      className={`w-2 h-2 rounded-full inline-block shrink-0 ${color} ${className}`}
      title={status}
    />
  )
}
