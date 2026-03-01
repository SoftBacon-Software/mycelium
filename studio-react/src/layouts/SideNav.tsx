import { NavLink } from 'react-router-dom'
import { useState } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { useVoiceStore } from '../stores/voiceStore'

const navItems = [
  { to: '/', label: 'Dashboard', abbr: 'Da' },
  { to: '/channels', label: 'Channels', abbr: 'Ch' },
  { to: '/tasks', label: 'Tasks', abbr: 'Ta' },
  { to: '/messages', label: 'Agent Comms', abbr: 'Ag' },
  { to: '/plans', label: 'Plans', abbr: 'Pl' },
  { to: '/bugs', label: 'Bugs', abbr: 'Bu' },
  { to: '/assets', label: 'Assets', abbr: 'As' },
  { to: '/operators', label: 'Operators', abbr: 'Op' },
  { to: '/approvals', label: 'Approvals', abbr: 'Ap' },
] as const

export default function SideNav() {
  const [collapsed, setCollapsed] = useState(false)
  const agents = useDashboardStore((s) => s.agents)
  const voiceConnected = useVoiceStore((s) => s.isConnected)
  const voiceChannel = useVoiceStore((s) => s.channelName)
  const voicePeers = useVoiceStore((s) => s.peers)
  const voiceLeave = useVoiceStore((s) => s.leave)

  const onlineCount = agents.filter((a) => a.status === 'online').length

  return (
    <nav
      className="flex flex-col h-screen bg-surface border-r border-border shrink-0 transition-all duration-200"
      style={{ width: collapsed ? 56 : 200 }}
    >
      {/* Logo */}
      <div className="flex items-center h-14 px-3 shrink-0">
        {collapsed ? (
          <span className="font-mono text-accent text-sm font-bold tracking-widest mx-auto">
            M
          </span>
        ) : (
          <span className="font-mono text-accent text-sm font-bold tracking-widest">
            MYCELIUM
          </span>
        )}
      </div>

      {/* Navigation links */}
      <div className="flex flex-col gap-0.5 px-2 flex-1">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              [
                'flex items-center gap-3 px-2.5 py-2 text-sm rounded-sm transition-colors duration-150',
                isActive
                  ? 'bg-surface-raised text-accent'
                  : 'text-text-dim hover:text-text hover:bg-surface-raised/50',
              ].join(' ')
            }
          >
            <span
              className="inline-flex items-center justify-center font-mono text-[11px] font-semibold shrink-0"
              style={{ width: 20 }}
            >
              {item.abbr}
            </span>
            {!collapsed && <span className="truncate">{item.label}</span>}
          </NavLink>
        ))}

        {/* Separator */}
        <div className="my-3 border-t border-border" />

        {/* Agents section */}
        <div className="px-2.5">
          {collapsed ? (
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
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-green" />
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
            <div className="my-3 border-t border-border" />
            <div className="px-2.5">
              {collapsed ? (
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

      {/* Toggle button */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center justify-center h-10 mx-2 mb-3 rounded-sm text-text-muted hover:text-text hover:bg-surface-raised/50 transition-colors duration-150 text-xs"
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? '\u00BB' : '\u00AB'}
      </button>
    </nav>
  )
}
