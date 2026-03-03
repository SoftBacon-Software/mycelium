import type { TeamChat, Message } from '../../api/types'
import { formatTime } from '../../utils/time'
import { getSenderDisplay } from '../../utils/sender'

// ─── Avatar helpers ─────────────────────────────────────────────────────────

function getAvatarConfig(name: string | null | undefined): { bg: string; initial: string } {
  if (!name) return { bg: 'bg-text-muted', initial: '?' }
  const lower = name.toLowerCase()
  if (lower === 'admin' || lower === '__admin__' || lower.startsWith('admin')) {
    return { bg: 'bg-accent', initial: 'A' }
  }
  if (lower === 'system' || lower === '__system__') {
    return { bg: 'bg-text-muted', initial: 'S' }
  }
  if (lower.startsWith('hijack')) {
    return { bg: 'bg-purple', initial: 'H' }
  }
  if (lower.startsWith('greatness')) {
    return { bg: 'bg-green', initial: 'G' }
  }
  if (lower.startsWith('macbook')) {
    return { bg: 'bg-blue', initial: 'M' }
  }
  if (lower.startsWith('unakron')) {
    return { bg: 'bg-accent', initial: 'U' }
  }
  return { bg: 'bg-blue', initial: name.charAt(0).toUpperCase() || '?' }
}

function Avatar({ name, size = 'sm' }: { name: string | null | undefined; size?: 'sm' | 'md' }) {
  const { bg, initial } = getAvatarConfig(name)
  const dim = size === 'sm' ? 'w-7 h-7 text-xs' : 'w-8 h-8 text-sm'
  return (
    <span
      className={`${dim} ${bg} rounded-full inline-flex items-center justify-center font-semibold text-bg shrink-0 select-none`}
    >
      {initial}
    </span>
  )
}

// ─── Types ───────────────────────────────────────────────────────────────────

function isAgentMessage(msg: TeamChat | Message): msg is Message {
  return 'from_agent' in msg
}

function getSenderName(msg: TeamChat | Message): string {
  return getSenderDisplay(isAgentMessage(msg) ? msg.from_agent : msg.display_name)
}

// ─── Main component ─────────────────────────────────────────────────────────

interface ChatMessageProps {
  message: TeamChat | Message
  isGrouped: boolean
  isExpanded: boolean
  onToggleExpand: () => void
}

const TRUNCATE_LENGTH = 200

export default function ChatMessage({
  message,
  isGrouped,
  isExpanded,
  onToggleExpand,
}: ChatMessageProps) {
  const content = message.content
  const shouldTruncate = content.length > TRUNCATE_LENGTH
  const displayContent =
    shouldTruncate && !isExpanded
      ? content.slice(0, TRUNCATE_LENGTH) + '...'
      : content

  const senderName = getSenderName(message)

  // Grouped message — just content + inline timestamp
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

  // New sender — full header
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

// Re-export Avatar for use in AgentComms
export { Avatar, getAvatarConfig, formatTime }
