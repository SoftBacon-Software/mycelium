import { useState, useEffect, useCallback } from 'react'
import { getVapidKey, subscribePush, unsubscribePush } from '../api/endpoints'

type PushStatus = 'unsupported' | 'prompt' | 'denied' | 'subscribed' | 'loading'

export function usePushNotifications() {
  const [status, setStatus] = useState<PushStatus>('loading')
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null)

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setStatus('unsupported')
      return
    }

    navigator.serviceWorker.register('/sw.js').then((reg) => {
      setRegistration(reg)
      return reg.pushManager.getSubscription()
    }).then((sub) => {
      if (sub) {
        setStatus('subscribed')
      } else {
        const perm = Notification.permission
        setStatus(perm === 'denied' ? 'denied' : 'prompt')
      }
    }).catch(() => {
      setStatus('unsupported')
    })
  }, [])

  const subscribe = useCallback(async () => {
    if (!registration) return
    try {
      const { key } = await getVapidKey()
      if (!key) return

      const sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      })

      await subscribePush(sub.toJSON())
      setStatus('subscribed')
    } catch {
      setStatus(Notification.permission === 'denied' ? 'denied' : 'prompt')
    }
  }, [registration])

  const unsubscribe = useCallback(async () => {
    if (!registration) return
    try {
      const sub = await registration.pushManager.getSubscription()
      if (sub) {
        await unsubscribePush(sub.endpoint)
        await sub.unsubscribe()
      }
      setStatus('prompt')
    } catch {
      // ignore
    }
  }, [registration])

  return { status, subscribe, unsubscribe }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}
