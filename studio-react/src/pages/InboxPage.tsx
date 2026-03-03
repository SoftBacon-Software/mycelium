import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { useAuthStore } from '../stores/authStore'
import { getInboxItems, getInboxCount, markInboxRead, dismissInboxItem } from '../api/endpoints'
import type { InboxItem } from '../api/types'
import { Inbox, MessageSquare, ShieldCheck, Megaphone, AtSign, CheckCheck, X, RefreshCw } from 'lucide-react'

type FilterTab = 'unread' | 'all' | 'approval' | 'bip_draft' | 'mention'

const TABS: { key: FilterTab; label: string }[] = [
  { key: 'unread', label: 'Unread' },
  { key: 'all', label: 'All' },
  { key: 'approval', label: 'Approvals' },
  { key: 'bip_draft', label: 'Posts' },
  { key: 'mention', label: 'Mentions' },
]

const TYPE_ICONS: Record<string, React.FC<{ className?: string }>> = {
  approval: ({ className }) => <ShieldCheck className={className} strokeWidth={1.5} />,
  bip_draft: ({ className }) => <Megaphone className={className} strokeWidth={1.5} />,
  mention: ({ className }) => <AtSign className={className} strokeWidth={1.5} />,
  message: ({ className }) => <MessageSquare className={className} strokeWidth={1.5} />,
}

const TYPE_COLORS: Record<string, string> = {
  approval: 'text-amber-400',
  bip_draft: 'text-green-400',
  mention: 'text-blue-400',
  message: 'text-text-dim',
}

