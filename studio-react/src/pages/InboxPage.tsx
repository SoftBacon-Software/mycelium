import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchInbox, markInboxRead } from '../api/endpoints'
import { getSenderDisplay } from '../utils/sender'
import { timeAgo } from '../utils/time'
import Badge from '../components/shared/Badge'
import type { InboxItem } from '../api/types'

type FilterTab = 'all' | 'requests' | 'mentions' | 'approvals'

const TABS: { key: FilterTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'requests', label: 'Requests' },
  { key: 'mentions', label: 'Mentions' },
  { key: 'approvals', label: 'Approvals' },
]

const kindConfig: Record<string, { variant: 'accent' | 'blue' | 'red' | 'green' | 'purple'; label: string }> = {
  request: { variant: 'accent', label: 'request' },
  directive: { variant: 'red', label: 'directive' },
  mention: { variant: 'blue', label: 'mention' },
  approval: { variant: 'red', label: 'approval' },
  step_comment: { variant: 'green', label: 'comment' },
  bip_approval: { variant: 'purple', label: 'BIP draft' },
}

function filterMatch(item: InboxItem, tab: FilterTab): boolean {
  if (tab === 'all') return true
  if (tab === 'requests') return item.kind === 'request' || item.kind === 'directive'
  if (tab === 'mentions') return item.kind === 'mention'
  if (tab === 'approvals') return item.kind === 'approval' || item.kind === 'bip_approval'
  return true
}

export default function InboxPage() {
  const navigate = useNavigate()
  const [items, setItems] = useState<InboxItem[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterTab>('all')

  const load = useCallback(async () => {
    try {
      const data = await fetchInbox()
      setItems(data.items)
      setUnreadCount(data.unread_count)
    } catch {
      // silently fail — next poll will retry
    } finally {
      setLoading(false)
    }
  }, [])

  // Mark as read on mount, then load
  useEffect(() => {
    markInboxRead().catch(() => {})
    load()
    const interval = setInterval(load, 10_000)
    return () => clearInterval(interval)
  }, [load])

  const filtered = useMemo(
    () => items.filter((item) => filterMatch(item, filter)),
    [items, filter],
  )

  if (loading && items.length === 0) {
    return (
      <div className="space-y-6">
        <h2 className="text-xl font-semibold text-text">Inbox</h2>
        <div className="bg-surface rounded-lg p-8 text-center">
          <p className="text-text-muted text-sm">Loading...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-semibold text-text">Inbox</h2>
        {unreadCount > 0 && (
          <span className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full bg-accent/15 text-accent text-xs font-bold tabular-nums">
            {unreadCount}
          </span>
        )}
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 bg-surface rounded-sm p-1">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`px-4 py-1.5 rounded-sm text-sm font-medium transition-colors ${
              filter === tab.key
                ? 'bg-surface-raised text-text'
                : 'text-text-muted hover:text-text-dim'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Items */}
      {filtered.length === 0 ? (
        <div className="bg-surface rounded-lg p-8 text-center">
          <p className="text-text-muted text-sm">
            {filter === 'all' ? 'Inbox is empty' : `No ${filter} items`}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((item) => {
            const config = kindConfig[item.kind] ?? kindConfig.request
            return (
              <button
                key={item.id}
                onClick={() => navigate(item.link)}
                className="w-full text-left bg-surface-raised rounded-lg p-4 hover:bg-surface-raised/80 transition-colors flex items-start gap-3"
              >
                {/* Unread dot */}
                <div className="mt-1.5 shrink-0">
                  {item.is_unread ? (
                    <div className="w-2 h-2 rounded-full bg-accent" />
                  ) : (
                    <div className="w-2 h-2" />
                  )}
                </div>

                {/* Content */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant={config.variant}>{config.label}</Badge>
                    <span className="text-sm font-medium text-text truncate">
                      {item.title}
                    </span>
                  </div>
                  <p className="text-xs text-text-muted truncate">{item.preview}</p>
                  <div className="flex items-center gap-2 mt-1.5 text-xs text-text-muted">
                    <span>{getSenderDisplay(item.from)}</span>
                    <span>&middot;</span>
                    <span>{timeAgo(item.created_at)}</span>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
