import { Link } from 'react-router-dom'
import { useVoiceStore } from '../../stores/voiceStore'

export default function VoiceBar() {
  const { isConnected, isMuted, channelName, peers, error, join, leave, toggleMute } =
    useVoiceStore()

  // Disconnected state — show subtle join prompt
  if (!isConnected) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-surface border-t border-border text-xs font-mono">
        <span className="w-2 h-2 rounded-full bg-text-muted/30 shrink-0" />
        <span className="text-text-muted">Voice</span>
        <div className="flex-1" />
        <button
          onClick={() => join()}
          className="px-2 py-0.5 rounded-sm bg-green/20 text-green hover:bg-green/30 transition-colors"
        >
          JOIN
        </button>
      </div>
    )
  }

  const peerCount = peers.length
  const statusText = error
    ? error
    : peerCount === 0
      ? 'Connected'
      : `${peerCount} peer${peerCount !== 1 ? 's' : ''}`

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-surface border-t border-border text-xs font-mono">
      {/* Green dot */}
      <span className="w-2 h-2 rounded-full bg-green animate-pulse shrink-0" />

      {/* Channel name */}
      <Link
        to="/channels"
        className="text-accent hover:underline underline-offset-2"
      >
        #{channelName}
      </Link>

      {/* Status */}
      <span className={error ? 'text-red' : 'text-text-muted'}>
        {statusText}
      </span>

      <div className="flex-1" />

      {/* Mute */}
      <button
        onClick={toggleMute}
        className={`px-2 py-0.5 rounded-sm transition-colors ${
          isMuted
            ? 'bg-red/20 text-red hover:bg-red/30'
            : 'bg-surface-raised text-text-dim hover:text-text hover:bg-surface-raised/80'
        }`}
      >
        {isMuted ? 'UNMUTE' : 'MUTE'}
      </button>

      {/* Leave */}
      <button
        onClick={leave}
        className="px-2 py-0.5 rounded-sm bg-red/20 text-red hover:bg-red/30 transition-colors"
      >
        LEAVE
      </button>
    </div>
  )
}
