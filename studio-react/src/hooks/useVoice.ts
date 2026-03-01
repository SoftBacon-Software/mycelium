import { useVoiceStore } from '../stores/voiceStore'

export function useVoice() {
  return useVoiceStore((s) => ({
    isConnected: s.isConnected,
    isMuted: s.isMuted,
    channelName: s.channelName,
    peers: s.peers,
    error: s.error,
    join: s.join,
    leave: s.leave,
    toggleMute: s.toggleMute,
  }))
}
