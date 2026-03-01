import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { useAuthStore } from '../stores/authStore'
import { sendTeamChat, resolveRequest } from '../api/endpoints'
import type { TeamChat, Message } from '../api/types'
import ChatMessage, { Avatar, formatTime } from '../components/messages/ChatMessage'
import Badge from '../components/shared/Badge'

type Tab = 'team' | 'agent'

// ─── Date separator ──────────────────────────────────────────────────────────

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

// ─── Auto-scroll hook ────────────────────────────────────────────────────────

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

// ─── Team Chat Tab ───────────────────────────────────────────────────────────

function TeamChatTab() {
  const teamChat = useDashboardStore((s) => s.teamChat)
  const refresh = useDashboardStore((s) => s.refresh)
  const user = useAuthStore((s) => s.user)

  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  const sorted = useMemo(
    () => [...teamChat].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
    [teamChat],
  )

  const { containerRef, handleScroll } = useAutoScroll([sorted.length])

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleSend() {
    const text = input.trim()
    if (!text || !user || sending) return
    setSending(true)
    try {
      await sendTeamChat(text, user.username, 'operator', user.display_name || user.username)
      setInput('')
      await refresh()
    } catch (err) {
      console.error('Failed to send team chat:', err)
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

  return (
    <div className="flex flex-col flex-1 min-h-0">
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
            const isGrouped = !!prev && !showDate && prev.display_name === msg.display_name

            return (
              <div key={msg.id}>
                {showDate && <DateSeparator date={msg.created_at} />}
                <ChatMessage
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
      <div className="px-4 py-3 border-t border-border">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
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

// ─── Agent Comms Tab ─────────────────────────────────────────────────────────

const msgTypeBadge: Record<string, 'red' | 'accent' | 'default'> = {
  directive: 'red',
  request: 'accent',
  message: 'default',
}

const statusBadgeVariant: Record<string, 'green' | 'blue' | 'accent' | 'muted' | 'default'> = {
  read: 'green',
  delivered: 'blue',
  pending: 'accent',
  resolved: 'muted',
}

function AgentMessage({
  msg,
  isGrouped,
  isExpanded,
  onToggleExpand,
  onResolve,
  isResolving,
}: {
  msg: Message
  isGrouped: boolean
  isExpanded: boolean
  onToggleExpand: () => void
  onResolve: (id: string) => void
  isResolving: boolean
}) {
  const content = msg.content
  const shouldTruncate = content.length > 200
  const displayContent =
    shouldTruncate && !isExpanded ? content.slice(0, 200) + '...' : content

  const isPendingRequest = msg.msg_type === 'request' && msg.status === 'pending'

  if (isGrouped) {
    return (
      <div className="group pl-9 py-0.5 hover:bg-surface/50 transition-colors">
        <p className="text-text text-sm whitespace-pre-wrap break-words">
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
        {isPendingRequest && (
          <button
            onClick={() => onResolve(msg.id)}
            disabled={isResolving}
            className="mt-1 px-3 py-1 rounded-sm text-xs bg-green/15 text-green hover:bg-green/25 transition-colors disabled:opacity-50"
          >
            {isResolving ? 'Resolving...' : 'Resolve'}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="group pt-2 pb-0.5 hover:bg-surface/50 transition-colors">
      <div className="flex items-start gap-2">
        <Avatar name={msg.from_agent} />
        <div className="flex-1 min-w-0">
          {/* Header */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm text-text">{msg.from_agent}</span>
            <svg viewBox="0 0 12 12" className="w-3 h-3 text-text-muted shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M2 6h8M7 3l3 3-3 3" />
            </svg>
            <span className="font-semibold text-sm text-text-dim">{msg.to_agent}</span>
            <Badge variant={msgTypeBadge[msg.msg_type] ?? 'default'}>{msg.msg_type}</Badge>
            <Badge variant={statusBadgeVariant[msg.status] ?? 'default'}>{msg.status}</Badge>
            <span className="text-text-muted text-xs">{formatTime(msg.created_at)}</span>
          </div>

          {/* Content */}
          <p className="text-text text-sm whitespace-pre-wrap break-words mt-1">
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

          {/* Resolve button for pending requests */}
          {isPendingRequest && (
            <button
              onClick={() => onResolve(msg.id)}
              disabled={isResolving}
              className="mt-1.5 px-3 py-1 rounded-sm text-xs bg-green/15 text-green hover:bg-green/25 transition-colors disabled:opacity-50"
            >
              {isResolving ? 'Resolving...' : 'Resolve'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function AgentCommsTab() {
  const messages = useDashboardStore((s) => s.messages)
  const refresh = useDashboardStore((s) => s.refresh)

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [resolvingId, setResolvingId] = useState<string | null>(null)

  const sorted = useMemo(
    () => [...messages].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
    [messages],
  )

  const { containerRef, handleScroll } = useAutoScroll([sorted.length])

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleResolve = useCallback(
    async (id: string) => {
      setResolvingId(id)
      try {
        await resolveRequest(id, 'resolved')
        await refresh()
      } catch (err) {
        console.error('Failed to resolve request:', err)
      } finally {
        setResolvingId(null)
      }
    },
    [refresh],
  )

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 pb-2"
      >
        {sorted.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-text-muted text-sm">No agent communications yet.</p>
          </div>
        ) : (
          sorted.map((msg, i) => {
            const prev = i > 0 ? sorted[i - 1] : null
            const showDate = !prev || !isSameDay(prev.created_at, msg.created_at)
            const isGrouped =
              !!prev &&
              !showDate &&
              prev.from_agent === msg.from_agent &&
              prev.to_agent === msg.to_agent

            return (
              <div key={msg.id}>
                {showDate && <DateSeparator date={msg.created_at} />}
                <AgentMessage
                  msg={msg}
                  isGrouped={isGrouped}
                  isExpanded={expandedIds.has(msg.id)}
                  onToggleExpand={() => toggleExpand(msg.id)}
                  onResolve={handleResolve}
                  isResolving={resolvingId === msg.id}
                />
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function MessagesPage() {
  const [tab, setTab] = useState<Tab>('team')
  const pendingRequests = useDashboardStore((s) => s.pendingRequests)
  const messages = useDashboardStore((s) => s.messages)

  // Count unread/pending items for badge
  const agentUnread = useMemo(() => {
    return pendingRequests.length
  }, [pendingRequests])

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)]">
      {/* Tab bar */}
      <div className="flex items-center gap-1 bg-surface rounded-sm p-1 mx-4 mt-1 mb-2 shrink-0">
        <button
          onClick={() => setTab('team')}
          className={`px-4 py-1.5 rounded-sm text-sm font-medium transition-colors ${
            tab === 'team'
              ? 'bg-surface-raised text-text'
              : 'text-text-muted hover:text-text-dim'
          }`}
        >
          Team Chat
        </button>
        <button
          onClick={() => setTab('agent')}
          className={`px-4 py-1.5 rounded-sm text-sm font-medium transition-colors flex items-center gap-2 ${
            tab === 'agent'
              ? 'bg-surface-raised text-text'
              : 'text-text-muted hover:text-text-dim'
          }`}
        >
          Agent Comms
          {agentUnread > 0 && (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent/15 text-accent text-xs font-bold tabular-nums">
              {agentUnread}
            </span>
          )}
        </button>
      </div>

      {/* Tab content */}
      {tab === 'team' ? <TeamChatTab /> : <AgentCommsTab />}
    </div>
  )
}