const PRIORITY_BADGE: Record<string, string> = {
  urgent: 'bg-red/15 text-red text-xs px-1.5 py-0.5 rounded font-mono uppercase',
  normal: '',
  low: 'bg-surface text-text-muted text-xs px-1.5 py-0.5 rounded font-mono uppercase',
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago'
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function getTypeIcon(type: string): React.FC<{ className?: string }> {
  return TYPE_ICONS[type] || TYPE_ICONS.message
}

export default function InboxPage() {
  const user = useAuthStore((s) => s.user)
  const [items, setItems] = useState<InboxItem[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<FilterTab>('unread')
  const [selected, setSelected] = useState<InboxItem | null>(null)

  const operatorId = user?.username || 'greatness'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const filters: Record<string, string> = { operator_id: operatorId }
      if (tab !== 'all' && tab !== 'unread') filters.type = tab
      if (tab === 'unread') filters.status = 'unread'
      const data = await getInboxItems(filters)
      setItems(data)
      const counts = await getInboxCount(operatorId)
      setUnreadCount(counts.unread ?? 0)
    } catch (e) {
      toast.error('Failed to load inbox')
    } finally {
      setLoading(false)
    }
  }, [operatorId, tab])

  useEffect(() => { load() }, [load])

  const handleMarkRead = useCallback(async (item: InboxItem) => {
    try {
      await markInboxRead(item.id)
      setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, status: 'read' } : i))
      setUnreadCount((c) => Math.max(0, c - (item.status === 'unread' ? 1 : 0)))
      if (selected?.id === item.id) setSelected({ ...item, status: 'read' })
    } catch (e) {
      toast.error('Failed to mark read')
    }
  }, [selected])

  const handleDismiss = useCallback(async (item: InboxItem) => {
    try {
      await dismissInboxItem(item.id)
      setItems((prev) => prev.filter((i) => i.id !== item.id))
      if (selected?.id === item.id) setSelected(null)
      toast.success('Dismissed')
    } catch (e) {
      toast.error('Failed to dismiss')
    }
  }, [selected])

  const handleSelectItem = useCallback((item: InboxItem) => {
    setSelected(item)
    if (item.status === 'unread') handleMarkRead(item)
  }, [handleMarkRead])

  const filteredItems = items

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Inbox size={18} className="text-accent" strokeWidth={1.5} />
          <h1 className="text-xl font-semibold text-text">Inbox</h1>
          {unreadCount > 0 && (
            <span className="bg-accent text-bg text-xs font-mono px-2 py-0.5 rounded-full">
              {unreadCount}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs text-text-muted hover:text-accent transition-colors"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} strokeWidth={1.5} />
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-border pb-0">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 text-xs font-mono rounded-t transition-colors ${
              tab === t.key
                ? 'bg-surface text-accent border border-b-surface border-border -mb-px'
                : 'text-text-muted hover:text-text'
            }`}
          >
            {t.label}
            {t.key === 'unread' && unreadCount > 0 && (
              <span className="ml-1.5 bg-accent text-bg rounded-full px-1 py-0 text-[10px]">
                {unreadCount}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="flex flex-1 min-h-0 gap-3">
        {/* Item list */}
        <div className={`flex flex-col gap-1 overflow-y-auto ${selected ? 'w-80 flex-shrink-0' : 'flex-1'}`}>
          {filteredItems.length === 0 && !loading && (
            <div className="text-center py-12">
              <Inbox size={32} className="text-text-muted mx-auto mb-3" strokeWidth={1} />
              <p className="text-sm text-text-muted">
                {tab === 'unread' ? 'All caught up' : 'No items'}
              </p>
            </div>
          )}
          {filteredItems.map((item) => {
            const Icon = getTypeIcon(item.type)
            const isSelected = selected?.id === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleSelectItem(item)}
                className={`text-left w-full p-3 rounded border transition-colors group ${
                  isSelected
                    ? 'bg-surface border-accent/40'
                    : item.status === 'unread'
                    ? 'bg-surface/60 border-border hover:border-accent/30 hover:bg-surface'
                    : 'bg-transparent border-transparent hover:border-border hover:bg-surface/40'
                }`}
              >
                <div className="flex items-start gap-2.5">
                  <Icon className={`mt-0.5 flex-shrink-0 w-4 h-4 ${TYPE_COLORS[item.type] || 'text-text-dim'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      {item.status === 'unread' && (
                        <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
                      )}
                      <span className={`text-sm font-medium truncate ${item.status === 'unread' ? 'text-text' : 'text-text-dim'}`}>
                        {item.title}
                      </span>
                      {item.priority === 'urgent' && (
                        <span className={PRIORITY_BADGE.urgent}>urgent</span>
                      )}
                    </div>
                    <p className="text-xs text-text-muted truncate">{item.summary}</p>
                    <p className="text-xs text-text-muted mt-1 font-mono">{formatDate(item.created_at)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleDismiss(item) }}
                    className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-text transition-opacity flex-shrink-0"
                    title="Dismiss"
                  >
                    <X size={12} strokeWidth={1.5} />
                  </button>
                </div>
              </button>
            )
          })}
        </div>

        {/* Detail panel */}
        {selected && (
          <div className="flex-1 min-h-0 overflow-y-auto bg-surface border border-border rounded p-4">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2">
                {(() => { const Icon = getTypeIcon(selected.type); return <Icon className={`w-4 h-4 ${TYPE_COLORS[selected.type] || 'text-text-dim'}`} /> })()}
                <h2 className="text-sm font-semibold text-text">{selected.title}</h2>
                {selected.priority === 'urgent' && (
                  <span className={PRIORITY_BADGE.urgent}>urgent</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {selected.status === 'unread' && (
                  <button
                    type="button"
                    onClick={() => handleMarkRead(selected)}
                    className="flex items-center gap-1 text-xs text-text-muted hover:text-accent transition-colors"
                  >
                    <CheckCheck size={12} strokeWidth={1.5} /> Mark read
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="text-text-muted hover:text-text transition-colors"
                >
                  <X size={14} strokeWidth={1.5} />
                </button>
              </div>
            </div>

            <p className="text-xs text-text-muted mb-3 font-mono">{formatDate(selected.created_at)}</p>

            <p className="text-sm text-text-dim mb-4">{selected.summary}</p>

            {/* Linked entity actions */}
            {selected.type === 'approval' && selected.data?.approval_id && (
              <div className="border border-border rounded p-3 bg-surface/50">
                <p className="text-xs text-text-muted mb-2">Approval #{selected.data.approval_id}</p>
                <div className="flex gap-2">
                  <Link
                    to="/approvals"
                    className="text-xs bg-accent text-bg px-3 py-1.5 rounded hover:bg-accent-light transition-colors font-medium"
                  >
                    Review in Approvals →
                  </Link>
                </div>
              </div>
            )}

            {selected.type === 'bip_draft' && selected.data?.draft_id && (
              <div className="border border-border rounded p-3 bg-surface/50">
                <p className="text-xs text-text-muted mb-1">Draft #{selected.data.draft_id}</p>
                {selected.data.content_preview && (
                  <p className="text-xs text-text-dim italic mb-2">"{selected.data.content_preview}"</p>
                )}
                <p className="text-xs text-text-muted">
                  Approve or reject in the Build in Public section.
                </p>
              </div>
            )}

            {selected.type === 'mention' && selected.data?.message_id && (
              <div className="border border-border rounded p-3 bg-surface/50">
                <p className="text-xs text-text-muted">
                  From: <span className="text-text-dim">{selected.data.from || 'unknown'}</span>
                </p>
                {selected.data.project_id && (
                  <p className="text-xs text-text-muted">
                    Project: <span className="text-text-dim">{selected.data.project_id}</span>
                  </p>
                )}
                <Link
                  to="/messages"
                  className="inline-block mt-2 text-xs text-accent hover:text-accent-light transition-colors"
                >
                  View in Agent Comms →
                </Link>
              </div>
            )}

            {selected.type === 'message' && (
              <div className="border border-border rounded p-3 bg-surface/50">
                <p className="text-xs text-text-muted">
                  From: <span className="text-text-dim">{selected.data?.from || 'unknown'}</span>
                </p>
                <Link
                  to="/messages"
                  className="inline-block mt-2 text-xs text-accent hover:text-accent-light transition-colors"
                >
                  View in Agent Comms →
                </Link>
              </div>
            )}

            {/* Raw data (collapsed) */}
            {selected.data && Object.keys(selected.data).length > 0 && (
              <details className="mt-4">
                <summary className="text-xs text-text-muted cursor-pointer hover:text-text">
                  Raw data
                </summary>
                <pre className="mt-2 text-xs text-text-muted bg-surface/50 rounded p-2 overflow-x-auto">
                  {JSON.stringify(selected.data, null, 2)}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
