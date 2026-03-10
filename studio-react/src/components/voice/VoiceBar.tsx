import { useState, useEffect } from 'react'
import { useVoiceStore, type VoicePeer } from '../../stores/voiceStore'
import { fetchTeams } from '../../api/endpoints'
import type { Team } from '../../api/types'
import { Mic, MicOff, PhoneOff, Phone } from 'lucide-react'

function PeerPill({ peer }: { peer: VoicePeer }) {
  const initial = (peer.name || '?')[0].toUpperCase()

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-surface-raised border border-border/50 text-xs font-mono" title={peer.name}>
      {/* Avatar circle with talk pulse */}
      <span className={`relative flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold shrink-0 ${
        peer.talking ? 'bg-green/30 text-green' : 'bg-surface text-text-muted'
      }`}>
        {peer.talking && (
          <span className="absolute inset-0 rounded-full bg-green/20 animate-ping" />
        )}
        {peer.muted && (
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-red flex items-center justify-center">
            <MicOff size={6} className="text-white" />
          </span>
        )}
        {initial}
      </span>
      <span className="text-text-dim truncate max-w-[80px]">{peer.name}</span>
    </div>
  )
}

export default function VoiceBar() {
  const { isConnected, isMuted, channelName, peers, error, join, leave, toggleMute } = useVoiceStore()
  const [teams, setTeams] = useState<Team[]>([])
  const [selectedTeam, setSelectedTeam] = useState('')
  const [loadingTeams, setLoadingTeams] = useState(false)

  useEffect(() => {
    if (!isConnected && teams.length === 0) {
      setLoadingTeams(true)
      fetchTeams()
        .then(setTeams)
        .catch(() => {})
        .finally(() => setLoadingTeams(false))
    }
  }, [isConnected, teams.length])

  function handleJoin() {
    const channel = selectedTeam ? `team-${selectedTeam}` : 'voice'
    join(channel)
  }

  // ─── Disconnected state ────────────────────────────────────────────────────

  if (!isConnected) {
    return (
      <div className="flex items-center gap-3 px-4 py-1.5 bg-surface border-b border-border text-xs font-mono shrink-0">
        <span className="w-2 h-2 rounded-full bg-text-muted shrink-0" />
        <span className="text-text-muted">Voice</span>

        {/* Team chooser */}
        <select
          value={selectedTeam}
          onChange={(e) => setSelectedTeam(e.target.value)}
          className="bg-surface-raised border border-border rounded px-2 py-0.5 text-xs text-text-dim appearance-none cursor-pointer min-w-[120px]"
          disabled={loadingTeams}
        >
          <option value="">General lobby</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>

        <div className="flex-1" />

        {error && <span className="text-red text-[10px]">{error}</span>}

        <button
          onClick={handleJoin}
          className="flex items-center gap-1 px-2.5 py-0.5 rounded-sm bg-green/15 text-green hover:bg-green/25 transition-colors"
        >
          <Phone size={10} />
          JOIN
        </button>
      </div>
    )
  }

  // ─── Connected state ───────────────────────────────────────────────────────

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 bg-surface border-b border-border text-xs font-mono shrink-0 flex-wrap">
      {/* Green dot */}
      <span className="w-2 h-2 rounded-full bg-green animate-pulse shrink-0" />

      {/* Channel name pill */}
      <span className="px-2 py-0.5 rounded-full bg-accent/10 text-accent text-[11px] font-medium shrink-0">
        #{channelName}
      </span>

      {/* Participant pills */}
      <div className="flex items-center gap-1 flex-wrap">
        {peers.map((peer) => (
          <PeerPill key={peer.id} peer={peer} />
        ))}
        {peers.length === 0 && (
          <span className="text-text-muted text-[10px]">No other peers</span>
        )}
      </div>

      <div className="flex-1" />

      {error && <span className="text-red text-[10px]">{error}</span>}

      {/* Mute toggle */}
      <button
        onClick={toggleMute}
        className={`flex items-center gap-1 px-2 py-0.5 rounded-sm transition-colors ${
          isMuted
            ? 'bg-red/20 text-red hover:bg-red/30'
            : 'bg-surface-raised text-text-dim hover:text-text'
        }`}
        title={isMuted ? 'Unmute' : 'Mute'}
      >
        {isMuted ? <MicOff size={12} /> : <Mic size={12} />}
        {isMuted ? 'MUTED' : 'MIC'}
      </button>

      {/* Leave */}
      <button
        onClick={leave}
        className="flex items-center gap-1 px-2 py-0.5 rounded-sm bg-red/20 text-red hover:bg-red/30 transition-colors"
      >
        <PhoneOff size={10} />
        LEAVE
      </button>
    </div>
  )
}
