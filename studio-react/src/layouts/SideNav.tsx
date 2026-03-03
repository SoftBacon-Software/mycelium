import { NavLink, useLocation } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { useVoiceStore } from '../stores/voiceStore'
import {
  LayoutDashboard, CheckSquare, Map, Bug,
  MessageSquare, Radio, ShieldCheck,
  Users, Cpu, FolderOpen, Lightbulb, Database,
  Settings, Activity, Webhook, Puzzle, BarChart3, Rocket, MessageCircle,
  ChevronRight, PanelLeftClose, PanelLeftOpen, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/* ── Types ── */

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

interface NavSection {
  id: string
  label: string | null
  defaultCollapsed?: boolean
  items: NavItem[]
}

/* ── Navigation structure ── */

const navSections: NavSection[] = [
  {
    id: 'pinned',
    label: null,
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard },
    ],
  },
  {
    id: 'work',
    label: 'Work',
    items: [
      { to: '/tasks', label: 'Tasks', icon: CheckSquare },
      { to: '/plans', label: 'Plans', icon: Map },
      { to: '/bugs', label: 'Bugs', icon: Bug },
    ],
  },
  {
    id: 'communicate',
    label: 'Communicate',
    items: [
      { to: '/channels', label: 'Channels', icon: MessageSquare },
      { to: '/messages', label: 'Agent Comms', icon: Radio },
      { to: '/approvals', label: 'Approvals', icon: ShieldCheck },
    ],
  },
  {
    id: 'network',
    label: 'Network',
    items: [
      { to: '/operators', label: 'Operators', icon: Users },
      { to: '/drones', label: 'Drones', icon: Cpu },
      { to: '/assets', label: 'Assets', icon: FolderOpen },
      { to: '/concepts', label: 'Concepts', icon: Lightbulb },
      { to: '/context', label: 'Context', icon: Database },
    ],
  },
  {
    id: 'system',
    label: 'System',
    defaultCollapsed: true,
    items: [
      { to: '/ops', label: 'Admin Ops', icon: Settings },
      { to: '/health', label: 'Network Health', icon: Activity },
      { to: '/webhooks', label: 'Webhooks', icon: Webhook },
      { to: '/plugins', label: 'Plugins', icon: Puzzle },
      { to: '/analytics', label: 'Analytics', icon: BarChart3 },
      { to: '/onboarding', label: 'Onboarding', icon: Rocket },
      { to: '/feedback', label: 'Feedback', icon: MessageCircle },
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
    navSections.filter((s) => s.label).map((s) => [s.id, s.defaultCollapsed ?? false])
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
  const voiceConnected = useVoiceStore((s) => s.isConnected)
  const voiceChannel = useVoiceStore((s) => s.channelName)
  const voicePeers = useVoiceStore((s) => s.peers)
  const voiceLeave = useVoiceStore((s) => s.leave)
  const location = useLocation()

  const onlineCount = agents.filter((a) => a.status === 'online').length

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
                  {section.items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === '/'}
                      title={isNarrow ? item.label : undefined}
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

        {/* Voice indicator */}
        {voiceConnected && (
          <>
            <div className="my-3 border-t border-border/50 mx-2" />
            <div className="px-2.5">
              {isNarrow ? (
                <div
                  className="flex flex-col items-center gap-1"
                  title={`Voice: #${voiceChannel}`}
                >
                  <span className="w-2 h-2 rounded-full bg-green animate-pulse" />
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-green animate-pulse shrink-0" />
                    <span className="text-[10px] text-text-muted uppercase tracking-wider font-semibold">
                      Voice
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-green">#{voiceChannel}</span>
                    <span className="text-xs text-text-muted">
                      {voicePeers.length} peer{voicePeers.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <button
                    onClick={voiceLeave}
                    className="mt-0.5 w-full px-2 py-1 rounded-sm text-[10px] font-medium bg-red/15 text-red hover:bg-red/25 transition-colors"
                  >
                    Disconnect
                  </button>
                </div>
              )}
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
