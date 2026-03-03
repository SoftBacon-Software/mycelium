import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchInbox, markInboxItemRead, markInboxItemActioned, dismissInboxItem, castVote, resolveApproval } from '../api/endpoints'
import { useAuthStore } from '../stores/authStore'
import { useDashboardStore } from '../stores/dashboardStore'
import { getSenderDisplay } from '../utils/sender'
import { timeAgo } from '../utils/time'
import Badge from '../components/shared/Badge'
import type { InboxItem } from '../api/types'
import {
  Bell, ShieldCheck, AtSign, MessageSquare, Star, Megaphone,
  Check, X, Eye, Trash2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/* ── Config ── */

const typeConfig: Record<string, { icon: LucideIcon; label: string; variant: 'accent' | 'blue' | 'red' | 'green' | 'purple' }> = {
  message: { icon: MessageSquare, label: 'Message', variant: 'accent' },
  approval: { icon: ShieldCheck, label: 'Approval', variant: 'red' },
  bip_draft: { icon: Megaphone, label: 'BIP Draft', variant: 'purple' },
  mention: { icon: AtSign, label: 'Mention', variant: 'blue' },
  feedback_request: { icon: Star, label: 'Feedback', variant: 'green' },
}

const priorityStyle: Record<string, { bg: string; dot: string; label: string }> = {
  urgent: { bg: 'bg-red/5 border-red/20', dot: 'bg-red', label: 'Urgent' },
  normal: { bg: 'bg-surface-raised', dot: 'bg-accent', label: 'Normal' },
  low: { bg: 'bg-surface', dot: 'bg-text-muted', label: 'Low / FYI' },
}

function linkForItem(item: InboxItem): string {
  if (item.type === 'approval') return '/approvals'
  if (item.type === 'mention' || item.type === 'message') return '/messages'
  if (item.type === 'feedback_request') return '/feedback'
  return '/inbox'
}

/* ── Component ── */

export default function InboxPage() {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const refresh = useDashboardStore((s) => s.refresh)
  const [items, setItems] = useState<InboxItem[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await fetchInbox()
      setItems(data)
    } catch {
      // silent — next poll will retry
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const interval = setInterval(load, 10_000)
    return () => clearInterval(interval)
  }, [load])

  // Group by priority
  const grouped = useMemo(() => {
    const urgent = items.filter((i) => i.priority === 'urgent')
    const normal = items.filter((i) => i.priority === 'normal')
    const low = items.filter((i) => i.priority === 'low')
    return { urgent, normal, low }
  }, [items])

  const unreadCount = useMemo(
    () => items.filter((i) => i.status === 'unread').length,
    [items],
  )

  async function handleMarkRead(item: InboxItem) {
    try {
      await markInboxItemRead(item.id)
      await load()
      refresh()
    } catch { /* silent */ }
  }

  async function handleAction(item: InboxItem) {
    try {
      await markInboxItemActioned(item.id)
      await load()
      refresh()
    } catch { /* silent */ }
  }

  async function handleDismiss(item: InboxItem) {
    try {
      await dismissInboxItem(item.id)
      await load()
      refresh()
    } catch { /* silent */ }
  }

  async function handleApprovalVote(item: InboxItem, vote: 'approve' | 'deny') {
    if (!user) return
    try {
      await castVote(item.entity_id, vote, null, user.username, 'operator')
      await markInboxItemActioned(item.id)
      await load()
      refresh()
    } catch { /* silent */ }
  }

  function handleExpand(item: InboxItem) {
    if (item.status === 'unread') handleMarkRead(item)
    setExpandedId((prev) => (prev === item.id ? null : item.id))
  }

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

      {/* Empty state */}
      {items.length === 0 && (
        <div className="bg-surface rounded-lg p-12 text-center">
          <Bell size={32} className="mx-auto text-text-muted mb-3 opacity-50" />
          <p className="text-text-dim text-sm font-medium mb-1">Inbox clear</p>
          <p className="text-text-muted text-xs">No items requiring your attention. Nice.</p>
        </div>
      )}

      {/* Priority sections */}
      {(['urgent', 'normal', 'low'] as const).map((priority) => {
        const sectionItems = grouped[priority]
        if (sectionItems.length === 0) return null
        const style = priorityStyle[priority]

        return (
          <section key={priority}>
            <div className="flex items-center gap-2 mb-2">
              <div className={`w-2 h-2 rounded-full ${style.dot}`} />
              <h3 className="text-sm font-semibold text-text-dim uppercase tracking-wider">
                {style.label}
              </h3>
              <span className="text-xs text-text-muted">({sectionItems.length})</span>
            </div>

            <div className="space-y-2">
              {sectionItems.map((item) => {
                const tc = typeConfig[item.type] ?? typeConfig.message
                const TypeIcon = tc.icon
                const isExpanded = expandedId === item.id
                const isUnread = item.status === 'unread'

                return (
                  <div
                    key={item.id}
                    className={`rounded-lg border transition-colors ${style.bg} ${
                      isUnread ? 'border-accent/30' : 'border-border/30'
                    }`}
                  >
                    {/* Item row */}
                    <button
                      onClick={() => handleExpand(item)}
                      className="w-full text-left p-4 flex items-start gap-3"
                    >
                      {/* Unread indicator */}
                      <div className="mt-1 shrink-0">
                        {isUnread ? (
                          <div className="w-2 h-2 rounded-full bg-accent" />
                        ) : (
                          <div className="w-2 h-2" />
                        )}
                      </div>

                      {/* Type icon */}
                      <TypeIcon size={16} strokeWidth={1.5} className={`mt-0.5 shrink-0 text-${tc.variant === 'accent' ? 'accent' : tc.variant}`} />

                      {/* Content */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                          <Badge variant={tc.variant}>{tc.label}</Badge>
                          <span className={`text-sm font-medium truncate ${isUnread ? 'text-text' : 'text-text-dim'}`}>
                            {item.title}
                          </span>
                        </div>
                        <p className="text-xs text-text-muted truncate">{item.summary}</p>
                        <span className="text-xs text-text-muted mt-1 block">{timeAgo(item.created_at)}</span>
                      </div>

                      {/* Expand indicator */}
                      <svg
                        viewBox="0 0 12 12"
                        className={`w-3 h-3 text-text-muted shrink-0 mt-1.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                        fill="none" stroke="currentColor" strokeWidth="2"
                      >
                        <path d="M2 4l4 4 4-4" />
                      </svg>
                    </button>

                    {/* Expanded detail */}
                    {isExpanded && (
                      <div className="px-4 pb-4 pt-0 border-t border-border/30 mx-4 mb-0">
                        <div className="pt-3 space-y-3">
                          {/* Full summary */}
                          <p className="text-sm text-text-dim whitespace-pre-wrap">{item.summary}</p>

                          {/* Metadata */}
                          <div className="flex items-center gap-3 text-xs text-text-muted">
                            <span>Type: {item.entity_type}</span>
                            {item.entity_id && (
                              <>
                                <span>&middot;</span>
                                <span>#{item.entity_id}</span>
                              </>
                            )}
                            <span>&middot;</span>
                            <span>Status: {item.status}</span>
                          </div>

                          {/* Action buttons */}
                          <div className="flex items-center gap-2 pt-1">
                            {item.type === 'approval' ? (
                              <>
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleApprovalVote(item, 'approve') }}
                                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm bg-green/15 text-green text-xs font-medium hover:bg-green/25 transition-colors"
                                >
                                  <Check size={12} /> Approve
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleApprovalVote(item, 'deny') }}
                                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm bg-red/15 text-red text-xs font-medium hover:bg-red/25 transition-colors"
                                >
                                  <X size={12} /> Reject
                                </button>
                              </>
                            ) : (
                              <>
                                {item.status !== 'actioned' && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleAction(item) }}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm bg-accent/15 text-accent text-xs font-medium hover:bg-accent/25 transition-colors"
                                  >
                                    <Check size={12} /> Done
                                  </button>
                                )}
                                <button
                                  onClick={(e) => { e.stopPropagation(); navigate(linkForItem(item)) }}
                                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm bg-surface text-text-dim text-xs font-medium hover:bg-surface-raised transition-colors"
                                >
                                  <Eye size={12} /> View
                                </button>
                              </>
                            )}
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDismiss(item) }}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-text-muted text-xs hover:text-red hover:bg-red/10 transition-colors ml-auto"
                            >
                              <Trash2 size={12} /> Dismiss
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
