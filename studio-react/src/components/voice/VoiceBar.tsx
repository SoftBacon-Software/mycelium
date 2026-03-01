import { useVoice } from '../../hooks/useVoice';

export default function VoiceBar() {
  const { isConnected, isMuted, peers, error, join, leave, toggleMute } = useVoice();

  const peerCount = peers.length;

  const statusText = error
    ? error
    : !isConnected
      ? 'Not connected'
      : peerCount === 0
        ? 'Connected'
        : `${peerCount} peer${peerCount !== 1 ? 's' : ''}`;

  return (
    <div className="flex items-center gap-2 px-3 py-1 rounded bg-surface-raised/50 text-xs font-mono">
      {/* Label */}
      <span className="text-text-muted select-none">VOICE</span>

      {/* Status */}
      <span
        className={
          error
            ? 'text-red'
            : isConnected
              ? 'text-green'
              : 'text-text-muted'
        }
        title={error || undefined}
      >
        {statusText}
      </span>

      {/* Join button — shown when disconnected */}
      {!isConnected && (
        <button
          onClick={join}
          className="px-2 py-0.5 rounded-sm bg-green/20 text-green hover:bg-green/30 transition-colors"
        >
          JOIN
        </button>
      )}

      {/* Mute button — shown when connected */}
      {isConnected && (
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
      )}

      {/* Leave button — shown when connected */}
      {isConnected && (
        <button
          onClick={leave}
          className="px-2 py-0.5 rounded-sm bg-red/20 text-red hover:bg-red/30 transition-colors"
        >
          LEAVE
        </button>
      )}
    </div>
  );
}
