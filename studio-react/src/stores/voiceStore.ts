import { create } from 'zustand'
import { toast } from 'sonner'
import { useAuthStore } from './authStore'

// ─── ICE Servers ─────────────────────────────────────────────────────────────

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
]

// ─── Module-scoped refs (survive navigation) ─────────────────────────────────

let ws: WebSocket | null = null
let localStream: MediaStream | null = null
const peerConnections = new Map<string, RTCPeerConnection>()
const audioElements = new Map<string, HTMLAudioElement>()
const audioContexts = new Map<string, { ctx: AudioContext; analyser: AnalyserNode }>()
let intentionalDisconnect = false
let talkDetectionInterval: ReturnType<typeof setInterval> | null = null

// ─── Rich peer metadata ─────────────────────────────────────────────────────

interface PeerMeta {
  name: string
  muted: boolean
  talking: boolean
}

const peerMetadata = new Map<string, PeerMeta>()

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VoicePeer {
  id: string
  name: string
  muted: boolean
  talking: boolean
}

interface VoiceState {
  isConnected: boolean
  isMuted: boolean
  channelName: string | null
  peers: VoicePeer[]
  myPeerId: string | null
  error: string | null
  join: (channelName?: string) => Promise<void>
  leave: () => void
  toggleMute: () => void
}

// ─── Helpers (module-scoped) ─────────────────────────────────────────────────

function sendSignal(msg: Record<string, unknown>) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function syncPeers() {
  const peers: VoicePeer[] = []
  for (const [id, meta] of peerMetadata) {
    peers.push({ id, name: meta.name, muted: meta.muted, talking: meta.talking })
  }
  useVoiceStore.setState({ peers })
}

function setupTalkDetection(peerId: string, stream: MediaStream) {
  try {
    const ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)
    audioContexts.set(peerId, { ctx, analyser })
  } catch {
    // AudioContext not available
  }
}

function startTalkDetectionLoop() {
  if (talkDetectionInterval) return
  talkDetectionInterval = setInterval(() => {
    let changed = false
    for (const [peerId, { analyser }] of audioContexts) {
      const data = new Uint8Array(analyser.frequencyBinCount)
      analyser.getByteFrequencyData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i]
      const avg = sum / data.length
      const talking = avg > 15
      const meta = peerMetadata.get(peerId)
      if (meta && meta.talking !== talking) {
        meta.talking = talking
        changed = true
      }
    }
    if (changed) syncPeers()
  }, 100)
}

function createPeerConnection(remotePeerId: string): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

  if (localStream) {
    for (const track of localStream.getTracks()) {
      pc.addTrack(track, localStream)
    }
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal({
        type: 'ice',
        candidate: event.candidate,
        to: remotePeerId,
      })
    }
  }

  pc.ontrack = (event) => {
    const audio = new Audio()
    audio.srcObject = event.streams[0]
    audio.autoplay = true
    audioElements.set(remotePeerId, audio)
    // Set up talk detection for remote stream
    setupTalkDetection(remotePeerId, event.streams[0])
    startTalkDetectionLoop()
  }

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') {
      removePeer(remotePeerId)
    }
  }

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      removePeer(remotePeerId)
    }
  }

  peerConnections.set(remotePeerId, pc)

  return pc
}

function removePeer(peerId: string) {
  const pc = peerConnections.get(peerId)
  if (pc) {
    pc.close()
    peerConnections.delete(peerId)
  }
  const audio = audioElements.get(peerId)
  if (audio) {
    audio.srcObject = null
    audioElements.delete(peerId)
  }
  const ac = audioContexts.get(peerId)
  if (ac) {
    ac.ctx.close().catch(() => {})
    audioContexts.delete(peerId)
  }
  peerMetadata.delete(peerId)
  syncPeers()
}

