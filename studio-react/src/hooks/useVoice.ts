import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../stores/authStore';

interface VoiceState {
  isConnected: boolean;
  isMuted: boolean;
  peers: string[];
  error: string | null;
}

interface PeerEntry {
  connection: RTCPeerConnection;
  peerId: string;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

export function useVoice() {
  const [state, setState] = useState<VoiceState>({
    isConnected: false,
    isMuted: false,
    peers: [],
    error: null,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const user = useAuthStore((s) => s.user);

  const sendSignal = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const createPeerConnection = useCallback(
    (remotePeerId: string): RTCPeerConnection => {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      // Add local audio tracks to the connection
      const localStream = localStreamRef.current;
      if (localStream) {
        for (const track of localStream.getTracks()) {
          pc.addTrack(track, localStream);
        }
      }

      // Send ICE candidates to the remote peer
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal({
            type: 'ice-candidate',
            candidate: event.candidate,
            targetPeerId: remotePeerId,
          });
        }
      };

      // Play incoming audio from remote peer
      pc.ontrack = (event) => {
        const audio = new Audio();
        audio.srcObject = event.streams[0];
        audio.autoplay = true;
      };

      peersRef.current.set(remotePeerId, { connection: pc, peerId: remotePeerId });
      setState((prev) => ({
        ...prev,
        peers: Array.from(peersRef.current.keys()),
      }));

      return pc;
    },
    [sendSignal],
  );

  const removePeer = useCallback((peerId: string) => {
    const entry = peersRef.current.get(peerId);
    if (entry) {
      entry.connection.close();
      peersRef.current.delete(peerId);
      setState((prev) => ({
        ...prev,
        peers: Array.from(peersRef.current.keys()),
      }));
    }
  }, []);

  const handleMessage = useCallback(
    async (event: MessageEvent) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(event.data as string);
      } catch {
        return;
      }

      const type = data.type as string;

      switch (type) {
        case 'peer-joined': {
          // A new peer joined — we create an offer for them
          const peerId = data.peerId as string;
          const pc = createPeerConnection(peerId);
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendSignal({ type: 'offer', offer, targetPeerId: peerId });
          } catch (err) {
            console.error('Failed to create offer:', err);
          }
          break;
        }

        case 'offer': {
          // Received an offer — create answer
          const peerId = data.fromPeerId as string;
          const pc = createPeerConnection(peerId);
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.offer as RTCSessionDescriptionInit));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendSignal({ type: 'answer', answer, targetPeerId: peerId });
          } catch (err) {
            console.error('Failed to handle offer:', err);
          }
          break;
        }

        case 'answer': {
          // Received answer to our offer
          const peerId = data.fromPeerId as string;
          const entry = peersRef.current.get(peerId);
          if (entry) {
            try {
              await entry.connection.setRemoteDescription(
                new RTCSessionDescription(data.answer as RTCSessionDescriptionInit),
              );
            } catch (err) {
              console.error('Failed to set remote description:', err);
            }
          }
          break;
        }

        case 'ice-candidate': {
          // Received ICE candidate from peer
          const peerId = data.fromPeerId as string;
          const entry = peersRef.current.get(peerId);
          if (entry && data.candidate) {
            try {
              await entry.connection.addIceCandidate(
                new RTCIceCandidate(data.candidate as RTCIceCandidateInit),
              );
            } catch (err) {
              console.error('Failed to add ICE candidate:', err);
            }
          }
          break;
        }

        case 'peer-left': {
          const peerId = data.peerId as string;
          removePeer(peerId);
          break;
        }
      }
    },
    [createPeerConnection, removePeer, sendSignal],
  );

  const join = useCallback(async () => {
    // Reset error
    setState((prev) => ({ ...prev, error: null }));

    // Acquire microphone
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Microphone access denied',
      }));
      return;
    }

    // Connect WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/voice`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        const peerId = user?.username || `user-${Date.now()}`;
        sendSignal({ type: 'join', peerId });
        setState((prev) => ({ ...prev, isConnected: true, error: null }));
      };

      ws.onmessage = handleMessage;

      ws.onerror = () => {
        setState((prev) => ({
          ...prev,
          error: 'Voice connection failed',
          isConnected: false,
        }));
      };

      ws.onclose = () => {
        setState((prev) => ({
          ...prev,
          isConnected: false,
          peers: [],
        }));
        // Clean up all peer connections
        for (const [, entry] of peersRef.current) {
          entry.connection.close();
        }
        peersRef.current.clear();
      };
    } catch {
      setState((prev) => ({
        ...prev,
        error: 'Failed to create WebSocket connection',
      }));
    }
  }, [user, sendSignal, handleMessage]);

  const leave = useCallback(() => {
    // Close WebSocket
    const ws = wsRef.current;
    if (ws) {
      ws.close();
      wsRef.current = null;
    }

    // Close all peer connections
    for (const [, entry] of peersRef.current) {
      entry.connection.close();
    }
    peersRef.current.clear();

    // Stop local audio tracks
    const stream = localStreamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      localStreamRef.current = null;
    }

    setState({
      isConnected: false,
      isMuted: false,
      peers: [],
      error: null,
    });
  }, []);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (stream) {
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setState((prev) => ({ ...prev, isMuted: !audioTrack.enabled }));
      }
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const ws = wsRef.current;
      if (ws) ws.close();

      for (const [, entry] of peersRef.current) {
        entry.connection.close();
      }
      peersRef.current.clear();

      const stream = localStreamRef.current;
      if (stream) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
      }
    };
  }, []);

  return {
    ...state,
    join,
    leave,
    toggleMute,
  };
}
