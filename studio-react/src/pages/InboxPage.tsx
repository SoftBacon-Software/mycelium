import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchInbox, markInboxItemRead, markInboxItemActioned, dismissInboxItem, bulkDismissInbox, castVote } from '../api/endpoints'
import { useAuthStore } from '../stores/authStore'
import { useDashboardStore } from '../stores/dashboardStore'
import { timeAgo } from '../utils/time'
import Badge from '../components/shared/Badge'
import type { InboxItem } from '../api/types'
import {
  Bell, ShieldCheck, AtSign, MessageSquare, Star, Megaphone,
  Check, X, Trash2, ExternalLink, CheckCheck, Archive,
  Filter, ChevronRight,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/* ── Config ── */

type FilterType = 'all' | 'approval' | 'message' | 'mention' | 'bip_draft' | 'feedback_request'

const typeConfig: Record<string, { icon: LucideIcon; label: string; variant: 'accent' | 'blue' | 'red' | 'green' | 'purple' }> = {
  message:          { icon: MessageSquare, label: 'Message',  variant: 'accent' },
  approval:         { icon: ShieldCheck,   label: 'Approval', variant: 'red' },
  bip_draft:        { icon: Megaphone,     label: 'BIP Draft', variant: 'purple' },
  mention:          { icon: AtSign,        label: 'Mention',  variant: 'blue' },
  feedback_request: { icon: Star,          label: 'Feedback', variant: 'green' },
}

const filters: { key: FilterType; label: string }[] = [
  { key: 'all',              label: 'All' },
  { key: 'approval',         label: 'Approvals' },
  { key: 'message',          label: 'Messages' },
  { key: 'mention',          label: 'Mentions' },
  { key: 'feedback_request', label: 'Feedback' },
]

function linkForItem(item: InboxItem): string {
  if (item.type === 'approval') return '/approvals'
  if (item.type === 'mention' || item.type === 'message') return '/messages'
  if (item.type === 'feedback_request') return '/feedback'
  return '/inbox'
}

function priorityIndicator(p: string) {
  if (p === 'urgent') return 'border-l-red'
  if (p === 'high')   return 'border-l-accent'
  return 'border-l-transparent'
}

/* ── Component ── */

export default function InboxPage() {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const refresh = useDashboardStore((s) => s.refresh)
  const [items, setItems] = useState<InboxItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [activeFilter, setActiveFilter] = useState<FilterType>('all')
  const [actionLoading, setActionLoading] = useState(false)

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

  // Filtered items
  const filtered = useMemo(() => {
    const list = activeFilter === 'all' ? items : items.filter((i) => i.type === activeFilter)
    // Sort: unread first, then by priority (urgent > normal > low), then newest
    const priorityOrder: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 }
    return [...list].sort((a, b) => {
      const aUnread = a.status === 'unread' ? 0 : 1
      const bUnread = b.status === 'unread' ? 0 : 1
      if (aUnread !== bUnread) return aUnread - bUnread
      const ap = priorityOrder[a.priority] ?? 2
      const bp = priorityOrder[b.priority] ?? 2
      if (ap !== bp) return ap - bp
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
  }, [items, activeFilter])

  // Counts per filter
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0 }
    for (const item of items) {
      if (item.status === 'unread') {
        c.all = (c.all || 0) + 1
        c[item.type] = (c[item.type] || 0) + 1
      }
    }
    return c
  }, [items])

  const selectedItem = useMemo(
    () => items.find((i) => i.id === selectedId) ?? null,
    [items, selectedId],
  )

  // Actions
  async function handleSelect(item: InboxItem) {
    setSelectedId(item.id)
    if (item.status === 'unread') {
      try {
        await markInboxItemRead(item.id)
        await load()
        refresh()
      } catch { /* silent */ }
    }
  }

  async function handleApprove(item: InboxItem) {
    if (!user || actionLoading) return
    setActionLoading(true)
    try {
      await castVote(item.entity_id, 'approve', null, user.username, 'operator')
      await markInboxItemActioned(item.id)
      await load()
      refresh()
    } catch { /* silent */ }
    setActionLoading(false)
  }

  async function handleReject(item: InboxItem) {
    if (!user || actionLoading) return
    setActionLoading(true)
    try {
      await castVote(item.entity_id, 'deny', null, user.username, 'operator')
      await markInboxItemActioned(item.id)
      await load()
      refresh()
    } catch { /* silent */ }
    setActionLoading(false)
  }

  async function handleArchive(item: InboxItem) {
    if (actionLoading) return
    setActionLoading(true)
    try {
      await markInboxItemActioned(item.id)
      if (selectedId === item.id) {
        // Select next item
        const idx = filtered.findIndex((i) => i.id === item.id)
        const next = filtered[idx + 1] ?? filtered[idx - 1] ?? null
        setSelectedId(next?.id ?? null)
      }
      await load()
      refresh()
    } catch { /* silent */ }
    setActionLoading(false)
  }

  async function handleDismiss(item: InboxItem) {
    if (actionLoading) return
    setActionLoading(true)
    try {
      await dismissInboxItem(item.id)
      if (selectedId === item.id) {
        const idx = filtered.findIndex((i) => i.id === item.id)
        const next = filtered[idx + 1] ?? filtered[idx - 1] ?? null
        setSelectedId(next?.id ?? null)
      }
      await load()
      refresh()
    } catch { /* silent */ }
    setActionLoading(false)
  }

  async function handleMarkAllRead() {
    const unread = items.filter((i) => i.status === 'unread')
    for (const item of unread) {
      try { await markInboxItemRead(item.id) } catch { /* skip */ }
    }
    await load()
    refresh()
  }

  async function handleDeleteAll() {
    try {
      await bulkDismissInbox(undefined, true)
      setSelectedId(null)
      await load()
      refresh()
    } catch { /* silent */ }
  }

  async function handleDeleteFiltered() {
    const ids = filtered.map((i) => i.id)
    if (!ids.length) return
    try {
      await bulkDismissInbox(ids)
      setSelectedId(null)
      await load()
      refresh()
    } catch { /* silent */ }
  }

  // Keyboard nav
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const idx = filtered.findIndex((i) => i.id === selectedId)
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        const next = filtered[idx + 1]
        if (next) handleSelect(next)
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        const prev = filtered[idx - 1]
        if (prev) handleSelect(prev)
      } else if (e.key === 'Escape') {
        setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /* ── Loading state ── */
  if (loading && items.length === 0) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-text">Inbox</h2>
        <div className="bg-surface rounded-lg p-8 text-center">
          <p className="text-text-muted text-sm">Loading...</p>
        </div>
      </div>
    )
  }

  /* ── Render ── */
  return (
    <div className="flex flex-col h-[calc(100vh-6rem)]">
      {/* Top bar */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold text-text">Inbox</h2>
          {counts.all > 0 && (
            <span className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full bg-accent/15 text-accent text-xs font-bold tabular-nums">
              {counts.all}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {counts.all > 0 && (
            <button
              onClick={handleMarkAllRead}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-text-muted active:text-text active:bg-surface-raised transition-colors"
            >
              <CheckCheck size={14} /> Mark all read
            </button>
          )}
          {filtered.length > 0 && activeFilter !== 'all' && (
            <button
              onClick={handleDeleteFiltered}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-text-muted active:text-red active:bg-red/10 transition-colors"
            >
              <Trash2 size={14} /> Delete {filters.find(f => f.key === activeFilter)?.label}
            </button>
          )}
          {items.length > 0 && (
            <button
              onClick={handleDeleteAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-red/70 active:text-red active:bg-red/10 transition-colors"
            >
              <Trash2 size={14} /> Delete all
            </button>
          )}
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 mb-4 shrink-0 overflow-x-auto pb-1">
        <Filter size={14} className="text-text-muted mr-1 shrink-0" />
        {filters.map((f) => {
          const isActive = activeFilter === f.key
          const count = counts[f.key] || 0
          return (
            <button
              key={f.key}
              onClick={() => setActiveFilter(f.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors whitespace-nowrap ${
                isActive
                  ? 'bg-accent/15 text-accent'
                  : 'text-text-muted hover:text-text-dim hover:bg-surface-raised'
              }`}
            >
              {f.label}
              {count > 0 && (
                <span className={`min-w-[16px] h-4 px-1 rounded-full text-[10px] font-bold tabular-nums flex items-center justify-center ${
                  isActive ? 'bg-accent/25 text-accent' : 'bg-surface-raised text-text-muted'
                }`}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Empty state */}
      {items.length === 0 ? (
        <div className="bg-surface rounded-lg p-12 text-center flex-1 flex flex-col items-center justify-center">
          <Bell size={32} className="text-text-muted mb-3 opacity-50" />
          <p className="text-text-dim text-sm font-medium mb-1">Inbox clear</p>
          <p className="text-text-muted text-xs">No items requiring your attention.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-surface rounded-lg p-12 text-center flex-1 flex flex-col items-center justify-center">
          <Filter size={24} className="text-text-muted mb-3 opacity-50" />
          <p className="text-text-dim text-sm font-medium">No {activeFilter === 'all' ? '' : activeFilter} items</p>
        </div>
      ) : (
        /* Two-panel layout */
        <div className="flex gap-0 flex-1 min-h-0 rounded-lg border border-border/30 overflow-hidden">
          {/* ── Left: Message list ── */}
          <div className={`${selectedItem ? 'w-[380px] shrink-0 hidden lg:block' : 'flex-1'} overflow-y-auto border-r border-border/30 bg-surface/50`}>
            {filtered.map((item) => {
              const tc = typeConfig[item.type] ?? typeConfig.message
              const TypeIcon = tc.icon
              const isUnread = item.status === 'unread'
              const isSelected = selectedId === item.id

              return (
                <button
                  key={item.id}
                  onClick={() => handleSelect(item)}
                  className={`w-full text-left px-4 py-3 flex items-start gap-3 border-b border-border/20 border-l-2 transition-colors ${priorityIndicator(item.priority)} ${
                    isSelected
                      ? 'bg-accent/8'
                      : isUnread
                        ? 'bg-surface hover:bg-surface-raised'
                        : 'hover:bg-surface-raised/50'
                  }`}
                >
                  {/* Unread dot */}
                  <div className="mt-1.5 shrink-0 w-2">
                    {isUnread && <div className="w-2 h-2 rounded-full bg-accent" />}
                  </div>

                  {/* Icon */}
                  <TypeIcon size={14} strokeWidth={1.5} className={`mt-1 shrink-0 text-${tc.variant === 'accent' ? 'accent' : tc.variant}`} />

                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className={`text-sm truncate ${isUnread ? 'font-semibold text-text' : 'font-medium text-text-dim'}`}>
                        {item.title}
                      </span>
                    </div>
                    <p className="text-xs text-text-muted truncate">{item.summary}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <Badge variant={tc.variant}>{tc.label}</Badge>
                      <span className="text-[10px] text-text-muted">{timeAgo(item.created_at)}</span>
                    </div>
                  </div>

                  {/* Selected indicator */}
                  {isSelected && (
                    <ChevronRight size={14} className="text-accent shrink-0 mt-1 hidden lg:block" />
                  )}
                </button>
              )
            })}
          </div>

          {/* ── Right: Reading pane ── */}
          {selectedItem ? (
            <div className="flex-1 overflow-y-auto min-w-0 bg-[var(--color-bg)]">
              {/* Detail header */}
              <div className="px-6 py-4 border-b border-border/30">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant={(typeConfig[selectedItem.type] ?? typeConfig.message).variant}>
                        {(typeConfig[selectedItem.type] ?? typeConfig.message).label}
                      </Badge>
                      {selectedItem.priority === 'urgent' && (
                        <Badge variant="red">Urgent</Badge>
                      )}
                      {selectedItem.status === 'actioned' && (
                        <Badge variant="green">Done</Badge>
                      )}
                    </div>
                    <h3 className="text-lg font-semibold text-text leading-tight">
                      {selectedItem.title}
                    </h3>
                    <p className="text-xs text-text-muted mt-1">
                      {new Date(selectedItem.created_at).toLocaleString()} &middot; {selectedItem.entity_type} #{selectedItem.entity_id}
                    </p>
                  </div>

                  {/* Back button (mobile) */}
                  <button
                    onClick={() => setSelectedId(null)}
                    className="lg:hidden shrink-0 px-2 py-1 text-xs text-text-muted active:text-text rounded transition-colors"
                  >
                    &larr; Back
                  </button>
                </div>
              </div>

              {/* Detail body + actions together (scrollable) */}
              <div className="px-6 py-5">
                <p className="text-sm text-text-dim whitespace-pre-wrap leading-relaxed">
                  {selectedItem.summary}
                </p>

                {/* Data payload */}
                {selectedItem.data && Object.keys(selectedItem.data).length > 0 && (
                  <div className="mt-4 p-4 rounded-lg bg-surface border border-border/30">
                    <p className="text-xs font-semibold text-text-dim mb-2 uppercase tracking-wider">Details</p>
                    <div className="space-y-1">
                      {Object.entries(selectedItem.data).map(([key, val]) => (
                        <div key={key} className="flex items-start gap-2 text-xs">
                          <span className="text-text-muted font-medium min-w-[100px]">{key}</span>
                          <span className="text-text-dim break-all">{typeof val === 'object' ? JSON.stringify(val) : String(val)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Action buttons — right after content */}
                <div className="flex items-center gap-2 mt-5 pt-4 border-t border-border/30">
                  {selectedItem.type === 'approval' && selectedItem.status !== 'actioned' ? (
                    <>
                      <button
                        onClick={() => handleApprove(selectedItem)}
                        disabled={actionLoading}
                        className="flex items-center gap-1.5 px-4 py-2 rounded bg-green/15 text-green text-sm font-medium active:bg-green/25 transition-colors disabled:opacity-50"
                      >
                        <Check size={14} /> Approve
                      </button>
                      <button
                        onClick={() => handleReject(selectedItem)}
                        disabled={actionLoading}
                        className="flex items-center gap-1.5 px-4 py-2 rounded bg-red/15 text-red text-sm font-medium active:bg-red/25 transition-colors disabled:opacity-50"
                      >
                        <X size={14} /> Reject
                      </button>
                    </>
                  ) : selectedItem.status !== 'actioned' ? (
                    <button
                      onClick={() => handleArchive(selectedItem)}
                      disabled={actionLoading}
                      className="flex items-center gap-1.5 px-4 py-2 rounded bg-accent/15 text-accent text-sm font-medium active:bg-accent/25 transition-colors disabled:opacity-50"
                    >
                      <Archive size={14} /> Archive
                    </button>
                  ) : null}

                  <button
                    onClick={() => navigate(linkForItem(selectedItem))}
                    className="flex items-center gap-1.5 px-4 py-2 rounded bg-surface-raised text-text-dim text-sm font-medium active:bg-surface transition-colors"
                  >
                    <ExternalLink size={14} /> View Source
                  </button>

                  <button
                    onClick={() => handleDismiss(selectedItem)}
                    disabled={actionLoading}
                    className="flex items-center gap-1.5 px-3 py-2 rounded text-text-muted text-sm active:text-red active:bg-red/10 transition-colors disabled:opacity-50"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* No selection */
            <div className="flex-1 flex flex-col items-center justify-center text-center bg-[var(--color-bg)]">
              <Bell size={28} className="text-text-muted mb-3 opacity-40" />
              <p className="text-text-dim text-sm font-medium">Select an item to read</p>
              <p className="text-text-muted text-xs mt-1">Use <kbd className="px-1.5 py-0.5 rounded bg-surface text-text-dim text-[10px] font-mono">j</kbd>/<kbd className="px-1.5 py-0.5 rounded bg-surface text-text-dim text-[10px] font-mono">k</kbd> to navigate</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
