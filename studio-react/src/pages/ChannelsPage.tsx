import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { useAuthStore } from '../stores/authStore'
import { fetchChannelMessages, fetchChannelUnread, sendChannelMessage, markChannelRead } from '../api/endpoints'
import type { Channel, ChannelMessage } from '../api/types'
import { Avatar, formatTime } from '../components/messages/ChatMessage'
import Badge from '../components/shared/Badge'
import { formatDateLabel } from '../utils/time'
import { useVoice } from '../hooks/useVoice'

// ─── Types ──────────────────────────────────────────────────────────────────

type ChannelType = Channel['type']
type BadgeVariant = 'default' | 'green' | 'red' | 'blue' | 'accent' | 'purple' | 'pink' | 'muted'

const CHANNEL_TYPE_CONFIG: Record<ChannelType, { label: string; icon: string; variant: BadgeVariant }> = {
  general: { label: 'General', icon: '#', variant: 'default' },
  announcement: { label: 'Announcements', icon: '\u{1F4E2}', variant: 'accent' },
  dm: { label: 'Direct Messages', icon: '\u{1F4AC}', variant: 'purple' },
  plan: { label: 'Plans', icon: '\u{1F4CB}', variant: 'blue' },
  bug: { label: 'Bugs', icon: '\u{1F41B}', variant: 'red' },
  task: { label: 'Tasks', icon: '\u2705', variant: 'green' },
}

const CHANNEL_TYPE_ORDER: ChannelType[] = ['general', 'announcement', 'dm', 'plan', 'bug', 'task']

const TRUNCATE_LENGTH = 300

// ─── Helpers ────────────────────────────────────────────────────────────────


function isSameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

function getSenderDisplay(fromAgent: string): string {
  if (fromAgent === '__admin__') return 'Admin'
  if (fromAgent.startsWith('__user:')) return fromAgent.slice(7)
  return fromAgent
}

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

// ─── Voice Panel ────────────────────────────────────────────────────────────

function VoicePanel() {
  const { isConnected, isMuted, peers, error, join, leave, toggleMute } = useVoice()

  const statusText = useMemo(() => {
    if (!isConnected) return 'Not connected'
    if (peers.length === 0) return 'Connected'
    return `${peers.length} peer${peers.length !== 1 ? 's' : ''}`
  }, [isConnected, peers.length])

  return (
    <div className="border-t border-border px-3 py-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-text-muted text-[10px] font-semibold tracking-wider uppercase">Voice</span>
        <span
          className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green' : 'bg-text-muted'}`}
        />
      </div>

      {/* Status */}
      <p className="text-text-dim text-xs mb-2">{statusText}</p>

      {/* Error */}
      {error && (
        <p className="text-red text-xs mb-2">{error}</p>
      )}

      {/* Controls */}
      {!isConnected ? (
        <button
          onClick={() => join('voice')}
          className="w-full px-3 py-1.5 rounded-sm text-xs font-medium bg-green/15 text-green hover:bg-green/25 transition-colors"
        >
          Join
        </button>
      ) : (
        <div className="flex items-center gap-2">
          <button
            onClick={toggleMute}
            className={`flex-1 px-3 py-1.5 rounded-sm text-xs font-medium transition-colors ${
              isMuted
                ? 'bg-red/15 text-red hover:bg-red/25'
                : 'bg-green/15 text-green hover:bg-green/25'
            }`}
          >
            {isMuted ? 'Unmute' : 'Mute'}
          </button>
          <button
            onClick={leave}
            className="flex-1 px-3 py-1.5 rounded-sm text-xs font-medium bg-red/15 text-red hover:bg-red/25 transition-colors"
          >
            Leave
          </button>
        </div>
      )}
    </div>
  )
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
}: {
  channels: Channel[]
  activeId: number | null
  unreadMap: Record<number, number>
  onSelect: (id: number) => void
}) {
  const totalUnread = useMemo(
    () => Object.values(unreadMap).reduce((sum, n) => sum + n, 0),
    [unreadMap],
  )

  // Group channels by type in defined order
  const grouped = useMemo(() => {
    const map = new Map<ChannelType, Channel[]>()
    for (const t of CHANNEL_TYPE_ORDER) {
      map.set(t, [])
    }
    for (const ch of channels) {
      if (ch.status !== 'active') continue
      const list = map.get(ch.type)
      if (list) list.push(ch)
    }
    return map
  }, [channels])

  return (
    <div className="w-60 bg-surface flex flex-col shrink-0 min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-border shrink-0">
        <span className="font-semibold text-sm text-text">Channels</span>
        {totalUnread > 0 && (
          <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent/15 text-accent text-xs font-bold tabular-nums">
            {totalUnread}
          </span>
        )}
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto py-2">
        {CHANNEL_TYPE_ORDER.map((type) => {
          const list = grouped.get(type)
          if (!list || list.length === 0) return null
          const config = CHANNEL_TYPE_CONFIG[type]

          return (
            <div key={type} className="mb-2">
              <div className="px-3 py-1">
                <span className="text-text-muted text-[10px] font-semibold tracking-wider uppercase">
                  {config.label}
                </span>
              </div>
              {list.map((ch) => {
                const isActive = ch.id === activeId
                const unread = unreadMap[ch.id] || 0

                return (
                  <button
                    key={ch.id}
                    onClick={() => onSelect(ch.id)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                      isActive
                        ? 'bg-surface-raised text-text'
                        : 'text-text-dim hover:text-text hover:bg-surface-raised/50'
                    }`}
                  >
                    <span className="w-5 text-center shrink-0 text-xs">{config.icon}</span>
                    <span className="truncate flex-1">{ch.name}</span>
                    {unread > 0 && (
                      <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent/15 text-accent text-xs font-bold tabular-nums shrink-0">
                        {unread}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>

      {/* Voice Panel */}
      <VoicePanel />
    </div>
  )
}

// ─── Chat Area ──────────────────────────────────────────────────────────────

function ChatArea({
  channel,
  messages,
  onSend,
  sending,
}: {
  channel: Channel | null
  messages: ChannelMessage[]
  onSend: (content: string) => void
  sending: boolean
}) {
  const [input, setInput] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())

  const sorted = useMemo(
    () => [...messages].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
    [messages],
  )

  const { containerRef, handleScroll } = useAutoScroll([sorted.length])

  // Reset expanded state when channel changes
  useEffect(() => {
    setExpandedIds(new Set())
  }, [channel?.id])

  function toggleExpand(id: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
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

  const config = CHANNEL_TYPE_CONFIG[channel.type]

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-bg">
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
      </div>

      {/* Message list */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 pb-2"
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
      const msgs = await fetchChannelMessages(activeChannelId, 100)
      setMessages(msgs)
    } catch (err) {
      console.error('Failed to fetch channel messages:', err)
    }
  }, [activeChannelId])

  // Mark channel as read and load messages when selecting a channel
  const handleSelectChannel = useCallback(
    async (id: number) => {
      setActiveChannelId(id)
      setMessages([])
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
    <div className="h-[calc(100vh-7rem)] rounded-sm overflow-hidden border border-border flex">
      <ChannelSidebar
        channels={channels}
        activeId={activeChannelId}
        unreadMap={unreadMap}
        onSelect={handleSelectChannel}
      />
      <ChatArea
        channel={activeChannel}
        messages={messages}
        onSend={handleSend}
        sending={sending}
      />
    </div>
  )
}
