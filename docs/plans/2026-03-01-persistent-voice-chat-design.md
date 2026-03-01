# Persistent Voice Chat Across App

## Context

Voice chat currently lives inside ChannelsPage's VoicePanel component. The `useVoice` hook (`src/hooks/useVoice.ts`) uses React refs + useState, and its useEffect cleanup destroys the WebSocket, all RTCPeerConnections, and stops audio tracks when the component unmounts. Navigating away from `/channels` kills the voice session.

## Goal

Voice connection persists across all page navigation. A green indicator in SideNav shows active voice status. A floating VoiceBar provides mute/leave controls from any page.

## Architecture

```
voiceStore.ts (Zustand module singleton — survives navigation)
├── State: isConnected, isMuted, channelName, peers[], error
├── Refs (module-scoped): ws, localStream, peerConnections Map, audioElements Map
├── Actions: join(channelName), leave(), toggleMute()
└── beforeunload listener for cleanup on tab close

Consumers:
├── SideNav.tsx        → green dot + channel name indicator
├── AppLayout.tsx      → floating VoiceBar (hidden on /channels)
├── ChannelsPage.tsx   → VoicePanel with full controls
└── useVoice.ts        → thin wrapper for backward compat
```

## Files

| File | Action | What Changes |
|------|--------|-------------|
| `src/stores/voiceStore.ts` | CREATE | Zustand store owning all WebRTC state + module-scoped refs |
| `src/hooks/useVoice.ts` | REWRITE | Thin wrapper re-exporting voiceStore selectors/actions |
| `src/pages/ChannelsPage.tsx` | EDIT | VoicePanel uses store; pass channel name on join |
| `src/components/voice/VoiceBar.tsx` | EDIT | Use voiceStore; add channel name + "go to channel" link |
| `src/layouts/AppLayout.tsx` | EDIT | Render floating VoiceBar at bottom when connected, hide on /channels |
| `src/layouts/SideNav.tsx` | EDIT | Add voice indicator (green dot, channel name, leave button) |
