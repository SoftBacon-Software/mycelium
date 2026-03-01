import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { useAuthStore } from '../stores/authStore'
import {
  fetchChannelMessages,
  fetchChannelUnread,
  sendChannelMessage,
  markChannelRead,
} from '../api/endpoints'
import type { Channel, ChannelMessage } from '../api/types'
import { Avatar, formatTime } from '../components/messages/ChatMessage'
import Badge from '../components/shared/Badge'

// ─── Types ──────────────────────────────────────────────────────────────────

type ChannelType = Channel['type']

interface UnreadMap {
  [channelId: number]: { name: string; slug: string; unread: number }
}

// ─── Channel type config ────────────────────────────────────────────────────

const CHANNEL_TYPE_CONFIG: Record<ChannelType, { label: string; icon: string; variant: 'default' | 'green' | 'red' | 'blue' | 'accent' | 'purple' | 'pink' | 'muted' }> = {
  general: { label: 'General', icon: '#', variant: 'default' },
  announcement: { label: 'Announcements', icon: '\u{1F4E2}', variant: 'accent' },
  dm: { label: 'Direct Messages', icon: '\u{1F4AC}', variant: 'purple' },
  plan: { label: 'Plans', icon: '\u{1F4CB}', variant: 'blue' },
  bug: { label: 'Bugs', icon: '\u{1F41B}', variant: 'red' },
  task: { label: 'Tasks', icon: '\u{2705}', variant: 'green' },
}

const CHANNEL_GROUP_ORDER: ChannelType[] = ['general', 'announcement', 'dm', 'plan', 'bug', 'task']

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDateLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)

  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}

function isSameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

