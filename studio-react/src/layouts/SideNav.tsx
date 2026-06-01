import { NavLink, useLocation } from 'react-router-dom'
import { useState, useEffect, useMemo } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { useAuthStore } from '../stores/authStore'
import { useVoiceStore } from '../stores/voiceStore'
import { fetchPluginNav } from '../api/endpoints'
import type { PluginNavEntry } from '../api/endpoints'
import {
  LayoutDashboard, CheckSquare, Map, Bug,
  MessageSquare, Radio, ShieldCheck, Inbox,
  Users, Cpu, FolderOpen, Lightbulb, Database, Server, Layers,
  Settings, Settings2, Activity, Webhook, Puzzle, BarChart3, Rocket, MessageCircle, Zap,
  ChevronRight, PanelLeftClose, PanelLeftOpen, X, HeartPulse, HardDrive,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/* ── Types ── */

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  adminOnly?: boolean
  desc?: string
}

interface NavSection {
  id: string
  label: string | null
  defaultCollapsed?: boolean
  items: NavItem[]
}

/* ── Navigation structure ── */

const staticNavSections: NavSection[] = [
  {
    id: 'pinned',
    label: null,
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, desc: 'Overview of agents, tasks, and activity' },
      { to: '/inbox', label: 'Inbox', icon: Inbox, desc: 'Pending approvals, mentions, and notifications' },
    ],
  },
  {
    id: 'work',
    label: 'Work',
    items: [
      { to: '/tasks', label: 'Tasks', icon: CheckSquare, desc: 'Kanban board for agent work items' },
      { to: '/plans', label: 'Plans', icon: Map, desc: 'Multi-step execution plans with progress tracking' },
      { to: '/bugs', label: 'Bugs', icon: Bug, desc: 'Bug reports filed by agents or operators' },
    ],
  },
  {
    id: 'communicate',
    label: 'Communicate',
    items: [
      { to: '/messages', label: 'Activity Log', icon: Radio, desc: 'All agent messages, requests, and directives' },
      { to: '/channels', label: 'Channels', icon: MessageSquare, desc: 'Persistent chat channels for teams' },
    ],
  },
  {
    id: 'observe',
    label: 'Observe',
    items: [
      { to: '/health', label: 'Network', icon: Activity, desc: 'Agent status, stale detection, and uptime' },
      { to: '/agent-health', label: 'Agent Health', icon: HeartPulse, desc: 'Per-agent profiles, stats, and leaderboard' },
      { to: '/analytics', label: 'Analytics', icon: BarChart3, desc: 'Spend tracking and usage metrics' },
      { to: '/feedback', label: 'Feedback', icon: MessageCircle, desc: 'Agent performance ratings and reviews' },
    ],
  },
  {
    id: 'manage',
    label: 'Manage',
    items: [
      { to: '/operators', label: 'Operators', icon: Users, desc: 'Human team members who control agents' },
      { to: '/teams', label: 'Teams', icon: Users, desc: 'Team organization and membership' },
      { to: '/team-settings', label: 'Settings', icon: Settings2, desc: 'Team roles, permissions, and configuration' },
      { to: '/deployments', label: 'Instances', icon: Server, adminOnly: true, desc: 'Customer instances and provisioning' },
      { to: '/approvals', label: 'Approvals', icon: ShieldCheck, adminOnly: true, desc: 'Review and vote on gated actions' },
      { to: '/concepts', label: 'Concepts', icon: Lightbulb, adminOnly: true, desc: 'Shared characters, styles, and rulesets' },
      { to: '/assets', label: 'Assets', icon: FolderOpen, adminOnly: true, desc: 'Files and artifacts uploaded by agents' },
      { to: '/drones', label: 'Drones', icon: Cpu, adminOnly: true, desc: 'GPU/CPU compute job queue and workers' },
      { to: '/files', label: 'File Server', icon: HardDrive, desc: 'Browse shared drives from local file drones' },
      { to: '/spawns', label: 'Spawns', icon: Zap, adminOnly: true, desc: 'Provision new agent instances' },
      { to: '/templates', label: 'Templates', icon: Layers, adminOnly: true, desc: 'Reusable agent configuration templates' },
    ],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    defaultCollapsed: true,
    items: [
      { to: '/plugins', label: 'Plugins', icon: Puzzle, adminOnly: true, desc: 'Server plugins and extensions' },
      { to: '/webhooks', label: 'Webhooks', icon: Webhook, adminOnly: true, desc: 'Event webhook subscriptions and logs' },
      { to: '/context', label: 'Context Store', icon: Database, desc: 'Versioned key-value store for agent memory' },
      { to: '/ops', label: 'Ops Console', icon: Settings, adminOnly: true, desc: 'Admin actions, config, and kill switch' },
      { to: '/onboarding', label: 'Onboarding', icon: Rocket, adminOnly: true, desc: 'Setup wizard for new instances' },
    ],
  },
]

