// Centralized timestamp utilities — all display times in CST (America/Chicago)

const TZ = 'America/Chicago'
const TZ_ABBR = 'CST'

/** Parse mixed timestamp formats from the API ("2026-03-02 02:27:48" or ISO "2026-03-02T02:27:53.214Z") */
export function parseTimestamp(dateStr: string): number {
  if (dateStr.includes('T')) return new Date(dateStr).getTime()
  return new Date(dateStr.replace(' ', 'T') + 'Z').getTime()
}

/** Relative time: "just now", "5m ago", "3h ago", "2d ago" */
export function timeAgo(dateStr: string | null): string {
  if (!dateStr) return '-'
  const ts = parseTimestamp(dateStr)
  if (isNaN(ts)) return '-'
  const diff = Date.now() - ts
  if (diff < 0) return 'just now'
  if (diff < 60_000) return 'just now'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

/** Short time: "2:45 PM CST" */
export function formatTime(dateStr: string): string {
  const ts = parseTimestamp(dateStr)
  if (isNaN(ts)) return '-'
  const d = new Date(ts)
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: TZ }) + ' ' + TZ_ABBR
}

/** Short date + time: "Mar 2, 2:45 PM CST" */
export function formatDateTime(dateStr: string): string {
  const ts = parseTimestamp(dateStr)
  if (isNaN(ts)) return '-'
  const d = new Date(ts)
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ,
  }) + ' ' + TZ_ABBR
}

/** Short date: "Mar 2" */
export function formatDate(dateStr: string): string {
  const ts = parseTimestamp(dateStr)
  if (isNaN(ts)) return '-'
  const d = new Date(ts)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: TZ })
}

/** Full timestamp: "Mar 2, 2026, 2:45:30 PM CST" */
export function formatFullTimestamp(dateStr: string): string {
  const ts = parseTimestamp(dateStr)
  if (isNaN(ts)) return '-'
  const d = new Date(ts)
  return d.toLocaleString('en-US', { timeZone: TZ }) + ' ' + TZ_ABBR
}

/** Date separator label: "Today", "Yesterday", or "Monday, March 2" */
export function formatDateLabel(dateStr: string): string {
  const ts = parseTimestamp(dateStr)
  if (isNaN(ts)) return '-'
  const d = new Date(ts)
  const now = new Date()
  // Compare in CST
  const fmt = (dt: Date) => dt.toLocaleDateString('en-US', { timeZone: TZ })
  if (fmt(d) === fmt(now)) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (fmt(d) === fmt(yesterday)) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: TZ })
}
