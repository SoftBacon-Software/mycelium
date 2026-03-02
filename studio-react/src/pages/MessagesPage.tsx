import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { resolveRequest, sendMessage } from '../api/endpoints'
import type { Message } from '../api/types'
import { Avatar, formatTime } from '../components/messages/ChatMessage'
import Badge from '../components/shared/Badge'
import ThreadPanel from '../components/messages/ThreadPanel'

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

// ─── Badge configs ───────────────────────────────────────────────────────────

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

// ─── Agent Message ───────────────────────────────────────────────────────────

function AgentMessage({
  msg,
  isGrouped,
  isExpanded,
  onToggleExpand,
  onResolve,
  isResolving,
  threadCount,
  onOpenThread,
}: {
  msg: Message
  isGrouped: boolean
  isExpanded: boolean
  onToggleExpand: () => void
  onResolve: (id: string) => void
  isResolving: boolean
  threadCount?: number
  onOpenThread?: () => void
}) {
  const content = msg.content
  const shouldTruncate = content.length > 200
  const displayContent =
    shouldTruncate && !isExpanded ? content.slice(0, 200) + '...' : content

  const isPendingRequest = msg.msg_type === 'request' && msg.status === 'pending'

  const threadIndicator = threadCount && threadCount > 1 && onOpenThread ? (
    <button
      onClick={onOpenThread}
      className="flex items-center gap-1 mt-1 text-xs text-accent hover:text-accent-light hover:underline underline-offset-2 transition-colors"
    >
      <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M2 4h12M2 8h8M2 12h5" />
      </svg>
      {threadCount - 1} {threadCount - 1 === 1 ? 'reply' : 'replies'}
    </button>
  ) : null

  const replyButton = onOpenThread ? (
    <button
      onClick={onOpenThread}
      className="opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-accent text-xs flex items-center gap-1 mt-1"
      title="Reply in thread"
    >
      <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M5 5L2 8l3 3" />
        <path d="M2 8h8c2.2 0 4 1.8 4 4v1" />
      </svg>
      Reply
    </button>
  ) : null

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
        {threadIndicator}
        {!threadIndicator && replyButton}
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
          {threadIndicator}
          {!threadIndicator && replyButton}
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function MessagesPage() {
  const messages = useDashboardStore((s) => s.messages)
  const pendingRequests = useDashboardStore((s) => s.pendingRequests)
  const refresh = useDashboardStore((s) => s.refresh)

  const agents = useDashboardStore((s) => s.agents)

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const [composeTo, setComposeTo] = useState('')
  const [composeContent, setComposeContent] = useState('')
  const [composeMsgType, setComposeMsgType] = useState<'message' | 'request' | 'directive'>('message')
  const [sending, setSending] = useState(false)
  const [threadRootMsg, setThreadRootMsg] = useState<Message | null>(null)
  const [timeRange, setTimeRange] = useState<string>('3h')

  const pendingCount = useMemo(() => pendingRequests.length, [pendingRequests])

  const threadCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const msg of messages) {
      if (msg.thread_id) counts.set(msg.thread_id, (counts.get(msg.thread_id) || 0) + 1)
    }
    return counts
  }, [messages])

  const sorted = useMemo(() => {
    const all = [...messages].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    if (timeRange === 'all') return all
    const hours: Record<string, number> = { '1h': 1, '3h': 3, '12h': 12, '24h': 24, '7d': 168 }
    const ms = (hours[timeRange] ?? 3) * 3600000
    const cutoff = Date.now() - ms
    return all.filter((m) => {
      const t = m.created_at.includes('T') ? new Date(m.created_at).getTime() : new Date(m.created_at.replace(' ', 'T') + 'Z').getTime()
      return t >= cutoff
    })
  }, [messages, timeRange])

  const { containerRef, handleScroll } = useAutoScroll([sorted.length])

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSend = useCallback(
    async () => {
      if (!composeContent.trim() || !composeTo.trim()) return
      setSending(true)
      try {
        await sendMessage({
          from_agent: '__admin__',
          to_agent: composeTo.trim(),
          content: composeContent.trim(),
          msg_type: composeMsgType,
        })
        setComposeContent('')
        await refresh()
      } catch (err) {
        console.error('Failed to send message:', err)
      } finally {
        setSending(false)
      }
    },
    [composeContent, composeTo, composeMsgType, refresh],
  )

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
    <div className="flex flex-col h-[calc(100vh-7rem)]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-1 pb-2 shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-text">Agent Comms</h2>
          {pendingCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent/15 text-accent text-xs font-bold tabular-nums">
              {pendingCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value)}
            className="bg-surface-raised text-text text-xs rounded px-2 py-1 border border-border focus:outline-none focus:ring-1 ring-accent"
          >
            <option value="1h">Last hour</option>
            <option value="3h">Last 3 hours</option>
            <option value="12h">Last 12 hours</option>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="all">All time</option>
          </select>
          <span className="text-xs text-text-muted tabular-nums">{sorted.length} msgs</span>
          <button
            onClick={() => refresh()}
            className="text-text-muted hover:text-text transition-colors p-1 rounded-sm hover:bg-surface-raised"
            title="Refresh"
          >
            <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2.5 8a5.5 5.5 0 0 1 9.3-4M13.5 8a5.5 5.5 0 0 1-9.3 4" />
              <path d="M11.5 1v3h3M4.5 15v-3h-3" />
            </svg>
          </button>
        </div>
      </div>

      {/* Message list */}
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
                  threadCount={msg.thread_id ? threadCounts.get(msg.thread_id) : undefined}
                  onOpenThread={() => setThreadRootMsg(msg)}
                />
              </div>
            )
          })
        )}
      </div>

      {/* Compose bar */}
      <div className="shrink-0 border-t border-border px-4 py-3">
        <div className="flex items-end gap-2">
          <select
            value={composeTo}
            onChange={(e) => setComposeTo(e.target.value)}
            className="bg-surface-raised border border-border rounded-sm px-2 py-1.5 text-xs text-text focus:outline-none focus:ring-1 focus:ring-accent/40 w-36 shrink-0"
          >
            <option value="">To...</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
            <option value="all">Broadcast (all)</option>
          </select>
          <select
            value={composeMsgType}
            onChange={(e) => setComposeMsgType(e.target.value as 'message' | 'request' | 'directive')}
            className="bg-surface-raised border border-border rounded-sm px-2 py-1.5 text-xs text-text focus:outline-none focus:ring-1 focus:ring-accent/40 w-24 shrink-0"
          >
            <option value="message">message</option>
            <option value="request">request</option>
            <option value="directive">directive</option>
          </select>
          <textarea
            value={composeContent}
            onChange={(e) => setComposeContent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder="Send a message..."
            rows={1}
            className="flex-1 bg-surface-raised border border-border rounded-sm px-3 py-1.5 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none min-h-[34px] max-h-24"
          />
          <button
            onClick={handleSend}
            disabled={sending || !composeContent.trim() || !composeTo}
            className="px-3 py-1.5 rounded-sm text-sm font-medium bg-accent text-bg hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {sending ? '...' : 'Send'}
          </button>
        </div>
      </div>

      {/* Thread slide-in panel */}
      {threadRootMsg && (
        <ThreadPanel
          message={threadRootMsg}
          onClose={() => setThreadRootMsg(null)}
        />
      )}
    </div>
  )
}
