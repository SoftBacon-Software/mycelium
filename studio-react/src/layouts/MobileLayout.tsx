import { Outlet, Link } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { useLiveEvents } from '../hooks/useLiveEvents'
import { useLiveStore } from '../stores/liveStore'

export default function MobileLayout() {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  useLiveEvents()
  const connected = useLiveStore((s) => s.connected)

  return (
    <div
      className="flex flex-col min-h-screen bg-bg text-text"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {/* Header */}
      <header className="flex items-center justify-between px-4 h-12 border-b border-border bg-surface shrink-0">
        <div className="flex items-center gap-2">
          <img
            src="/fungal_horror.png"
            alt="Mycelium"
            className="w-7 h-7 rounded-lg object-cover"
            style={{ filter: 'drop-shadow(0 0 4px rgba(212,168,71,0.4))' }}
          />
          <span className="font-mono text-accent text-xs font-bold tracking-[0.15em]">
            MYCELIUM
          </span>
          <span
            className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green' : 'bg-text-muted'}`}
            title={connected ? 'Connected' : 'Disconnected'}
          />
        </div>
        <div className="flex items-center gap-3">
          <Link to="/" className="text-[10px] text-text-muted font-mono hover:text-text-dim">
            DESKTOP
          </Link>
          {user && (
            <button
              onClick={logout}
              className="text-[10px] text-text-muted font-mono hover:text-red"
            >
              OUT
            </button>
          )}
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  )
}
