import { useEffect, useRef } from 'react'
import { getToken } from '../api/client'
import { useLiveStore } from '../stores/liveStore'

const API_BASE = '/api/mycelium'
const RECONNECT_DELAY = 3000

export function useLiveEvents() {
  const esRef = useRef<EventSource | null>(null)
  const setConnected = useLiveStore((s) => s.setConnected)
  const pushEvent = useLiveStore((s) => s.pushEvent)

  useEffect(() => {
    let cancelled = false
    let reconnectTimer: ReturnType<typeof setTimeout>

    function connect() {
      if (cancelled) return
      const token = getToken()
      if (!token) return

      const url = `${API_BASE}/events/stream?token=${encodeURIComponent(token)}`
      const es = new EventSource(url)
      esRef.current = es

      es.onopen = () => {
        if (!cancelled) setConnected(true)
      }

      es.onmessage = (e) => {
        if (cancelled) return
        try {
          const event = JSON.parse(e.data)
          if (event.type === 'connected') return
          pushEvent(event)
        } catch {
          // ignore parse errors
        }
      }

      es.onerror = () => {
        es.close()
        esRef.current = null
        if (!cancelled) {
          setConnected(false)
          reconnectTimer = setTimeout(connect, RECONNECT_DELAY)
        }
      }
    }

    connect()

    return () => {
      cancelled = true
      clearTimeout(reconnectTimer)
      if (esRef.current) {
        esRef.current.close()
        esRef.current = null
      }
      setConnected(false)
    }
  }, [setConnected, pushEvent])
}
