import { Outlet, useLocation } from 'react-router-dom'
import { useState, useMemo } from 'react'
import { Menu } from 'lucide-react'
import SideNav from './SideNav'
import DirectiveBanner from '../components/directives/DirectiveBanner'
import VoiceBar from '../components/voice/VoiceBar'
import { useAuthStore } from '../stores/authStore'
import { useDashboardStore } from '../stores/dashboardStore'
import { usePolling } from '../hooks/usePolling'
import { useMediaQuery } from '../hooks/useMediaQuery'

const routeTitles: Record<string, string> = {
  '/': 'Dashboard',
  '/inbox': 'Inbox',
  '/channels': 'Channels',
  '/tasks': 'Tasks',
  '/messages': 'Agent Comms',
  '/plans': 'Plans',
  '/bugs': 'Bugs',
  '/assets': 'Assets',
  '/operators': 'Operators',
  '/approvals': 'Approvals',
  '/drones': 'Drones',
  '/concepts': 'Concepts',
  '/context': 'Context Keys',
  '/webhooks': 'Webhooks',
  '/ops': 'Admin Ops',
  '/health': 'Network Health',
  '/onboarding': 'Onboarding',
  '/plugins': 'Plugins',
  '/analytics': 'Analytics',
  '/feedback': 'Feedback',
}

function formatTime(date: Date | null): string {
  if (!date) return 'never'
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

export default function AppLayout() {
  const location = useLocation()
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const { loading, refresh, instanceConfig } = useDashboardStore()
  const { lastRefresh } = usePolling(10_000)
  const isMobile = useMediaQuery('(max-width: 767px)')
  const [mobileOpen, setMobileOpen] = useState(false)

  const pageTitle = routeTitles[location.pathname] || 'Mycelium'
  const showFloatingVoice = location.pathname !== '/channels'

  const isFrozen = useMemo(() => {
    const adminStatus = instanceConfig.find((c) => c.key === 'admin_status')
    return adminStatus?.value === 'frozen'
  }, [instanceConfig])

  return (
    <div className="flex h-screen bg-bg overflow-hidden">
      <SideNav
        isMobile={isMobile}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      <div className="flex flex-col flex-1 min-w-0">
        {/* Header bar */}
        <header className="flex items-center justify-between h-14 px-4 md:px-6 border-b border-border bg-surface shrink-0">
          {/* Left: hamburger + page title */}
          <div className="flex items-center gap-3">
            {isMobile && (
              <button
                onClick={() => setMobileOpen(true)}
                className="p-1.5 -ml-1 rounded-lg text-text-muted hover:text-text transition-colors"
              >
                <Menu size={20} strokeWidth={1.5} />
              </button>
            )}
            <h1 className="text-lg font-semibold text-text">{pageTitle}</h1>
          </div>

          {/* Right: controls */}
          <div className="flex items-center gap-3 md:gap-4">
            {/* Frozen kill switch badge */}
            {isFrozen && (
              <span className="px-2.5 py-1 rounded text-xs font-mono font-bold bg-red/20 text-red animate-pulse">
                FROZEN
              </span>
            )}

            {/* User display name */}
            {user && (
              <span className="text-sm text-text-dim hidden sm:inline">{user.display_name}</span>
            )}

            {/* Last refresh */}
            <span className="text-xs text-text-muted font-mono hidden md:inline" title="Last refresh">
              {formatTime(lastRefresh)}
            </span>

            {/* Refresh button */}
            <button
              onClick={refresh}
              disabled={loading}
              className="px-2.5 py-1.5 rounded-sm text-text-dim hover:text-text hover:bg-surface-raised/50 transition-colors text-xs font-mono disabled:opacity-50 disabled:cursor-not-allowed"
              title="Refresh data"
            >
              {loading ? '...' : 'SYNC'}
            </button>

            {/* Logout button */}
            <button
              onClick={logout}
              className="px-2.5 py-1.5 rounded-sm text-text-muted hover:text-red hover:bg-red/10 transition-colors text-xs font-mono"
              title="Logout"
            >
              OUT
            </button>
          </div>
        </header>

        {/* Content area */}
        <main className={
          !showFloatingVoice
            ? 'flex-1 overflow-hidden flex flex-col min-h-0'
            : `flex-1 overflow-y-auto p-4 md:p-6 ${showFloatingVoice ? 'pb-16' : ''}`
        }>
          <DirectiveBanner />
          <Outlet />
        </main>

        {/* Floating voice bar (hidden on /channels where VoicePanel handles it) */}
        {showFloatingVoice && (
          <div className="shrink-0">
            <VoiceBar />
          </div>
        )}
      </div>
    </div>
  )
}