function parseMetadata(raw: string): Record<string, unknown> | null {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function getSenderDisplay(fromAgent: string): string {
  if (fromAgent === '__admin__') return 'Admin'
  if (fromAgent.startsWith('__user:')) return fromAgent.slice(7)
  return fromAgent
}

// ─── Date separator ─────────────────────────────────────────────────────────

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

// ─── Channel Message Bubble ─────────────────────────────────────────────────

function ChannelMessageBubble({
  msg,
  isGrouped,
  isExpanded,
  onToggleExpand,
}: {
  msg: ChannelMessage
  isGrouped: boolean
  isExpanded: boolean
  onToggleExpand: () => void
}) {
  const content = msg.content
  const shouldTruncate = content.length > 300
  const displayContent =
    shouldTruncate && !isExpanded ? content.slice(0, 300) + '...' : content
  const senderName = getSenderDisplay(msg.from_agent)

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
            {formatTime(msg.created_at)}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="group pt-2 pb-0.5 hover:bg-surface/50 transition-colors">
      <div className="flex items-start gap-2">
        <Avatar name={senderName} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-sm text-text">{senderName}</span>
            <span className="text-text-muted text-xs">{formatTime(msg.created_at)}</span>
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

// ─── Channel Sidebar Item ───────────────────────────────────────────────────

function ChannelListItem({
  channel,
  isSelected,
  unreadCount,
  onClick,
}: {
  channel: Channel
  isSelected: boolean
  unreadCount: number
  onClick: () => void
}) {
  const config = CHANNEL_TYPE_CONFIG[channel.type] || CHANNEL_TYPE_CONFIG.general

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm rounded-sm transition-colors text-left ${
        isSelected
          ? 'bg-surface-raised text-text'
          : 'text-text-dim hover:text-text hover:bg-surface-raised/50'
      }`}
    >
      <span className="text-text-muted text-xs shrink-0 w-4 text-center">{config.icon}</span>
      <span className="truncate flex-1">{channel.name}</span>
      {unreadCount > 0 && (
        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent/15 text-accent text-xs font-bold tabular-nums shrink-0">
          {unreadCount}
        </span>
      )}
    </button>
  )
}

// ─── Channel Chat Area ──────────────────────────────────────────────────────

function ChannelChatArea({
  channel,
  messages,
  loading,
  onSend,
}: {
  channel: Channel
  messages: ChannelMessage[]
  loading: boolean
  onSend: (content: string) => Promise<void>
}) {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())

  const sorted = useMemo(
    () => [...messages].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
    [messages],
  )

  const { containerRef, handleScroll } = useAutoScroll([sorted.length])

  function toggleExpand(id: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleSend() {
    const text = input.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await onSend(text)
      setInput('')
    } catch (err) {
      console.error('Failed to send channel message:', err)
    } finally {
      setSending(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const config = CHANNEL_TYPE_CONFIG[channel.type] || CHANNEL_TYPE_CONFIG.general

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Channel header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        <span className="text-text-muted text-sm">{config.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-text truncate">{channel.name}</h2>
            <Badge variant={config.variant}>{channel.type}</Badge>
            {channel.status === 'archived' && <Badge variant="muted">archived</Badge>}
          </div>
          {channel.description && (
            <p className="text-xs text-text-muted truncate mt-0.5">{channel.description}</p>
          )}
        </div>
      </div>

      {/* Message list */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 pb-2"
      >
        {loading && messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-text-muted text-sm">Loading messages...</p>
          </div>
        ) : sorted.length === 0 ? (
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
                <ChannelMessageBubble
                  msg={msg}
                  isGrouped={isGrouped}
                  isExpanded={expandedIds.has(msg.id)}
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
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Message #${channel.name}...`}
            className="flex-1 bg-surface-raised border border-border rounded px-3 py-2 text-text text-sm placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-ring"
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
  const refresh = useDashboardStore((s) => s.refresh)

  const [selectedChannelId, setSelectedChannelId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ChannelMessage[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [unreadMap, setUnreadMap] = useState<UnreadMap>({})

  // Group channels by type
  const groupedChannels = useMemo(() => {
    const groups: Partial<Record<ChannelType, Channel[]>> = {}
    const activeChannels = channels.filter((c) => c.status === 'active')
    for (const ch of activeChannels) {
      if (!groups[ch.type]) groups[ch.type] = []
      groups[ch.type]!.push(ch)
    }
    return groups
  }, [channels])

  const selectedChannel = useMemo(
    () => channels.find((c) => c.id === selectedChannelId) || null,
    [channels, selectedChannelId],
  )

  // Fetch unread counts
  const loadUnread = useCallback(async () => {
    try {
      const data = await fetchChannelUnread()
      setUnreadMap(data)
    } catch (err) {
      console.error('Failed to fetch unread counts:', err)
    }
  }, [])

  // Load messages for selected channel
  const loadMessages = useCallback(async (channelId: number, showLoading = true) => {
    if (showLoading) setMessagesLoading(true)
    try {
      const data = await fetchChannelMessages(channelId, 100)
      setMessages(data)
    } catch (err) {
      console.error('Failed to fetch channel messages:', err)
    } finally {
      if (showLoading) setMessagesLoading(false)
    }
  }, [])

  // Initial load
  useEffect(() => {
    refresh()
    loadUnread()
  }, [refresh, loadUnread])

  // Auto-select first channel if none selected
  useEffect(() => {
    if (selectedChannelId === null && channels.length > 0) {
      const activeChannels = channels.filter((c) => c.status === 'active')
      if (activeChannels.length > 0) {
        setSelectedChannelId(activeChannels[0].id)
      }
    }
  }, [channels, selectedChannelId])

  // Load messages when channel changes
  useEffect(() => {
    if (selectedChannelId !== null) {
      loadMessages(selectedChannelId)
      // Mark channel as read
      markChannelRead(selectedChannelId).catch((err) =>
        console.error('Failed to mark channel read:', err),
      )
    } else {
      setMessages([])
    }
  }, [selectedChannelId, loadMessages])

  // Poll messages every 5s when a channel is selected
  useEffect(() => {
    if (selectedChannelId === null) return

    const interval = setInterval(() => {
      loadMessages(selectedChannelId, false)
      loadUnread()
    }, 5000)

    return () => clearInterval(interval)
  }, [selectedChannelId, loadMessages, loadUnread])

  // Handle channel selection
  function handleSelectChannel(channelId: number) {
    setSelectedChannelId(channelId)
    // Clear unread for this channel locally
    setUnreadMap((prev) => {
      const next = { ...prev }
      if (next[channelId]) {
        next[channelId] = { ...next[channelId], unread: 0 }
      }
      return next
    })
  }

  // Send message
  async function handleSend(content: string) {
    if (selectedChannelId === null) return
    await sendChannelMessage(selectedChannelId, content)
    await loadMessages(selectedChannelId, false)
  }

  // Total unread across all channels
  const totalUnread = useMemo(() => {
    return Object.values(unreadMap).reduce((sum, ch) => sum + (ch.unread || 0), 0)
  }, [unreadMap])

  return (
    <div className="flex h-[calc(100vh-7rem)] rounded-sm overflow-hidden border border-border">
      {/* Channel sidebar */}
      <div className="w-60 bg-surface border-r border-border flex flex-col shrink-0">
        {/* Sidebar header */}
        <div className="flex items-center justify-between px-3 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold text-text">Channels</h2>
          {totalUnread > 0 && (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent/15 text-accent text-xs font-bold tabular-nums">
              {totalUnread}
            </span>
          )}
        </div>

        {/* Channel groups */}
        <div className="flex-1 overflow-y-auto py-2">
          {channels.length === 0 ? (
            <div className="px-3 py-4 text-center">
              <p className="text-text-muted text-xs">No channels yet.</p>
            </div>
          ) : (
            CHANNEL_GROUP_ORDER.map((type) => {
              const group = groupedChannels[type]
              if (!group || group.length === 0) return null
              const config = CHANNEL_TYPE_CONFIG[type]

              return (
                <div key={type} className="mb-2">
                  <p className="px-3 py-1 text-[10px] text-text-muted uppercase tracking-wider font-semibold">
                    {config.label}
                  </p>
                  {group.map((ch) => (
                    <ChannelListItem
                      key={ch.id}
                      channel={ch}
                      isSelected={ch.id === selectedChannelId}
                      unreadCount={unreadMap[ch.id]?.unread || 0}
                      onClick={() => handleSelectChannel(ch.id)}
                    />
                  ))}
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col min-w-0 bg-bg">
        {selectedChannel ? (
          <ChannelChatArea
            channel={selectedChannel}
            messages={messages}
            loading={messagesLoading}
            onSend={handleSend}
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-text-muted text-sm">Select a channel to start chatting</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
