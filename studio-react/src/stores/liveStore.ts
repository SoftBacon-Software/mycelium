import { create } from 'zustand'

export interface LiveEvent {
  type: string
  agent: string
  project_id: string | null
  summary: string
  data: Record<string, unknown>
  id: number
  created_at: string
}

interface LiveState {
  connected: boolean
  events: LiveEvent[]
  // Tracks recent heartbeats: agent ID → timestamp of last heartbeat
  recentHeartbeats: Record<string, number>
  setConnected: (v: boolean) => void
  pushEvent: (e: LiveEvent) => void
  clear: () => void
}

const MAX_EVENTS = 100

export const useLiveStore = create<LiveState>()((set) => ({
  connected: false,
  events: [],
  recentHeartbeats: {},

  setConnected: (v) => set({ connected: v }),

  pushEvent: (e) =>
    set((state) => {
      const next: Partial<LiveState> = {
        events: [e, ...state.events].slice(0, MAX_EVENTS),
      }
      // Track heartbeats and status changes for live agent indicators
      if (e.type === 'agent_heartbeat' || e.type === 'agent_status_changed') {
        next.recentHeartbeats = { ...state.recentHeartbeats, [e.agent]: Date.now() }
      }
      return next
    }),

  clear: () => set({ events: [], recentHeartbeats: {} }),
}))
