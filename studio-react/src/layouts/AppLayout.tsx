import { Outlet, useLocation, useSearchParams } from 'react-router-dom'
import { useState, useMemo, useEffect } from 'react'
import { Menu } from 'lucide-react'
import SideNav from './SideNav'
import VoiceCommand from '../components/voice/VoiceCommand'
import DirectiveBanner from '../components/directives/DirectiveBanner'
import VoiceBar from '../components/voice/VoiceBar'
import { useAuthStore } from '../stores/authStore'
import { useDashboardStore } from '../stores/dashboardStore'
import { usePolling } from '../hooks/usePolling'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useLiveEvents } from '../hooks/useLiveEvents'

const routeTitles: Record<string, string> = {
  '/': 'Dashboard',
  '/inbox': 'Inbox',
  '/channels': 'Channels',
  '/tasks': 'Tasks',
  '/messages': 'Activity Log',
  '/plans': 'Plans',
  '/bugs': 'Bugs',
  '/assets': 'Assets',
  '/operators': 'Operators',
  '/approvals': 'Approvals',
  '/drones': 'Drones',
  '/spawns': 'Spawns',
  '/concepts': 'Concepts',
  '/context': 'Context Store',
  '/webhooks': 'Webhooks',
  '/ops': 'Ops Console',
  '/health': 'Network',
  '/agent-health': 'Agent Health',
  '/onboarding': 'Onboarding',
  '/plugins': 'Plugins',
  '/analytics': 'Analytics',
  '/feedback': 'Feedback',
  '/templates': 'Agent Templates',
  '/teams': 'Teams',
  '/team-settings': 'Settings',
  '/deployments': 'Instances',
}

const routeDescriptions: Record<string, string> = {
  '/': 'Overview of your agents, tasks, and recent activity',
  '/inbox': 'Pending approvals, mentions, and notifications',
  '/channels': 'Persistent chat channels for agent and team communication',
  '/tasks': 'Kanban board for tracking agent work items',
  '/messages': 'All agent messages, requests, and directives',
  '/plans': 'Multi-step execution plans with progress tracking',
  '/bugs': 'Bug reports filed by agents or operators',
  '/assets': 'Files and artifacts uploaded by agents',
  '/operators': 'Human team members who own and control agents',
  '/approvals': 'Review and vote on gated actions (deploys, deletes, etc.)',
  '/drones': 'GPU/CPU compute job queue and worker status',
  '/spawns': 'Provision new agent instances on the network',
  '/concepts': 'Shared characters, styles, rulesets, and libraries',
  '/context': 'Versioned key-value store for agent memory and configuration',
  '/webhooks': 'Event webhook subscriptions and delivery logs',
  '/ops': 'Admin actions, instance config, and kill switch',
  '/health': 'Agent status, stale detection, and network uptime',
  '/agent-health': 'Per-agent profiles, performance stats, and leaderboard',
  '/onboarding': 'Setup wizard for new Mycelium instances',
  '/plugins': 'Server plugins, extensions, and integrations',
  '/analytics': 'Spend tracking, usage metrics, and cost breakdown',
  '/feedback': 'Agent performance ratings and operator reviews',
  '/templates': 'Reusable agent configuration templates',
  '/teams': 'Team organization and membership management',
  '/team-settings': 'Team roles, permissions, and configuration',
  '/deployments': 'Customer instances, provisioning, and health checks',
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
  useLiveEvents()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const { loading, refresh, instanceConfig, activeOperators } = useDashboardStore()
  const { lastRefresh } = usePolling(10_000)
  const isMobile = useMediaQuery('(max-width: 767px)')
  const [mobileOpen, setMobileOpen] = useState(false)

  const pageTitle = routeTitles[location.pathname] || 'Mycelium'
  const pageDesc = routeDescriptions[location.pathname] || ''
  useEffect(() => {
    document.title = pageTitle === 'Dashboard' ? 'Mycelium' : pageTitle + ' — Mycelium'
  }, [pageTitle])
  const isChannels = location.pathname === '/channels'
  const rec = searchParams.has('rec')

  const isFrozen = useMemo(() => {
    const adminStatus = instanceConfig.find((c) => c.key === 'admin_status')
    return adminStatus?.value === 'frozen'
  }, [instanceConfig])

  // Recording mode: full-screen content, minimal chrome
  if (rec) {
    return (
      <div className="flex flex-col h-screen bg-bg overflow-hidden">
        {/* Minimal header — just page title + live dot */}
        <header className="flex items-center justify-between h-10 px-6 border-b border-border/50 bg-surface shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="w-2 h-2 rounded-full bg-green animate-pulse" />
            <h1 className="text-sm font-semibold text-text">{pageTitle}</h1>
          </div>
          <span className="text-[10px] text-text-muted/50 font-mono">mycelium.fyi</span>
        </header>
        <main className={
          isChannels
            ? 'flex-1 overflow-hidden flex flex-col min-h-0'
            : 'flex-1 overflow-y-auto p-4 md:p-6 pb-8'
        }>
          <Outlet />
        </main>
      </div>
    )
  }

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
            <div className="flex items-baseline gap-3">
              <h1 className="text-lg font-semibold text-text">{pageTitle}</h1>
              {pageDesc && (
                <span className="text-xs text-text-muted hidden lg:inline">{pageDesc}</span>
              )}
            </div>
          </div>

          {/* Right: controls */}
          <div className="flex items-center gap-3 md:gap-4">
            {/* Frozen kill switch badge */}
            {isFrozen && (
              <span className="px-2.5 py-1 rounded text-xs font-mono font-bold bg-red/20 text-red animate-pulse">
                FROZEN
              </span>
            )}

            {/* Active operator presence */}
            {activeOperators.length > 0 && (
              <div className="hidden sm:flex items-center gap-1.5" title={
                activeOperators.length === 1
                  ? 'Only you are online'
                  : activeOperators.map(o => o.display_name).join(', ') + ' online'
              }>
                {activeOperators.map((op) => (
                  <span
                    key={op.id}
                    className="flex items-center gap-1 text-xs text-text-muted"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-moss inline-block" />
                    <span className="hidden md:inline">{op.display_name}</span>
                  </span>
                ))}
                {activeOperators.length === 1 && (
                  <span className="text-xs text-text-muted font-mono hidden md:inline">only you</span>
                )}
              </div>
            )}

            {/* User display name */}
            {user && (
              <span className="text-sm text-text-dim hidden sm:inline">{user.display_name}</span>
            )}

            {/* Voice command */}
            <VoiceCommand />

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

        {/* Voice bar — always at the top, below header */}
        <VoiceBar />

        {/* Content area */}
        <main className={
          isChannels
            ? 'flex-1 overflow-hidden flex flex-col min-h-0'
            : 'flex-1 overflow-y-auto p-4 md:p-6 pb-16'
        }>
          <DirectiveBanner />
          <Outlet />
        </main>
      </div>
    </div>
  )
}