async function handleMessage(event: MessageEvent) {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(event.data as string)
  } catch {
    return
  }

  const type = data.type as string

  switch (type) {
    case 'welcome': {
      // Server sends our peer ID and list of existing peers in the channel
      useVoiceStore.setState({ myPeerId: data.id as string })
      const existingPeers = (data.peers as Array<{ id: string; name: string; muted: boolean }>) || []
      // Populate metadata for existing peers
      for (const p of existingPeers) {
        peerMetadata.set(p.id, { name: p.name || p.id, muted: !!p.muted, talking: false })
      }
      syncPeers()
      // Create peer connections to all existing peers (we are the new joiner, so we make offers)
      for (const p of existingPeers) {
        const pc = createPeerConnection(p.id)
        try {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          sendSignal({ type: 'offer', sdp: offer, to: p.id })
        } catch (err) {
          console.error('Failed to create offer:', err)
        }
      }
      break
    }

    case 'peer_joined': {
      const peer = data.peer as { id: string; name: string; muted: boolean }
      peerMetadata.set(peer.id, { name: peer.name || peer.id, muted: !!peer.muted, talking: false })
      syncPeers()
      // Don't create offer here — the new joiner will offer to us via welcome
      break
    }

    case 'peer_updated': {
      const peer = data.peer as { id: string; name: string; muted: boolean }
      const meta = peerMetadata.get(peer.id)
      if (meta) {
        meta.name = peer.name || meta.name
        meta.muted = !!peer.muted
        syncPeers()
      }
      break
    }

    case 'offer': {
      const fromId = data.from as string
      if (!peerMetadata.has(fromId)) {
        peerMetadata.set(fromId, { name: fromId, muted: false, talking: false })
        syncPeers()
      }
      const pc = createPeerConnection(fromId)
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp as RTCSessionDescriptionInit))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        sendSignal({ type: 'answer', sdp: answer, to: fromId })
      } catch (err) {
        console.error('Failed to handle offer:', err)
      }
      break
    }

    case 'answer': {
      const fromId = data.from as string
      const pc = peerConnections.get(fromId)
      if (pc) {
        try {
          await pc.setRemoteDescription(
            new RTCSessionDescription(data.sdp as RTCSessionDescriptionInit),
          )
        } catch (err) {
          console.error('Failed to set remote description:', err)
        }
      }
      break
    }

    case 'ice': {
      const fromId = data.from as string
      const pc = peerConnections.get(fromId)
      if (pc && data.candidate) {
        try {
          await pc.addIceCandidate(
            new RTCIceCandidate(data.candidate as RTCIceCandidateInit),
          )
        } catch (err) {
          console.error('Failed to add ICE candidate:', err)
        }
      }
      break
    }

    case 'peer_left': {
      const peerId = data.id as string
      removePeer(peerId)
      break
    }
  }
}

function cleanupAll() {
  if (talkDetectionInterval) {
    clearInterval(talkDetectionInterval)
    talkDetectionInterval = null
  }
  if (ws) {
    ws.close()
    ws = null
  }
  for (const [, pc] of peerConnections) {
    pc.close()
  }
  peerConnections.clear()
  for (const [, audio] of audioElements) {
    audio.srcObject = null
  }
  audioElements.clear()
  for (const [, ac] of audioContexts) {
    ac.ctx.close().catch(() => {})
  }
  audioContexts.clear()
  peerMetadata.clear()
  if (localStream) {
    for (const track of localStream.getTracks()) {
      track.stop()
    }
    localStream = null
  }
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useVoiceStore = create<VoiceState>()((set) => ({
  isConnected: false,
  isMuted: false,
  channelName: null,
  peers: [],
  myPeerId: null,
  error: null,

  join: async (channelName?: string) => {
    set({ error: null })

    // Acquire microphone
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      localStream = stream
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Microphone access denied',
      })
      return
    }

    // Connect WebSocket with JWT token
    const token = useAuthStore.getState().token
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/voice?token=${encodeURIComponent(token || '')}`

    try {
      intentionalDisconnect = false
      const socket = new WebSocket(wsUrl)
      ws = socket

      socket.onopen = () => {
        const user = useAuthStore.getState().user
        // Send our display name
        sendSignal({ type: 'set_name', name: user?.display_name || user?.username || 'User' })
        // Join the specific channel
        const channel = channelName || 'voice'
        sendSignal({ type: 'join_channel', channel })
        set({ isConnected: true, channelName: channel, error: null })
      }

      socket.onmessage = handleMessage

      socket.onerror = () => {
        set({ error: 'Voice connection failed', isConnected: false })
        toast.error('Voice: connection error')
      }

      socket.onclose = (e) => {
        cleanupAll()
        if (!intentionalDisconnect) {
          set({ isConnected: false, peers: [], channelName: null, myPeerId: null })
          if (e.code === 4401 || e.code === 4403) {
            toast.error('Voice: authentication failed')
          } else {
            toast.error('Voice: disconnected')
          }
        }
      }
    } catch {
      set({ error: 'Failed to create WebSocket connection' })
    }
  },

  leave: () => {
    intentionalDisconnect = true
    cleanupAll()
    set({
      isConnected: false,
      isMuted: false,
      channelName: null,
      peers: [],
      myPeerId: null,
      error: null,
    })
  },

  toggleMute: () => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0]
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled
        const muted = !audioTrack.enabled
        set({ isMuted: muted })
        // Broadcast mute state to peers
        sendSignal({ type: 'mute', muted })
      }
    }
  },
}))

// ─── Tab close cleanup ───────────────────────────────────────────────────────

window.addEventListener('beforeunload', () => {
  if (useVoiceStore.getState().isConnected) {
    cleanupAll()
  }
})
