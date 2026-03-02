import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchThreadMessages, sendMessage } from '../../api/endpoints'
import { useDashboardStore } from '../../stores/dashboardStore'
import type { Message } from '../../api/types'
import { Avatar, formatTime } from './ChatMessage'
import Badge from '../shared/Badge'

const msgTypeBadge: Record<string, 'red' | 'accent' | 'default'> = {
  directive: 'red',
  request: 'accent',
  message: 'default',
}

interface ThreadPanelProps {
  message: Message
  onClose: () => void
}

export default function ThreadPanel({ message, onClose }: ThreadPanelProps) {
  const refresh = useDashboardStore((s) => s.refresh)
  const [threadMessages, setThreadMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [replyContent, setReplyContent] = useState('')
  const [sending, setSending] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  const threadId = message.thread_id || message.id.toString()

  const loadThread = useCallback(async () => {
    setLoading(true)
    try {
      const msgs = await fetchThreadMessages(threadId)
      // Filter out the root message — we show it separately from props
      setThreadMessages(
        msgs
          .filter((m) => m.id.toString() !== message.id.toString())
          .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
      )
    } catch (err) {
      console.error('Failed to load thread:', err)
    } finally {
      setLoading(false)
    }
  }, [threadId, message.id])

  useEffect(() => {
    loadThread()
  }, [loadThread])

  // Scroll to bottom when messages load
  useEffect(() => {
    if (!loading && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [loading, threadMessages.length])

  // Escape key closes panel
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  const handleSend = useCallback(async () => {
    const content = replyContent.trim()
    if (!content || sending) return
    setSending(true)
    try {
      await sendMessage({
        from_agent: '__admin__',
        to_agent: message.from_agent,
        project_id: message.project_id,
        content,
        thread_id: threadId,
        msg_type: 'message',
      })
      setReplyContent('')
      await loadThread()
      await refresh()
    } catch (err) {
      console.error('Failed to send reply:', err)
    } finally {
      setSending(false)
    }
  }, [replyContent, sending, message.from_agent, message.project_id, threadId, loadThread, refresh])

  const replyCount = threadMessages.length

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-bg/60 z-40"
        onClick={onClose}
        aria-hidden
      />

      {/* Slide-in panel */}
      <div className="fixed top-0 right-0 h-full w-full max-w-lg bg-surface border-l border-border z-50 flex flex-col animate-in slide-in-from-right">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-text">Thread</h2>
            {!loading && (
              <span className="text-xs text-text-muted">
                {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-text-muted hover:text-text transition-colors p-1 -mr-1 shrink-0"
            aria-label="Close"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div ref={bodyRef} className="flex-1 overflow-y-auto px-4 py-3">
          {/* Root message */}
          <div className="pb-3">
            <div className="flex items-start gap-2">
              <Avatar name={message.from_agent} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm text-text">{message.from_agent}</span>
                  <svg viewBox="0 0 12 12" className="w-3 h-3 text-text-muted shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M2 6h8M7 3l3 3-3 3" />
                  </svg>
                  <span className="font-semibold text-sm text-text-dim">{message.to_agent}</span>
                  <Badge variant={msgTypeBadge[message.msg_type] ?? 'default'}>{message.msg_type}</Badge>
                  <span className="text-text-muted text-xs">{formatTime(message.created_at)}</span>
                </div>
                <p className="text-text text-sm whitespace-pre-wrap break-words mt-1">
                  {message.content}
                </p>
              </div>
            </div>
          </div>

          {/* Divider */}
          {replyCount > 0 && (
            <div className="flex items-center gap-3 py-2">
              <div className="flex-1 h-px bg-border" />
              <span className="text-text-muted text-xs font-medium shrink-0">
                {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
              </span>
              <div className="flex-1 h-px bg-border" />
            </div>
          )}

          {/* Thread replies */}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-text-muted text-sm">Loading thread...</span>
            </div>
          ) : (
            threadMessages.map((msg) => (
              <div key={msg.id} className="py-1.5">
                <div className="flex items-start gap-2">
                  <Avatar name={msg.from_agent} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-text">{msg.from_agent}</span>
                      <span className="text-text-muted text-xs">{formatTime(msg.created_at)}</span>
                    </div>
                    <p className="text-text text-sm whitespace-pre-wrap break-words mt-0.5">
                      {msg.content}
                    </p>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer — reply composer */}
        <div className="border-t border-border p-4 shrink-0">
          <textarea
            value={replyContent}
            onChange={(e) => setReplyContent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                handleSend()
              }
            }}
            rows={3}
            placeholder="Reply in thread..."
            className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none"
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-text-muted">
              {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to send
            </span>
            <button
              type="button"
              onClick={handleSend}
              disabled={!replyContent.trim() || sending}
              className="px-4 py-1.5 rounded-sm text-sm font-medium bg-accent text-bg hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {sending ? 'Sending...' : 'Reply'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