/* ── localStorage helpers ── */

const SECTIONS_KEY = 'mycelium_sidenav_sections'
const COLLAPSED_KEY = 'mycelium_sidenav_collapsed'

function loadCollapsedSections(): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(SECTIONS_KEY)
    if (stored) return JSON.parse(stored)
  } catch { /* ignore */ }
  return Object.fromEntries(
    staticNavSections.filter((s) => s.label).map((s) => [s.id, s.defaultCollapsed ?? false])
  )
}

function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === 'true'
  } catch { return false }
}

/* ── Component ── */

interface SideNavProps {
  mobileOpen?: boolean
  onMobileClose?: () => void
  isMobile?: boolean
}

export default function SideNav({ mobileOpen, onMobileClose, isMobile }: SideNavProps) {
  const [collapsed, setCollapsed] = useState(loadSidebarCollapsed)
  const [collapsedSections, setCollapsedSections] = useState(loadCollapsedSections)
  const agents = useDashboardStore((s) => s.agents)
  const inboxUnread = useDashboardStore((s) => s.inboxUnread)
  const pendingApprovals = useDashboardStore((s) => s.pendingApprovals)
  const userRole = useAuthStore((s) => s.user?.role)
  const isAdmin = userRole === 'admin'
  const voiceConnected = useVoiceStore((s) => s.isConnected)
  const voiceChannel = useVoiceStore((s) => s.channelName)
  const location = useLocation()

  // Plugin page nav entries
  const [pluginNav, setPluginNav] = useState<PluginNavEntry[]>([])
  useEffect(() => {
    if (!isAdmin) return
    fetchPluginNav().then(setPluginNav).catch(() => {})
  }, [isAdmin])

  // Build nav sections with plugin pages injected
  const navSections = useMemo(() => {
    const sections = staticNavSections.map((s) => ({
      ...s,
      items: [...s.items],
    }))
    for (const entry of pluginNav) {
      for (const page of entry.pages) {
        const section = sections.find((s) => s.id === (page.nav_section || 'advanced'))
        if (section) {
          section.items.push({
            to: `/plugins/${entry.name}${page.path}`,
            label: page.title,
            icon: Puzzle,
          })
        }
      }
    }
    return sections
  }, [pluginNav])

  const onlineCount = agents.filter((a) => a.status === 'online').length

  // Persistent pending-approval count for the /approvals nav badge.
  // Same derivation as the dashboard ActionRequired component.
  const pendingApprovalCount = useMemo(
    () => pendingApprovals.filter((a) => a.status === 'pending').length,
    [pendingApprovals]
  )

  // Close mobile drawer on route change
  useEffect(() => {
    if (isMobile && mobileOpen) onMobileClose?.()
  }, [location.pathname]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      localStorage.setItem(COLLAPSED_KEY, String(!prev))
      return !prev
    })
  }

  const toggleSection = (id: string) => {
    setCollapsedSections((prev) => {
      const next = { ...prev, [id]: !prev[id] }
      localStorage.setItem(SECTIONS_KEY, JSON.stringify(next))
      return next
    })
  }

  // On mobile: don't use sidebar collapse (always show full labels)
  const isNarrow = !isMobile && collapsed

  const sidebar = (
    <nav
      className="glass-nav flex flex-col h-screen shrink-0 transition-all duration-300"
      style={{ width: isMobile ? 260 : isNarrow ? 56 : 200 }}
    >
      {/* Logo */}
      <div className="flex items-center h-14 px-3 shrink-0 border-b border-border/50 gap-2">
        <img
          src="/fungal_horror.png"
          alt="Mycelium"
          className={`${isNarrow ? 'w-8 h-8 mx-auto' : 'w-9 h-9'} rounded-lg object-cover shrink-0`}
          style={{ filter: 'drop-shadow(0 0 6px rgba(212,168,71,0.4))' }}
        />
        {!isNarrow && (
          <span
            className="font-mono text-accent text-sm font-bold tracking-[0.2em] flex-1"
            style={{ textShadow: '0 0 16px rgba(212,168,71,0.4)' }}
          >
            MYCELIUM
          </span>
        )}
        {isMobile && (
          <button
            onClick={onMobileClose}
            className="p-1 rounded-lg text-text-muted hover:text-text-dim transition-colors"
            aria-label="Close navigation menu"
          >
            <X size={18} strokeWidth={1.5} />
          </button>
        )}
      </div>

      {/* Navigation sections */}
      <div className="flex flex-col flex-1 py-2 overflow-y-auto">
        {navSections.map((section, sectionIdx) => {
          const visibleItems = isAdmin
            ? section.items
            : section.items.filter((item) => !item.adminOnly)
          if (visibleItems.length === 0) return null

          const isSectionCollapsed = section.label && !isNarrow
            ? collapsedSections[section.id] ?? false
            : false

          return (
            <div key={section.id} className={sectionIdx > 0 ? 'mt-3' : ''}>
              {/* Section header — desktop expanded */}
              {section.label && !isNarrow && (
                <button
                  onClick={() => toggleSection(section.id)}
                  className="flex items-center justify-between w-full px-3 py-1 mb-0.5 group"
                  aria-expanded={!isSectionCollapsed}
                >
                  <span className="text-[10px] uppercase tracking-widest font-semibold text-text-muted group-hover:text-text-dim transition-colors">
                    {section.label}
                  </span>
                  <ChevronRight
                    size={12}
                    className={`text-text-muted group-hover:text-text-dim transition-transform duration-200 ${
                      isSectionCollapsed ? '' : 'rotate-90'
                    }`}
                  />
                </button>
              )}

              {/* Section separator — desktop collapsed */}
              {section.label && isNarrow && sectionIdx > 0 && (
                <div className="mx-3 my-2 border-t border-border/50" />
              )}

              {/* Nav items */}
              {!isSectionCollapsed && (
                <div className="flex flex-col gap-0.5 px-2">
                  {visibleItems.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === '/'}
                      title={isNarrow ? item.label : item.desc || undefined}
                      className={({ isActive }) =>
                        [
                          'flex items-center gap-3 px-2.5 py-2 text-sm rounded-lg transition-all duration-150',
                          isNarrow ? 'justify-center' : '',
                          isActive
                            ? 'glass-nav-active text-accent'
                            : 'text-text-muted hover:text-text-dim hover:bg-white/[0.03]',
                        ].join(' ')
                      }
                    >
                      <item.icon size={16} strokeWidth={1.5} className="shrink-0" />
                      {!isNarrow && <span className="truncate">{item.label}</span>}
                      {item.to === '/inbox' && inboxUnread > 0 && (
                        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent/20 text-accent text-[10px] font-bold tabular-nums ml-auto shrink-0">
                          {inboxUnread}
                        </span>
                      )}
                      {item.to === '/approvals' && isAdmin && pendingApprovalCount > 0 && (
                        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent/20 text-accent text-[10px] font-bold tabular-nums ml-auto shrink-0">
                          {pendingApprovalCount}
                        </span>
                      )}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          )
        })}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Agents section */}
        <div className="mx-2 my-3 border-t border-border/50" />
        <div className="px-2.5">
          {isNarrow ? (
            <div className="flex flex-col items-center gap-1">
              <span className="text-[10px] text-text-muted uppercase tracking-wider">Ag</span>
              <span className="text-xs font-mono text-green font-semibold">{onlineCount}</span>
            </div>
          ) : (
            <>
              <span className="text-[10px] text-text-muted uppercase tracking-wider font-semibold">
                Agents
              </span>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-green dot-online" />
                <span className="text-xs text-text-dim">
                  {onlineCount} online
                </span>
              </div>
            </>
          )}
        </div>

        {/* Voice indicator — minimal, controls are in VoiceBar */}
        {voiceConnected && (
          <>
            <div className="my-3 border-t border-border/50 mx-2" />
            <div className="px-2.5">
              <div className={`flex items-center ${isNarrow ? 'justify-center' : 'gap-2'}`} title={`Voice: #${voiceChannel}`}>
                <span className="w-1.5 h-1.5 rounded-full bg-green animate-pulse shrink-0" />
                {!isNarrow && (
                  <span className="text-xs text-green font-mono truncate">#{voiceChannel}</span>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Toggle button — desktop only */}
      {!isMobile && (
        <button
          onClick={toggleCollapsed}
          className="flex items-center justify-center h-9 mx-2 mb-3 rounded-lg text-text-muted hover:text-accent transition-all duration-150 text-xs border border-transparent hover:border-border/50 hover:glass-nav-active"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed
            ? <PanelLeftOpen size={16} strokeWidth={1.5} />
            : <PanelLeftClose size={16} strokeWidth={1.5} />
          }
        </button>
      )}
    </nav>
  )

  // Mobile: render as overlay drawer
  if (isMobile) {
    return (
      <>
        {/* Backdrop */}
        {mobileOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/60 animate-fade-in"
            onClick={onMobileClose}
          />
        )}
        {/* Drawer — always in DOM for smooth slide */}
        <div
          className={`fixed top-0 left-0 z-50 h-full transition-transform duration-250 ease-out ${
            mobileOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          {sidebar}
        </div>
      </>
    )
  }

  // Desktop: render inline
  return sidebar
}
