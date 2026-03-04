import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { useAuthStore } from '../stores/authStore'
import { fetchChannelMessages, fetchChannelUnread, sendChannelMessage, markChannelRead, createChannel, deleteChannel } from '../api/endpoints'
import type { Channel, ChannelMessage } from '../api/types'
import { Avatar, formatTime } from '../components/messages/ChatMessage'
import Badge from '../components/shared/Badge'
import { formatDateLabel } from '../utils/time'
import { getSenderDisplay } from '../utils/sender'

// ─── Types ──────────────────────────────────────────────────────────────────

type ChannelType = Channel['type']
type BadgeVariant = 'default' | 'green' | 'red' | 'blue' | 'accent' | 'purple' | 'pink' | 'muted'

const CHANNEL_TYPE_CONFIG: Record<string, { label: string; icon: string; variant: BadgeVariant }> = {
  general: { label: 'Channels', icon: '#', variant: 'default' },
  announcement: { label: 'Channels', icon: '\u{1F4E2}', variant: 'accent' },
  dm: { label: 'Direct Messages', icon: '\u{1F4AC}', variant: 'purple' },
}

const DEFAULT_TYPE_CONFIG = { label: 'Channels', icon: '#', variant: 'default' as BadgeVariant }

type SidebarGroup = 'channels' | 'dm'
const SIDEBAR_GROUPS: { key: SidebarGroup; label: string }[] = [
  { key: 'channels', label: 'Channels' },
  { key: 'dm', label: 'Direct Messages' },
]

const TRUNCATE_LENGTH = 300

// ─── Helpers ────────────────────────────────────────────────────────────────


function isSameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

// getSenderDisplay imported from utils/sender

// ─── Date Separator ─────────────────────────────────────────────────────────

function DateSeparator({ date }: { date: string }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="flex-1 h-px bg-border" />
      <span className="text-text-muted text-xs font-medium shrink-0">
        {formatDateLabel(date)}
      </span>
      <div className="flex-1 h-px bg-border" />
    </div>
  )
}

// ─── Auto-scroll hook ───────────────────────────────────────────────────────

