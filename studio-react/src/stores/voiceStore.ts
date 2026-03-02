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
let intentionalDisconnect = false

// ─── Types ───────────────────────────────────────────────────────────────────

interface VoiceState {
  isConnected: boolean
  isMuted: boolean
  channelName: string | null
  peers: string[]
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
  useVoiceStore.setState({ peers: Array.from(peerConnections.keys()) })
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
        type: 'ice-candidate',
        candidate: event.candidate,
        targetPeerId: remotePeerId,
      })
    }
  }

  pc.ontrack = (event) => {
    const audio = new Audio()
    audio.srcObject = event.streams[0]
    audio.autoplay = true
    audioElements.set(remotePeerId, audio)
  }

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') {
      toast.error(`Voice: connection to ${remotePeerId} failed (ICE failure)`)
      removePeer(remotePeerId)
    } else if (pc.iceConnectionState === 'disconnected') {
      toast.error(`Voice: connection to ${remotePeerId} lost`)
    }
  }

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      toast.error(`Voice: peer connection to ${remotePeerId} failed`)
      removePeer(remotePeerId)
    }
  }

  peerConnections.set(remotePeerId, pc)
  syncPeers()

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
    case 'peer-joined': {
      const peerId = data.peerId as string
      const pc = createPeerConnection(peerId)
      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        sendSignal({ type: 'offer', offer, targetPeerId: peerId })
      } catch (err) {
        console.error('Failed to create offer:', err)
        toast.error('Voice: failed to connect to new peer')
      }
      break
    }

    case 'offer': {
      const peerId = data.fromPeerId as string
      const pc = createPeerConnection(peerId)
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer as RTCSessionDescriptionInit))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        sendSignal({ type: 'answer', answer, targetPeerId: peerId })
      } catch (err) {
        console.error('Failed to handle offer:', err)
        toast.error('Voice: failed to negotiate with peer')
      }
      break
    }

    case 'answer': {
      const peerId = data.fromPeerId as string
      const pc = peerConnections.get(peerId)
      if (pc) {
        try {
          await pc.setRemoteDescription(
            new RTCSessionDescription(data.answer as RTCSessionDescriptionInit),
          )
        } catch (err) {
          console.error('Failed to set remote description:', err)
          toast.error('Voice: connection setup failed')
        }
      }
      break
    }

    case 'ice-candidate': {
      const peerId = data.fromPeerId as string
      const pc = peerConnections.get(peerId)
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

    case 'peer-left': {
      const peerId = data.peerId as string
      removePeer(peerId)
      break
    }
  }
}

function cleanupAll() {
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

    // Connect WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/voice`

    try {
      intentionalDisconnect = false
      const socket = new WebSocket(wsUrl)
      ws = socket

      socket.onopen = () => {
        const user = useAuthStore.getState().user
        const peerId = user?.username || `user-${Date.now()}`
        sendSignal({ type: 'join', peerId })
        set({ isConnected: true, channelName: channelName || 'voice', error: null })
      }

      socket.onmessage = handleMessage

      socket.onerror = () => {
        set({ error: 'Voice connection failed', isConnected: false })
        toast.error('Voice: connection error — check server or network')
      }

      socket.onclose = () => {
        for (const [, pc] of peerConnections) {
          pc.close()
        }
        peerConnections.clear()
        for (const [, audio] of audioElements) {
          audio.srcObject = null
        }
        audioElements.clear()

        if (!intentionalDisconnect) {
          set({ isConnected: false, peers: [], channelName: null })
          toast.error('Voice: disconnected unexpectedly')
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
      error: null,
    })
  },

  toggleMute: () => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0]
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled
        set({ isMuted: !audioTrack.enabled })
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