function useAutoScroll(deps: unknown[]) {
  const containerRef = useRef<HTMLDivElement>(null)
  const shouldScroll = useRef(true)

  function handleScroll() {
    const el = containerRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    shouldScroll.current = distFromBottom < 80
  }

  useEffect(() => {
    const el = containerRef.current
    if (el && shouldScroll.current) {
      el.scrollTop = el.scrollHeight
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { containerRef, handleScroll }
}


// ─── Channel Message ────────────────────────────────────────────────────────

function ChannelMsg({
  message,
  isGrouped,
  isExpanded,
  onToggleExpand,
}: {
  message: ChannelMessage
  isGrouped: boolean
  isExpanded: boolean
  onToggleExpand: () => void
}) {
  const content = message.content
  const shouldTruncate = content.length > TRUNCATE_LENGTH
  const displayContent =
    shouldTruncate && !isExpanded
      ? content.slice(0, TRUNCATE_LENGTH) + '...'
      : content

  const senderName = getSenderDisplay(message.from_agent)

  // Grouped message — compact form without avatar
  if (isGrouped) {
    return (
      <div className="group pl-9 py-0.5 hover:bg-surface/50 transition-colors">
        <div className="flex items-start gap-2">
          <p className="text-text text-sm whitespace-pre-wrap break-words flex-1 min-w-0">
            {displayContent}
            {shouldTruncate && (
              <button
                onClick={onToggleExpand}
                className="text-accent text-xs ml-1 hover:underline underline-offset-2"
              >
                {isExpanded ? 'show less' : 'show more'}
              </button>
            )}
          </p>
          <span className="text-text-muted text-xs shrink-0 opacity-0 group-hover:opacity-100 transition-opacity pt-0.5">
            {formatTime(message.created_at)}
          </span>
        </div>
      </div>
    )
  }

  // New sender — full header with avatar
  return (
    <div className="group pt-2 pb-0.5 hover:bg-surface/50 transition-colors">
      <div className="flex items-start gap-2">
        <Avatar name={senderName} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-sm text-text">{senderName}</span>
            <span className="text-text-muted text-xs">{formatTime(message.created_at)}</span>
          </div>
          <p className="text-text text-sm whitespace-pre-wrap break-words mt-0.5">
            {displayContent}
            {shouldTruncate && (
              <button
                onClick={onToggleExpand}
                className="text-accent text-xs ml-1 hover:underline underline-offset-2"
              >
                {isExpanded ? 'show less' : 'show more'}
              </button>
            )}
          </p>
        </div>
      </div>
    </div>
  )
}

// ─── Sidebar ────────────────────────────────────────────────────────────────

function ChannelSidebar({
  channels,
  activeId,
  unreadMap,
  onSelect,
  onChannelCreated,
  onChannelDeleted,
}: {
  channels: Channel[]
  activeId: number | null
  unreadMap: Record<number, number>
  onSelect: (id: number) => void
  onChannelCreated: () => void
  onChannelDeleted: (id: number) => void
}) {
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<ChannelType>('general')
  const [newDesc, setNewDesc] = useState('')
  const [creating, setCreating] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  async function handleDelete(e: React.MouseEvent, ch: Channel) {
    e.stopPropagation()
    if (!window.confirm(`Delete "${ch.name}"? This cannot be undone.`)) return
    setDeletingId(ch.id)
    try {
      await deleteChannel(ch.id)
      onChannelDeleted(ch.id)
    } catch (err) {
      console.error('Failed to delete channel:', err)
    } finally {
      setDeletingId(null)
    }
  }

  const totalUnread = useMemo(
    () => Object.values(unreadMap).reduce((sum, n) => sum + n, 0),
    [unreadMap],
  )

  // Group channels into Channels (general/announcement/legacy entity types) and DMs
  const grouped = useMemo(() => {
    const map = new Map<SidebarGroup, Channel[]>()
    map.set('channels', [])
    map.set('dm', [])
    for (const ch of channels) {
      if (ch.status !== 'active') continue
      if (ch.type === 'dm') {
        map.get('dm')!.push(ch)
      } else {
        map.get('channels')!.push(ch)
      }
    }
    return map
  }, [channels])

  async function handleCreate() {
    const name = newName.trim()
    if (!name || creating) return
    setCreating(true)
    try {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      await createChannel({ name, slug, type: newType, description: newDesc.trim() || undefined })
      setNewName('')
      setNewDesc('')
      setNewType('general')
      setShowCreate(false)
      onChannelCreated()
    } catch (err) {
      console.error('Failed to create channel:', err)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="bg-surface flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm text-text">Channels</span>
          {totalUnread > 0 && (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent/15 text-accent text-xs font-bold tabular-nums">
              {totalUnread}
            </span>
          )}
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="text-text-muted hover:text-accent transition-colors p-0.5 rounded-sm hover:bg-surface-raised"
          title="Create channel"
        >
          <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
      </div>

      {/* Create channel form */}
      {showCreate && (
        <div className="px-3 py-2 border-b border-border space-y-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Channel name"
            className="w-full bg-surface-raised border border-border rounded-sm px-2 py-1 text-xs text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40"
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as ChannelType)}
            className="w-full bg-surface-raised border border-border rounded-sm px-2 py-1 text-xs text-text focus:outline-none focus:ring-1 focus:ring-accent/40"
          >
            <option value="general">General</option>
            <option value="announcement">Announcement</option>
          </select>
          <input
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Description (optional)"
            className="w-full bg-surface-raised border border-border rounded-sm px-2 py-1 text-xs text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={handleCreate}
              disabled={!newName.trim() || creating}
              className="flex-1 px-2 py-1 rounded-sm text-xs font-medium bg-accent text-bg hover:bg-accent-light transition-colors disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create'}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="px-2 py-1 rounded-sm text-xs text-text-muted hover:text-text transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto py-2">
        {SIDEBAR_GROUPS.map(({ key, label }) => {
          const list = grouped.get(key)
          if (!list || list.length === 0) return null

          return (
            <div key={key} className="mb-2">
              <div className="px-3 py-1">
                <span className="text-text-muted text-[10px] font-semibold tracking-wider uppercase">
                  {label}
                </span>
              </div>
              {list.map((ch) => {
                const isActive = ch.id === activeId
                const unread = unreadMap[ch.id] || 0
                const config = CHANNEL_TYPE_CONFIG[ch.type] || DEFAULT_TYPE_CONFIG
                const isProtected = ['general', 'admin'].includes(ch.slug)

                return (
                  <div
                    key={ch.id}
                    className={`group w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors cursor-pointer ${
                      isActive
                        ? 'bg-surface-raised text-text'
                        : 'text-text-dim hover:text-text hover:bg-surface-raised/50'
                    }`}
                    onClick={() => onSelect(ch.id)}
                  >
                    <span className="w-5 text-center shrink-0 text-xs">{config.icon}</span>
                    <span className="truncate flex-1">{ch.name}</span>
                    {unread > 0 && (
                      <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent/15 text-accent text-xs font-bold tabular-nums shrink-0">
                        {unread}
                      </span>
                    )}
                    {!isProtected && <button
                      onClick={(e) => handleDelete(e, ch)}
                      disabled={deletingId === ch.id}
                      className="opacity-0 group-hover:opacity-100 shrink-0 p-0.5 rounded text-text-muted hover:text-red hover:bg-red/10 transition-all"
                      title="Delete channel"
                    >
                      <svg viewBox="0 0 12 12" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M2 2l8 8M10 2l-8 8" />
                      </svg>
                    </button>}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

    </div>
  )
}

// ─── Chat Area ──────────────────────────────────────────────────────────────

function ChatArea({
  channel,
  messages,
  onSend,
  sending,
  showAll,
  onToggleShowAll,
}: {
  channel: Channel | null
  messages: ChannelMessage[]
  onSend: (content: string) => void
  sending: boolean
  showAll: boolean
  onToggleShowAll: () => void
}) {
  const [input, setInput] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
  const [allExpanded, setAllExpanded] = useState(false)

  const sorted = useMemo(
    () => [...messages].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
    [messages],
  )

  // Track which messages are truncatable
  const truncatableIds = useMemo(
    () => new Set(sorted.filter((m) => m.content.length > TRUNCATE_LENGTH).map((m) => m.id)),
    [sorted],
  )

  const { containerRef, handleScroll } = useAutoScroll([sorted.length])

  // Reset expanded state when channel changes
  useEffect(() => {
    setExpandedIds(new Set())
    setAllExpanded(false)
  }, [channel?.id])

  function toggleExpand(id: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setAllExpanded(false)
  }

  function toggleExpandAll() {
    if (allExpanded) {
      setExpandedIds(new Set())
      setAllExpanded(false)
    } else {
      setExpandedIds(new Set(truncatableIds))
      setAllExpanded(true)
    }
  }

  function handleSend() {
    const text = input.trim()
    if (!text || sending) return
    onSend(text)
    setInput('')
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!channel) {
    return (
      <div className="flex-1 flex items-center justify-center bg-bg">
        <p className="text-text-muted text-sm">Select a channel to start chatting</p>
      </div>
    )
  }

  const config = CHANNEL_TYPE_CONFIG[channel.type] || DEFAULT_TYPE_CONFIG

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-bg">
      {/* Channel header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        <span className="text-base">{config.icon}</span>
        <span className="font-semibold text-sm text-text">{channel.name}</span>
        <Badge variant={config.variant}>{channel.type}</Badge>
        {channel.description && (
          <>
            <div className="w-px h-4 bg-border" />
            <span className="text-text-muted text-xs truncate">{channel.description}</span>
          </>
        )}
        <div className="ml-auto shrink-0">
          <button
            onClick={() => { onToggleShowAll(); toggleExpandAll() }}
            className="text-xs px-2 py-1 rounded-sm font-medium transition-colors border border-border hover:border-accent/40 hover:text-accent text-text-muted"
            title={showAll ? 'Show recent messages only' : 'Load all messages and expand for Ctrl+F search'}
          >
            {showAll ? 'Show Less' : 'Show All'}
          </button>
        </div>
      </div>

      {/* Message list */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 pb-2 min-h-0"
      >
        {sorted.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-text-muted text-sm">No messages yet. Start the conversation.</p>
          </div>
        ) : (
          sorted.map((msg, i) => {
            const prev = i > 0 ? sorted[i - 1] : null
            const showDate = !prev || !isSameDay(prev.created_at, msg.created_at)
            const isGrouped =
              !!prev &&
              !showDate &&
              prev.from_agent === msg.from_agent

            return (
              <div key={msg.id}>
                {showDate && <DateSeparator date={msg.created_at} />}
                <ChannelMsg
                  message={msg}
                  isGrouped={isGrouped}
                  isExpanded={showAll || expandedIds.has(msg.id)}
                  onToggleExpand={() => toggleExpand(msg.id)}
                />
              </div>
            )
          })
        )}
      </div>

      {/* Input bar */}
      <div className="px-4 py-3 border-t border-border shrink-0">
        <div className="flex items-center gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Message #${channel.name}...`}
            rows={1}
            className="flex-1 bg-surface-raised border border-border rounded px-3 py-2 text-text text-sm placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            disabled={sending}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending}
            className="bg-accent text-bg rounded px-4 py-2 text-sm font-medium hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {sending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function ChannelsPage() {
  const channels = useDashboardStore((s) => s.channels)
  const user = useAuthStore((s) => s.user)

  const [activeChannelId, setActiveChannelId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ChannelMessage[]>([])
  const [unreadMap, setUnreadMap] = useState<Record<number, number>>({})
  const [sending, setSending] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const activeChannel = useMemo(
    () => channels.find((ch) => ch.id === activeChannelId) ?? null,
    [channels, activeChannelId],
  )

  // Auto-select first active channel on mount
  useEffect(() => {
    if (activeChannelId !== null) return
    const active = channels.filter((ch) => ch.status === 'active')
    if (active.length > 0) {
      setActiveChannelId(active[0].id)
    }
  }, [channels, activeChannelId])

  // Load unread counts
  const loadUnread = useCallback(async () => {
    try {
      const data = await fetchChannelUnread()
      const map: Record<number, number> = {}
      for (const [idStr, info] of Object.entries(data)) {
        const id = Number(idStr)
        if (info.unread > 0) map[id] = info.unread
      }
      setUnreadMap(map)
    } catch (err) {
      console.error('Failed to fetch channel unread:', err)
    }
  }, [])

  // Load messages for active channel
  const loadMessages = useCallback(async () => {
    if (activeChannelId === null) return
    try {
      const msgs = await fetchChannelMessages(activeChannelId, showAll ? 500 : 100)
      setMessages(msgs)
    } catch (err) {
      console.error('Failed to fetch channel messages:', err)
    }
  }, [activeChannelId, showAll])

  // Mark channel as read and load messages when selecting a channel
  const handleSelectChannel = useCallback(
    async (id: number) => {
      setActiveChannelId(id)
      setMessages([])
      setShowAll(false)
      try {
        await markChannelRead(id)
        setUnreadMap((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
      } catch (err) {
        console.error('Failed to mark channel as read:', err)
      }
    },
    [],
  )

  // Initial load + polling for messages and unread every 5s
  useEffect(() => {
    loadMessages()
    loadUnread()

    const interval = setInterval(() => {
      loadMessages()
      loadUnread()
    }, 5000)

    return () => clearInterval(interval)
  }, [loadMessages, loadUnread])

  // Send a message
  const handleSend = useCallback(
    async (content: string) => {
      if (activeChannelId === null || !user) return
      setSending(true)
      try {
        await sendChannelMessage(activeChannelId, content)
        await loadMessages()
      } catch (err) {
        console.error('Failed to send channel message:', err)
      } finally {
        setSending(false)
      }
    },
    [activeChannelId, user, loadMessages],
  )

  return (
    <div className="flex-1 min-h-0 rounded-sm overflow-hidden border border-border flex">
      <div className={`${activeChannelId ? 'hidden sm:flex' : 'flex'} flex-col w-full sm:w-60 shrink-0 min-h-0`}>
        <ChannelSidebar
          channels={channels}
          activeId={activeChannelId}
          unreadMap={unreadMap}
          onSelect={handleSelectChannel}
          onChannelCreated={() => { useDashboardStore.getState().refresh(); loadUnread() }}
          onChannelDeleted={(id) => {
            if (activeChannelId === id) setActiveChannelId(null)
            useDashboardStore.getState().refresh()
          }}
        />
      </div>
      <div className={`${activeChannelId ? 'flex' : 'hidden sm:flex'} flex-col flex-1 min-w-0 min-h-0`}>
        {activeChannelId && (
          <button
            onClick={() => handleSelectChannel(null as any)}
            className="sm:hidden flex items-center gap-1 px-3 py-2 text-xs text-text-muted hover:text-accent border-b border-border shrink-0"
          >
            <svg viewBox="0 0 12 12" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 2L4 6l4 4" /></svg>
            Channels
          </button>
        )}
        <ChatArea
          channel={activeChannel}
          messages={messages}
          onSend={handleSend}
          sending={sending}
          showAll={showAll}
          onToggleShowAll={() => setShowAll(prev => !prev)}
        />
      </div>
    </div>
  )
}
